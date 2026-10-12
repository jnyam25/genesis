/**
 * Preprinted barcode. Volumes are listed directly, one per tank, in slot order.
 *
 *   PT1|T<totalMl>|<v1>,<v2>,...,<vN>[|I<rounds>]
 *
 *   PT1          header
 *   T<totalMl>   target fill, ml
 *   v1..vN       ml from each tank (must match config.tanks.length)
 *   |I<rounds>   optional interleave override
 *
 *   PT1|T200|100,100     two tanks, 100+100 = 200
 *   PT1|T260|130,130|I4  two tanks, 4 mix rounds
 *
 * Header must be PT1, the volume count must match the tank count,
 * and the volumes must sum to the total.
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
