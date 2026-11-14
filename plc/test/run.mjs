// Runs the Genesis Micro850 programs (plc/*.st plus Prog1's compiled ladder) on a simulated belt,
// beside twin/src/plc/virtual-plc.ts on its own copy of the same belt, and checks every scenario.
//
//   cd twin && npm ci && npm run build      (once: the virtual PLC and the simulated ESP32 nodes)
//   node plc/test/run.mjs
//
// A scenario passes when, for the Micro850 programs:
//   - every can ended up where the PLC's own counters say (lane 1, lane 2, or pushed off);
//   - no can is in the wrong lane and none is left on the belt;
//   - where the virtual PLC is physically consistent too, every can's fate matches it.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runSt, runVplc } from "./line.mjs";
import { makePlc } from "./plc.mjs";
const require = createRequire(import.meta.url);
const { COIL, SYS } = require(fileURLToPath(new URL("../../twin/dist/plc/tag-map.js", import.meta.url)));

const at = (t, x) => Math.abs(t - x) < 0.005;
const mixed = ["PT1|T200|100,100", "PT1|T260|130,130", "PT1|T200|200", "PT1|T180|90,90", "PT1|T120|0,120", "PT1|T280|140,140", "XX1|T200|100,100", "PT1|T100|100,0", "PT1|T200|100,90"];
const arm = ["PT1|T200|100,100", "PT1|T260|130,130", "PT1|T180|90,90", "PT1|T120|0,120", "PT1|T280|140,140~wrongbottle", "PT1|T100|100,0"];
const labelsOf = (pool, n) => Array.from({ length: n }, (_, i) => pool[i % pool.length]);
const localReset = (t0) => (t, p) => { if (at(t, t0)) p.s("_IO_EM_DI_06", true); if (at(t, t0 + 0.5)) p.s("_IO_EM_DI_06", false); };
const once = (from, cmd, result) => () => { let done = false; return (t, r) => { if (!done && t >= from && r[423] === cmd && r[424] !== r[425]) { r[426] = result; r[425] = r[424]; done = true; } }; };
const window = (from, to, cmd, result) => () => (t, r) => { if (t >= from && t < to && r[423] === cmd && r[424] !== r[425]) { r[426] = result; r[425] = r[424]; } };

const SCENARIOS = [
  { name: "mixed labels", labels: labelsOf(mixed, 40) },
  { name: "stop 60 s, start 70 s", labels: labelsOf(mixed, 40),
    st: (t, p) => { if (at(t, 60)) p.g("MB_CMD")[5] = true; if (at(t, 70)) p.g("MB_CMD")[4] = true; },
    v: (t, v) => { if (at(t, 60)) v.server.coils[COIL.CMD_STOP] = 1; if (at(t, 70)) v.server.coils[COIL.CMD_START] = 1; } },
  { name: "digital E-Stop, release, local reset, start", labels: labelsOf(mixed, 40),
    st: (t, p) => { if (at(t, 80)) p.g("MB_CMD")[0] = true; if (at(t, 85)) p.g("MB_CMD")[1] = true; localReset(87)(t, p); if (at(t, 90)) p.g("MB_CMD")[4] = true; },
    v: (t, v) => { if (at(t, 80)) v.server.coils[COIL.CMD_DIGITAL_ESTOP] = 1; if (at(t, 85)) v.server.coils[COIL.CMD_RELEASE_ESTOP] = 1; if (at(t, 87)) v.server.coils[COIL.SIM_LOCAL_RESET] = 1; if (at(t, 90)) v.server.coils[COIL.CMD_START] = 1; } },
  { name: "station node silent 6 s, reset, start", labels: labelsOf(mixed, 40),
    st: (t, p) => { localReset(70)(t, p); if (at(t, 72)) p.g("MB_CMD")[4] = true; },
    v: (t, v) => { if (at(t, 70)) v.server.coils[COIL.SIM_LOCAL_RESET] = 1; if (at(t, 72)) v.server.coils[COIL.CMD_START] = 1; },
    nodeHook: (t, who) => !(who === "station" && t >= 60 && t < 66) },
  { name: "fire pusher every 7 s", labels: labelsOf(mixed, 40), twinGhosts: true,
    st: (t, p) => { if (t > 20 && t % 7 < 0.005) p.g("MB_CMD")[3] = true; },
    v: (t, v) => { if (t > 20 && t % 7 < 0.005) v.server.coils[COIL.CMD_FIRE_PUSHER] = 1; } },
  { name: "tank 2 disabled 50-100 s", labels: labelsOf(mixed, 40), twinGhosts: true,
    st: (t, p) => { if (at(t, 50)) p.g("MB_SYS")[4] = 1; if (at(t, 100)) p.g("MB_SYS")[4] = 3; },
    v: (t, v) => { for (const [t0, m] of [[50, 1], [100, 3]]) if (at(t, t0)) { v.server.registers[SYS.TANK_ENABLE_MASK] = m; v.applyTankMask(m); } } },
  { name: "wrong bottle at QC", labels: labelsOf(arm, 30), twinGhosts: true },
  { name: "PICK_LID NO_LID once", labels: labelsOf(arm, 30), twinGhosts: true, regHook: once(40, 2, 2) },
  { name: "PICK_LID NO_LID 20 s → fault, reset, start", labels: labelsOf(arm, 30), twinGhosts: true, regHook: window(40, 60, 2, 2),
    st: (t, p) => { localReset(70)(t, p); if (at(t, 72)) p.g("MB_CMD")[4] = true; },
    v: (t, v) => { if (at(t, 70)) v.server.coils[COIL.SIM_LOCAL_RESET] = 1; if (at(t, 72)) v.server.coils[COIL.CMD_START] = 1; } },
  { name: "PLACE_LID LID_LOST → reject + fault, reset, start", labels: labelsOf(arm, 30), twinGhosts: true, regHook: once(50, 3, 3),
    st: (t, p) => { localReset(80)(t, p); if (at(t, 82)) p.g("MB_CMD")[4] = true; },
    v: (t, v) => { if (at(t, 80)) v.server.coils[COIL.SIM_LOCAL_RESET] = 1; if (at(t, 82)) v.server.coils[COIL.CMD_START] = 1; } },
];

const truthLane = (label) => { const m = /\|T(\d+)\|/.exec(label); const lane = m && +m[1] > 250 ? 1 : 0; return label.endsWith("~wrongbottle") ? 1 - lane : lane; };
const physical = (f) => ({ laneA: f.filter((x) => x === "lane1").length, laneB: f.filter((x) => x === "lane2").length, removed: f.filter((x) => x === "qr-ejected" || x === "pushed").length });
const consistent = (r) => { const ph = physical(r.fates); return ph.laneA === r.counts.laneA && ph.laneB === r.counts.laneB && ph.removed === r.counts.rejected; };

function checkBench() {
  const p = makePlc();
  const fail = (m) => { console.log("FAIL  sim inputs, refill coils, valve scale\n      " + m); process.exit(1); };
  p.s("_IO_EM_DI_05", true);
  p.scan(0);
  p.s("SimInputs", true);
  p.s("_IO_EM_DI_00", false);
  p.scan(10);
  if (p.g("SafetyOK") || p.g("Running")) fail("safety closed before a simulated reset");
  p.g("MB_CMD")[10] = true;
  p.s("_IO_EM_DI_00", false);
  p.scan(20);
  if (!p.g("SafetyOK") || p.g("_IO_EM_DO_00")) fail("simulated reset did not close the circuit with the safety output held off");
  p.g("MB_CMD")[4] = true;
  p.s("_IO_EM_DI_00", false);
  p.scan(30);
  if (!p.g("Running") || p.g("_IO_EM_DO_01")) fail("line did not run with the belt output held off");
  p.g("TankLevelMl_x10")[1] = 1000;
  p.g("MB_CMD")[12] = true;
  p.scan(40);
  if (p.g("TankLevelMl_x10")[1] !== 50000 || p.g("MB_CMD")[12]) fail("coil 12 did not refill tank 1");
  p.s("SimInputs", false);
  p.s("_IO_EM_DI_00", true);
  p.s("_IO_EM_DI_05", true);
  p.s("AoFullScale", 1000);
  const cont = (n) => p.g(n);
  cont("ContState")[0] = 1; cont("ContSt")[0] = 2; cont("ContVol1")[0] = 100; cont("ContTimerDs")[0] = 0; cont("ContId")[0] = 1;
  cont("TankEnabled")[1] = true;
  p.scan(50);
  if (p.g("_IO_P2_AO_00") !== 800 || p.g("_IO_P2_AO_01") !== 0) fail(`slot 2 angles ${_IO(p)} with AoFullScale 1000`);
  if (p.g("_IO_P3_AO_00") !== 0 || p.g("_IO_P3_AO_01") !== 0) fail("slot 3 was not held at 0");
  p.s("AoFullScale", 0);
  p.scan(60);
  if (p.g("_IO_P2_AO_00") !== 0) fail("AoFullScale 0 did not close the valve");
  console.log("PASS  sim inputs, refill coils, valve scale");
}
const _IO = (p) => `${p.g("_IO_P2_AO_00")}/${p.g("_IO_P2_AO_01")}`;
checkBench();

let failed = 0;
for (const sc of SCENARIOS) {
  const opts = (script) => ({ seconds: 330, script: script ?? (() => {}), nodeHook: sc.nodeHook ?? null, regHook: sc.regHook ? sc.regHook() : null });
  const v = runVplc(sc.labels, opts(sc.v));
  const s = runSt(sc.labels, opts(sc.st));
  const wrongLane = s.fates.filter((f, i) => (f === "lane1" && truthLane(sc.labels[i]) !== 0) || (f === "lane2" && truthLane(sc.labels[i]) !== 1)).length;
  const unfinished = sc.labels.length - s.fates.filter(Boolean).length;
  const fateDiff = sc.labels.filter((_, i) => v.fates[i] !== s.fates[i]).length;
  const problems = [];
  if (!consistent(s)) problems.push(`counters ${JSON.stringify(s.counts)} vs belt ${JSON.stringify(physical(s.fates))}`);
  if (wrongLane) problems.push(`${wrongLane} can(s) in the wrong lane`);
  if (unfinished) problems.push(`${unfinished} can(s) left on the belt`);
  if (!sc.twinGhosts && consistent(v) && fateDiff) problems.push(`${fateDiff} can(s) end differently from the virtual PLC`);
  const twin = consistent(v) ? "twin consistent" : "twin loses track of cans (expected, see programs.md)";
  console.log(`${problems.length ? "FAIL" : "PASS"}  ${sc.name}  ${JSON.stringify(s.counts)}  [${twin}]${problems.length ? "\n      " + problems.join("\n      ") : ""}`);
  if (problems.length) failed++;
}
console.log(failed ? `\n${failed} scenario(s) failed` : "\nall scenarios passed");
process.exit(failed ? 1 : 0);
