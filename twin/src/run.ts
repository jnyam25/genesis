/**
 * Captsone twin — runnable Node harness and Raspberry Pi service.
 *
 * Serves one line over HTTP, from one of two sources:
 *
 *   CAPTSONE_MODE=sim (default) — the simulated line: drives `TwinCore` and
 *                                 feeds preprinted barcodes on a timer.
 *   CAPTSONE_MODE=plc           — the physical line: `PlcBridge` polls the PLC
 *                                 over Modbus TCP (PLC_HOST, PLC_PORT,
 *                                 PLC_UNIT_ID, PLC_POLL_MS, PLC_COIL_BASE). Point it at the
 *                                 virtual PLC (`npm run virtual-plc`) to test
 *                                 without hardware.
 *
 * Endpoints (both modes):
 *   GET  /snapshot     — engine snapshot contract (docs/engine-design.md §7);
 *                        also written to runtime/snapshot.json
 *   GET  /hmi/state    — live state in the HMI's TwinState shape (see hmi.ts)
 *   POST /hmi/command  — operator command { "command": "eStop" | ..., "tankId"? }
 *   GET  /health       — mode, source status (PLC link, line state bits)
 *   GET  /             — tiny HTML dashboard (tanks, KPIs, containers, event timeline)
 *                        polling /snapshot and /hmi/state
 *
 * While the source has no data (PLC offline), data endpoints answer 503 with
 * { ok: false, error } so the HMI shows a stale feed instead of wrong numbers.
 *
 * Operator tank names/colors (setTankColor, resetTankColor, addTank with a
 * color) are saved to CAPTSONE_TANK_COLORS_FILE (default runtime/tank-colors.json)
 * and reloaded on start.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";

import { DEFAULT_CONFIG } from "./config";
import { TwinCore, type Snapshot } from "./core";
import { nextBarcode } from "./feeder";
import { applyHmiCommand, toHmiState, type CommandRequest, type HmiState } from "./hmi";
import { PlcBridge } from "./plc/bridge";
import { TankPalette, loadTankColors, saveTankColors } from "./tank-colors";

const PORT = Number(process.env.CAPTSONE_PORT ?? 43124);
/** Bind address. Set CAPTSONE_HOST=0.0.0.0 to expose the twin on the LAN. */
const HOST = process.env.CAPTSONE_HOST ?? "127.0.0.1";
const MODE = (process.env.CAPTSONE_MODE ?? "sim").toLowerCase();
const MAX_BODY_BYTES = 16 * 1024;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const SNAPSHOT_FILE = path.join(__dirname, "..", "runtime", "snapshot.json");
const TANK_COLORS_FILE = path.resolve(process.env.CAPTSONE_TANK_COLORS_FILE ?? path.join(__dirname, "..", "runtime", "tank-colors.json"));
const TICK_DT_SEC = 0.1;

function createPalette(): TankPalette {
  return new TankPalette(loadTankColors(TANK_COLORS_FILE), (palette) => {
    try {
      saveTankColors(TANK_COLORS_FILE, palette);
    } catch (err) {
      console.error(`[captsone] could not save tank colors to ${TANK_COLORS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** What the HTTP layer needs from a line, simulated or physical. */
interface LineSource {
  readonly mode: string;
  start(): void;
  stop(): void;
  hmiState(): HmiState | null;
  snapshot(): Snapshot | null;
  command(req: CommandRequest): Promise<string | null>;
  health(): Record<string, unknown>;
  /** Why data is unavailable (when hmiState() is null). */
  unavailableReason(): string;
}

class SimulatedLine implements LineSource {
  readonly mode = "sim";
  private readonly core = new TwinCore(DEFAULT_CONFIG, createPalette());
  private timer: NodeJS.Timeout | null = null;
  private feedTimer = 0;
  private barcodeIdx = 0;

  start(): void {
    this.timer = setInterval(() => {
      this.core.tick(TICK_DT_SEC);
      this.feedTimer += TICK_DT_SEC;
      // The feeder is faster than the line; hold back when a backlog has formed so
      // the queue stays bounded and tank-count changes reach new barcodes quickly.
      if (this.feedTimer >= DEFAULT_CONFIG.mockSensorPeriodSec && this.core.queuedBarcodes < DEFAULT_CONFIG.maxConcurrentContainers) {
        this.feedTimer = 0;
        this.core.enqueueBarcode(nextBarcode(this.barcodeIdx++, this.core.tanks.length));
      }
    }, TICK_DT_SEC * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  hmiState(): HmiState {
    return toHmiState(this.core);
  }

  snapshot(): Snapshot {
    return this.core.snapshot();
  }

  async command(req: CommandRequest): Promise<string | null> {
    return applyHmiCommand(this.core, req);
  }

  health(): Record<string, unknown> {
    return { halted: this.core.isHalted, simTimeSec: Math.round(this.core.simTimeSec), safety: this.core.safety.state() };
  }

  unavailableReason(): string {
    return "";
  }
}

class PhysicalLine implements LineSource {
  readonly mode = "plc";
  readonly bridge: PlcBridge;

  constructor() {
    const host = process.env.PLC_HOST;
    if (!host) {
      console.error("[captsone] CAPTSONE_MODE=plc requires PLC_HOST (e.g. PLC_HOST=192.168.10.10).");
      process.exit(1);
    }
    this.bridge = new PlcBridge({
      host,
      port: Number(process.env.PLC_PORT ?? 502),
      unitId: Number(process.env.PLC_UNIT_ID ?? 1),
      pollMs: Number(process.env.PLC_POLL_MS ?? 250),
      coilBase: Number(process.env.PLC_COIL_BASE ?? 0),
      palette: createPalette(),
    });
  }

  start(): void {
    this.bridge.start();
  }
  stop(): void {
    this.bridge.stop();
  }
  hmiState(): HmiState | null {
    return this.bridge.hmiState();
  }
  snapshot(): Snapshot | null {
    return this.bridge.snapshot();
  }
  command(req: CommandRequest): Promise<string | null> {
    return this.bridge.command(req);
  }
  health(): Record<string, unknown> {
    return { plc: this.bridge.status() };
  }
  unavailableReason(): string {
    return this.bridge.status().reason ?? "PLC offline";
  }
}

function writeSnapshotFile(snap: Snapshot): void {
  const dir = path.dirname(SNAPSHOT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
}

// Client script is plain concatenation: no `${` or backslash escapes inside this template literal.
function dashboardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Captsone Twin</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#0d1117;color:#e6edf3}
h1{font-size:18px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:20px 0 8px}
a{color:#58a6ff}small,.muted{color:#8b949e;font-weight:normal}.err{color:#f85149}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
.card{padding:10px;border-radius:8px;border:1px solid #30363d;background:#161b22}
.card b{display:block;font-size:20px}
.bar{height:8px;background:#30363d;border-radius:4px;margin-top:6px;overflow:hidden}
.bar>i{display:block;height:100%;background:#58a6ff}
.cols{display:grid;grid-template-columns:minmax(280px,1fr) minmax(320px,1.3fr);gap:24px}
@media(max-width:800px){.cols{grid-template-columns:1fr}}
.ctr{display:grid;grid-template-columns:64px 110px 1fr 110px;gap:8px;align-items:center;padding:4px 0}
.ctr .bar{margin:0}.num{text-align:right;font-variant-numeric:tabular-nums}
.tlwrap{max-height:60vh;overflow:auto;padding-left:6px}
.tl{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid #30363d}
.tl li{position:relative;padding:0 0 12px 12px}
.tl li::before{content:'';position:absolute;left:-20px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--c);box-shadow:0 0 0 3px #0d1117}
.tl time{font:12px ui-monospace,monospace;color:#8b949e;margin-right:6px}</style>
</head><body><h1>Captsone Industrial Paint Mixing — Digital Twin <small id="mode"></small></h1>
<p id="err" class="err" hidden></p>
<div id="tanks" class="grid"></div>
<h2>Production</h2><div id="kpis" class="grid"></div>
<div class="cols">
<section><h2>Containers on the line</h2><div id="ctrs"></div></section>
<section><h2>Event timeline <small id="clock"></small></h2><div class="tlwrap"><ol id="tl" class="tl"></ol></div></section>
</div>
<p class="muted">Raw data: <a href="/snapshot">/snapshot</a> · <a href="/hmi/state">/hmi/state</a> · <a href="/health">/health</a></p>
<script>
const $=id=>document.getElementById(id);
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const pct=v=>Math.round(v*1000)/10+'%';
const SEV={info:'#58a6ff',success:'#3fb950',warn:'#d29922',error:'#f85149'};
const STATUS={idle:'Idle',label:'Label',scan:'Scan','scan-rejected':'Scan rejected',mix:'Mix',cap:'Arm (lid)',qc:'QC',sort:'Sort',output:'Accepted',rejected:'Rejected'};
const statusText=s=>STATUS[s]||s.replace(/^fill-([0-9]+)$/,'Fill bay $1');
const hms=ms=>new Date(ms).toLocaleTimeString([],{hour12:false});
function ago(ms){const s=Math.max(0,Math.round((Date.now()-ms)/1000));return s<60?s+' s ago':Math.floor(s/60)+' min '+(s%60)+' s ago';}
function bar(frac,color){return '<div class=bar><i style="width:'+Math.max(0,Math.min(1,frac||0))*100+'%;background:'+esc(color)+'"></i></div>';}
function card(label,value,sub){return '<div class=card><span class=muted>'+esc(label)+'</span><b>'+esc(value)+'</b>'+(sub?'<span class=muted>'+esc(sub)+'</span>':'')+'</div>';}
async function getJson(u){const r=await fetch(u,{cache:'no-store'});const b=await r.json();if(!r.ok)throw new Error(b.error||'unavailable');return b;}
function render(s,h){
$('tanks').innerHTML=s.tanks.map(t=>'<div class=card><span class=muted>'+esc(t.id)+'</span> '+esc(t.name)+'<br>'+Math.round(t.levelMl)+' / '+esc(t.capacityMl)+' ml'+bar(t.levelMl/t.capacityMl,t.colorCode)+'</div>').join('');
const o=s.oee;
$('kpis').innerHTML=card('Accepted',s.counts.accepted)+card('Rejected',s.counts.rejected)+card('Total',s.counts.total)+
card('Throughput',s.throughputCpm+' /min')+card('OEE',pct(o.overall),'A '+pct(o.availability)+' · P '+pct(o.performance)+' · Q '+pct(o.quality))+
(s.sortLanes||[]).map(l=>card(l.name,l.count)).join('');
$('ctrs').innerHTML=h.containers.length?h.containers.map(c=>{
const color=c.status==='output'?SEV.success:/rejected/.test(c.status)?SEV.error:SEV.info;
return '<div class=ctr><b>'+esc(c.id)+'</b><span>'+esc(statusText(c.status))+'</span>'+bar(c.targetMl?c.fillMl/c.targetMl:0,color)+
'<span class="num muted">'+(c.targetMl?esc(c.fillMl)+' / '+esc(c.targetMl)+' ml':'—')+'</span></div>';}).join(''):'<p class=muted>No containers on the belt.</p>';
const ev=h.recentEvents||(h.lastEvent?[h.lastEvent]:[]);
$('clock').textContent='· line time '+Math.round(s.timestamp)+' s';
$('tl').innerHTML=ev.length?ev.map(e=>'<li style="--c:'+(SEV[e.severity]||SEV.info)+'"><time>'+hms(e.at)+'</time><span class=muted>'+ago(e.at)+'</span><div>'+esc(e.message)+'</div></li>').join(''):'<li style="--c:#30363d" class=muted>No events yet.</li>';
}
async function poll(){try{const [s,h]=await Promise.all([getJson('/snapshot'),getJson('/hmi/state')]);$('err').hidden=true;render(s,h);}
catch(e){$('err').textContent='Line data unavailable: '+e.message;$('err').hidden=false;}}
fetch('/health').then(r=>r.json()).then(h=>{$('mode').textContent='('+h.mode+')';});
poll();setInterval(poll,500);
</script></body></html>`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, pretty = false): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS });
  res.end(JSON.stringify(body, null, pretty ? 2 : undefined));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

function startHttpServer(line: LineSource): http.Server {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (url === "/snapshot") {
      const snap = line.snapshot();
      if (snap) sendJson(res, 200, snap, true);
      else sendJson(res, 503, { ok: false, error: line.unavailableReason() });
      return;
    }
    if (url === "/hmi/state" && req.method === "GET") {
      const state = line.hmiState();
      if (state) sendJson(res, 200, state);
      else sendJson(res, 503, { ok: false, error: line.unavailableReason() });
      return;
    }
    if (url === "/health") {
      sendJson(res, 200, { ok: true, mode: line.mode, ...line.health() }, true);
      return;
    }
    if (url === "/hmi/command") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "use POST" });
        return;
      }
      readJsonBody(req)
        .then((body) => line.command((body ?? {}) as CommandRequest))
        .then((error) => sendJson(res, error ? 400 : 200, error ? { ok: false, error } : { ok: true }))
        .catch((err: Error) => {
          if (!res.headersSent && !req.destroyed) sendJson(res, 400, { ok: false, error: err.message });
        });
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
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[captsone] port ${PORT} is already in use — stop the other process or set CAPTSONE_PORT.`);
    } else {
      console.error(`[captsone] HTTP server error: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[captsone] mode: ${line.mode}${line instanceof PhysicalLine ? ` (PLC ${process.env.PLC_HOST}:${process.env.PLC_PORT ?? 502})` : ""}`);
    console.log(`[captsone] snapshot HTTP server on http://${HOST}:${PORT}/snapshot`);
    console.log(`[captsone] HMI state / commands on http://${HOST}:${PORT}/hmi/state, POST /hmi/command`);
    console.log(`[captsone] health             on http://${HOST}:${PORT}/health`);
    console.log(`[captsone] dashboard          on http://${HOST}:${PORT}/`);
    console.log(`[captsone] snapshot file      ${path.resolve(SNAPSHOT_FILE)}`);
    console.log(`[captsone] tank colors file   ${TANK_COLORS_FILE}`);
  });
  return server;
}

function main(): void {
  if (MODE !== "sim" && MODE !== "plc") {
    console.error(`[captsone] unknown CAPTSONE_MODE "${MODE}" — use "sim" or "plc".`);
    process.exit(1);
  }
  const line: LineSource = MODE === "plc" ? new PhysicalLine() : new SimulatedLine();
  line.start();
  const server = startHttpServer(line);

  let lastOnline = true;
  const snapshotTimer = setInterval(() => {
    const snap = line.snapshot();
    if (snap) writeSnapshotFile(snap);
    const online = snap !== null;
    if (online !== lastOnline) {
      console.log(online ? "[captsone] line data available" : `[captsone] line data unavailable: ${line.unavailableReason()}`);
      lastOnline = online;
    }
  }, DEFAULT_CONFIG.snapshotPeriodSec * 1000);

  const shutdown = (): void => {
    clearInterval(snapshotTimer);
    const snap = line.snapshot();
    if (snap) writeSnapshotFile(snap);
    line.stop();
    server.close();
    console.log("[captsone] shut down; final snapshot written.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
