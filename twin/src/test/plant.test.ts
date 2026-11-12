import { test } from "node:test";
import * as assert from "node:assert/strict";

import { VirtualPlc } from "../plc/virtual-plc";
import { PLANT, PLANT_SENSOR_STATIONS, PLANT_STOPPER_STATIONS } from "../plc/tag-map";
import { DEFAULT_CONFIG } from "../config";

/**
 * A toy 3D plant in place of ProtoTwin: cans ride a belt, stoppers catch them,
 * sensors see them, pushers remove them. It only talks through the PLANT
 * registers, exactly as ProtoTwin Connect would over Modbus TCP.
 */
class ToyPlant {
  cans: number[] = [];
  removed = 0;
  private loadTimer = 0;
  private readonly pos = new Map(DEFAULT_CONFIG.stations.map((s) => [s.id, s.positionM]));
  constructor(private readonly r: Uint16Array) {}

  step(dt: number): void {
    const r = this.r;
    const run = r[PLANT.BELT_RUN] === 1;
    // Load a can upstream of SCAN every 4 s when the entry is clear.
    this.loadTimer += dt;
    if (this.loadTimer >= 4 && !this.cans.some((x) => x < 0.2)) {
      this.cans.push(-0.3);
      this.loadTimer = 0;
    }
    this.cans.sort((a, b) => b - a);
    if (run) {
      for (let i = 0; i < this.cans.length; i++) {
        let next = this.cans[i] + DEFAULT_CONFIG.beltSpeedMPerSec * dt;
        PLANT_STOPPER_STATIONS.forEach((st, k) => {
          const p = this.pos.get(st)!;
          if (r[PLANT.STOPPER_BASE + k] === 0 && this.cans[i] <= p && next > p) next = p;
        });
        if (i > 0) next = Math.min(next, this.cans[i - 1] - 0.12);
        this.cans[i] = Math.max(this.cans[i], next);
      }
    }
    const near = (st: string) => this.cans.findIndex((x) => Math.abs(x - this.pos.get(st)!) < 0.03);
    if (r[PLANT.QR_REJECT_EXTEND] && near("SCAN") >= 0) { this.cans.splice(near("SCAN"), 1); this.removed++; }
    if (r[PLANT.REJECT_DIVERTER_EXTEND] && near("GATE") >= 0) { this.cans.splice(near("GATE"), 1); this.removed++; }
    this.cans = this.cans.filter((x) => x < 3.7);
    PLANT_SENSOR_STATIONS.forEach((st, k) => (r[PLANT.INPUT_BASE + k] = near(st) >= 0 ? 1 : 0));
  }
}

test("plant mode: a physics plant drives the sensors and the line runs cans end to end", () => {
  const plc = new VirtualPlc({ feed: true });
  const r = plc.server.registers;
  r[PLANT.MODE] = 1;
  const plant = new ToyPlant(r);
  const seen = { valve1: false, valve2: false, press: false, laneB: false };
  for (let i = 0; i < 1800; i++) {
    plant.step(0.1);
    plc.scan(0.1);
    seen.valve1 ||= r[PLANT.VALVE_T1_OPEN] === 1;
    seen.valve2 ||= r[PLANT.VALVE_T2_OPEN] === 1;
    seen.press ||= r[PLANT.LID_PRESS_EXTEND] === 1;
    seen.laneB ||= r[PLANT.SORT_DIVERTER_LANE_B] === 1;
  }
  const jammed = plc.core.containers.filter((c) => c.state === "JAMMED");
  assert.equal(jammed.length, 0, jammed.map((c) => c.jamReason).join("; "));
  assert.ok(plc.core.counts.accepted >= 5, `accepted ${plc.core.counts.accepted}`);
  assert.deepEqual(seen, { valve1: true, valve2: true, press: true, laneB: true });
  assert.equal(r[PLANT.STACK_GREEN], 1);
});

test("plant mode: a can that never reaches a sensor jams instead of arriving on the timer", () => {
  const plc = new VirtualPlc({ feed: false });
  const r = plc.server.registers;
  r[PLANT.MODE] = 1;
  r[PLANT.SENSOR_MASK] = 0b11; // plant models SCAN and BAY-1 only
  plc.core.enqueueBarcode("PT1|T200|100,100");
  r[PLANT.INPUT_BASE] = 1; // can at SCAN
  for (let i = 0; i < 20; i++) plc.scan(0.1);
  r[PLANT.INPUT_BASE] = 0;
  for (let i = 0; i < 300; i++) plc.scan(0.1); // BAY-1 sensor never fires
  const c = plc.core.containers[0];
  assert.equal(c.state, "JAMMED");
  assert.match(c.jamReason ?? "", /BAY-1/);
});

test("plant mode off: the register block is still published and the timers run the line", () => {
  const plc = new VirtualPlc({ feed: true });
  for (let i = 0; i < 400; i++) plc.scan(0.1);
  assert.equal(plc.server.registers[PLANT.BELT_RUN], 1);
  assert.ok(plc.core.counts.accepted > 0);
});
