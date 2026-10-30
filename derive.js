/* Shot planner: everything the board shows, worked out from the plan's rows.
   derive(plan) takes the plan (sections of rows, as stored) and returns the board's data, the warnings (rows it couldn't
   read) and the model checks. Same rules as the Python build it replaces, so the numbers match. No plan content lives in
   this file: names, places and wording all come from the plan itself. */
(function (root) {
  "use strict";

  const DEG = 180 / Math.PI;

  // ------------------------------------------------------------------ number helpers that round like Python
  function pyRound(x, n) {
    n = n || 0;
    if (!isFinite(x)) return x;
    if (Math.abs(x) < 1e9) {                                // fast path: not near a tie, so plain rounding agrees
      const p = Math.pow(10, n), s = x * p, fl = Math.floor(s), frac = s - fl;
      if (Math.abs(frac - 0.5) > 1e-6) return (frac < 0.5 ? fl : fl + 1) / p;
    }
    const neg = x < 0, a = Math.abs(x);
    let s;
    try { s = a.toFixed(Math.min(100, n + 60)); } catch (e) { s = a.toFixed(20); }
    const dot = s.indexOf(".");
    const tail = dot < 0 ? "" : s.slice(dot + 1 + n);
    let out;
    if (tail[0] === "5" && /^50*$/.test(tail)) {           // an exact tie: round half to even
      const head = dot < 0 ? s : s.slice(0, dot + 1 + n).replace(/\.$/, "");
      const digits = head.replace(".", "");
      const last = Number(digits[digits.length - 1]);
      const scale = Math.pow(10, n);
      const base = Number(head);
      out = last % 2 === 0 ? base : (Math.round(base * scale) + 1) / scale;
      out = Number(out.toFixed(n));
    } else {
      out = Number(a.toFixed(n));
    }
    return neg ? -out : out;
  }
  const fmt = (x, n) => pyRound(x, n).toFixed(n);
  function pyMod(a, b) {
    let m = a % b;
    if (m !== 0) { if ((b < 0) !== (m < 0)) m += b; } else m = 0;
    return m;
  }
  // math.hypot and sum() as CPython computes them (compensated), so distances and speeds agree to the last bit
  const SPLIT = 134217729;
  function hypot(x, y) {
    x = Math.abs(x); y = Math.abs(y);
    const max = x > y ? x : y;
    if (max === Infinity) return Infinity;
    if (x !== x || y !== y) return NaN;
    if (max === 0) return 0;
    if (x === 0 || y === 0) return max;
    let e = Math.ceil(Math.log2(max)), scale = Math.pow(2, -e);
    while (max * scale >= 1) { e += 1; scale = Math.pow(2, -e); }
    while (max * scale < 0.5) { e -= 1; scale = Math.pow(2, -e); }
    let csum = 1.0, frac1 = 0.0, frac2 = 0.0, a, p, t, ah, al, sm;
    // x, then y: exact squares (Dekker), added to csum without loss
    a = x * scale; p = a * a; t = SPLIT * a; ah = t - (t - a); al = a - ah;
    frac1 += al * al - (((p - ah * ah) - al * ah) - ah * al); sm = csum + p; frac2 += p - (sm - csum); csum = sm;
    a = y * scale; p = a * a; t = SPLIT * a; ah = t - (t - a); al = a - ah;
    frac1 += al * al - (((p - ah * ah) - al * ah) - ah * al); sm = csum + p; frac2 += p - (sm - csum); csum = sm;
    let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
    // correction step: csum - h*h, exactly
    const b = -h; p = b * h; t = SPLIT * b; const bh = t - (t - b), bl = b - bh; t = SPLIT * h; const hh = t - (t - h), hl = h - hh;
    frac1 += bl * hl - (((p - bh * hh) - bl * hh) - bh * hl); sm = csum + p; frac2 += p - (sm - csum); csum = sm;
    h += (csum - 1.0 + (frac1 + frac2)) / (2.0 * h);
    return h / scale;
  }
  function pySum(arr) {
    if (!arr.length) return 0;
    let f = 0 + arr[0], c = 0.0;
    for (let i = 1; i < arr.length; i++) {
      const x = arr[i], t = f + x;
      if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x; else c += (x - t) + f;
      f = t;
    }
    if (c && isFinite(c)) f += c;
    return f;
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  function mmss(T) {
    const neg = T < 0;
    const t = pyRound(Math.abs(T), 0);
    return (neg ? "-" : "") + Math.floor(t / 60) + ":" + pad2(t % 60);
  }
  function txt(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
    if (typeof v === "boolean") return v ? "Yes" : "";
    return String(v).trim();
  }
  const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
  function pyFloat(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return NUM_RE.test(s) ? Number(s) : null;
  }
  function parseTime(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const s = String(v).trim().replace(/−/g, "-");
    const m = /^(-?)(\d+):(\d{1,2})(?:\.(\d+))?$/.exec(s);
    if (!m) return pyFloat(s);
    if (Number(m[3]) >= 60) return null;
    const val = Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number("0." + m[4]) : 0);
    return m[1] ? -val : val;
  }
  function parsePoints(v, known) {
    const pts = [], bad = [];
    for (const part of txt(v).split(";").map((p) => p.trim()).filter(Boolean)) {
      if (Object.prototype.hasOwnProperty.call(known, part)) { pts.push(known[part].slice()); continue; }
      const m = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(part);
      if (m) pts.push([Number(m[1]), Number(m[2])]); else bad.push(part);
    }
    return [pts, bad];
  }
  function parsePair(v, dflt) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(txt(v));
    return m ? [Number(m[1]), Number(m[2])] : dflt;
  }
  function parseSpan(v, dflt) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(txt(v));
    return m ? [Number(m[1]), Number(m[2])] : dflt;
  }
  function parseList(v) { return txt(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean); }
  function parseBox(v, dflt) {
    const p = txt(v).split(/[,;\s]+/).filter(Boolean).map(Number);
    return p.length === 4 && p.every(isFinite) ? p : dflt;
  }
  const yes = (v) => /^(y|yes|true|1|x)$/i.test(txt(v));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = (re, s) => { const out = []; let m; const r = new RegExp(re.source, "g"); while ((m = r.exec(s))) out.push(m[1]); return out; };
  const MARK_CODE = /\b([A-Z]\d)\b/;

  function rowsOf(plan, name) {
    const sec = (plan && plan.sections && plan.sections[name]) || {};
    return Object.keys(sec).filter((id) => sec[id] && typeof sec[id] === "object")
      .map((id) => Object.assign({ id }, sec[id]))
      .sort((a, b) => ((a.o == null ? 1e15 : a.o) - (b.o == null ? 1e15 : b.o)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // ------------------------------------------------------------------ the derivation
  function derive(plan) {
    const W = [];
    const warn = (sec, id, text) => W.push({ sec, id, text });
    const set = {};
    for (const r of rowsOf(plan, "settings")) set[r.id] = r.value;
    const tx = {};
    for (const r of rowsOf(plan, "texts")) tx[r.id] = txt(r.text);
    const sNum = (k, d) => { const v = pyFloat(set[k]); return v === null ? d : v; };
    const sStr = (k, d) => (txt(set[k]) || d);
    const STATUS = parseList(set.statusWords || "Stated, Proposed, Confirmed, Open, Dropped");
    const checkStatus = (sec, id, n, value, label) => {
      const v = txt(value);
      if (v && !STATUS.includes(v)) warn(sec, id, `${sec} row ${n}: ${label || "Status"} '${v}' isn't one of ${STATUS.join(", ")}`);
    };
    const TAB = { marks: "Marks", people: "People", beats: "Beats", moves: "Moves", runsheet: "Run sheet", cards: "Cards", swaps: "Swaps",
      resets: "Resets", preset: "Preset", signals: "Signals", measure: "Measure", openitems: "Open items" };

    // ---- lenses and model settings
    const LENSES = {};
    for (const part of txt(set.lenses || "18 mm=90; 24 mm=74; 35 mm=54").split(";")) {
      const m = /^\s*(.+?)\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
      if (m) LENSES[m[1]] = Number(m[2]);
    }
    if (!Object.keys(LENSES).length) LENSES["24 mm"] = 74;
    const LENS = LENSES[sStr("lens", "24 mm")] !== undefined ? sStr("lens", "24 mm") : Object.keys(LENSES)[0];
    const NEAR_EDGE = sNum("nearEdge", 10), MAX_RANGE = sNum("maxRange", 30), SWAP_SPEED = sNum("swapSpeed", 0.7);
    const SWAP_MARGIN = sNum("swapMargin", 3), BODY_HALF = sNum("bodyHalf", 0.25), TALENT_GAP = sNum("talentGap", 0.9);
    const CLEARANCE = sNum("clearance", 0.3), CROWD = sNum("crowdGap", 0.45), TIMER_LEN = sNum("timerLen", 900);
    const TALENT_SET = txt(set.talent), CAMERA_SET = txt(set.camera);

    // ---- marks, things on a counter, places off the plan
    const marks = [], draftMarks = [], off = [], props = [], find = {}, seen = {};
    rowsOf(plan, "marks").forEach((r, i) => {
      const n = i + 1;
      const code = txt(r.code), name = txt(r.name), kindRaw = txt(r.kind), kind = kindRaw.toLowerCase();
      const status = txt(r.status) || "Proposed", note = txt(r.note);
      checkStatus("Marks", r.id, n, status);
      if (!code) { warn("Marks", r.id, `Marks row ${n}: no code`); return; }
      if (seen[code]) { warn("Marks", r.id, `Marks row ${n}: code '${code}' is already used on row ${seen[code]}; this row is skipped`); return; }
      seen[code] = n;
      if (txt(r.find)) find[code] = txt(r.find);
      if (kind === "off the plan") { off.push([code, name, note, status]); return; }
      const x = pyFloat(r.x), y = pyFloat(r.y);
      if (x === null || y === null) { warn("Marks", r.id, `Marks row ${n} (${code}): plan x and y must be numbers`); return; }
      const k = /'s route$/.test(kind) || kind === "route" ? "route" : /'s station$/.test(kind) || kind === "station" ? "station"
        : kind === "landmark" ? "landmark" : kind === "camera mark" || kind === "camera" ? "camera" : kind === "crew hold" || kind === "hold" ? "hold" : null;
      if (kind === "on a counter") props.push([code, name, x, y, r.id]);
      else if (k === "camera" || k === "hold") draftMarks.push([code, name, x, y, k, status, note, r.id]);
      else if (k) marks.push([code, name, x, y, k, status, note, r.id]);
      else warn("Marks", r.id, `Marks row ${n} (${code}): unknown kind '${kindRaw}'`);
    });
    const MARK_XY = {};
    for (const m of marks.concat(draftMarks)) MARK_XY[m[0]] = [m[2], m[3]];
    const PROP_XY = {};
    for (const p of props) PROP_XY[p[0]] = [p[2], p[3]];
    const markId = {};
    for (const m of marks.concat(draftMarks)) markId[m[0]] = m[7];

    // ---- people
    const people = [];
    const pCodes = new Set();
    rowsOf(plan, "people").forEach((r, i) => {
      const n = i + 1, code = txt(r.code);
      checkStatus("People", r.id, n, r.status);
      if (pCodes.has(code)) { warn("People", r.id, `People row ${n}: code '${code}' is already used; this row is skipped`); return; }
      pCodes.add(code);
      people.push({ id: r.id, code, who: txt(r.who), role: txt(r.role), during: txt(r.during), card: txt(r.card), slack: txt(r.slack),
        status: txt(r.status), note: txt(r.note), initials: txt(r.initials) || code.slice(0, 2), color: txt(r.color) || "crew",
        tape: txt(r.tape), speed: pyFloat(r.speed), cont: parseTime(r.cont), checked: yes(r.checked), runcol: txt(r.runcol),
        marks: txt(r.marks), goesby: txt(r.goesby).toLowerCase(), named: txt(r.named) === "" ? true : yes(r.named), withcam: yes(r.withcam) });
    });
    const P = Object.fromEntries(people.map((p) => [p.code, p]));
    const TALENT = TALENT_SET || ((people.find((p) => p.color === "talent") || {}).code || "");
    const CAMERA = CAMERA_SET || ((people.find((p) => p.color === "camera") || {}).code || "");
    const NAMES = Object.fromEntries(people.map((p) => [p.code, p.who]));
    const OFF_PLAN = {};
    for (const p of people) {
      const m = /\b([HVX]\d)\b/.exec(p.during);
      if (m && p.code !== TALENT && p.code !== CAMERA && p.cont === null) OFF_PLAN[p.code] = [m[1], p.during];
    }

    // ---- beats
    const beatsAll = [], beatTimes = [], beatSeen = new Set(), insideSet = new Set(), pills = {};
    rowsOf(plan, "beats").forEach((r, i) => {
      const n = i + 1, b = txt(r.code);
      if (beatSeen.has(b)) { warn("Beats", r.id, `Beats row ${n}: beat '${b}' is already used; this row is skipped`); return; }
      beatSeen.add(b);
      beatsAll.push(Object.assign({}, r, { code: b }));
      checkStatus("Beats", r.id, n, r.wording, "Wording status");
      checkStatus("Beats", r.id, n, r.timing, "Timing status");
      let t0 = parseTime(r.t0), t1 = parseTime(r.t1);
      if (t0 === null && t1 === null) return;
      if (t0 === null) { warn("Beats", r.id, `Beats row ${n} (${b}): the start must be m:ss; this beat is left out until it's fixed`); return; }
      if (t1 === null || t1 < t0) { warn("Beats", r.id, `Beats row ${n} (${b}): the end must be m:ss and after the start; kept with a 1 s length until it's fixed`); t1 = t0 + 1; }
      beatTimes.push([b, t0, t1, txt(r.card) || b, r.id]);
      if (yes(r.inside)) insideSet.add(b);
      if (txt(r.pill)) pills[b] = txt(r.pill);
    });
    const BEAT_INDEX = Object.fromEntries(beatTimes.map((b) => [b[0], b]));
    const timerBeat = txt(set.timerBeat), cutBeat = txt(set.cutBeat), endBeat = txt(set.endBeat);
    for (const need of [timerBeat, endBeat]) {
      if (need && !BEAT_INDEX[need]) warn("Beats", null, `Beats: ${need} needs a start and an end (the timer and the end of the take come from it)`);
    }
    const TIMER_START = BEAT_INDEX[timerBeat] ? BEAT_INDEX[timerBeat][1] : 0;
    const TAKE_END = BEAT_INDEX[endBeat] ? BEAT_INDEX[endBeat][2] : Math.max(60, ...beatTimes.map((b) => b[2]));
    const CUT_POINT = BEAT_INDEX[cutBeat] ? BEAT_INDEX[cutBeat][1] : TAKE_END;
    const INSIDE = beatTimes.filter((b) => insideSet.has(b[0])).map((b) => b[0]);
    const timerFull = () => { const r = pyRound(TIMER_LEN, 0); return Math.floor(r / 60) + ":" + pad2(r % 60); };
    function timerAt(T) {
      if (T < TIMER_START) return timerFull();
      const rem = Math.max(0, Math.trunc(pyRound(TIMER_LEN - (T - TIMER_START), 0)));
      return Math.floor(rem / 60) + ":" + pad2(rem % 60);
    }
    function beatAt(T) {
      let cur = beatTimes.length ? beatTimes[0][0] : "";
      for (const [b, t0] of beatTimes) { if (insideSet.has(b)) continue; if (t0 <= T) cur = b; }
      for (const b of INSIDE) { const x = BEAT_INDEX[b]; if (x && x[1] <= T && T < x[2]) return b; }
      return cur;
    }

    // ---- moves
    const RAW = {}, WATCH = {}, KEYS = {};
    const knownLooks = new Set(Object.keys(MARK_XY).concat(props.map((p) => p[0]), people.map((p) => p.code)));
    rowsOf(plan, "moves").forEach((r, i) => {
      const n = i + 1, who = txt(r.who), T = parseTime(r.t), where = txt(r.at);
      if (!who || T === null || !where) { warn("Moves", r.id, `Moves row ${n}: needs a person, a take time (m:ss) and a where`); return; }
      if (!pCodes.has(who)) { warn("Moves", r.id, `Moves row ${n}: person '${who}' isn't a code on the People tab; row skipped`); return; }
      checkStatus("Moves", r.id, n, r.status);
      let xy;
      if (MARK_XY[where]) xy = MARK_XY[where];
      else {
        const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(where);
        if (!m) { warn("Moves", r.id, `Moves row ${n} (${who} ${mmss(T)}): where '${where}' is not a mark code or 'x, y'`); return; }
        xy = [Number(m[1]), Number(m[2])];
      }
      const lookRaw = txt(r.face);
      let look = null;
      if (lookRaw !== "") {
        const f = pyFloat(lookRaw);
        if (f !== null) look = f;
        else if (knownLooks.has(lookRaw)) look = lookRaw;
        else warn("Moves", r.id, `Moves row ${n} (${who} ${mmss(T)}): facing '${lookRaw}' isn't a person, mark, thing or number`);
      }
      let beat = txt(r.beat);
      if (beat && !beatSeen.has(beat)) { warn("Moves", r.id, `Moves row ${n} (${who} ${mmss(T)}): beat '${beat}' isn't on the Beats tab; filed by its time instead`); beat = ""; }
      const k = [T, [pyRound(xy[0], 3), pyRound(xy[1], 3)], look, txt(r.what), beat];
      (RAW[who] = RAW[who] || []).push(k);
      (KEYS[who] = KEYS[who] || []).push({ id: r.id, t: T, x: k[1][0], y: k[1][1], at: where, mark: MARK_XY[where] ? where : "", face: look,
        what: txt(r.what), watch: txt(r.watch), beat, status: txt(r.status) });
      const w = txt(r.watch);
      if (w) WATCH[who + "@" + T] = w;
    });
    for (const who of Object.keys(RAW)) {
      RAW[who].sort((a, b) => a[0] - b[0]);
      KEYS[who].sort((a, b) => a.t - b.t);
      const times = RAW[who].map((k) => k[0]);
      if (new Set(times).size !== times.length) warn("Moves", null, `Moves: ${who} has two rows at the same take time`);
    }
    if (!RAW[CAMERA] || !RAW[TALENT]) warn("Moves", null, `Moves: ${NAMES[TALENT] || TALENT} (${TALENT}) and the camera (${CAMERA}) both need rows`);

    // ---- run sheet
    const SUMMARY = new Map(), RUN_NOTES = {};
    rowsOf(plan, "runsheet").forEach((r, i) => {
      const b = txt(r.beat);
      checkStatus("Run sheet", r.id, i + 1, r.status);
      const cells = r.cells || {};
      for (const p of people) {
        if (!p.runcol) continue;
        const v = txt(cells[p.code]);
        if (v) { if (!SUMMARY.has(p.code)) SUMMARY.set(p.code, new Map()); SUMMARY.get(p.code).set(b, v); }
      }
      if (txt(r.note)) RUN_NOTES[b] = txt(r.note);
    });

    // ---- cards (for people without moves)
    const CARD_LINES = [];
    rowsOf(plan, "cards").forEach((r, i) => {
      const n = i + 1, who = txt(r.who);
      checkStatus("Cards", r.id, n, r.status);
      if (RAW[who]) warn("Cards", r.id, `Cards row ${n}: ${who}'s card is built from Moves, so this row isn't used`);
      else if (!pCodes.has(who)) warn("Cards", r.id, `Cards row ${n}: person '${who}' isn't a code on the People tab`);
      CARD_LINES.push([who, txt(r.when), txt(r.at), txt(r.what), txt(r.watch)]);
    });

    // ---- swaps
    const SWAPS = [];
    const places = new Set(off.map((o) => o[0]).concat(["Open"]));
    rowsOf(plan, "swaps").forEach((r, i) => {
      const n = i + 1, code = txt(r.code);
      if (SWAPS.some((s) => s.code === code)) { warn("Swaps", r.id, `Swaps row ${n}: code '${code}' is already used; this row is skipped`); return; }
      const ax = pyFloat(r.ax), ay = pyFloat(r.ay);
      if (ax === null || ay === null) { warn("Swaps", r.id, `Swaps row ${n} (${code}): 'swapper stands' x and y must be numbers; row skipped`); return; }
      const target = txt(r.target);
      if (!PROP_XY[target]) warn("Swaps", r.id, `Swaps row ${n} (${code}): target '${target}' isn't on the Marks tab as a thing on a counter`);
      const frm = txt(r.frm);
      if (!MARK_XY[frm] && !places.has(frm)) warn("Swaps", r.id, `Swaps row ${n} (${code}): from '${frm}' isn't a mark or a place off the plan; the hold is left out of the check`);
      const [way, bad] = parsePoints(r.way, MARK_XY);
      if (bad.length) warn("Swaps", r.id, `Swaps row ${n} (${code}): couldn't read ${bad.join(", ")} in 'Way in'; use marks or 'x, y' separated by ';'`);
      let uf = parseTime(r.uf), ut = parseTime(r.ut);
      if (uf === null || ut === null || ut <= uf) { warn("Swaps", r.id, `Swaps row ${n} (${code}): 'useful from' and 'useful to' should be m:ss, in order; using the whole take`); uf = 0; ut = 99999; }
      let handling = pyFloat(r.handling);
      if (handling === null || !(handling > 0)) { warn("Swaps", r.id, `Swaps row ${n} (${code}): 'swap takes' should be a number of seconds above 0; using 10`); handling = 10; }
      checkStatus("Swaps", r.id, n, r.status);
      SWAPS.push({ id: r.id, code, name: txt(r.name), cond: txt(r.cond), what: txt(r.what), who: txt(r.who), frm, route: txt(r.route), target,
        access: [ax, ay], status: txt(r.status), source: txt(r.source), useful: [uf, ut], way_in: way, handling });
    });

    // ---- resets
    const partialName = (tx.resetPartialName || "Partial reset").toLowerCase();
    const nameSet = new Set(people.map((p) => p.who.toLowerCase()).concat(people.map((p) => p.goesby).filter(Boolean), ["everyone"]));
    const PART = [], FULL = [];
    rowsOf(plan, "resets").forEach((r, i) => {
      const n = i + 1;
      const [route, bad] = parsePoints(r.route, MARK_XY);
      if (bad.length) warn("Resets", r.id, `Resets row ${n}: couldn't read ${bad.join(", ")} in 'Route on the map'`);
      const row = { id: r.id, kind: txt(r.kind), step: txt(r.step), who: txt(r.who), frm: txt(r.frm), to: txt(r.to), what: txt(r.what),
        when: txt(r.when), status: txt(r.status), note: txt(r.note), route, label: txt(r.label), style: txt(r.style) };
      checkStatus("Resets", r.id, n, row.status);
      const who = row.who.toLowerCase();
      if (![...nameSet].some((nm) => nm && new RegExp("\\b" + escRe(nm) + "\\b").test(who))) {
        warn("Resets", r.id, `Resets row ${n} (step ${row.step}): '${row.who}' doesn't name anyone on the People tab, so no card gets this step`);
      }
      (row.kind.toLowerCase() === partialName ? PART : FULL).push(row);
    });

    // ---- preset, signals, measure, open items
    const PRESET = [];
    const knownWho = new Set([...nameSet, "open", ""]);
    rowsOf(plan, "preset").forEach((r, i) => {
      checkStatus("Preset", r.id, i + 1, r.status);
      if (!knownWho.has(txt(r.who).toLowerCase())) warn("Preset", r.id, `Preset row ${i + 1}: who '${txt(r.who)}' isn't a name on the People tab, so it's on nobody's card`);
      PRESET.push([txt(r.area), txt(r.item), txt(r.how), txt(r.who), txt(r.forc), txt(r.status), txt(r.note)]);
    });
    const SIGNALS = [];
    rowsOf(plan, "signals").forEach((r, i) => {
      checkStatus("Signals", r.id, i + 1, r.status);
      SIGNALS.push([txt(r.signal), txt(r.means), txt(r.by), txt(r.to), txt(r.how), txt(r.when), txt(r.status), txt(r.note)]);
    });
    const MEASURE = rowsOf(plan, "measure").filter((r) => txt(r.measure)).map((r) => [txt(r.measure), txt(r.why), txt(r.value), txt(r.by), txt(r.date)]);
    const OPEN = [];
    rowsOf(plan, "openitems").forEach((r, i) => {
      checkStatus("Open items", r.id, i + 1, r.status);
      if (!["Dropped", "Confirmed"].includes(txt(r.status))) OPEN.push([txt(r.question), txt(r.who), txt(r.why), txt(r.ondoc)]);
    });

    // ---- the room
    const ptsOf = (v) => parsePoints(v, {})[0];
    const AREAS = rowsOf(plan, "areas").map((a) => ({ id: a.id, label: txt(a.label), poly: ptsOf(a.pts), kind: txt(a.kind), level: txt(a.level),
      conf: txt(a.conf), note: txt(a.note), style: txt(a.style) || (txt(a.kind) === "outside" ? "outside" : "room") }));
    const FEATURES = rowsOf(plan, "features").map((f) => ({ id: f.id, label: txt(f.label), x1: pyFloat(f.x1), y1: pyFloat(f.y1), x2: pyFloat(f.x2),
      y2: pyFloat(f.y2), kind: txt(f.kind) })).filter((f) => [f.x1, f.y1, f.x2, f.y2].every((v) => v !== null));
    const FIXTURES = rowsOf(plan, "fixtures").map((f) => ({ id: f.id, label: txt(f.label), x: pyFloat(f.x), y: pyFloat(f.y), w: pyFloat(f.w),
      h: pyFloat(f.h), kind: txt(f.kind), solid: yes(f.solid) })).filter((f) => [f.x, f.y, f.w, f.h].every((v) => v !== null));
    const seats = rowsOf(plan, "seats").map((s) => ({ id: s.id, kind: txt(s.kind).toLowerCase(), x: pyFloat(s.x), y: pyFloat(s.y), moved: yes(s.moved),
      r: pyFloat(s.r) })).filter((s) => s.x !== null && s.y !== null);
    const STOOLS = seats.filter((s) => s.kind === "stool").map((s) => [s.x, s.y]);
    const CHAIRS = seats.filter((s) => s.kind === "chair").map((s) => [s.x, s.y]);
    const BISTRO = seats.filter((s) => s.kind === "patio table");
    const POINTS = rowsOf(plan, "points").map((p) => ({ id: p.id, label: txt(p.label), x: pyFloat(p.x), y: pyFloat(p.y), kind: txt(p.kind) }))
      .filter((p) => p.x !== null && p.y !== null);
    const wallRows = rowsOf(plan, "walls").map((w) => ({ id: w.id, a: [pyFloat(w.x1), pyFloat(w.y1)], b: [pyFloat(w.x2), pyFloat(w.y2)], view: yes(w.view), walk: yes(w.walk) }))
      .filter((w) => w.a.concat(w.b).every((v) => v !== null));
    const WALLS = wallRows.filter((w) => w.view).map((w) => [w.a, w.b]);
    const BARRIERS = wallRows.filter((w) => w.walk).map((w) => [w.a, w.b]);
    const LABELS = rowsOf(plan, "labels").map((l) => ({ id: l.id, text: txt(l.text), x: pyFloat(l.x), y: pyFloat(l.y), size: pyFloat(l.size) || 13,
      style: txt(l.style), anchor: txt(l.anchor) || "middle", view: txt(l.view) })).filter((l) => l.text && l.x !== null && l.y !== null);
    const SOLID = FIXTURES.filter((f) => f.solid).map((f) => [f.x, f.y, f.w, f.h]);
    const OUTLINE = ptsOf(set.outline);

    // ---- moves expanded into holds and walks
    function expand(person, track) {
      if (!track.length) return [];
      const out = [track[0]];
      const p = P[person] || {};
      const sp = p.speed !== null && p.speed !== undefined && p.speed > 0 ? p.speed : 0.8;
      const cont = p.cont !== null && p.cont !== undefined ? p.cont : -1e9;
      for (let i = 0; i + 1 < track.length; i++) {
        const k0 = track[i], k1 = track[i + 1];
        const t0 = k0[0], p0 = k0[1], t1 = k1[0], p1 = k1[1];
        if (t1 > cont) {
          const dist = hypot(p1[0] - p0[0], p1[1] - p0[1]);
          const depart = dist > 0.05 ? Math.max(t0, t1 - Math.max(dist / sp, 1.0)) : t1;
          if (depart > t0 + 0.01 && dist > 0.05) out.push([pyRound(depart, 2), p0, null, "", k0[4]]);
        }
        out.push(k1);
      }
      return out;
    }
    const TRACKS = {};
    for (const who of Object.keys(RAW)) TRACKS[who] = expand(who, RAW[who]);
    // people in the order of the People rows
    const onMapOrder = people.map((p) => p.code).filter((c) => TRACKS[c] && TRACKS[c].length);

    function posAt(track, T) {
      if (!track || !track.length) return null;
      if (T <= track[0][0]) return track[0][1];
      for (let i = 0; i + 1 < track.length; i++) {
        const a = track[i], b = track[i + 1];
        if (a[0] <= T && T <= b[0]) {
          const f = b[0] === a[0] ? 0 : (T - a[0]) / (b[0] - a[0]);
          return [a[1][0] + (b[1][0] - a[1][0]) * f, a[1][1] + (b[1][1] - a[1][1]) * f];
        }
      }
      return track[track.length - 1][1];
    }
    function present(person, T) { const tr = TRACKS[person]; if (!tr || !tr.length) return false; return tr[0][0] <= -60 || T >= tr[0][0]; }
    function lookAt(track, T) { let last = null; for (const k of track) if (k[0] <= T && k[2] !== null && k[2] !== undefined) last = k[2]; return last; }
    function targetXY(look, x, y, T) {
      if (TRACKS[look] && TRACKS[look].length) return posAt(TRACKS[look], T);
      if (MARK_XY[look]) return MARK_XY[look];
      if (PROP_XY[look]) return PROP_XY[look];
      return [x + 1, y];
    }
    function headingAt(person, T) {
      const tr = TRACKS[person];
      const look = lookAt(tr, T);
      const [x, y] = posAt(tr, T);
      if (typeof look === "number") return look;
      const [tx2, ty2] = targetXY(look, x, y, T);
      return DEG * Math.atan2(ty2 - y, tx2 - x);
    }

    // ---- swaps: routes and how long they need
    function swapRoute(sw) {
      const pts = [];
      if (MARK_XY[sw.frm]) pts.push(MARK_XY[sw.frm]);
      for (const p of sw.way_in) pts.push(p);
      pts.push(sw.access);
      return pts;
    }
    function swapNeed(sw) {
      const pts = swapRoute(sw), legs = [];
      for (let i = 0; i + 1 < pts.length; i++) legs.push(hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
      return Math.ceil(2 * pySum(legs) / SWAP_SPEED + Number(sw.handling));
    }

    // ---- in frame (the sketch camera)
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    function segCross(p1, p2, q1, q2) {
      const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
      return (d1 * d2 < 0) && (d3 * d4 < 0);
    }
    const blocked = (a, b) => WALLS.some((w) => segCross(a, b, w[0], w[1]));
    function offAxis(cam, hd, t) {
      const dx = t[0] - cam[0], dy = t[1] - cam[1];
      const ang = DEG * Math.atan2(dy, dx);
      return [Math.abs(pyMod(ang - hd + 180, 360) - 180), hypot(dx, dy)];
    }
    function inView(cam, hd, t, fov, margin) {
      const [diff, dist] = offAxis(cam, hd, t);
      if (dist < 0.3 || dist > MAX_RANGE) return false;
      if (diff > fov / 2 + (margin || 0)) return false;
      return !blocked(cam, t);
    }
    function frameState(cam, hd, t, fov) {
      const [diff, dist] = offAxis(cam, hd, t);
      if (dist < 0.3 || dist > MAX_RANGE || blocked(cam, t)) return ["out", diff];
      if (diff <= fov / 2) return ["in", diff];
      if (diff <= fov / 2 + NEAR_EDGE) return ["edge", diff];
      return ["out", diff];
    }
    function runs(times, ok, step, minLen) {
      minLen = minLen || 0;
      const out = [];
      let start = null;
      for (let i = 0; i < times.length; i++) {
        const T = times[i], good = ok[i];
        if (good && start === null) start = T;
        if (!good && start !== null) { if (T - step - start >= minLen) out.push([start, T - step]); start = null; }
      }
      if (start !== null && times[times.length - 1] - start >= minLen) out.push([start, times[times.length - 1]]);
      return out;
    }
    function timesFrom(t0, t1, step) { const out = []; let T = t0; while (T <= t1 + 1e-9) { out.push(pyRound(T, 3)); T += step; } return out; }
    const cam = TRACKS[CAMERA] || [], tal = TRACKS[TALENT] || [];
    const camCache = new Map();
    const camState = (T) => { let v = camCache.get(T); if (!v) { v = [posAt(cam, T), cam.length ? headingAt(CAMERA, T) : 0]; camCache.set(T, v); } return v; };
    const camAt = (T) => camState(T)[0], camHd = (T) => camState(T)[1];
    const checkedPeople = people.filter((p) => p.checked).map((p) => p.code);
    function sweep(fov, state, step) {
      step = step || 0.5;
      const times = timesFrom(-5.0, TAKE_END, step), out = {};
      if (!cam.length) return out;
      for (const p of checkedPeople) {
        if (!TRACKS[p] || !TRACKS[p].length) continue;
        const ok = times.map((T) => present(p, T) && frameState(camAt(T), camHd(T), posAt(TRACKS[p], T), fov)[0] === (state || "in"));
        out[p] = runs(times, ok, step);
      }
      return out;
    }
    function talentOut(fov) {
      if (!cam.length || !tal.length) return [];
      const times = timesFrom(0, TAKE_END, 0.5);
      return runs(times, times.map((T) => !inView(camAt(T), camHd(T), posAt(tal, T), fov, 2)), 0.5);
    }
    function clean(rs) {
      const out = [];
      for (const [a, b] of rs) { const a2 = Math.ceil(a - 1e-9), b2 = Math.floor(b + 1e-9); if (b2 > a2) out.push([a2, b2]); }
      return out;
    }
    const bodyDeg = (c, p) => DEG * Math.atan2(BODY_HALF, Math.max(hypot(p[0] - c[0], p[1] - c[1]), 0.3));
    function swapWindows() {
      const res = {};
      for (const sw of SWAPS) {
        let tFrom = Math.max(sw.useful[0], TIMER_START), tTo = Math.min(sw.useful[1], TAKE_END);
        const thing = PROP_XY[sw.target] ? [PROP_XY[sw.target]] : [];
        const body = swapRoute(sw), need = swapNeed(sw);
        res[sw.code] = {};
        for (const lens of Object.keys(LENSES)) {
          const fov = LENSES[lens];
          const times = timesFrom(tFrom, tTo, 0.5);
          const ok = times.map((T) => {
            if (!cam.length) return false;
            const c = camAt(T), hd = camHd(T);
            let clear = thing.every((p) => !inView(c, hd, p, fov, SWAP_MARGIN));
            clear = clear && body.every((p) => !inView(c, hd, p, fov, SWAP_MARGIN + bodyDeg(c, p)));
            const cy = tal.length ? posAt(tal, T) : [1e9, 1e9];
            return clear && hypot(cy[0] - sw.access[0], cy[1] - sw.access[1]) > TALENT_GAP;
          });
          res[sw.code][lens] = clean(runs(times, ok, 0.5, need));
        }
      }
      return res;
    }
    function thingRuns(xy, fov, t0, t1, margin) {
      const times = timesFrom(t0, t1, 0.5);
      return runs(times, times.map((T) => cam.length && inView(camAt(T), camHd(T), xy, fov, margin === undefined ? 3.0 : margin)), 0.5);
    }
    function firstInFrame(xy, fov) {
      if (!cam.length) return null;
      for (const T of timesFrom(-5.0, TAKE_END, 0.5)) if (inView(camAt(T), camHd(T), xy, fov)) return T;
      return null;
    }
    const WINDOWS = swapWindows();

    // ---- labels and mark sets
    const LABEL = {};
    for (const m of marks) LABEL[m[0]] = m[1];
    for (const m of draftMarks) LABEL[m[0]] = m[1];
    for (const o of off) LABEL[o[0]] = o[1];
    const allMarks = marks.concat(draftMarks);
    const MARKSET = {};
    for (const p of people) {
      if (!p.marks) continue;
      const spec = parseList(p.marks).map((s) => s.toLowerCase());
      const codes = new Set(parseList(p.marks));
      MARKSET[p.code] = allMarks.filter((m) => codes.has(m[0]) || spec.includes(m[4])).map((m) => m[0]);
    }
    function markNear(person, xy, tol) {
      tol = tol === undefined ? 0.6 : tol;
      let best = null, bd = 9e9;
      const codes = MARKSET[person] || Object.keys(MARK_XY);
      for (const code of codes) {
        if (!MARK_XY[code]) continue;
        const [x, y] = MARK_XY[code];
        const d = hypot(x - xy[0], y - xy[1]);
        if (d < bd) { best = code; bd = d; }
      }
      return bd <= tol ? best : null;
    }
    const TAKE_MIN = pyRound((TAKE_END + 30) / 60, 1);

    // ---- numbers for {tokens}
    const winText = (code, lens) => {
      lens = lens || LENS;
      const w = (WINDOWS[code] || {})[lens] || [];
      return (w.map(([a, b]) => `${mmss(a)}-${mmss(b)}`).join(", ") || "none") + ` at ${lens}`;
    };
    // {tokens}: each one is defined in the plan's settings ("tokens"), one per line: name = kind arguments
    //   take REF [+/-s]     take time of REF (cut, timer, timerend, end, or a beat code = its start)
    //   timer REF [+/-s]    the on-camera timer at REF
    //   length BEAT         the beat's length in seconds
    //   range A B T0-T1     closest and farthest two people get over that span ("talent", "camera" or a code)
    //   closest A B T0-T1   closest they get
    //   dist P Q            distance between two marks or things
    //   first THING LENS    first moment a thing on a counter is in frame at that lens
    const NUM = (function () {
      const dist = (a, b) => hypot(a[0] - b[0], a[1] - b[1]);
      const out = {};
      const f1 = (v) => `${fmt(v, 1)} m`;
      const refT = (ref) => {
        if (ref === "cut") return CUT_POINT;
        if (ref === "timer") return TIMER_START;
        if (ref === "timerend") return TIMER_START + TIMER_LEN;
        if (ref === "end") return TAKE_END;
        if (BEAT_INDEX[ref]) return BEAT_INDEX[ref][1];
        return null;
      };
      const who = (c) => TRACKS[c === "talent" ? TALENT : c === "camera" ? CAMERA : c] || [];
      const xyOf = (c) => MARK_XY[c] || PROP_XY[c] || null;
      const between = (a, b, sp) => {
        const ta = who(a), tb = who(b), [s0, s1] = parseSpan(sp, [0, 0]), o = [];
        if (!ta.length || !tb.length) return o;
        for (let T = s0; T <= s1 + 1e-9; T += 0.5) o.push(dist(posAt(ta, T), posAt(tb, T)));
        return o;
      };
      for (const line of txt(set.tokens).split("\n")) {
        const m = /^\s*([a-z0-9_]+)\s*=\s*(\w+)\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const [, name, kind, rest] = m, a = rest.split(/\s+/).filter(Boolean);
        let v = "?";
        if (kind === "take" || kind === "timer") {
          const t = refT(a[0]), off = a[1] ? Number(a[1]) : 0;
          if (t !== null && isFinite(off)) v = kind === "take" ? mmss(t + off) : timerAt(t + off);
        } else if (kind === "length") {
          if (BEAT_INDEX[a[0]]) v = String(Math.trunc(pyRound(BEAT_INDEX[a[0]][2] - BEAT_INDEX[a[0]][1], 0)));
        } else if (kind === "range" || kind === "closest") {
          const d = between(a[0], a[1], a[2]);
          if (d.length) v = kind === "range" ? `${fmt(Math.min(...d), 1)} to ${fmt(Math.max(...d), 1)} m` : f1(Math.min(...d));
        } else if (kind === "dist") {
          const p = xyOf(a[0]), q = xyOf(a[1]);
          if (p && q) v = f1(dist(p, q));
        } else if (kind === "first") {
          const p = PROP_XY[a[0]] || MARK_XY[a[0]], lens = a.slice(1).join(" ");
          if (p) { const t = firstInFrame(p, LENSES[lens] !== undefined ? LENSES[lens] : LENSES[LENS]); v = t !== null ? mmss(t) : "never"; }
        }
        out[name] = v;
      }
      for (const sw of SWAPS) {
        out[sw.code.toLowerCase() + "_win"] = winText(sw.code);
        out[sw.code.toLowerCase() + "_need"] = `${swapNeed(sw)} s`;
      }
      return out;
    })();
    const FILL_KEYS = Object.keys(NUM);
    function fill(text, T) {
      if (!text) return "";
      let out = String(text);
      if (T !== undefined && T !== null && out.includes("{timer}")) out = out.split("{timer}").join(timerAt(T));
      for (const key of FILL_KEYS) out = out.split("{" + key + "}").join(NUM[key]);
      return out;
    }
    const tokenRe = /\{([a-z0-9_]+)\}/g;
    function unknownTokens(text) {
      const out = []; let m;
      const known = new Set(FILL_KEYS.concat(["timer"]));
      const r = new RegExp(tokenRe.source, "g");
      while ((m = r.exec(String(text || "")))) if (!known.has(m[1])) out.push(m[1]);
      return out;
    }
    const fillTx = (key, extra) => {
      let s = tx[key] || "";
      if (extra) for (const k of Object.keys(extra)) s = s.split("{" + k + "}").join(extra[k]);
      s = s.split("{privacy}").join(sStr("privacy", ""));
      return fill(s);
    };

    // ---- cards
    function whenLabel(beat) {
      const [, t0, t1] = BEAT_INDEX[beat];
      if (t1 <= 0 && t0 < 0) return ["before action", ""];
      const timer = t0 < TIMER_START ? "" : timerAt(t0);
      return [`${mmss(Math.max(t0, 0))}-${mmss(t1)}`, timer];
    }
    function cardRows(person) {
      if (!RAW[person]) {
        return CARD_LINES.filter((c) => c[0] === person).map((c) => ["", c[1], "", "", fill(c[2]), fill(c[3]), fill(c[4])]);
      }
      const tr = RAW[person].slice().sort((a, b) => a[0] - b[0]);
      const byBeat = {};
      for (const k of tr) { const b = BEAT_INDEX[k[4]] ? k[4] : beatAt(k[0]); (byBeat[b] = byBeat[b] || []).push(k); }
      const rows = [];
      for (const [b, , , name] of beatTimes) {
        const ks = byBeat[b] || [];
        const acts = ks.filter((k) => k[3]).map((k) => k[3]);
        const watches = ks.map((k) => fill(WATCH[person + "@" + k[0]] || "", k[0])).filter(Boolean);
        if (!acts.length && !watches.length) continue;
        const ms = [];
        for (const k of ks) { const m = markNear(person, k[1]); if (m && (!ms.length || ms[ms.length - 1] !== m)) ms.push(m); }
        const [tstr, timer] = whenLabel(b);
        const where = ms.join(" > ") || (P[person] && P[person].withcam ? (tx.withCamera || "With the camera") : "");
        rows.push([b, name, tstr, timer, where, acts.map((a) => fill(a, null)).join(" "), watches.join(" ")]);
      }
      return rows;
    }
    function cardKey(person, rows) {
      const codes = [];
      for (const r of rows) for (const c of words(MARK_CODE, r[4] + " " + r[5])) if (!codes.includes(c)) codes.push(c);
      if (OFF_PLAN[person]) { const c = OFF_PLAN[person][0]; if (!codes.includes(c)) codes.unshift(c); }
      return codes.filter((c) => LABEL[c] !== undefined).map((c) => `${c} ${LABEL[c]}`).join("; ");
    }
    function dutyKey(person) {
      const p = P[person];
      if (p && p.goesby) return p.goesby;
      return (NAMES[person] || person).toLowerCase().split(" ")[0];
    }
    function duties(person) {
      const key = dutyKey(person), re = new RegExp("\\b" + escRe(key) + "\\b");
      return PART.concat(FULL).filter((r) => { const w = r.who.toLowerCase(); return re.test(w) || w === "everyone"; })
        .map((r) => [r.kind, r.step, r.frm, r.to, fill(r.what), r.when]);
    }
    const forList = (forc) => forc.split(",").map((c) => c.trim());
    function safetyLines(person) {
      return PRESET.filter((r) => r[0] === "Safety" && (r[4] === "Everyone" || forList(r[4]).includes(person)))
        .map((r) => fill(r[1]) + (r[2] ? ` (${fill(r[2])})` : ""));
    }
    function presetLines(person) {
      const first = (NAMES[person] || person).split(" ")[0].toLowerCase();
      const out = [];
      for (const [area, item, how, who, forc] of PRESET) {
        if (area === "Safety") continue;
        const mine = who.trim().toLowerCase() === first && (P[person] ? P[person].named : true);
        if (mine || forList(forc).includes(person)) out.push(`${area}: ${fill(item)}` + (how ? ` (${fill(how)})` : ""));
      }
      return out;
    }

    // ---- inferences (wording from the plan's texts, numbers from the model)
    function inferences() {
      // the notes are the plan's texts whose keys start with "inf", in order; three kinds are worked out from the model
      const out = [];
      const L = LENSES[LENS];
      let swapsDone = false;
      for (const key of rowsOf(plan, "texts").map((r) => r.id).filter((k) => /^inf/.test(k))) {
        if (!tx[key]) continue;
        if (key === "infSeeThrough") {
          const pt = parsePair(set.seeThrough, null);
          if (!pt) continue;
          const [a0, a1] = parseSpan(set.seeThroughSpan, [0, TAKE_END]);
          const rs = thingRuns(pt, L, a0, a1, 0.0).filter((r) => r[1] - r[0] >= 2);
          if (rs.length) out.push([key, fillTx(key, { a: mmss(rs[0][0]), b: mmss(rs[0][1]) })]);
        } else if (/^infSwap/.test(key)) {
          if (swapsDone) continue;
          swapsDone = true;
          for (const sw of SWAPS) {
            const by = WINDOWS[sw.code] || {};
            const t = Object.keys(by).map((lens) => `${lens} ` + (by[lens].map(([a, b]) => `${mmss(a)}-${mmss(b)}`).join(", ") || "none")).join("; ");
            const anyWin = Object.values(by).some((v) => v.length);
            const ex = { name: sw.name, need: String(swapNeed(sw)), handling: String(sw.handling), txt: t };
            if (!MARK_XY[sw.frm] && !sw.way_in.length) out.push([sw.code, fillTx("infSwapNoFrom", ex)]);
            else if (anyWin) out.push([sw.code, fillTx("infSwapWin", ex)]);
            else out.push([sw.code, fillTx("infSwapNone", ex)]);
          }
        } else if (key === "infAway") {
          const thing = PROP_XY[txt(set.awayThing)], [pa, pb] = parseList(set.awayMarks).map((c) => MARK_XY[c]);
          if (!thing || !pa || !pb) continue;
          const spans = [];
          for (const lens of Object.keys(LENSES)) {
            const r = thingRuns(thing, LENSES[lens], TIMER_START, TAKE_END).filter((x) => x[1] - x[0] >= 60);
            if (r.length) spans.push([lens, r[0][0], Math.max(...r.map((x) => x[1])), r]);
          }
          if (!spans.length) continue;
          const a = Math.max(...spans.map((x) => x[1])), b = Math.min(...spans.map((x) => x[2]));
          const gaps = [];
          for (const [lens, , , r] of spans) {
            for (let i = 0; i + 1 < r.length; i++) { const g0 = r[i][1], g1 = r[i + 1][0]; if (a < g0 && g0 < b && g1 - g0 >= 5) gaps.push([lens, g0, g1]); }
          }
          const exc = gaps.length ? (tx.infAwayExc || "; except {list}").split("{list}").join(gaps.map(([lens, g0, g1]) => `${mmss(g0)} to ${mmss(g1)} at ${lens}`).join(", ")) : "";
          out.push([key, fillTx(key, { b: mmss(b), exc, apart: fmt(hypot(pa[0] - pb[0], pa[1] - pb[1]), 1) })]);
        } else if (key !== "infAwayExc") out.push([key, fillTx(key)]);
      }
      return out;
    }

    // ---- checks
    function mismatches() {
      const out = [];
      for (const [person, beats] of SUMMARY) {
        if (!TRACKS[person] || !TRACKS[person].length) continue;
        for (const [beat, t] of beats) {
          if (!BEAT_INDEX[beat]) { out.push([person, beat, "beat not on the Beats tab"]); continue; }
          const [, t0, t1] = BEAT_INDEX[beat];
          const reached = new Set();
          for (let T = t0; T <= t1; T += 0.5) {
            if (present(person, T)) { const m = markNear(person, posAt(TRACKS[person], T), 0.7); if (m) reached.add(m); }
          }
          for (const c of words(MARK_CODE, t.split(":")[0])) if (MARK_XY[c] && !reached.has(c)) out.push([person, beat, `names ${c}, but the moves don't reach it in this beat`]);
        }
      }
      return out;
    }
    const distRect = (x, y, r) => { const [x0, y0, w, h] = r; return hypot(Math.max(x0 - x, 0.0, x - (x0 + w)), Math.max(y0 - y, 0.0, y - (y0 + h))); };
    const fixtureName = new Map();
    for (const f of FIXTURES) fixtureName.set([f.x, f.y, f.w, f.h].join(","), f.label);
    const OB_RECTS = SOLID.map((r) => [r, fixtureName.get(r.join(",")) || "furniture"]);
    const OB_CIRCLES = BISTRO.filter((s) => !s.moved).map((s) => [[s.x, s.y], s.r !== null ? s.r : 0.35, s.kind.charAt(0).toUpperCase() + s.kind.slice(1)]);
    function worst(x, y) {
      let best = [9e9, ""];
      for (const [r, name] of OB_RECTS) { const d = distRect(x, y, r); if (d < best[0]) best = [d, name]; }
      for (const [[cx, cy], rad, name] of OB_CIRCLES) { const d = Math.max(0.0, hypot(x - cx, y - cy) - rad); if (d < best[0]) best = [d, name]; }
      return best;
    }
    function routeClearance() {
      const routes = SWAPS.map((sw) => [`${sw.code} way in`, swapRoute(sw)])
        .concat(PART.concat(FULL).filter((r) => r.route.length > 1).map((r) => [`${r.kind} ${r.step}`, r.route]));
      const out = {};
      for (const [label, pts] of routes) {
        let w = [9e9, ""], wall = false;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1];
          if (BARRIERS.some(([w0, w1]) => segCross(a, b, w0, w1))) wall = true;
          const L = hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.max(1, Math.trunc(L / 0.1));
          for (let j = 0; j <= n; j++) {
            const d = worst(a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n);
            if (d[0] < w[0]) w = d;
          }
        }
        if (w[0] < CLEARANCE - 1e-6 || wall) out[label] = [pyRound(w[0], 2), w[1], wall];
      }
      return out;
    }
    function clearance() {
      const out = {}, step = 0.25, times = timesFrom(-60.0, TAKE_END, step);
      for (const p of onMapOrder) {
        const tr = TRACKS[p];
        const walls = [], close = [];
        let run = null, last = null;
        for (const T of times) {
          if (!present(p, T)) { last = null; continue; }
          const [x, y] = posAt(tr, T);
          if (last !== null && BARRIERS.some(([a, b]) => segCross(last, [x, y], a, b))) walls.push([T, pyRound(x, 2), pyRound(y, 2)]);
          last = [x, y];
          const w = worst(x, y);
          if (w[0] < CLEARANCE - 1e-6) {
            const what = w[1];
            if (run && run[2] === what && T - run[1] <= step + 1e-6) run = [run[0], T, what, Math.min(run[3], w[0])];
            else { if (run) close.push(run); run = [T, T, what, w[0]]; }
          } else if (run) { close.push(run); run = null; }
        }
        if (run) close.push(run);
        if (walls.length || close.length) out[p] = { walls, close: close.map(([a, b, w, d]) => [a, b, w, pyRound(d, 2)]) };
      }
      return out;
    }
    function crowding() {
      const out = [], times = timesFrom(-5.0, TAKE_END, 0.5);
      for (let i = 0; i < onMapOrder.length; i++) {
        for (let j = i + 1; j < onMapOrder.length; j++) {
          const a = onMapOrder[i], b = onMapOrder[j];
          const ok = times.map((T) => {
            if (!(present(a, T) && present(b, T))) return false;
            const pa = posAt(TRACKS[a], T), pb = posAt(TRACKS[b], T);
            return hypot(pa[0] - pb[0], pa[1] - pb[1]) < CROWD;
          });
          const r = runs(times, ok, 0.5);
          if (r.length) out.push([a, b, r]);
        }
      }
      return out;
    }
    function speeds() {
      const out = {}, step = 0.5, times = timesFrom(-5.0, TAKE_END, step);
      for (const p of onMapOrder) {
        let best = 0.0, when = null;
        for (const T of times.slice(1)) {
          const a = posAt(TRACKS[p], T - step), b = posAt(TRACKS[p], T);
          const v = hypot(b[0] - a[0], b[1] - a[1]) / step;
          if (v > best) { best = v; when = T; }
        }
        out[p] = [pyRound(best, 2), when];
      }
      return out;
    }
    function solidHits() {
      const out = {}, times = timesFrom(-5.0, TAKE_END, 0.5);
      for (const p of onMapOrder) {
        const bad = [];
        for (const T of times) {
          const [x, y] = posAt(TRACKS[p], T);
          if (SOLID.some(([x0, y0, w, h]) => x0 + 0.05 < x && x < x0 + w - 0.05 && y0 + 0.05 < y && y < y0 + h - 0.05)) bad.push(T);
        }
        if (bad.length) out[p] = [bad[0], bad[bad.length - 1], bad.length];
      }
      return out;
    }

    // ---- reset routes on the map
    function routeStyle(row) {
      if (["talent", "camera", "crew", "crew2"].includes(row.style)) return row.style;
      const w = row.who.toLowerCase();
      const talentFirst = (NAMES[TALENT] || "").split(" ")[0].toLowerCase();
      if (talentFirst && w.includes(talentFirst)) return "talent";
      if (w.includes("camera")) return "camera";
      return "crew";
    }
    function labelAt(pts, placed) {
      const L = [];
      for (let i = 0; i + 1 < pts.length; i++) L.push(hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
      const half = pySum(L) / 2;
      let acc = 0.0, at = pts[0];
      for (let i = 0; i < L.length; i++) {
        const a = pts[i], b = pts[i + 1], l = L[i];
        if (acc + l >= half && l > 0) { const f = (half - acc) / l; at = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; break; }
        acc += l;
      }
      let x = at[0] + 0.25, y = at[1];
      while (placed.some(([px, py]) => Math.abs(y - py) < 0.42 && Math.abs(x - px) < 3.2)) y += 0.42;
      placed.push([x, y]);
      return [x, y];
    }
    function resetRoutes() {
      const out = {};
      for (const [kind, rows] of [["partial", PART], ["full", FULL]]) {
        const placed = [], items = [];
        for (const r of rows) {
          if (r.route.length < 2) continue;
          let at = labelAt(r.route, placed);
          const anchor = kind === "partial" && at[0] > 3.0 ? "end" : "start";
          if (anchor === "end") at = [at[0] - 0.5, at[1]];
          items.push({ pts: r.route.map(([x, y]) => [pyRound(x, 3), pyRound(y, 3)]), style: routeStyle(r), label: r.label || `${r.step}: ${r.who}`,
            at: [pyRound(at[0], 3), pyRound(at[1], 3)], anchor, id: r.id });
        }
        out[kind] = items;
      }
      const offTxt = tx.resetOff || "";
      out.off = {
        partial: offTxt ? [{ at: parsePair(set.resetOffPartial, [-1.1, -2.95]), label: offTxt }] : [],
        full: offTxt ? [{ at: parsePair(set.resetOffFull, [-2.2, -3.75]), label: offTxt }] : [],
      };
      return out;
    }
    function hotRect() {
      const isl = FIXTURES.find((f) => f.id === txt(set.hotFixture));
      let ys = parseList(set.hotMarks).filter((c) => MARK_XY[c]).map((c) => MARK_XY[c][1]);
      if (!isl || !ys.length) return [0, 0, 0, 0];
      const x1 = isl.x;
      const y0 = Math.min(...ys) - 0.3, y1 = Math.max(...ys) + 0.4;
      return [0.0, pyRound(y0, 2), pyRound(x1, 2), pyRound(y1 - y0, 2)];
    }

    function fitBox() {
      const pts = [].concat(...AREAS.map((a) => a.poly), allMarks.map((m) => [m[2], m[3]]));
      if (!pts.length) return [-1, -1, 12, 12];
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs) - 0.5, y0 = Math.min(...ys) - 0.5;
      return [x0, y0, Math.max(...xs) + 0.5 - x0, Math.max(...ys) + 0.5 - y0];
    }

    // ---- the board's data
    const r3 = (v) => pyRound(Number(v), 3);
    const cardPeople = people.filter((p) => yes(p.card));
    const outPeople = cardPeople.map((p) => {
      const code = p.code, tr = TRACKS[code] || [];
      const rows = cardRows(code);
      const op = OFF_PLAN[code] || ["", ""];
      return {
        code, name: NAMES[code] || code, role: p.role, color: p.color, initials: p.initials, status: p.status,
        onMap: tr.length > 0, joins: tr.length ? pyRound(tr[0][0], 2) : null, place: op[0], placeText: op[1],
        track: tr.map((k) => [pyRound(k[0], 2), r3(k[1][0]), r3(k[1][1]), k[2], k[3], k[4]]),
        card: rows, key: cardKey(code, rows), duties: duties(code), safety: safetyLines(code), preset: presetLines(code),
        tape: p.tape, checked: p.checked, markset: MARKSET[code] || [],
        // for the editor
        id: p.id, keys: KEYS[code] || [], withcam: p.withcam, speed: p.speed, cont: p.cont,
      };
    });
    const swapsOut = SWAPS.map((sw) => ({
      code: sw.code, name: sw.name, if: sw.cond, what: sw.what, who: sw.who, from: sw.frm, route: sw.route, status: sw.status,
      useful: sw.useful.slice(), need: (MARK_XY[sw.frm] || sw.way_in.length) ? swapNeed(sw) : null,
      path: swapRoute(sw).map(([x, y]) => [r3(x), r3(y)]), source: sw.source,
      target: (PROP_XY[sw.target] || sw.access).map(r3), access: [r3(sw.access[0]), r3(sw.access[1])],
      windows: Object.fromEntries(Object.keys(WINDOWS[sw.code] || {}).map((l) => [l, WINDOWS[sw.code][l].map((w) => w.slice())])),
      id: sw.id, way: sw.way_in, handling: sw.handling,
    }));
    const runCols = people.filter((p) => p.runcol).map((p) => [p.code, p.runcol]);
    const data = {
      draft: sStr("draft", ""), version: sStr("version", ""), date: sStr("date", ""), privacy: sStr("privacy", ""),
      timerStart: TIMER_START, timerLen: TIMER_LEN, takeEnd: TAKE_END, cutPoint: CUT_POINT,
      beats: beatTimes.map(([code, t0, t1, name, id]) => ({ code, t0, t1, name, inside: insideSet.has(code), id, pill: pills[code] || "" })),
      runCols,
      run: Object.fromEntries(beatTimes.map(([b]) => [b, Object.fromEntries(runCols.map(([p]) => [p, fill((SUMMARY.get(p) || new Map()).get(b) || "")]))])),
      areas: AREAS.map((a) => ({ id: a.id, label: a.label, poly: a.poly, kind: a.kind, level: a.level, conf: a.conf, note: a.note, style: a.style })),
      outline: OUTLINE,
      features: FEATURES.map((f) => ({ id: f.id, label: f.label, x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, kind: f.kind })),
      fixtures: FIXTURES.map((f) => ({ id: f.id, label: f.label, x: f.x, y: f.y, w: f.w, h: f.h, kind: f.kind })),
      stools: STOOLS, chairs: CHAIRS, bistro: BISTRO.map((s) => [s.x, s.y, s.moved]),
      points: POINTS.map((p) => ({ id: p.id, label: p.label, x: p.x, y: p.y, kind: p.kind })),
      hot: hotRect(),
      marks: allMarks.map((m) => ({ code: m[0], label: m[1], x: m[2], y: m[3], kind: m[4], status: m[5], note: m[6], find: find[m[0]] || "", id: m[7] })),
      offPlan: off.map(([code, label, note, status]) => ({ code, label, note, status })),
      props: props.map((p) => ({ id: p[0], label: p[1], x: p[2], y: p[3], rowId: p[4] })),
      people: outPeople,
      walls: WALLS.map(([a, b]) => [a.slice(), b.slice()]),
      lenses: LENSES, nearEdge: NEAR_EDGE,
      resetPartial: PART.map((r) => [r.kind, r.step, r.who, r.frm, r.to, fill(r.what), r.when, r.status, r.note]),
      resetFull: FULL.map((r) => [r.kind, r.step, r.who, r.frm, r.to, fill(r.what), r.when, r.status, r.note]),
      resetRoutes: resetRoutes(),
      swaps: swapsOut,
      signals: SIGNALS.map((r) => r.slice()),
      preset: PRESET.map((r) => r.slice()),
      takeMin: TAKE_MIN,
      openItems: OPEN.map((r) => r.map((c) => fill(c))),
      runNotes: Object.fromEntries(Object.keys(RUN_NOTES).map((k) => [k, fill(RUN_NOTES[k])])),
      inferences: inferences().map((x) => x[1]),
      numbers: NUM,
      // for the app (not in the Python build)
      ui: {
        title: sStr("title", "Shot plan"), eyebrow: sStr("eyebrow", ""), lens: LENS, talent: TALENT, camera: CAMERA,
        views: { kitchen: parseBox(set.viewKitchen, fitBox()), route: parseBox(set.viewRoute, fitBox()) },
        routeUntil: sNum("routeUntil", -1e9), labels: LABELS, barriers: BARRIERS, measure: MEASURE,
        calc: { now: sStr("calcNow", "13:30"), stop: sStr("calcStop", "15:00"), reset: sNum("calcReset", 10) },
        texts: {
          stamp: fillTx("stamp"), degrees: tx.degrees || "0 = right on the plan, 90 = down, 180 = left, 270 = up.", about: fillTx("about").split("\n").filter(Boolean), runIntro: fillTx("runIntro"), runEnd: fillTx("runEnd"),
          runEndName: tx.runEndName || "End", signalsIntro: fillTx("signalsIntro"), resetPartialName: tx.resetPartialName || "Partial reset",
          resetFullName: tx.resetFullName || "Full reset", resetPartial: fillTx("resetPartial"), resetFull: fillTx("resetFull"),
          calcNote: fillTx("calcNote"), cutFlag: fillTx("cutFlag"), clockTalent: fillTx("clockTalent"), clockOther: fillTx("clockOther"),
          withCamera: tx.withCamera || "With the camera",
        },
      },
    };

    // tokens nobody can fill, in any text the plan holds
    const tokenSections = ["moves", "runsheet", "cards", "swaps", "resets", "preset", "signals", "openitems", "beats", "texts"];
    for (const name of tokenSections) {
      for (const r of rowsOf(plan, name)) {
        for (const [k, v] of Object.entries(r)) {
          const vals = k === "cells" && v && typeof v === "object" ? Object.values(v) : [v];
          for (const val of vals) {
            if (typeof val !== "string" || !val.includes("{")) continue;
            const unknown = unknownTokens(val).filter((t) => !(name === "texts" && ["privacy", "a", "b", "name", "need", "handling", "txt", "exc", "apart", "list"].includes(t)));
            for (const t of unknown) warn(TAB[name] || name, r.id, `${TAB[name] || name}: unknown token '{${t}}' (the Tokens list shows the ones the plan fills)`);
          }
        }
      }
    }
    for (const m of mismatches()) warn("Run sheet", null, `Run sheet ${m[1]} (${m[0]}): ${m[2]}`);

    const checks = {
      sweep: Object.fromEntries(Object.keys(LENSES).map((l) => [l, sweep(LENSES[l], "in")])),
      edge: Object.fromEntries(Object.keys(LENSES).map((l) => [l, sweep(LENSES[l], "edge")])),
      talentOut: Object.fromEntries(Object.keys(LENSES).map((l) => [l, talentOut(LENSES[l])])),
      crowding: crowding(), speeds: speeds(), solid: solidHits(), routes: routeClearance(), clearance: clearance(),
      mismatches: mismatches(),
    };
    const model = { TRACKS, RAW, MARK_XY, PROP_XY, posAt, headingAt, present, beatAt, timerAt, mmss, fill, markNear, LABEL, NAMES };
    return { data, warnings: W, checks, model };
  }

  const api = { derive, pyRound, mmss, parseTime, parsePoints, fmt, txt };
  root.PlanDerive = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
