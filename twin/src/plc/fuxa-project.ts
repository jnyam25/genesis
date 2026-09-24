/**
 * Generates the FUXA SCADA project for the line PLC from the register map, so
 * the SCADA tags can never drift from tag-map.ts.
 *
 *   npm run fuxa-project                        → writes deploy/fuxa/captsone-project.json
 *   npm run fuxa-project -- --push              → also loads it into a running FUXA
 *                                                 (FUXA_URL, default http://127.0.0.1:1881)
 *
 * Environment: PLC_HOST (default 127.0.0.1, the virtual PLC), PLC_PORT (5020),
 * PLC_UNIT_ID (1), FUXA_POLL_MS (1000), FUXA_URL, FUXA_COMMANDS=1 (adds the
 * command coils and buttons; by default SCADA is read-only, scada.md R10).
 *
 * The project holds one Modbus TCP device (every holding register of the map
 * except the 32 raw barcode text registers, plus the command coils when
 * enabled), alarms for every FaultCode plus E-Stop / reset / tank-low, and a
 * "Line overview" view with the line state, production counters, the stations
 * (scanner, robotic arm, sort sensor) and the tanks. Every decision stays in
 * the PLC, which also refuses remote commands in LOCAL mode.
 */

import * as fs from "fs";
import * as path from "path";

import { MAX_TANKS } from "../config";
import { FAULT_TEXT, FaultCode } from "../events";
import { ARM_STATUS_BITS, LINE_STATE_BITS, SCAN, TANK_FLAG_BITS, coilTable, registerTable, type RegisterDef } from "./tag-map";

export interface FuxaProjectOptions {
  plcHost: string;
  plcPort: number;
  unitId: number;
  pollingMs: number;
  /** Command buttons (coil tags). False = read-only SCADA that never writes to the PLC. */
  commands: boolean;
}

export const DEFAULT_FUXA_OPTIONS: FuxaProjectOptions = { plcHost: "127.0.0.1", plcPort: 5020, unitId: 1, pollingMs: 1000, commands: false };

const DEVICE_ID = "captsone-plc";
const VIEW_ID = "v_line_overview";
/** FUXA's Modbus memory-area prefixes (runtime/devices/modbus: ModbusMemoryAddress). */
const HOLDING_REGISTERS = "400000";
const COILS = "000000";

interface FuxaTag {
  id: string;
  name: string;
  label: string;
  type: "UInt16" | "Bool";
  /** 1-based, as FUXA's Modbus driver expects (it subtracts 1). */
  address: string;
  memaddress: string;
  divisor?: number;
  format?: number;
  /** History: saved on every change and at least every `interval` seconds. */
  daq?: { enabled: boolean; changed: boolean; interval: number };
  description: string;
}

interface FuxaAlarmLevel {
  enabled: true;
  checkdelay: number;
  timedelay: number;
  min: number;
  max: number;
  text: string;
  group: string;
  ackmode: "float" | "ackactive" | "ackpassive";
  bkcolor: string;
  color: string;
}

interface FuxaAlarm {
  name: string;
  property: { variableId: string; bitmask?: number };
  highhigh?: FuxaAlarmLevel;
  high?: FuxaAlarmLevel;
  low?: FuxaAlarmLevel;
  info?: FuxaAlarmLevel;
}

interface FuxaViewItem {
  id: string;
  type: string;
  name: string;
  property: Record<string, unknown>;
  label: string;
}

export interface FuxaProject {
  version: string;
  name: string;
  server: { id: string; name: string; type: "FuxaServer"; property: Record<string, never> };
  devices: Record<string, unknown>;
  hmi: { views: unknown[]; layout: unknown };
  alarms: FuxaAlarm[];
  texts: unknown[];
  notifications: unknown[];
  scripts: unknown[];
  charts: unknown[];
}

export function tagId(name: string): string {
  return `t_${name.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** Scaled registers state their factor in the unit ("ml × 10", "× 1000", "cpm × 100"). */
function scaling(unit: string): { divisor?: number; format?: number } {
  const m = /×\s*(\d+)/.exec(unit);
  if (!m) return {};
  const divisor = Number(m[1]);
  return { divisor, format: Math.round(Math.log10(divisor)) };
}

function registerTag(r: RegisterDef): FuxaTag {
  return {
    id: tagId(r.name),
    name: r.name,
    label: r.name,
    type: "UInt16",
    address: String(r.address + 1),
    memaddress: HOLDING_REGISTERS,
    ...scaling(r.unit),
    ...(/Heartbeat/.test(r.name) ? {} : { daq: { enabled: true, changed: true, interval: 60 } }),
    description: r.description,
  };
}

function coilTag(r: RegisterDef): FuxaTag {
  return { id: tagId(r.name), name: r.name, label: r.name, type: "Bool", address: String(r.address + 1), memaddress: COILS, description: r.description };
}

export function fuxaTags(commands = true): FuxaTag[] {
  const regs = registerTable().filter((r) => r.address < SCAN.TEXT_BASE || r.address >= SCAN.PARSE_RESULT);
  return [...regs.map(registerTag), ...(commands ? coilTable().map(coilTag) : [])];
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

const RED = { bkcolor: "#c62828", color: "#ffffff" };
const AMBER = { bkcolor: "#f9a825", color: "#1b1b1b" };
const BLUE = { bkcolor: "#1565c0", color: "#ffffff" };

function level(value: number, text: string, group: string, colors: { bkcolor: string; color: string }, ackmode: FuxaAlarmLevel["ackmode"]): FuxaAlarmLevel {
  return { enabled: true, checkdelay: 1, timedelay: 0, min: value, max: value, text, group, ackmode, ...colors };
}

export function fuxaAlarms(): FuxaAlarm[] {
  const names = new Set(registerTable().map((r) => r.name));
  const byName = (name: string) => {
    if (!names.has(name)) throw new Error(`no register named ${name}`);
    return tagId(name);
  };
  const lineState = byName("Sys.LineState");
  const alarms: FuxaAlarm[] = [
    {
      name: "E-Stop active",
      property: { variableId: lineState, bitmask: 1 << LINE_STATE_BITS.ESTOP_ACTIVE },
      highhigh: level(1, "EMERGENCY STOP active — safety circuit open, all motion de-energized", "Safety", RED, "ackactive"),
    },
    {
      name: "Safety reset required",
      property: { variableId: lineState, bitmask: 1 << LINE_STATE_BITS.RESET_REQUIRED },
      info: level(1, "Safety circuit waiting for RESET at the local panel", "Safety", BLUE, "float"),
    },
  ];
  for (const code of Object.values(FaultCode).filter((v): v is FaultCode => typeof v === "number")) {
    alarms.push({
      name: `Station fault ${code}`,
      property: { variableId: byName("Sys.FaultCode") },
      highhigh: level(code, `FAULT ${code}: ${FAULT_TEXT[code]} — line stopped, fix it then RESET`, "Station faults", RED, "ackactive"),
    });
  }
  for (let k = 1; k <= MAX_TANKS; k++) {
    alarms.push({
      name: `Tank ${k} low`,
      property: { variableId: byName(`Tank${k}.Flags`), bitmask: 1 << TANK_FLAG_BITS.LOW },
      low: level(1, `Tank ${k} below its refill threshold`, "Tanks", AMBER, "float"),
    });
  }
  return alarms;
}

// ---------------------------------------------------------------------------
// Line overview view (SVG + FUXA gauges)
// ---------------------------------------------------------------------------

const W = 1280;
const H = 760;
const BG = "#10151c";
const PANEL = "#1a222d";
const EDGE = "#2c3847";
const INK = "#e6edf3";
const MUTED = "#8b98a8";
const OFF = "#39424e";

class ViewBuilder {
  private svg: string[] = [];
  readonly items: Record<string, FuxaViewItem> = {};
  private n = 0;

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}_${String(this.n).padStart(4, "0")}`;
  }

  rect(x: number, y: number, w: number, h: number, fill: string, stroke = "none", rx = 0): void {
    this.svg.push(`<rect id="${this.id("svg")}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}"/>`);
  }

  text(x: number, y: number, s: string, size = 14, fill = INK, anchor: "start" | "middle" | "end" = "start", weight = "normal"): void {
    this.svg.push(
      `<text id="${this.id("svg")}" x="${x}" y="${y}" font-family="sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" xml:space="preserve">${escapeXml(s)}</text>`,
    );
  }

  panel(x: number, y: number, w: number, h: number, title: string): void {
    this.rect(x, y, w, h, PANEL, EDGE, 6);
    this.text(x + 14, y + 26, title.toUpperCase(), 13, MUTED, "start", "bold");
  }

  /** Numeric readout of a tag (right-aligned at x). */
  value(x: number, y: number, variableId: string, name: string, size = 18): void {
    const id = this.id("VAL");
    this.svg.push(
      `<g id="${id}" type="svg-ext-value" fill="${INK}" stroke="none" font-size="${size}" font-family="sans-serif" text-anchor="end">` +
        `<text id="${this.id("VAL")}" x="${x}" y="${y}" font-family="monospace" font-size="${size}" fill="${INK}" text-anchor="end" xml:space="preserve">--</text></g>`,
    );
    this.items[id] = { id, type: "svg-ext-value", name, property: { events: [], actions: [], variableId }, label: "Value" };
  }

  /** Lamp driven by one bit (bitmask) or a whole 0/1 tag. */
  lamp(cx: number, cy: number, variableId: string, name: string, onColor: string, bitmask?: number): void {
    const id = this.id("GSE");
    this.svg.push(
      `<g id="${id}" type="svg-ext-gauge_semaphore" fill="${OFF}" stroke="#000000" font-size="14" font-family="sans-serif">` +
        `<ellipse id="${this.id("GSE")}" cx="${cx}" cy="${cy}" rx="9" ry="9" fill="${OFF}" stroke="#0b0f14"/></g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-gauge_semaphore",
      name,
      property: {
        events: [],
        actions: [],
        variableId,
        ...(bitmask ? { bitmask } : {}),
        ranges: [
          { type: "range", min: 0, max: 0, color: OFF },
          { type: "range", min: 1, max: 1, color: onColor },
        ],
      },
      label: "HtmlSemaphore",
    };
  }

  /** Push button that writes 1 to a command coil (the PLC acts on the edge and clears it). */
  button(x: number, y: number, w: number, h: number, variableId: string, text: string, bg: string, fg = "#ffffff"): void {
    const id = this.id("HXB");
    const inner = this.id("HXB");
    this.svg.push(
      `<g id="${id}" type="svg-ext-html_button" fill="#FFFFFF" font-size="16" font-family="sans-serif" text-anchor="right" stroke="#000000">` +
        `<rect id="${this.id("svg")}" x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}" stroke="#ffffff" stroke-width="0"/>` +
        `<foreignObject id="H-${inner}" x="${x}" y="${y}" width="${w}" height="${h}">` +
        `<BUTTON id="B-${inner}" class="md-btn  md-btn-raised" style="width: 100%; height: 100%; font-weight: bold; background-color: ${bg}; color: ${fg};">${escapeXml(text)}</BUTTON>` +
        `</foreignObject></g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-html_button",
      name: text,
      property: { events: [{ type: "click", action: "onSetValue", actparam: "1" }], actions: [], variableId, text },
      label: "HtmlButton",
    };
  }

  svgContent(): string {
    return (
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:html="http://www.w3.org/1999/xhtml">` +
      `<g><title>Layer 1</title>${this.svg.join("")}</g></svg>`
    );
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function lineOverviewView(commands = true): { id: string; name: string; type: string; profile: unknown; items: Record<string, FuxaViewItem>; variables: Record<string, never>; svgcontent: string } {
  const v = new ViewBuilder();
  const t = (name: string) => tagId(name);
  const GREEN = "#2e7d32";
  const LIT_GREEN = "#43d17a";
  const LIT_RED = "#ff4d4f";
  const LIT_AMBER = "#ffb020";
  const LIT_BLUE = "#4aa3ff";

  v.rect(0, 0, W, H, BG);
  v.text(24, 40, "Captsone bottling line", 24, INK, "start", "bold");
  v.text(W - 24, 40, "Allen-Bradley Micro850 2080-L50E-48QBB · Modbus TCP", 14, MUTED, "end");

  // Line status -------------------------------------------------------------
  v.panel(20, 60, 400, 330, "Line status");
  const stateLamps: Array<[string, number, string]> = [
    ["Running", LINE_STATE_BITS.RUNNING, LIT_GREEN],
    ["Safety circuit closed", LINE_STATE_BITS.SAFETY_OK, LIT_GREEN],
    ["E-Stop active", LINE_STATE_BITS.ESTOP_ACTIVE, LIT_RED],
    ["Station fault latched", LINE_STATE_BITS.FAULT, LIT_RED],
    ["Reset required", LINE_STATE_BITS.RESET_REQUIRED, LIT_AMBER],
    ["Local mode (HMI view-only)", LINE_STATE_BITS.LOCAL_MODE, LIT_BLUE],
    ["Pi / HMI link", LINE_STATE_BITS.HMI_LINK_OK, LIT_GREEN],
    ["Simulation inputs", LINE_STATE_BITS.SIMULATION, LIT_AMBER],
  ];
  stateLamps.forEach(([label, b, color], i) => {
    const y = 110 + i * 30;
    v.lamp(48, y - 5, t("Sys.LineState"), label, color, 1 << b);
    v.text(68, y, label, 15);
  });
  v.text(34, 368, "Fault code", 15, MUTED);
  v.value(400, 368, t("Sys.FaultCode"), "Fault code", 20);

  // Production --------------------------------------------------------------
  v.panel(440, 60, 400, 330, "Production");
  const production: Array<[string, string, string]> = [
    ["Accepted", "Counts.Accepted", ""],
    ["Rejected", "Counts.Rejected", ""],
    ["Total", "Counts.Total", ""],
    ["Sorted to lane A", "Counts.LaneA", ""],
    ["Sorted to lane B", "Counts.LaneB", ""],
    ["Throughput", "Perf.ThroughputCpm", "/min"],
    ["OEE", "Oee.Overall", ""],
    ["Containers on belt", "Sys.ActiveContainers", ""],
    ["Uptime", "Sys.UptimeS", "s"],
  ];
  production.forEach(([label, name, unit], i) => {
    const y = 110 + i * 30;
    v.text(458, y, label, 15);
    v.value(unit ? 780 : 820, y, t(name), label);
    if (unit) v.text(786, y, unit, 13, MUTED);
  });

  // Stations ----------------------------------------------------------------
  v.panel(860, 60, 400, 330, "Stations (PLC-supervised)");
  const stationLamps: Array<[string, string, string, number | undefined]> = [
    ["Run permit to ESP32 nodes", "Station.RunPermit", LIT_GREEN, undefined],
    ["Arm homed", "Station.ArmStatus", LIT_GREEN, 1 << ARM_STATUS_BITS.HOMED],
    ["Arm busy", "Station.ArmStatus", LIT_BLUE, 1 << ARM_STATUS_BITS.BUSY],
    ["Arm holding a lid", "Station.ArmStatus", LIT_GREEN, 1 << ARM_STATUS_BITS.LID_HELD],
  ];
  stationLamps.forEach(([label, name, color, mask], i) => {
    const y = 110 + i * 28;
    v.lamp(888, y - 5, t(name), label, color, mask);
    v.text(908, y, label, 15);
  });
  const stationValues: Array<[string, string]> = [
    ["Arm command (1 home, 2 pick, 3 place)", "Station.ArmCmd"],
    ["Arm result (1 OK … 6 refused)", "Station.ArmResult"],
    ["Last scan: container / result", "Scan.ResultId"],
    ["Sort height (mm)", "Station.SortHeightMm"],
  ];
  stationValues.forEach(([label, name], i) => {
    const y = 232 + i * 28;
    v.text(878, y, label, 14, MUTED);
    v.value(name === "Scan.ResultId" ? 1190 : 1240, y, t(name), label);
  });
  v.text(1205, 288, "/", 16, MUTED, "middle");
  v.value(1240, 288, t("Scan.ParseResult"), "Scan result");
  v.text(878, 372, "Node heartbeats: scanner / station", 14, MUTED);
  v.value(1170, 372, t("Field.ScannerNodeHeartbeat"), "Scanner node heartbeat", 16);
  v.value(1240, 372, t("Field.StationNodeHeartbeat"), "Station node heartbeat", 16);

  // Tanks -------------------------------------------------------------------
  v.panel(20, 410, 820, 330, "Tanks");
  const rows: Array<[string, number]> = [
    ["Enabled", 0],
    ["Level (ml)", 1],
    ["Valve (%)", 2],
    ["Low", 3],
  ];
  rows.forEach(([label, r]) => v.text(34, 490 + r * 50, label, 14, MUTED));
  for (let k = 1; k <= MAX_TANKS; k++) {
    const x = 170 + (k - 1) * 84;
    const flags = t(`Tank${k}.Flags`);
    v.text(x, 455, `T${k}`, 16, INK, "middle", "bold");
    v.lamp(x, 485, flags, `Tank ${k} enabled`, LIT_GREEN, 1 << TANK_FLAG_BITS.ENABLED);
    v.value(x + 30, 540, t(`Tank${k}.LevelMl`), `Tank ${k} level`, 16);
    v.value(x + 30, 590, t(`Tank${k}.ValveOpeningPct`), `Tank ${k} valve`, 16);
    v.lamp(x, 635, flags, `Tank ${k} low`, LIT_AMBER, 1 << TANK_FLAG_BITS.LOW);
  }
  v.text(34, 715, "Levels come from the PLC (tank-level node or analog inputs). Refill is automatic below the threshold.", 13, MUTED);

  // Commands ----------------------------------------------------------------
  v.panel(860, 410, 400, 330, "Commands");
  if (commands) {
    v.button(880, 450, 170, 52, t("Cmd.Start"), "START", GREEN);
    v.button(1070, 450, 170, 52, t("Cmd.Stop"), "STOP", "#546e7a");
    v.button(880, 518, 170, 52, t("Cmd.Reset"), "RESET", "#1565c0");
    v.button(1070, 518, 170, 52, t("Cmd.Jog"), "JOG", "#455a64");
    v.button(880, 586, 360, 60, t("Cmd.DigitalEStop"), "DIGITAL E-STOP", "#c62828");
    v.button(880, 656, 170, 40, t("Cmd.ReleaseEStop"), "Release E-Stop", "#37474f");
    v.button(1070, 656, 170, 40, t("Cmd.FirePusher"), "Fire reject", "#37474f");
    v.text(880, 722, "The PLC decides: commands are refused in LOCAL mode or when unsafe.", 12, MUTED);
  } else {
    v.text(880, 470, "Read-only SCADA: this project never writes to the PLC.", 14, MUTED);
    v.text(880, 496, "Operate the line from the local panel or the web HMI.", 14, MUTED);
    v.text(880, 522, "Set FUXA_COMMANDS=1 to add command buttons.", 14, MUTED);
  }

  return { id: VIEW_ID, name: "Line overview", type: "svg", profile: { width: W, height: H, bkcolor: BG, margin: 10, align: "middleCenter" }, items: v.items, variables: {}, svgcontent: v.svgContent() };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export function buildFuxaProject(opts: FuxaProjectOptions = DEFAULT_FUXA_OPTIONS): FuxaProject {
  const tags = Object.fromEntries(fuxaTags(opts.commands).map((tag) => [tag.id, tag]));
  return {
    version: "1.02",
    name: "Captsone bottling line",
    server: { id: "0", name: "FUXA Server", type: "FuxaServer", property: {} },
    devices: {
      [DEVICE_ID]: {
        id: DEVICE_ID,
        name: "Micro850",
        type: "ModbusTCP",
        enabled: true,
        polling: opts.pollingMs,
        property: { address: `${opts.plcHost}:${opts.plcPort}`, port: opts.plcPort, slaveid: String(opts.unitId), delay: 10, options: false },
        tags,
      },
    },
    hmi: {
      views: [lineOverviewView(opts.commands)],
      layout: {
        start: VIEW_ID,
        zoom: "autoresize",
        navigation: {
          mode: "over",
          type: "inline",
          bkcolor: PANEL,
          fgcolor: INK,
          items: [{ icon: "dashboard", view: VIEW_ID, link: "", text: "Line overview" }],
        },
        header: { title: "Captsone SCADA", alarms: "fix", infos: "fix", bkcolor: BG, fgcolor: INK },
        showdev: true,
        show_connection_error: true,
      },
    },
    alarms: fuxaAlarms(),
    texts: [],
    notifications: [],
    scripts: [],
    charts: [],
  };
}

/** Load a project into a running FUXA (replaces its whole project and restarts its runtime). */
export async function pushFuxaProject(project: FuxaProject, fuxaUrl: string): Promise<void> {
  const res = await fetch(`${fuxaUrl.replace(/\/$/, "")}/api/project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  if (!res.ok) throw new Error(`FUXA answered ${res.status} ${res.statusText}: ${await res.text()}`);
}

export const FUXA_PROJECT_FILE = path.join(__dirname, "..", "..", "..", "deploy", "fuxa", "captsone-project.json");

if (require.main === module) {
  const env = process.env;
  const project = buildFuxaProject({
    plcHost: env.PLC_HOST ?? DEFAULT_FUXA_OPTIONS.plcHost,
    plcPort: Number(env.PLC_PORT ?? DEFAULT_FUXA_OPTIONS.plcPort),
    unitId: Number(env.PLC_UNIT_ID ?? DEFAULT_FUXA_OPTIONS.unitId),
    pollingMs: Number(env.FUXA_POLL_MS ?? DEFAULT_FUXA_OPTIONS.pollingMs),
    commands: env.FUXA_COMMANDS === "1",
  });
  fs.writeFileSync(FUXA_PROJECT_FILE, JSON.stringify(project, null, 2) + "\n");
  const device = Object.values(project.devices)[0] as { property: { address: string }; tags: object };
  console.log(`[fuxa-project] wrote ${FUXA_PROJECT_FILE} (${Object.keys(device.tags).length} tags, ${project.alarms.length} alarms, PLC ${device.property.address})`);
  if (process.argv.includes("--push")) {
    const url = env.FUXA_URL ?? "http://127.0.0.1:1881";
    pushFuxaProject(project, url).then(
      () => console.log(`[fuxa-project] loaded into FUXA at ${url}`),
      (err: Error) => {
        console.error(`[fuxa-project] could not load into FUXA at ${url}: ${err.message}`);
        process.exit(1);
      },
    );
  }
}