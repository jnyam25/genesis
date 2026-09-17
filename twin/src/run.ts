/**
 * Captsone twin — runnable Node harness.
 *
 * Drives the framework-agnostic `TwinCore` and emits the live HMI JSON
 * snapshot over TWO transports the twin can actually produce without the
 * ProtoTwin simulator:
 *
 *   1. File write  — `twin/runtime/snapshot.json` is overwritten each tick.
 *   2. HTTP server — GET http://127.0.0.1:<PORT>/snapshot returns the latest
 *                    snapshot JSON; GET / returns a tiny HTML dashboard that
 *                    polls /snapshot. This is the contract the HMI worker
 *                    builds against.
 *
 * The harness does NOT import `prototwin` (the simulator injects that). It
 * feeds preprinted barcodes into the core on a timer (the mock-sensor role)
 * and ticks the simulation at a fixed dt.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";

import { DEFAULT_CONFIG, SAMPLE_BARCODES } from "./config";
import { TwinCore, type Snapshot } from "./core";

const PORT = Number(process.env.CAPTSONE_PORT ?? 43123);
const SNAPSHOT_FILE = path.join(__dirname, "..", "runtime", "snapshot.json");
const TICK_DT_SEC = 0.1;
const FEED_PERIOD_SEC = DEFAULT_CONFIG.mockSensorPeriodSec;

function ensureRuntimeDir(): void {
  const dir = path.dirname(SNAPSHOT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeSnapshotFile(snap: Snapshot): void {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
}

function dashboardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Captsone Twin</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#0d1117;color:#e6edf3}
h1{font-size:18px}pre{background:#161b22;padding:12px;border-radius:8px;overflow:auto;max-height:70vh}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin:12px 0}
.tank{padding:10px;border-radius:8px;border:1px solid #30363d}
.bar{height:8px;background:#30363d;border-radius:4px;margin-top:6px;overflow:hidden}
.bar>i{display:block;height:100%;background:#58a6ff}</style>
</head><body><h1>Captsone Industrial Paint Mixing — Digital Twin</h1>
<div id="tanks" class="grid"></div>
<pre id="snap"></pre>
<script>
async function poll(){const r=await fetch('/snapshot');const s=await r.json();
const tanks=document.getElementById('tanks');tanks.innerHTML='';
for(const t of s.tanks){const pct=Math.max(0,Math.min(1,t.levelMl/t.capacityMl));
const d=document.createElement('div');d.className='tank';
d.innerHTML='<b>'+t.id+'</b> '+t.name+'<br>'+Math.round(t.levelMl)+'/'+t.capacityMl+' ml'+
'<div class=bar><i style="width:'+(pct*100)+'%;background:'+t.colorCode+'"></i></div>';
tanks.appendChild(d);}
document.getElementById('snap').textContent=JSON.stringify(s,null,2);}
poll();setInterval(poll,500);
</script></body></html>`;
}

function startHttpServer(latest: () => Snapshot): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/snapshot") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(latest(), null, 2));
      return;
    }
    if (url === "/" || url === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardHtml());
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  server.listen(PORT, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`[captsone] snapshot HTTP server on http://127.0.0.1:${PORT}/snapshot`);
    console.log(`[captsone] dashboard          on http://127.0.0.1:${PORT}/`);
    console.log(`[captsone] snapshot file      ${path.resolve(SNAPSHOT_FILE)}`);
  });
  return server;
}

function main(): void {
  ensureRuntimeDir();
  const core = new TwinCore(DEFAULT_CONFIG);
  let latestSnap: Snapshot = core.snapshot();

  const server = startHttpServer(() => latestSnap);

  let feedTimer = 0;
  let barcodeIdx = 0;
  let snapshotTimer = 0;

  const interval = setInterval(() => {
    core.tick(TICK_DT_SEC);

    feedTimer += TICK_DT_SEC;
    if (feedTimer >= FEED_PERIOD_SEC) {
      feedTimer = 0;
      const code = SAMPLE_BARCODES[barcodeIdx % SAMPLE_BARCODES.length];
      barcodeIdx++;
      core.enqueueBarcode(code);
    }

    snapshotTimer += TICK_DT_SEC;
    if (snapshotTimer >= DEFAULT_CONFIG.snapshotPeriodSec) {
      snapshotTimer = 0;
      latestSnap = core.snapshot();
      writeSnapshotFile(latestSnap);
    }
  }, 100);

  const shutdown = (): void => {
    clearInterval(interval);
    server.close();
    writeSnapshotFile(core.snapshot());
    // eslint-disable-next-line no-console
    console.log("[captsone] shut down; final snapshot written.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
