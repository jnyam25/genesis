/**
 * Installs dependencies for every sub-project (twin/, hmi/).
 *
 * Runs automatically after `npm install` at the repo root (postinstall), or on
 * demand via `npm run setup`. Uses `npm ci` so each machine gets exactly the
 * versions pinned in the committed lockfiles; falls back to `npm install` if a
 * lockfile is missing or out of sync with its package.json.
 *
 * `npm ci` also wipes any existing node_modules first, which is what we want
 * when the repo was copied from another computer: native binaries (Next SWC,
 * Tailwind oxide, lightningcss) are OS/CPU specific and must be reinstalled.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PROJECTS, checkNodeVersion, npmSpawnArgs } from "./lib.mjs";

checkNodeVersion();

const npm = (args, cwd) => spawnSync(...npmSpawnArgs(args, { cwd, stdio: "inherit" })).status === 0;

for (const project of PROJECTS) {
  const cwd = join(ROOT, project);
  console.log(`\n[setup] installing ${project}/ ...`);
  const hasLock = existsSync(join(cwd, "package-lock.json"));
  let ok = hasLock && npm(["ci", "--no-fund", "--no-audit"], cwd);
  if (!ok) {
    console.warn(`[setup] ${hasLock ? "npm ci failed" : "no lockfile"} in ${project}/ — falling back to npm install`);
    ok = npm(["install", "--no-fund", "--no-audit"], cwd);
  }
  if (!ok) {
    console.error(`\n[setup] failed to install ${project}/. Run \`npm run doctor\` for diagnostics.`);
    process.exit(1);
  }
}

console.log("\n[setup] done. Next: `npm run dev` (twin + HMI) — see INSTALL.md.");
