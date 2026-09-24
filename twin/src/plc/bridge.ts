/**
 * PLC bridge — runs on the Raspberry Pi and connects the physical line PLC to
 * the HMI.
 *
 * Polls the PLC over Modbus TCP using the register map in `tag-map.ts`, decodes
 * it into the same `HmiState` (for `/hmi/state`) and engine `Snapshot` (for
 * `/snapshot`) the simulated twin produces, and turns HMI operator commands
 * into command-coil pulses and tank-enable-mask writes. Tank names/colors are
 * Pi-side presentation data (`tank-colors.ts`) and never go to the PLC.
 *
 * The bridge never runs control logic: the PLC owns sequencing and all
 * interlocks. If the PLC is unreachable, silent (heartbeat frozen), or speaks a
 * different register-map version, the bridge reports "offline" and the HMI
 * shows a stale feed.
 */

import { DEFAULT_CONFIG, MAX_TANKS, TANK_SLOTS, tankSlot } from "../config";
import type { Snapshot, SnapshotContainer, SnapshotSortLane } from "../core";
import { EVENT_SEVERITY, EventCode, formatEvent } from "../events";
import {
  LOCAL_BUTTONS,
  addTankColor,
  applyTankColorCommand,
  hmiContainerId,
  hmiTankSlots,
  isKnownCommand,
  unknownCommandMessage,
  type CommandRequest,
  type HmiContainerStatus,
  type HmiEvent,
  type HmiState,
} from "../hmi";
import { SafetyCommand, authorize, type SafetyState } from "../safety";
import { TankPalette } from "../tank-colors";
import { ModbusTcpClient } from "./modbus";
import {
  COIL,
  CONTAINER_BLOCK,
  CONTAINER_FIELD,
  CONTAINER_SLOTS,
  CONTAINER_STATUS,
  EVENT_BLOCK,
  EVENT_FIELD,
  EVENT_SLOTS,
  LINE_STATE_BITS,
  PROTOCOL_VERSION,
  SIM,
  SYS,
  SYS_BLOCK,
  TANK_BLOCK,
  TANK_FIELD,
  TANK_FLAG_BITS,
  bit,
  containerRegister,
  eventRegister,
  tankRegister,
  u16,
} from "./tag-map";

export interface PlcBridgeOptions {
  host: string;
  port?: number;
  unitId?: number;
  pollMs?: number;
  /** PLC heartbeat must change within this window (ms) or the PLC is offline. */
  heartbeatTimeoutMs?: number;
  /**
   * Modbus address of register-map coil 0. 0 for the virtual PLC and for the
   * Micro850, whose Modbus mapping puts coil 0 at 000001 (docs/prototype/micro850-plc.md §2).
   * Non-zero only for a PLC with fixed coil memory elsewhere (e.g. a CLICK PLUS: 16384).
   */
  coilBase?: number;
  /** Operator tank names/colors. They live on the Pi, not in the PLC. */
  palette?: TankPalette;
}

export interface PlcStatus {
  online: boolean;
  connected: boolean;
  reason: string | null;
  lastPollAt: number | null;
  lineState: {
    running: boolean;
    eStopActive: boolean;
    digitalEStop: boolean;
    physicalEStop: boolean;
    resetRequired: boolean;
    localMode: boolean;
    simulation: boolean;
    safetyOk: boolean;
    fault: boolean;
    hmiLinkOk: boolean;
  } | null;
}

/** Register status code → HMI station status. */
export function hmiStatusFromCode(code: number): HmiContainerStatus | null {
  switch (code) {
    case CONTAINER_STATUS.LABEL:
      return "label";
    case CONTAINER_STATUS.SCAN:
      return "scan";
    case CONTAINER_STATUS.SCAN_REJECTED:
      return "scan-rejected";
    case CONTAINER_STATUS.MIX:
      return "mix";
    case CONTAINER_STATUS.CAP:
      return "cap";
    case CONTAINER_STATUS.QC:
      return "qc";
    case CONTAINER_STATUS.SORT:
      return "sort";
    case CONTAINER_STATUS.OUTPUT:
    case CONTAINER_STATUS.OUTPUT_LANE_B:
      return "output";
    case CONTAINER_STATUS.REJECTED:
      return "rejected";
  }
  if (code > CONTAINER_STATUS.FILL_BASE && code <= CONTAINER_STATUS.FILL_BASE + MAX_TANKS) {
    return `fill-${code - CONTAINER_STATUS.FILL_BASE}`;
  }
  return null;
}

/** Sort lane of an accepted container (index into config.sort.lanes); undefined while not yet sorted. */
export function laneFromCode(code: number): number | undefined {
  if (code === CONTAINER_STATUS.OUTPUT) return 0;
  if (code === CONTAINER_STATUS.OUTPUT_LANE_B) return 1;
  return undefined;
}

/** Register status code → engine container state (for `/snapshot`). */
function engineStatusFromCode(code: number): SnapshotContainer["status"] {
  if (code === CONTAINER_STATUS.OUTPUT || code === CONTAINER_STATUS.OUTPUT_LANE_B) return "ACCEPTED";
  if (code === CONTAINER_STATUS.REJECTED || code === CONTAINER_STATUS.SCAN_REJECTED) return "REJECTED";
  return "SERVING";
}

export class PlcBridge {
  private readonly client: ModbusTcpClient;
  private readonly opts: Required<PlcBridgeOptions>;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private registers = new Map<number, number>();
  private lastPollAt: number | null = null;
  private reason: string | null = "not started";
  private plcHeartbeat = -1;
  private plcHeartbeatChangedAt = 0;
  private hmiHeartbeat = 0;
  /** Detects PLC restarts (uptime going backwards) so event ids stay unique. */
  private epoch = 0;
  private lastUptime = -1;
  /** First time each event (by id) was seen — PLC events carry no timestamp. */
  private eventSeenAt = new Map<string, number>();
  readonly palette: TankPalette;

  constructor(options: PlcBridgeOptions) {
    this.palette = options.palette ?? new TankPalette();
    this.opts = { port: 502, unitId: 1, pollMs: 250, heartbeatTimeoutMs: 3000, coilBase: 0, ...options, palette: this.palette };
    this.client = new ModbusTcpClient({
      host: this.opts.host,
      port: this.opts.port,
      unitId: this.opts.unitId,
      timeoutMs: Math.max(500, this.opts.pollMs * 2),
    });
    this.client.on("error", () => {
      /* surfaced through status().reason on the next poll */
    });
  }

  start(): void {
    this.stopped = false;
    this.client.connect();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.client.close();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.poll().finally(() => this.schedule(this.opts.pollMs));
    }, delay);
  }

  /** One poll cycle. Public for tests. */
  async poll(): Promise<void> {
    if (!this.client.isConnected) {
      this.reason = `connecting to PLC at ${this.opts.host}:${this.opts.port}`;
      return;
    }
    try {
      const blocks = [SYS_BLOCK, TANK_BLOCK, CONTAINER_BLOCK, EVENT_BLOCK];
      const reads = await Promise.all(blocks.map((b) => this.client.readHoldingRegisters(b.start, b.length)));
      const next = new Map<number, number>();
      blocks.forEach((b, i) => reads[i].forEach((v, j) => next.set(b.start + j, v)));

      const version = next.get(SYS.PROTOCOL_VERSION) ?? 0;
      if (version !== PROTOCOL_VERSION) {
        this.reason = `PLC register map version ${version}, bridge expects ${PROTOCOL_VERSION}`;
        return;
      }

      const now = Date.now();
      const heartbeat = next.get(SYS.PLC_HEARTBEAT) ?? 0;
      if (heartbeat !== this.plcHeartbeat) {
        this.plcHeartbeat = heartbeat;
        this.plcHeartbeatChangedAt = now;
      }
      const uptime = next.get(SYS.UPTIME_S) ?? 0;
      if (uptime < this.lastUptime) this.epoch++;
      this.lastUptime = uptime;

      this.registers = next;
      this.lastPollAt = now;
      this.reason =
        now - this.plcHeartbeatChangedAt > this.opts.heartbeatTimeoutMs ? "PLC heartbeat stopped (PLC in program mode or faulted?)" : null;

      this.hmiHeartbeat = u16(this.hmiHeartbeat + 1);
      await this.client.writeSingleRegister(SYS.HMI_HEARTBEAT, this.hmiHeartbeat);
    } catch (err) {
      this.reason = `PLC poll failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private reg(address: number): number {
    return this.registers.get(address) ?? 0;
  }

  status(): PlcStatus {
    const online = this.client.isConnected && this.reason === null && this.lastPollAt !== null;
    const ls = this.lastPollAt !== null ? this.reg(SYS.LINE_STATE) : null;
    return {
      online,
      connected: this.client.isConnected,
      reason: online ? null : this.reason,
      lastPollAt: this.lastPollAt,
      lineState:
        ls === null
          ? null
          : {
              running: bit(ls, LINE_STATE_BITS.RUNNING),
              eStopActive: bit(ls, LINE_STATE_BITS.ESTOP_ACTIVE),
              digitalEStop: bit(ls, LINE_STATE_BITS.DIGITAL_ESTOP),
              physicalEStop: bit(ls, LINE_STATE_BITS.PHYSICAL_ESTOP),
              resetRequired: bit(ls, LINE_STATE_BITS.RESET_REQUIRED),
              localMode: bit(ls, LINE_STATE_BITS.LOCAL_MODE),
              simulation: bit(ls, LINE_STATE_BITS.SIMULATION),
              safetyOk: bit(ls, LINE_STATE_BITS.SAFETY_OK),
              fault: bit(ls, LINE_STATE_BITS.FAULT),
              hmiLinkOk: bit(ls, LINE_STATE_BITS.HMI_LINK_OK),
            },
    };
  }

  /** Safety / control-authority state decoded from Sys.LineState and Sys.PhysicalEStopMask. */
  safetyState(): SafetyState {
    const ls = this.reg(SYS.LINE_STATE);
    const mask = this.reg(SYS.PHYSICAL_ESTOP_MASK);
    return {
      eStopActive: bit(ls, LINE_STATE_BITS.ESTOP_ACTIVE),
      digitalEStop: bit(ls, LINE_STATE_BITS.DIGITAL_ESTOP),
      eStopButtons: DEFAULT_CONFIG.safety.eStopButtons.map((b, i) => ({ ...b, pressed: bit(mask, i) })),
      safetyCircuitOk: bit(ls, LINE_STATE_BITS.SAFETY_OK),
      resetRequired: bit(ls, LINE_STATE_BITS.RESET_REQUIRED),
      running: bit(ls, LINE_STATE_BITS.RUNNING),
      controlMode: bit(ls, LINE_STATE_BITS.LOCAL_MODE) ? "local" : "remote",
      remoteResetAllowed: bit(ls, LINE_STATE_BITS.REMOTE_RESET_ALLOWED),
      simulated: bit(ls, LINE_STATE_BITS.SIMULATION),
      faultActive: bit(ls, LINE_STATE_BITS.FAULT),
    };
  }

  private events(nowMs: number): HmiEvent[] {
    const out: HmiEvent[] = [];
    for (let i = 0; i < EVENT_SLOTS; i++) {
      const seq = this.reg(eventRegister(i, EVENT_FIELD.SEQ));
      if (seq === 0) continue;
      const code = this.reg(eventRegister(i, EVENT_FIELD.CODE));
      const arg1 = this.reg(eventRegister(i, EVENT_FIELD.ARG1));
      const arg2 = this.reg(eventRegister(i, EVENT_FIELD.ARG2));
      const id = `p${this.epoch}-${seq}`;
      if (!this.eventSeenAt.has(id)) this.eventSeenAt.set(id, nowMs);
      out.push({
        id,
        at: this.eventSeenAt.get(id)!,
        severity: EVENT_SEVERITY[code as EventCode] ?? "info",
        message: formatEvent(code, arg1, arg2, (slot) => this.palette.get(`T${slot}`)?.name),
      });
    }
    // Bound the seen-map to recent ids.
    if (this.eventSeenAt.size > 200) {
      const keep = new Set(out.map((e) => e.id));
      for (const id of this.eventSeenAt.keys()) if (!keep.has(id)) this.eventSeenAt.delete(id);
    }
    return out;
  }

  /** Live HMI state, or null while the PLC is offline. */
  hmiState(nowMs = Date.now()): HmiState | null {
    if (!this.status().online) return null;

    const tanks: HmiState["tanks"] = [];
    for (let slot = 1; slot <= MAX_TANKS; slot++) {
      if (!bit(this.reg(tankRegister(slot, TANK_FIELD.FLAGS)), TANK_FLAG_BITS.ENABLED)) continue;
      const id = TANK_SLOTS[slot - 1].id;
      const color = this.palette.get(id)!;
      tanks.push({
        id,
        name: color.name,
        colorCode: color.colorCode,
        levelMl: this.reg(tankRegister(slot, TANK_FIELD.LEVEL_ML_X10)) / 10,
        capacityMl: this.reg(tankRegister(slot, TANK_FIELD.CAPACITY_ML)),
      });
    }

    const containers: HmiState["containers"] = [];
    for (let i = 0; i < CONTAINER_SLOTS; i++) {
      const id = this.reg(containerRegister(i, CONTAINER_FIELD.ID));
      const code = this.reg(containerRegister(i, CONTAINER_FIELD.STATUS));
      const status = hmiStatusFromCode(code);
      if (id === 0 || !status) continue;
      const lane = laneFromCode(code);
      containers.push({
        id: hmiContainerId(id),
        status,
        fillMl: this.reg(containerRegister(i, CONTAINER_FIELD.FILL_ML_X10)) / 10,
        targetMl: this.reg(containerRegister(i, CONTAINER_FIELD.TARGET_ML_X10)) / 10,
        ...(lane === undefined ? {} : { lane }),
      });
    }

    const events = this.events(nowMs);
    return {
      tanks,
      tankSlots: hmiTankSlots(this.palette, tanks.map((t) => t.id)),
      containers,
      counts: {
        accepted: this.reg(SYS.COUNT_ACCEPTED),
        rejected: this.reg(SYS.COUNT_REJECTED),
        total: this.reg(SYS.COUNT_TOTAL),
      },
      sortLanes: this.sortLanes(),
      throughputCpm: this.reg(SYS.THROUGHPUT_CPM_X100) / 100,
      oee: {
        availability: this.reg(SYS.OEE_AVAILABILITY_X1000) / 1000,
        performance: this.reg(SYS.OEE_PERFORMANCE_X1000) / 1000,
        quality: this.reg(SYS.OEE_QUALITY_X1000) / 1000,
        overall: this.reg(SYS.OEE_OVERALL_X1000) / 1000,
      },
      lastEvent: events[0] ?? null,
      recentEvents: events,
      safety: this.safetyState(),
      timestamp: nowMs,
      connected: true,
    };
  }

  private sortLanes(): SnapshotSortLane[] {
    const counts = [this.reg(SYS.COUNT_LANE_A), this.reg(SYS.COUNT_LANE_B)];
    return DEFAULT_CONFIG.sort.lanes.map((l, i) => ({ id: l.id, name: l.name, count: counts[i] }));
  }

  /** Engine-contract snapshot for `/snapshot`, or null while offline. */
  snapshot(): Snapshot | null {
    const state = this.hmiState();
    if (!state) return null;
    const containers: SnapshotContainer[] = [];
    for (let i = 0; i < CONTAINER_SLOTS; i++) {
      const id = this.reg(containerRegister(i, CONTAINER_FIELD.ID));
      if (id === 0) continue;
      containers.push({
        id,
        status: engineStatusFromCode(this.reg(containerRegister(i, CONTAINER_FIELD.STATUS))),
        fillMl: this.reg(containerRegister(i, CONTAINER_FIELD.FILL_ML_X10)) / 10,
        targetMl: this.reg(containerRegister(i, CONTAINER_FIELD.TARGET_ML_X10)) / 10,
      });
    }
    return {
      tanks: state.tanks,
      containers,
      counts: state.counts,
      sortLanes: this.sortLanes(),
      throughputCpm: state.throughputCpm,
      oee: state.oee,
      lastEvent: state.lastEvent?.message ?? "",
      timestamp: this.reg(SYS.UPTIME_S),
    };
  }

  /**
   * Apply an HMI operator command. Resolves to an error message, or null on success.
   *
   * Commands are pre-checked with the same authorization rules the PLC applies
   * (safety.ts) so the operator gets an immediate, specific refusal; the PLC
   * remains authoritative and records its own COMMAND_REFUSED event if it
   * disagrees. The digital E-Stop and STOP are never pre-refused.
   */
  async command(req: CommandRequest): Promise<string | null> {
    const command = req.command;
    if (!isKnownCommand(command)) return unknownCommandMessage(command);
    if (command === "setTankColor" || command === "resetTankColor") {
      return applyTankColorCommand(
        { setTankColor: (id, c) => this.palette.set(id, c), resetTankColor: (id) => this.palette.reset(id) },
        req,
      );
    }
    if (!this.status().online) return `PLC offline: ${this.status().reason ?? "unknown"}`;

    const safety = this.safetyState();
    const precheck = (cmd: SafetyCommand): string | null => authorize(safety, cmd, "remote")?.message ?? null;
    const pulse = async (coil: number): Promise<null> => {
      await this.client.writeSingleCoil(this.opts.coilBase + coil, true);
      return null;
    };

    try {
      switch (command) {
        case "eStop":
          return await pulse(COIL.CMD_DIGITAL_ESTOP);
        case "stop":
          return await pulse(COIL.CMD_STOP);
        case "releaseEStop":
        case "clearEStop":
          return precheck(SafetyCommand.RELEASE_ESTOP) ?? (await pulse(COIL.CMD_RELEASE_ESTOP));
        case "reset":
          return precheck(SafetyCommand.RESET) ?? (await pulse(COIL.CMD_RESET));
        case "start":
          return precheck(SafetyCommand.START) ?? (await pulse(COIL.CMD_START));
        case "jogBelt":
          return precheck(SafetyCommand.JOG) ?? (await pulse(COIL.CMD_JOG));
        case "firePusher":
          return precheck(SafetyCommand.FIRE_PUSHER) ?? (await pulse(COIL.CMD_FIRE_PUSHER));
        case "addTank": {
          const color = addTankColor(req);
          if ("error" in color) return color.error;
          const refused = precheck(SafetyCommand.TANK_CHANGE);
          if (refused) return refused;
          const mask = this.reg(SYS.TANK_ENABLE_MASK);
          let slot = 1;
          while (slot <= MAX_TANKS && bit(mask, slot - 1)) slot++;
          if (slot > MAX_TANKS) return "all tank slots are already enabled";
          if (color.color) this.palette.set(TANK_SLOTS[slot - 1].id, color.color);
          await this.client.writeSingleRegister(SYS.TANK_ENABLE_MASK, mask | (1 << (slot - 1)));
          return null;
        }
        case "removeTank": {
          if (typeof req.tankId !== "string") return "removeTank requires a string tankId";
          const refused = precheck(SafetyCommand.TANK_CHANGE);
          if (refused) return refused;
          const slot = tankSlot(req.tankId);
          if (slot === null) return `unknown tank ${req.tankId}`;
          const mask = this.reg(SYS.TANK_ENABLE_MASK);
          const next = mask & ~(1 << (slot - 1));
          if (next === mask) return `tank ${req.tankId} is not enabled`;
          if (next === 0) return "cannot remove the last tank";
          await this.client.writeSingleRegister(SYS.TANK_ENABLE_MASK, next);
          return null;
        }
      }

      // Simulation-only commands operate the physical inputs of a simulated line.
      if (!safety.simulated) {
        return `${command} is only available on a simulated PLC — operate the physical controls on the line`;
      }
      switch (command) {
        case "simControlMode":
          if (req.mode !== "local" && req.mode !== "remote") return 'simControlMode requires mode "local" or "remote"';
          await this.client.writeSingleRegister(SIM.LOCAL_MODE, req.mode === "local" ? 1 : 0);
          return null;
        case "simLocalButton": {
          const coils: Record<string, number> = {
            start: COIL.SIM_LOCAL_START,
            stop: COIL.SIM_LOCAL_STOP,
            reset: COIL.SIM_LOCAL_RESET,
            jog: COIL.SIM_LOCAL_JOG,
          };
          const coil = typeof req.button === "string" ? coils[req.button] : undefined;
          if (coil === undefined) return `simLocalButton requires button ${LOCAL_BUTTONS.map((b) => `"${b}"`).join(" | ")}`;
          return await pulse(coil);
        }
        case "simPhysicalEStop": {
          const index = DEFAULT_CONFIG.safety.eStopButtons.findIndex((b) => b.id === req.buttonId);
          if (index < 0) {
            return `simPhysicalEStop requires buttonId one of ${DEFAULT_CONFIG.safety.eStopButtons.map((b) => b.id).join(", ")}`;
          }
          if (typeof req.pressed !== "boolean") return "simPhysicalEStop requires boolean pressed";
          const [current] = await this.client.readHoldingRegisters(SIM.PHYSICAL_ESTOP_MASK, 1);
          const next = req.pressed ? current | (1 << index) : current & ~(1 << index);
          await this.client.writeSingleRegister(SIM.PHYSICAL_ESTOP_MASK, next);
          return null;
        }
      }
    } catch (err) {
      return `PLC write failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  }
}
