/**
 * Virtual PLC — the twin core behind the real PLC register map.
 *
 * Runs the simulated line and exposes it over Modbus TCP exactly as the
 * physical Micro850 PLC is specified to (docs/prototype/io-map.md). Use it
 * to develop and test the bridge, the HMI, and the ESP32 node firmware before
 * the hardware exists, and as the reference implementation of the register
 * semantics for the PLC programmer (docs/prototype/micro850-plc.md).
 *
 * LABEL / CAP / PRESS: the Station.*Request registers and Station.RunPermit are
 * published, but each station completes on the core's own timer; Station.*Done
 * writes from an ESP32 are accepted and ignored.
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
 *      VPLC_FEED=0 to disable the built-in barcode feeder (then only recipes
 *      written to the Recipe mailbox — e.g. by the ESP32 scanner node — enter).
 *
 * Port 5020 instead of 502 so it runs without admin/root rights.
 */

import { DEFAULT_CONFIG, MAX_TANKS, TANK_SLOTS, tankSlot } from "../config";
import { TwinCore } from "../core";
import { TankChangeRefusal } from "../events";
import { nextBarcode } from "../feeder";
import { hmiStatus, liveOee, visibleContainers } from "../hmi";
import { ModbusTcpServer, type WriteEvent } from "./modbus";
import {
  COIL,
  COIL_COUNT,
  CONTAINER_FIELD,
  CONTAINER_SLOTS,
  CONTAINER_STATUS,
  EVENT_FIELD,
  EVENT_LAST_SEQ,
  EVENT_SLOTS,
  LINE_STATE_BITS,
  PROTOCOL_VERSION,
  RECIPE,
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
} from "./tag-map";

const SCAN_PERIOD_SEC = 0.1;
const HMI_LINK_TIMEOUT_SEC = 3;
const REGISTER_SPACE = 500;

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
    case "press":
      return CONTAINER_STATUS.PRESS;
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

export interface VirtualPlcOptions {
  /** Feed sample barcodes like the Node harness does. */
  feed?: boolean;
  unitId?: number;
}

export class VirtualPlc {
  readonly core = new TwinCore(DEFAULT_CONFIG);
  readonly server: ModbusTcpServer;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat = 0;
  private feedTimer = 0;
  private barcodeIdx = 0;
  private lastHmiHeartbeat = -1;
  private hmiHeartbeatChangedAt = -Infinity;
  private readonly feed: boolean;

  constructor(options: VirtualPlcOptions = {}) {
    this.feed = options.feed ?? true;
    this.server = new ModbusTcpServer({
      holdingRegisters: REGISTER_SPACE,
      coils: COIL_COUNT,
      unitId: options.unitId,
    });
    this.server.on("write", (w: WriteEvent) => this.onWrite(w));
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
    this.handleSimulatedInputs();
    this.handleCommandCoils();
    this.handleRecipeMailbox();
    this.core.tick(dt);

    if (this.feed) {
      this.feedTimer += dt;
      if (this.feedTimer >= DEFAULT_CONFIG.mockSensorPeriodSec && this.core.queuedBarcodes < DEFAULT_CONFIG.maxConcurrentContainers) {
        this.feedTimer = 0;
        this.core.enqueueBarcode(nextBarcode(this.barcodeIdx++, this.core.tanks.length));
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
    if (take(COIL.CMD_RESET)) this.core.reset("remote");
    if (take(COIL.SIM_LOCAL_RESET)) this.core.reset("local");
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

  /**
   * Recipe mailbox: the scanner node writes the parsed barcode fields and then
   * increments Recipe.Seq. The virtual PLC re-encodes it as a barcode for the
   * core (which re-validates it) and acknowledges.
   */
  private handleRecipeMailbox(): void {
    const r = this.server.registers;
    const seq = r[RECIPE.SEQ];
    if (seq === 0 || seq === r[RECIPE.ACK_SEQ]) return;
    const parseResult = r[RECIPE.PARSE_RESULT];
    let barcode: string;
    if (parseResult !== 0) {
      barcode = `SCANNER-ERROR|${parseResult}`;
    } else {
      const volumes = Array.from({ length: this.core.tanks.length }, (_, i) => r[RECIPE.VOL_BASE + i]);
      const rounds = r[RECIPE.ROUNDS];
      barcode = `PT1|T${r[RECIPE.TOTAL_ML]}|${volumes.join(",")}${rounds > 0 ? `|I${rounds}` : ""}`;
    }
    this.core.enqueueBarcode(barcode);
    r[RECIPE.ACK_SEQ] = seq;
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
    r[SYS.PHYSICAL_ESTOP_MASK] = core.safety.physicalMask();

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

    // Microcontroller stations: requests + run permit. The simulated stations
    // complete on the core's timers, so Done registers are not required here.
    const heldAt = (stationId: string) => core.containers.find((c) => c.occupyingStationId === stationId && c.state === "SERVING");
    r[STATION.RUN_PERMIT] = safety.running ? 1 : 0;
    r[STATION.LABEL_REQUEST] = u16(heldAt("LABEL")?.id ?? 0);
    r[STATION.CAP_REQUEST] = u16(heldAt("CAP")?.id ?? 0);
    r[STATION.PRESS_REQUEST] = u16(heldAt("PRESS")?.id ?? 0);

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
  const plc = new VirtualPlc({ feed: process.env.VPLC_FEED !== "0", unitId });
  plc
    .start(port, host)
    .then(() => {
      console.log(`[virtual-plc] Modbus TCP server on ${host}:${port} (unit id ${unitId}, protocol v${PROTOCOL_VERSION})`);
      console.log(`[virtual-plc] barcode feeder ${process.env.VPLC_FEED === "0" ? "OFF (recipe mailbox only)" : "ON"}`);
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
