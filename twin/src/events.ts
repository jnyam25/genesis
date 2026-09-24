/**
 * Structured event and status codes shared by the twin core, the PLC register
 * map (`plc/tag-map.ts`), and the PLC bridge.
 *
 * A PLC cannot cheaply send human-readable strings, so every line event is a
 * numeric `EventCode` plus two numeric arguments. The twin core records the
 * same codes alongside its own messages, which keeps the simulated line and a
 * physical PLC reporting identical, comparable event streams. `formatEvent`
 * turns a code + args back into operator text on the Pi side.
 *
 * NUMBERS ARE A WIRE CONTRACT: never renumber existing entries; only append.
 */

import { DEFAULT_CONFIG, TANK_SLOTS } from "./config";

export type EventSeverity = "info" | "success" | "warn" | "error";

export enum EventCode {
  /** arg1: none. A barcode was read upstream and queued. */
  BARCODE_QUEUED = 1,
  /** arg1: container id. */
  CONTAINER_ENTERED = 2,
  /** arg1: container id, arg2: BarcodeErrorCode. */
  BARCODE_REJECTED = 3,
  /** arg1: container id, arg2: fill in 0.1 ml. */
  CONTAINER_ACCEPTED = 4,
  /** arg1: container id, arg2: RejectReason. */
  CONTAINER_REJECTED = 5,
  /** arg1: container id, arg2: StationCode where it jammed. */
  CONTAINER_JAMMED = 6,
  /** arg1: container id, arg2: tank slot that was no longer present. */
  DISPENSE_SKIPPED = 7,
  /** arg1: tank slot, arg2: level in ml. */
  TANK_LOW = 8,
  /** arg1: tank slot, arg2: level in ml. */
  TANK_REFILLED = 9,
  /** Deprecated (protocol v1 software stop). Not emitted since v2 — see DIGITAL_ESTOP / DIGITAL_ESTOP_RELEASED. */
  ESTOP = 10,
  /** Deprecated (protocol v1). */
  ESTOP_CLEARED = 11,
  /** arg1: containers in transit that were advanced. */
  JOG = 12,
  /** Jog refused because the line is running. */
  JOG_IGNORED = 13,
  /** arg1: container id rejected by the pusher. */
  PUSHER_FIRED = 14,
  /** Pusher fired with no container at QC/GATE. */
  PUSHER_NO_TARGET = 15,
  /** arg1: tank slot, arg2: active tank count after the change. */
  TANK_ENABLED = 16,
  /** arg1: tank slot, arg2: active tank count after the change. */
  TANK_DISABLED = 17,
  /** arg1: TankChangeRefusal. */
  TANK_CHANGE_REFUSED = 18,
  /** arg1: number of queued barcodes held back after a tank-count change. */
  STALE_BARCODES_HELD = 19,
  /** Hardware safety circuit opened (physical E-Stop, guard door). PLC only. */
  SAFETY_CIRCUIT_OPEN = 20,
  /** Hardware safety circuit restored. PLC only. */
  SAFETY_CIRCUIT_OK = 21,
  /** arg1: vendor fault code, arg2: StationCode or 0. PLC only. */
  FAULT = 22,
  /** Digital E-Stop activated (HMI). arg1: source (2 = remote). Opens the safety circuit. */
  DIGITAL_ESTOP = 23,
  /** Digital E-Stop released. arg1: source. */
  DIGITAL_ESTOP_RELEASED = 24,
  /** arg1: physical E-Stop button index (config.safety.eStopButtons). */
  PHYSICAL_ESTOP_PRESSED = 25,
  /** arg1: physical E-Stop button index. */
  PHYSICAL_ESTOP_RELEASED = 26,
  /** Safety circuit reset. arg1: source (1 local, 2 remote). */
  SAFETY_RESET = 27,
  /** arg1: source (1 local, 2 remote). */
  LINE_STARTED = 28,
  /** arg1: source (0 E-Stop, 1 local, 2 remote). */
  LINE_STOPPED = 29,
  /** arg1: 1 = LOCAL, 0 = REMOTE. */
  CONTROL_MODE_CHANGED = 30,
  /** arg1: SafetyCommand, arg2: RefusalReason. */
  COMMAND_REFUSED = 31,
}

/** Commands subject to safety/authority checks (wire contract: append only). */
export enum SafetyCommand {
  START = 1,
  STOP = 2,
  RESET = 3,
  JOG = 4,
  FIRE_PUSHER = 5,
  TANK_CHANGE = 6,
  RELEASE_ESTOP = 7,
  DIGITAL_ESTOP = 8,
  MODE_CHANGE = 9,
}

/** Why a command was refused (wire contract: append only). */
export enum RefusalReason {
  LOCAL_MODE = 1,
  REMOTE_MODE = 2,
  ESTOP_ACTIVE = 3,
  RESET_REQUIRED = 4,
  LINE_RUNNING = 5,
  REMOTE_RESET_NOT_ALLOWED = 6,
  ESTOP_STILL_PRESSED = 7,
  NOT_ACTIVE = 8,
}

export const REFUSAL_TEXT: Record<RefusalReason, string> = {
  [RefusalReason.LOCAL_MODE]: "local control is active — the HMI is view-only (switch the panel key to REMOTE)",
  [RefusalReason.REMOTE_MODE]: "remote control is active — local panel buttons are disabled (switch the panel key to LOCAL)",
  [RefusalReason.ESTOP_ACTIVE]: "an emergency stop is active",
  [RefusalReason.RESET_REQUIRED]: "safety reset required",
  [RefusalReason.LINE_RUNNING]: "stop the line first",
  [RefusalReason.REMOTE_RESET_NOT_ALLOWED]: "reset must be done at the local control panel",
  [RefusalReason.ESTOP_STILL_PRESSED]: "a physical E-Stop is still pressed — release it first",
  [RefusalReason.NOT_ACTIVE]: "the digital E-Stop is not active",
};

export const COMMAND_TEXT: Record<SafetyCommand, string> = {
  [SafetyCommand.START]: "start",
  [SafetyCommand.STOP]: "stop",
  [SafetyCommand.RESET]: "reset",
  [SafetyCommand.JOG]: "jog",
  [SafetyCommand.FIRE_PUSHER]: "fire reject diverter",
  [SafetyCommand.TANK_CHANGE]: "tank change",
  [SafetyCommand.RELEASE_ESTOP]: "release digital E-Stop",
  [SafetyCommand.DIGITAL_ESTOP]: "digital E-Stop",
  [SafetyCommand.MODE_CHANGE]: "mode change",
};

export enum RejectReason {
  BAD_BARCODE = 1,
  FILL_OUT_OF_TOLERANCE = 2,
  MANUAL_PUSHER = 3,
  WAIT_TIMEOUT = 4,
  SERVICE_TIMEOUT = 5,
  /** PLC only: the sort sensor read a different bottle type than the recipe calls for. */
  BOTTLE_TYPE_MISMATCH = 6,
  /** PLC only: a microcontroller station (label, cap, press) reported a fault or did not finish. */
  STATION_FAULT = 7,
}

export enum TankChangeRefusal {
  MAX_TANKS_REACHED = 1,
  NO_FREE_SLOT = 2,
  TANK_NOT_FOUND = 3,
  LAST_TANK = 4,
}

/** Numeric form of `BarcodeError.code` (0 = parsed OK). */
export const BARCODE_ERROR_CODES = {
  OK: 0,
  BAD_HEADER: 1,
  BAD_TOTAL: 2,
  TANK_COUNT_MISMATCH: 3,
  NEGATIVE_VOLUME: 4,
  VOLUME_SUM_MISMATCH: 5,
  MALFORMED: 6,
} as const;
export type BarcodeErrorName = keyof typeof BARCODE_ERROR_CODES;

/** Fixed station codes. BAY-n is 10+n; 0 = none/unknown. */
const STATION_CODES: Record<string, number> = {
  SCAN: 1,
  LABEL: 2,
  MIX: 20,
  QC: 21,
  GATE: 22,
  CAP: 23,
  PRESS: 24,
  SORT: 25,
};

/**
 * Station codes: SCAN=1, LABEL=2, BAY-n=10+n, MIX=20, QC=21, GATE=22, CAP=23,
 * PRESS=24, SORT=25, 0 = none/unknown.
 */
export function stationCode(stationId: string | null | undefined): number {
  if (!stationId) return 0;
  if (stationId in STATION_CODES) return STATION_CODES[stationId];
  const bay = /^BAY-(\d+)$/.exec(stationId);
  return bay ? 10 + Number(bay[1]) : 0;
}

export function stationIdFromCode(code: number): string | null {
  const fixed = Object.entries(STATION_CODES).find(([, v]) => v === code);
  if (fixed) return fixed[0];
  if (code >= 11 && code <= 19) return `BAY-${code - 10}`;
  return null;
}

export const EVENT_SEVERITY: Record<EventCode, EventSeverity> = {
  [EventCode.BARCODE_QUEUED]: "info",
  [EventCode.CONTAINER_ENTERED]: "info",
  [EventCode.BARCODE_REJECTED]: "warn",
  [EventCode.CONTAINER_ACCEPTED]: "success",
  [EventCode.CONTAINER_REJECTED]: "error",
  [EventCode.CONTAINER_JAMMED]: "error",
  [EventCode.DISPENSE_SKIPPED]: "warn",
  [EventCode.TANK_LOW]: "warn",
  [EventCode.TANK_REFILLED]: "success",
  [EventCode.ESTOP]: "error",
  [EventCode.ESTOP_CLEARED]: "success",
  [EventCode.JOG]: "info",
  [EventCode.JOG_IGNORED]: "warn",
  [EventCode.PUSHER_FIRED]: "warn",
  [EventCode.PUSHER_NO_TARGET]: "warn",
  [EventCode.TANK_ENABLED]: "warn",
  [EventCode.TANK_DISABLED]: "warn",
  [EventCode.TANK_CHANGE_REFUSED]: "warn",
  [EventCode.STALE_BARCODES_HELD]: "warn",
  [EventCode.SAFETY_CIRCUIT_OPEN]: "error",
  [EventCode.SAFETY_CIRCUIT_OK]: "success",
  [EventCode.FAULT]: "error",
  [EventCode.DIGITAL_ESTOP]: "error",
  [EventCode.DIGITAL_ESTOP_RELEASED]: "warn",
  [EventCode.PHYSICAL_ESTOP_PRESSED]: "error",
  [EventCode.PHYSICAL_ESTOP_RELEASED]: "warn",
  [EventCode.SAFETY_RESET]: "success",
  [EventCode.LINE_STARTED]: "success",
  [EventCode.LINE_STOPPED]: "warn",
  [EventCode.CONTROL_MODE_CHANGED]: "info",
  [EventCode.COMMAND_REFUSED]: "warn",
};

const REJECT_TEXT: Record<number, string> = {
  [RejectReason.BAD_BARCODE]: "bad barcode",
  [RejectReason.FILL_OUT_OF_TOLERANCE]: "fill out of tolerance",
  [RejectReason.MANUAL_PUSHER]: "manual reject (reject diverter)",
  [RejectReason.WAIT_TIMEOUT]: "wait timeout",
  [RejectReason.SERVICE_TIMEOUT]: "service timeout",
  [RejectReason.BOTTLE_TYPE_MISMATCH]: "bottle type does not match the recipe (sort sensor)",
  [RejectReason.STATION_FAULT]: "station fault (label, cap or press)",
};

const TANK_REFUSAL_TEXT: Record<number, string> = {
  [TankChangeRefusal.MAX_TANKS_REACHED]: "maximum tank count reached",
  [TankChangeRefusal.NO_FREE_SLOT]: "no free tank slot",
  [TankChangeRefusal.TANK_NOT_FOUND]: "tank not found",
  [TankChangeRefusal.LAST_TANK]: "cannot remove the last tank",
};

function barcodeErrorName(code: number): string {
  const entry = Object.entries(BARCODE_ERROR_CODES).find(([, v]) => v === code);
  return entry ? entry[0] : `code ${code}`;
}

/** Display name of a tank slot (1-based); undefined if the slot does not exist. */
export type TankNameLookup = (slot: number) => string | undefined;

const defaultTankName: TankNameLookup = (slot) => TANK_SLOTS[slot - 1]?.name;

const SOURCE_TEXT: Record<number, string> = { 0: "E-Stop", 1: "local", 2: "remote" };

function eStopButtonName(index: number): string {
  return DEFAULT_CONFIG.safety.eStopButtons[index]?.name ?? `button ${index + 1}`;
}

function containerLabel(id: number): string {
  return `C-${String(id).padStart(4, "0")}`;
}

/**
 * Operator text for a coded event (used for events that arrive from a PLC).
 * `tankName` supplies the operator's tank names (see tank-colors.ts).
 */
export function formatEvent(code: number, arg1: number, arg2: number, tankName: TankNameLookup = defaultTankName): string {
  const tankLabel = (slot: number): string => {
    const name = tankName(slot);
    return name === undefined ? `slot ${slot}` : `T${slot} (${name})`;
  };
  switch (code as EventCode) {
    case EventCode.BARCODE_QUEUED:
      return "barcode read — container queued";
    case EventCode.CONTAINER_ENTERED:
      return `${containerLabel(arg1)} entered the line`;
    case EventCode.BARCODE_REJECTED:
      return `${containerLabel(arg1)} barcode rejected: ${barcodeErrorName(arg2)}`;
    case EventCode.CONTAINER_ACCEPTED:
      return `${containerLabel(arg1)} ACCEPTED (fill ${(arg2 / 10).toFixed(1)} ml)`;
    case EventCode.CONTAINER_REJECTED:
      return `${containerLabel(arg1)} REJECTED — ${REJECT_TEXT[arg2] ?? `reason ${arg2}`}`;
    case EventCode.CONTAINER_JAMMED:
      return `${containerLabel(arg1)} JAMMED at ${stationIdFromCode(arg2) ?? "unknown station"}`;
    case EventCode.DISPENSE_SKIPPED:
      return `${containerLabel(arg1)} skipped dispense — tank ${tankLabel(arg2)} removed`;
    case EventCode.TANK_LOW:
      return `tank ${tankLabel(arg1)} low (${arg2} ml) — auto-refilling`;
    case EventCode.TANK_REFILLED:
      return `tank ${tankLabel(arg1)} refilled to ${arg2} ml`;
    case EventCode.ESTOP:
      return "E-STOP triggered — line halted (latched)";
    case EventCode.ESTOP_CLEARED:
      return "E-STOP cleared — line resumed";
    case EventCode.JOG:
      return `Manual: belt jog (${arg1} container(s) in transit)`;
    case EventCode.JOG_IGNORED:
      return "Manual: belt jog ignored — line is running (E-Stop first)";
    case EventCode.PUSHER_FIRED:
      return `Manual: reject diverter fired on ${containerLabel(arg1)}`;
    case EventCode.PUSHER_NO_TARGET:
      return "Manual: reject diverter fired — no container at the sort sensor or reject diverter";
    case EventCode.TANK_ENABLED:
      return `Manual: tank ${tankLabel(arg1)} added — line now has ${arg2} tanks`;
    case EventCode.TANK_DISABLED:
      return `Manual: tank ${tankLabel(arg1)} removed — line now has ${arg2} tanks`;
    case EventCode.TANK_CHANGE_REFUSED:
      return `Manual: tank change refused — ${TANK_REFUSAL_TEXT[arg1] ?? `reason ${arg1}`}`;
    case EventCode.STALE_BARCODES_HELD:
      return `${arg1} queued barcode(s) printed for the previous tank count held back from the line`;
    case EventCode.SAFETY_CIRCUIT_OPEN:
      return "SAFETY CIRCUIT OPEN — hardware E-Stop or guard interlock";
    case EventCode.SAFETY_CIRCUIT_OK:
      return "Safety circuit restored — reset required";
    case EventCode.FAULT:
      return `FAULT ${arg1}${arg2 ? ` at ${stationIdFromCode(arg2) ?? `station ${arg2}`}` : ""}`;
    case EventCode.DIGITAL_ESTOP:
      return "DIGITAL E-STOP activated from the HMI — safety circuit opened, all motion de-energized";
    case EventCode.DIGITAL_ESTOP_RELEASED:
      return "Digital E-Stop released — safety reset required at the local panel";
    case EventCode.PHYSICAL_ESTOP_PRESSED:
      return `PHYSICAL E-STOP pressed at ${eStopButtonName(arg1)} — safety circuit opened, all motion de-energized`;
    case EventCode.PHYSICAL_ESTOP_RELEASED:
      return `Physical E-Stop at ${eStopButtonName(arg1)} released — safety reset required`;
    case EventCode.SAFETY_RESET:
      return `Safety circuit reset (${SOURCE_TEXT[arg1] ?? arg1}) — press START to run`;
    case EventCode.LINE_STARTED:
      return `Line started (${SOURCE_TEXT[arg1] ?? arg1})`;
    case EventCode.LINE_STOPPED:
      return arg1 === 0 ? "Line stopped by emergency stop" : `Line stopped (${SOURCE_TEXT[arg1] ?? arg1})`;
    case EventCode.CONTROL_MODE_CHANGED:
      return arg1 === 1 ? "Control mode: LOCAL — HMI is view-only" : "Control mode: REMOTE";
    case EventCode.COMMAND_REFUSED:
      return `${COMMAND_TEXT[arg1 as SafetyCommand] ?? `command ${arg1}`} refused: ${REFUSAL_TEXT[arg2 as RefusalReason] ?? `reason ${arg2}`}`;
    default:
      return `event ${code} (${arg1}, ${arg2})`;
  }
}
