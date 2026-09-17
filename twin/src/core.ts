/**
 * Captsone twin core — the framework-agnostic simulation engine.
 *
 * Pure TypeScript, no `prototwin` dependency. Owns the container state machine,
 * station routing, pipelining, tank levels + auto-refill, jam/timeout handling,
 * OEE + throughput accounting, and the JSON snapshot builder. The prototwin
 * `PaintLineController` wraps this same control model in the simulator's
 * Component/Handle/Wait API; the Node harness (`run.ts`) drives it directly so
 * the twin is runnable here without the simulator.
 */

import type { TwinConfig, TankConfig } from "./config";
import { parseBarcode, BarcodeError, type ParsedBarcode } from "./barcode";
import { buildDispensePlan, type DispensePlan } from "./recipe";

export type ContainerStatus =
  | "ENTERING"
  | "MOVING"
  | "SERVING"
  | "BLOCKED"
  | "ACCEPTED"
  | "REJECTED"
  | "JAMMED";

export interface TankRuntime extends TankConfig {
  levelMl: number;
  refilling: boolean;
  refillTimerSec: number;
}

export interface Op {
  stationId: string;
  tankIndex: number; // -1 for non-dispense ops
  durationSec: number;
  volumeMl: number;
}

export interface Container {
  id: number;
  barcodeRaw: string;
  parsed: ParsedBarcode | null;
  plan: DispensePlan | null;
  parseError: string | null;
  ops: Op[];
  opIndex: number;
  state: ContainerStatus;
  timeInOpSec: number;
  transitTimerSec: number;
  deadlineSec: number;
  fillMl: number;
  targetMl: number;
  occupyingStationId: string | null;
  jamReason: string | null;
}

export interface SnapshotTank {
  id: string;
  name: string;
  colorCode: string;
  levelMl: number;
  capacityMl: number;
}

export interface SnapshotContainer {
  id: number;
  status: ContainerStatus;
  fillMl: number;
  targetMl: number;
}

export interface Snapshot {
  tanks: SnapshotTank[];
  containers: SnapshotContainer[];
  counts: { accepted: number; rejected: number; total: number };
  throughputCpm: number;
  oee: { availability: number; performance: number; quality: number; overall: number };
  lastEvent: string;
  timestamp: number;
}

export class TwinCore {
  readonly config: TwinConfig;
  readonly tanks: TankRuntime[];
  containers: Container[] = [];
  private nextContainerId = 1;
  private spawnTimerSec = 0;
  readonly counts = { accepted: 0, rejected: 0, total: 0 };
  private lineBlockedSec = 0;
  private lastEvent = "init";
  simTimeSec = 0;
  private occupancy = new Map<string, number>();
  private barcodeQueue: string[] = [];
  private readonly idealCycleSec: number;

  constructor(config: TwinConfig) {
    this.config = config;
    this.tanks = config.tanks.map((t) => ({
      ...t,
      levelMl: t.capacityMl,
      refilling: false,
      refillTimerSec: 0,
    }));
    const avgDispense =
      config.tanks.reduce((a, t) => a + (t.capacityMl * 0.05) / t.dispenseRateMlPerSec, 0) /
      Math.max(1, config.tanks.length);
    const transit = config.stationSpacingM / config.beltSpeedMPerSec;
    this.idealCycleSec = 0.5 + avgDispense + 0.4 + 0.3 + transit * (config.stations.length - 1);
  }

  enqueueBarcode(barcode: string): void {
    this.barcodeQueue.push(barcode);
    this.recordEvent(`barcode queued: ${barcode}`);
  }

  tick(dt: number): void {
    this.simTimeSec += dt;

    for (const tank of this.tanks) {
      if (tank.refilling) {
        tank.refillTimerSec -= dt;
        if (tank.refillTimerSec <= 0) {
          tank.levelMl = Math.min(tank.capacityMl, tank.levelMl + this.config.refillAmountMl);
          tank.refilling = false;
          this.recordEvent(`tank ${tank.id} refilled to ${Math.round(tank.levelMl)} ml`);
        }
      }
    }

    this.spawnTimerSec -= dt;
    if (
      this.barcodeQueue.length > 0 &&
      this.containers.length < this.config.maxConcurrentContainers &&
      !this.occupancy.has("SCAN") &&
      this.spawnTimerSec <= 0
    ) {
      this.spawnContainer(this.barcodeQueue.shift()!);
      this.spawnTimerSec = 0.4;
    }

    let lineWasBlocked = false;
    for (const c of this.containers) {
      if (c.state === "ACCEPTED" || c.state === "REJECTED" || c.state === "JAMMED") continue;
      this.progressContainer(c, dt);
      if (c.state === "BLOCKED") lineWasBlocked = true;
    }
    if (lineWasBlocked) this.lineBlockedSec += dt;

    // Trim retained history.
    if (this.containers.length > 60) {
      const live = this.containers.filter(
        (c) => c.state !== "ACCEPTED" && c.state !== "REJECTED" && c.state !== "JAMMED",
      );
      const done = this.containers
        .filter(
          (c) => c.state === "ACCEPTED" || c.state === "REJECTED" || c.state === "JAMMED",
        )
        .slice(-10);
      this.containers = live.concat(done);
    }
  }

  private spawnContainer(barcodeRaw: string): void {
    const id = this.nextContainerId++;
    let parsed: ParsedBarcode | null = null;
    let plan: DispensePlan | null = null;
    let parseError: string | null = null;
    try {
      parsed = parseBarcode(barcodeRaw, this.config);
      plan = buildDispensePlan(parsed, this.config.mixPolicy);
    } catch (e) {
      parseError = e instanceof BarcodeError ? `${e.code}: ${e.message}` : String(e);
    }

    const ops: Op[] = [];
    if (parsed && plan) {
      ops.push({ stationId: "SCAN", tankIndex: -1, durationSec: 0.5, volumeMl: 0 });
      for (const step of plan.steps) {
        const tank = this.config.tanks[step.tankIndex];
        const stationId = this.dispenseStationFor(step.tankIndex);
        const dur = step.volumeMl / tank.dispenseRateMlPerSec + 0.2;
        ops.push({ stationId, tankIndex: step.tankIndex, durationSec: dur, volumeMl: step.volumeMl });
      }
      ops.push({ stationId: "QC", tankIndex: -1, durationSec: 0.4, volumeMl: 0 });
      ops.push({ stationId: "GATE", tankIndex: -1, durationSec: 0.3, volumeMl: 0 });
    } else {
      ops.push({ stationId: "SCAN", tankIndex: -1, durationSec: 0.5, volumeMl: 0 });
      ops.push({ stationId: "GATE", tankIndex: -1, durationSec: 0.3, volumeMl: 0 });
    }

    const c: Container = {
      id,
      barcodeRaw,
      parsed,
      plan,
      parseError,
      ops,
      opIndex: 0,
      state: "ENTERING",
      timeInOpSec: 0,
      transitTimerSec: 0,
      deadlineSec: 0,
      fillMl: 0,
      targetMl: parsed ? parsed.totalMl : 0,
      occupyingStationId: null,
      jamReason: null,
    };
    this.containers.push(c);
    this.recordEvent(`container ${id} entered (barcode ${barcodeRaw})`);
    if (parseError) this.recordEvent(`container ${id} barcode rejected: ${parseError}`);
  }

  private dispenseStationFor(tankIndex: number): string {
    const bays = this.config.stations.filter((s) => s.id.startsWith("BAY-"));
    const bay = bays[tankIndex] ?? bays[bays.length - 1];
    return bay ? bay.id : "QC";
  }

  private progressContainer(c: Container, dt: number): void {
    if (c.opIndex >= c.ops.length) return;
    const op = c.ops[c.opIndex];

    if (c.state === "ENTERING") {
      if (this.occupancy.has(op.stationId)) {
        c.state = "BLOCKED";
        c.deadlineSec = this.config.sensorWaitTimeoutSec;
        return;
      }
      this.acquire(c, op.stationId);
      c.state = "SERVING";
      c.timeInOpSec = 0;
      c.deadlineSec = this.config.sensorWaitTimeoutSec;
      return;
    }

    if (c.state === "MOVING") {
      c.transitTimerSec -= dt;
      if (c.transitTimerSec <= 0) {
        if (this.occupancy.has(op.stationId)) {
          c.state = "BLOCKED";
          c.deadlineSec = this.config.sensorWaitTimeoutSec;
        } else {
          this.acquire(c, op.stationId);
          c.state = "SERVING";
          c.timeInOpSec = 0;
          c.deadlineSec = this.config.sensorWaitTimeoutSec;
        }
      }
      return;
    }

    if (c.state === "BLOCKED") {
      c.deadlineSec -= dt;
      if (c.deadlineSec <= 0) {
        this.forceReject(c, `jam at ${op.stationId} (wait timeout)`);
        return;
      }
      if (!this.occupancy.has(op.stationId)) {
        this.acquire(c, op.stationId);
        c.state = "SERVING";
        c.timeInOpSec = 0;
        c.deadlineSec = this.config.sensorWaitTimeoutSec;
      }
      return;
    }

    if (c.state === "SERVING") {
      c.timeInOpSec += dt;
      c.deadlineSec -= dt;
      if (c.deadlineSec <= 0 && op.stationId !== "GATE") {
        this.forceReject(c, `service timeout at ${op.stationId}`);
        return;
      }
      if (c.timeInOpSec >= op.durationSec) {
        if (op.tankIndex >= 0) this.dispense(c, op);
        this.release(c);
        c.opIndex++;
        if (c.opIndex >= c.ops.length) return;
        const next = c.ops[c.opIndex];
        if (next.stationId === "GATE") {
          this.finalizeAtGate(c);
          return;
        }
        if (next.stationId === "QC") {
          if (this.occupancy.has("QC")) {
            c.state = "BLOCKED";
            c.deadlineSec = this.config.sensorWaitTimeoutSec;
          } else {
            this.acquire(c, "QC");
            c.state = "SERVING";
            c.timeInOpSec = 0;
            c.deadlineSec = this.config.sensorWaitTimeoutSec;
          }
          return;
        }
        c.state = "MOVING";
        c.transitTimerSec = this.config.stationSpacingM / this.config.beltSpeedMPerSec;
      }
    }
  }

  private dispense(c: Container, op: Op): void {
    const tank = this.tanks[op.tankIndex];
    // Refinement d: ±dispenseVariance jitter on the target volume.
    const variance = this.config.dispenseVariance;
    const jitter = 1 + (Math.random() * 2 - 1) * variance;
    const amount = Math.min(op.volumeMl * jitter, tank.levelMl);
    tank.levelMl -= amount;
    c.fillMl += amount;
    if (tank.levelMl < tank.refillThresholdMl && !tank.refilling) {
      // Refinement a: auto-refill then continue (ACCEPT), never reject on low level.
      tank.refilling = true;
      tank.refillTimerSec = 1.5;
      this.recordEvent(`tank ${tank.id} low (${Math.round(tank.levelMl)} ml) — auto-refilling`);
    }
  }

  private finalizeAtGate(c: Container): void {
    if (this.occupancy.has("GATE")) {
      c.state = "BLOCKED";
      c.deadlineSec = this.config.sensorWaitTimeoutSec;
      return;
    }
    this.acquire(c, "GATE");
    // Accept iff barcode parsed and fill is within tolerance of target.
    if (c.parseError || !c.parsed) {
      this.reject(c, "bad barcode");
    } else {
      const tolerance = Math.max(1, c.targetMl * (this.config.dispenseVariance + 0.01));
      if (Math.abs(c.fillMl - c.targetMl) > tolerance) {
        this.reject(c, `fill ${c.fillMl.toFixed(1)} != target ${c.targetMl}`);
      } else {
        this.accept(c);
      }
    }
  }

  private accept(c: Container): void {
    this.release(c);
    c.state = "ACCEPTED";
    this.counts.accepted++;
    this.counts.total++;
    this.recordEvent(`container ${c.id} ACCEPTED (fill ${c.fillMl.toFixed(1)}/${c.targetMl} ml)`);
  }

  private reject(c: Container, reason: string): void {
    this.release(c);
    c.state = "REJECTED";
    c.jamReason = reason;
    this.counts.rejected++;
    this.counts.total++;
    this.recordEvent(`container ${c.id} REJECTED — ${reason}`);
  }

  private forceReject(c: Container, reason: string): void {
    this.release(c);
    c.state = "JAMMED";
    c.jamReason = reason;
    this.counts.rejected++;
    this.counts.total++;
    this.recordEvent(`container ${c.id} JAMMED — ${reason}`);
  }

  private acquire(c: Container, stationId: string): void {
    this.occupancy.set(stationId, c.id);
    c.occupyingStationId = stationId;
  }

  private release(c: Container): void {
    if (c.occupyingStationId) {
      this.occupancy.delete(c.occupyingStationId);
      c.occupyingStationId = null;
    }
  }

  private recordEvent(msg: string): void {
    this.lastEvent = msg;
  }

  /** Build the HMI-facing JSON snapshot (documented data contract). */
  snapshot(): Snapshot {
    const simMin = this.simTimeSec / 60;
    const throughputCpm = simMin > 0 ? this.counts.accepted / simMin : 0;
    const operatingSec = Math.max(1, this.simTimeSec - this.lineBlockedSec);
    const availability = clamp01(1 - this.lineBlockedSec / Math.max(1, this.simTimeSec));
    const performance = clamp01((this.idealCycleSec * this.counts.total) / operatingSec);
    const quality = this.counts.total > 0 ? this.counts.accepted / this.counts.total : 0;
    const overall = availability * performance * quality;
    return {
      tanks: this.tanks.map((t) => ({
        id: t.id,
        name: t.name,
        colorCode: t.colorCode,
        levelMl: Math.round(t.levelMl * 10) / 10,
        capacityMl: t.capacityMl,
      })),
      containers: this.containers.map((c) => ({
        id: c.id,
        status: c.state,
        fillMl: Math.round(c.fillMl * 10) / 10,
        targetMl: c.targetMl,
      })),
      counts: { ...this.counts },
      throughputCpm: Math.round(throughputCpm * 100) / 100,
      oee: {
        availability: round3(availability),
        performance: round3(performance),
        quality: round3(quality),
        overall: round3(overall),
      },
      lastEvent: this.lastEvent,
      timestamp: Math.round(this.simTimeSec * 1000) / 1000,
    };
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
