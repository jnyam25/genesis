/**
 * Captsone PLC register map (Modbus TCP) — the single source of truth for the
 * data exchanged between the line PLC and the Raspberry Pi bridge.
 *
 * Used by:
 *   - `plc/virtual-plc.ts` — a software PLC exposing the twin core on this map
 *   - `plc/bridge.ts`      — the Pi-side bridge that reads a (real or virtual)
 *                            PLC and serves the HMI
 *   - `plc/print-tag-map.ts` — generates the tables in docs/prototype/io-map.md
 *
 * The same tags are exposed as OPC UA nodes by name (see
 * docs/prototype/communication.md); `name` is the OPC UA browse name.
 *
 * Conventions
 *   - Addresses are 0-based PDU addresses. Classic "Modicon" numbering is
 *     address + 40001 for holding registers and address + 1 for coils.
 *   - All registers are UINT16. Scaled values state their factor
 *     (e.g. `_X10` = value × 10). Counters wrap at 65536.
 *   - Coils are command pulses: the writer sets 1, the PLC acts on the rising
 *     edge and resets the coil to 0 (acknowledge).
 *
 * NUMBERS ARE A WIRE CONTRACT: bump PROTOCOL_VERSION on any breaking change.
 */

import { MAX_TANKS } from "../config";

/**
 * v2: E-Stop / safety circuit / local-remote control bits, start/stop/reset coils, simulation block.
 * v3: bottling line from the BOM — sort lane counters, valve opening per tank, label/cap/press/sort
 *     container statuses, microcontroller station handshake block, E-Stops PANEL/ENTRY/EXIT.
 */
export const PROTOCOL_VERSION = 3;

export type Access = "R" | "RW";

export interface RegisterDef {
  address: number;
  name: string;
  access: Access;
  /** Engineering unit / scaling, for docs. */
  unit: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Holding registers — system block (0..19)
// ---------------------------------------------------------------------------

export const SYS = {
  PROTOCOL_VERSION: 0,
  PLC_HEARTBEAT: 1,
  LINE_STATE: 2,
  TANK_COUNT: 3,
  TANK_ENABLE_MASK: 4,
  COUNT_ACCEPTED: 5,
  COUNT_REJECTED: 6,
  COUNT_TOTAL: 7,
  THROUGHPUT_CPM_X100: 8,
  OEE_AVAILABILITY_X1000: 9,
  OEE_PERFORMANCE_X1000: 10,
  OEE_QUALITY_X1000: 11,
  OEE_OVERALL_X1000: 12,
  HMI_HEARTBEAT: 13,
  UPTIME_S: 14,
  ACTIVE_CONTAINERS: 15,
  /** bit i = physical E-Stop button i (config.safety.eStopButtons) pressed. */
  PHYSICAL_ESTOP_MASK: 16,
  /** Accepted containers sent to sort lane A (config.sort.lanes[0]). */
  COUNT_LANE_A: 17,
  /** Accepted containers sent to sort lane B (config.sort.lanes[1]). */
  COUNT_LANE_B: 18,
} as const;
export const SYS_BLOCK = { start: 0, length: 20 };

/** Bits of SYS.LINE_STATE. */
export const LINE_STATE_BITS = {
  /** Line running (run commanded, safety circuit closed, no E-Stop). */
  RUNNING: 0,
  /** Any emergency stop active (digital latched or physical pressed). */
  ESTOP_ACTIVE: 1,
  /** Safety relay closed — actuator power available (relay feedback input). */
  SAFETY_OK: 2,
  FAULT: 3,
  /** PLC sees the Pi/HMI heartbeat changing. */
  HMI_LINK_OK: 4,
  /** Digital E-Stop latched (from the HMI). */
  DIGITAL_ESTOP: 5,
  /** At least one physical E-Stop button pressed (see Sys.PhysicalEStopMask). */
  PHYSICAL_ESTOP: 6,
  /** No E-Stop active, but the safety circuit awaits RESET. */
  RESET_REQUIRED: 7,
  /** Local/Remote key switch in LOCAL: HMI is view-only (except digital E-Stop/stop). */
  LOCAL_MODE: 8,
  /** PLC accepts Cmd.Reset from the HMI (Remote mode only). */
  REMOTE_RESET_ALLOWED: 9,
  /** Simulation inputs active: Sim.* registers/coils drive the physical inputs. */
  SIMULATION: 10,
} as const;

// ---------------------------------------------------------------------------
// Holding registers — tank slots (20 + 6·(k-1), k = 1..MAX_TANKS)
// ---------------------------------------------------------------------------

export const TANK_BASE = 20;
export const TANK_SIZE = 6;
export const TANK_FIELD = {
  LEVEL_ML_X10: 0,
  CAPACITY_ML: 1,
  FLAGS: 2,
  REFILL_THRESHOLD_ML: 3,
  DISPENSE_RATE_ML_S_X10: 4,
  /** Proportional valve opening while dispensing, 0–100 % (drives AO_Valve_T<k>_Angle). */
  VALVE_OPENING_PCT: 5,
} as const;
export const TANK_FLAG_BITS = { ENABLED: 0, REFILLING: 1, LOW: 2 } as const;
export const TANK_BLOCK = { start: TANK_BASE, length: TANK_SIZE * MAX_TANKS };

export function tankRegister(slot: number, field: number): number {
  return TANK_BASE + (slot - 1) * TANK_SIZE + field;
}

// ---------------------------------------------------------------------------
// Holding registers — container tracking slots (100 + 5·i, i = 0..7)
// ---------------------------------------------------------------------------

export const CONTAINER_SLOTS = 8;
export const CONTAINER_BASE = 100;
export const CONTAINER_SIZE = 5;
export const CONTAINER_FIELD = {
  /** 0 = empty slot. */
  ID: 0,
  STATUS: 1,
  FILL_ML_X10: 2,
  TARGET_ML_X10: 3,
} as const;
export const CONTAINER_BLOCK = { start: CONTAINER_BASE, length: CONTAINER_SIZE * CONTAINER_SLOTS };

export function containerRegister(index: number, field: number): number {
  return CONTAINER_BASE + index * CONTAINER_SIZE + field;
}

/** CONTAINER_FIELD.STATUS values. FILL = 10 + bay number (11..18). */
export const CONTAINER_STATUS = {
  NONE: 0,
  SCAN: 1,
  SCAN_REJECTED: 2,
  LABEL: 3,
  FILL_BASE: 10,
  MIX: 20,
  QC: 21,
  /** Accepted, sorted to lane A (or accepted on a line without a sort diverter). */
  OUTPUT: 22,
  REJECTED: 23,
  CAP: 24,
  PRESS: 25,
  SORT: 26,
  /** Accepted, sorted to lane B. */
  OUTPUT_LANE_B: 27,
} as const;

// ---------------------------------------------------------------------------
// Holding registers — event ring (200..232)
// ---------------------------------------------------------------------------

export const EVENT_BASE = 200;
export const EVENT_SLOTS = 8;
export const EVENT_SIZE = 4;
/** EVENT_BASE holds the sequence number of the newest event (0 = none yet). */
export const EVENT_LAST_SEQ = EVENT_BASE;
/** Entries start at EVENT_BASE + 1, newest first. */
export const EVENT_FIELD = { SEQ: 0, CODE: 1, ARG1: 2, ARG2: 3 } as const;
export const EVENT_BLOCK = { start: EVENT_BASE, length: 1 + EVENT_SIZE * EVENT_SLOTS };

export function eventRegister(index: number, field: number): number {
  return EVENT_BASE + 1 + index * EVENT_SIZE + field;
}

// ---------------------------------------------------------------------------
// Holding registers — recipe mailbox (300..312), written by the scanner node
// ---------------------------------------------------------------------------

export const RECIPE = {
  /** Writer increments after filling the other fields. */
  SEQ: 300,
  /** BARCODE_ERROR_CODES value from the scanner-side parse (0 = OK). */
  PARSE_RESULT: 301,
  TOTAL_ML: 302,
  /** Interleave rounds override, 0 = use line policy. */
  ROUNDS: 303,
  /** VOL_1..VOL_8 at 304..311, ml per tank slot in barcode order. */
  VOL_BASE: 304,
  /** PLC copies SEQ here once the recipe is queued. */
  ACK_SEQ: 312,
} as const;
export const RECIPE_BLOCK = { start: 300, length: 13 };

// ---------------------------------------------------------------------------
// Holding registers — field node inputs (400..419), written by ESP32 nodes
// ---------------------------------------------------------------------------

export const FIELD = {
  /** Measured level per tank slot, 0.1 ml (400..407). */
  TANK_LEVEL_BASE: 400,
  /** Heartbeat of the tank-level node (increments ≥ 1 Hz). */
  TANK_NODE_HEARTBEAT: 410,
  /** Heartbeat of the scanner node (ESP32 #1: labeling station + barcode scanner). */
  SCANNER_NODE_HEARTBEAT: 411,
  /** Heartbeat of the station node (ESP32 #2: capping arm, lid press, sort sensor). */
  STATION_NODE_HEARTBEAT: 412,
} as const;
export const FIELD_BLOCK = { start: 400, length: 20 };

// ---------------------------------------------------------------------------
// Holding registers — microcontroller station handshake (420..430)
//
// The PLC holds a container at LABEL / CAP / PRESS and publishes its id in the
// station's Request register. The ESP32 runs the station (label applicator,
// arm sequence, press stroke) only while RunPermit = 1, then writes the same id
// to Done. The PLC releases the container when Done = Request, or faults it
// (RejectReason.STATION_FAULT) on timeout or a station fault bit.
// ---------------------------------------------------------------------------

export const STATION = {
  /** 1 = line running with the safety circuit closed. ESP32 actuators must stop when 0. */
  RUN_PERMIT: 420,
  LABEL_REQUEST: 421,
  LABEL_DONE: 422,
  CAP_REQUEST: 423,
  CAP_DONE: 424,
  PRESS_REQUEST: 425,
  PRESS_DONE: 426,
  /** Bottle type the sort sensor read at QC: 0 unknown, 1 = lanes[0] type, 2 = lanes[1] type. */
  SORT_SENSOR_TYPE: 427,
  /** Container id the sort-sensor reading belongs to. */
  SORT_SENSOR_CONTAINER: 428,
  /** Fault bits written only by the scanner node: bit0 labeler, bit1 scanner. */
  SCANNER_NODE_FAULTS: 429,
  /** Fault bits written only by the station node: bit0 capping arm, bit1 lid press, bit2 sort sensor. */
  STATION_NODE_FAULTS: 430,
} as const;
export const STATION_BLOCK = { start: 420, length: 11 };

// ---------------------------------------------------------------------------
// Coils — command pulses
// ---------------------------------------------------------------------------

export const COIL = {
  /** Digital E-Stop: PLC latches it and drops O_Safety_RemoteEStopOK (opens the safety circuit). */
  CMD_DIGITAL_ESTOP: 0,
  /** Release the digital E-Stop latch (does not reset or start). */
  CMD_RELEASE_ESTOP: 1,
  CMD_JOG: 2,
  CMD_FIRE_PUSHER: 3,
  CMD_START: 4,
  CMD_STOP: 5,
  /** Safety reset from the HMI — only honoured if REMOTE_RESET_ALLOWED and in Remote mode. */
  CMD_RESET: 6,
  /** Simulation only (LINE_STATE.SIMULATION): local panel push-buttons. */
  SIM_LOCAL_START: 8,
  SIM_LOCAL_STOP: 9,
  SIM_LOCAL_RESET: 10,
  SIM_LOCAL_JOG: 11,
} as const;
export const COIL_COUNT = 16;

// ---------------------------------------------------------------------------
// Holding registers — simulation inputs (450..451). Only honoured while
// LINE_STATE.SIMULATION = 1 (virtual PLC, or a PLC with SimInputs enabled).
// ---------------------------------------------------------------------------

export const SIM = {
  /** Simulated physical E-Stop buttons: bit i = button i pressed. */
  PHYSICAL_ESTOP_MASK: 450,
  /** Simulated Local/Remote key switch: 1 = LOCAL, 0 = REMOTE. */
  LOCAL_MODE: 451,
} as const;
export const SIM_BLOCK = { start: 450, length: 2 };

// ---------------------------------------------------------------------------
// Scaling helpers
// ---------------------------------------------------------------------------

export function u16(value: number): number {
  const v = Math.round(value);
  return ((v % 65536) + 65536) % 65536;
}

/** Clamp to UINT16 range (for non-wrapping quantities such as levels). */
export function clampU16(value: number): number {
  return Math.max(0, Math.min(65535, Math.round(value)));
}

export function bit(value: number, index: number): boolean {
  return ((value >> index) & 1) === 1;
}

// ---------------------------------------------------------------------------
// Documentation table
// ---------------------------------------------------------------------------

export function registerTable(): RegisterDef[] {
  const rows: RegisterDef[] = [
    { address: SYS.PROTOCOL_VERSION, name: "Sys.ProtocolVersion", access: "R", unit: "—", description: `Register map version (currently ${PROTOCOL_VERSION}). Bridge refuses to run on a mismatch.` },
    { address: SYS.PLC_HEARTBEAT, name: "Sys.PlcHeartbeat", access: "R", unit: "count", description: "Incremented by the PLC at ≥ 1 Hz. Bridge marks the PLC offline if it stops changing for 3 s." },
    { address: SYS.LINE_STATE, name: "Sys.LineState", access: "R", unit: "bits", description: "bit0 RUNNING, bit1 ESTOP_ACTIVE, bit2 SAFETY_OK (safety relay closed), bit3 FAULT, bit4 HMI_LINK_OK, bit5 DIGITAL_ESTOP, bit6 PHYSICAL_ESTOP, bit7 RESET_REQUIRED, bit8 LOCAL_MODE, bit9 REMOTE_RESET_ALLOWED, bit10 SIMULATION." },
    { address: SYS.TANK_COUNT, name: "Sys.TankCount", access: "R", unit: "count", description: "Enabled tank modules." },
    { address: SYS.TANK_ENABLE_MASK, name: "Sys.TankEnableMask", access: "RW", unit: "bits", description: "bit k-1 = tank slot k enabled. HMI add/remove tank writes this. PLC refuses a mask of 0; in-flight containers that still need a disabled tank are rejected (under-filled). Queued recipes with the old tank count are held back (event 19)." },
    { address: SYS.COUNT_ACCEPTED, name: "Counts.Accepted", access: "R", unit: "count", description: "Containers accepted since PLC start (wraps)." },
    { address: SYS.COUNT_REJECTED, name: "Counts.Rejected", access: "R", unit: "count", description: "Containers rejected, incl. scan rejects and jams (wraps)." },
    { address: SYS.COUNT_TOTAL, name: "Counts.Total", access: "R", unit: "count", description: "Accepted + rejected (wraps)." },
    { address: SYS.THROUGHPUT_CPM_X100, name: "Perf.ThroughputCpm", access: "R", unit: "cpm × 100", description: "Accepted containers per minute, rolling window." },
    { address: SYS.OEE_AVAILABILITY_X1000, name: "Oee.Availability", access: "R", unit: "× 1000", description: "0 while the line is not running (stopped, E-Stop, reset pending)." },
    { address: SYS.OEE_PERFORMANCE_X1000, name: "Oee.Performance", access: "R", unit: "× 1000", description: "" },
    { address: SYS.OEE_QUALITY_X1000, name: "Oee.Quality", access: "R", unit: "× 1000", description: "" },
    { address: SYS.OEE_OVERALL_X1000, name: "Oee.Overall", access: "R", unit: "× 1000", description: "" },
    { address: SYS.HMI_HEARTBEAT, name: "Sys.HmiHeartbeat", access: "RW", unit: "count", description: "Written by the Pi bridge every poll. PLC clears HMI_LINK_OK if it stops changing (alarm only — never a safety function)." },
    { address: SYS.UPTIME_S, name: "Sys.UptimeS", access: "R", unit: "s (wraps)", description: "Seconds since PLC run start." },
    { address: SYS.ACTIVE_CONTAINERS, name: "Sys.ActiveContainers", access: "R", unit: "count", description: "Containers currently on the belt." },
    { address: SYS.PHYSICAL_ESTOP_MASK, name: "Sys.PhysicalEStopMask", access: "R", unit: "bits", description: "bit i = physical E-Stop button i pressed, from the safety relay's monitoring contacts (bit0 local control panel, bit1 line entry, bit2 line exit — config.safety.eStopButtons)." },
    { address: SYS.COUNT_LANE_A, name: "Counts.LaneA", access: "R", unit: "count", description: "Accepted containers sorted to lane A (config.sort.lanes[0]) (wraps)." },
    { address: SYS.COUNT_LANE_B, name: "Counts.LaneB", access: "R", unit: "count", description: "Accepted containers sorted to lane B (config.sort.lanes[1]) (wraps)." },
  ];

  const tankFields: Array<[number, string, Access, string, string]> = [
    [TANK_FIELD.LEVEL_ML_X10, "LevelMl", "R", "ml × 10", "Measured level (from field node or analog input)."],
    [TANK_FIELD.CAPACITY_ML, "CapacityMl", "R", "ml", "Usable capacity."],
    [TANK_FIELD.FLAGS, "Flags", "R", "bits", "bit0 ENABLED, bit1 REFILLING, bit2 LOW."],
    [TANK_FIELD.REFILL_THRESHOLD_ML, "RefillThresholdMl", "R", "ml", "Auto-refill starts below this level."],
    [TANK_FIELD.DISPENSE_RATE_ML_S_X10, "DispenseRate", "R", "ml/s × 10", "Calibrated flow through the valve at ValveOpeningPct."],
    [TANK_FIELD.VALVE_OPENING_PCT, "ValveOpeningPct", "R", "%", "Proportional valve opening while dispensing (drives AO_Valve_T<k>_Angle)."],
  ];
  for (let slot = 1; slot <= MAX_TANKS; slot++) {
    for (const [field, name, access, unit, description] of tankFields) {
      rows.push({ address: tankRegister(slot, field), name: `Tank${slot}.${name}`, access, unit, description: slot === 1 ? description : "" });
    }
  }

  const containerFields: Array<[number, string, string, string]> = [
    [CONTAINER_FIELD.ID, "Id", "—", "Container id, 0 = empty slot."],
    [CONTAINER_FIELD.STATUS, "Status", "code", "0 none, 1 scan, 2 scan-rejected, 3 label, 11..18 fill at bay n (10+n), 20 mix, 21 sort sensor / reject diverter, 22 accepted to lane A, 23 rejected, 24 cap, 25 press, 26 sort diverter, 27 accepted to lane B."],
    [CONTAINER_FIELD.FILL_ML_X10, "FillMl", "ml × 10", "Dispensed so far."],
    [CONTAINER_FIELD.TARGET_ML_X10, "TargetMl", "ml × 10", "Recipe total."],
  ];
  for (let i = 0; i < CONTAINER_SLOTS; i++) {
    for (const [field, name, unit, description] of containerFields) {
      rows.push({ address: containerRegister(i, field), name: `Container${i + 1}.${name}`, access: "R", unit, description: i === 0 ? description : "" });
    }
  }

  rows.push({ address: EVENT_LAST_SEQ, name: "Events.LastSeq", access: "R", unit: "count", description: "Sequence number of the newest event (wraps; 0 = none)." });
  for (let i = 0; i < EVENT_SLOTS; i++) {
    const d = i === 0;
    rows.push({ address: eventRegister(i, EVENT_FIELD.SEQ), name: `Event${i + 1}.Seq`, access: "R", unit: "count", description: d ? "Entries are newest first; Event1 is the newest." : "" });
    rows.push({ address: eventRegister(i, EVENT_FIELD.CODE), name: `Event${i + 1}.Code`, access: "R", unit: "EventCode", description: d ? "See the event code table." : "" });
    rows.push({ address: eventRegister(i, EVENT_FIELD.ARG1), name: `Event${i + 1}.Arg1`, access: "R", unit: "—", description: "" });
    rows.push({ address: eventRegister(i, EVENT_FIELD.ARG2), name: `Event${i + 1}.Arg2`, access: "R", unit: "—", description: "" });
  }

  rows.push(
    { address: RECIPE.SEQ, name: "Recipe.Seq", access: "RW", unit: "count", description: "Scanner node increments after writing the fields below (write fields first, SEQ last)." },
    { address: RECIPE.PARSE_RESULT, name: "Recipe.ParseResult", access: "RW", unit: "code", description: "0 OK, 1 BAD_HEADER, 2 BAD_TOTAL, 3 TANK_COUNT_MISMATCH, 4 NEGATIVE_VOLUME, 5 VOLUME_SUM_MISMATCH, 6 MALFORMED. Non-zero → the container rides through unfilled and the reject diverter rejects it." },
    { address: RECIPE.TOTAL_ML, name: "Recipe.TotalMl", access: "RW", unit: "ml", description: "" },
    { address: RECIPE.ROUNDS, name: "Recipe.Rounds", access: "RW", unit: "count", description: "Interleave rounds override, 0 = line policy." },
  );
  for (let k = 1; k <= MAX_TANKS; k++) {
    rows.push({ address: RECIPE.VOL_BASE + k - 1, name: `Recipe.Vol${k}`, access: "RW", unit: "ml", description: k === 1 ? "Volume for the k-th enabled tank, in barcode order." : "" });
  }
  rows.push({ address: RECIPE.ACK_SEQ, name: "Recipe.AckSeq", access: "R", unit: "count", description: "PLC copies Recipe.Seq here once queued. Writer waits for AckSeq = Seq before the next recipe." });

  for (let k = 1; k <= MAX_TANKS; k++) {
    rows.push({ address: FIELD.TANK_LEVEL_BASE + k - 1, name: `Field.Tank${k}LevelMl`, access: "RW", unit: "ml × 10", description: k === 1 ? "Written by the ESP32 tank-level node; PLC validates range and heartbeat before using it." : "" });
  }
  rows.push(
    { address: FIELD.TANK_NODE_HEARTBEAT, name: "Field.TankNodeHeartbeat", access: "RW", unit: "count", description: "ESP32 tank node increments ≥ 1 Hz." },
    { address: FIELD.SCANNER_NODE_HEARTBEAT, name: "Field.ScannerNodeHeartbeat", access: "RW", unit: "count", description: "ESP32 scanner node (labeling + barcode scanner) increments ≥ 1 Hz." },
    { address: FIELD.STATION_NODE_HEARTBEAT, name: "Field.StationNodeHeartbeat", access: "RW", unit: "count", description: "ESP32 station node (capping arm, lid press, sort sensor) increments ≥ 1 Hz." },
    { address: STATION.RUN_PERMIT, name: "Station.RunPermit", access: "R", unit: "0/1", description: "1 = line running with the safety circuit closed. ESP32 nodes must stop their actuators when 0 or when Sys.PlcHeartbeat stops changing for 1 s. Not a safety function: actuator power still goes through the safety relay." },
    { address: STATION.LABEL_REQUEST, name: "Station.LabelRequest", access: "R", unit: "id", description: "Container id held at LABEL waiting for its label, 0 = none." },
    { address: STATION.LABEL_DONE, name: "Station.LabelDone", access: "RW", unit: "id", description: "Scanner node writes the container id once the label is applied." },
    { address: STATION.CAP_REQUEST, name: "Station.CapRequest", access: "R", unit: "id", description: "Container id held at CAP waiting for the arm to place a lid, 0 = none." },
    { address: STATION.CAP_DONE, name: "Station.CapDone", access: "RW", unit: "id", description: "Station node writes the container id once the lid is placed and the arm is clear." },
    { address: STATION.PRESS_REQUEST, name: "Station.PressRequest", access: "R", unit: "id", description: "Container id held at PRESS waiting for the lid press, 0 = none." },
    { address: STATION.PRESS_DONE, name: "Station.PressDone", access: "RW", unit: "id", description: "Station node writes the container id once the press has retracted." },
    { address: STATION.SORT_SENSOR_TYPE, name: "Station.SortSensorType", access: "RW", unit: "code", description: "Bottle type the sort sensor read: 0 unknown, 1 = lane A type, 2 = lane B type. PLC rejects on mismatch with the recipe (BOTTLE_TYPE_MISMATCH)." },
    { address: STATION.SORT_SENSOR_CONTAINER, name: "Station.SortSensorContainer", access: "RW", unit: "id", description: "Container id the sort-sensor reading belongs to." },
    { address: STATION.SCANNER_NODE_FAULTS, name: "Station.ScannerNodeFaults", access: "RW", unit: "bits", description: "Written only by the scanner node: bit0 labeler, bit1 scanner. Any bit → PLC raises FAULT and rejects the affected container (STATION_FAULT)." },
    { address: STATION.STATION_NODE_FAULTS, name: "Station.StationNodeFaults", access: "RW", unit: "bits", description: "Written only by the station node: bit0 capping arm, bit1 lid press, bit2 sort sensor. Same handling." },
    { address: SIM.PHYSICAL_ESTOP_MASK, name: "Sim.PhysicalEStopMask", access: "RW", unit: "bits", description: "SIMULATION ONLY: drives the physical E-Stop inputs. Ignored unless LineState.SIMULATION = 1. A physical PLC must never act on it with real outputs powered." },
    { address: SIM.LOCAL_MODE, name: "Sim.LocalMode", access: "RW", unit: "0/1", description: "SIMULATION ONLY: Local/Remote key switch (1 = LOCAL)." },
  );
  return rows;
}

export function coilTable(): RegisterDef[] {
  return [
    { address: COIL.CMD_DIGITAL_ESTOP, name: "Cmd.DigitalEStop", access: "RW", unit: "pulse", description: "Digital E-Stop. PLC latches DIGITAL_ESTOP and de-energizes O_Safety_RemoteEStopOK, which opens the hardwired safety circuit. Always accepted, any mode." },
    { address: COIL.CMD_RELEASE_ESTOP, name: "Cmd.ReleaseEStop", access: "RW", unit: "pulse", description: "Release the digital E-Stop latch. Does not reset or start the line." },
    { address: COIL.CMD_JOG, name: "Cmd.Jog", access: "RW", unit: "pulse", description: "Jog the belt one step. Remote mode, line stopped, safety circuit reset." },
    { address: COIL.CMD_FIRE_PUSHER, name: "Cmd.FirePusher", access: "RW", unit: "pulse", description: "Fire the reject diverter on the container at the sort sensor or reject diverter. Remote mode, no E-Stop." },
    { address: COIL.CMD_START, name: "Cmd.Start", access: "RW", unit: "pulse", description: "Start the line. Remote mode, safety circuit reset, no E-Stop." },
    { address: COIL.CMD_STOP, name: "Cmd.Stop", access: "RW", unit: "pulse", description: "Controlled stop. Always accepted, any mode." },
    { address: COIL.CMD_RESET, name: "Cmd.Reset", access: "RW", unit: "pulse", description: "Safety reset from the HMI. Only if REMOTE_RESET_ALLOWED, Remote mode, and no E-Stop active; otherwise refused (event COMMAND_REFUSED)." },
    { address: COIL.SIM_LOCAL_START, name: "Sim.LocalStart", access: "RW", unit: "pulse", description: "SIMULATION ONLY: local panel START push-button." },
    { address: COIL.SIM_LOCAL_STOP, name: "Sim.LocalStop", access: "RW", unit: "pulse", description: "SIMULATION ONLY: local panel STOP push-button." },
    { address: COIL.SIM_LOCAL_RESET, name: "Sim.LocalReset", access: "RW", unit: "pulse", description: "SIMULATION ONLY: local panel RESET push-button." },
    { address: COIL.SIM_LOCAL_JOG, name: "Sim.LocalJog", access: "RW", unit: "pulse", description: "SIMULATION ONLY: local panel JOG push-button." },
  ];
}
