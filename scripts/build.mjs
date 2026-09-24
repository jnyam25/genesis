/**
 * Production build of both sub-projects.
 *
 *   node scripts/build.mjs          # HMI built against the live twin (http source)
 *   node scripts/build.mjs --mock   # HMI built with its built-in mock feed
 *
 * NEXT_PUBLIC_* values are inlined by `next build`, so the HMI data source is
 * chosen here, not at `npm start`. (TWIN_HTTP_URL is read at runtime.)
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, checkNodeVersion, hmiEnv, npmSpawnArgs } from "./lib.mjs";

checkNodeVersion();

const mock = process.argv.includes("--mock");
const steps = [
  ["twin", { ...process.env }],
  ["hmi", hmiEnv({ mock })],
];

for (const [project, env] of steps) {
  console.log(`\n[build] ${project}/${project === "hmi" ? ` (data source: ${env.NEXT_PUBLIC_TWIN_SOURCE ?? "from hmi/.env.local"})` : ""}`);
  const res = spawnSync(...npmSpawnArgs(["run", "build"], { cwd: join(ROOT, project), stdio: "inherit", env }));
  if (res.status !== 0) {
    console.error(`\n[build] ${project}/ failed.`);
    process.exit(res.status ?? 1);
  }
}
console.log("\n[build] done. Run `npm start`.");
