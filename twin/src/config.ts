/**
 * Captsone twin configuration.
 *
 * Everything that describes the physical line — tanks, nozzles, sensors,
 * stations, belt speed, timeouts, dispensing jitter — is data here. Adding a
 * new paint color / tank is a config edit (append to `tanks`), NOT a code or
 * barcode-format change. The controller, barcode parser, and Node harness all
 * read from this single source of truth.
 */

/** A single paint source: a tank + its dispense nozzle + presence sensor. */
export interface TankConfig {
  /** Stable id used in barcodes, snapshots, and logs. */
  id: string;
  /** Human label shown in the HMI. */
  name: string;
  /** Hex color code for the HMI swatch. */
  colorCode: string;
  /** Tank capacity in milliliters. */
  capacityMl: number;
  /** Level (ml) below which the controller triggers an auto-refill. */
  refillThresholdMl: number;
  /** Dispense rate (ml/second) for this tank's nozzle. */
  dispenseRateMlPerSec: number;
}

/** A station along the belt. Order matters — containers visit them in order. */
export interface StationConfig {
  id: string;
  name: string;
  /** Belt distance from line start, in meters. */
  positionM: number;
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
  /** Stations along the belt (scan, dispense bays, quality, accept/reject). */
  stations: StationConfig[];
  /** Policy that orders per-tank volumes into dispense steps (mix_sequence). */
  mixPolicy: MixPolicy;
  /** Auto-refill amount (ml) added when a tank drops below its threshold. */
  refillAmountMl: number;
  /** Mock barcode sensor emit period (s). */
  mockSensorPeriodSec: number;
  /** Snapshot emit period (s) for the Node harness. */
  snapshotPeriodSec: number;
}

/**
 * MAX_TANKS is a documented ceiling, not a hard limit. The controller creates
 * handles dynamically in `initialize()` from `config.tanks`, so the live tank
 * count is whatever `tanks.length` is. MAX_TANKS only guards against absurd
 * config and is referenced in the design doc as the bound we'd use if we ever
 * had to fall back to statically-declared handle fields. See
 * `docs/engine-design.md` § "Static-handle constraint".
 */
export const MAX_TANKS = 8;

export const DEFAULT_CONFIG: TwinConfig = {
  lineId: "CAP-LINE-01",
  beltSpeedMPerSec: 0.20,
  stationSpacingM: 0.50,
  maxConcurrentContainers: 4,
  sensorWaitTimeoutSec: 6.0,
  dispenseVariance: 0.02,
  tanks: [
    { id: "T1", name: "Titanium White",  colorCode: "#F4F1EA", capacityMl: 5000, refillThresholdMl: 800,  dispenseRateMlPerSec: 25 },
    { id: "T2", name: "Cadmium Red",     colorCode: "#C8362B", capacityMl: 5000, refillThresholdMl: 800,  dispenseRateMlPerSec: 25 },
    { id: "T3", name: "Ultramarine Blue", colorCode: "#1F3A93", capacityMl: 5000, refillThresholdMl: 800,  dispenseRateMlPerSec: 25 },
  ],
  stations: [
    { id: "SCAN",    name: "Barcode Scan",     positionM: 0.0 },
    { id: "BAY-1",   name: "Dispense Bay 1",   positionM: 0.5 },
    { id: "BAY-2",   name: "Dispense Bay 2",   positionM: 1.0 },
    { id: "BAY-3",   name: "Dispense Bay 3",   positionM: 1.5 },
    { id: "QC",      name: "Quality Check",    positionM: 2.0 },
    { id: "GATE",    name: "Accept/Reject",    positionM: 2.5 },
  ],
  mixPolicy: { kind: "interleaved", rounds: 2 },
  refillAmountMl: 4000,
  mockSensorPeriodSec: 3.0,
  snapshotPeriodSec: 0.5,
};

/** A few sample preprinted barcodes used by the harness demo and tests. */
export const SAMPLE_BARCODES: string[] = [
  "PT1|T250|100,80,70",   // 3-tank mix, interleaved into 2 rounds
  "PT1|T300|120,90,90",   // 3-tank mix
  "PT1|T200|200",         // single-tank (pure white) — still valid
  "PT1|T150|60,50,40",   // 3-tank mix
];
