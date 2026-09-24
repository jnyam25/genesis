/**
 * Captsone twin configuration.
 *
 * Everything that describes the physical line — tanks, nozzles, sensors,
 * stations, belt speed, timeouts, dispensing jitter — is data here. Adding a
 * tank is a config edit (append to `tanks`), NOT a code or barcode-format
 * change. The controller, barcode parser, and Node harness all read from this
 * single source of truth. Tank names/colors below are only defaults: operators
 * rename and recolor slots at runtime (tank-colors.ts).
 */

import type { SafetyConfig } from "./safety";

/** A single paint source: a tank + its proportional dispense valve + presence sensor. */
export interface TankConfig {
  /** Stable id used in barcodes, snapshots, and logs. */
  id: string;
  /** Human label shown in the HMI (default; operator-editable, see tank-colors.ts). */
  name: string;
  /** Hex color code for the HMI swatch (default; operator-editable). */
  colorCode: string;
  /** Tank capacity in milliliters. */
  capacityMl: number;
  /** Level (ml) below which the controller triggers an auto-refill. */
  refillThresholdMl: number;
  /** Flow (ml/second) through this tank's valve at `valveOpeningPct`. Recalibrate after changing the opening. */
  dispenseRateMlPerSec: number;
  /** Proportional valve opening while dispensing (0–100 %), sent to the PLC analog output. */
  valveOpeningPct: number;
}

/** A station along the belt. Order matters — containers visit them in order. */
export interface StationConfig {
  id: string;
  name: string;
  /** Belt distance from line start, in meters. */
  positionM: number;
}

/** Time a container spends at each non-dispense station (s). Each must stay below `sensorWaitTimeoutSec`. */
export interface StationTimesConfig {
  /** LABEL: labeling station applies the barcode label (microcontroller). */
  label: number;
  /** SCAN: barcode scanner reads the label (microcontroller). */
  scan: number;
  /** CAP: robotic arm places the lid (microcontroller). */
  cap: number;
  /** PRESS: lid press seats the lid (microcontroller). */
  press: number;
  /** QC: sort sensor re-confirms the bottle type; the fill check happens here. */
  qc: number;
  /** GATE: reject diverter decision. */
  gate: number;
  /** SORT: sort diverter sets the output lane. */
  sort: number;
}

/** One of the two output lanes after the sort diverter. */
export interface SortLaneConfig {
  id: string;
  name: string;
}

/**
 * Two-path sort after the reject diverter. The bottle type (and so the lane)
 * follows from the recipe total; the sort sensor at QC re-confirms it on the
 * physical line.
 */
export interface SortConfig {
  /** lanes[0] = diverter at rest, lanes[1] = diverter actuated. */
  lanes: [SortLaneConfig, SortLaneConfig];
  /** Recipes totalling at most this (ml) are small bottles → lanes[0]; larger → lanes[1]. */
  smallBottleMaxMl: number;
}

/** Ordering policy for turning per-tank volumes into ordered dispense steps. */
export type MixPolicy =
  | { kind: "sequential" }
  | { kind: "interleaved"; rounds: number };

export interface TwinConfig {
  /** Line identifier. */
  lineId: string;
  /** Belt speed (m/s). Drives per-station transit time in the harness. */
  beltSpeedMPerSec: number;
  /** Station spacing (m) used to convert belt speed into transit time. */
  stationSpacingM: number;
  /** Maximum containers allowed on the belt concurrently (pipelining cap). */
  maxConcurrentContainers: number;
  /** Sensor-wait timeout (s). A jam past this forces a reject. */
  sensorWaitTimeoutSec: number;
  /** Dispense-volume jitter, as a fraction of target (0.02 = ±2%). */
  dispenseVariance: number;
  /** Tanks / paint sources. Order = tank index used in barcodes. */
  tanks: TankConfig[];
  /**
   * Stations along the belt, in travel order: optional LABEL, SCAN, BAY-1..N,
   * optional MIX, optional CAP, optional PRESS, QC, GATE, optional SORT.
   * SCAN, QC and GATE are required.
   */
  stations: StationConfig[];
  /** Service time at each non-dispense station. */
  stationTimesSec: StationTimesConfig;
  /** Output lanes after the sort diverter (used when the line has a SORT station). */
  sort: SortConfig;
  /** Policy that orders per-tank volumes into dispense steps (mix_sequence). */
  mixPolicy: MixPolicy;
  /** Mixer run time at the MIX station (s). Ignored if there is no MIX station. */
  mixDurationSec: number;
  /** Auto-refill amount (ml) added when a tank drops below its threshold. */
  refillAmountMl: number;
  /** Rolling window for throughput (containers/min), in seconds. */
  throughputWindowSec: number;
  /** Emergency stops, safety reset policy, and local/remote control (see safety.ts). */
  safety: SafetyConfig;
  /** Mock barcode sensor emit period (s). */
  mockSensorPeriodSec: number;
  /** Snapshot emit period (s) for the Node harness. */
  snapshotPeriodSec: number;
}

/**
 * MAX_TANKS is the number of physical tank slots. The live tank count is
 * whatever `tanks.length` is; MAX_TANKS bounds the tank slots below and the
 * PLC register map (`plc/tag-map.ts`), which reserves one block per slot.
 */
export const MAX_TANKS = 8;

const TANK_DEFAULTS = { capacityMl: 5000, refillThresholdMl: 800, dispenseRateMlPerSec: 25, valveOpeningPct: 80 };

/**
 * Physical tank slots. Slot k (1-based) always carries id `Tk`, so a tank keeps
 * its id, colour, and PLC register block when modules are enabled/disabled at
 * runtime. The default line populates slots 1–3; "add tank" enables the next
 * free slot.
 */
export const TANK_SLOTS: TankConfig[] = [
  { id: "T1", name: "Titanium White",       colorCode: "#F4F1EA", ...TANK_DEFAULTS },
  { id: "T2", name: "Cadmium Red",          colorCode: "#C8362B", ...TANK_DEFAULTS },
  { id: "T3", name: "Ultramarine Blue",     colorCode: "#1F3A93", ...TANK_DEFAULTS },
  { id: "T4", name: "Hansa Yellow",         colorCode: "#F2C230", ...TANK_DEFAULTS },
  { id: "T5", name: "Phthalo Green",        colorCode: "#1F7A5A", ...TANK_DEFAULTS },
  { id: "T6", name: "Carbon Black",         colorCode: "#2B2B2B", ...TANK_DEFAULTS },
  { id: "T7", name: "Quinacridone Magenta", colorCode: "#A4245E", ...TANK_DEFAULTS },
  { id: "T8", name: "Burnt Sienna",         colorCode: "#8A4B2A", ...TANK_DEFAULTS },
];

/** 1-based slot number for a tank id (`T4` → 4), or null if it is not a slot id. */
export function tankSlot(tankId: string): number | null {
  const m = /^T(\d+)$/.exec(tankId);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= MAX_TANKS ? n : null;
}

export const DEFAULT_CONFIG: TwinConfig = {
  lineId: "CAP-LINE-01",
  beltSpeedMPerSec: 0.20,
  stationSpacingM: 0.50,
  maxConcurrentContainers: 4,
  sensorWaitTimeoutSec: 6.0,
  dispenseVariance: 0.02,
  tanks: TANK_SLOTS.slice(0, 3),
  stations: [
    { id: "LABEL",   name: "Labeling",         positionM: 0.0 },
    { id: "SCAN",    name: "Barcode Scan",     positionM: 0.5 },
    { id: "BAY-1",   name: "Fill Bay 1",       positionM: 1.0 },
    { id: "BAY-2",   name: "Fill Bay 2",       positionM: 1.5 },
    { id: "BAY-3",   name: "Fill Bay 3",       positionM: 2.0 },
    { id: "CAP",     name: "Capping Arm",      positionM: 2.5 },
    { id: "PRESS",   name: "Lid Press",        positionM: 3.0 },
    { id: "QC",      name: "Sort Sensor",      positionM: 3.5 },
    { id: "GATE",    name: "Reject Diverter",  positionM: 4.0 },
    { id: "SORT",    name: "Sort Diverter",    positionM: 4.5 },
  ],
  stationTimesSec: { label: 1.0, scan: 0.5, cap: 2.5, press: 0.8, qc: 0.4, gate: 0.3, sort: 0.3 },
  sort: {
    lanes: [
      { id: "A", name: "Lane A (small bottles)" },
      { id: "B", name: "Lane B (large bottles)" },
    ],
    smallBottleMaxMl: 250,
  },
  mixPolicy: { kind: "interleaved", rounds: 2 },
  mixDurationSec: 1.5,
  refillAmountMl: 4000,
  throughputWindowSec: 60,
  safety: {
    // Physical E-Stop buttons in PLC mask bit order: I_EStop_<Id>_Mon inputs.
    eStopButtons: [
      { id: "PANEL", name: "Local control panel" },
      { id: "ENTRY", name: "Line entry" },
      { id: "EXIT", name: "Line exit" },
    ],
    remoteResetAllowed: false,
    initialMode: "remote",
    startRunning: true,
  },
  mockSensorPeriodSec: 3.0,
  snapshotPeriodSec: 0.5,
};

/** A few sample preprinted barcodes used by the harness demo and tests. */
export const SAMPLE_BARCODES: string[] = [
  "PT1|T250|100,80,70",   // 3-tank mix, interleaved into 2 rounds
  "PT1|T300|120,90,90",   // 3-tank mix
  "PT1|T200|200",         // single volume on a 3-tank line — fails TANK_COUNT_MISMATCH (scan-reject demo)
  "PT1|T150|60,50,40",   // 3-tank mix
];
