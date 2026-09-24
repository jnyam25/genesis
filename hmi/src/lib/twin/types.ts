/**
 * Twin snapshot types.
 *
 * This shape is the contract between the engine (digital twin) and the HMI.
 * The HMI must never assume fields beyond this shape; everything visual is
 * derived from these fields so the twin can swap transports (file, polling,
 * WebSocket) without frontend changes.
 */

/**
 * Station-based container status, in belt order. Mirrors `HmiContainerStatus`
 * in twin/src/hmi.ts — keep in sync.
 *
 * - `qc` covers the sort sensor and the reject diverter; a bad-barcode
 *   container also reports `qc` while it rides unfilled from scan to the
 *   reject diverter.
 * - `mix` only occurs on lines configured with a mixer.
 * - Final statuses: `output` (accepted, see `Container.lane`), `rejected`, and
 *   `scan-rejected` (bad barcode, rejected into the normal reject lane).
 */
export type ContainerStatus =
  | "idle"
  | "label"
  | "scan"
  | "scan-rejected"
  | `fill-${number}`
  | "mix"
  | "cap"
  | "press"
  | "qc"
  | "sort"
  | "output"
  | "rejected";

export interface Tank {
  id: string;
  name: string;
  /** Hex color used for the paint, e.g. "#e53935". */
  colorCode: string;
  /** Current fill in milliliters. */
  levelMl: number;
  /** Total capacity in milliliters. */
  capacityMl: number;
}

/** An operator-editable tank name + color. */
export interface TankColor {
  name: string;
  /** "#RRGGBB" */
  colorCode: string;
}

/**
 * A tank slot (T1..T8, enabled or not) with its editable name/color.
 * Mirrors `HmiTankSlot` in twin/src/hmi.ts — keep in sync.
 */
export interface TankSlot extends TankColor {
  id: string;
  /** On the line right now. */
  enabled: boolean;
  /** Differs from the built-in default. */
  custom: boolean;
}

export const TANK_NAME_MAX_LENGTH = 24;

export interface Container {
  id: string;
  status: ContainerStatus;
  /** Current fill in milliliters (sum of all doses received so far). */
  fillMl: number;
  /** Target total fill in milliliters for this container's recipe. */
  targetMl: number;
  /**
   * Output lane after the sort diverter (index into `TwinState.sortLanes`;
   * 0 = Lane A, 1 = Lane B). Set once the recipe is known: where a `sort`
   * container is headed and where an `output` container went.
   */
  lane?: number;
}

/** An output lane after the sort diverter. */
export interface SortLane {
  id: string;
  name: string;
  /** Accepted containers sent to this lane. */
  count: number;
}

export interface Oee {
  availability: number;
  performance: number;
  quality: number;
  overall: number;
}

export interface Counts {
  accepted: number;
  rejected: number;
  total: number;
}

export interface TwinEvent {
  id: string;
  /** ISO timestamp. */
  at: number;
  severity: "info" | "warn" | "error" | "success";
  message: string;
}

export interface TwinState {
  tanks: Tank[];
  /** Optional: every tank slot with its editable name/color. Sources without it offer no color editor. */
  tankSlots?: TankSlot[];
  containers: Container[];
  counts: Counts;
  /** Optional: accepted counts per output lane after the sort diverter. */
  sortLanes?: SortLane[];
  /** Containers completed per minute (rolling). */
  throughputCpm: number;
  oee: Oee;
  lastEvent: TwinEvent | null;
  /**
   * Optional: recent events, newest first. Sources that can emit several events
   * between snapshots (the live twin) send this so the event log has no gaps;
   * sources without it (the mock) fall back to `lastEvent`.
   */
  recentEvents?: TwinEvent[];
  /** Safety / control-authority state. Optional: sources without it show no safety UI. */
  safety?: SafetyState;
  /** Engine wall-clock timestamp (ms). */
  timestamp: number;
  /** True when the twin has not produced a snapshot yet. */
  connected: boolean;
}

export type ControlMode = "local" | "remote";

/**
 * Emergency-stop, safety-circuit, and control-authority state.
 * Mirrors `SafetyState` in twin/src/safety.ts — keep in sync.
 */
export interface SafetyState {
  /** Any E-Stop (digital latched or physical pressed) is active. */
  eStopActive: boolean;
  /** Digital E-Stop latched from the HMI. */
  digitalEStop: boolean;
  /** Physical E-Stop buttons and whether each is pressed. */
  eStopButtons: { id: string; name: string; pressed: boolean }[];
  /** Safety relay closed: actuator power available. */
  safetyCircuitOk: boolean;
  /** No E-Stop active, but the safety circuit awaits RESET. */
  resetRequired: boolean;
  /** Line running. */
  running: boolean;
  /** Local/Remote key switch. LOCAL = HMI is view-only (except E-Stop and stop). */
  controlMode: ControlMode;
  /** Safety reset may be done from the HMI (Remote mode). */
  remoteResetAllowed: boolean;
  /** The source is a simulation: physical panel/E-Stop buttons can be operated from the HMI. */
  simulated: boolean;
}

/** Result of a command: null on success, otherwise why it was refused. */
export type CommandResult = Promise<string | null>;

export type LocalButton = "start" | "stop" | "reset" | "jog";

/**
 * Operator commands the HMI sends to the twin/PLC (source: remote). The
 * digital E-Stop and stop are always accepted; the rest follow the
 * safety/authority rules in `safety.ts`.
 */
export interface TwinCommands {
  /** Digital E-Stop: opens the safety circuit — the physical line shuts down. */
  eStop(): CommandResult;
  /** Release the latched digital E-Stop (does not reset or start). */
  releaseEStop(): CommandResult;
  /** Safety reset from the HMI (only where remote reset is allowed). */
  reset(): CommandResult;
  start(): CommandResult;
  stop(): CommandResult;
  jogBelt(): CommandResult;
  firePusher(): CommandResult;
  /** Enable the next free tank slot, optionally giving it a name and color. */
  addTank(color?: Partial<TankColor>): CommandResult;
  removeTank(tankId: string): CommandResult;
  /** Rename/recolor a tank slot (enabled or not). Presentation only: allowed in any mode. */
  setTankColor(tankId: string, color: Partial<TankColor>): CommandResult;
  /** Restore a slot's default name/color; every slot when tankId is omitted. */
  resetTankColor(tankId?: string): CommandResult;
  /**
   * Simulation only: operate the physical controls of a simulated line — the
   * local control panel and the physical E-Stop buttons.
   */
  sim?: {
    setControlMode(mode: ControlMode): CommandResult;
    pressLocalButton(button: LocalButton): CommandResult;
    setPhysicalEStop(buttonId: string, pressed: boolean): CommandResult;
  };
}

export const EMPTY_TWIN_STATE: TwinState = {
  tanks: [],
  containers: [],
  counts: { accepted: 0, rejected: 0, total: 0 },
  throughputCpm: 0,
  oee: { availability: 0, performance: 0, quality: 0, overall: 0 },
  lastEvent: null,
  timestamp: 0,
  connected: false,
};
