/**
 * Runs the same npm script in twin/ and hmi/ in parallel with prefixed output.
 *
 *   node scripts/run-all.mjs dev            # twin + HMI dev server, HMI wired to the live twin
 *   node scripts/run-all.mjs dev --mock     # same, but the HMI uses its built-in mock feed
 *   node scripts/run-all.mjs dev --plc-sim  # virtual PLC (Modbus TCP) + twin in PLC-bridge mode + HMI
 *   node scripts/run-all.mjs dev --line     # real Micro850: virtual PLC + coil link + bridge + HMI + FUXA.
 *                                           # Requires PLC_HOST. PLC_PORT defaults to 502.
 *                                           # FUXA reads the Micro850 and the virtual PLC (port 5020).
 *                                           # SCADA_GATEWAY_HOST also starts the remote-SCADA door.
 *   node scripts/run-all.mjs start          # production: requires `npm run build` first
 *
 * Ctrl+C stops everything. If any process exits, the others are stopped too.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ROOT, PROJECTS, HMI_PORT, TWIN_PORT, checkNodeVersion, hmiEnv, npmSpawnArgs, portInUse } from "./lib.mjs";

const require = createRequire(import.meta.url);

checkNodeVersion();

const script = process.argv[2];
const mock = process.argv.includes("--mock");
const plcSim = process.argv.includes("--plc-sim");
const line = process.argv.includes("--line");
const VPLC_PORT = Number(process.env.VPLC_PORT ?? 5020);
const FUXA_PORT = Number(process.env.FUXA_PORT ?? 1881);
const GATEWAY_PORT = Number(process.env.SCADA_GATEWAY_PORT ?? 5502);
const gatewayHost = (process.env.SCADA_GATEWAY_HOST ?? "").trim();
if (!script || [mock, plcSim, line].filter(Boolean).length > 1) {
  console.error("usage: node scripts/run-all.mjs <npm-script> [--mock | --plc-sim | --line]");
  process.exit(1);
}

if (line && !process.env.PLC_HOST) {
  console.error(
    "[genesis] npm run line needs PLC_HOST, the Micro850 address on the control network.\n" +
      '           PowerShell: $env:PLC_HOST="192.168.10.10"; npm run line\n' +
      "           bash:       PLC_HOST=192.168.10.10 npm run line",
  );
  process.exit(1);
}

const plcHost = process.env.PLC_HOST;
const plcPort = String(process.env.PLC_PORT ?? (line ? 502 : 5020));
const plcUnit = Number(process.env.PLC_UNIT_ID ?? 1);

for (const project of PROJECTS) {
  if (!existsSync(join(ROOT, project, "node_modules"))) {
    console.error(`[genesis] ${project}/node_modules is missing — run \`npm install\` at the repo root first.`);
    process.exit(1);
  }
}
if (script === "start" && !existsSync(join(ROOT, "hmi", ".next", "BUILD_ID"))) {
  console.error("[genesis] no production build found — run `npm run build` first.");
  process.exit(1);
}

const isWin = process.platform === "win32";
const colors = { vplc: "\x1b[33m", link: "\x1b[96m", twin: "\x1b[36m", hmi: "\x1b[35m", fuxa: "\x1b[32m", gateway: "\x1b[34m" };
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
  ? { ...process.env, GENESIS_MODE: "plc", PLC_HOST: "127.0.0.1", PLC_PORT: String(VPLC_PORT) }
  : line
    ? {
        ...process.env,
        GENESIS_MODE: "plc",
        PLC_HOST: plcHost,
        PLC_PORT: plcPort,
        PLC_UNIT_ID: String(plcUnit),
        PLC_COIL_BASE: process.env.PLC_COIL_BASE ?? "0",
        FUXA_POLL_MS: process.env.FUXA_POLL_MS ?? "250",
      }
    : { ...process.env };

if (line) {
  const busy = [];
  for (const [name, port] of [
    ["HMI", HMI_PORT],
    ["twin", TWIN_PORT],
    ["FUXA", FUXA_PORT],
    ["virtual PLC", VPLC_PORT],
    ...(gatewayHost ? [["SCADA gateway", GATEWAY_PORT]] : []),
  ]) {
    if (await portInUse(port)) busy.push(`${name} port ${port}`);
  }
  if (busy.length) {
    console.error(`[genesis] already running: ${busy.join(", ")}.\n           Stop those processes, then run \`npm run line\` again.`);
    process.exit(1);
  }
}

if (plcSim || line) {
  // One compile, then start from dist/. Two compilers writing dist/ at once race.
  console.log(`[genesis] building twin for ${line ? "the physical line" : "--plc-sim"} ...`);
  const build = spawnSync(...npmSpawnArgs(["run", "build"], { cwd: join(ROOT, "twin"), stdio: "inherit" }));
  if (build.status !== 0) process.exit(build.status ?? 1);
}

if (line) {
  try {
    const version = await readProtocolVersion(plcHost, Number(plcPort), plcUnit);
    const expected = require(join(ROOT, "twin", "dist", "plc", "tag-map.js")).PROTOCOL_VERSION;
    if (version !== expected) {
      console.error(
        `[genesis] PLC at ${plcHost}:${plcPort} speaks register map v${version}; this software expects v${expected}.\n` +
          "           The 2080-L50E-24QBB must be in Run, with MB_Sys mapped at 400001. Prog1 writes 4 to MB_Sys[0].",
      );
      process.exit(1);
    }
    console.log(`[genesis] PLC ${plcHost}:${plcPort} answered, register map v${version}.`);
  } catch (err) {
    console.error(
      `[genesis] cannot reach the PLC at ${plcHost}:${plcPort} (${err.message}).\n` +
        "           Power the Micro850 and check PLC_HOST. The ESP32 nodes connect to the PLC on their own.",
    );
    process.exit(1);
  }
}

/** [name, directory, npm script, env] */
const processes = [
  ...(plcSim || line
    ? [[
        "vplc",
        "twin",
        "start:virtual-plc",
        { ...process.env, VPLC_PORT: String(VPLC_PORT), ...(line ? { VPLC_FOLLOW: "1" } : {}) },
      ]]
    : []),
  ...(line
    ? [[
        "link",
        "twin",
        "start:plc-link",
        {
          ...process.env,
          PLC_HOST: plcHost,
          PLC_PORT: plcPort,
          PLC_UNIT_ID: String(plcUnit),
          VPLC_HOST: "127.0.0.1",
          VPLC_PORT: String(VPLC_PORT),
        },
      ]]
    : []),
  ["twin", "twin", plcSim || line ? "start" : script, twinEnv],
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
      console.log(`[genesis] ${name} exited (code ${code}) — stopping the rest.`);
      stopAll(code ?? 1);
    }
  });
  children.set(name, child);
}

if (line) {
  const fuxa = spawn(process.execPath, [join(ROOT, "scripts", "fuxa.mjs"), "--load"], {
    cwd: ROOT,
    env: {
      ...twinEnv,
      FORCE_COLOR: "1",
      FUXA_URL: `http://127.0.0.1:${FUXA_PORT}`,
      FUXA_PEER_HOST: "127.0.0.1",
      FUXA_PEER_PORT: String(VPLC_PORT),
    },
  });
  pipe(fuxa.stdout, "fuxa");
  pipe(fuxa.stderr, "fuxa");
  fuxa.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`[genesis] fuxa exited (code ${code}) — stopping the rest.`);
      stopAll(code ?? 1);
    }
  });
  children.set("fuxa", fuxa);
  processes.push(["fuxa"]);
}

if ((line || plcSim) && gatewayHost) {
  const gateway = spawn(process.execPath, [join(ROOT, "twin", "dist", "plc", "scada-gateway.js")], {
    cwd: ROOT,
    env: { ...twinEnv, SCADA_GATEWAY_HOST: gatewayHost, SCADA_GATEWAY_PORT: String(GATEWAY_PORT), FORCE_COLOR: "1" },
  });
  pipe(gateway.stdout, "gateway");
  pipe(gateway.stderr, "gateway");
  gateway.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`[genesis] scada gateway exited (code ${code}) — stopping the rest.`);
      stopAll(code ?? 1);
    }
  });
  children.set("gateway", gateway);
  processes.push(["gateway"]);
}

const hmiSource = processes.find(([name]) => name === "hmi")[3].NEXT_PUBLIC_TWIN_SOURCE;
const source = script === "start" ? "as built" : (hmiSource ?? "from hmi/.env.local");
const names = processes.map(([name]) => name).join(" + ");
console.log(
  line
    ? `[genesis] physical line: ${names}\n` +
        `           Micro850: Modbus TCP ${plcHost}:${plcPort} (unit ${plcUnit}) — bridge and HMI\n` +
        `           Virtual PLC: Modbus TCP 127.0.0.1:${VPLC_PORT} — repeats the Micro850 status words; its heartbeat stays its own\n` +
        `           HMI:  http://localhost:${HMI_PORT}\n` +
        `           Twin: http://127.0.0.1:${TWIN_PORT}/health\n` +
        `           SCADA: http://127.0.0.1:${FUXA_PORT}/home` +
        (process.env.FUXA_COMMANDS === "1" ? " (command buttons on; PLC link view reads both)\n" : " (read-only; PLC link view reads both; set FUXA_COMMANDS=1 for command buttons)\n") +
        (gatewayHost ? `           Remote SCADA door: Modbus TCP ${gatewayHost}:${GATEWAY_PORT}\n` : "") +
        `           Controller 2080-L50E-24QBB. Prog1 publishes protocol 4, the heartbeat, LineState and RunPermit.\n` +
        `           Line state, counts, E-Stop mask and run permit are copied from the Micro850. Command coils go both ways.\n` +
        `           RunPermit follows Running. Leave field power off until the station programs are downloaded.\n` +
        `           Counts, OEE and containers stay 0 on the Micro850 until those programs are in the controller.\n` +
        `           Expansion I/O is a 2085-IQ16 and a 2085-OB16. Those points are not Modbus tags.\n` +
        `           ESP32 scanner and station nodes join the PLC themselves.\n` +
        `           Ctrl+C stops this PC software. The PLC keeps running.`
    : `[genesis] running "${script}" in ${names}\n` +
        (plcSim ? `           Virtual PLC: Modbus TCP 127.0.0.1:${VPLC_PORT} (twin runs in PLC-bridge mode)\n` : "") +
        (plcSim && gatewayHost ? `           Remote SCADA door: Modbus TCP ${gatewayHost}:${GATEWAY_PORT}\n` : "") +
        `           HMI:  http://localhost:${HMI_PORT}  (data source: ${source})\n` +
        `           Twin: http://127.0.0.1:${TWIN_PORT}/  (snapshot: /snapshot, HMI state: /hmi/state, health: /health)\n` +
        `           Ctrl+C to stop.`,
);

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

/** Read holding register 0 (Sys.ProtocolVersion) once. */
function readProtocolVersion(host, port, unitId) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timed out")), 3000);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.once("error", (err) => finish(err));
    socket.once("connect", () => {
      const req = Buffer.alloc(12);
      req.writeUInt16BE(1, 0);
      req.writeUInt16BE(0, 2);
      req.writeUInt16BE(6, 4);
      req.writeUInt8(unitId & 0xff, 6);
      req.writeUInt8(0x03, 7);
      req.writeUInt16BE(0, 8);
      req.writeUInt16BE(1, 10);
      socket.write(req);
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 9) return;
      if (buf[7] & 0x80) {
        finish(new Error(`Modbus exception ${buf[8]}`));
        return;
      }
      if (buf.length < 11) return;
      finish(null, buf.readUInt16BE(9));
    });
  });
}
