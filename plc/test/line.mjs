import { createRequire } from "node:module";
import { makePlc } from "./plc.mjs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const DIST = fileURLToPath(new URL("../../twin/dist/", import.meta.url));
const { VirtualPlc } = require(DIST + "plc/virtual-plc.js");
const { SimulatedScannerNode, SimulatedStationNode } = require(DIST + "plc/simulated-nodes.js");
const { DEFAULT_CONFIG } = require(DIST + "config.js");
const { PLANT, COIL } = require(DIST + "plc/tag-map.js");

const POS = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
const EYE = 0.03, GAP = 0.12, SPEED = 0.2;

/** A conveyor with stoppers, eyes, the QR ejector, the fill-reject pusher and the sort diverter. */
export class Belt {
  constructor(labels, periodSec) { this.labels = labels; this.period = periodSec; this.cans = []; this.next = 0; this.spawnT = 0; this.fates = []; this.idToCan = new Map(); }
  present(i) { return this.cans.some((c) => Math.abs(c.x - POS[i]) <= EYE); }
  at(i) { return this.cans.find((c) => Math.abs(c.x - POS[i]) <= EYE); }
  step(dt, out) {
    this.spawnT += dt;
    if (this.spawnT >= this.period && this.next < this.labels.length && !this.cans.some((c) => c.x < -0.2)) {
      this.spawnT = 0;
      let label = this.labels[this.next];
      const wrong = label.endsWith("~wrongbottle");
      label = label.replace("~wrongbottle", "");
      const m = /\|T(\d+)\|/.exec(label);
      const lane = m && +m[1] > 250 ? 1 : 0;
      this.cans.push({ n: this.next++, x: -0.45, label, lane: wrong ? 1 - lane : lane, laneB: null });
    }
    // a cylinder stroke pushes the can in front of it once, on the rising edge
    if (out.qr && !this.qrPrev) { const c = this.at(0); if (c) this.finish(c, "qr-ejected"); }
    if (out.reject && !this.rejPrev) { const c = this.at(6); if (c) this.finish(c, "pushed"); }
    this.qrPrev = out.qr; this.rejPrev = out.reject;
    if (out.belt) {
      const sorted = [...this.cans].sort((a, b) => b.x - a.x);
      let ahead = Infinity;
      for (const c of sorted) {
        let nx = c.x + SPEED * dt;
        for (let i = 0; i < 7; i++) if (!out.stopper[i] && c.x <= POS[i] && nx > POS[i]) nx = POS[i];   // extended stopper holds at the eye
        nx = Math.min(nx, ahead - GAP);
        if (nx > c.x) c.x = nx;
        if (c.laneB === null && c.x >= POS[7]) c.laneB = out.laneB;
        ahead = c.x;
      }
    }
    for (const c of [...this.cans]) if (c.x > POS[7] + 0.3) this.finish(c, c.laneB ? "lane2" : "lane1");
  }
  finish(c, fate) { this.cans.splice(this.cans.indexOf(c), 1); this.fates[c.n] = fate; }
  /** Bind the container id the controller requested a scan for to the can on the SCAN eye. */
  bind(id) { const c = this.at(0); if (c && id && !this.idToCan.has(id)) this.idToCan.set(id, c); }
  find(id) { const c = this.idToCan.get(id); return c ? { labelText: c.label, lane: c.lane } : undefined; }
}

export function runSt(labels, { seconds = 400, period = 4, script = () => {}, nodeHook = null, regHook = null } = {}) {
  const p = makePlc();
  const belt = new Belt(labels, period);
  const MB = { 300: "MB_SCAN", 400: "MB_FIELD", 420: "MB_STATION", 0: "MB_SYS" };
  const base = (a) => (a >= 420 ? 420 : a >= 400 ? 400 : a >= 300 ? 300 : 0);
  const r = new Proxy({}, {
    get: (_, k) => { const a = +k; return p.g(MB[base(a)])[a - base(a)]; },
    set: (_, k, v) => { const a = +k; p.g(MB[base(a)])[a - base(a)] = v; return true; },
  });
  const scanner = new SimulatedScannerNode(DEFAULT_CONFIG), station = new SimulatedStationNode(DEFAULT_CONFIG);
  for (const [n, v] of [["_IO_EM_DI_00", true], ["_IO_EM_DI_01", true], ["_IO_EM_DI_02", true], ["_IO_EM_DI_05", true]]) p.s(n, v);
  const dt = 0.01;
  const events = []; let lastSeq = 0; let relay = true; let prevReset = false;
  for (let k = 0; k * dt < seconds; k++) {
    const t = k * dt;
    if (k === 50) p.g("MB_CMD")[4] = true;
    script(t, p, belt);
    // safety relay: opens when O_Safety_RemoteEStopOK drops, closes on the local RESET button
    const resetBtn = p.g("_IO_EM_DI_06");
    if (!p.g("_IO_EM_DO_00") && k > 2) relay = false;
    if (resetBtn && !prevReset && p.g("_IO_EM_DO_00")) relay = true;
    prevReset = resetBtn;
    p.s("_IO_EM_DI_00", relay);
    if (k % 10 === 0) {
      belt.bind(r[300]);
      if (regHook) regHook(t, r);
      if (!nodeHook || nodeHook(t, "scanner")) scanner.step(r, 0.1, (id) => belt.find(id));
      if (!nodeHook || nodeHook(t, "station")) station.step(r, 0.1, (id) => belt.find(id));
    }
    for (let i = 0; i < 7; i++) p.s(`_IO_EM_DI_${String(7 + i).padStart(2, "0")}`, belt.present(i));
    p.s("X1_DI_00", belt.present(7));
    p.scan(Math.round(t * 1000));
    const ev = p.g("MB_EVENT");
    if (ev[0] !== lastSeq) {
      const n = (ev[0] - lastSeq + 65535) % 65535;
      if (n > 8) throw new Error("event ring overran between scans");
      for (let i = n - 1; i >= 0; i--) events.push({ t, code: ev[1 + 4 * i + 1], a1: ev[1 + 4 * i + 2], a2: ev[1 + 4 * i + 3] });
      lastSeq = ev[0];
    }
    const stop = [0, 1, 2, 3, 4, 5, 6].map((i) => p.g(`X2_DO_0${i}`));
    belt.step(dt, { belt: p.g("_IO_EM_DO_01"), stopper: stop, qr: p.g("_IO_EM_DO_04"), reject: p.g("_IO_EM_DO_06"), laneB: p.g("_IO_EM_DO_07") });
  }
  const sys = p.g("MB_SYS");
  return { fates: belt.fates, counts: { accepted: sys[5], rejected: sys[6], total: sys[7], laneA: sys[17], laneB: sys[18] }, p, belt, events };
}

export function runVplc(labels, { seconds = 400, period = 4, script = () => {}, nodeHook = null, regHook = null } = {}) {
  const plc = new VirtualPlc({ feed: true, externalNodes: { scanner: true, station: true } });
  plc.__events = [];
  const rec = plc.core.recordEvent.bind(plc.core);
  plc.core.recordEvent = (msg, sev, code, a1 = 0, a2 = 0) => { plc.__events.push({ t: plc.core.simTimeSec, code, a1, a2, msg }); rec(msg, sev, code, a1, a2); };
  const R = plc.server.registers;
  R[PLANT.MODE] = 1;
  const belt = new Belt(labels, period);
  const scanner = new SimulatedScannerNode(DEFAULT_CONFIG), station = new SimulatedStationNode(DEFAULT_CONFIG);
  const dt = 0.01;
  for (let k = 0; k * dt < seconds; k++) {
    const t = k * dt;
    script(t, plc, belt);
    for (let i = 0; i < 8; i++) R[PLANT.INPUT_BASE + i] = belt.present(i) ? 1 : 0;
    if (k % 10 === 0) {
      belt.bind(R[300]);
      if (regHook) regHook(t, R);
      if (!nodeHook || nodeHook(t, "scanner")) scanner.step(R, 0.1, (id) => belt.find(id));
      if (!nodeHook || nodeHook(t, "station")) station.step(R, 0.1, (id) => belt.find(id));
      plc.scan(0.1);
    }
    const stop = [0, 1, 2, 3, 4, 5, 6].map((i) => R[PLANT.STOPPER_BASE + i] === 1);
    belt.step(dt, { belt: R[PLANT.BELT_RUN] === 1, stopper: stop, qr: R[PLANT.QR_REJECT_EXTEND] === 1, reject: R[PLANT.REJECT_DIVERTER_EXTEND] === 1, laneB: R[PLANT.SORT_DIVERTER_LANE_B] === 1 });
  }
  const c = plc.core.counts;
  const events = plc.core.events.length ? [] : [];
  return { events: plc.__events, fates: belt.fates, counts: { accepted: c.accepted, rejected: c.rejected, total: c.total, laneA: plc.core.laneCounts[0], laneB: plc.core.laneCounts[1] }, plc, belt };
}
