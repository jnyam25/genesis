/**
 * Mock barcode feeder shared by the Node harness (`run.ts`) and the virtual PLC.
 * Stands in for containers arriving at the scanner with preprinted barcodes.
 */

import { DEFAULT_CONFIG, SAMPLE_BARCODES } from "./config";

/**
 * Barcode for the index-th container. With the configured tank count, cycle the
 * documented SAMPLE_BARCODES (one of which intentionally fails the scan). If an
 * operator has added/removed tanks, printed barcodes must carry one volume per
 * tank, so synthesize matching ones — keeping every 4th malformed so the
 * scan-reject path stays exercised.
 */
export function nextBarcode(index: number, tankCount: number): string {
  if (tankCount === DEFAULT_CONFIG.tanks.length) return SAMPLE_BARCODES[index % SAMPLE_BARCODES.length];
  if (index % 4 === 3) return "PT1|T200|200,x";
  const volumes = Array.from({ length: tankCount }, () => 40 + Math.round(Math.random() * 60));
  const total = volumes.reduce((a, b) => a + b, 0);
  return `PT1|T${total}|${volumes.join(",")}`;
}
