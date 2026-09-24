import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_CONFIG, SAMPLE_BARCODES, TANK_SLOTS } from "../config";
import { TwinCore } from "../core";
import { EVENT_SEVERITY, EventCode, formatEvent } from "../events";
import { applyHmiCommand, toHmiState } from "../hmi";
import { TankPalette, loadTankColors, saveTankColors } from "../tank-colors";

/** Run the core with the harness feeder (bounded backlog) and collect HMI statuses. */
function run(core: TwinCore, seconds: number, barcode: (i: number) => string, statuses?: Set<string>): void {
  let feed = 0;
  let i = 0;
  for (let k = 0; k < seconds * 10; k++) {
    core.tick(0.1);
    feed += 0.1;
    if (feed >= 3 && core.queuedBarcodes < DEFAULT_CONFIG.maxConcurrentContainers) {
      feed = 0;
      core.enqueueBarcode(barcode(i++));
    }
    if (statuses) for (const c of toHmiState(core).containers) statuses.add(c.status);
  }
}

test("line keeps flowing past the pipelining cap (regression: stalled after 4 containers)", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  run(core, 300, (i) => SAMPLE_BARCODES[i % SAMPLE_BARCODES.length]);
  assert.ok(core.counts.total > 30, `expected > 30 containers in 300 s, got ${core.counts.total}`);
  assert.ok(core.counts.accepted > 20);
});

test("containers visit label, scan, every bay, cap, press, sort sensor, sort diverter, output and reject", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  const statuses = new Set<string>();
  run(core, 120, (i) => SAMPLE_BARCODES[i % SAMPLE_BARCODES.length], statuses);
  for (const s of ["label", "scan", "fill-1", "fill-2", "fill-3", "cap", "press", "qc", "sort", "output", "scan-rejected"]) {
    assert.ok(statuses.has(s), `missing status ${s}; saw ${[...statuses].join(", ")}`);
  }
  assert.ok(!statuses.has("mix"), "the default bottling line has no mixer");
});

test("default line matches the BOM: station order and E-Stops at the panel, line entry and line exit", () => {
  assert.deepEqual(
    DEFAULT_CONFIG.stations.map((s) => s.id),
    ["LABEL", "SCAN", "BAY-1", "BAY-2", "BAY-3", "CAP", "PRESS", "QC", "GATE", "SORT"],
  );
  assert.deepEqual(DEFAULT_CONFIG.safety.eStopButtons.map((b) => b.id), ["PANEL", "ENTRY", "EXIT"]);
  const t = DEFAULT_CONFIG.stationTimesSec;
  for (const [name, sec] of Object.entries(t)) {
    assert.ok(sec < DEFAULT_CONFIG.sensorWaitTimeoutSec, `${name} dwell must be below the service timeout`);
  }
});

test("physical E-Stop at the line entry and at the line exit each stop the line and are named", () => {
  for (const [buttonId, name] of [["ENTRY", "Line entry"], ["EXIT", "Line exit"]]) {
    const core = new TwinCore(DEFAULT_CONFIG);
    run(core, 10, (i) => SAMPLE_BARCODES[i % 4]);
    assert.equal(applyHmiCommand(core, { command: "simPhysicalEStop", buttonId, pressed: true }), null);
    const safety = toHmiState(core).safety!;
    assert.ok(safety.eStopActive && !safety.running, buttonId);
    assert.deepEqual(safety.eStopButtons.filter((b) => b.pressed).map((b) => b.name), [name]);
    assert.ok(core.events.some((e) => e.code === EventCode.PHYSICAL_ESTOP_PRESSED && e.message.includes(name)));
  }
});

test("sort diverter: small bottles go to lane A, large bottles to lane B", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  const lanes = new Map<string, number>();
  const barcodes = ["PT1|T150|60,50,40", "PT1|T300|120,90,90"];
  let feed = 0;
  let i = 0;
  for (let k = 0; k < 1500; k++) {
    core.tick(0.1);
    if ((feed += 0.1) >= 3 && core.queuedBarcodes < 4) {
      feed = 0;
      core.enqueueBarcode(barcodes[i++ % 2]);
    }
    for (const c of toHmiState(core).containers) if (c.status === "output") lanes.set(c.id, c.lane!);
  }
  const snap = core.snapshot();
  assert.deepEqual(snap.sortLanes.map((l) => l.id), ["A", "B"]);
  assert.ok(snap.sortLanes[0].count > 0 && snap.sortLanes[1].count > 0, JSON.stringify(snap.sortLanes));
  assert.equal(snap.sortLanes[0].count + snap.sortLanes[1].count, core.counts.accepted);
  for (const c of core.containers.filter((x) => x.state === "ACCEPTED")) {
    assert.equal(c.lane, c.targetMl <= DEFAULT_CONFIG.sort.smallBottleMaxMl ? 0 : 1, `C-${c.id} total ${c.targetMl}`);
  }
  assert.ok(new Set(lanes.values()).size === 2);
});

test("no scan diverter: a bad barcode rides through unfilled and the reject diverter rejects it", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  core.enqueueBarcode("PT1|T200|200");
  const seen: string[] = [];
  for (let k = 0; k < 600 && core.counts.total === 0; k++) {
    core.tick(0.1);
    const c = toHmiState(core).containers[0];
    if (c && seen[seen.length - 1] !== c.status) seen.push(c.status);
  }
  assert.equal(core.counts.rejected, 1);
  const c = core.containers[0];
  assert.equal(c.state, "REJECTED");
  assert.equal(c.fillMl, 0);
  assert.ok(!c.ops.some((op) => op.tankId !== null || op.stationId === "CAP" || op.stationId === "PRESS"));
  assert.deepEqual(seen, ["label", "scan", "qc", "scan-rejected"]);
  assert.ok(core.simTimeSec > 15, "it travels the belt instead of being diverted at the scanner");
});

test("containers only move forward along the belt, even with an interleaved mix policy", () => {
  assert.equal(DEFAULT_CONFIG.mixPolicy.kind, "interleaved");
  const core = new TwinCore(DEFAULT_CONFIG);
  const order = ["label", "scan", "fill-1", "fill-2", "fill-3", "cap", "press", "qc", "sort", "output"];
  const lastPos = new Map<string, number>();
  let feed = 0;
  for (let k = 0; k < 1200; k++) {
    core.tick(0.1);
    if ((feed += 0.1) >= 3 && core.queuedBarcodes < 4) {
      feed = 0;
      core.enqueueBarcode("PT1|T300|120,90,90|I4");
    }
    for (const c of toHmiState(core).containers) {
      const pos = order.indexOf(c.status);
      if (pos < 0) continue;
      assert.ok(pos >= (lastPos.get(c.id) ?? -1), `${c.id} moved backwards to ${c.status}`);
      lastPos.set(c.id, pos);
    }
  }
  assert.ok(core.counts.accepted > 0);
});

test("digital E-Stop: shuts the line down, needs release + LOCAL reset + start to resume", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  run(core, 30, (i) => SAMPLE_BARCODES[i % 4]);
  assert.equal(applyHmiCommand(core, { command: "eStop" }), null);
  let s = toHmiState(core).safety!;
  assert.ok(s.eStopActive && s.digitalEStop && !s.safetyCircuitOk && !s.running);
  const before = core.counts.total;
  run(core, 20, (i) => SAMPLE_BARCODES[i % 4]);
  assert.equal(core.counts.total, before, "nothing moves while E-Stopped");
  assert.equal(toHmiState(core).oee.availability, 0);

  // While the digital E-Stop is latched nothing else is allowed.
  assert.match(applyHmiCommand(core, { command: "start" })!, /emergency stop is active/);
  assert.match(applyHmiCommand(core, { command: "jogBelt" })!, /emergency stop is active/);

  // Release does not restart; a remote reset is refused by default.
  assert.equal(applyHmiCommand(core, { command: "releaseEStop" }), null);
  s = toHmiState(core).safety!;
  assert.ok(!s.eStopActive && s.resetRequired && !s.running);
  assert.match(applyHmiCommand(core, { command: "reset" })!, /local control panel/);
  assert.match(applyHmiCommand(core, { command: "start" })!, /safety reset required/);

  // Local reset closes the circuit but does not start.
  assert.equal(applyHmiCommand(core, { command: "simLocalButton", button: "reset" }), null);
  s = toHmiState(core).safety!;
  assert.ok(s.safetyCircuitOk && !s.resetRequired && !s.running);
  run(core, 10, (i) => SAMPLE_BARCODES[i % 4]);
  assert.equal(core.counts.total, before, "reset alone never restarts the line");

  assert.equal(applyHmiCommand(core, { command: "start" }), null);
  run(core, 30, (i) => SAMPLE_BARCODES[i % 4]);
  assert.ok(core.counts.total > before);
  assert.ok(core.events.some((e) => e.code === EventCode.DIGITAL_ESTOP));
});

test("physical E-Stop: shuts down physical and digital control; HMI sees which button; reset only after release", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  run(core, 20, (i) => SAMPLE_BARCODES[i % 4]);
  assert.equal(applyHmiCommand(core, { command: "simPhysicalEStop", buttonId: "EXIT", pressed: true }), null);
  let state = toHmiState(core);
  assert.ok(state.safety!.eStopActive && !state.safety!.running && !state.safety!.safetyCircuitOk);
  assert.deepEqual(state.safety!.eStopButtons.filter((b) => b.pressed).map((b) => b.name), ["Line exit"]);
  assert.match(state.lastEvent!.message, /LINE STOPPED|Line stopped|PHYSICAL E-STOP/i);
  assert.ok(state.recentEvents!.some((e) => /PHYSICAL E-STOP pressed at Line exit/.test(e.message) && e.severity === "error"));

  // Digital side is shut down too: every operational command is refused.
  for (const command of ["start", "jogBelt", "firePusher"]) {
    assert.match(applyHmiCommand(core, { command })!, /emergency stop is active/, command);
  }
  assert.match(applyHmiCommand(core, { command: "releaseEStop" })!, /not active/);
  assert.match(applyHmiCommand(core, { command: "simLocalButton", button: "reset" })!, /still pressed/);
  // The digital E-Stop can still be added on top.
  assert.equal(applyHmiCommand(core, { command: "eStop" }), null);

  applyHmiCommand(core, { command: "simPhysicalEStop", buttonId: "EXIT", pressed: false });
  assert.match(applyHmiCommand(core, { command: "simLocalButton", button: "reset" })!, /emergency stop is active/, "digital still latched");
  applyHmiCommand(core, { command: "releaseEStop" });
  assert.equal(applyHmiCommand(core, { command: "simLocalButton", button: "reset" }), null);
  assert.equal(applyHmiCommand(core, { command: "start" }), null);
  state = toHmiState(core);
  assert.ok(state.safety!.running && !state.safety!.eStopActive);
});

test("local control: LOCAL makes the HMI view-only except E-Stop and stop; panel buttons need LOCAL", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  assert.match(applyHmiCommand(core, { command: "simLocalButton", button: "start" })!, /remote control is active/);
  assert.match(applyHmiCommand(core, { command: "simLocalButton", button: "jog" })!, /remote control is active/);

  assert.equal(applyHmiCommand(core, { command: "simControlMode", mode: "local" }), null);
  let s = toHmiState(core).safety!;
  assert.equal(s.controlMode, "local");
  assert.ok(!s.running, "switching mode stops the line");

  for (const command of ["start", "jogBelt", "firePusher", "addTank"]) {
    assert.match(applyHmiCommand(core, { command })!, /local control is active/, command);
  }
  assert.match(applyHmiCommand(core, { command: "removeTank", tankId: "T1" })!, /local control is active/);

  assert.equal(applyHmiCommand(core, { command: "simLocalButton", button: "jog" }), null, "local jog while stopped");
  assert.equal(applyHmiCommand(core, { command: "simLocalButton", button: "start" }), null);
  assert.ok(toHmiState(core).safety!.running);
  assert.match(applyHmiCommand(core, { command: "simLocalButton", button: "jog" })!, /stop the line first/);

  // Stop and digital E-Stop always work from the HMI.
  assert.equal(applyHmiCommand(core, { command: "stop" }), null);
  assert.ok(!toHmiState(core).safety!.running);
  assert.equal(applyHmiCommand(core, { command: "eStop" }), null);
  assert.ok(toHmiState(core).safety!.eStopActive);

  assert.equal(applyHmiCommand(core, { command: "simControlMode", mode: "remote" }), null);
  s = toHmiState(core).safety!;
  assert.equal(s.controlMode, "remote");
  assert.ok(core.events.some((e) => e.code === EventCode.COMMAND_REFUSED));
});

test("remote reset can be enabled by configuration (Remote mode only)", () => {
  const core = new TwinCore({ ...DEFAULT_CONFIG, safety: { ...DEFAULT_CONFIG.safety, remoteResetAllowed: true } });
  applyHmiCommand(core, { command: "eStop" });
  applyHmiCommand(core, { command: "releaseEStop" });
  assert.equal(applyHmiCommand(core, { command: "reset" }), null);
  assert.equal(applyHmiCommand(core, { command: "start" }), null);
  assert.ok(toHmiState(core).safety!.running);
});

test("tank slots keep ids and barcode order; stale queued barcodes are held back", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  for (let i = 0; i < 3; i++) core.enqueueBarcode("PT1|T250|100,80,70");
  core.addTank();
  assert.deepEqual(core.tanks.map((t) => t.id), ["T1", "T2", "T3", "T4"]);
  assert.equal(core.queuedBarcodes, 0);
  const held = core.events.find((e) => e.code === EventCode.STALE_BARCODES_HELD);
  assert.equal(held?.arg1, 3);

  core.removeTank("T2");
  core.addTank(); // re-enables the lowest free slot, in slot order
  assert.deepEqual(core.tanks.map((t) => t.id), ["T1", "T2", "T3", "T4"]);
  assert.equal(core.tanks[1].name, TANK_SLOTS[1].name);
  assert.deepEqual(
    core.config.stations.map((s) => s.id),
    ["LABEL", "SCAN", "BAY-1", "BAY-2", "BAY-3", "BAY-4", "CAP", "PRESS", "QC", "GATE", "SORT"],
  );

  const c0 = core.counts.rejected;
  run(core, 90, () => "PT1|T200|50,50,50,50");
  assert.equal(core.counts.rejected, c0, "valid 4-tank barcodes should not be rejected");
});

test("tank colors: rename/recolor any slot, add a tank with its own color, reset to defaults", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  assert.equal(applyHmiCommand(core, { command: "setTankColor", tankId: "T2", name: " Crimson ", colorCode: "#b00020" }), null);
  assert.deepEqual([core.tanks[1].name, core.tanks[1].colorCode], ["Crimson", "#B00020"]);
  assert.equal(core.config.tanks[1].name, "Crimson");

  // A slot that is not on the line yet can be edited too; enabling it uses the edit.
  assert.equal(applyHmiCommand(core, { command: "setTankColor", tankId: "T5", colorCode: "#00AAFF" }), null);
  assert.equal(applyHmiCommand(core, { command: "addTank", name: "Lemon", colorCode: "#FFF44F" }), null);
  assert.deepEqual([core.tanks[3].id, core.tanks[3].name, core.tanks[3].colorCode], ["T4", "Lemon", "#FFF44F"]);

  const slots = toHmiState(core).tankSlots!;
  assert.equal(slots.length, 8);
  assert.deepEqual(slots.filter((s) => s.enabled).map((s) => s.id), ["T1", "T2", "T3", "T4"]);
  assert.deepEqual(slots.filter((s) => s.custom).map((s) => s.id), ["T2", "T4", "T5"]);
  assert.equal(slots[4].colorCode, "#00AAFF");

  assert.match(applyHmiCommand(core, { command: "setTankColor", tankId: "T2", colorCode: "red" })!, /hex color/);
  assert.match(applyHmiCommand(core, { command: "setTankColor", tankId: "T2", name: "" })!, /empty/);
  assert.match(applyHmiCommand(core, { command: "setTankColor", tankId: "T9", name: "X" })!, /unknown tank/);
  assert.match(applyHmiCommand(core, { command: "addTank", colorCode: "#12345" })!, /hex color/);
  assert.equal(core.tanks.length, 4, "an invalid color does not add a tank");

  assert.equal(applyHmiCommand(core, { command: "resetTankColor", tankId: "T2" }), null);
  assert.equal(core.tanks[1].name, TANK_SLOTS[1].name);
  assert.equal(applyHmiCommand(core, { command: "resetTankColor" }), null);
  assert.ok(toHmiState(core).tankSlots!.every((s) => !s.custom));
  assert.equal(core.tanks[3].colorCode, TANK_SLOTS[3].colorCode);
});

test("tank colors persist through the palette file and are applied on start", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "captsone-")), "tank-colors.json");
  const saving = new TankPalette(loadTankColors(file), (p) => saveTankColors(file, p));
  new TwinCore(DEFAULT_CONFIG, saving).setTankColor("T1", { name: "Snow", colorCode: "#FFFFFF" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { T1: { name: "Snow", colorCode: "#FFFFFF" } });

  const restarted = new TwinCore(DEFAULT_CONFIG, new TankPalette(loadTankColors(file)));
  assert.deepEqual([restarted.tanks[0].name, restarted.tanks[0].colorCode], ["Snow", "#FFFFFF"]);

  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(loadTankColors(file), {}, "a corrupt file falls back to defaults");
});

test("throughput is a rolling rate, not a since-start average", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  run(core, 180, () => "PT1|T250|100,80,70");
  const busy = core.snapshot().throughputCpm;
  assert.ok(busy > 0);
  core.eStop();
  run(core, 90, () => "PT1|T250|100,80,70");
  assert.equal(core.snapshot().throughputCpm, 0, "no accepts in the last window → 0 cpm");
});

test("recentEvents is newest-first and carries structured events", () => {
  const core = new TwinCore(DEFAULT_CONFIG);
  run(core, 20, (i) => SAMPLE_BARCODES[i % 4]);
  const state = toHmiState(core);
  assert.ok(state.recentEvents && state.recentEvents.length > 1);
  assert.equal(state.recentEvents![0].id, state.lastEvent!.id);
  assert.ok(core.events.every((e) => e.code > 0));
});

test("every event code has a severity and operator text", () => {
  for (const value of Object.values(EventCode)) {
    if (typeof value !== "number") continue;
    assert.ok(EVENT_SEVERITY[value as EventCode], `severity for ${value}`);
    assert.ok(!formatEvent(value, 1, 2).startsWith("event "), `text for ${value}`);
  }
});
