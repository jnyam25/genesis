/**
 * Runs the same npm script in twin/ and hmi/ in parallel with prefixed output.
 *
 *   node scripts/run-all.mjs dev            # twin + HMI dev server, HMI wired to the live twin
 *   node scripts/run-all.mjs dev --mock     # same, but the HMI uses its built-in mock feed
 *   node scripts/run-all.mjs dev --plc-sim  # virtual PLC (Modbus TCP) + twin in PLC-bridge mode + HMI:
 *                                           # the physical-prototype architecture, entirely in software
 *   node scripts/run-all.mjs start          # production: requires `npm run build` first
 *
 * Ctrl+C stops everything. If any process exits, the others are stopped too.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PROJECTS, HMI_PORT, TWIN_PORT, checkNodeVersion, hmiEnv, npmSpawnArgs } from "./lib.mjs";

checkNodeVersion();

const script = process.argv[2];
const mock = process.argv.includes("--mock");
const plcSim = process.argv.includes("--plc-sim");
const VPLC_PORT = Number(process.env.VPLC_PORT ?? 5020);
if (!script) {
  console.error("usage: node scripts/run-all.mjs <npm-script> [--mock | --plc-sim]");
  process.exit(1);
}

for (const project of PROJECTS) {
  if (!existsSync(join(ROOT, project, "node_modules"))) {
    console.error(`[captsone] ${project}/node_modules is missing — run \`npm install\` at the repo root first.`);
    process.exit(1);
  }
}
if (script === "start" && !existsSync(join(ROOT, "hmi", ".next", "BUILD_ID"))) {
  console.error("[captsone] no production build found — run `npm run build` first.");
  process.exit(1);
}

const isWin = process.platform === "win32";
const colors = { vplc: "\x1b[33m", twin: "\x1b[36m", hmi: "\x1b[35m" };
const children = new Map();
let shuttingDown = false;

function pipe(stream, name) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) process.stdout.write(`${colors[name]}[${name}]\x1b[0m ${line}\n`);
  });
}

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    if (child.exitCode !== null) continue;
    // With shell:true on Windows, kill() only ends cmd.exe; take down the whole tree.
    if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGINT");
  }
  setTimeout(() => process.exit(code), 500);
}

const twinEnv = plcSim
  ? { ...process.env, CAPTSONE_MODE: "plc", PLC_HOST: "127.0.0.1", PLC_PORT: String(VPLC_PORT) }
  : { ...process.env };

if (plcSim) {
  // Compile the twin once so the virtual PLC and the bridge don't run two
  // TypeScript compilers against the same dist/ concurrently.
  console.log("[captsone] building twin for --plc-sim ...");
  const build = spawnSync(...npmSpawnArgs(["run", "build"], { cwd: join(ROOT, "twin"), stdio: "inherit" }));
  if (build.status !== 0) process.exit(build.status ?? 1);
}

/** [name, directory, npm script, env] */
const processes = [
  ...(plcSim ? [["vplc", "twin", "start:virtual-plc", { ...process.env, VPLC_PORT: String(VPLC_PORT) }]] : []),
  ["twin", "twin", plcSim ? "start" : script, twinEnv],
  ["hmi", "hmi", script, hmiEnv({ mock })],
];

for (const [name, dir, npmScript, env] of processes) {
  const child = spawn(
    ...npmSpawnArgs(["run", npmScript], {
      cwd: join(ROOT, dir),
      env: { ...env, FORCE_COLOR: "1" },
    }),
  );
  pipe(child.stdout, name);
  pipe(child.stderr, name);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`[captsone] ${name} exited (code ${code}) — stopping the rest.`);
      stopAll(code ?? 1);
    }
  });
  children.set(name, child);
}

const hmiSource = processes.find(([name]) => name === "hmi")[3].NEXT_PUBLIC_TWIN_SOURCE;
const source = script === "start" ? "as built" : (hmiSource ?? "from hmi/.env.local");
console.log(
  `[captsone] running "${script}" in ${processes.map(([name]) => name).join(" + ")}\n` +
    (plcSim ? `           Virtual PLC: Modbus TCP 127.0.0.1:${VPLC_PORT} (twin runs in PLC-bridge mode)\n` : "") +
    `           HMI:  http://localhost:${HMI_PORT}  (data source: ${source})\n` +
    `           Twin: http://127.0.0.1:${TWIN_PORT}/  (snapshot: /snapshot, HMI state: /hmi/state, health: /health)\n` +
    `           Ctrl+C to stop.`,
);

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
