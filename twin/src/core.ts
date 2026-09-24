/**
 * Captsone twin core — the framework-agnostic simulation engine.
 *
 * Pure TypeScript, no simulator dependency. Owns the container state machine,
 * station routing (label → scan → fill bays → capping arm → sort sensor →
 * reject diverter → sort diverter), pipelining, tank levels + auto-refill, jam/timeout handling,
 * OEE + throughput accounting, and the JSON snapshot builder. The Node harness
 * (`run.ts`) and the virtual PLC (`plc/virtual-plc.ts`) drive it directly.
 *
 * A container's label is read at SCAN: the recipe (and so the fill ops) is
 * only known once the SCAN op completes. Microcontroller stations complete on
 * the core's own timers, unless a `StationDriver` is attached — the virtual PLC
 * attaches one so LABEL, SCAN, CAP and QC finish only when the field nodes
 * report back through the register map, exactly as on the real PLC.
 */

import { MAX_TANKS, TANK_SLOTS, tankSlot, type StationConfig, type TankConfig, type TwinConfig } from "./config";
import { parseBarcode, BarcodeError, type ParsedBarcode } from "./barcode";
import {
  BARCODE_ERROR_CODES,
  EVENT_SEVERITY,
  EventCode,
  FAULT_TEXT,
  FaultCode,
  RejectReason,
  TankChangeRefusal,
  stationCode,
  type EventSeverity,
} from "./events";
import { beltOrderSteps, buildDispensePlan, type DispensePlan } from "./recipe";
import { RollingRate, computeOee, idealCycleSec } from "./metrics";
import { LineSafety, SafetyCommand, type ControlMode, type ControlSource, type Refusal } from "./safety";
import { TankPalette, type TankColor } from "./tank-colors";

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
  /** Tank this op dispenses from; null for non-dispense ops. Keyed by id so
   *  removing a tank at runtime never re-points an in-flight op. */
  tankId: string | null;
  durationSec: number;
  volumeMl: number;
}

export type { EventSeverity } from "./events";

export interface CoreEvent {
  /** Monotonic sequence number. */
  seq: number;
  simTimeSec: number;
  severity: EventSeverity;
  message: string;
  /** Structured form (see events.ts) — what a PLC reports for the same event. */
  code: EventCode;
  arg1: number;
  arg2: number;
}

const EVENT_LOG_SIZE = 50;
/** How far a manual jog advances belt transit (s). */
const JOG_SEC = 0.5;

/** What a station reported when it finished with a container. */
export interface StationResult {
  /** SCAN only: the raw text the scanner read, or null for a no-read. */
  scanText?: string | null;
  /** Reject the container at the reject diverter (station failed, bottle type mismatch). */
  reject?: RejectReason;
}

/**
 * Completes stations from outside the core (the PLC talking to field nodes).
 * Stations it does not handle complete on the core's timers.
 */
export interface StationDriver {
  handles(stationId: string): boolean;
  /**
   * Polled every tick while `c` is SERVING at `stationId`. Return null while the
   * station is still working; the core jams the container after
   * `config.stationNodeTimeoutSec`.
   */
  poll(stationId: string, c: Container): StationResult | null;
}

export interface Container {
  id: number;
  /** Text printed on the container's label (simulation truth); null when only a real scanner can read it. */
  labelText: string | null;
  /** Text the scanner read at SCAN; null until then or on a no-read. */
  barcodeRaw: string | null;
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
  /** Numeric BarcodeError code (0 when the barcode parsed). */
  parseErrorCode: number;
  /** Sim time the container reached ACCEPTED/REJECTED/JAMMED; null while live. */
  completedAtSec: number | null;
  /** Output lane after the sort diverter (index into config.sort.lanes), from the bottle type. */
  lane: number;
  /** Set when a station failed on this container: the reject diverter rejects it for this reason. */
  rejectReason: RejectReason | null;
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

export interface SnapshotSortLane {
  id: string;
  name: string;
  /** Accepted containers sent to this lane. */
  count: number;
}

export interface Snapshot {
  tanks: SnapshotTank[];
  containers: SnapshotContainer[];
  counts: { accepted: number; rejected: number; total: number };
  /** Accepted containers per output lane after the sort diverter. */
  sortLanes: SnapshotSortLane[];
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
  /** Accepted containers per sort lane (index = config.sort.lanes). */
  readonly laneCounts = [0, 0];
  private lineBlockedSec = 0;
  private lastEvent = "init";
  private eventSeq = 0;
  /** Recent events, oldest first (bounded). */
  readonly events: CoreEvent[] = [];
  /** E-Stops, safety circuit, local/remote authority, run state (see safety.ts). */
  readonly safety: LineSafety;
  /** Recent ACCEPTED completions (rolling throughput window). */
  private readonly acceptedRate: RollingRate;
  simTimeSec = 0;
  private occupancy = new Map<string, number>();
  /** Bottles waiting to enter, by label text (null = label only a real scanner can read). */
  private barcodeQueue: Array<string | null> = [];
  private readonly idealCycleSec: number;
  /** Completes microcontroller stations from outside (the virtual PLC); null = the core's own timers. */
  driver: StationDriver | null = null;
  /** Operator-editable tank names and colors, per slot. */
  readonly palette: TankPalette;

  /**
   * @param palette saved tank names/colors; when given, it overrides the names
   *                and colors of the configured tanks. Defaults to TANK_SLOTS.
   */
  constructor(config: TwinConfig, palette?: TankPalette) {
    this.palette = palette ?? new TankPalette();
    const tanks = config.tanks.map((t) => ({ ...t, ...(palette?.get(t.id) ?? {}) }));
    // Own copy: operator commands add/remove tanks and bays at runtime.
    this.config = { ...config, tanks, stations: [...config.stations] };
    this.tanks = tanks.map((t) => ({
      ...t,
      levelMl: t.capacityMl,
      refilling: false,
      refillTimerSec: 0,
    }));
    this.safety = new LineSafety(
      config.safety,
      (code, arg1, arg2, message) => this.recordEvent(message, EVENT_SEVERITY[code], code, arg1, arg2),
      true,
    );
    this.acceptedRate = new RollingRate(config.throughputWindowSec);
    this.idealCycleSec = idealCycleSec(config);
  }

  /** Bottles waiting upstream, not yet admitted onto the belt. */
  get queuedBarcodes(): number {
    return this.barcodeQueue.length;
  }

  /** Queue a bottle with this preprinted label; the scanner reads it at SCAN. */
  enqueueBarcode(barcode: string): void {
    this.barcodeQueue.push(barcode);
    this.recordEvent(`barcode queued: ${barcode}`, "info", EventCode.BARCODE_QUEUED);
  }

  /** Queue a bottle whose label only the (real) scanner can read. */
  enqueueBottle(): void {
    this.barcodeQueue.push(null);
  }

  /**
   * A station fault decided by the PLC: record it, stop the line, and latch it
   * until RESET (START is refused meanwhile).
   */
  raiseFault(code: FaultCode, stationId: string | null = null): void {
    const at = stationId ? ` at ${stationId}` : "";
    this.recordEvent(`FAULT: ${FAULT_TEXT[code]}${at} — line stopped`, "error", EventCode.FAULT, code, stationCode(stationId));
    this.safety.latchFault();
  }

  /** True whenever the line may not move: stopped, E-Stop active, or safety reset pending. */
  get isHalted(): boolean {
    return !this.safety.lineEnabled;
  }

  tick(dt: number): void {
    this.simTimeSec += dt;

    for (const tank of this.tanks) {
      if (tank.refilling) {
        tank.refillTimerSec -= dt;
        if (tank.refillTimerSec <= 0) {
          tank.levelMl = Math.min(tank.capacityMl, tank.levelMl + this.config.refillAmountMl);
          tank.refilling = false;
          this.recordEvent(`tank ${tank.id} refilled to ${Math.round(tank.levelMl)} ml`, "success", EventCode.TANK_REFILLED, slotOf(tank.id), Math.round(tank.levelMl));
        }
      }
    }

    if (this.isHalted) {
      // Stopped / E-Stop counts as downtime; tanks keep refilling, nothing moves.
      this.lineBlockedSec += dt;
      return;
    }

    this.spawnTimerSec -= dt;
    // Only containers still on the belt count toward the pipelining cap; finished
    // ones are retained for history and must not block new arrivals.
    const onBelt = this.containers.filter((c) => c.completedAtSec === null).length;
    if (
      this.barcodeQueue.length > 0 &&
      onBelt < this.config.maxConcurrentContainers &&
      !this.occupancy.has(this.entryStationId) &&
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

  private spawnContainer(labelText: string | null): void {
    const id = this.nextContainerId++;
    const times = this.config.stationTimesSec;
    const ops: Op[] = [];
    if (this.hasStation("LABEL")) ops.push(serviceOp("LABEL", times.label));
    ops.push(serviceOp("SCAN", times.scan));

    const c: Container = {
      id,
      labelText,
      barcodeRaw: null,
      parsed: null,
      plan: null,
      parseError: null,
      ops,
      opIndex: 0,
      state: "ENTERING",
      timeInOpSec: 0,
      transitTimerSec: 0,
      deadlineSec: 0,
      fillMl: 0,
      targetMl: 0,
      occupyingStationId: null,
      jamReason: null,
      parseErrorCode: BARCODE_ERROR_CODES.OK,
      completedAtSec: null,
      lane: 0,
      rejectReason: null,
    };
    this.containers.push(c);
    this.recordEvent(`container ${id} entered`, "info", EventCode.CONTAINER_ENTERED, id);
  }

  /**
   * The PLC validates what the scanner read at SCAN and plans the rest of the
   * container's route. `text` null = no read.
   */
  private applyScan(c: Container, text: string | null): void {
    c.barcodeRaw = text;
    try {
      if (text === null) throw new BarcodeError("MALFORMED", "no read");
      c.parsed = parseBarcode(text, this.config);
      c.plan = buildDispensePlan(c.parsed, this.config.mixPolicy);
    } catch (e) {
      c.parsed = null;
      c.plan = null;
      if (text === null) {
        c.parseError = "NO_READ: the scanner returned no barcode";
        c.parseErrorCode = BARCODE_ERROR_CODES.NO_READ;
      } else {
        c.parseError = e instanceof BarcodeError ? `${e.code}: ${e.message}` : String(e);
        c.parseErrorCode = e instanceof BarcodeError ? BARCODE_ERROR_CODES[e.code] : BARCODE_ERROR_CODES.MALFORMED;
      }
    }

    const times = this.config.stationTimesSec;
    const visit = (stationId: string, durationSec: number, required = false) => {
      if (required || this.hasStation(stationId)) c.ops.push(serviceOp(stationId, durationSec));
    };
    if (c.parsed && c.plan) {
      c.targetMl = c.parsed.totalMl;
      c.lane = this.laneFor(c.parsed.totalMl);
      // One pass along the belt: each bay once, in belt order (see beltOrderSteps).
      for (const step of beltOrderSteps(c.plan)) {
        const tank = this.config.tanks[step.tankIndex];
        const stationId = this.dispenseStationFor(step.tankIndex);
        const dur = step.volumeMl / tank.dispenseRateMlPerSec + 0.2;
        c.ops.push({ stationId, tankId: tank.id, durationSec: dur, volumeMl: step.volumeMl });
      }
      visit("MIX", this.config.mixDurationSec);
      visit("CAP", times.cap);
      visit("QC", times.qc, true);
      visit("GATE", times.gate, true);
      visit("SORT", times.sort);
      this.recordEvent(`container ${c.id} barcode read: ${text}`, "info", EventCode.BARCODE_READ, c.id, c.targetMl);
    } else {
      // No scan diverter: an unreadable bottle rides through unserved to the reject diverter.
      visit("GATE", times.gate, true);
      this.recordEvent(`container ${c.id} barcode rejected: ${c.parseError}`, "warn", EventCode.BARCODE_REJECTED, c.id, c.parseErrorCode);
    }
  }

  /** A station failed on `c`: skip its remaining service and send it to the reject diverter. */
  private flagReject(c: Container, reason: RejectReason): void {
    c.rejectReason = reason;
    const rest = c.ops.slice(c.opIndex + 1).filter((op) => op.stationId === "GATE");
    c.ops = c.ops.slice(0, c.opIndex + 1).concat(rest);
  }

  private hasStation(stationId: string): boolean {
    return this.config.stations.some((s) => s.id === stationId);
  }

  /** First station a new container occupies (LABEL on the default line). */
  private get entryStationId(): string {
    return this.hasStation("LABEL") ? "LABEL" : "SCAN";
  }

  /** Sort lane for a recipe total: small bottles to lanes[0], large to lanes[1]. */
  private laneFor(totalMl: number): number {
    if (!this.hasStation("SORT")) return 0;
    return totalMl <= this.config.sort.smallBottleMaxMl ? 0 : 1;
  }

  /** Belt transit time between two stations, one station spacing per station passed. */
  private transitSec(fromId: string, toId: string): number {
    const ids = this.config.stations.map((s) => s.id);
    const hops = Math.max(1, ids.indexOf(toId) - ids.indexOf(fromId));
    return (hops * this.config.stationSpacingM) / this.config.beltSpeedMPerSec;
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
      if (this.occupancy.has(op.stationId)) this.block(c);
      else this.serve(c, op.stationId);
      return;
    }

    if (c.state === "MOVING") {
      c.transitTimerSec -= dt;
      if (c.transitTimerSec <= 0) {
        if (op.stationId === "GATE") this.finalizeAtGate(c);
        else if (this.occupancy.has(op.stationId)) this.block(c);
        else this.serve(c, op.stationId);
      }
      return;
    }

    if (c.state === "BLOCKED") {
      c.deadlineSec -= dt;
      if (c.deadlineSec <= 0) {
        this.forceReject(c, `jam at ${op.stationId} (wait timeout)`, op.stationId);
        return;
      }
      if (!this.occupancy.has(op.stationId)) {
        if (op.stationId === "GATE") this.finalizeAtGate(c);
        else this.serve(c, op.stationId);
      }
      return;
    }

    if (c.state === "SERVING") {
      c.timeInOpSec += dt;
      c.deadlineSec -= dt;
      if (c.deadlineSec <= 0 && op.stationId !== "GATE") {
        this.forceReject(c, `service timeout at ${op.stationId}`, op.stationId);
        return;
      }
      let result: StationResult | null = {};
      if (this.driver?.handles(op.stationId)) result = this.driver.poll(op.stationId, c);
      else if (c.timeInOpSec < op.durationSec) result = null;
      if (result) this.completeOp(c, op, result);
    }
  }

  private completeOp(c: Container, op: Op, result: StationResult): void {
    if (op.tankId) this.dispense(c, op);
    if (op.stationId === "SCAN") this.applyScan(c, result.scanText !== undefined ? result.scanText : c.labelText);
    if (result.reject) this.flagReject(c, result.reject);
    if (c.opIndex === c.ops.length - 1) {
      // Last station passed (SORT, or GATE on a line without a sort diverter).
      this.accept(c);
      return;
    }
    this.release(c);
    c.opIndex++;
    const next = c.ops[c.opIndex];
    if (next.stationId === "GATE" && op.stationId === "QC") {
      // The reject diverter sits directly after the sort sensor.
      this.finalizeAtGate(c);
      return;
    }
    if (next.stationId === "QC") {
      if (this.occupancy.has("QC")) this.block(c);
      else this.serve(c, "QC");
      return;
    }
    c.state = "MOVING";
    c.transitTimerSec = this.transitSec(op.stationId, next.stationId);
  }

  private block(c: Container): void {
    c.state = "BLOCKED";
    c.deadlineSec = this.config.sensorWaitTimeoutSec;
  }

  private serve(c: Container, stationId: string): void {
    this.acquire(c, stationId);
    c.state = "SERVING";
    c.timeInOpSec = 0;
    c.deadlineSec = this.driver?.handles(stationId) ? this.config.stationNodeTimeoutSec : this.config.sensorWaitTimeoutSec;
  }

  private dispense(c: Container, op: Op): void {
    const tank = this.tanks.find((t) => t.id === op.tankId);
    if (!tank) {
      // Tank was removed while this container was in flight: it stays under-filled
      // and the gate rejects it.
      this.recordEvent(`container ${c.id} skipped dispense — tank ${op.tankId} removed`, "warn", EventCode.DISPENSE_SKIPPED, c.id, slotOf(op.tankId));
      return;
    }
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
      this.recordEvent(`tank ${tank.id} low (${Math.round(tank.levelMl)} ml) — auto-refilling`, "warn", EventCode.TANK_LOW, slotOf(tank.id), Math.round(tank.levelMl));
    }
  }

  private finalizeAtGate(c: Container): void {
    if (this.occupancy.has("GATE")) {
      c.state = "BLOCKED";
      c.deadlineSec = this.config.sensorWaitTimeoutSec;
      return;
    }
    this.acquire(c, "GATE");
    // Pass iff barcode parsed and fill is within tolerance of target; passing
    // containers continue to the sort diverter (or are accepted here without one).
    if (c.parseError || !c.parsed) {
      this.reject(c, "bad barcode", RejectReason.BAD_BARCODE);
      return;
    }
    if (c.rejectReason !== null) {
      this.reject(c, REJECT_REASON_TEXT[c.rejectReason] ?? "station fault", c.rejectReason);
      return;
    }
    const tolerance = Math.max(1, c.targetMl * (this.config.dispenseVariance + 0.01));
    if (Math.abs(c.fillMl - c.targetMl) > tolerance) {
      this.reject(c, `fill ${c.fillMl.toFixed(1)} != target ${c.targetMl}`, RejectReason.FILL_OUT_OF_TOLERANCE);
      return;
    }
    c.state = "SERVING";
    c.timeInOpSec = 0;
    c.deadlineSec = this.config.sensorWaitTimeoutSec;
  }

  private accept(c: Container): void {
    this.release(c);
    c.state = "ACCEPTED";
    c.completedAtSec = this.simTimeSec;
    this.acceptedRate.record(this.simTimeSec);
    this.counts.accepted++;
    this.counts.total++;
    this.laneCounts[c.lane]++;
    const lane = this.hasStation("SORT") ? ` → ${this.config.sort.lanes[c.lane].name}` : "";
    this.recordEvent(`container ${c.id} ACCEPTED (fill ${c.fillMl.toFixed(1)}/${c.targetMl} ml)${lane}`, "success", EventCode.CONTAINER_ACCEPTED, c.id, Math.round(c.fillMl * 10));
  }

  private reject(c: Container, reason: string, reasonCode: RejectReason): void {
    this.release(c);
    c.state = "REJECTED";
    c.jamReason = reason;
    c.completedAtSec = this.simTimeSec;
    this.counts.rejected++;
    this.counts.total++;
    this.recordEvent(`container ${c.id} REJECTED — ${reason}`, "error", EventCode.CONTAINER_REJECTED, c.id, reasonCode);
  }

  private forceReject(c: Container, reason: string, stationId: string): void {
    this.release(c);
    c.state = "JAMMED";
    c.jamReason = reason;
    c.completedAtSec = this.simTimeSec;
    this.counts.rejected++;
    this.counts.total++;
    this.recordEvent(`container ${c.id} JAMMED — ${reason}`, "error", EventCode.CONTAINER_JAMMED, c.id, stationCode(stationId));
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

  private recordEvent(msg: string, severity: EventSeverity, code: EventCode, arg1 = 0, arg2 = 0): void {
    this.lastEvent = msg;
    this.events.push({ seq: ++this.eventSeq, simTimeSec: this.simTimeSec, severity, message: msg, code, arg1, arg2 });
    if (this.events.length > EVENT_LOG_SIZE) this.events.shift();
  }

  // ---- Operator commands (HMI Manual/Jog screen, via run.ts) ----

  /**
   * Digital E-Stop (HMI). Opens the safety circuit — on the physical line the
   * PLC drops its fail-safe output into the safety relay, de-energizing all
   * motion. Always allowed, from anywhere.
   */
  eStop(): null {
    this.safety.pressDigitalEStop();
    return null;
  }

  /** Release the latched digital E-Stop. Does not restart: RESET then START are required. */
  clearEStop(): Refusal | null {
    return this.safety.releaseDigitalEStop();
  }

  /** Physical E-Stop button pressed/released (safety relay monitoring input). */
  setPhysicalEStop(buttonId: string, pressed: boolean): void {
    this.safety.setPhysicalEStop(buttonId, pressed);
  }

  /** Safety reset. Local (panel) by default; remote only if config.safety.remoteResetAllowed. */
  reset(source: ControlSource = "remote"): Refusal | null {
    return this.safety.reset(source);
  }

  start(source: ControlSource = "remote"): Refusal | null {
    return this.safety.start(source);
  }

  /** Controlled stop. Always allowed, from anywhere. */
  stop(source: ControlSource = "remote"): null {
    this.safety.stop(source);
    return null;
  }

  /** Local/Remote key switch on the local control panel. */
  setControlMode(mode: ControlMode): Refusal | null {
    return this.safety.setMode(mode, "local");
  }

  /** Advance containers in transit by one jog step. Only while stopped with the safety circuit reset. */
  jogBelt(source: ControlSource = "remote"): Refusal | null {
    const refusal = this.safety.authorize(SafetyCommand.JOG, source);
    if (refusal) return refusal;
    let moved = 0;
    for (const c of this.containers) {
      if (c.state === "MOVING") {
        c.transitTimerSec = Math.max(0, c.transitTimerSec - JOG_SEC);
        moved++;
      }
    }
    this.recordEvent(`Manual: belt jog ${JOG_SEC}s (${source}, ${moved} container(s) in transit)`, "info", EventCode.JOG, moved);
    return null;
  }

  /** Fire the reject diverter: rejects the container at the sort sensor (QC) or reject diverter (GATE). */
  firePusher(source: ControlSource = "remote"): Refusal | null {
    const refusal = this.safety.authorize(SafetyCommand.FIRE_PUSHER, source);
    if (refusal) return refusal;
    const target = this.containers.find(
      (c) => c.occupyingStationId === "QC" || c.occupyingStationId === "GATE",
    );
    if (!target) {
      this.recordEvent("Manual: reject diverter fired — no container at the sort sensor or reject diverter", "warn", EventCode.PUSHER_NO_TARGET);
      return null;
    }
    this.recordEvent(`Manual: reject diverter fired on container ${target.id}`, "warn", EventCode.PUSHER_FIRED, target.id);
    this.reject(target, "manual reject (reject diverter)", RejectReason.MANUAL_PUSHER);
    return null;
  }

  /**
   * Enable the next free tank slot (see config.TANK_SLOTS) + its dispense bay.
   * Tanks stay in slot order, which is also the barcode volume order.
   * `color` (validated by the caller) is saved to that slot's palette entry first.
   */
  addTank(source: ControlSource = "remote", color?: Partial<TankColor>): Refusal | null {
    const refusal = this.safety.authorize(SafetyCommand.TANK_CHANGE, source);
    if (refusal) return refusal;
    if (this.tanks.length >= MAX_TANKS) {
      this.recordEvent(`Manual: cannot add tank — MAX_TANKS (${MAX_TANKS}) reached`, "warn", EventCode.TANK_CHANGE_REFUSED, TankChangeRefusal.MAX_TANKS_REACHED);
      return null;
    }
    const present = new Set(this.tanks.map((t) => t.id));
    const tank = TANK_SLOTS.find((t) => !present.has(t.id));
    if (!tank) {
      this.recordEvent("Manual: no free tank slot", "warn", EventCode.TANK_CHANGE_REFUSED, TankChangeRefusal.NO_FREE_SLOT);
      return null;
    }
    if (color && (color.name !== undefined || color.colorCode !== undefined)) this.palette.set(tank.id, color);
    this.enableSlot(tankSlot(tank.id) ?? MAX_TANKS);
    return null;
  }

  /**
   * Rename / recolor a tank slot (enabled or not). Presentation only: no safety
   * check, since it moves nothing. Returns an error message, or null.
   */
  setTankColor(tankId: string, color: { name?: unknown; colorCode?: unknown }): string | null {
    const error = this.palette.set(tankId, color);
    if (!error) this.applyPalette();
    return error;
  }

  /** Restore one tank slot's (or every slot's) default name and color. */
  resetTankColor(tankId?: string): string | null {
    const error = this.palette.reset(tankId);
    if (!error) this.applyPalette();
    return error;
  }

  private applyPalette(): void {
    for (const list of [this.tanks, this.config.tanks]) {
      for (const t of list) Object.assign(t, this.palette.get(t.id) ?? {});
    }
  }

  /** Record a refused tank-module change requested through another channel (e.g. a PLC mask write). */
  refuseTankChange(refusal: TankChangeRefusal): void {
    this.recordEvent(`Manual: tank change refused (${TankChangeRefusal[refusal]})`, "warn", EventCode.TANK_CHANGE_REFUSED, refusal);
  }

  /** Enable a specific tank slot (1-based). No-op if it is already enabled. */
  enableTankSlot(slot: number, source: ControlSource = "remote"): Refusal | null {
    const refusal = this.safety.authorize(SafetyCommand.TANK_CHANGE, source);
    if (refusal) return refusal;
    this.enableSlot(slot);
    return null;
  }

  private enableSlot(slot: number): void {
    const def = TANK_SLOTS[slot - 1];
    if (!def) {
      this.recordEvent(`Manual: tank slot ${slot} does not exist`, "warn", EventCode.TANK_CHANGE_REFUSED, TankChangeRefusal.NO_FREE_SLOT);
      return;
    }
    const tank: TankConfig = { ...def, ...this.palette.get(def.id) };
    if (this.tanks.some((t) => t.id === tank.id)) return;
    const idx = this.tanks.filter((t) => (tankSlot(t.id) ?? MAX_TANKS) < slot).length;
    this.config.tanks.splice(idx, 0, { ...tank });
    this.tanks.splice(idx, 0, { ...tank, levelMl: tank.capacityMl, refilling: false, refillTimerSec: 0 });
    this.syncBays();
    this.recordEvent(`Manual: tank ${tank.id} (${tank.name}) added — line now has ${this.tanks.length} tanks`, "warn", EventCode.TANK_ENABLED, slotOf(tank.id), this.tanks.length);
    this.dropStaleBarcodes();
  }

  /** Disable a tank. In-flight containers that still needed it are under-filled and rejected. */
  removeTank(tankId: string, source: ControlSource = "remote"): Refusal | null {
    const refusal = this.safety.authorize(SafetyCommand.TANK_CHANGE, source);
    if (refusal) return refusal;
    const idx = this.tanks.findIndex((t) => t.id === tankId);
    if (idx < 0) {
      this.recordEvent(`Manual: tank ${tankId} not found`, "warn", EventCode.TANK_CHANGE_REFUSED, TankChangeRefusal.TANK_NOT_FOUND);
      return null;
    }
    if (this.tanks.length <= 1) {
      this.recordEvent("Manual: cannot remove the last tank", "warn", EventCode.TANK_CHANGE_REFUSED, TankChangeRefusal.LAST_TANK);
      return null;
    }
    const [removed] = this.tanks.splice(idx, 1);
    this.config.tanks.splice(idx, 1);
    this.syncBays();
    this.recordEvent(`Manual: tank ${removed.id} (${removed.name}) removed — line now has ${this.tanks.length} tanks`, "warn", EventCode.TANK_DISABLED, slotOf(removed.id), this.tanks.length);
    this.dropStaleBarcodes();
    return null;
  }

  /**
   * After a tank-count change, barcodes still waiting upstream were printed for
   * the old line and would all fail TANK_COUNT_MISMATCH at the scanner. Divert
   * them before they enter the belt instead of letting them skew quality.
   */
  private dropStaleBarcodes(): void {
    const before = this.barcodeQueue.length;
    this.barcodeQueue = this.barcodeQueue.filter((code) => {
      if (code === null) return true;
      try {
        parseBarcode(code, this.config);
        return true;
      } catch (e) {
        return !(e instanceof BarcodeError && e.code === "TANK_COUNT_MISMATCH");
      }
    });
    const dropped = before - this.barcodeQueue.length;
    if (dropped > 0) {
      this.recordEvent(
        `${dropped} queued barcode(s) printed for the previous tank count held back from the line`,
        "warn",
        EventCode.STALE_BARCODES_HELD,
        dropped,
      );
    }
  }

  /** Keep one BAY-n station per tank, inserted after the last bay (before MIX/CAP/QC). */
  private syncBays(): void {
    const stations = this.config.stations;
    const bays = stations.filter((s) => s.id.startsWith("BAY-"));
    while (bays.length < this.tanks.length) {
      const k = bays.length + 1;
      const last = bays[bays.length - 1] ?? stations.find((s) => s.id === "SCAN");
      const bay: StationConfig = {
        id: `BAY-${k}`,
        name: `Dispense Bay ${k}`,
        positionM: (last?.positionM ?? 0) + this.config.stationSpacingM,
      };
      const after = last ? stations.indexOf(last) + 1 : 0;
      stations.splice(after, 0, bay);
      bays.push(bay);
    }
    while (bays.length > this.tanks.length) {
      const bay = bays.pop()!;
      stations.splice(stations.indexOf(bay), 1);
    }
  }

  /** Build the HMI-facing JSON snapshot (documented data contract). */
  snapshot(): Snapshot {
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
      sortLanes: this.config.sort.lanes.map((l, i) => ({ id: l.id, name: l.name, count: this.laneCounts[i] })),
      throughputCpm: this.acceptedRate.perMinute(this.simTimeSec),
      oee: computeOee({
        elapsedSec: this.simTimeSec,
        downtimeSec: this.lineBlockedSec,
        idealCycleSec: this.idealCycleSec,
        accepted: this.counts.accepted,
        total: this.counts.total,
      }),
      lastEvent: this.lastEvent,
      timestamp: Math.round(this.simTimeSec * 1000) / 1000,
    };
  }
}

function slotOf(tankId: string | null): number {
  return tankId ? (tankSlot(tankId) ?? 0) : 0;
}

function serviceOp(stationId: string, durationSec: number): Op {
  return { stationId, tankId: null, durationSec, volumeMl: 0 };
}

const REJECT_REASON_TEXT: Partial<Record<RejectReason, string>> = {
  [RejectReason.BOTTLE_TYPE_MISMATCH]: "bottle type does not match the recipe (sort sensor)",
  [RejectReason.STATION_FAULT]: "station fault (labeler or robotic arm)",
};
