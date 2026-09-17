/**
 * Twin snapshot types.
 *
 * This shape is the contract between the engine (digital twin) and the HMI.
 * The HMI must never assume fields beyond this shape; everything visual is
 * derived from these fields so the twin can swap transports (file, polling,
 * WebSocket) without frontend changes.
 */

export type ContainerStatus =
  | "idle"
  | "scan"
  | "scan-rejected"
  | `fill-${number}`
  | "mix"
  | "qc"
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

export interface Container {
  id: string;
  status: ContainerStatus;
  /** Current fill in milliliters (sum of all doses received so far). */
  fillMl: number;
  /** Target total fill in milliliters for this container's recipe. */
  targetMl: number;
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
  containers: Container[];
  counts: Counts;
  /** Containers completed per minute (rolling). */
  throughputCpm: number;
  oee: Oee;
  lastEvent: TwinEvent | null;
  /** Engine wall-clock timestamp (ms). */
  timestamp: number;
  /** True when the twin has not produced a snapshot yet. */
  connected: boolean;
}

/**
 * Optional operator commands the HMI can send back to the twin/engine.
 * Real transports (OPC UA/MQTT/WS) will proxy these to the PLC; the mock
 * implements them locally so the Manual/Jog screen is functional standalone.
 */
export interface TwinCommands {
  jogBelt(): void;
  firePusher(): void;
  addTank(): void;
  removeTank(tankId: string): void;
  eStop(): void;
  clearEStop(): void;
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
