/** Shared helpers for the root orchestration scripts (no dependencies). */

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load the repo-root `.env` and then `.env.local` into `process.env`.
 * A value already set in the shell is left alone. `.env.local` wins over `.env`.
 * An empty value is ignored, so a placeholder like `PLC_HOST=` stays unset.
 */
export function loadLocalEnv() {
  const merged = new Map();
  for (const name of [".env", ".env.local"]) {
    const file = join(ROOT, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const body = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eq = body.indexOf("=");
      if (eq < 1) continue;
      const key = body.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = body.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (value !== "") merged.set(key, value);
    }
  }
  for (const [key, value] of merged) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

/** Sub-projects, in install/build order. */
export const PROJECTS = ["twin", "hmi"];

/** Default ports: HMI (Next.js) and the twin's HTTP server. */
export const HMI_PORT = 43123;
export const TWIN_PORT = Number(process.env.GENESIS_PORT ?? 43124);

/** Next.js 16 requires Node >= 20.9. */
export const MIN_NODE = [20, 9, 0];

export function nodeVersionOk(version = process.versions.node) {
  const cur = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (cur[i] !== MIN_NODE[i]) return cur[i] > MIN_NODE[i];
  }
  return true;
}

export function checkNodeVersion() {
  if (nodeVersionOk()) return;
  console.error(
    `\n[genesis] Node ${process.versions.node} is too old — Node ${MIN_NODE.join(".")} or newer is required.` +
      `\n           Install the LTS from https://nodejs.org (or run \`nvm use\` — see .nvmrc).\n`,
  );
  process.exit(1);
}

/**
 * Arguments for spawning npm cross-platform. On Windows npm is `npm.cmd`, which
 * needs a shell; pass one command string (args here are static, never user input).
 */
/**
 * True when this port already has a listener on IPv4 or IPv6.
 * Next.js binds `::`, so an IPv4-only check can report a busy HMI port as free.
 */
export async function portInUse(port) {
  const taken = (host) =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", (err) => resolve(err.code === "EADDRINUSE"));
      srv.once("listening", () => srv.close(() => resolve(false)));
      srv.listen(port, host);
    });
  for (const host of ["127.0.0.1", "::"]) {
    if (await taken(host)) return true;
  }
  return false;
}

export function npmSpawnArgs(args, options = {}) {
  if (process.platform === "win32") return [`npm ${args.join(" ")}`, { ...options, shell: true }];
  return ["npm", args, options];
}

/**
 * Environment for the HMI when it runs alongside the twin.
 *
 * Defaults the HMI to the live twin (`http` source, proxied through the HMI's
 * own `/api/twin` route to TWIN_HTTP_URL). `--mock` forces the built-in mock.
 * An explicit NEXT_PUBLIC_TWIN_SOURCE — in the shell, the root `.env.local`,
 * or hmi/.env.local — always wins.
 */
export function hmiEnv({ mock = false } = {}) {
  const env = { ...process.env };
  const envLocal = join(ROOT, "hmi", ".env.local");
  const setInEnvLocal =
    existsSync(envLocal) && /^\s*NEXT_PUBLIC_TWIN_SOURCE\s*=/m.test(readFileSync(envLocal, "utf8"));
  if (mock) env.NEXT_PUBLIC_TWIN_SOURCE = "mock";
  else if (!env.NEXT_PUBLIC_TWIN_SOURCE && !setInEnvLocal) env.NEXT_PUBLIC_TWIN_SOURCE = "http";
  env.TWIN_HTTP_URL ??= `http://127.0.0.1:${TWIN_PORT}`;
  return env;
}
