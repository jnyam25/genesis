/**
 * Captsone custom barcode format — parser + validator.
 *
 * The barcode is PREPRINTED on each container before it enters the line and
 * encodes the dispense instructions DIRECTLY: how many milliliters to draw
 * from EACH paint source (tank). It is NOT a recipe-id lookup. Adding a new
 * tank requires only (a) appending a tank to `config.tanks` and (b) printing
 * barcodes with one more comma-separated volume. No parser or controller
 * code changes.
 *
 * Format (version 1):
 *
 *   PT1|T<totalMl>|<v1>,<v2>,...,<vN>[|I<rounds>]
 *
 *   PT1            — literal header ("PaintTwin", format version 1)
 *   T<totalMl>     — target total fill volume in milliliters, e.g. T250
 *   <v1>,...,<vN> — per-tank volume in ml, in config.tanks order, e.g. 100,80,70
 *   |I<rounds>    — OPTIONAL override of the interleaving round count from
 *                   config.mixPolicy. Omit to use the config policy.
 *
 * Examples:
 *   PT1|T250|100,80,70       3 tanks, 100+80+70 = 250 ml total
 *   PT1|T300|120,90,90|I4     3 tanks, interleaved into 4 rounds
 *   PT1|T200|200              single-tank fill (pure color)
 *
 * Validation rules (see `parseBarcode`):
 *   - header must be exactly "PT1"
 *   - totalMl > 0
 *   - per-tank volume count must equal config.tanks.length
 *   - every per-tank volume >= 0
 *   - sum(per-tank) must equal totalMl within `toleranceMl`
 * A failing validation returns a structured error; the controller force-rejects.
 */

import type { TwinConfig } from "./config";

export interface ParsedBarcode {
  header: string;
  totalMl: number;
  /** Per-tank target volumes, indexed by config.tanks order. */
  perTankMl: number[];
  /** Optional interleaving override; null means "use config policy". */
  interleaveRounds: number | null;
  raw: string;
}

export class BarcodeError extends Error {
  constructor(
    public readonly code:
      | "BAD_HEADER"
      | "BAD_TOTAL"
      | "TANK_COUNT_MISMATCH"
      | "NEGATIVE_VOLUME"
      | "VOLUME_SUM_MISMATCH"
      | "MALFORMED",
    message: string,
  ) {
    super(message);
    this.name = "BarcodeError";
  }
}

export function parseBarcode(
  raw: string,
  config: TwinConfig,
  toleranceMl = 1,
): ParsedBarcode {
  const text = raw.trim();
  const parts = text.split("|");
  if (parts.length < 3 || parts.length > 4) {
    throw new BarcodeError("MALFORMED", `expected 3-4 fields, got ${parts.length}`);
  }
  const header = parts[0];
  if (header !== "PT1") {
    throw new BarcodeError("BAD_HEADER", `header must be "PT1", got "${header}"`);
  }
  const totalField = parts[1];
  if (!totalField.startsWith("T")) {
    throw new BarcodeError("BAD_TOTAL", `total field must start with T, got "${totalField}"`);
  }
  const totalMl = Number(totalField.slice(1));
  if (!Number.isFinite(totalMl) || totalMl <= 0) {
    throw new BarcodeError("BAD_TOTAL", `totalMl must be a positive number, got "${totalField}"`);
  }
  const volumeFields = parts[2].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const perTankMl = volumeFields.map((v) => Number(v));
  if (perTankMl.some((v) => !Number.isFinite(v))) {
    throw new BarcodeError("MALFORMED", `non-numeric volume in "${parts[2]}"`);
  }
  if (perTankMl.length !== config.tanks.length) {
    throw new BarcodeError(
      "TANK_COUNT_MISMATCH",
      `barcode lists ${perTankMl.length} tank volumes but config has ${config.tanks.length} tanks`,
    );
  }
  if (perTankMl.some((v) => v < 0)) {
    throw new BarcodeError("NEGATIVE_VOLUME", `negative volume in "${parts[2]}"`);
  }
  const sum = perTankMl.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - totalMl) > toleranceMl) {
    throw new BarcodeError(
      "VOLUME_SUM_MISMATCH",
      `sum(perTank)=${sum} != totalMl=${totalMl} (tolerance ${toleranceMl})`,
    );
  }
  let interleaveRounds: number | null = null;
  if (parts.length === 4) {
    const opt = parts[3];
    if (!opt.startsWith("I")) {
      throw new BarcodeError("MALFORMED", `unknown option field "${opt}"`);
    }
    interleaveRounds = Number(opt.slice(1));
    if (!Number.isFinite(interleaveRounds) || interleaveRounds < 1) {
      throw new BarcodeError("MALFORMED", `interleave rounds must be >= 1, got "${opt}"`);
    }
  }
  return { header, totalMl, perTankMl, interleaveRounds, raw: text };
}
