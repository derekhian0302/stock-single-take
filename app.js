// Shot Planner: the shared board. Everyone with the link sees the same plan and can change it; the board, the cards and
// the checks are worked out again from the plan after every change.
import { openStore, newId, undoOps, PRESENCE_MS } from "./store.js";

const PD = window.PlanDerive;
const $ = (id) => document.getElementById(id);
const svgNS = "http://www.w3.org/2000/svg";
const S = 100; // svg units per meter
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const el = (tag, attrs, parent) => { const e = document.createElementNS(svgNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
const mmss = (t) => { const neg = t < 0; t = Math.round(Math.abs(t)); return (neg ? "-" : "") + Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
const mmssH = (t) => { const neg = t < 0; const a = Math.abs(t); const s = Math.floor(a + 1e-9), half = a - s >= 0.25 ? ".5" : ""; return (neg ? "-" : "") + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + half; };
function parseTimeInput(raw) {
  const v = String(raw || "").trim().replace(/\u2212/g, "-");
  const m = /^(-?)(\d+)\.(\d\d)$/.exec(v);
  if (m && Number(m[3]) < 60) return { t: (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])), how: "m.ss" };
  const t = window.PlanDerive.parseTime(v);
  return { t, how: /:/.test(v) ? "m:ss" : "seconds" };
}
const ls = { get(k, d) { try { const v = localStorage.getItem("planner." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("planner." + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } } };
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); if (s < 50) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return new Date(ms).toLocaleDateString(); };
const tsMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : v && v.seconds ? v.seconds * 1000 : typeof v === "number" ? v : 0);

// ------------------------------------------------------------------ boot: the plan's key is the part of the link after '#'
const hashParts = (location.hash || "").replace(/^#/, "").split("/");
const KEY = hashParts[0];
const params = new URLSearchParams(location.search);
if (!/^[A-Za-z0-9_-]{16,64}$/.test(KEY)) {
  $("gate").hidden = false;
} else {
  start().catch((e) => { $("gate").hidden = false; $("gate-msg").textContent = "The plan couldn't open: " + (e && e.message ? e.message : e); console.error(e); });
}

async function start() {
  const store = await openStore({ key: KEY, config: window.FIREBASE_CONFIG, emulator: params.get("emu"), local: params.has("local") });
  $("app").hidden = false;
  const app = makeApp(store);
  window.__planner = app;   // for tests
}

function makeApp(store) {
  const map = $("map");
  const state = {
    T: -10, playing: false, speed: 10, view: "auto", lens: null, tab: "take", sel: null, reset: "partial",
    edit: ls.get("edit", false), moveMarks: false, kf: null, sec: "moves", filter: "", override: null, zoom: "all", zc: 0,
  };
  let PLAN = { sections: {} }, DATA = null, WARN = [], CHECKS = null, firstData = true, me = ls.get("name", "");
  let byCode = {}, markXY = {}, markBy = {}, propXY = {}, VIEWS = {}, people = [], mainBeats = [], insideBeats = [];
  let viewNow = null, lastFrame = 0, pxPerUnit = 1, lastPanelKey = "";
  const px = (p) => p / Math.max(pxPerUnit, 0.05);
  const measure = () => { const vb = map.viewBox.baseVal; const r = map.getBoundingClientRect(); pxPerUnit = vb && vb.width && r.width ? Math.min(r.width / vb.width, r.height / vb.height) : 1; };
  store.setName(me);

  // ---------------------------------------------------------------- deriving the board from the plan (in a worker)
  let worker = null, seq = 0, doneSeq = 0, deriveTimer = null;
  try { worker = new Worker("worker.js"); worker.onmessage = (e) => onDerived(e.data); worker.onerror = () => { worker = null; scheduleDerive(); }; } catch (e) { worker = null; }
  function scheduleDerive() { clearTimeout(deriveTimer); deriveTimer = setTimeout(runDerive, 40); }
  function runDerive() {
    const s = ++seq;
    const plan = JSON.parse(JSON.stringify({ sections: PLAN.sections }));
    if (worker) worker.postMessage({ seq: s, plan });
    else { try { const r = PD.derive(plan); onDerived({ seq: s, data: r.data, warnings: r.warnings, checks: r.checks }); } catch (err) { onDerived({ seq: s, error: String(err.stack || err) }); } }
  }
  let pendingMsg = null;
  function onDerived(msg) {
    if (msg.seq < doneSeq) return;
    if (drag || kdrag) { pendingMsg = msg; return; }      // a drag in progress keeps the board it started with
    doneSeq = msg.seq;
    if (msg.error) {
      console.error(msg.error);
      showDeriveError(msg.error.split("\n")[0]);
      if (firstData) { firstData = false; afterFirstData(true); }   // nothing to show yet: open the tables so it can be fixed
      return;
    }
    $("derive-err").hidden = true;
    DATA = msg.data; WARN = msg.warnings; CHECKS = msg.checks;
    if (state.override && state.override.seq <= msg.seq) state.override = null;
    rebuild();
  }
  function showDeriveError(first) {
    const box = $("derive-err"); box.hidden = false;
    box.innerHTML = `<b>${DATA ? "The board is showing the plan from before the latest change." : "The board can't be drawn from this plan yet."}</b> Something in the plan can't be worked out (${esc(first)}). Undo the change in History, or fix the row in Plan tables. <span class="btnrow"><button class="btn small-btn" data-go="plan">Plan tables</button><button class="btn small-btn" data-go="history">History</button></span>`;
    for (const b of box.querySelectorAll("[data-go]")) b.addEventListener("click", () => setTab(b.dataset.go));
  }
  let serverLoaded = store.mode === "local";
  store.on("plan", (plan, info) => {
    PLAN = plan;
    if (info && info.fromServer) serverLoaded = true;
    if (info && !info.local && !info.first) noteRemote(info.changed);
    scheduleDerive();
  });
  store.on("status", (s) => {
    if (/permission-denied/.test(s) && !DATA) {
      $("app").hidden = true; $("gate").hidden = false;
      $("gate-msg").textContent = "This link doesn't open a plan. Check that you have the whole link, including everything after the #.";
      return;
    }
    const box = $("sync");
    const map2 = { connecting: ["Connecting…", ""], saved: ["All changes saved", "saved"], saving: ["Saving…", "saving"], offline: ["Offline: your changes will sync when you're back", "offline"],
      local: ["Local copy: changes stay in this browser", "local"] };
    const [t, c] = map2[s] || [s.startsWith("error") ? "Couldn't save: " + s.slice(7) : s, s.startsWith("error") ? "error" : ""];
    box.textContent = t; box.className = "sync " + c;
  });
  window.addEventListener("online", () => $("sync").classList.remove("offline"));
  window.addEventListener("offline", () => { const b = $("sync"); b.textContent = "Offline: your changes will sync when you're back"; b.className = "sync offline"; });

  // ---------------------------------------------------------------- geometry helpers on the board data
  function present(p, T) { return p.onMap && (p.joins <= -60 || T >= p.joins); }
  function posAt(track, T) {
    if (!track || !track.length) return null;
    if (T <= track[0][0]) return [track[0][1], track[0][2]];
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i], b = track[i + 1];
      if (a[0] <= T && T <= b[0]) { const f = b[0] === a[0] ? 0 : (T - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
    }
    const z = track[track.length - 1]; return [z[1], z[2]];
  }
  const overrideAt = (code, T) => state.override && state.override.code === code && (state.override.T === undefined || Math.abs(T - state.override.T) < 0.3);
  function posOf(p, T) { if (overrideAt(p.code, T)) return state.override.xy; return posAt(p.track, T); }
  function lookAt(track, T) { let last = null; for (const k of track) { if (k[0] <= T && k[3] !== null && k[3] !== undefined) last = k[3]; } return last; }
  function headingAt(code, T) {
    const p = byCode[code]; const xy = posOf(p, T); const look = lookAt(p.track, T);
    if (overrideAt(code, T) && typeof state.override.face === "number") return state.override.face;
    if (typeof look === "number") return look;
    let t = null;
    if (look && byCode[look] && byCode[look].onMap) t = posOf(byCode[look], T);
    else if (look && markXY[look]) t = markXY[look];
    else if (look && propXY[look]) t = propXY[look];
    if (!t) return 0;
    return Math.atan2(t[1] - xy[1], t[0] - xy[0]) * 180 / Math.PI;
  }
  function actionAt(code, T) { let a = ""; for (const k of byCode[code].track) if (k[0] <= T && k[4]) a = k[4]; return a; }
  function beatAt(T) {
    for (const b of insideBeats) if (b.t0 <= T && T < b.t1) return b;
    let cur = mainBeats[0] || { code: "", name: "" };
    for (const b of mainBeats) if (b.t0 <= T) cur = b;
    return cur;
  }
  const mainBeatOf = (b) => { let cur = mainBeats[0]; for (const m of mainBeats) if (m.t0 <= b.t0) cur = m; return cur; };
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const segCross = (p1, p2, q1, q2) => { const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2); return d1 * d2 < 0 && d3 * d4 < 0; };
  const blocked = (a, b) => DATA.walls.some((w) => segCross(a, b, w[0], w[1]));
  function frameState(cam, hd, t, f) {
    const dx = t[0] - cam[0], dy = t[1] - cam[1], d = Math.hypot(dx, dy);
    if (d < 0.3 || d > 30 || blocked(cam, t)) return ["out", 999];
    const diff = Math.abs(((Math.atan2(dy, dx) * 180 / Math.PI - hd + 540) % 360) - 180);
    if (diff <= f / 2) return ["in", diff];
    if (diff <= f / 2 + DATA.nearEdge) return ["edge", diff - f / 2];
    return ["out", diff];
  }
  function rayHit(o, ang, maxd) {
    const d = [Math.cos(ang), Math.sin(ang)]; let best = maxd;
    for (const w of DATA.walls) {
      const [a, b] = w; const e = [b[0] - a[0], b[1] - a[1]];
      const den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-9) continue;
      const t = ((a[0] - o[0]) * e[1] - (a[1] - o[1]) * e[0]) / den;
      const u = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
      if (t > 0.05 && u >= 0 && u <= 1 && t < best) best = t;
    }
    return [o[0] + d[0] * best, o[1] + d[1] * best];
  }
  const fov = () => DATA.lenses[state.lens];
  const tagFor = (st) => st === "Proposed" ? '<span class="tag draft">draft</span>' : st === "Open" ? '<span class="tag open">open</span>' : "";
  const talent = () => (DATA ? byCode[DATA.ui.talent] : null), camera = () => (DATA ? byCode[DATA.ui.camera] : null);
  const nameOf = (code) => (byCode[code] ? byCode[code].name : code);

  // ---------------------------------------------------------------- svg layers
  const gBase = el("g", { id: "base" }, map);
  const gSwap = el("g", { id: "swapmarks" }, map);
  const gOverlay = el("g", { id: "overlay" }, map);
  const gWedge = el("g", { id: "wedge" }, map);
  const gMarks = el("g", { id: "marks" }, map);
  const gPeople = el("g", { id: "people" }, map);
  const gDrag = el("g", { id: "drag" }, map);
  const defs = el("defs", {}, map);
  ["talent", "camera", "crew", "crew2"].forEach((c) => {
    const m = el("marker", { id: "arr-" + c, viewBox: "0 0 10 10", refX: "7", refY: "5", markerWidth: "4", markerHeight: "4", orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", style: "fill:var(--" + c + ")" }, m);
  });
  const wedge = el("path", { class: "wedge" }, gWedge);
  const pts = (poly) => poly.map((p) => (p[0] * S).toFixed(1) + "," + (p[1] * S).toFixed(1)).join(" ");
  const inBox = (x, y, box) => x >= box[0] && x <= box[0] + box[2] && y >= box[1] && y <= box[1] + box[3];

  function drawBase(k) {
    gBase.innerHTML = "";
    gMarks.innerHTML = "";
    for (const a of DATA.areas) el("polygon", { points: pts(a.poly), class: "a-" + (a.style || "room") }, gBase);
    const hz = DATA.hot; el("rect", { x: hz[0] * S, y: hz[1] * S, width: hz[2] * S, height: hz[3] * S, class: "hot" }, gBase);
    const order = ["counter", "tall", "island", "appliance", "cooktop", "sink", "furniture", "rug", "item"];
    const kinds = order.concat(DATA.fixtures.map((f) => f.kind).filter((k2) => !order.includes(k2)));
    for (const kind of kinds) for (const f of DATA.fixtures.filter((f2) => f2.kind === kind)) {
      const r = el("rect", { x: f.x * S, y: f.y * S, width: f.w * S, height: f.h * S, class: "f-" + kind, rx: kind === "sink" ? 6 : 0 }, gBase);
      const tt = el("title", {}, r); tt.textContent = f.label;
    }
    for (const [x, y] of DATA.chairs) el("circle", { cx: x * S, cy: y * S, r: 18, class: "f-appliance" }, gBase);
    for (const [x, y, moved] of DATA.bistro) { const c = el("circle", { cx: x * S, cy: y * S, r: 32, class: "f-appliance" }, gBase); if (moved) { c.setAttribute("style", "fill:none;stroke-dasharray:5 4"); const tt = el("title", {}, c); tt.textContent = "Moved clear for the take (preset)"; } }
    if (DATA.outline.length > 1) el("polygon", { points: pts(DATA.outline), class: "wall" }, gBase);
    for (const f of DATA.features) {
      const a = { x1: f.x1 * S, y1: f.y1 * S, x2: f.x2 * S, y2: f.y2 * S };
      if (f.kind === "opening") el("line", Object.assign({ class: "glass-gap" }, a), gBase);
      else if (f.kind === "window" || f.kind === "glass") { el("line", Object.assign({ class: "glass-gap" }, a), gBase); el("line", Object.assign({ class: "glass" }, a), gBase); }
      else if (f.kind === "door") { el("line", Object.assign({ class: "glass-gap" }, a), gBase); el("line", Object.assign({ class: "door" }, a), gBase); }
    }
    // walls drawn outside the outline (the passage and the landing)
    const onOutline = (w) => DATA.outline.some((p, i) => { const q = DATA.outline[(i + 1) % DATA.outline.length]; const c1 = Math.abs(cross(p, q, w[0])) < 1e-6, c2 = Math.abs(cross(p, q, w[1])) < 1e-6; return c1 && c2; });
    for (const w of DATA.walls) { if (!onOutline(w)) el("line", { x1: w[0][0] * S, y1: w[0][1] * S, x2: w[1][0] * S, y2: w[1][1] * S, class: "wall", style: "stroke-width:4" }, gBase); }
    for (const p of DATA.points) {
      const X = p.x * S, Y = p.y * S, r = 8 * k;
      let node;
      if (p.kind === "power") node = el("circle", { cx: X, cy: Y, r, class: "pt-power" }, gBase);
      else if (p.kind === "noise") node = el("rect", { x: X - r, y: Y - r, width: 2 * r, height: 2 * r, class: "pt-noise" }, gBase);
      else node = el("polygon", { points: `${X},${Y - 1.4 * r} ${X + 1.3 * r},${Y + r} ${X - 1.3 * r},${Y + r}`, class: "pt-trip" }, gBase);
      const tt = el("title", {}, node); tt.textContent = p.label;
    }
    for (const l of DATA.ui.labels) {
      if (l.view && k < 1.6) continue;
      const cls = l.style === "strong" ? "lbl-strong" : l.style === "hold" ? "lbl-hold" : "";
      const t = el("text", { x: l.x * S, y: l.y * S, class: "lbl-map " + cls, "font-size": Math.max(l.size * k, px(l.size >= 15 ? 12 : 10.5)), "text-anchor": l.anchor || "middle" }, gBase);
      t.textContent = l.text;
    }
    const box = VIEWS[viewNow];
    for (const m of DATA.marks) {
      if (k < 1.6 && !inBox(m.x, m.y, box)) continue;
      const g = el("g", { class: "mk " + m.kind + (m.status !== "Stated" ? " draft" : ""), "data-code": m.code, "data-id": m.id }, gMarks);
      el("circle", { cx: m.x * S, cy: m.y * S, r: Math.max(16 * k, px(10)) }, g);
      const t = el("text", { x: m.x * S, y: m.y * S, "font-size": Math.max(15 * k, px(10)) }, g); t.textContent = m.code;
      const tt = el("title", {}, g); tt.textContent = m.code + ": " + m.label + (m.status !== "Stated" ? " (" + (m.status === "Open" ? "nobody has said" : "draft") + ")" : "") + (m.note ? ". " + m.note : "");
    }
    for (const p of DATA.props) {
      const g = el("g", { class: "prop", "data-prop": p.id, "data-id": p.rowId }, gMarks);
      el("circle", { cx: p.x * S, cy: p.y * S, r: Math.max(4.5 * k, state.edit && state.moveMarks ? px(7) : 0) }, g);
      const tt = el("title", {}, g); tt.textContent = p.label;
    }
  }

  function inWindow(sw, T) { return (sw.windows[state.lens] || []).some((w) => w[0] <= T && T <= w[1]); }
  function drawSwapMarks(T) {
    gSwap.innerHTML = "";
    if (state.tab !== "take") return;
    for (const sw of DATA.swaps) {
      if (!inWindow(sw, T)) continue;
      el("circle", { cx: sw.target[0] * S, cy: sw.target[1] * S, r: 34, class: "swapmark" }, gSwap);
      el("polyline", { points: pts(sw.path.concat([sw.target])), class: "route-line route-crew2", style: "stroke-dasharray:6 5;stroke-width:3" }, gSwap);
      const t = el("text", { x: sw.target[0] * S + 40, y: sw.target[1] * S - 30, class: "ovl-tag", "font-size": Math.max(16, px(11)) }, gSwap); t.textContent = sw.name + " window";
    }
  }
  function drawOverlay() {
    gOverlay.innerHTML = "";
    if (state.tab !== "resets" || !DATA) return;
    const k = state.reset === "full" ? 2.2 : 1;
    const routes = DATA.resetRoutes[state.reset];
    for (const r of routes) el("polyline", { points: pts(r.pts), class: "route-line route-" + r.style, "marker-end": "url(#arr-" + r.style + ")", style: "stroke-width:" + 4 * (k > 1 ? 1.6 : 1) }, gOverlay);
    const rm = Math.max(16 * k, px(10));
    const box = VIEWS[viewNow];
    const taken = DATA.marks.filter((m) => k >= 1.6 || inBox(m.x, m.y, box)).map((m) => ({ x: m.x * S - rm, y: m.y * S - rm, width: 2 * rm, height: 2 * rm }));
    const hits = (b) => taken.some((o) => b.x < o.x + o.width && o.x < b.x + b.width && b.y < o.y + o.height && o.y < b.y + b.height);
    for (const r of routes) {
      const fs = Math.max(16 * k, px(11)), y0 = r.at[1] * S;
      const t = el("text", { x: r.at[0] * S, y: y0, class: "ovl-tag", "font-size": fs, "text-anchor": r.anchor || "start" }, gOverlay); t.textContent = r.label;
      let bb = t.getBBox();
      if (bb.width && hits(bb)) {
        for (const d of [1, -1, 2, -2, 3, -3]) { t.setAttribute("y", y0 + d * fs * 1.2); bb = t.getBBox(); if (!hits(bb)) break; }
        if (hits(bb)) { t.setAttribute("y", y0); bb = t.getBBox(); }
      }
      taken.push({ x: bb.x, y: bb.y, width: bb.width, height: bb.height });
    }
    for (const o of DATA.resetRoutes.off[state.reset]) {
      const t = el("text", { x: o.at[0] * S, y: o.at[1] * S, class: "ovl-tag", "font-size": Math.max(14 * k, px(10.5)) }, gOverlay); t.textContent = o.label;
    }
  }
  function wantedView(T) {
    if (state.tab === "resets") return state.reset === "full" ? "route" : "kitchen";
    if (state.view !== "auto") return state.view;
    return T < DATA.ui.routeUntil ? "route" : "kitchen";
  }
  function applyView(v, force) {
    if (v === viewNow && !force) return;
    viewNow = v;
    const [x, y, w, h] = VIEWS[v];
    map.setAttribute("viewBox", `${x * S} ${y * S} ${w * S} ${h * S}`);
    measure();
    drawBase(v === "route" ? 2.2 : 1);
    for (const code in nodes) nodes[code].hit.setAttribute("r", Math.max(36, px(22) / (v === "route" ? 2.2 : 1)));
    drawOverlay();
  }

  // ---------------------------------------------------------------- people on the map
  let nodes = {};
  function buildNodes() {
    gPeople.innerHTML = ""; nodes = {};
    for (const p of people) {
      if (!p.onMap) continue;
      const g = el("g", { class: "person " + p.color, tabindex: "0", role: "button", "aria-label": p.name + ": show card", "data-code": p.code }, gPeople);
      const hit = el("circle", { class: "hit", r: 36 }, g);
      const ring = el("circle", { class: "ring", r: 29 }, g);
      const nose = el("line", { class: "nose" }, g);
      el("circle", { class: "body", r: p.code === DATA.ui.talent ? 23 : 20 }, g);
      const tx = el("text", { "font-size": p.code === DATA.ui.talent ? 17 : 15 }, g); tx.textContent = p.initials;
      const handle = el("circle", { class: "handle", r: 9, style: "display:none" }, g);
      const hh = el("circle", { class: "handle-hit", r: 24, style: "display:none" }, g);   // what a finger grabs: bigger than the dot
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); personClick(p.code); } });
      nodes[p.code] = { g, ring, nose, hit, handle, hh };
    }
  }

  // ---------------------------------------------------------------- the frame
  function render() {
    if (!DATA) return;
    const T = state.T;
    if (!kdrag) keepInZoom(T);
    applyView(wantedView(T));
    const k = viewNow === "route" ? 2.2 : 1;
    const camP = camera();
    const cam = camP && camP.onMap ? posOf(camP, T) : null, hd = cam ? headingAt(camP.code, T) : 0, f = fov();
    if (cam) {
      const n = 64, a0 = (hd - f / 2) * Math.PI / 180, a1 = (hd + f / 2) * Math.PI / 180;
      let d = `M${(cam[0] * S).toFixed(1)},${(cam[1] * S).toFixed(1)}`;
      for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; const h = rayHit(cam, a, 30); d += ` L${(h[0] * S).toFixed(1)},${(h[1] * S).toFixed(1)}`; }
      wedge.setAttribute("d", d + " Z");
    }
    wedge.style.display = state.tab === "resets" || !cam ? "none" : "";
    drawSwapMarks(T);
    const hits = [], edges = [];
    let talentIn = false;
    const selKey = selectedKey();
    for (const p of people) {
      const nd = nodes[p.code]; if (!nd) continue;
      const here = present(p, T) && state.tab !== "resets";
      nd.g.style.display = here ? "" : "none";
      if (!here) continue;
      const xy = posOf(p, T); const h = headingAt(p.code, T) * Math.PI / 180;
      nd.g.setAttribute("transform", `translate(${(xy[0] * S).toFixed(1)},${(xy[1] * S).toFixed(1)}) scale(${k})`);
      nd.nose.setAttribute("x1", 0); nd.nose.setAttribute("y1", 0);
      nd.nose.setAttribute("x2", (Math.cos(h) * 34).toFixed(1)); nd.nose.setAttribute("y2", (Math.sin(h) * 34).toFixed(1));
      const onKey = state.edit && selKey && selKey.p.code === p.code && Math.abs(selKey.k.t - T) < 0.26;
      nd.handle.style.display = nd.hh.style.display = onKey ? "" : "none";
      if (onKey) {
        // sized on screen: a dot you can see and a target a finger can hit, just clear of the person's own dot
        const hr = Math.max(9, px(6) / k), hit = Math.max(24, px(22) / k), d = 22 + hit;
        for (const c of [nd.handle, nd.hh]) { c.setAttribute("cx", (Math.cos(h) * d).toFixed(1)); c.setAttribute("cy", (Math.sin(h) * d).toFixed(1)); }
        nd.handle.setAttribute("r", hr.toFixed(1)); nd.hh.setAttribute("r", hit.toFixed(1));
      }
      nd.g.classList.toggle("sel", state.sel === p.code || (selKey && selKey.p.code === p.code));
      let st = "out";
      if (cam && p.code !== camP.code) { const fs = frameState(cam, hd, xy, f); st = fs[0]; if (st === "edge" && p.checked) edges.push(`${p.name}, ${Math.max(1, Math.round(fs[1]))}° outside the frame`); }
      if (p.code === DATA.ui.talent) { talentIn = st === "in"; st = "out"; }
      if (st === "in" && p.checked) hits.push(p.name);
      nd.ring.style.display = (st === "in" || (st === "edge" && p.checked)) ? "" : "none";
      nd.ring.setAttribute("class", "ring" + (st === "edge" ? " edge" : ""));
    }
    $("taketime").textContent = mmss(T);
    $("timer").textContent = timerAt(T);
    $("timerbox").classList.toggle("idle", T < DATA.timerStart);
    const b = beatAt(T);
    $("beatcode").textContent = b.code ? "Beat " + b.code : "Beat";
    $("beatname").textContent = b.name || "";
    for (const s of document.querySelectorAll(".seg-b")) s.classList.toggle("on", s.dataset.code === b.code || (b.inside && mainBeatOf(b) && s.dataset.code === mainBeatOf(b).code));
    const ph = $("lanes").querySelector(".playhead");
    if (ph) ph.style.left = pct(T);
    const swapsNow = DATA.swaps.filter((sw) => inWindow(sw, T)).map((sw) => sw.name);
    const tl = talent();
    const key = [b.code, hits.join(","), edges.join(","), talentIn, swapsNow.join(","), tl ? actionAt(tl.code, T) : "", camP ? actionAt(camP.code, T) : "", Math.round(T), state.lens, doneSeq].join("|");
    if (key !== lastPanelKey) {
      lastPanelKey = key;
      const checkedNames = people.filter((p) => p.checked && present(p, T)).map((p) => p.name).join(", ") || "nobody on the map yet";
      let pills = hits.length ? `<span class="pill warn">In frame: ${esc(hits.join(", "))}</span>` : `<span class="pill ok">Crew clear at ${esc(state.lens)} (sketch model)</span>`;
      if (edges.length) pills += `<span class="pill edge">Near the edge: ${esc(edges.join(", "))}</span>`;
      if (b.pill) pills += `<span class="pill neutral">${esc(b.pill)}</span>`;
      else if (T >= 0 && tl) pills += `<span class="pill ${talentIn ? "neutral" : "warn"}">${esc(tl.name)} ${talentIn ? "in frame" : "out of frame"}</span>`;
      for (const s of swapsNow) pills += `<span class="pill swap">${esc(s)} window</span>`;
      $("inview").innerHTML = pills;
      const notChecked = people.filter((p) => !p.onMap || !present(p, T)).filter((p) => p.code !== DATA.ui.talent).map((p) => p.name);
      $("notchecked").textContent = `Checked: ${checkedNames}, against walls only (no reflections, shadows or the boom pole). Not checked, off the map: ${notChecked.join(", ") || "nobody"}.`;
      $("doing").innerHTML = (tl ? `<b>${esc(tl.name)}</b><span>${esc(actionAt(tl.code, T) || "—")}</span>` : "") + (camP ? `<b>Camera</b><span>${esc(actionAt(camP.code, T) || "—")}</span>` : "");
      for (const row of $("plist").children) {
        const p = byCode[row.dataset.code]; if (!p) continue;
        let wh = "", mk = "";
        if (!present(p, T)) { const o = DATA.offPlan.find((x) => x.code === p.place); wh = o ? o.label : (p.placeText || "Off the map"); mk = p.place || ""; }
        else {
          const xy = posOf(p, T); const m = nearestMark(xy, p.markset);
          const was = posAt(p.track, T - 0.5); const moving = Math.hypot(xy[0] - was[0], xy[1] - was[1]) > 0.05;
          if (m) { wh = m.label + (m.status !== "Stated" ? " (draft)" : ""); mk = m.code; }
          else if (p.withcam && T < DATA.ui.routeUntil) { wh = DATA.ui.texts.withCamera; mk = moving ? "→" : "·"; }
          else if (moving) { wh = "On the move"; mk = "→"; }
          else { wh = "Holding"; mk = "·"; }
        }
        row.querySelector('[data-role="wh"]').textContent = wh;
        row.querySelector('[data-role="mk"]').textContent = mk;
      }
      if (state.tab === "cards") highlightCardRow();
    }
  }
  function timerAt(T) { if (T < DATA.timerStart) return mmss(DATA.timerLen); return mmss(Math.max(0, DATA.timerLen - (T - DATA.timerStart))); }
  function nearestMark(xy, codes) {
    let best = null, bd = 1e9;
    for (const m of DATA.marks) { if (codes && codes.length && !codes.includes(m.code)) continue; const d = Math.hypot(m.x - xy[0], m.y - xy[1]); if (d < bd) { bd = d; best = m; } }
    return bd <= 0.6 ? best : null;
  }

  // ---------------------------------------------------------------- timeline: beats, keyframe lanes, swap windows
  const t0s = -10;
  // the timeline shows the whole take, or two minutes around the playhead (for placing keyframes in busy stretches)
  function tw() {
    if (state.zoom !== "near") return [t0s, DATA.takeEnd];
    const span = 120;
    let a = state.zc - span / 2, b = state.zc + span / 2;
    if (a < t0s) { b += t0s - a; a = t0s; }
    if (b > DATA.takeEnd) { a -= b - DATA.takeEnd; b = DATA.takeEnd; }
    return [Math.max(t0s, a), b];
  }
  const pct = (t) => { const [a, b] = tw(); return ((t - a) / (b - a) * 100).toFixed(3) + "%"; };
  function setZoom(z) {
    state.zoom = z; state.zc = state.T;
    for (const b of document.querySelectorAll("[data-zoom]")) b.setAttribute("aria-pressed", String(b.dataset.zoom === z));
    $("timeline").classList.toggle("zoomed", z === "near");
    buildStrip(); buildLanes(); buildSwapStrip(); render();
  }
  function keepInZoom(T) {
    if (state.zoom !== "near") return;
    const [a, b] = tw();
    if (T < a + 4 || T > b - 4) { state.zc = T; buildStrip(); buildLanes(); buildSwapStrip(); }
  }
  function buildStrip() {
    const strip = $("strip"); strip.innerHTML = "";
    for (const b of mainBeats) {
      if (b.t1 <= 0 && b.t0 < 0) continue;
      const s = document.createElement("div");
      s.className = "seg-b"; s.dataset.code = b.code; s.title = b.code + ": " + b.name + " (" + mmss(b.t0) + ")";
      s.style.left = pct(b.t0); s.style.width = `calc(${pct(b.t1)} - ${pct(b.t0)} - 2px)`;
      s.textContent = b.name;
      s.addEventListener("click", () => setT(b.t0));
      strip.appendChild(s);
    }
    const flag = document.createElement("div"); flag.className = "flag"; flag.style.left = pct(DATA.cutPoint); flag.title = DATA.ui.texts.cutFlag || "Planned cut point"; strip.appendChild(flag);
    for (const [t, lab] of [[0, "0:00"], [DATA.timerStart, "timer"], [DATA.cutPoint, "cut"], [DATA.takeEnd, mmss(DATA.takeEnd)]]) {
      const tk = document.createElement("div"); tk.className = "tick" + (lab === "timer" ? " minor" : ""); tk.style.left = pct(t); tk.textContent = lab; strip.appendChild(tk);
    }
  }
  function buildLanes() {
    const box = $("lanes"); box.innerHTML = "";
    box.style.position = "relative";
    for (const p of people) {
      if (!p.onMap) continue;
      const lane = document.createElement("div"); lane.className = "lane"; lane.dataset.code = p.code;
      lane.innerHTML = `<span class="ln" title="${esc(p.name)}">${esc(p.initials)}</span>`;
      const color = `var(--${p.color})`;
      for (let i = 0; i + 1 < p.track.length; i++) {
        const a = p.track[i], b = p.track[i + 1];
        if (b[0] > a[0] && b[0] > t0s && Math.hypot(b[1] - a[1], b[2] - a[2]) > 0.05) {
          const a0 = Math.max(a[0], t0s);
          const w = document.createElement("div"); w.className = "walk"; w.style.left = pct(a0); w.style.width = `calc(${pct(b[0])} - ${pct(a0)})`; w.style.background = color; lane.appendChild(w);
        }
      }
      for (const kf of p.keys) {
        const d = document.createElement("button"); d.type = "button"; d.className = "kf" + (state.kf === kf.id ? " sel" : "") + (kf.what || kf.watch ? " has-text" : "");
        d.style.left = pct(Math.max(kf.t, t0s)); d.style.setProperty("--c", color); d.dataset.id = kf.id; d.dataset.code = p.code;
        if (kf.t < t0s) d.classList.add("early");
        d.title = `${p.name} at ${mmssH(kf.t)}: ${kf.mark || kf.at}${kf.what ? " · " + kf.what : ""}`;
        d.setAttribute("aria-label", `${p.name}, keyframe at ${mmssH(kf.t)}`);
        lane.appendChild(d);
      }
      lane.addEventListener("dblclick", (e) => { if (!state.edit || e.target.closest(".kf")) return; const T = laneT(lane, e.clientX); addKeyframeAt(p.code, T); });
      lane.addEventListener("click", (e) => { if (e.target.closest(".kf")) return; setT(laneT(lane, e.clientX)); });
      box.appendChild(lane);
    }
    const ph = document.createElement("div"); ph.className = "playhead"; box.appendChild(ph);
    if (state.focusKf) { const d = box.querySelector(`.kf[data-id="${CSS.escape(state.focusKf)}"]`); state.focusKf = null; if (d) d.focus(); }
  }
  const laneT = (lane, clientX) => { const r = lane.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width)); const [a, b] = tw(); return Math.round((a + f * (b - a)) * 2) / 2; };
  function buildSwapStrip() {
    const box = $("swapstrip"); box.innerHTML = "";
    for (const sw of DATA.swaps) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span class="l">${esc(sw.name)}</span>`;
      const u = document.createElement("div"); u.className = "use"; u.style.left = pct(Math.max(sw.useful[0], t0s));
      u.style.width = `calc(${pct(Math.min(sw.useful[1], DATA.takeEnd))} - ${pct(Math.max(sw.useful[0], t0s))})`;
      u.title = `${sw.name} is useful ${mmss(sw.useful[0])} to ${mmss(Math.min(sw.useful[1], DATA.takeEnd))}`; row.appendChild(u);
      for (const w of (sw.windows[state.lens] || [])) {
        const d = document.createElement("div"); d.className = "win"; d.style.left = pct(w[0]); d.style.width = `calc(${pct(w[1])} - ${pct(w[0])})`;
        d.title = `${sw.name}: ${mmss(w[0])} to ${mmss(w[1])} at ${state.lens}`;
        d.addEventListener("click", () => setT(w[0] + 1));
        row.appendChild(d);
      }
      box.appendChild(row);
    }
    $("swaptable").innerHTML = `<tr><th>Swap</th><th>Who</th><th>Useful</th><th>Windows</th></tr>` + DATA.swaps.map((sw) => {
      const ws = (sw.windows[state.lens] || []).map((w) => `${mmss(w[0])}-${mmss(w[1])}`).join(", ") || "none";
      return `<tr><td><b>${esc(sw.name)}</b>${tagFor(sw.status)}<br><span class="small">${esc(sw.if)}</span></td><td>${esc(sw.who)}<br><span class="small">from ${esc(sw.from)}</span></td><td class="wins">${mmss(sw.useful[0])}-${mmss(Math.min(sw.useful[1], DATA.takeEnd))}<br><span class="small">${sw.need === null ? "needs: open" : "needs " + sw.need + " s"}</span></td><td class="wins">${esc(ws).replace(/, /g, ",<wbr> ")}</td></tr>`;
    }).join("");
  }
  function buildPeopleList() {
    const plist = $("plist"); plist.innerHTML = "";
    for (const p of people) {
      const b = document.createElement("button");
      b.className = "prow"; b.type = "button"; b.dataset.code = p.code;
      b.innerHTML = `<i class="dot" style="background:var(--${esc(p.color)})"></i><span><span class="nm">${esc(p.name)}</span><br><span class="wh" data-role="wh"></span></span><span class="mk-code" data-role="mk"></span>`;
      b.addEventListener("click", () => openCard(p.code));
      plist.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- cards, resets, the calculator, about
  function cardChips() {
    const c = $("cardchips"); c.innerHTML = "";
    for (const p of people.concat([{ code: "RUN", name: "Run sheet" }, { code: "SIG", name: "Signals" }])) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = p.name; b.dataset.code = p.code;
      b.setAttribute("aria-pressed", String(state.sel === p.code));
      b.addEventListener("click", () => { state.sel = p.code; renderCard(); render(); });
      c.appendChild(b);
    }
  }
  function runSheetHTML() {
    const cols = DATA.runCols;
    let h = `<div class="tablewrap"><table><tr><th>Beat</th><th>Take</th>${cols.map((c) => `<th>${esc(c[1])}</th>`).join("")}</tr>`;
    for (const b of DATA.beats) {
      const note = DATA.runNotes[b.code];
      if (b.inside || note) { h += `<tr data-beat="${esc(b.code)}"><td><b>${esc(b.code)}</b><br><span class="small">${esc(b.name)}</span></td><td class="t">${mmss(b.t0)}</td><td colspan="${cols.length}" class="small"><i>${esc(note || "Inside the beat above.")}</i></td></tr>`; continue; }
      h += `<tr data-beat="${esc(b.code)}"><td><b>${esc(b.code)}</b><br><span class="small">${esc(b.name)}</span></td><td class="t">${b.t1 <= 0 && b.t0 < 0 ? "before" : mmss(b.t0)}</td>${cols.map((c) => `<td>${esc((DATA.run[b.code] || {})[c[0]] || "")}</td>`).join("")}</tr>`;
    }
    h += `<tr><td><b>End</b><br><span class="small">${esc(DATA.ui.texts.runEndName)}</span></td><td class="t">${mmss(DATA.takeEnd)}</td><td colspan="${cols.length}" class="small">${esc(DATA.ui.texts.runEnd)}</td></tr>`;
    return h + "</table></div>";
  }
  function signalsHTML() {
    return `<div class="tablewrap"><table><tr><th>Signal</th><th>Given by</th><th>How</th></tr>` +
      DATA.signals.map((r) => `<tr><td><b>${esc(r[0])}</b>${tagFor(r[6])}<br><span class="small">${esc(r[1])}</span></td><td>${esc(r[2])}<br><span class="small">to ${esc(r[3])}</span></td><td>${esc(r[4])}${r[7] ? `<br><span class="small">${esc(r[7])}</span>` : ""}</td></tr>`).join("") + "</table></div>";
  }
  function personCardHTML(p, print) {
    const tape = p.tape ? `<span class="tape ${esc(p.tape)}">${esc(p.tape)} tape</span>` : "";
    const clock = p.code === DATA.ui.talent ? DATA.ui.texts.clockTalent : DATA.ui.texts.clockOther;
    let h = `<h2${print ? "" : ' style="margin-top:12px"'}>${esc(p.name)}${tape}</h2><p class="small">${esc(p.role)} ${esc(clock)}</p><div class="tablewrap"><table><tr><th>When</th><th>Where</th><th>What you do</th></tr>`;
    for (const r of p.card) {
      const sub = [r[2] && r[2] !== "before action" ? r[2] : "", r[3] ? "timer " + r[3] : ""].filter(Boolean).join(" · ");
      h += `<tr data-beat="${esc(r[0])}"><td><b>${esc(r[1])}</b>${sub ? `<br><span class="small">${esc(sub)}</span>` : ""}</td><td>${esc(r[4])}</td><td>${esc(r[5])}${r[6] ? `<span class="watch">Watch for: ${esc(r[6])}</span>` : ""}</td></tr>`;
    }
    h += "</table></div>";
    if (p.key) h += `<p class="small"><b>Marks on this card:</b> ${esc(p.key)}.</p>`;
    if (p.preset.length) h += `<h3>Set before action</h3><ul class="tight">${p.preset.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    if (p.duties.length) h += `<h3>Between takes</h3><ul class="tight">${p.duties.map((d) => `<li><b>${esc(d[0])}, step ${esc(d[1])}</b> (${esc(d[5])} min after cut): ${esc(d[4])}</li>`).join("")}</ul>`;
    if (p.safety.length) h += `<h3>Safety and quiet</h3><ul class="tight">${p.safety.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    return h;
  }
  function renderCard() {
    if (!DATA) return;
    if (!state.sel || (!byCode[state.sel] && !["RUN", "SIG"].includes(state.sel))) state.sel = people[0] ? people[0].code : "RUN";
    for (const b of $("cardchips").children) b.setAttribute("aria-pressed", String(b.dataset.code === state.sel));
    const body = $("cardbody");
    if (state.sel === "RUN") body.innerHTML = `<h2 style="margin-top:12px">Run sheet</h2><p class="small">${esc(DATA.ui.texts.runIntro)}</p>` + runSheetHTML() + editNote("runsheet", "the Run sheet table");
    else if (state.sel === "SIG") body.innerHTML = `<h2 style="margin-top:12px">Signals</h2><p class="small">${esc(DATA.ui.texts.signalsIntro)}</p>` + signalsHTML() + editNote("signals", "the Signals table");
    else {
      const p = byCode[state.sel];
      body.innerHTML = personCardHTML(p) + (p.onMap ? `<p class="small edit-only">${esc(p.name)}'s card is built from their keyframes: change them on the map or in <button class="linkbtn" data-goto="moves" data-filter="who:${esc(p.code)}">Plan tables → Moves</button>.</p>`
        : editNote("cards", "Plan tables → Cards", p.code));
    }
    for (const b of body.querySelectorAll("[data-goto]")) b.addEventListener("click", () => gotoSection(b.dataset.goto, b.dataset.filter || ""));
    highlightCardRow();
  }
  const editNote = (sec, label, filter) => `<p class="small edit-only">Change this in <button class="linkbtn" data-goto="${sec}" data-filter="${esc(filter || "")}">${esc(label)}</button>.</p>`;
  function highlightCardRow() { const b = beatAt(state.T); for (const tr of document.querySelectorAll("#cardbody tr[data-beat]")) tr.classList.toggle("cur", tr.dataset.beat === b.code); }
  function openCard(code) { state.sel = code; setTab("cards"); renderCard(); render(); }
  function renderResets() {
    $("r-partial").textContent = DATA.ui.texts.resetPartialName; $("r-full").textContent = DATA.ui.texts.resetFullName;
    $("r-partial").setAttribute("aria-pressed", String(state.reset === "partial"));
    $("r-full").setAttribute("aria-pressed", String(state.reset === "full"));
    const rows = state.reset === "partial" ? DATA.resetPartial : DATA.resetFull;
    $("resetnote").textContent = state.reset === "partial" ? DATA.ui.texts.resetPartial : DATA.ui.texts.resetFull;
    $("resettable").innerHTML = `<tr><th>#</th><th>Who</th><th>What</th><th>Min after cut</th></tr>` +
      rows.map((r) => `<tr><td><b>${esc(r[1])}</b></td><td>${esc(r[2])}${r[3] || r[4] ? `<br><span class="small">${esc(r[3])}${r[4] ? " → " + esc(r[4]) : ""}</span>` : ""}</td><td>${esc(r[5])}${r[8] ? `<br><span class="small">${esc(r[8])}</span>` : ""}</td><td class="t">${esc(r[6])}</td></tr>`).join("");
    drawOverlay();
  }
  let calcInit = false;
  function calc() {
    if (!calcInit && DATA) { calcInit = true; $("c-now").value = DATA.ui.calc.now; $("c-stop").value = DATA.ui.calc.stop; $("c-reset").value = DATA.ui.calc.reset; }
    const toMin = (v) => { if (!v || !/^\d{1,2}:\d{2}/.test(v)) return null; const [h, m] = v.split(":").map(Number); return h * 60 + m; };
    const now = toMin($("c-now").value), stop = toMin($("c-stop").value), rv = $("c-reset").value, take = DATA.takeMin;
    const r = Number(rv);
    if (now === null || stop === null || rv === "" || !(r >= 0)) { $("c-out").textContent = "—"; $("c-explain").textContent = "Fill in the time of the cut, the stop time and the reset length."; }
    else {
      const mins = stop - now;
      $("c-out").textContent = mins <= 0 ? 0 : Math.floor(mins / (take + r));
      $("c-explain").textContent = `${Math.max(0, mins)} minutes to the stop. Counted from a cut: each attempt is a ${r}-minute reset, then about ${take} minutes (the take plus rolling). If everyone's already set and ready to roll, it can be one more. ${DATA.ui.texts.calcNote}`;
    }
    const stopM = stop === null ? 900 : stop;
    const resets = [5, 10, 15, 20], clocks = ["11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30"];
    const lbl = (c) => { const [h, m] = c.split(":").map(Number); return ((h - 1) % 12 + 1) + ":" + String(m).padStart(2, "0"); };
    $("lighttable").innerHTML = `<tr><th>Time of the cut</th>${resets.map((x) => `<th>${x}-min resets</th>`).join("")}</tr>` +
      clocks.map((c) => `<tr><td>${lbl(c)}</td>${resets.map((x) => { const m = stopM - toMin(c); return `<td>${m <= 0 ? 0 : Math.floor(m / (take + x))}</td>`; }).join("")}</tr>`).join("");
  }
  function renderAbout() {
    $("aboutlist").innerHTML = DATA.ui.texts.about.map((x) => `<li>${esc(x)}</li>`).join("");
    $("inferences").innerHTML = DATA.inferences.map((x) => `<li>${esc(x)}</li>`).join("");
    $("openitems").innerHTML = `<tr><th>Question</th><th>For</th><th>On the Questions doc?</th></tr>` +
      DATA.openItems.map((r) => `<tr><td>${esc(r[0])}<br><span class="small">${esc(r[2])}</span></td><td>${esc(r[1])}</td><td>${esc(r[3])}</td></tr>`).join("");
  }

  // ---------------------------------------------------------------- rebuild after each derivation
  function rebuild() {
    people = DATA.people;
    byCode = Object.fromEntries(people.map((p) => [p.code, p]));
    markXY = Object.fromEntries(DATA.marks.map((m) => [m.code, [m.x, m.y]]));
    markBy = Object.fromEntries(DATA.marks.map((m) => [m.code, m]));
    propXY = Object.fromEntries(DATA.props.map((p) => [p.id, [p.x, p.y]]));
    VIEWS = DATA.ui.views;
    mainBeats = DATA.beats.filter((b) => !b.inside); insideBeats = DATA.beats.filter((b) => b.inside);
    if (!state.lens || !(state.lens in DATA.lenses)) state.lens = DATA.ui.lens;
    document.title = DATA.ui.title || "Shot Planner";
    $("title").textContent = DATA.ui.title || "Shot Planner";
    $("eyebrow").textContent = DATA.ui.eyebrow || "";
    $("stamp").textContent = DATA.ui.texts.stamp || DATA.privacy;
    $("vline").textContent = [DATA.draft, DATA.date, DATA.version ? "plan " + DATA.version : ""].filter(Boolean).join(" · ") + " · live: changes show up for everyone";
    $("lg-talent").textContent = talent() ? talent().name : "Talent";
    $("scrub").max = DATA.takeEnd;
    if (state.T > DATA.takeEnd) state.T = DATA.takeEnd;
    const lensBox = $("lenses");
    lensBox.innerHTML = "";
    for (const name of Object.keys(DATA.lenses)) {
      const b = document.createElement("button"); b.textContent = name; b.setAttribute("aria-pressed", String(name === state.lens));
      b.addEventListener("click", () => { state.lens = name; for (const c of lensBox.children) c.setAttribute("aria-pressed", String(c.textContent === name)); lastPanelKey = ""; buildSwapStrip(); render(); });
      lensBox.appendChild(b);
    }
    buildNodes(); buildPeopleList(); buildStrip(); buildLanes(); buildSwapStrip(); cardChips(); calc(); renderAbout();
    const nw = WARN.length; $("warncount").hidden = !nw; $("warncount").textContent = nw;
    if (state.tab === "cards") renderCard();
    if (state.tab === "resets") renderResets();
    if (state.tab === "checks") renderChecks();
    if (state.tab === "plan") renderPlan(false);
    renderInspector();
    viewNow = null; lastPanelKey = "";
    if (firstData) { firstData = false; afterFirstData(); }
    render();
    const empty = !Object.keys(PLAN.sections).some((k) => Object.keys(PLAN.sections[k] || {}).length);
    if (empty && serverLoaded) showEmpty();
    else if (!empty && $("inspector").dataset.empty === "1") { $("inspector").dataset.empty = ""; $("inspector").hidden = true; }
  }
  function flushPending() { if (pendingMsg && !drag && !kdrag) { const m = pendingMsg; pendingMsg = null; onDerived(m); } }
  function afterFirstData(broken) {
    const tab = hashParts[1];
    const want = ["take", "cards", "resets", "plan", "checks", "history", "about"].includes(tab) ? tab : "take";
    setTab(broken && !["plan", "history"].includes(want) ? "plan" : want);
    setEdit(state.edit);
    try { document.fonts.ready.then(() => drawOverlay()); } catch (e) { /* fonts load later */ }
    startPresence();
  }
  function showEmpty() {
    const box = $("inspector"); box.hidden = false; box.dataset.empty = "1"; box.dataset.kf = "";
    box.innerHTML = `<h2>This plan is empty</h2><p class="small">Load a copy of a plan (a .json file) on the History tab to start.</p><button class="btn" id="go-hist">Go to History</button>`;
    $("go-hist").addEventListener("click", () => setTab("history"));
  }

  // ---------------------------------------------------------------- writing changes
  const undoStack = [];
  async function commit(ops, label, opts) {
    if (!state.edit && !(opts && opts.always)) { toast("Turn on Edit to change the plan."); return null; }
    if (!me) { await askName(); if (!me) { toast("Not saved: set your name to save changes."); revertUI(); return null; } }
    // a field edit to a row someone else has just deleted would bring back half a row: drop it
    const gone = ops.filter((op) => op.f && !(PLAN.sections[op.s] || {})[op.id]);
    if (gone.length) {
      ops = ops.filter((op) => !gone.includes(op));
      toast("Someone else just deleted that row, so this change wasn't saved.");
      if (!ops.length) return null;
    }
    try {
      const r = await store.commit(ops, label, opts);
      if (!r) return null;
      let entry = null;
      if (!(opts && opts.noUndo)) { entry = { label, ops: r.ops }; undoStack.push(entry); $("undo").disabled = false; }
      if (!(opts && opts.quiet)) toast(label, entry);
      r.done.catch((e) => toast("Couldn't save: " + (e.code || e.message) + ". Check your connection, then try again."));
      return r;
    } catch (e) { console.error(e); toast("Couldn't save: " + (e.message || e)); return null; }
  }
  // put the screen back to what's stored (after a change that wasn't saved)
  function revertUI() {
    state.override = null;
    if (!DATA) { if (state.tab === "plan") renderPlan(true); return; }
    buildLanes(); renderInspector(true);
    if (state.tab === "plan") renderPlan(true);
    viewNow = null; lastPanelKey = ""; render();
  }
  // undo one of your own changes; if someone has changed the same thing since, ask first
  const stable = (v) => JSON.stringify(v === undefined ? null : v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x).filter((kk) => !kk.startsWith("_")).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x));
  const sameVal = (a, b) => stable(a) === stable(b);
  const currentVal = (s2, id, f) => { const row = (PLAN.sections[s2] || {})[id]; return f ? getF(row || {}, f.join(".")) : row; };
  async function undoEntry(entry, force) {
    const changed = entry.ops.filter((o) => !sameVal(currentVal(o.s, o.id, o.f), o.v));
    if (changed.length && !force) {
      toastAsk("Someone has changed this since. Undo yours anyway?", "Undo anyway", () => undoEntry(entry, true));
      return;
    }
    const i = undoStack.indexOf(entry);
    if (i >= 0) undoStack.splice(i, 1);
    $("undo").disabled = !undoStack.length;
    await commit(entry.ops.map((o) => ({ s: o.s, id: o.id, f: o.f, v: o.before })), "Undo: " + entry.label, { noUndo: true, always: true });
  }
  function undoLast() { const last = undoStack[undoStack.length - 1]; if (last) undoEntry(last); }
  $("undo").addEventListener("click", undoLast);
  function nextO(sec) { const rows = Object.values(PLAN.sections[sec] || {}); return rows.reduce((m, r) => Math.max(m, Number(r.o) || 0), 0) + 1; }
  function orderBetween(sec, afterId) {
    const rows = Object.entries(PLAN.sections[sec] || {}).map(([id, r]) => ({ id, o: Number(r.o) || 0 })).sort((a, b) => a.o - b.o);
    const i = rows.findIndex((r) => r.id === afterId);
    if (i < 0) return nextO(sec);
    const a = rows[i].o, b = rows[i + 1] ? rows[i + 1].o : a + 2;
    return (a + b) / 2;
  }
  let toastTimer = null;
  function showToast(html, ms, buttons) {
    const t = $("toast"); t.hidden = false; t.innerHTML = html; t.dataset.btn = buttons ? "1" : "";
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { t.hidden = true; t.dataset.btn = ""; }, ms);
    return () => { clearTimeout(toastTimer); t.hidden = true; t.dataset.btn = ""; };
  }
  function toast(msg, entry) {
    const close = showToast(`<span>${esc(msg)}</span>` + (entry ? `<button type="button" id="toast-undo">Undo</button>` : ""), entry ? 6000 : 4500, !!entry);
    if (entry) $("toast-undo").addEventListener("click", () => { close(); undoEntry(entry); });
  }
  // a question with two answers; sticky ones stay up until answered (someone's unsaved typing depends on it)
  function toastAsk(msg, yes, onYes, opts) {
    opts = opts || {};
    const alt = opts.alt ? `<button type="button" id="toast-alt">${esc(opts.alt[0])}</button>` : "";
    const close = showToast(`<span>${esc(msg)}</span><button type="button" id="toast-yes">${esc(yes)}</button>${alt}<button type="button" id="toast-no">${esc(opts.no || "Keep theirs")}</button>`, opts.sticky ? 0 : 12000, true);
    $("toast-yes").addEventListener("click", () => { close(); onYes(); });
    if (opts.alt) $("toast-alt").addEventListener("click", () => { close(); opts.alt[1](); });
    $("toast-no").addEventListener("click", () => { close(); if (opts.onNo) opts.onNo(); });
  }
  // two people added lines to the same text at once: theirs plus the lines only you added (null when either of you
  // changed or removed a line, or you added nothing new)
  function mergeLines(base, theirs, mine) {
    const L = (x) => String(x == null ? "" : x).split("\n");
    const b = L(base), t = L(theirs), m = L(mine);
    const added = (from, to) => { const out = []; let i = 0; for (const line of to) { if (i < from.length && line === from[i]) i++; else out.push(line); } return i === from.length ? out : null; };
    const mineNew = added(b, m), theirsNew = added(b, t);
    if (!mineNew || !theirsNew) return null;
    const extra = mineNew.filter((x) => x.trim() && !t.includes(x));
    return extra.length ? t.concat(extra).join("\n").replace(/\n+$/, "") : null;
  }
  // you typed over something someone else saved meanwhile: ask, and offer to keep both when that's possible
  function askOverwrite(who, base, theirs, mine, isText, save, keepTheirs) {
    const both = isText && typeof theirs === "string" ? mergeLines(base, theirs, mine) : null;
    if (both !== null) toastAsk(`${who} changed this while you were typing. Keep both?`, "Keep both", () => save(both), { sticky: true, alt: ["Only mine", () => save(mine)], onNo: keepTheirs });
    else toastAsk(`${who} changed this while you were typing. Save yours over theirs?`, "Save mine", () => save(mine), { sticky: true, onNo: keepTheirs });
  }
  const announced = new Set();
  function noteRemote(changed) {
    let best = null;
    for (const s of changed || []) for (const [id, r] of Object.entries(PLAN.sections[s] || {})) { const at = tsMs(r && r._at); if (r && r._by && r._by !== me && (!best || at > best.at)) best = { at, by: r._by, s, id }; }
    if (!best || Date.now() - best.at >= 20000) return;
    const key = `${best.s}/${best.id}@${best.at}`;
    if (announced.has(key)) return;
    announced.add(key);
    const t = $("toast");
    if (!t.hidden && t.dataset.btn === "1") return;      // never take away someone's Undo or an open question
    toast(`${best.by} changed ${SECTIONS[best.s] ? SECTIONS[best.s].title : best.s}`);
  }

  // ---------------------------------------------------------------- your name, on your changes
  let nameResolve = null;
  function askName() {
    return new Promise((resolve) => {
      nameResolve = resolve;
      const names = [...new Set((DATA ? DATA.people : []).map((p) => p.name).filter((n) => /^[A-Z][a-z]+$/.test(n)))];
      openModal("Your name", `<p class="small">It goes on your changes in History, so the team knows who changed what.</p>
        <div class="chips" id="name-chips">${names.map((n) => `<button type="button" data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>
        <div class="form" style="grid-template-columns:minmax(0,1fr)"><input id="name-in" placeholder="Or type your name" value="${esc(me)}" maxlength="40"></div>
        <div class="btnrow"><button class="btn primary" id="name-ok">Save</button><button class="btn" id="name-cancel">Cancel</button></div>`);
      const done = (n) => { n = (n || "").trim(); if (n) { me = n; ls.set("name", n); store.setName(n); $("me-name").textContent = n; startPresence(); } nameResolve = null; closeModal(); resolve(n); };
      for (const b of document.querySelectorAll("#name-chips button")) b.addEventListener("click", () => done(b.dataset.n));
      $("name-ok").addEventListener("click", () => done($("name-in").value));
      $("name-in").addEventListener("keydown", (e) => { if (e.key === "Enter") done($("name-in").value); });
      $("name-cancel").addEventListener("click", () => done(""));
      setTimeout(() => $("name-in").focus(), 30);
    });
  }
  $("me").addEventListener("click", () => askName());
  $("me-name").textContent = me || "set your name";
  function openModal(title, html) { $("modal-title").textContent = title; $("modal-body").innerHTML = html; $("modal").hidden = false; }
  function closeModal() { $("modal").hidden = true; $("modal-body").innerHTML = ""; if (nameResolve) { const f = nameResolve; nameResolve = null; f(""); } }
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });

  // ---------------------------------------------------------------- edit mode
  function setEdit(on) {
    state.edit = on; ls.set("edit", on);
    $("edit").setAttribute("aria-pressed", String(on));
    $("edit-lbl").textContent = on ? "Editing" : "Edit";
    $("edit-hint").hidden = !on || state.tab !== "take";
    document.body.classList.toggle("editing", on);
    map.classList.toggle("marks-movable", on && state.moveMarks);
    for (const e of document.querySelectorAll(".edit-only")) e.hidden = !on;
    $("import-file").disabled = !on; $("import-lbl").classList.toggle("off", !on);
    if (state.tab === "plan") renderPlan(true);
    if (state.tab === "history") { renderHistory(); renderSnaps(); }
    renderInspector();
    if (DATA) { viewNow = null; render(); }
  }
  $("edit").addEventListener("click", () => setEdit(!state.edit));
  $("move-marks").addEventListener("change", (e) => { state.moveMarks = e.target.checked; map.classList.toggle("marks-movable", state.edit && state.moveMarks); viewNow = null; render(); });

  // ---------------------------------------------------------------- map: drag people, marks and facing
  function svgPoint(e) {
    const pt = map.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const m = map.getScreenCTM(); if (!m) return [0, 0];
    const q = pt.matrixTransform(m.inverse()); return [q.x / S, q.y / S];
  }
  const round2 = (v) => Math.round(v * 20) / 20;
  function snapMark(xy) {
    const r = Math.max(0.28, px(16) / S);
    let best = null, bd = r;
    for (const m of DATA.marks) { const d = Math.hypot(m.x - xy[0], m.y - xy[1]); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  let drag = null;
  map.addEventListener("pointerdown", (e) => {
    if (!DATA || e.button > 0) return;
    const handle = e.target.closest(".handle, .handle-hit");
    const pg = e.target.closest(".person");
    const mk = e.target.closest(".mk, .prop");
    if (handle && pg && state.edit) { drag = { kind: "face", code: pg.dataset.code, id: e.pointerId }; }
    else if (mk && state.edit && state.moveMarks) { drag = { kind: "mark", el: mk, code: mk.dataset.code || mk.dataset.prop, rowId: mk.dataset.id, isProp: !!mk.dataset.prop, start: svgPoint(e), id: e.pointerId, moved: false }; }
    else if (pg) { drag = { kind: "person", code: pg.dataset.code, start: svgPoint(e), sx: e.clientX, sy: e.clientY, id: e.pointerId, moved: false }; }
    else return;
    map.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  map.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const xy = svgPoint(e);
    if (drag.kind === "person") {
      if (!state.edit) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      if (!drag.moved) { drag.moved = true; drag.from = posOf(byCode[drag.code], state.T); nodes[drag.code].g.classList.add("dragging"); if (state.playing) togglePlay(false); }
      const m = snapMark(xy);
      drag.to = m ? [m.x, m.y] : [round2(xy[0]), round2(xy[1])]; drag.mark = m ? m.code : "";
      state.override = { code: drag.code, xy: drag.to, T: state.T, seq: Infinity };
      gDrag.innerHTML = "";
      el("line", { x1: drag.from[0] * S, y1: drag.from[1] * S, x2: drag.to[0] * S, y2: drag.to[1] * S, class: "ghost-line" }, gDrag);
      if (m) el("circle", { cx: m.x * S, cy: m.y * S, r: Math.max(26, px(16)), class: "snap-ring" }, gDrag);
      const tip = el("text", { x: drag.to[0] * S + px(18), y: drag.to[1] * S - px(18), class: "drag-tip", "font-size": px(13) }, gDrag);
      tip.textContent = `${mmssH(Math.round(state.T * 2) / 2)} · ${m ? m.code : drag.to[0].toFixed(2) + ", " + drag.to[1].toFixed(2)}`;
      lastPanelKey = ""; render();
    } else if (drag.kind === "face") {
      const p = byCode[drag.code], at = posOf(p, state.T);
      let deg = Math.atan2(xy[1] - at[1], xy[0] - at[0]) * 180 / Math.PI;
      deg = (Math.round(deg / 5) * 5 + 360) % 360;
      drag.deg = deg; drag.moved = true;
      state.override = { code: drag.code, xy: at, face: deg, T: state.T, seq: Infinity };
      render();
    } else if (drag.kind === "mark") {
      drag.moved = true;
      const m = [round2(xy[0]), round2(xy[1])]; drag.to = m;
      gDrag.innerHTML = "";
      el("circle", { cx: m[0] * S, cy: m[1] * S, r: Math.max(20, px(12)), class: "snap-ring" }, gDrag);
      const tip = el("text", { x: m[0] * S + px(16), y: m[1] * S - px(16), class: "drag-tip", "font-size": px(13) }, gDrag);
      tip.textContent = `${drag.code} · ${m[0].toFixed(2)}, ${m[1].toFixed(2)}`;
      drag.el.setAttribute("transform", `translate(${(m[0] - (drag.isProp ? propXY[drag.code][0] : markXY[drag.code][0])) * S},${(m[1] - (drag.isProp ? propXY[drag.code][1] : markXY[drag.code][1])) * S})`);
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    gDrag.innerHTML = "";
    setTimeout(flushPending, 0);
    if (d.kind === "person") {
      if (nodes[d.code]) nodes[d.code].g.classList.remove("dragging");
      if (!d.moved) { personClick(d.code); return; }
      placePerson(d.code, d.mark, d.to);
    } else if (d.kind === "face") {
      if (d.moved) setFacing(d.code, d.deg);
    } else if (d.kind === "mark") {
      if (!d.moved) return;
      const row = PLAN.sections.marks && PLAN.sections.marks[d.rowId];
      if (!row) { viewNow = null; render(); return; }
      commit([{ s: "marks", id: d.rowId, f: ["x"], v: d.to[0] }, { s: "marks", id: d.rowId, f: ["y"], v: d.to[1] }], `Moved ${d.isProp ? "" : "mark "}${d.code} to ${d.to[0].toFixed(2)}, ${d.to[1].toFixed(2)}`)
        .then((r) => { if (!r) { viewNow = null; render(); } });
    }
  };
  map.addEventListener("pointerup", endDrag);
  // phones: in edit mode a finger on a person (or a movable mark) drags it; anywhere else on the map still scrolls the page
  map.addEventListener("touchstart", (e) => {
    if (!state.edit || !DATA || !e.target.closest) return;
    if (e.target.closest(".person") || (state.moveMarks && e.target.closest(".mk, .prop"))) e.preventDefault();
  }, { passive: false });
  map.addEventListener("pointercancel", () => {
    if (drag && (drag.kind === "person" || drag.kind === "face")) { state.override = null; if (nodes[drag.code]) nodes[drag.code].g.classList.remove("dragging"); }
    const wasMark = drag && drag.kind === "mark";
    drag = null; gDrag.innerHTML = "";
    if (wasMark) viewNow = null;
    render(); flushPending();
  });

  function personClick(code) {
    if (!state.edit) { openCard(code); return; }
    const p = byCode[code];
    const k = p.keys.filter((kf) => kf.t <= state.T + 0.26).pop() || p.keys[0];
    if (k) selectKey(k.id, false);
  }
  function keyAt(p, T) { return p.keys.find((k) => Math.abs(k.t - T) <= 0.25); }
  async function placePerson(code, mark, xy) {
    const p = byCode[code];
    const T = Math.round(state.T * 2) / 2;
    const at = mark || `${xy[0].toFixed(2)}, ${xy[1].toFixed(2)}`;
    const k = keyAt(p, T);
    state.override = { code, xy, T: state.T, seq: seq + 1 };
    let r;
    if (k) r = await commit([{ s: "moves", id: k.id, f: ["at"], v: at }], `${p.name} at ${mmssH(k.t)}: moved to ${at}`);
    else {
      const id = newId();
      r = await commit([{ s: "moves", id, f: null, v: { o: nextO("moves"), who: code, t: T, at, face: "", what: "", watch: "", beat: "", status: "Proposed" } }], `${p.name}: new keyframe at ${mmssH(T)} (${at})`);
      if (r) state.kf = id;
    }
    if (!r) { state.override = null; render(); }
  }
  async function setFacing(code, deg) {
    const k = selectedKey();
    if (!k || k.p.code !== code) { state.override = null; render(); return; }
    state.override = { code, xy: posOf(byCode[code], state.T), face: deg, T: state.T, seq: seq + 1 };
    const r = await commit([{ s: "moves", id: k.k.id, f: ["face"], v: deg }], `${k.p.name} at ${mmssH(k.k.t)}: facing ${deg}°`);
    if (!r) { state.override = null; render(); }
  }
  function addKeyframeAt(code, T) {
    const p = byCode[code];
    if (keyAt(p, T)) { selectKey(keyAt(p, T).id, true); return; }
    const xy = posAt(p.track, T) || [0, 0];
    const m = snapMark(xy);
    const at = m && Math.hypot(m.x - xy[0], m.y - xy[1]) < 0.05 ? m.code : `${xy[0].toFixed(2)}, ${xy[1].toFixed(2)}`;
    const id = newId();
    commit([{ s: "moves", id, f: null, v: { o: nextO("moves"), who: code, t: T, at, face: "", what: "", watch: "", beat: "", status: "Proposed" } }], `${p.name}: new keyframe at ${mmssH(T)}`)
      .then((r) => { if (r) { state.kf = id; setT(T); } });
  }

  // ---------------------------------------------------------------- lanes: drag a keyframe to retime it
  let kdrag = null;
  const tipEl = document.createElement("div"); tipEl.className = "kf-tip"; tipEl.hidden = true; document.body.appendChild(tipEl);
  $("lanes").addEventListener("pointerdown", (e) => {
    const d = e.target.closest(".kf"); if (!d || e.button > 0) return;
    const p = byCode[d.dataset.code]; const k = p.keys.find((x) => x.id === d.dataset.id); if (!k) return;
    kdrag = { d, p, k, id: e.pointerId, sx: e.clientX, moved: false, lane: d.parentElement, T: k.t };
    d.setPointerCapture(e.pointerId); e.preventDefault();
  });
  $("lanes").addEventListener("pointermove", (e) => {
    if (!kdrag || e.pointerId !== kdrag.id || !state.edit) return;
    if (!kdrag.moved && Math.abs(e.clientX - kdrag.sx) < 4) return;
    kdrag.moved = true;
    const i = kdrag.p.keys.indexOf(kdrag.k);
    const lo = i > 0 ? kdrag.p.keys[i - 1].t + 0.5 : -60, hi = i + 1 < kdrag.p.keys.length ? kdrag.p.keys[i + 1].t - 0.5 : DATA.takeEnd;
    const T = Math.max(lo, Math.min(hi, laneT(kdrag.lane, e.clientX)));
    kdrag.T = T; kdrag.d.style.left = pct(T);
    tipEl.hidden = false; tipEl.textContent = `${mmssH(kdrag.k.t)} → ${mmssH(T)}`;
    tipEl.style.left = e.clientX + 12 + "px"; tipEl.style.top = e.clientY - 28 + "px";
  });
  const endK = (e) => {
    if (!kdrag || e.pointerId !== kdrag.id) return;
    const g = kdrag; kdrag = null; tipEl.hidden = true;
    setTimeout(flushPending, 0);
    if (!g.moved || g.T === g.k.t) { selectKey(g.k.id, true, true); return; }
    commit([{ s: "moves", id: g.k.id, f: ["t"], v: g.T }], `${g.p.name}: keyframe ${mmssH(g.k.t)} moved to ${mmssH(g.T)}`).then((r) => { if (r) { state.kf = g.k.id; setT(g.T); } else buildLanes(); });
  };
  $("lanes").addEventListener("pointerup", endK);
  window.addEventListener("pointerup", (e) => { if (kdrag) endK(e); });
  $("lanes").addEventListener("lostpointercapture", (e) => { if (kdrag) endK(e); });
  $("lanes").addEventListener("pointercancel", () => { kdrag = null; tipEl.hidden = true; buildLanes(); flushPending(); });
  $("lanes").addEventListener("keydown", (e) => {
    const d = e.target.closest(".kf"); if (!d) return;
    const p = byCode[d.dataset.code]; const k = p.keys.find((x) => x.id === d.dataset.id); if (!k) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectKey(k.id, true); }
    else if (state.edit && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const i = p.keys.indexOf(k);
      const lo = i > 0 ? p.keys[i - 1].t + 0.5 : -60, hi = i + 1 < p.keys.length ? p.keys[i + 1].t - 0.5 : DATA.takeEnd;
      const nt = Math.max(lo, Math.min(hi, k.t + (e.key === "ArrowLeft" ? -0.5 : 0.5)));
      if (nt === k.t) return;
      state.focusKf = k.id;
      commit([{ s: "moves", id: k.id, f: ["t"], v: nt }], `${p.name}: keyframe ${mmssH(k.t)} moved to ${mmssH(nt)}`, { quiet: true }).then(() => { state.kf = k.id; setT(nt); });
    }
  });

  // ---------------------------------------------------------------- the keyframe inspector
  function selectedKey() {
    if (!state.kf || !DATA) return null;
    for (const p of people) { const k = p.keys.find((x) => x.id === state.kf); if (k) return { p, k }; }
    return null;
  }
  function selectKey(id, seek, reveal) {
    state.kf = id;
    const s = selectedKey();
    if (s && seek) setT(s.k.t);
    for (const b of document.querySelectorAll(".lane .kf")) b.classList.toggle("sel", b.dataset.id === id);
    if (state.tab !== "take") setTab("take");
    renderInspector(true); render();
    if (reveal && window.innerWidth < 980) { const r2 = $("inspector").getBoundingClientRect(); if (r2.top > window.innerHeight - 80) toast("Its details are below the map: scroll down to edit them."); }
  }
  function patchInspector(p, k) {
    const setv = (id, v) => { const e = $(id); if (e && e !== document.activeElement && e.value !== v) e.value = v; };
    const faceIsNum = typeof k.face === "number";
    setv("i-t", mmssH(k.t)); setv("i-mark", k.mark || ""); setv("i-xy", k.mark ? "" : k.at);
    setv("i-face", faceIsNum ? "#deg" : (k.face === null ? "" : String(k.face))); setv("i-deg", faceIsNum ? String(k.face) : "");
    setv("i-what", k.what); setv("i-watch", k.watch); setv("i-beat", k.beat || ""); setv("i-status", k.status || "");
    const h = $("inspector").querySelector("h2"); if (h) h.textContent = `${p.name} · ${mmssH(k.t)}`;
  }
  function renderInspector(force) {
    const box = $("inspector");
    const s = selectedKey();
    if (!s || state.tab !== "take") { if (box.dataset.empty !== "1") box.hidden = true; return; }
    const { p, k } = s;
    if (!force && !box.hidden && box.dataset.kf === k.id && box.contains(document.activeElement)) { patchInspector(p, k); return; }
    box.hidden = false; box.dataset.kf = k.id; box.dataset.empty = "";
    const dis = state.edit ? "" : "disabled";
    const row = (PLAN.sections.moves || {})[k.id] || {};
    const markOpts = DATA.marks.map((m) => `<option value="${esc(m.code)}"${k.mark === m.code ? " selected" : ""}>${esc(m.code)}: ${esc(m.label)}</option>`).join("");
    const faceVal = k.face === null ? "" : String(k.face);
    const faceIsNum = typeof k.face === "number";
    const faceOpts = [`<option value="">Keeps the last facing</option>`]
      .concat(people.filter((x) => x.onMap && x.code !== p.code).map((x) => `<option value="${esc(x.code)}"${faceVal === x.code ? " selected" : ""}>Toward ${esc(x.name)}</option>`))
      .concat(DATA.marks.map((m) => `<option value="${esc(m.code)}"${faceVal === m.code ? " selected" : ""}>Toward ${esc(m.code)}</option>`))
      .concat(DATA.props.map((x) => `<option value="${esc(x.id)}"${faceVal === x.id ? " selected" : ""}>Toward the ${esc(x.label.toLowerCase())}</option>`))
      .concat([`<option value="#deg"${faceIsNum ? " selected" : ""}>A direction (degrees)</option>`]).join("");
    const beatOpts = [`<option value="">By its time (${esc(beatAt(k.t).code)})</option>`].concat(DATA.beats.map((b) => `<option value="${esc(b.code)}"${k.beat === b.code ? " selected" : ""}>${esc(b.code)}: ${esc(b.name)}</option>`)).join("");
    const stOpts = ["", "Proposed", "Stated", "Confirmed", "Open", "Dropped"].map((x) => `<option${k.status === x ? " selected" : ""}>${x}</option>`).join("");
    const i = p.keys.indexOf(k);
    box.innerHTML = `<div class="inspector-head"><h2>${esc(p.name)} · ${mmssH(k.t)}</h2><span class="seg"><button id="i-prev" ${i > 0 ? "" : "disabled"} title="Their previous keyframe">◀</button><button id="i-next" ${i + 1 < p.keys.length ? "" : "disabled"} title="Their next keyframe">▶</button><button id="i-close" title="Close">✕</button></span></div>
      <p class="small">Keyframe ${i + 1} of ${p.keys.length}. ${state.edit ? "Changes save when you leave a field." : "Turn on Edit to change it."}</p>
      <div class="form">
        <label for="i-t">Take time</label><input id="i-t" value="${esc(mmssH(k.t))}" ${dis} placeholder="m:ss" autocomplete="off">
        <label for="i-mark">Where</label><div class="pair"><select id="i-mark" ${dis}><option value="">A spot (x, y)</option>${markOpts}</select><input id="i-xy" value="${esc(k.mark ? "" : k.at)}" placeholder="x, y (meters)" ${dis}></div>
        <label for="i-face">Facing</label><div class="pair"><select id="i-face" ${dis}>${faceOpts}</select><input id="i-deg" type="number" step="5" value="${faceIsNum ? esc(k.face) : ""}" placeholder="degrees" ${dis} ${faceIsNum ? "" : "hidden"}></div>
        <label for="i-what">What they do</label><textarea id="i-what" ${dis}>${esc(k.what)}</textarea>
        <label for="i-watch">Watch for</label><textarea id="i-watch" ${dis} placeholder="{timer} gives the timer reading here">${esc(k.watch)}</textarea>
        <label for="i-beat">Beat</label><select id="i-beat" ${dis}>${beatOpts}</select>
        <label for="i-status">Status</label><select id="i-status" ${dis}>${stOpts}</select>
      </div>
      ${state.edit ? `<div class="btnrow"><button class="btn" id="i-add">Add one at the playhead</button><button class="btn" id="i-dup">Copy to 5 s later</button><span id="i-delbox"><button class="btn danger" id="i-del">Delete</button></span></div>` : ""}
      <div class="meta">${row._by ? `Last changed by ${esc(row._by)}, ${ago(tsMs(row._at))}.` : ""} Degrees: ${esc(DATA.ui.texts.degrees)}</div>`;
    // the keyframe as it is when a button is pressed (someone may have retimed or deleted it since this was drawn)
    const now = () => { const s2 = selectedKey(); return s2 && s2.k.id === k.id ? s2 : null; };
    const gone = () => { toast("That keyframe has just been deleted."); state.kf = null; renderInspector(); buildLanes(); render(); return null; };
    const set1 = (f, v, label) => { const c2 = now(); if (!c2) return gone(); return commit([{ s: "moves", id: k.id, f: [f], v }], `${c2.p.name} at ${mmssH(c2.k.t)}: ${label}`, { quiet: true }); };
    $("i-prev").addEventListener("click", () => { const c2 = now(); if (!c2) return gone(); const j = c2.p.keys.indexOf(c2.k); if (j > 0) selectKey(c2.p.keys[j - 1].id, true); });
    $("i-next").addEventListener("click", () => { const c2 = now(); if (!c2) return gone(); const j = c2.p.keys.indexOf(c2.k); if (j + 1 < c2.p.keys.length) selectKey(c2.p.keys[j + 1].id, true); });
    $("i-close").addEventListener("click", () => { state.kf = null; renderInspector(); buildLanes(); render(); });
    if (!state.edit) return;
    // typing while someone else changes the same field: ask before writing over theirs
    const stored = (f) => getF((PLAN.sections.moves || {})[k.id] || {}, f);
    const seen = {};
    for (const [eid, f] of [["i-t", "t"], ["i-xy", "at"], ["i-deg", "face"], ["i-what", "what"], ["i-watch", "watch"]]) $(eid).addEventListener("focus", () => { seen[f] = stable(stored(f)); });
    const guarded = (f, v, go) => {
      const cur = stored(f);
      const save = (val) => { seen[f] = stable(val); go(val); };
      if (seen[f] !== undefined && stable(cur) !== seen[f] && !sameVal(cur, v)) {
        const row2 = (PLAN.sections.moves || {})[k.id] || {};
        askOverwrite(row2._by && row2._by !== me ? row2._by : "Someone", JSON.parse(seen[f]), cur, v, f === "what" || f === "watch", save, () => { delete seen[f]; renderInspector(true); });
        return;
      }
      save(v);
    };
    $("i-t").addEventListener("change", (e) => {
      const { t, how } = parseTimeInput(e.target.value);
      const c2 = now(); if (!c2) return gone();
      if (t === null || t < -600 || t > DATA.takeEnd + 600) { toast("Take time is m:ss, like 3:05 or 3:05.5"); e.target.value = mmssH(c2.k.t); return; }
      guarded("t", t, (val) => commit([{ s: "moves", id: k.id, f: ["t"], v: val }], `${c2.p.name}: keyframe now at ${mmssH(val)}${how === "seconds" ? " (read as seconds)" : ""}`).then((r) => { if (r) setT(val); }));
    });
    $("i-mark").addEventListener("change", (e) => { if (e.target.value) set1("at", e.target.value, "moved to " + e.target.value); else $("i-xy").focus(); });
    $("i-xy").addEventListener("change", (e) => { const v = e.target.value.trim(); if (!/^-?\d+(\.\d+)?\s*[, ]\s*-?\d+(\.\d+)?$/.test(v)) { toast("A spot is 'x, y' in meters, like 1.40, 2.95"); return; } guarded("at", v, (val) => set1("at", val, "moved to " + val)); });
    $("i-face").addEventListener("change", (e) => { const v = e.target.value; if (v === "#deg") { $("i-deg").hidden = false; $("i-deg").focus(); return; } set1("face", v, v ? "facing " + v : "keeps the last facing"); });
    $("i-deg").addEventListener("change", (e) => {
      const raw = e.target.value.trim();
      if (raw === "") { guarded("face", "", (val) => set1("face", val, "keeps the last facing")); return; }
      const n = Number(raw); if (!isFinite(n)) return;
      const v = ((n % 360) + 360) % 360;
      guarded("face", v, (val) => set1("face", val, "facing " + val + "°"));
    });
    $("i-what").addEventListener("change", (e) => { const v = e.target.value.trim(); guarded("what", v, (val) => set1("what", val, "what they do")); });
    $("i-watch").addEventListener("change", (e) => { const v = e.target.value.trim(); guarded("watch", v, (val) => set1("watch", val, "watch for")); });
    $("i-beat").addEventListener("change", (e) => set1("beat", e.target.value, "beat " + (e.target.value || "by time")));
    $("i-status").addEventListener("change", (e) => set1("status", e.target.value, "status " + e.target.value));
    $("i-add").addEventListener("click", () => addKeyframeAt(p.code, Math.round(state.T * 2) / 2));
    $("i-dup").addEventListener("click", () => {
      const c2 = now(); if (!c2) return gone();
      const id = newId(), t = c2.k.t + 5, row2 = (PLAN.sections.moves || {})[k.id];
      if (keyAt(c2.p, t)) { toast("There's already a keyframe 5 s later."); return; }
      commit([{ s: "moves", id, f: null, v: Object.assign({}, cleanRow(row2), { o: nextO("moves"), t, what: "", watch: "", status: "Proposed" }) }], `${c2.p.name}: copied the ${mmssH(c2.k.t)} keyframe to ${mmssH(t)}`).then((r) => { if (r) { state.kf = id; setT(t); } });
    });
    $("i-del").addEventListener("click", () => {
      $("i-delbox").innerHTML = `<span class="confirm">Delete this keyframe? <button class="btn danger" id="i-del-y">Delete</button><button class="btn" id="i-del-n">Keep</button></span>`;
      $("i-del-y").addEventListener("click", () => { const c2 = now(); if (!c2) return gone(); state.kf = null; commit([{ s: "moves", id: k.id, f: null, v: undefined }], `${c2.p.name}: deleted the keyframe at ${mmssH(c2.k.t)}`); });
      $("i-del-n").addEventListener("click", () => renderInspector(true));
    });
  }
  const cleanRow = (r) => { const o = {}; for (const [k2, v] of Object.entries(r || {})) if (!k2.startsWith("_")) o[k2] = v; return o; };

  // ---------------------------------------------------------------- plan tables
  const ST = ["", "Proposed", "Stated", "Confirmed", "Open", "Dropped"];
  // options for the tables; from the board when there is one, otherwise from the plan's own rows
  const planRows = (sec) => Object.values(PLAN.sections[sec] || {}).filter((r) => r && typeof r === "object").sort((a, b) => (Number(a.o) || 0) - (Number(b.o) || 0));
  const peopleCodes = () => (DATA ? DATA.people.map((p) => p.code) : planRows("people").map((r) => String(r.code || "")).filter(Boolean));
  const beatCodes = () => (DATA ? DATA.beats.map((b) => b.code) : planRows("beats").map((r) => String(r.code || "")).filter(Boolean));
  const runColsNow = () => (DATA ? DATA.runCols : planRows("people").filter((r) => r.runcol).map((r) => [String(r.code), String(r.runcol)]));
  const textNow = (k2, d) => (DATA ? DATA.ui.texts[k2] : (((PLAN.sections.texts || {})[k2] || {}).text || d));
  const YES = ["", "Yes"], YESNO = ["Yes", "No"];
  const C = (key, label, type, extra) => Object.assign({ key, label, type: type || "text" }, extra || {});
  const SECTIONS = {
    moves: { title: "Moves", help: "Where each person is at a take time. Between two rows they wait, then walk at their pace so they arrive on time. 'Where' is a mark code or 'x, y'. 'Facing' is a person, a mark, a thing on a counter, or degrees.",
      cols: () => [C("who", "Person", "select", { opts: peopleCodes, cls: "narrow" }), C("t", "Take time", "time"), C("at", "Where", "text", { cls: "narrow" }), C("face", "Facing", "text", { cls: "narrow" }),
        C("what", "What they do", "long"), C("watch", "Watch for", "long"), C("beat", "Beat", "select", { opts: () => [""].concat(beatCodes()), cls: "narrow" }), C("status", "Status", "select", { opts: () => ST, cls: "narrow" })],
      sort: (a, b) => (personOrder(a.who) - personOrder(b.who)) || ((PD.parseTime(a.t) || 0) - (PD.parseTime(b.t) || 0)), newRow: () => ({ who: (state.filter && byCode[state.filter.toUpperCase()]) ? state.filter.toUpperCase() : peopleCodes()[0] || "", t: Math.round(state.T * 2) / 2, at: "", face: "", what: "", watch: "", beat: "", status: "Proposed" }) },
    marks: { title: "Marks", help: "Numbered spots (tape), things on the counters, and places off the plan. Plan x and y are meters (see Settings). Moving a mark moves every keyframe that names it. Renaming a code doesn't rename it in Moves, Swaps or Resets: Checks lists anything that stops reading.",
      cols: () => [C("code", "Code", "text", { cls: "code" }), C("name", "Name", "long"), C("kind", "Kind", "select", { opts: () => markKinds(), cls: "narrow" }), C("status", "Status", "select", { opts: () => ST, cls: "narrow" }),
        C("x", "Plan x", "num"), C("y", "Plan y", "num"), C("find", "Find it on the day", "long"), C("note", "Source or note", "long")] },
    beats: { title: "Beats", help: "The take's beats. Times are take time (m:ss) from 'action'. 'Inside' marks a beat that sits inside another one. 'Board note' replaces the in-frame pill during that beat.",
      cols: () => [C("code", "Beat", "text", { cls: "code" }), C("card", "Name on cards", "text"), C("t0", "Starts", "time"), C("t1", "Ends", "time"), C("inside", "Inside", "select", { opts: () => YES, cls: "narrow" }), C("pill", "Board note", "text"),
        C("shot", "Shot no.", "text", { cls: "code" }), C("what", "What happens (shot list)", "long"), C("stations", "Stations", "text"), C("camera", "Camera (shot list)", "long"), C("wording", "Wording status", "select", { opts: () => ST, cls: "narrow" }),
        C("timing", "Timing status", "select", { opts: () => ST, cls: "narrow" }), C("swapcut", "Swap or cut", "text"), C("note", "Source or note", "long")] },
    people: { title: "People", help: "Who's in the take. 'Gets a card' puts them on the board. Pace is m/s; 'walks without stopping until' is the take time until which they walk straight through their keyframes (the hook).",
      cols: () => [C("code", "Code", "text", { cls: "code" }), C("who", "Who", "text"), C("role", "Role in the take", "long"), C("during", "During takes", "long"), C("card", "Gets a card", "select", { opts: () => YESNO, cls: "narrow" }),
        C("initials", "Initials", "text", { cls: "code" }), C("color", "Color", "select", { opts: () => ["talent", "camera", "crew", "boom", "crew2"], cls: "narrow" }), C("tape", "Tape", "select", { opts: () => ["", "orange", "blue", "purple"], cls: "narrow" }),
        C("speed", "Pace (m/s)", "num"), C("cont", "Walks without stopping until", "time"), C("checked", "In-frame check", "select", { opts: () => YES, cls: "narrow" }), C("withcam", "With the camera", "select", { opts: () => YES, cls: "narrow" }),
        C("runcol", "Run sheet column", "text"), C("marks", "Their marks", "text"), C("goesby", "Name on reset steps", "text"), C("named", "Gets presets they set", "select", { opts: () => YESNO, cls: "narrow" }),
        C("slack", "In the channel", "text"), C("status", "Status", "select", { opts: () => ST, cls: "narrow" }), C("note", "Source or note", "long")] },
    runsheet: { title: "Run sheet", help: "One line per beat for each person with a run sheet column (People). A blank cell means stay where you are. Mark codes before a ':' are checked against the moves.",
      cols: () => [C("beat", "Beat", "select", { opts: beatCodes, cls: "narrow" }), C("what", "What", "text")].concat(runColsNow().map(([code, name]) => C("cells." + code, name, "long"))).concat([C("note", "Note (spans the row)", "long"), C("status", "Status", "select", { opts: () => ST, cls: "narrow" })]) },
    cards: { title: "Cards", help: "Card lines for people who aren't on the map (no keyframes). Everyone with keyframes gets a card built from them.",
      cols: () => [C("who", "Person", "select", { opts: peopleCodes, cls: "narrow" }), C("when", "When", "text"), C("at", "Where", "text"), C("what", "What to do", "long"), C("watch", "Watch for", "long"), C("status", "Status", "select", { opts: () => ST, cls: "narrow" })] },
    swaps: { title: "Swaps", help: "Each swap: who does it from where, the way in (marks or 'x, y' separated by ';'), where they stand, how long it takes, and when it would help. Windows are worked out from the moves.",
      cols: () => [C("code", "Code", "text", { cls: "code" }), C("name", "Swap", "text"), C("cond", "If", "text"), C("what", "What", "long"), C("who", "Who", "text"), C("frm", "From (hold)", "text", { cls: "code" }), C("way", "Way in", "text"),
        C("ax", "Stands x", "num"), C("ay", "Stands y", "num"), C("handling", "Swap takes (s)", "num"), C("uf", "Useful from", "time"), C("ut", "Useful to", "time"), C("route", "Route (words)", "long"), C("target", "Target", "text", { cls: "narrow" }),
        C("status", "Status", "select", { opts: () => ST, cls: "narrow" }), C("source", "Source", "long")] },
    resets: { title: "Resets", help: "Steps between takes. 'Kind' picks the reset. 'Who' names people (or a role like 'camera op') so the step goes on their card. 'Route on the map': marks or 'x, y' separated by ';'.",
      cols: () => [C("kind", "Kind", "select", { opts: () => [textNow("resetPartialName", "Partial reset"), textNow("resetFullName", "Full reset")] }), C("step", "Step", "text", { cls: "code" }), C("who", "Who", "text"), C("frm", "From", "text"), C("to", "To", "text"), C("what", "What", "long"),
        C("when", "When (min after cut)", "text", { cls: "code" }), C("status", "Status", "select", { opts: () => ST, cls: "narrow" }), C("note", "Source or note", "long"), C("route", "Route on the map", "text"), C("label", "Route label", "text"),
        C("style", "Route color", "select", { opts: () => ["", "talent", "camera", "crew", "crew2"], cls: "narrow" })] },
    preset: { title: "Preset", help: "What's set before action. 'Who' sets it; 'On whose card' lists person codes (or Everyone). Area 'Safety' goes on cards under Safety and quiet.",
      cols: () => [C("area", "Area", "text"), C("item", "Item", "long"), C("how", "Where or how", "long"), C("who", "Who", "text"), C("forc", "On whose card", "text"), C("status", "Status", "select", { opts: () => ST, cls: "narrow" }), C("note", "Source or note", "long")] },
    signals: { title: "Signals", help: "How the set talks during a take.",
      cols: () => [C("signal", "Signal", "text"), C("means", "Means", "long"), C("by", "Given by", "text"), C("to", "To", "text"), C("how", "How", "long"), C("when", "When", "text"), C("status", "Status", "select", { opts: () => ST, cls: "narrow" }), C("note", "Source or note", "long")] },
    measure: { title: "Measure", help: "What to measure at the house, and why. Fill in the value, who measured it and when; then update the room (Room tables) to match.",
      cols: () => [C("measure", "Measure", "long"), C("why", "Why", "long"), C("value", "Value", "text"), C("by", "Who measured", "text"), C("date", "Date", "text")] },
    openitems: { title: "Open items", help: "Questions, each with who can answer it. Confirmed and Dropped ones leave the board.",
      cols: () => [C("question", "Question", "long"), C("who", "For", "text"), C("why", "Why it matters", "long"), C("ondoc", "On the Questions doc?", "text", { cls: "narrow" }), C("status", "Status", "select", { opts: () => ST, cls: "narrow" })] },
    fixtures: { group: "Room", title: "Counters and furniture", help: "Rectangles in plan meters: x, y is the corner nearest the origin; w and h the size. 'Solid' ones count for walking clearance.",
      cols: () => [C("label", "Name", "text"), C("x", "x", "num"), C("y", "y", "num"), C("w", "w", "num"), C("h", "h", "num"), C("kind", "Kind", "select", { opts: () => ["counter", "tall", "island", "appliance", "cooktop", "sink", "furniture", "rug", "item"], cls: "narrow" }), C("solid", "Solid", "select", { opts: () => YES, cls: "narrow" }), C("conf", "Sure?", "select", { opts: () => ["low", "medium", "high"], cls: "narrow" }), C("note", "Note", "long")] },
    walls: { group: "Room", title: "Walls", help: "Wall segments in plan meters. 'Blocks the view' hides what's behind it from the camera; 'Blocks walking' is checked on routes (glass blocks walking but not the view).",
      cols: () => [C("x1", "x1", "num"), C("y1", "y1", "num"), C("x2", "x2", "num"), C("y2", "y2", "num"), C("view", "Blocks the view", "select", { opts: () => YES, cls: "narrow" }), C("walk", "Blocks walking", "select", { opts: () => YES, cls: "narrow" }), C("note", "Note", "long")] },
    features: { group: "Room", title: "Doors, windows, glass", help: "Drawn over the walls: openings, windows, glass and doors.",
      cols: () => [C("label", "Name", "text"), C("x1", "x1", "num"), C("y1", "y1", "num"), C("x2", "x2", "num"), C("y2", "y2", "num"), C("kind", "Kind", "select", { opts: () => ["opening", "window", "glass", "door"], cls: "narrow" }), C("conf", "Sure?", "select", { opts: () => ["low", "medium", "high"], cls: "narrow" }), C("note", "Note", "long")] },
    areas: { group: "Room", title: "Areas", help: "Rooms and outside areas as polygons: 'x, y; x, y; ...' in plan meters.",
      cols: () => [C("label", "Name", "text"), C("pts", "Outline", "long"), C("kind", "Kind", "select", { opts: () => ["room", "outside"], cls: "narrow" }), C("style", "Drawn as", "select", { opts: () => ["room", "outside", "lawn", "lower", "hall"], cls: "narrow" }), C("level", "Level", "text", { cls: "narrow" }), C("conf", "Sure?", "select", { opts: () => ["low", "medium", "high"], cls: "narrow" }), C("note", "Note", "long")] },
    seats: { group: "Room", title: "Stools, chairs, patio tables", help: "Patio tables marked 'moved' are cleared for the take and drawn dashed; the others count for clearance.",
      cols: () => [C("kind", "Kind", "select", { opts: () => ["stool", "chair", "patio table"], cls: "narrow" }), C("x", "x", "num"), C("y", "y", "num"), C("moved", "Moved", "select", { opts: () => YES, cls: "narrow" }), C("r", "Radius", "num")] },
    points: { group: "Room", title: "Outlets, noise, trip hazards", help: "Points on the plan.",
      cols: () => [C("label", "Name", "text"), C("x", "x", "num"), C("y", "y", "num"), C("kind", "Kind", "select", { opts: () => ["power", "noise", "trip"], cls: "narrow" }), C("conf", "Sure?", "select", { opts: () => ["low", "medium", "high"], cls: "narrow" }), C("note", "Note", "long")] },
    labels: { group: "Room", title: "Map labels", help: "Words on the map. 'Only on the whole route' hides a label in the kitchen view.",
      cols: () => [C("text", "Label", "text"), C("x", "x", "num"), C("y", "y", "num"), C("size", "Size", "num"), C("style", "Style", "select", { opts: () => ["", "strong", "hold"], cls: "narrow" }), C("anchor", "Anchor", "select", { opts: () => ["middle", "start", "end"], cls: "narrow" }), C("view", "Only on the whole route", "select", { opts: () => ["", "Whole route"], cls: "narrow" })] },
    settings: { group: "Setup", title: "Settings", help: "Names, the timer, lenses, views and the model's numbers. Each setting is found by its name, so a new one only does something if the plan reads that name.", fixed: true,
      cols: () => [C("id", "Setting", "ro"), C("value", "Value", "long", { cls: "wide-col" }), C("note", "What it does", "ro")] },
    texts: { group: "Setup", title: "Wording", help: "Wording on the board and in prints. {tokens} are filled in from the plan. Rows whose name starts with inf are the notes on the About tab: Add a row to write a new one.", fixed: true,
      cols: () => [C("id", "Where it shows", "ro"), C("text", "Text", "long", { cls: "wide-col" })] },
  };
  const personOrder = (c) => { const i = (DATA ? DATA.people : []).findIndex((p) => p.code === c); return i < 0 ? 999 : i; };
  const markKinds = () => { const t = talent() ? talent().name.split(" ")[0] : "Talent"; return [`${t}'s route`, `${t}'s station`, "Landmark", "Camera mark", "Crew hold", "On a counter", "Off the plan"]; };
  function secChips() {
    const box = $("secchips"); box.innerHTML = "";
    let lastGroup = null;
    for (const [k, s] of Object.entries(SECTIONS)) {
      if (s.group && s.group !== lastGroup) { const sp = document.createElement("span"); sp.className = "small"; sp.textContent = s.group + ":"; sp.style.alignSelf = "center"; box.appendChild(sp); lastGroup = s.group; }
      const b = document.createElement("button"); b.type = "button"; b.textContent = s.title; b.dataset.sec = k;
      b.setAttribute("aria-pressed", String(state.sec === k));
      b.addEventListener("click", () => { state.sec = k; state.filter = ""; $("plan-filter").value = ""; renderPlan(true); });
      box.appendChild(b);
    }
  }
  const getF = (row, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), row);
  function cellHTML(c, row) {
    const v = getF(row, c.key);
    const dis = state.edit ? "" : "disabled";
    const dk = `data-f="${esc(c.key)}"`;
    if (c.type === "ro") return `<td class="ro">${esc(c.key === "id" ? row.id : v)}</td>`;
    if (!state.edit) {
      const shown = c.type === "time" ? (typeof v === "number" ? mmssH(v) : (v == null ? "" : v)) : (v == null ? "" : v);
      return `<td class="view ${c.type === "long" ? (c.cls || "wide-col") : ""}">${esc(shown)}</td>`;
    }
    if (c.type === "select") {
      const opts = c.opts();
      const cur = v === undefined || v === null ? "" : String(v);
      const list = opts.includes(cur) ? opts : [cur].concat(opts);
      return `<td class="${c.cls || ""}"><select ${dk} ${dis}>${list.map((o) => `<option${o === cur ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></td>`;
    }
    if (c.type === "long") return `<td class="${c.cls || "wide-col"}"><textarea ${dk} ${dis} rows="1">${esc(v)}</textarea></td>`;
    const shown = c.type === "time" ? (typeof v === "number" ? mmssH(v) : (v == null ? "" : v)) : (v == null ? "" : v);
    return `<td class="${c.type === "num" ? "num" : c.type === "time" ? "time" : c.cls || ""}"><input ${dk} value="${esc(shown)}" ${dis}${c.type === "num" ? ' inputmode="decimal"' : c.type === "time" ? ' placeholder="m:ss" autocomplete="off"' : ""}></td>`;
  }
  function sectionRows(sec) {
    const s = SECTIONS[sec];
    const rows = Object.entries(PLAN.sections[sec] || {}).map(([id, r]) => Object.assign({ id }, r));
    rows.sort((a, b) => (s.sort ? s.sort(a, b) : 0) || ((Number(a.o) || 0) - (Number(b.o) || 0)));
    const raw = state.filter.trim(), f = raw.toLowerCase();
    if (/^who:/i.test(raw)) { const code = raw.slice(4).trim(); return rows.filter((r) => r.who === code); }
    return f ? rows.filter((r) => JSON.stringify(cleanRow(r)).toLowerCase().includes(f) || r.id === f) : rows;
  }
  function renderPlan(force) {
    const sec = state.sec, s = SECTIONS[sec];
    const tbl = $("ptable");
    if (!force && tbl.contains(document.activeElement)) { patchPlan(); return; }
    for (const b of $("secchips").children) if (b.dataset.sec) b.setAttribute("aria-pressed", String(b.dataset.sec === sec));
    $("sec-help").textContent = s.help;
    const cols = s.cols();
    const rows = sectionRows(sec);
    const warnedIds = new Set(WARN.filter((w) => w.id).map((w) => w.id));
    const secWarn = WARN.filter((w) => (PLAN.sections[sec] || {})[w.id]);
    $("sec-warn").innerHTML = secWarn.length ? `<div class="pill warn" style="margin:6px 0">${secWarn.length} row${secWarn.length > 1 ? "s" : ""} here can't be read: see Checks</div>` : "";
    tbl.dataset.sec = sec;
    const acts = !state.edit ? "" : s.fixed ? `<button type="button" data-act="del" title="Delete this row">✕</button>`
      : `${s.sort ? "" : `<button type="button" data-act="up" title="Move up">↑</button><button type="button" data-act="down" title="Move down">↓</button>`}<button type="button" data-act="ins" title="Add a row below">+</button><button type="button" data-act="del" title="Delete this row">✕</button>`;
    tbl.innerHTML = `<thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}<th></th></tr></thead><tbody>` + rows.map((r) =>
      `<tr data-id="${esc(r.id)}" class="${warnedIds.has(r.id) ? "warned" : ""}" title="${r._by ? esc("Last changed by " + r._by + ", " + ago(tsMs(r._at))) : ""}">${cols.map((c) => cellHTML(c, r)).join("")}<td class="acts">${acts}</td></tr>`).join("") + "</tbody>";
    for (const ta of tbl.querySelectorAll("textarea")) fitArea(ta);
    $("sec-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}${state.filter ? " (filtered)" : ""}`;
    $("add-row").hidden = !state.edit;
  }
  function fitArea(ta) { ta.style.height = "auto"; ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 30), 170) + "px"; }
  $("ptable").addEventListener("input", (e) => { if (e.target.tagName === "TEXTAREA") fitArea(e.target); });
  function patchPlan() {
    const sec = $("ptable").dataset.sec; const rows = PLAN.sections[sec] || {};
    for (const inp of $("ptable").querySelectorAll("[data-f]")) {
      if (inp === document.activeElement) continue;
      const id = inp.closest("tr").dataset.id; const r = rows[id]; if (!r) continue;
      const c = SECTIONS[sec].cols().find((x) => x.key === inp.dataset.f); if (!c) continue;
      const v = getF(r, c.key);
      const shown = c.type === "time" ? (typeof v === "number" ? mmssH(v) : (v == null ? "" : String(v))) : (v == null ? "" : String(v));
      if (inp.value !== shown) inp.value = shown;
    }
  }
  function parseCell(c, raw) {
    const s = raw.trim();
    if (c.type === "time") { const t = parseTimeInput(s).t; return t === null ? s : t; }
    if (c.type === "num") { if (s === "") return ""; const n = Number(s); return isFinite(n) && /^-?\d*\.?\d+(e-?\d+)?$/i.test(s) ? n : s; }
    return s;
  }
  $("ptable").addEventListener("focusin", (e) => {
    const inp = e.target.closest("[data-f]"); if (!inp) return;
    const sec = $("ptable").dataset.sec, id = inp.closest("tr").dataset.id;
    inp.dataset.seen = stable(getF((PLAN.sections[sec] || {})[id] || {}, inp.dataset.f));
  });
  $("ptable").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-f]"); if (!inp) return;
    const sec = $("ptable").dataset.sec, id = inp.closest("tr").dataset.id;
    const c = SECTIONS[sec].cols().find((x) => x.key === inp.dataset.f);
    let v = parseCell(c, inp.value);
    if (sec === "settings" && c.key === "value" && /^-?\d+(\.\d+)?$/.test(String(v).trim())) v = Number(v);
    const row = (PLAN.sections[sec] || {})[id];
    const what = rowName(sec, row);
    const isTime = c.type === "time" && typeof v === "number";
    const how = parseTimeInput(inp.value).how;
    const save = (val) => { inp.dataset.seen = stable(val); commit([{ s: sec, id, f: c.key.split("."), v: val }], `${SECTIONS[sec].title}: ${c.label}${what ? " (" + what + ")" : ""}${isTime ? " now " + mmssH(val) + (how === "seconds" ? ", read as seconds" : "") : ""}`, { quiet: !isTime }); };
    const cur = getF(row || {}, c.key);
    if (row && inp.dataset.seen !== undefined && stable(cur) !== inp.dataset.seen && !sameVal(cur, v)) {
      askOverwrite(row._by && row._by !== me ? row._by : "Someone", JSON.parse(inp.dataset.seen), cur, v, c.type === "long" && typeof v === "string", save, () => { inp.dataset.seen = stable(cur); renderPlan(true); });
      return;
    }
    save(v);
  });
  $("ptable").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const sec = $("ptable").dataset.sec, tr = b.closest("tr"), id = tr.dataset.id;
    const rows = sectionRows(sec), i = rows.findIndex((r) => r.id === id);
    const what = rowName(sec, rows[i]);
    if (b.dataset.act === "del") {
      const cell = b.parentElement;
      cell.innerHTML = `<span class="confirm">Delete? <button type="button" data-act="del-y">Yes</button><button type="button" data-act="del-n">No</button></span>`;
      return;
    }
    if (b.dataset.act === "del-n") { renderPlan(true); return; }
    if (b.dataset.act === "del-y") { commit([{ s: sec, id, f: null, v: undefined }], `${SECTIONS[sec].title}: deleted a row${what ? " (" + what + ")" : ""}`); return; }
    if (b.dataset.act === "ins") {
      const nid = newId(), base = SECTIONS[sec].newRow ? SECTIONS[sec].newRow() : {};
      if (sec === "moves") { base.who = rows[i].who; base.t = (PD.parseTime(rows[i].t) || 0) + 5; }
      commit([{ s: sec, id: nid, f: null, v: Object.assign(base, { o: orderBetween(sec, id) }) }], `${SECTIONS[sec].title}: added a row`).then(() => flashRow(nid));
      return;
    }
    const j = b.dataset.act === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return;
    const a = rows[i], c2 = rows[j];
    const oa = Number(a.o) || 0, oc = Number(c2.o) || 0;
    commit([{ s: sec, id: a.id, f: ["o"], v: oc === oa ? oa + (j > i ? 0.5 : -0.5) : oc }, { s: sec, id: c2.id, f: ["o"], v: oa }], `${SECTIONS[sec].title}: reordered`, { quiet: true });
  });
  function addNamedRow(sec) {
    const texts = sec === "texts";
    openModal(texts ? "Add wording" : "Add a setting", `<p class="small">${texts ? "The plan finds wording by its name. A name that starts with inf adds a note to the About tab." : "The plan finds a setting by its name, so a new one only does something if the plan reads that name."} Letters, numbers and _ only, starting with a letter.</p>
      <div class="form" style="grid-template-columns:minmax(0,1fr)"><input id="nk-in" maxlength="40" autocomplete="off" spellcheck="false" placeholder="${texts ? "infNewNote" : "settingName"}"></div>
      <p class="small" id="nk-msg" role="alert"></p>
      <div class="btnrow"><button class="btn primary" id="nk-ok">Add</button><button class="btn" id="nk-cancel">Cancel</button></div>`);
    const go = () => {
      const key = $("nk-in").value.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) { $("nk-msg").textContent = "Use letters, numbers and _ only, starting with a letter."; return; }
      if ((PLAN.sections[sec] || {})[key]) { $("nk-msg").textContent = `There's already one called ${key}.`; return; }
      closeModal();
      commit([{ s: sec, id: key, f: null, v: texts ? { o: nextO(sec), text: "" } : { o: nextO(sec), value: "", note: "" } }], `${SECTIONS[sec].title}: added ${key}`)
        .then((r) => { if (r) { state.filter = ""; $("plan-filter").value = ""; setTimeout(() => flashRow(key), 400); } });
    };
    $("nk-ok").addEventListener("click", go);
    $("nk-in").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    $("nk-cancel").addEventListener("click", closeModal);
    setTimeout(() => $("nk-in").focus(), 30);
  }
  $("add-row").addEventListener("click", () => {
    if (SECTIONS[state.sec].fixed) { addNamedRow(state.sec); return; }
    const sec = state.sec, nid = newId(), base = SECTIONS[sec].newRow ? SECTIONS[sec].newRow() : {};
    commit([{ s: sec, id: nid, f: null, v: Object.assign(base, { o: nextO(sec) }) }], `${SECTIONS[sec].title}: added a row`).then(() => { state.filter = ""; $("plan-filter").value = ""; setTimeout(() => flashRow(nid), 400); });
  });
  $("plan-filter").addEventListener("input", (e) => { state.filter = e.target.value; renderPlan(true); });
  function rowName(sec, r) {
    if (!r) return "";
    if (sec === "moves") return `${nameOf(r.who)} ${typeof r.t === "number" ? mmssH(r.t) : r.t}`;
    return String(r.code || r.name || r.label || r.text && r.text.slice(0, 30) || r.question && r.question.slice(0, 40) || r.item && r.item.slice(0, 40) || r.signal || r.measure && r.measure.slice(0, 40) || r.beat || r.step || "").trim();
  }
  function flashRow(id) {
    const tr = $("ptable").querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (!tr) return;
    tr.scrollIntoView({ block: "center", behavior: "smooth" });
    tr.classList.add("flash"); setTimeout(() => tr.classList.remove("flash"), 1600);
    const f = tr.querySelector("input:not([disabled]), textarea:not([disabled])"); if (f) f.focus({ preventScroll: true });
  }
  function gotoSection(sec, filter, rowId) {
    state.sec = sec; state.filter = filter || ""; $("plan-filter").value = state.filter;
    setTab("plan"); renderPlan(true);
    if (rowId) setTimeout(() => flashRow(rowId), 50);
  }

  // ---------------------------------------------------------------- checks
  const secOfRow = (id) => Object.keys(PLAN.sections).find((s) => (PLAN.sections[s] || {})[id]);
  function renderChecks() {
    if (!DATA) return;
    $("warnlist").innerHTML = WARN.length ? WARN.map((w, i) => {
      const sec = w.kind === "leftover" ? w.sec : w.id && secOfRow(w.id);
      const btn = w.kind === "leftover" ? (state.edit ? `<button type="button" data-wdel="${i}">Delete it</button>` : `<span class="small">(turn on Edit to delete it)</span>`)
        : sec && SECTIONS[sec] ? `<button type="button" data-w="${i}">Show the row</button>` : "";
      return `<div class="warn-item"><span>${esc(w.text)}</span>${btn}</div>`;
    }).join("") : `<p class="okline">Every row reads cleanly.</p>`;
    for (const b of $("warnlist").querySelectorAll("button[data-w]")) b.addEventListener("click", () => { const w = WARN[Number(b.dataset.w)]; gotoSection(secOfRow(w.id), "", w.id); });
    for (const b of $("warnlist").querySelectorAll("button[data-wdel]")) b.addEventListener("click", () => {
      const w = WARN[Number(b.dataset.wdel)];
      if (!(PLAN.sections[w.sec] || {})[w.id]) return;
      b.disabled = true;
      commit([{ s: w.sec, id: w.id, f: null, v: undefined }], `${SECTIONS[w.sec] ? SECTIONS[w.sec].title : w.sec}: deleted a leftover piece of a deleted row`);
    });
    const c = CHECKS, n = (code) => nameOf(code);
    const runsTxt = (iv) => iv.map(([a, b]) => `${mmss(a)}-${mmss(b)}`).join(", ");
    const groups = [];
    for (const lens of Object.keys(DATA.lenses)) {
      const items = [];
      for (const [p, iv] of Object.entries(c.sweep[lens] || {})) if (iv.length) items.push(`In frame: ${esc(n(p))} ${runsTxt(iv)}`);
      for (const [p, iv] of Object.entries(c.edge[lens] || {})) if (iv.length) items.push(`Near the edge: ${esc(n(p))} ${runsTxt(iv)}`);
      const co = c.talentOut[lens] || [];
      items.push(co.length ? `${esc(talent() ? talent().name : "Talent")} out of frame: ${runsTxt(co)}` : `${esc(talent() ? talent().name : "Talent")} in frame all take`);
      for (const sw of DATA.swaps) items.push(`${esc(sw.name)} window: ${(sw.windows[lens] || []).length ? runsTxt(sw.windows[lens]) : "none"}`);
      groups.push([`At ${lens}`, items]);
    }
    groups.push([`Closer than the crowding gap`, c.crowding.length ? c.crowding.map(([a, b, iv]) => `${esc(n(a))} and ${esc(n(b))}: ${runsTxt(iv)}`) : ["Nobody"]]);
    groups.push(["Fastest walking pace", Object.entries(c.speeds).map(([p, [v, t]]) => `${esc(n(p))}: ${v} m/s${t !== null ? " at " + mmss(t) : ""}${v > 1.4 ? " (that's a hurry)" : ""}`)]);
    const sol = Object.entries(c.solid);
    groups.push(["Standing inside a counter or furniture", sol.length ? sol.map(([p, [a, b, k]]) => `${esc(n(p))}: ${mmss(a)} to ${mmss(b)} (${k} moments)`) : ["Nobody"]]);
    const rt = Object.entries(c.routes);
    groups.push(["Swap and reset routes", rt.length ? rt.map(([k, [d, w, wall]]) => `${esc(k)}: ${d} m from ${esc(w)}${wall ? ", through a wall" : ""}`) : ["All clear"]]);
    const cl = Object.entries(c.clearance);
    groups.push(["Walls and clearance during the take", cl.length ? cl.flatMap(([p, v]) => v.walls.map(([T, x, y]) => `${esc(n(p))} crosses a wall or glass at ${mmss(T)} (${x}, ${y})`).concat(v.close.map(([a, b, w, d]) => `${esc(n(p))} within ${d} m of ${esc(w)}, ${mmss(a)} to ${mmss(b)}`))) : ["All clear"]]);
    $("modelchecks").innerHTML = groups.map(([h, items]) => `<div class="check-group"><h3>${esc(h)}</h3><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul></div>`).join("");
    $("tokentable").innerHTML = `<tr><th>Token</th><th>Now</th></tr>` + Object.entries(DATA.numbers).map(([k, v]) => `<tr><td class="t">{${esc(k)}}</td><td>${esc(v)}</td></tr>`).join("");
  }

  // ---------------------------------------------------------------- history and copies
  let unHist = null, unSnap = null, HIST = [], SNAPS = [];
  function watchHistory(on) {
    if (on && !unHist) {
      unHist = store.watchHistory(80, (list, err) => { if (err) { $("histlist").textContent = "Couldn't load the history: " + (err.code || err.message); return; } HIST = list; renderHistory(); });
      unSnap = store.watchSnapshots((list, err) => { if (err) { $("snaplist").textContent = "Couldn't load the copies: " + (err.code || err.message); return; } SNAPS = list; renderSnaps(); });
    } else if (!on && unHist) { unHist(); unSnap(); unHist = unSnap = null; }
  }
  function renderHistory() {
    $("histlist").innerHTML = HIST.length ? `<div class="hist">` + HIST.map((h, i) => `<div class="hist-row"><div><span class="what">${esc(h.label)}</span><br><span class="when">${esc(h.who)} · ${esc(ago(h.at))}</span></div><div>${h.ops && h.ops.length && state.edit ? `<span data-box="${i}"><button class="btn small-btn" data-undo="${i}">Undo</button></span>` : ""}</div></div>`).join("") + "</div>"
      : `<p class="small">No changes yet.</p>`;
  }
  $("histlist").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.undo !== undefined) {
      const h = HIST[Number(b.dataset.undo)];
      const ops = undoOps(h);
      const changed = ops.filter((o) => !sameVal(currentVal(o.s, o.id, o.f), o.expect));
      if (changed.length) {
        b.parentElement.innerHTML = `<span class="confirm">Changed again since. Undo anyway? <button class="btn small-btn" data-force="${b.dataset.undo}">Undo</button></span>`;
        return;
      }
      doUndo(h);
    }
    if (b.dataset.force !== undefined) doUndo(HIST[Number(b.dataset.force)]);
  });
  const stripMeta = (v) => (v && typeof v === "object" && !Array.isArray(v) ? cleanRow(v) : v === undefined ? null : v);
  const getRow = (s, id) => (PLAN.sections[s] || {})[id];
  function doUndo(h) { const ops = undoOps(h).map((o) => ({ s: o.s, id: o.id, f: o.f, v: o.v })); commit(ops, "Undo: " + h.label, { always: true }); }
  function renderSnaps() {
    $("snaplist").innerHTML = SNAPS.length ? `<div class="hist">` + SNAPS.map((s, i) => `<div class="hist-row"><div><span class="what">${esc(s.label)}</span><br><span class="when">${esc(new Date(s.at).toLocaleString())} · ${esc(s.who)}</span></div><div>${state.edit ? `<span data-sbox="${i}"><button class="btn small-btn" data-restore="${i}">Restore</button></span>` : ""}</div></div>`).join("") + "</div>"
      : `<p class="small">No copies yet: the first one is made before the first change of the hour.</p>`;
  }
  $("snaplist").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const offline = "You're offline. Restore a copy once you're connected, so nothing newer gets overwritten.";
    if (b.dataset.restore !== undefined) {
      if (!store.online()) { toast(offline); return; }
      b.parentElement.innerHTML = `<span class="confirm">Put the whole plan back to this copy? <button class="btn small-btn danger" data-really="${b.dataset.restore}">Restore</button></span>`; return;
    }
    if (b.dataset.really !== undefined) {
      const s = SNAPS[Number(b.dataset.really)];
      if (!store.online()) { toast(offline); renderSnaps(); return; }
      if (!me) { askName(); return; }
      b.disabled = true;
      store.replaceAll(s.sections || {}, `Restored the copy from ${new Date(s.at).toLocaleString()}`, me).then(() => toast("Restored. The plan as it was just before is saved as a copy too."),
        (err) => { renderSnaps(); toast(err.code === "offline" ? offline : "Couldn't restore: " + (err.code || err.message)); });
    }
  });
  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ schema: 1, exported: new Date().toISOString(), sections: Object.fromEntries(Object.entries(PLAN.sections).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([id, r]) => [id, cleanRow(r)]))])) }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `${(DATA && DATA.ui.title || "plan").replace(/[^A-Za-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $("import-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    let j;
    try { j = JSON.parse(await f.text()); } catch (err) { $("import-msg").textContent = "That file isn't a plan copy (it isn't JSON)."; return; }
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (!j || !isObj(j.sections) || !["moves", "marks", "people", "beats"].some((k2) => isObj(j.sections[k2]))) { $("import-msg").textContent = "That file isn't a plan copy (it has no Moves, Marks, People or Beats)."; return; }
    const badRow = Object.entries(j.sections).find(([, rows]) => !isObj(rows) || Object.values(rows).some((r) => !isObj(r)));
    if (badRow) { $("import-msg").textContent = `That file isn't a plan copy: the ${badRow[0]} table isn't a set of rows.`; return; }
    if (!state.edit) { $("import-msg").textContent = "Turn on Edit to load a copy."; return; }
    const offline = "You're offline. Load a copy once you're connected, so nothing newer gets overwritten.";
    if (!serverLoaded || !store.online()) { $("import-msg").textContent = offline; return; }
    const problem = checkStorable(j.sections);
    if (problem) { $("import-msg").textContent = "That file can't be stored: " + problem + "."; return; }
    let test; try { test = PD.derive({ sections: j.sections }); } catch (err) { $("import-msg").textContent = "That plan can't be read: " + err.message; return; }
    const n = Object.values(j.sections).reduce((s, v) => s + Object.keys(v || {}).length, 0);
    $("import-msg").innerHTML = `<span class="confirm">Replace the whole plan with this file (${n} rows, ${test.warnings.length} warnings)? <button class="btn small-btn danger" id="imp-y">Replace</button><button class="btn small-btn" id="imp-n">Cancel</button></span>`;
    $("imp-n").addEventListener("click", () => { $("import-msg").textContent = ""; });
    $("imp-y").addEventListener("click", async () => {
      if (!store.online()) { $("import-msg").textContent = offline; return; }
      if (!me) { await askName(); if (!me) return; }
      $("import-msg").textContent = "Loading…";
      try { await store.replaceAll(j.sections, `Loaded a copy of the plan (${f.name})`, me); $("import-msg").textContent = "Loaded. The plan as it was before is saved as a copy."; }
      catch (err) { $("import-msg").textContent = err.code === "offline" ? offline : "Couldn't load it: " + (err.code || err.message); }
    });
  });

  function checkStorable(sections) {
    const bad = [];
    const walk = (v, path, inArray) => {
      if (bad.length > 2) return;
      if (Array.isArray(v)) { if (inArray) bad.push(`${path} has a list inside a list`); v.forEach((x, i) => walk(x, `${path}[${i}]`, true)); }
      else if (v && typeof v === "object") for (const [k2, x] of Object.entries(v)) { if (k2 === "" || /^__.*__$/.test(k2)) bad.push(`${path} uses the name '${k2}'`); walk(x, `${path}.${k2}`, false); }
    };
    walk(sections, "sections", false);
    for (const [name, items] of Object.entries(sections)) if (JSON.stringify(items || {}).length > 900000) bad.push(`the ${name} table is over 900 KB`);
    return bad.slice(0, 3).join("; ");
  }

  // ---------------------------------------------------------------- print
  $("print").addEventListener("click", () => {
    if (!DATA) return;
    const cur = byCode[state.sel] ? byCode[state.sel].name : null;
    openModal("Print", `<div class="chips" style="flex-direction:column;align-items:stretch">
      <button type="button" data-p="cards">Everyone's cards (one per page)</button>
      ${cur ? `<button type="button" data-p="one">${esc(cur)}'s card</button>` : ""}
      <button type="button" data-p="run">The run sheet and signals</button>
      <button type="button" data-p="resets">Resets, preset and measuring</button>
      <button type="button" data-p="all">Everything</button></div>
      <p class="small">Prints in the browser: pick your printer, or Save as PDF.</p><div class="btnrow"><button class="btn" id="p-cancel">Cancel</button></div>`);
    $("p-cancel").addEventListener("click", closeModal);
    for (const b of document.querySelectorAll("#modal-body [data-p]")) b.addEventListener("click", () => { closeModal(); doPrint(b.dataset.p); });
  });
  function doPrint(what) {
    const foot = `<div class="pfoot">${esc(DATA.ui.title)} · ${esc([DATA.draft, DATA.version].filter(Boolean).join(" · "))} · printed ${esc(new Date().toLocaleString())} · ${esc(DATA.privacy)}</div>`;
    const head = (t) => `<div class="pstamp">${esc(DATA.ui.texts.stamp || DATA.privacy)}</div><h1>${esc(t)}</h1>`;
    const pages = [];
    const card = (p) => pages.push(`<div class="pg">${head(DATA.ui.title)}${personCardHTML(p, true)}${foot}</div>`);
    if (what === "cards" || what === "all") people.forEach(card);
    if (what === "one" && byCode[state.sel]) card(byCode[state.sel]);
    if (what === "run" || what === "all") pages.push(`<div class="pg">${head("Run sheet")}<p>${esc(DATA.ui.texts.runIntro)}</p>${runSheetHTML()}<h2>Signals</h2><p>${esc(DATA.ui.texts.signalsIntro)}</p>${signalsHTML()}${foot}</div>`);
    if (what === "resets" || what === "all") {
      const rs = (rows) => `<table><tr><th>#</th><th>Who</th><th>What</th><th>Min after cut</th></tr>${rows.map((r) => `<tr><td>${esc(r[1])}</td><td>${esc(r[2])}<br>${esc(r[3])}${r[4] ? " → " + esc(r[4]) : ""}</td><td>${esc(r[5])}</td><td>${esc(r[6])}</td></tr>`).join("")}</table>`;
      pages.push(`<div class="pg">${head("Resets")}<h2>${esc(DATA.ui.texts.resetPartialName)}</h2><p>${esc(DATA.ui.texts.resetPartial)}</p>${rs(DATA.resetPartial)}<h2>${esc(DATA.ui.texts.resetFullName)}</h2><p>${esc(DATA.ui.texts.resetFull)}</p>${rs(DATA.resetFull)}${foot}</div>`);
      pages.push(`<div class="pg">${head("Preset")}<table><tr><th>Area</th><th>Item</th><th>Who</th><th>Status</th></tr>${DATA.preset.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}${r[2] ? `<br>${esc(r[2])}` : ""}</td><td>${esc(r[3])}</td><td>${esc(r[5])}</td></tr>`).join("")}</table>
        <h2>To measure at the house</h2><table><tr><th>Measure</th><th>Why</th><th>Value</th></tr>${DATA.ui.measure.map((m) => `<tr><td>${esc(m[0])}</td><td>${esc(m[1])}</td><td>${esc(m[2])}</td></tr>`).join("")}</table>${foot}</div>`);
      pages.push(`<div class="pg">${head("Open questions")}<table><tr><th>Question</th><th>For</th><th>Questions doc?</th></tr>${DATA.openItems.map((r) => `<tr><td>${esc(r[0])}<br><i>${esc(r[2])}</i></td><td>${esc(r[1])}</td><td>${esc(r[3])}</td></tr>`).join("")}</table>${foot}</div>`);
    }
    $("printroot").innerHTML = pages.join("");
    setTimeout(() => window.print(), 50);
  }

  // ---------------------------------------------------------------- who else is here
  let presTimer = null, unPres = null;
  function startPresence() {
    if (!unPres) unPres = store.watchPresence((list) => {
      const byName = {};
      for (const p of list) if (p.name && p.name !== me) byName[p.name] = p;
      const names = Object.values(byName);
      $("here").innerHTML = names.length ? "Here now: " + names.map((p) => `<span class="who" title="${esc(p.tab || "")}">${esc(p.name)}</span>`).join("") : "";
    });
    const beat = () => { if (document.visibilityState === "visible" && me) store.presence({ name: me, tab: state.tab }); };
    clearInterval(presTimer); beat(); presTimer = setInterval(beat, PRESENCE_MS);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && me) store.presence({ name: me, tab: state.tab }); });
  window.addEventListener("pagehide", () => store.leave());

  // ---------------------------------------------------------------- tabs and controls
  function setTab(t) {
    state.tab = t;
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.view === t));
    const boardTabs = ["take", "cards", "resets", "about"];
    $("main-grid").hidden = !boardTabs.includes(t);
    for (const v of boardTabs) $("view-" + v).hidden = v !== t;
    for (const v of ["plan", "checks", "history"]) $("view-" + v).hidden = v !== t;
    $("timeline").style.opacity = t === "resets" ? 0.45 : 1;
    $("edit-hint").hidden = !state.edit || t !== "take";
    try { history.replaceState(null, "", "#" + KEY + (t === "take" ? "" : "/" + t)); } catch (e) { /* ignore */ }
    if (t === "plan") { secChips(); renderPlan(true); }
    watchHistory(t === "history");
    if (t === "history") { renderHistory(); renderSnaps(); }
    for (const e of document.querySelectorAll(".edit-only")) e.hidden = !state.edit;
    if (unPres && me) store.presence({ name: me, tab: t });
    if (!DATA) return;
    if (t === "cards") renderCard();
    if (t === "resets") renderResets(); else drawOverlay();
    if (t === "checks") renderChecks();
    renderInspector();
    viewNow = null; lastPanelKey = ""; render();
  }
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => setTab(b.dataset.view));
  $("r-partial").addEventListener("click", () => { state.reset = "partial"; renderResets(); viewNow = null; render(); });
  $("r-full").addEventListener("click", () => { state.reset = "full"; renderResets(); viewNow = null; render(); });
  for (const id of ["c-now", "c-stop", "c-reset"]) $(id).addEventListener("input", calc);
  const viewBtns = { auto: $("v-auto"), kitchen: $("v-kitchen"), route: $("v-route") };
  for (const [v, b] of Object.entries(viewBtns)) b.addEventListener("click", () => { state.view = v; for (const [w, c] of Object.entries(viewBtns)) c.setAttribute("aria-pressed", String(w === v)); viewNow = null; render(); });
  for (const b of document.querySelectorAll("[data-speed]")) b.addEventListener("click", () => { state.speed = Number(b.dataset.speed); for (const c of document.querySelectorAll("[data-speed]")) c.setAttribute("aria-pressed", String(c === b)); });
  const scrub = $("scrub");
  function setT(T) { if (!DATA) return; state.T = Math.max(-10, Math.min(DATA.takeEnd, T)); scrub.value = state.T; render(); if (state.tab === "take" && state.kf) { const s = selectedKey(); if (s && !$("inspector").contains(document.activeElement)) renderInspector(); } }
  scrub.addEventListener("input", () => { state.T = Number(scrub.value); render(); });
  function step(ts) {
    if (!state.playing) return;
    const dt = lastFrame ? (ts - lastFrame) / 1000 : 0; lastFrame = ts;
    state.T = Math.min(DATA.takeEnd, state.T + dt * state.speed); scrub.value = state.T; render();
    if (state.T >= DATA.takeEnd) { togglePlay(false); return; }
    requestAnimationFrame(step);
  }
  function togglePlay(on) {
    state.playing = on === undefined ? !state.playing : on;
    $("play").textContent = state.playing ? "Pause" : "Play";
    if (state.playing) { if (state.T >= DATA.takeEnd) state.T = -10; lastFrame = 0; requestAnimationFrame(step); }
  }
  $("play").addEventListener("click", () => togglePlay());
  const starts = () => Array.from(new Set(DATA.beats.map((b) => Math.max(b.t0, -10)))).sort((a, b) => a - b);
  $("prev").addEventListener("click", () => { const s = starts().filter((t) => t < state.T - 0.6); setT(s.length ? s[s.length - 1] : -10); });
  $("next").addEventListener("click", () => { const s = starts().find((t) => t > state.T + 0.1); setT(s === undefined ? DATA.takeEnd : s); });
  $("back1").addEventListener("click", () => setT(Math.round(state.T * 2) / 2 - 0.5));
  for (const b of document.querySelectorAll("[data-zoom]")) b.addEventListener("click", () => setZoom(b.dataset.zoom));
  $("fwd1").addEventListener("click", () => setT(Math.round(state.T * 2) / 2 + 0.5));
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (!$("modal").hidden) { if (e.key === "Escape") closeModal(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) { e.preventDefault(); undoLast(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) && document.activeElement.id !== "scrub") return;
    if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); togglePlay(); }
    else if (e.key === "[") $("prev").click();
    else if (e.key === "]") $("next").click();
    else if (e.key === ",") $("back1").click();
    else if (e.key === ".") $("fwd1").click();
    else if (e.key === "e" || e.key === "E") setEdit(!state.edit);
    else if (e.key === "Escape" && state.kf) { state.kf = null; renderInspector(); buildLanes(); render(); }
  });
  try { new ResizeObserver(() => { const old = pxPerUnit; measure(); if (DATA && Math.abs(old - pxPerUnit) > 0.01) { viewNow = null; render(); if (state.tab === "resets") drawOverlay(); } }).observe(map); } catch (e) { /* older browsers */ }

  return { state, store, get data() { return DATA; }, get warnings() { return WARN; }, get checks() { return CHECKS; }, get plan() { return PLAN; }, setT, setTab, setEdit, commit, selectKey, gotoSection };
}
