/**
 * Environment diagnostics: `npm run doctor`.
 *
 * Checks the things that most often break a fresh checkout on a new machine:
 * Node/npm versions, missing installs, node_modules copied from a different
 * OS/CPU (e.g. carried over on a USB drive), and ports already in use.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ROOT, PROJECTS, HMI_PORT, TWIN_PORT, MIN_NODE, nodeVersionOk, npmSpawnArgs } from "./lib.mjs";

let problems = 0;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg, fix) => {
  problems++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}${fix ? `\n      → ${fix}` : ""}`);
};

console.log(`\nCaptsone doctor — ${process.platform}/${process.arch}\n`);

// Node / npm
if (nodeVersionOk()) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} (need >= ${MIN_NODE.join(".")})`, "install Node LTS from https://nodejs.org");

const npmV = spawnSync(...npmSpawnArgs(["--version"], { encoding: "utf8" }));
if (npmV.status === 0) ok(`npm ${npmV.stdout.trim()}`);
else bad("npm not found on PATH", "reinstall Node.js (npm ships with it)");

// Installs
for (const project of PROJECTS) {
  if (existsSync(join(ROOT, project, "node_modules"))) ok(`${project}/node_modules present`);
  else bad(`${project}/node_modules missing`, "run `npm install` at the repo root");
}

// Native binaries built for another platform (node_modules copied between machines)
const hmiNext = join(ROOT, "hmi", "node_modules", "@next");
if (existsSync(hmiNext)) {
  const swc = readdirSync(hmiNext).filter((d) => d.startsWith("swc-"));
  const match = swc.some((d) => d.includes(process.platform) && d.includes(process.arch));
  if (swc.length && !match)
    bad(
      `hmi native binaries are for another platform (${swc.join(", ")})`,
      "node_modules was copied from another computer — run `npm run clean && npm install`",
    );
  else if (swc.length) ok(`hmi native binaries match ${process.platform}/${process.arch}`);
}

// Ports
const portFree = (port) =>
  new Promise((resolve) => {
    const srv = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => srv.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });

for (const [name, port, fix] of [
  ["HMI", HMI_PORT, "stop the other process, or edit the -p flag in hmi/package.json"],
  ["Twin", TWIN_PORT, "stop the other process, or set CAPTSONE_PORT to another port"],
]) {
  if (await portFree(port)) ok(`${name} port ${port} is free`);
  else bad(`${name} port ${port} is in use (already running, or another app)`, fix);
}

console.log(problems ? `\n${problems} problem(s) found.\n` : "\nAll good. Run `npm run dev`.\n");
process.exit(problems ? 1 : 0);
