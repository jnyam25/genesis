/**
 * Runs FUXA (open-source SCADA/HMI, MIT) natively — no Docker, no admin rights.
 *
 *   npm run fuxa            # installs deploy/fuxa on first use, then starts FUXA
 *   npm run fuxa -- --load  # also (re)loads the generated Captsone project
 *
 * FUXA is installed from npm into deploy/fuxa/node_modules and keeps its
 * project, logs and history in deploy/fuxa/data (both gitignored). On the very
 * first start — or with --load — the project generated from the PLC register
 * map (twin/src/plc/fuxa-project.ts) is loaded, pointing at PLC_HOST:PLC_PORT
 * (default: the virtual PLC on 127.0.0.1:5020).
 *
 * Environment: FUXA_PORT (1881), FUXA_HOST (127.0.0.1 — set 0.0.0.0 to serve
 * panels on the LAN, after enabling authentication in FUXA's settings),
 * FUXA_DATA (deploy/fuxa/data), PLC_HOST, PLC_PORT, PLC_UNIT_ID, and
 * FUXA_COMMANDS=1 to include command buttons (the project is read-only by default).
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, checkNodeVersion, npmSpawnArgs } from "./lib.mjs";

checkNodeVersion();

const FUXA_DIR = join(ROOT, "deploy", "fuxa");
const APP_DIR = join(FUXA_DIR, "node_modules", "@frangoteam", "fuxa");
const DATA_DIR = resolve(process.env.FUXA_DATA ?? join(FUXA_DIR, "data"));
const PORT = Number(process.env.FUXA_PORT ?? 1881);
const URL = `http://127.0.0.1:${PORT}`;

const npm = (args, cwd, env = process.env) => spawnSync(...npmSpawnArgs(args, { cwd, env, stdio: "inherit" })).status === 0;

if (!existsSync(join(APP_DIR, "main.js"))) {
  console.log("[fuxa] installing FUXA into deploy/fuxa (first run, a few minutes) ...");
  const ok = npm(["ci", "--no-fund", "--no-audit"], FUXA_DIR) || npm(["install", "--no-fund", "--no-audit"], FUXA_DIR);
  if (!ok || !existsSync(join(APP_DIR, "main.js"))) {
    console.error("[fuxa] install failed. Behind a TLS-inspecting proxy, retry with NODE_OPTIONS=--use-system-ca.");
    process.exit(1);
  }
}

// FUXA copies settings.default.js on first start; seed it ourselves so it listens
// on loopback unless FUXA_HOST says otherwise.
const appData = join(DATA_DIR, "_appdata");
const settingsFile = join(appData, "settings.js");
const firstRun = !existsSync(join(appData, "project.fuxap.db"));
if (!existsSync(settingsFile)) {
  mkdirSync(appData, { recursive: true });
  copyFileSync(join(APP_DIR, "settings.default.js"), settingsFile);
  const text = readFileSync(settingsFile, "utf8");
  const seeded = text.replace(/\/\/\s*uiHost:\s*"127\.0\.0\.1",/, 'uiHost: process.env.FUXA_HOST || "127.0.0.1",');
  if (seeded === text) console.warn("[fuxa] could not find uiHost in settings.default.js — FUXA will listen on all interfaces.");
  writeFileSync(settingsFile, seeded);
}

const fuxa = spawn(process.execPath, [join(APP_DIR, "main.js"), "--userDir", DATA_DIR, "--port", String(PORT)], {
  cwd: APP_DIR,
  stdio: "inherit",
});

const stop = () => fuxa.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
fuxa.on("exit", (code) => process.exit(code ?? 0));

async function waitForFuxa(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${URL}/api/settings`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (firstRun || process.argv.includes("--load")) {
  if (!(await waitForFuxa())) {
    console.error(`[fuxa] FUXA did not answer on ${URL} — project not loaded.`);
  } else {
    console.log("[fuxa] loading the Captsone project generated from the PLC register map ...");
    const ok = npm(["run", "fuxa-project", "--", "--push"], join(ROOT, "twin"), { ...process.env, FUXA_URL: URL });
    if (!ok) console.error("[fuxa] project not loaded — run `npm run fuxa:project` once FUXA is up.");
  }
}

console.log(
  `[fuxa] editor: ${URL}/editor   operator view: ${URL}/home\n` +
    `       PLC: ${process.env.PLC_HOST ?? "127.0.0.1"}:${process.env.PLC_PORT ?? 5020} (start the virtual PLC with \`npm run virtual-plc\`)\n` +
    "       Ctrl+C to stop.",
);
