// The shared plan: where it's kept, and how changes reach everyone.
// Firestore when the page has a Firebase config (everyone with the link sees the same plan, live), or a local copy in this
// browser for trying things out (?local). Every change is a list of small field edits, so two people editing different
// things at once never overwrite each other. Each change is also logged with who made it, so it can be undone.

const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
const SNAP_EVERY = 60 * 60 * 1000;          // a full copy of the plan at most once an hour, before the next change
const PRESENCE_EVERY = 3 * 60 * 1000;
const PRESENCE_STALE = 7 * 60 * 1000;

export const clientId = Math.random().toString(36).slice(2, 10);
export const newId = () => "r" + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function getPath(obj, path) { let o = obj; for (const k of path) { if (o == null || typeof o !== "object") return undefined; o = o[k]; } return o; }
function setPath(obj, path, v) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) { if (o[path[i]] == null || typeof o[path[i]] !== "object") o[path[i]] = {}; o = o[path[i]]; }
  if (v === undefined) delete o[path[path.length - 1]]; else o[path[path.length - 1]] = v;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ops: [{s: section, id: row id, f: [field path] or null for the whole row, v: new value (undefined deletes)}]
function withBefore(plan, ops) {
  return ops.map((op) => {
    const row = getPath(plan.sections, [op.s, op.id]);
    const before = op.f ? getPath(row, op.f) : row;
    return Object.assign({}, op, { before: clone(before) });
  }).filter((op) => !same(op.before, op.v));
}
function applyLocal(plan, ops) {
  for (const op of ops) {
    plan.sections[op.s] = plan.sections[op.s] || {};
    if (!op.f) { if (op.v === undefined) delete plan.sections[op.s][op.id]; else plan.sections[op.s][op.id] = clone(op.v); }
    else { if (!plan.sections[op.s][op.id]) plan.sections[op.s][op.id] = {}; setPath(plan.sections[op.s][op.id], op.f, clone(op.v)); }
  }
}
const histOps = (ops) => ops.map((op) => ({ s: op.s, id: op.id, f: op.f || null, b: op.before === undefined ? {} : { v: op.before }, a: op.v === undefined ? {} : { v: op.v } }));
export function undoOps(entry) {
  return (entry.ops || []).map((o) => ({ s: o.s, id: o.id, f: o.f || null, v: o.b && "v" in o.b ? o.b.v : undefined, expect: o.a && "v" in o.a ? o.a.v : undefined }));
}

function emitter() {
  const subs = {};
  return {
    on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); return () => { subs[ev] = subs[ev].filter((f) => f !== fn); }; },
    emit(ev, ...a) { for (const fn of subs[ev] || []) { try { fn(...a); } catch (e) { console.error(e); } } },
  };
}

// ------------------------------------------------------------------ Firestore
async function firestoreStore({ key, config, emulator }) {
  const [{ initializeApp }, F] = await Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-firestore.js")]);
  if (emulator) config = Object.assign({}, config, { projectId: "demo-planner", apiKey: "emulator" });   // tests only
  const app = initializeApp(config, "planner-" + key.slice(0, 6));
  let db;
  try {
    db = F.initializeFirestore(app, emulator ? {} : { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch (e) { db = F.getFirestore(app); }
  if (emulator) { const [h, p] = emulator.split(":"); F.connectFirestoreEmulator(db, h, Number(p)); }
  const ev = emitter();
  const planRef = F.doc(db, "plans", key);
  const dataCol = F.collection(planRef, "data");
  const histCol = F.collection(planRef, "history");
  const snapCol = F.collection(planRef, "snapshots");
  const presCol = F.collection(planRef, "presence");
  const plan = { sections: {} };
  let loaded = false, lastSnap = null, me = { name: "" }, pending = 0;

  const status = (s) => ev.emit("status", s);
  status("connecting");
  F.onSnapshot(planRef, (d) => {
    const v = d.data({ serverTimestamps: "estimate" });
    const seen = v && v.lastSnap ? v.lastSnap.toMillis() : (d.exists() ? 0 : null);
    if (seen !== null && (lastSnap === null || seen > lastSnap || !d.metadata.hasPendingWrites)) lastSnap = Math.max(seen, lastSnap || 0);
    ev.emit("meta", v || null);
  },
    (e) => status("error: " + e.code));
  // serverSeen: the plan has come from the server at least once. connected: it's in step with the server right now.
  let serverSeen = false, connected = false;
  const online = () => connected && navigator.onLine !== false;
  F.onSnapshot(dataCol, { includeMetadataChanges: true }, (snap) => {
    const changed = [];
    const fromServer = !snap.metadata.fromCache && !serverSeen;
    if (!snap.metadata.fromCache) serverSeen = true;
    const was = connected;
    connected = !snap.metadata.fromCache;
    if (was !== connected) ev.emit("connection", connected);
    for (const ch of snap.docChanges()) {
      changed.push(ch.doc.id);
      if (ch.type === "removed") delete plan.sections[ch.doc.id];
      else plan.sections[ch.doc.id] = (ch.doc.data({ serverTimestamps: "estimate" }) || {}).items || {};
    }
    const first = !loaded;
    loaded = true;
    if (changed.length || first || fromServer) ev.emit("plan", plan, { first, changed, local: snap.metadata.hasPendingWrites, fromServer });
    if (!pending) status(snap.metadata.fromCache ? (navigator.onLine === false ? "offline" : "connecting") : "saved");
  }, (e) => status("error: " + e.code));

  async function commit(ops, label, extra) {
    ops = withBefore(plan, ops);
    if (!ops.length) return null;
    // an hourly copy of the whole plan, taken before the first change of the hour (its own write, so a failed copy
    // never blocks the change itself)
    if (serverSeen && online() && lastSnap !== null && Date.now() - lastSnap > SNAP_EVERY && !extra?.noSnapshot) {
      lastSnap = Date.now();
      const sb = F.writeBatch(db);
      sb.set(F.doc(snapCol), { at: F.serverTimestamp(), who: me.name || "Someone", label: "Hourly copy", sections: clone(plan.sections) });
      sb.set(planRef, { lastSnap: F.serverTimestamp() }, { merge: true });
      sb.commit().catch((e) => console.warn("hourly copy failed", e));
    }
    const b = F.writeBatch(db);
    const bySec = {};
    for (const op of ops) {
      const s = (bySec[op.s] = bySec[op.s] || { items: {} });
      if (!op.f) {
        if (op.v === undefined) s.items[op.id] = F.deleteField();
        else {
          const row = clone(op.v);
          for (const k of Object.keys(op.before || {})) if (!(k in row)) row[k] = F.deleteField();
          s.items[op.id] = Object.assign(row, { _by: me.name || "", _at: F.serverTimestamp() });
        }
      } else {
        const row = (s.items[op.id] = s.items[op.id] && typeof s.items[op.id] === "object" ? s.items[op.id] : {});
        setPath(row, op.f, op.v === undefined ? F.deleteField() : clone(op.v));
        row._by = me.name || ""; row._at = F.serverTimestamp();
      }
    }
    for (const [sec, val] of Object.entries(bySec)) b.set(F.doc(dataCol, sec), val, { merge: true });
    const entry = { at: F.serverTimestamp(), who: me.name || "Someone", client: clientId, label: label || "Edit", ops: extra?.noHistoryOps ? [] : histOps(ops) };
    if (extra?.note) entry.note = extra.note;
    b.set(F.doc(histCol), entry);
    pending++; status("saving");
    const p = b.commit().then(() => { pending--; if (!pending) status("saved"); }, (e) => { pending--; status("error: " + (e.code || e.message)); throw e; });
    if (navigator.onLine === false) status("offline");
    return { ops, done: p };
  }

  async function replaceAll(sections, label, who) {
    // Only ever online, in one transaction: the "Before" copy is what the server holds at that moment (not this
    // browser's copy, which may be behind), and if anything changes in between, the transaction starts again.
    // A transaction can't be saved for later, so a copy loaded offline can never land on top of other people's work.
    if (!online()) throw Object.assign(new Error("You're offline. Loading a whole copy needs a connection."), { code: "offline" });
    pending++; status("saving");
    try {
      const listed = await F.getDocsFromServer(dataCol);
      const names = [...new Set(Object.keys(plan.sections).concat(Object.keys(sections), listed.docs.map((d) => d.id)))];
      await F.runTransaction(db, async (tx) => {
        const before = {};
        for (const name of names) {
          const d = await tx.get(F.doc(dataCol, name));
          if (d.exists()) before[name] = (d.data() || {}).items || {};
        }
        const by = who || me.name || "Someone";
        tx.set(F.doc(snapCol), { at: F.serverTimestamp(), who: by, label: "Before: " + label, sections: before });
        for (const name of names) tx.set(F.doc(dataCol, name), { items: clone(sections[name] || {}) });
        tx.set(F.doc(histCol), { at: F.serverTimestamp(), who: by, client: clientId, label, ops: [] });
        tx.set(planRef, { updated: F.serverTimestamp(), lastSnap: F.serverTimestamp(), schema: 1 }, { merge: true });
      });
      pending--; if (!pending) status("saved");
    } catch (e) {
      pending--;
      status(online() ? "error: " + (e.code || e.message) : "offline");
      if (!online() && e.code !== "offline") throw Object.assign(new Error("You're offline. Loading a whole copy needs a connection."), { code: "offline" });
      throw e;
    }
  }

  return {
    mode: "firestore",
    on: ev.on,
    plan: () => plan,
    setName(n) { me.name = n; },
    commit,
    replaceAll,
    online,
    watchHistory(limit, fn) {
      return F.onSnapshot(F.query(histCol, F.orderBy("at", "desc"), F.limit(limit || 80)), (snap) => {
        fn(snap.docs.map((d) => Object.assign({ id: d.id }, d.data({ serverTimestamps: "estimate" }), { at: (d.data({ serverTimestamps: "estimate" }).at || { toMillis: () => Date.now() }).toMillis() })));
      }, (e) => fn(null, e));
    },
    watchSnapshots(fn) {
      return F.onSnapshot(F.query(snapCol, F.orderBy("at", "desc"), F.limit(30)), (snap) => {
        fn(snap.docs.map((d) => { const v = d.data({ serverTimestamps: "estimate" }); return { id: d.id, at: v.at ? v.at.toMillis() : Date.now(), who: v.who, label: v.label, sections: v.sections }; }));
      }, (e) => fn(null, e));
    },
    async presence(info) {
      try { await F.setDoc(F.doc(presCol, clientId), Object.assign({ at: F.serverTimestamp() }, info)); } catch (e) { /* not essential */ }
    },
    async leave() { try { await F.deleteDoc(F.doc(presCol, clientId)); } catch (e) { /* ignore */ } },
    watchPresence(fn) {
      return F.onSnapshot(presCol, (snap) => {
        const now = Date.now();
        fn(snap.docs.map((d) => { const v = d.data({ serverTimestamps: "estimate" }); return Object.assign({ id: d.id }, v, { at: v.at ? v.at.toMillis() : now }); })
          .filter((p) => p.id !== clientId && now - p.at < PRESENCE_STALE));
      }, () => fn([]));
    },
    loaded: () => loaded,
  };
}

// ------------------------------------------------------------------ a local copy (this browser only), for trying it out
function localStore({ key }) {
  const ev = emitter();
  const LS = "planner:" + key;
  const read = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } };
  const plan = { sections: read(":plan", {}) };
  let hist = read(":hist", []), snaps = read(":snaps", []), me = { name: "" };
  let chan = null;
  try { chan = new BroadcastChannel(LS); } catch (e) { chan = null; }
  const histSubs = [], snapSubs = [], presSubs = [];
  const peers = {};
  const fire = () => { for (const f of histSubs) f(hist.slice(0, 80)); for (const f of snapSubs) f(snaps.slice(0, 30)); };
  if (chan) chan.onmessage = (m) => {
    const d = m.data;
    if (d.type === "ops") { applyLocal(plan, d.ops); hist = [d.entry].concat(hist).slice(0, 300); ev.emit("plan", plan, { first: false, changed: [...new Set(d.ops.map((o) => o.s))], local: false }); fire(); }
    if (d.type === "all") { plan.sections = clone(d.sections); hist = [d.entry].concat(hist).slice(0, 300); snaps = read(":snaps", snaps); ev.emit("plan", plan, { first: false, changed: Object.keys(plan.sections), local: false }); fire(); }
    if (d.type === "presence") { if (d.info) peers[d.id] = Object.assign({ id: d.id, at: Date.now() }, d.info); else delete peers[d.id]; for (const f of presSubs) f(Object.values(peers)); }
  };
  setTimeout(() => { ev.emit("status", "local"); ev.emit("plan", plan, { first: true, changed: Object.keys(plan.sections), local: false }); }, 0);
  return {
    mode: "local",
    on: ev.on,
    online: () => true,
    plan: () => plan,
    setName(n) { me.name = n; },
    async commit(ops, label, extra) {
      ops = withBefore(plan, ops);
      if (!ops.length) return null;
      const last = snaps[0] ? snaps[0].at : 0;
      if (Date.now() - last > SNAP_EVERY && Object.keys(plan.sections).length && !extra?.noSnapshot) {
        snaps = [{ id: newId(), at: Date.now(), who: me.name || "Someone", label: "Hourly copy", sections: clone(plan.sections) }].concat(snaps).slice(0, 30);
        write(":snaps", snaps);
      }
      applyLocal(plan, ops);
      for (const op of ops) { const row = plan.sections[op.s][op.id]; if (row) { row._by = me.name || ""; row._at = Date.now(); } }
      const entry = { id: newId(), at: Date.now(), who: me.name || "Someone", client: clientId, label: label || "Edit", ops: histOps(ops) };
      hist = [entry].concat(hist).slice(0, 300);
      write(":plan", plan.sections); write(":hist", hist);
      if (chan) chan.postMessage({ type: "ops", ops: clone(ops.map((o) => ({ s: o.s, id: o.id, f: o.f, v: o.v }))), entry });
      ev.emit("plan", plan, { first: false, changed: [...new Set(ops.map((o) => o.s))], local: true });
      fire();
      return { ops, done: Promise.resolve() };
    },
    async replaceAll(sections, label, who) {
      snaps = [{ id: newId(), at: Date.now(), who: who || me.name || "Someone", label: "Before: " + label, sections: clone(plan.sections) }].concat(snaps).slice(0, 30);
      plan.sections = clone(sections);
      const entry = { id: newId(), at: Date.now(), who: who || me.name || "Someone", client: clientId, label, ops: [] };
      hist = [entry].concat(hist).slice(0, 300);
      write(":plan", plan.sections); write(":hist", hist); write(":snaps", snaps);
      if (chan) chan.postMessage({ type: "all", sections: plan.sections, entry });
      ev.emit("plan", plan, { first: false, changed: Object.keys(plan.sections), local: true });
      fire();
    },
    watchHistory(limit, fn) { histSubs.push(fn); fn(hist.slice(0, limit || 80)); return () => histSubs.splice(histSubs.indexOf(fn), 1); },
    watchSnapshots(fn) { snapSubs.push(fn); fn(snaps.slice(0, 30)); return () => snapSubs.splice(snapSubs.indexOf(fn), 1); },
    async presence(info) { if (chan) chan.postMessage({ type: "presence", id: clientId, info }); },
    async leave() { if (chan) chan.postMessage({ type: "presence", id: clientId, info: null }); },
    watchPresence(fn) { presSubs.push(fn); fn(Object.values(peers)); return () => presSubs.splice(presSubs.indexOf(fn), 1); },
    loaded: () => true,
  };
}

export async function openStore(opts) {
  if (opts.local || !opts.config || !opts.config.projectId) return localStore(opts);
  return firestoreStore(opts);
}
export const PRESENCE_MS = PRESENCE_EVERY;
