/**
 * Removes installed dependencies and build output from every sub-project.
 * Use before copying the repo to a USB drive / another machine, or to force a
 * clean reinstall (`npm run clean && npm install`).
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PROJECTS } from "./lib.mjs";

const targets = [
  ...PROJECTS.map((p) => join(p, "node_modules")),
  join("twin", "dist"),
  join("twin", "runtime"),
  join("hmi", ".next"),
  join("hmi", "next-env.d.ts"),
  join("hmi", "tsconfig.tsbuildinfo"),
];

for (const rel of targets) {
  rmSync(join(ROOT, rel), { recursive: true, force: true });
  console.log(`[clean] removed ${rel}`);
}
console.log("[clean] done. Root node_modules (if any) is left alone.");
