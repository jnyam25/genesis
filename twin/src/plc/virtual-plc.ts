/**
 * Virtual PLC — the twin core behind the real PLC register map.
 *
 * Runs the simulated line and exposes it over Modbus TCP exactly as the
 * physical Micro850 PLC is specified to (docs/prototype/io-map.md). Use it
 * to develop and test the bridge, the HMI, and the ESP32 node firmware before
 * the hardware exists, and as the reference implementation of the register
 * semantics for the PLC programmer (docs/prototype/micro850-plc.md).
 *
 * The PLC makes every line decision. The ESP32 field nodes only execute its
 * requests and report back through the register map:
 *   LABEL  Station.LabelRequest/Done            (scanner node: label applicator)
 *   SCAN   Scan.Request → raw text → Scan.Done  (scanner node; the PLC validates the barcode)
 *   CAP    Station.ArmCmd/Seq → Result/DoneSeq  (station node on the xArm; see arm-sequencer.ts)
 *   QC     Station.SortRequest → SortHeightMm   (station node; the PLC classifies the bottle)
 * The PLC also watches the node heartbeats and fault bits, and latches a fault
 * (stopping the line) when a node goes offline or fails.
 *
 * By default both nodes are simulated in-process (simulated-nodes.ts) and
 * follow the same register contract as the firmware. Point real ESP32s at the
 * virtual PLC with VPLC_NODES to test the firmware against the full line.
 *
 *   npm run virtual-plc            (in twin/)  →  Modbus TCP on 0.0.0.0:5020
 *
 * The physical inputs a real PLC reads from wiring — the local control panel
 * (Local/Remote key switch, Start/Stop/Reset/Jog) and the physical E-Stop
 * buttons — are driven through the Sim.* registers and coils, and the virtual
 * PLC reports LineState.SIMULATION = 1 so the bridge and HMI allow operating
 * them.
 *
 * Env: VPLC_PORT (5020), VPLC_HOST (0.0.0.0), VPLC_UNIT_ID (1),
 *      VPLC_FEED=0   no bottle arrivals (tests drive the core directly),
 *      VPLC_NODES=scanner | station | scanner,station | all
 *                    real ESP32 nodes instead of the simulated ones. With a real
 *                    scanner node, bottles arrive without a known label and the
 *                    recipe comes only from what the scanner reads.
 *
 * Port 5020 instead of 502 so it runs without admin/root rights.
 */

import { DEFAULT_CONFIG, MAX_TANKS, TANK_SLOTS, tankSlot } from "../config";
import { TwinCore, type Container, type StationDriver, type StationResult } from "../core";
import { FaultCode, RejectReason, TankChangeRefusal } from "../events";
import { nextBarcode } from "../feeder";
import { hmiStatus, liveOee, visibleContainers } from "../hmi";
import { ArmSequencer } from "./arm-sequencer";
import { ModbusTcpServer, type WriteEvent } from "./modbus";
import { SimulatedScannerNode, SimulatedStationNode } from "./simulated-nodes";
import {
  COIL,
  COIL_COUNT,
  CONTAINER_FIELD,
  CONTAINER_SLOTS,
  CONTAINER_STATUS,
  EVENT_FIELD,
  EVENT_LAST_SEQ,
  EVENT_SLOTS,
  FIELD,
  LINE_STATE_BITS,
  PROTOCOL_VERSION,
  SCAN,
  SCAN_STATUS,
  SCAN_TEXT_REGISTERS,
  SIM,
  STATION,
  SYS,
  TANK_FIELD,
  TANK_FLAG_BITS,
  clampU16,
  containerRegister,
  eventRegister,
  tankRegister,
  u16,
  unpackScanText,
} from "./tag-map";

const SCAN_PERIOD_SEC = 0.1;
const HMI_LINK_TIMEOUT_SEC = 3;
/** A field node whose heartbeat does not change for this long is offline. */
export const NODE_HEARTBEAT_TIMEOUT_SEC = 3;
const REGISTER_SPACE = 500;

/** Node fault bits → the fault the PLC latches, and the station it belongs to. */
const SCANNER_FAULT_BITS: Array<[FaultCode, string]> = [
  [FaultCode.LABELER, "LABEL"],
  [FaultCode.SCANNER, "SCAN"],
];
const STATION_FAULT_BITS: Array<[FaultCode, string]> = [
  [FaultCode.ARM_SERVO, "CAP"],
  [FaultCode.SORT_SENSOR, "QC"],
];

/** Map the HMI station status (and sort lane, for accepted containers) onto the register status code. */
export function containerStatusCode(status: string, lane = 0): number {
  switch (status) {
    case "label":
      return CONTAINER_STATUS.LABEL;
    case "scan":
      return CONTAINER_STATUS.SCAN;
    case "scan-rejected":
      return CONTAINER_STATUS.SCAN_REJECTED;
    case "mix":
      return CONTAINER_STATUS.MIX;
    case "cap":
      return CONTAINER_STATUS.CAP;
    case "qc":
      return CONTAINER_STATUS.QC;
    case "sort":
      return CONTAINER_STATUS.SORT;
    case "output":
      return lane === 1 ? CONTAINER_STATUS.OUTPUT_LANE_B : CONTAINER_STATUS.OUTPUT;
    case "rejected":
      return CONTAINER_STATUS.REJECTED;
  }
  const fill = /^fill-(\d+)$/.exec(status);
  return fill ? CONTAINER_STATUS.FILL_BASE + Number(fill[1]) : CONTAINER_STATUS.NONE;
}

/** Event sequence numbers on the wire are 1..65535 (0 means "none"). */
function wireSeq(seq: number): number {
  return ((seq - 1) % 65535) + 1;
}

export interface ExternalNodes {
  /** ESP32 #1 (label applicator + barcode scanner) is real. */
  scanner?: boolean;
  /** ESP32 #2 (xArm robotic arm + sort sensor) is real. */
  station?: boolean;
}

export interface VirtualPlcOptions {
  /** Bottles arrive on the feed timer like the Node harness does. */
  feed?: boolean;
  /** Field nodes that are real ESP32s on the network; the others are simulated. */
  externalNodes?: ExternalNodes;
  unitId?: number;
}

/** Parse VPLC_NODES ("scanner", "station", "scanner,station", "all"). */
export function parseExternalNodes(value: string | undefined): ExternalNodes {
  const parts = new Set((value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const all = parts.has("all");
  return { scanner: all || parts.has("scanner"), station: all || parts.has("station") };
}

interface NodeWatch {
  heartbeat: number;
  fault: FaultCode;
  stationId: string;
  last: number;
  changedAt: number;
}

export class VirtualPlc implements StationDriver {
  readonly core = new TwinCore(DEFAULT_CONFIG);
  readonly server: ModbusTcpServer;
  readonly arm: ArmSequencer;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat = 0;
  private feedTimer = 0;
  private barcodeIdx = 0;
  private lastHmiHeartbeat = -1;
  private hmiHeartbeatChangedAt = -Infinity;
  private readonly feed: boolean;
  private readonly external: Required<ExternalNodes>;
  private readonly scannerSim: SimulatedScannerNode | null;
  private readonly stationSim: SimulatedStationNode | null;
  private readonly watches: NodeWatch[] = [];
  /** Latched faults, oldest first (Sys.FaultCode shows the first). */
  private faults: FaultCode[] = [];

  constructor(options: VirtualPlcOptions = {}) {
    this.feed = options.feed ?? true;
    this.external = { scanner: false, station: false, ...options.externalNodes };
    this.server = new ModbusTcpServer({
      holdingRegisters: REGISTER_SPACE,
      coils: COIL_COUNT,
      unitId: options.unitId,
    });
    this.server.on("write", (w: WriteEvent) => this.onWrite(w));
    this.arm = new ArmSequencer(this.server.registers);
    this.scannerSim = this.external.scanner ? null : new SimulatedScannerNode(this.core.config);
    this.stationSim = this.external.station ? null : new SimulatedStationNode(this.core.config);
    if (this.external.scanner) {
      this.watches.push({ heartbeat: FIELD.SCANNER_NODE_HEARTBEAT, fault: FaultCode.SCANNER_NODE_OFFLINE, stationId: "SCAN", last: -1, changedAt: 0 });
    }
    if (this.external.station) {
      this.watches.push({ heartbeat: FIELD.STATION_NODE_HEARTBEAT, fault: FaultCode.STATION_NODE_OFFLINE, stationId: "CAP", last: -1, changedAt: 0 });
    }
    this.core.driver = this;
    // Simulated key switch starts where the configured line starts.
    this.server.registers[SIM.LOCAL_MODE] = this.core.safety.controlMode === "local" ? 1 : 0;
    this.publish();
  }

  async start(port: number, host = "0.0.0.0"): Promise<void> {
    await this.server.listen(port, host);
    this.timer = setInterval(() => this.scan(SCAN_PERIOD_SEC), SCAN_PERIOD_SEC * 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.server.close();
  }

  /** One PLC scan: inputs → logic → outputs. Public for tests. */
  scan(dt: number): void {
    // The simulated field nodes act between PLC scans, like the real ESP32s.
    const find = (id: number) => this.core.containers.find((c) => c.id === id);
    this.scannerSim?.step(this.server.registers, dt, find);
    this.stationSim?.step(this.server.registers, dt, find);

    this.handleSimulatedInputs();
    this.handleCommandCoils();
    this.superviseNodes();
    const armFault = this.arm.step(this.core.safety.lineEnabled, this.faults.length > 0, this.heldAt("CAP")?.id ?? 0);
    if (armFault) this.latchFault(armFault, "CAP");
    this.core.tick(dt);

    if (this.feed) {
      this.feedTimer += dt;
      if (this.feedTimer >= DEFAULT_CONFIG.mockSensorPeriodSec && this.core.queuedBarcodes < DEFAULT_CONFIG.maxConcurrentContainers) {
        this.feedTimer = 0;
        if (this.external.scanner) this.core.enqueueBottle();
        else this.core.enqueueBarcode(nextBarcode(this.barcodeIdx++, this.core.tanks.length));
      }
    }

    const hmiHeartbeat = this.server.registers[SYS.HMI_HEARTBEAT];
    if (hmiHeartbeat !== this.lastHmiHeartbeat) {
      this.lastHmiHeartbeat = hmiHeartbeat;
      this.hmiHeartbeatChangedAt = this.core.simTimeSec;
    }
    this.heartbeat = u16(this.heartbeat + 1);
    this.publish();
  }

  /** Command coils are pulses: act on 1, then reset to 0 (acknowledge). */
  private handleCommandCoils(): void {
    const coils = this.server.coils;
    const take = (address: number): boolean => {
      if (coils[address] !== 1) return false;
      coils[address] = 0;
      return true;
    };
    // Stops first: a digital E-Stop or stop in the same scan as a start always wins.
    if (take(COIL.CMD_DIGITAL_ESTOP)) this.core.eStop();
    if (take(COIL.CMD_STOP)) this.core.stop("remote");
    if (take(COIL.SIM_LOCAL_STOP)) this.core.stop("local");
    if (take(COIL.CMD_RELEASE_ESTOP)) this.core.clearEStop();
    if (take(COIL.CMD_RESET)) this.reset("remote");
    if (take(COIL.SIM_LOCAL_RESET)) this.reset("local");
    if (take(COIL.CMD_START)) this.core.start("remote");
    if (take(COIL.SIM_LOCAL_START)) this.core.start("local");
    if (take(COIL.CMD_JOG)) this.core.jogBelt("remote");
    if (take(COIL.SIM_LOCAL_JOG)) this.core.jogBelt("local");
    if (take(COIL.CMD_FIRE_PUSHER)) this.core.firePusher("remote");
  }

  /**
   * Simulated physical inputs (Sim.* registers): the local panel key switch and
   * the physical E-Stop buttons. On a real PLC these are hardwired inputs.
   */
  private handleSimulatedInputs(): void {
    const r = this.server.registers;
    const mode = r[SIM.LOCAL_MODE] === 1 ? "local" : "remote";
    if (mode !== this.core.safety.controlMode) this.core.setControlMode(mode);
    const mask = r[SIM.PHYSICAL_ESTOP_MASK];
    this.core.config.safety.eStopButtons.forEach((b, i) => {
      this.core.setPhysicalEStop(b.id, ((mask >> i) & 1) === 1);
    });
  }

  private onWrite(w: WriteEvent): void {
    if (w.kind !== "register") return;
    const touched = (addr: number) => addr >= w.address && addr < w.address + w.values.length;
    if (touched(SYS.TANK_ENABLE_MASK)) this.applyTankMask(this.server.registers[SYS.TANK_ENABLE_MASK]);
  }

  private applyTankMask(mask: number): void {
    const wanted = new Set<number>();
    for (let slot = 1; slot <= MAX_TANKS; slot++) if ((mask >> (slot - 1)) & 1) wanted.add(slot);
    if (wanted.size === 0) {
      // A line needs at least one tank: refuse; publish() rewrites the actual mask.
      this.core.refuseTankChange(TankChangeRefusal.LAST_TANK);
      return;
    }
    const present = new Set(this.core.tanks.map((t) => tankSlot(t.id)));
    for (const slot of wanted) if (!present.has(slot)) this.core.enableTankSlot(slot, "remote");
    for (const tank of [...this.core.tanks]) {
      const slot = tankSlot(tank.id);
      if (slot !== null && !wanted.has(slot)) this.core.removeTank(tank.id, "remote");
    }
  }

  /** RESET also clears latched faults; a cause that is still present re-latches on this scan. */
  private reset(source: "local" | "remote"): void {
    this.core.reset(source);
    if (this.faults.length > 0 && !this.core.safety.state().faultActive) {
      this.faults = [];
      this.arm.reset();
      for (const w of this.watches) w.changedAt = this.core.simTimeSec;
    }
  }

  private latchFault(code: FaultCode, stationId: string): void {
    if (this.faults.includes(code)) return;
    this.faults.push(code);
    this.core.raiseFault(code, stationId);
  }

  /** Field node heartbeats and fault bits. */
  private superviseNodes(): void {
    const r = this.server.registers;
    const now = this.core.simTimeSec;
    for (const w of this.watches) {
      if (r[w.heartbeat] !== w.last) {
        w.last = r[w.heartbeat];
        w.changedAt = now;
      } else if (now - w.changedAt > NODE_HEARTBEAT_TIMEOUT_SEC) {
        this.latchFault(w.fault, w.stationId);
      }
    }
    SCANNER_FAULT_BITS.forEach(([code, stationId], i) => {
      if ((r[STATION.SCANNER_NODE_FAULTS] >> i) & 1) this.latchFault(code, stationId);
    });
    STATION_FAULT_BITS.forEach(([code, stationId], i) => {
      if ((r[STATION.STATION_NODE_FAULTS] >> i) & 1) this.latchFault(code, stationId);
    });
  }

  private heldAt(stationId: string): Container | undefined {
    return this.core.containers.find((c) => c.occupyingStationId === stationId && c.state === "SERVING");
  }

  // ---- StationDriver: the core asks the PLC whether a station has finished ----

  handles(stationId: string): boolean {
    return stationId === "LABEL" || stationId === "SCAN" || stationId === "CAP" || stationId === "QC";
  }

  poll(stationId: string, c: Container): StationResult | null {
    const r = this.server.registers;
    switch (stationId) {
      case "LABEL":
        return this.handshake(STATION.LABEL_REQUEST, STATION.LABEL_DONE, c.id) ? {} : null;
      case "SCAN": {
        if (!this.handshake(SCAN.REQUEST, SCAN.DONE, c.id)) return null;
        if (r[SCAN.STATUS] === SCAN_STATUS.NO_READ) return { scanText: null };
        const text = unpackScanText(r.subarray(SCAN.TEXT_BASE, SCAN.TEXT_BASE + SCAN_TEXT_REGISTERS), r[SCAN.LENGTH]);
        return { scanText: text };
      }
      case "CAP": {
        const outcome = this.arm.takeOutcome(c.id);
        if (!outcome) return null;
        return outcome === "capped" ? {} : { reject: RejectReason.STATION_FAULT };
      }
      case "QC": {
        if (!this.handshake(STATION.SORT_REQUEST, STATION.SORT_DONE, c.id)) return null;
        if (!this.core.config.stations.some((s) => s.id === "SORT")) return {};
        return this.classifyBottle(r[STATION.SORT_HEIGHT_MM]) === c.lane ? {} : { reject: RejectReason.BOTTLE_TYPE_MISMATCH };
      }
    }
    return {};
  }

  /** Request/done handshake: publish the id, finish when the node echoes it. */
  private handshake(request: number, done: number, id: number): boolean {
    const r = this.server.registers;
    const wireId = u16(id);
    if (r[request] !== wireId) {
      r[request] = wireId;
      return false;
    }
    if (r[done] !== wireId) return false;
    r[request] = 0;
    return true;
  }

  /** Sort lane whose nominal bottle height is nearest the measurement and within tolerance; -1 = unknown. */
  classifyBottle(heightMm: number): number {
    if (heightMm <= 0) return -1;
    const { lanes, heightToleranceMm } = this.core.config.sort;
    let best = -1;
    lanes.forEach((lane, i) => {
      const off = Math.abs(heightMm - lane.bottleHeightMm);
      if (off <= heightToleranceMm && (best < 0 || off < Math.abs(heightMm - lanes[best].bottleHeightMm))) best = i;
    });
    return best;
  }

  /** Write the core's state into the register map. */
  private publish(): void {
    const r = this.server.registers;
    const core = this.core;
    const snap = core.snapshot();
    const oee = liveOee(core, snap);

    // System
    let lineState = 0;
    const safety = core.safety.state();
    const setBit = (bitIndex: number, on: boolean) => {
      if (on) lineState |= 1 << bitIndex;
    };
    setBit(LINE_STATE_BITS.RUNNING, safety.running);
    setBit(LINE_STATE_BITS.ESTOP_ACTIVE, safety.eStopActive);
    setBit(LINE_STATE_BITS.SAFETY_OK, safety.safetyCircuitOk);
    setBit(LINE_STATE_BITS.HMI_LINK_OK, core.simTimeSec - this.hmiHeartbeatChangedAt <= HMI_LINK_TIMEOUT_SEC);
    setBit(LINE_STATE_BITS.DIGITAL_ESTOP, safety.digitalEStop);
    setBit(LINE_STATE_BITS.PHYSICAL_ESTOP, safety.eStopButtons.some((b) => b.pressed));
    setBit(LINE_STATE_BITS.RESET_REQUIRED, safety.resetRequired);
    setBit(LINE_STATE_BITS.LOCAL_MODE, safety.controlMode === "local");
    setBit(LINE_STATE_BITS.REMOTE_RESET_ALLOWED, safety.remoteResetAllowed);
    setBit(LINE_STATE_BITS.SIMULATION, true);
    setBit(LINE_STATE_BITS.FAULT, safety.faultActive);
    r[SYS.PHYSICAL_ESTOP_MASK] = core.safety.physicalMask();
    r[SYS.FAULT_CODE] = safety.faultActive ? (this.faults[0] ?? 0) : 0;

    let mask = 0;
    for (const t of core.tanks) {
      const slot = tankSlot(t.id);
      if (slot !== null) mask |= 1 << (slot - 1);
    }

    r[SYS.PROTOCOL_VERSION] = PROTOCOL_VERSION;
    r[SYS.PLC_HEARTBEAT] = this.heartbeat;
    r[SYS.LINE_STATE] = lineState;
    r[SYS.TANK_COUNT] = core.tanks.length;
    r[SYS.TANK_ENABLE_MASK] = mask;
    r[SYS.COUNT_ACCEPTED] = u16(snap.counts.accepted);
    r[SYS.COUNT_REJECTED] = u16(snap.counts.rejected);
    r[SYS.COUNT_TOTAL] = u16(snap.counts.total);
    r[SYS.THROUGHPUT_CPM_X100] = clampU16(snap.throughputCpm * 100);
    r[SYS.OEE_AVAILABILITY_X1000] = clampU16(oee.availability * 1000);
    r[SYS.OEE_PERFORMANCE_X1000] = clampU16(oee.performance * 1000);
    r[SYS.OEE_QUALITY_X1000] = clampU16(oee.quality * 1000);
    r[SYS.OEE_OVERALL_X1000] = clampU16(oee.overall * 1000);
    r[SYS.UPTIME_S] = u16(Math.floor(core.simTimeSec));
    r[SYS.ACTIVE_CONTAINERS] = core.containers.filter((c) => c.completedAtSec === null).length;
    r[SYS.COUNT_LANE_A] = u16(core.laneCounts[0]);
    r[SYS.COUNT_LANE_B] = u16(core.laneCounts[1]);

    // Microcontroller stations. Requests are set by poll(); drop any whose
    // container has left the station (jammed, manually rejected).
    r[STATION.RUN_PERMIT] = safety.running ? 1 : 0;
    const stale: Array<[number, string]> = [[STATION.LABEL_REQUEST, "LABEL"], [SCAN.REQUEST, "SCAN"], [STATION.SORT_REQUEST, "QC"]];
    for (const [request, stationId] of stale) {
      if (r[request] !== 0 && r[request] !== u16(this.heldAt(stationId)?.id ?? 0)) r[request] = 0;
    }
    const scanned = core.containers.filter((c) => c.barcodeRaw !== null || c.parseErrorCode !== 0).pop();
    if (scanned) {
      r[SCAN.PARSE_RESULT] = scanned.parseErrorCode;
      r[SCAN.RESULT_ID] = u16(scanned.id);
      r[SCAN.TOTAL_ML] = clampU16(scanned.parsed ? scanned.targetMl : 0);
    }

    // Tanks
    for (let slot = 1; slot <= MAX_TANKS; slot++) {
      const def = TANK_SLOTS[slot - 1];
      const t = core.tanks.find((x) => x.id === def.id);
      let flags = 0;
      if (t) {
        flags |= 1 << TANK_FLAG_BITS.ENABLED;
        if (t.refilling) flags |= 1 << TANK_FLAG_BITS.REFILLING;
        if (t.levelMl < t.refillThresholdMl) flags |= 1 << TANK_FLAG_BITS.LOW;
      }
      const src = t ?? def;
      r[tankRegister(slot, TANK_FIELD.LEVEL_ML_X10)] = t ? clampU16(t.levelMl * 10) : 0;
      r[tankRegister(slot, TANK_FIELD.CAPACITY_ML)] = clampU16(src.capacityMl);
      r[tankRegister(slot, TANK_FIELD.FLAGS)] = flags;
      r[tankRegister(slot, TANK_FIELD.REFILL_THRESHOLD_ML)] = clampU16(src.refillThresholdMl);
      r[tankRegister(slot, TANK_FIELD.DISPENSE_RATE_ML_S_X10)] = clampU16(src.dispenseRateMlPerSec * 10);
      r[tankRegister(slot, TANK_FIELD.VALVE_OPENING_PCT)] = clampU16(src.valveOpeningPct);
    }

    // Containers: live ones first, then lingering finished ones, up to the slot count.
    const visible = visibleContainers(core);
    const ordered = [
      ...visible.filter((c) => c.completedAtSec === null),
      ...visible.filter((c) => c.completedAtSec !== null),
    ].slice(0, CONTAINER_SLOTS);
    for (let i = 0; i < CONTAINER_SLOTS; i++) {
      const c = ordered[i];
      r[containerRegister(i, CONTAINER_FIELD.ID)] = c ? u16(c.id) : 0;
      r[containerRegister(i, CONTAINER_FIELD.STATUS)] = c ? containerStatusCode(hmiStatus(c), c.lane) : 0;
      r[containerRegister(i, CONTAINER_FIELD.FILL_ML_X10)] = c ? clampU16(c.fillMl * 10) : 0;
      r[containerRegister(i, CONTAINER_FIELD.TARGET_ML_X10)] = c ? clampU16(c.targetMl * 10) : 0;
    }

    // Events, newest first
    const recent = core.events.slice(-EVENT_SLOTS).reverse();
    r[EVENT_LAST_SEQ] = recent[0] ? wireSeq(recent[0].seq) : 0;
    for (let i = 0; i < EVENT_SLOTS; i++) {
      const e = recent[i];
      r[eventRegister(i, EVENT_FIELD.SEQ)] = e ? wireSeq(e.seq) : 0;
      r[eventRegister(i, EVENT_FIELD.CODE)] = e ? e.code : 0;
      r[eventRegister(i, EVENT_FIELD.ARG1)] = e ? u16(e.arg1) : 0;
      r[eventRegister(i, EVENT_FIELD.ARG2)] = e ? u16(e.arg2) : 0;
    }
  }
}

if (require.main === module) {
  const port = Number(process.env.VPLC_PORT ?? 5020);
  const host = process.env.VPLC_HOST ?? "0.0.0.0";
  const unitId = process.env.VPLC_UNIT_ID ? Number(process.env.VPLC_UNIT_ID) : 1;
  const externalNodes = parseExternalNodes(process.env.VPLC_NODES);
  const plc = new VirtualPlc({ feed: process.env.VPLC_FEED !== "0", externalNodes, unitId });
  const node = (real: boolean | undefined) => (real ? "REAL ESP32 (heartbeat watched)" : "simulated");
  plc
    .start(port, host)
    .then(() => {
      console.log(`[virtual-plc] Modbus TCP server on ${host}:${port} (unit id ${unitId}, protocol v${PROTOCOL_VERSION})`);
      console.log(`[virtual-plc] bottle feed ${process.env.VPLC_FEED === "0" ? "OFF" : "ON"}`);
      console.log(`[virtual-plc] scanner node (label + barcode): ${node(externalNodes.scanner)}`);
      console.log(`[virtual-plc] station node (robotic arm + sort sensor): ${node(externalNodes.station)}`);
    })
    .catch((err: NodeJS.ErrnoException) => {
      console.error(
        err.code === "EADDRINUSE"
          ? `[virtual-plc] port ${port} is already in use — set VPLC_PORT.`
          : `[virtual-plc] failed to start: ${err.message}`,
      );
      process.exit(1);
    });
  const shutdown = () => plc.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
