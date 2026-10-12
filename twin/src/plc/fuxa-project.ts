/**
 * Generates the FUXA SCADA project for the line PLC from the register map, so
 * the SCADA tags can never drift from tag-map.ts.
 *
 *   npm run fuxa-project                        → writes deploy/fuxa/genesis-project.json
 *   npm run fuxa-project -- --push              → also loads it into a running FUXA
 *                                                 (FUXA_URL, default http://127.0.0.1:1881)
 *
 * Environment: PLC_HOST (default 127.0.0.1, the virtual PLC), PLC_PORT (5020),
 * PLC_UNIT_ID (1), FUXA_POLL_MS (250, same cadence as the bridge), FUXA_URL, FUXA_COMMANDS=1 (adds the
 * command coils and buttons; by default SCADA is read-only, scada.md R10).
 *
 * The project holds one Modbus TCP device (every holding register of the map
 * except the 32 raw barcode text registers, plus the command coils when
 * enabled), alarms for every FaultCode plus E-Stop / reset / tank-low, and a
 * "Line overview" view: the concept line (scan gate, QR reject, two tanks,
 * capping arm, lid press, fill reject, sort into two lanes) plus production
 * counters and, when FUXA_COMMANDS=1, the command buttons. Fault and E-Stop
 * banners blink over the line, a tank-level chart sits beside the vessels,
 * and clicking a station opens a diagnostic card. A Trends view charts
 * throughput. Every decision stays in the PLC, which refuses remote
 * commands in LOCAL mode.
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

export const DEFAULT_FUXA_OPTIONS: FuxaProjectOptions = { plcHost: "127.0.0.1", plcPort: 5020, unitId: 1, pollingMs: 250, commands: false };

const DEVICE_ID = "genesis-plc";
const VIEW_ID = "v_line_overview";
const VIEW_TRENDS = "v_trends";
const VIEW_TANKS = "v_diag_tanks";
const VIEW_SCAN = "v_diag_scan";
const VIEW_ARM = "v_diag_arm";
const VIEW_SORT = "v_diag_sort";
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
    {
      name: "Digital E-Stop latched",
      property: { variableId: lineState, bitmask: 1 << LINE_STATE_BITS.DIGITAL_ESTOP },
      highhigh: level(1, "Digital E-Stop latched — release it, then RESET, then START", "Safety", RED, "ackactive"),
    },
    {
      name: "E-Stop at line start",
      property: { variableId: byName("Sys.PhysicalEStopMask"), bitmask: 1 << 0 },
      highhigh: level(1, "Physical E-Stop pressed at the start of the line", "Safety", RED, "ackactive"),
    },
    {
      name: "E-Stop at line end",
      property: { variableId: byName("Sys.PhysicalEStopMask"), bitmask: 1 << 1 },
      highhigh: level(1, "Physical E-Stop pressed at the end of the line", "Safety", RED, "ackactive"),
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

const W = 1440;
const H = 960;
const BG = "#f4f7fb";
const PANEL = "#ffffff";
const EDGE = "#d5dee8";
const INK = "#1e293b";
const MUTED = "#64748b";
const OFF = "#cbd5e1";

class ViewBuilder {
  private svg: string[] = [];
  readonly items: Record<string, FuxaViewItem> = {};
  private n = 0;

  constructor(private width = W, private height = H) {}

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

  /** Start or stop an animation when a bit (or a 0/1 tag) is in range. */
  private flow(variableId: string, type: string, on: boolean, bitmask?: number): Record<string, unknown> {
    return { options: {}, range: { min: on ? 1 : 0, max: on ? 1 : 0 }, variableId, type, ...(bitmask ? { bitmask } : {}) };
  }

  /** Animated process pipe. The dashed core moves while the watched bit is on. */
  pipe(x1: number, y1: number, x2: number, y2: number, name: string, variableId: string, content: string, animate = true, bitmask?: number): void {
    const id = this.id("PIE");
    const d = `M${x1},${y1}L${x2},${y2}`;
    this.svg.push(
      `<g id="${id}" type="svg-ext-pipe">` +
        `<path id="${this.id("bPIE")}" d="${d}" stroke-width="0" stroke="#0f172a" fill="none" stroke-linecap="round"/>` +
        `<path id="${this.id("pPIE")}" d="${d}" stroke-width="16" stroke="#cbd5e1" fill="none" stroke-linecap="round"/>` +
        `<path id="${this.id("cPIE")}" d="${d}" stroke-width="7" stroke="${content}" fill="none" stroke-dasharray="14 12" stroke-linecap="butt"/>` +
        `</g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-pipe",
      name,
      property: {
        events: [],
        actions: animate
          ? [this.flow(variableId, "clockwise", true, bitmask), this.flow(variableId, "stop", false, bitmask)]
          : [],
        options: { borderWidth: 0, border: "#0f172a", pipeWidth: 16, pipe: "#cbd5e1", contentWidth: 7, content, contentSpace: 14 },
        variableId,
      },
      label: "Pipe",
    };
  }

  /** Vertical tank level. FUXA grows the bar from the bottom of the frame. */
  levelBar(x: number, y: number, w: number, h: number, name: string, variableId: string, color: string, max = 5000, lowAt = 800): void {
    const id = this.id("GXP");
    this.svg.push(
      `<g id="${id}" type="svg-ext-gauge_progress">` +
        `<rect id="${this.id("A-GXP")}" x="${x}" y="${y}" width="${w}" height="${h}" fill="#f8fafc" stroke="#94a3b8" stroke-width="1"/>` +
        `<rect id="${this.id("B-GXP")}" x="${x}" y="${y + h}" width="${w}" height="0" fill="${color}" stroke="none"/>` +
        `<foreignObject id="${this.id("H-GXP")}" x="${x}" y="${y}" width="${w}" height="${h}"/>` +
        `</g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-gauge_progress",
      name,
      property: {
        events: [],
        actions: [],
        variableId,
        ranges: [
          { type: "minmax", min: 0, max: lowAt, style: [false, false], color: "#dc2626", stroke: "" },
          { type: "minmax", min: lowAt, max, style: [false, false], color, stroke: "" },
        ],
      },
      label: "HtmlProgress",
    };
  }

  /** ISA process symbol. `kind` is the FUXA proc-eng shape name (tank4, valvecx, motor, nozzle). */
  symbol(kind: string, x: number, y: number, d: string, name: string, variableId: string, fill: string, scale = 1): string {
    const id = this.id("SHE");
    this.svg.push(
      `<g id="${id}" type="svg-ext-proceng-${kind}" transform="translate(${x},${y}) scale(${scale})" fill="${fill}" stroke="#334155" stroke-width="1.4">` +
        `<path id="${this.id("SHE")}" d="${d}" fill="${fill}" stroke="#334155" stroke-width="1.4"/>` +
        `</g>`,
    );
    this.items[id] = {
      id,
      type: `svg-ext-proceng-${kind}`,
      name,
      property: { events: [], actions: [], variableId },
      label: "Proc-Eng",
    };
    return id;
  }

  /** Color an ISA valve from one status bit. */
  valve(x: number, y: number, name: string, variableId: string, bitmask: number): void {
    const id = this.symbol("valvecx", x, y, "M 0 0 L 20 12 L 0 24 Z M 40 0 L 20 12 L 40 24 Z M 20 12 L 32 32 L 8 32 Z", name, variableId, "#94a3b8");
    const item = this.items[id];
    item.property.bitmask = bitmask;
    item.property.ranges = [
      { type: "range", min: 1, max: 1, color: "#15803d", stroke: "#14532d" },
      { type: "range", min: 0, max: 0, color: "#94a3b8", stroke: "#475569" },
    ];
  }

  /** Conveyor motor. The symbol rotates while the line is running. */
  motor(x: number, y: number, name: string, variableId: string, bitmask: number): void {
    const id = this.id("SHE");
    this.svg.push(
      `<g id="${id}" type="svg-ext-proceng-motor" transform="translate(${x},${y})" fill="#e2e8f0" stroke="#334155">` +
        `<ellipse id="${this.id("SHE")}" cx="20" cy="20" rx="20" ry="20" fill="#e2e8f0" stroke="#334155" stroke-width="1.5"/>` +
        `<path d="M 20,2 38,20 20,38 Z" fill="#334155" stroke="none"/>` +
        `</g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-proceng-motor",
      name,
      property: {
        events: [],
        variableId,
        actions: [this.flow(variableId, "clockwise", true, bitmask), this.flow(variableId, "stop", false, bitmask)],
      },
      label: "Proc-Eng",
    };
  }

  /** Lid-press cylinder. The head strokes while the line is running. */
  piston(x: number, y: number, name: string, variableId: string, bitmask: number): string {
    const id = this.id("SHE");
    const head = this.id("pm");
    this.svg.push(
      `<g id="${id}" type="svg-ext-ape-piston" transform="translate(${x},${y}) scale(0.85)">` +
        `<path d="M 40.5,0 V 52" stroke="#334155" stroke-width="5" fill="none"/>` +
        `<rect id="${head}" x="8" y="50" width="64" height="22" rx="2" fill="#64748b" stroke="#334155"/>` +
        `</g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-ape-piston",
      name,
      property: {
        events: [],
        variableId,
        actions: [this.flow(variableId, "downup", true, bitmask), this.flow(variableId, "stop", false, bitmask)],
      },
      label: "AnimProcEng",
    };
    return id;
  }

  /** Capping-arm rotor. Spins while the arm is busy. */
  rotor(x: number, y: number, name: string, variableId: string, bitmask: number): string {
    const id = this.id("SHE");
    this.svg.push(
      `<g id="${id}" type="svg-ext-ape-eli" transform="translate(${x},${y}) scale(0.42)" fill="#0f766e" stroke="none">` +
        `<path d="M32 4 A28 28 0 1 0 32 60 A28 28 0 1 0 32 4 M32 18 L32 46 M18 32 L46 32 M22 22 L42 42 M42 22 L22 42" fill="none" stroke="#0f766e" stroke-width="4"/>` +
        `</g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-ape-eli",
      name,
      property: {
        events: [],
        variableId,
        actions: [this.flow(variableId, "clockwise", true, bitmask), this.flow(variableId, "stop", false, bitmask)],
      },
      label: "AnimProcEng",
    };
    return id;
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

  /** Banner hidden at 0 and shown in its alarm color while the value (after an optional bitmask) is inside the show range. */
  banner(x: number, y: number, w: number, h: number, name: string, text: string, variableId: string, showMin: number, showMax: number, fill: string, bitmask?: number): void {
    const id = this.id("SHE");
    this.svg.push(
      `<g id="${id}" type="svg-ext-shapes" style="display:none">` +
        `<rect id="${this.id("svg")}" x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}"/>` +
        `<text id="${this.id("svg")}" x="${x + w / 2}" y="${y + h / 2 + 5}" font-family="sans-serif" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(text)}</text>` +
        `</g>`,
    );
    const act = (type: string, min: number, max: number) => ({
      options: { interval: 450 },
      range: { min, max },
      variableId,
      type,
      ...(bitmask ? { bitmask } : {}),
    });
    this.items[id] = {
      id,
      type: "svg-ext-shapes",
      name,
      property: {
        events: [],
        actions: [act("hide", 0, 0), act("show", showMin, showMax)],
        variableId,
        ...(bitmask ? { bitmask } : {}),
      },
      label: "Shapes",
    };
  }

  /** Station marker that turns red for the listed fault codes. */
  faultSpot(cx: number, cy: number, name: string, variableId: string, hot: number[]): string {
    const id = this.id("SHE");
    this.svg.push(
      `<g id="${id}" type="svg-ext-proceng-spot" transform="translate(${cx - 9},${cy - 9})">` +
        `<ellipse id="${this.id("SHE")}" cx="9" cy="9" rx="9" ry="9" fill="#e2e8f0" stroke="#64748b" stroke-width="1.5"/>` +
        `</g>`,
    );
    const ranges = [];
    for (let code = 0; code <= 8; code++) {
      const on = hot.includes(code);
      ranges.push({ type: "range", min: code, max: code, color: on ? "#dc2626" : "#e2e8f0", stroke: on ? "#7f1d1d" : "#64748b" });
    }
    this.items[id] = {
      id,
      type: "svg-ext-proceng-spot",
      name,
      property: { events: [], actions: [], variableId, ranges },
      label: "Proc-Eng",
    };
    return id;
  }

  /** Realtime chart. `chartId` must match an entry in the project chart list. */
  chart(x: number, y: number, w: number, h: number, name: string, chartId: string, variableId: string, variableIds: string[]): void {
    const id = this.id("HXC");
    this.svg.push(
      `<g id="${id}" type="svg-ext-html_chart">` +
        `<rect id="${this.id("svg")}" x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff" stroke="#d5dee8"/>` +
        `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" id="D-HXC_${id}" style="width:100%;height:100%"></div>` +
        `</foreignObject></g>`,
    );
    this.items[id] = {
      id,
      type: "svg-ext-html_chart",
      name,
      property: {
        id: chartId,
        type: "realtime1",
        events: [],
        actions: [],
        variableId,
        variableIds,
        options: {
          title: name,
          fontFamily: "sans-serif",
          legendFontSize: 11,
          colorBackground: "rgba(255,255,255,0)",
          legendBackground: "rgba(255,255,255,0)",
          titleHeight: 18,
          axisLabelFontSize: 10,
          labelsDivWidth: 0,
          axisLineColor: "rgba(30,41,59,1)",
          axisLabelColor: "rgba(30,41,59,1)",
          legendMode: "always",
          series: [],
          width: w,
          height: h,
          decimalsPrecision: 0,
          realtime: 120,
          dateFormat: "MM_DD_YYYY",
          timeFormat: "hh_mm_ss",
        },
      },
      label: "HtmlChart",
    };
  }

  /** Open a diagnostic card. The PLC is not written. */
  bindCard(itemId: string, viewId: string): void {
    this.items[itemId].property.events = [{ type: "click", action: "onwindow", actparam: viewId, actoptions: { width: 720, height: 480, left: 80, top: 40 } }];
  }

  svgContent(): string {
    return (
      `<svg width="${this.width}" height="${this.height}" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:html="http://www.w3.org/1999/xhtml">` +
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
  const GREEN = "#15803d";
  const LIT_GREEN = "#16a34a";
  const LIT_RED = "#dc2626";
  const LIT_AMBER = "#d97706";
  const LIT_BLUE = "#0284c7";

  v.rect(0, 0, W, H, BG);
  v.text(24, 38, "Genesis", 26, INK, "start", "bold");
  v.text(150, 38, "Filling, capping and inspection", 18, MUTED);
  v.text(W - 24, 38, "Micro850 · Modbus TCP", 14, MUTED, "end");

  // Product flow ------------------------------------------------------------
  const running = t("Sys.LineState");
  const runBit = 1 << LINE_STATE_BITS.RUNNING;
  v.panel(16, 56, W - 32, 460, "Product flow");
  v.levelBar(1048, 78, 22, 100, "OEE bar", t("Oee.Overall"), "#15803d", 1, 0.5);
  v.text(1088, 100, "OEE", 12, MUTED);
  v.value(1160, 124, t("Oee.Overall"), "OEE header", 18);
  v.chart(620, 68, 340, 112, "Tank levels", "chart_tanks", t("Tank1.LevelMl"), [t("Tank1.LevelMl"), t("Tank2.LevelMl")]);
  v.text(620, 196, "Click a tank, the arm, the press, or a station marker.", 12, MUTED);

  v.pipe(96, 318, 1260, 318, "Conveyor", running, "#0284c7", true, runBit);
  v.pipe(1188, 200, 1348, 200, "Lane 2 conveyor", running, "#0284c7", true, runBit);
  v.pipe(1348, 200, 1348, 318, "Lane 2 drop", running, "#0284c7", true, runBit);
  v.pipe(176, 318, 176, 430, "QR reject pipe", running, "#e11d48", false);
  v.pipe(1040, 318, 1040, 430, "Fill reject pipe", running, "#e11d48", false);

  v.rect(136, 430, 80, 28, "#fee2e2", "#fecaca", 4);
  v.text(176, 448, "QR reject", 11, "#9f1239", "middle");
  v.rect(990, 430, 100, 28, "#fee2e2", "#fecaca", 4);
  v.text(1040, 448, "Fill reject", 11, "#9f1239", "middle");

  const tank1 = v.symbol("tank4", 250, 100, "M 0 15 C 0 6.72 11.19 0 25 0 C 38.81 0 50 6.72 50 15 L 50 105 C 50 113.28 38.81 120 25 120 C 11.19 120 0 113.28 0 105 Z", "Tank 1 vessel", t("Tank1.LevelMl"), "#f8fafc");
  v.bindCard(tank1, VIEW_TANKS);
  v.levelBar(262, 122, 26, 86, "Tank 1 level bar", t("Tank1.LevelMl"), "#7EC8E3");
  v.text(275, 92, "T1  Sky Blue", 13, INK, "middle", "bold");
  v.value(300, 118, t("Tank1.LevelMl"), "Tank 1 level", 13);
  v.text(306, 118, "ml", 11, MUTED);
  v.valve(255, 228, "Tank 1 valve", t("Tank1.Flags"), 1 << TANK_FLAG_BITS.ENABLED);
  v.symbol("nozzle", 246, 268, "M 0 40 L 40 0 L 80 40 M 40 0 L 40 40", "Fill nozzle 1", t("Tank1.ValveOpeningPct"), "#334155", 0.55);

  const tank2 = v.symbol("tank4", 400, 100, "M 0 15 C 0 6.72 11.19 0 25 0 C 38.81 0 50 6.72 50 15 L 50 105 C 50 113.28 38.81 120 25 120 C 11.19 120 0 113.28 0 105 Z", "Tank 2 vessel", t("Tank2.LevelMl"), "#f8fafc");
  v.bindCard(tank2, VIEW_TANKS);
  v.levelBar(412, 122, 26, 86, "Tank 2 level bar", t("Tank2.LevelMl"), "#F4C430");
  v.text(425, 92, "T2  Amber", 13, INK, "middle", "bold");
  v.value(450, 118, t("Tank2.LevelMl"), "Tank 2 level", 13);
  v.text(456, 118, "ml", 11, MUTED);
  v.valve(405, 228, "Tank 2 valve", t("Tank2.Flags"), 1 << TANK_FLAG_BITS.ENABLED);
  v.symbol("nozzle", 396, 268, "M 0 40 L 40 0 L 80 40 M 40 0 L 40 40", "Fill nozzle 2", t("Tank2.ValveOpeningPct"), "#334155", 0.55);

  v.motor(78, 246, "Conveyor motor", running, runBit);
  const rotor = v.rotor(548, 236, "Capping rotor", t("Station.ArmStatus"), 1 << ARM_STATUS_BITS.BUSY);
  v.bindCard(rotor, VIEW_ARM);
  const press = v.piston(710, 198, "Lid press", running, runBit);
  v.bindCard(press, VIEW_ARM);
  v.lamp(648, 250, t("Station.ArmStatus"), "Arm homed", LIT_GREEN, 1 << ARM_STATUS_BITS.HOMED);
  v.lamp(648, 274, t("Station.ArmStatus"), "Arm holding a lid", LIT_GREEN, 1 << ARM_STATUS_BITS.LID_HELD);

  v.lamp(48, 250, t("Sys.PhysicalEStopMask"), "E-Stop line start", LIT_RED, 1 << 0);
  v.text(64, 254, "Line start", 12, MUTED);
  v.lamp(1396, 248, t("Sys.PhysicalEStopMask"), "E-Stop line end", LIT_RED, 1 << 1);
  v.text(1396, 230, "Line end", 11, MUTED, "middle");

  const stations: Array<[number, string]> = [
    [120, "Scan"],
    [275, "Bay 1"],
    [425, "Bay 2"],
    [570, "Arm"],
    [748, "Press"],
    [880, "Check"],
    [1040, "Reject"],
    [1180, "Sort"],
    [1360, "Lane 1"],
  ];
  for (const [x, label] of stations) v.text(x, 356, label, 12, INK, "middle");
  v.text(1260, 190, "Lane 2", 12, INK, "middle");
  const low = 1 << TANK_FLAG_BITS.LOW;
  v.banner(188, 66, 72, 20, "Tank 1 low", "T1 LOW", t("Tank1.Flags"), 1, 1, "#b45309", low);
  v.banner(360, 66, 72, 20, "Tank 2 low", "T2 LOW", t("Tank2.Flags"), 1, 1, "#b45309", low);
  v.banner(36, 468, 240, 30, "E-Stop banner", "E-STOP ACTIVE", running, 1, 1, "#b91c1c", 1 << LINE_STATE_BITS.ESTOP_ACTIVE);
  v.banner(290, 468, 250, 30, "Fault banner", "STATION FAULT", t("Sys.FaultCode"), 1, 8, "#c2410c");
  v.bindCard(v.faultSpot(120, 378, "Scan fault", t("Sys.FaultCode"), [FaultCode.LABELER, FaultCode.SCANNER, FaultCode.SCANNER_NODE_OFFLINE]), VIEW_SCAN);
  v.bindCard(v.faultSpot(570, 378, "Arm fault", t("Sys.FaultCode"), [FaultCode.ARM_SERVO, FaultCode.ARM_NO_LID, FaultCode.ARM_LID_LOST, FaultCode.STATION_NODE_OFFLINE]), VIEW_ARM);
  v.bindCard(v.faultSpot(748, 378, "Press fault", t("Sys.FaultCode"), [FaultCode.STATION_NODE_OFFLINE]), VIEW_ARM);
  v.bindCard(v.faultSpot(1180, 378, "Sort fault", t("Sys.FaultCode"), [FaultCode.SORT_SENSOR]), VIEW_SORT);
  v.value(150, 390, t("Scan.ParseResult"), "Scan result", 14);
  v.text(156, 390, "QR", 11, MUTED);
  v.value(1208, 390, t("Station.SortHeightMm"), "Sort height", 14);
  v.text(1214, 390, "mm", 11, MUTED);
  v.value(1410, 400, t("Counts.LaneA"), "Lane 1 count", 16);
  v.value(1320, 176, t("Counts.LaneB"), "Lane 2 count", 16);

  // Line status -------------------------------------------------------------
  v.panel(16, 532, 460, 408, "Line status");
  const stateLamps: Array<[string, number, string]> = [
    ["Running", LINE_STATE_BITS.RUNNING, LIT_GREEN],
    ["Safety circuit closed", LINE_STATE_BITS.SAFETY_OK, LIT_GREEN],
    ["E-Stop active", LINE_STATE_BITS.ESTOP_ACTIVE, LIT_RED],
    ["Station fault latched", LINE_STATE_BITS.FAULT, LIT_RED],
    ["Reset required", LINE_STATE_BITS.RESET_REQUIRED, LIT_AMBER],
    ["Local mode", LINE_STATE_BITS.LOCAL_MODE, LIT_BLUE],
    ["HMI link", LINE_STATE_BITS.HMI_LINK_OK, LIT_GREEN],
    ["Run permit", -1, LIT_GREEN],
  ];
  stateLamps.forEach(([label, bit, color], i) => {
    const y = 590 + i * 32;
    if (bit < 0) {
      v.lamp(44, y - 4, t("Station.RunPermit"), label, color);
    } else {
      v.lamp(44, y - 4, t("Sys.LineState"), label, color, 1 << bit);
    }
    v.text(64, y, label, 15);
  });
  v.text(36, 860, "Fault", 14, MUTED);
  v.value(200, 860, t("Sys.FaultCode"), "Fault code", 18);
  v.text(220, 860, "Arm cmd / result", 14, MUTED);
  v.value(400, 860, t("Station.ArmCmd"), "Arm command", 16);
  v.text(408, 860, "/", 14, MUTED);
  v.value(456, 860, t("Station.ArmResult"), "Arm result", 16);

  // Production --------------------------------------------------------------
  v.panel(492, 532, 440, 408, "Production");
  const production: Array<[string, string, string]> = [
    ["Accepted", "Counts.Accepted", ""],
    ["Rejected", "Counts.Rejected", ""],
    ["Total", "Counts.Total", ""],
    ["Lane 1", "Counts.LaneA", ""],
    ["Lane 2", "Counts.LaneB", ""],
    ["Throughput", "Perf.ThroughputCpm", "/min"],
    ["OEE", "Oee.Overall", ""],
    ["On the belt", "Sys.ActiveContainers", ""],
    ["Uptime", "Sys.UptimeS", "s"],
  ];
  production.forEach(([label, name, unit], i) => {
    const y = 590 + i * 32;
    v.text(512, y, label, 15);
    v.value(unit ? 840 : 900, y, t(name), label);
    if (unit) v.text(848, y, unit, 13, MUTED);
  });

  // Commands ----------------------------------------------------------------
  v.panel(948, 532, 476, 408, "Commands");
  if (commands) {
    v.button(972, 590, 200, 52, t("Cmd.Start"), "START", GREEN);
    v.button(1192, 590, 200, 52, t("Cmd.Stop"), "STOP", "#475569");
    v.button(972, 658, 200, 52, t("Cmd.Reset"), "RESET", "#0369a1");
    v.button(1192, 658, 200, 52, t("Cmd.Jog"), "JOG", "#334155");
    v.button(972, 726, 420, 56, t("Cmd.DigitalEStop"), "DIGITAL E-STOP", "#b91c1c");
    v.button(972, 798, 200, 44, t("Cmd.ReleaseEStop"), "Release E-Stop", "#334155");
    v.button(1192, 798, 200, 44, t("Cmd.FirePusher"), "Fire reject", "#334155");
    v.text(972, 868, "The PLC refuses a command in LOCAL mode or when it is unsafe.", 12, MUTED);
    v.text(972, 888, "STOP and the digital E-Stop are accepted in either mode.", 12, MUTED);
  } else {
    v.text(972, 600, "Read-only. This project never writes to the PLC.", 15, INK);
    v.text(972, 628, "Run the line from the local panel or the web HMI.", 15, INK);
    v.text(972, 668, "Generate again with FUXA_COMMANDS=1 to add", 14, MUTED);
    v.text(972, 690, "START, STOP, RESET, JOG, E-Stop and reject.", 14, MUTED);
  }

  return { id: VIEW_ID, name: "Line overview", type: "svg", profile: { width: W, height: H, bkcolor: BG, margin: 10, align: "middleCenter" }, items: v.items, variables: {}, svgcontent: v.svgContent() };
}

type FuxaView = ReturnType<typeof lineOverviewView>;

function viewOf(id: string, name: string, v: ViewBuilder, width: number, height: number): FuxaView {
  return { id, name, type: "svg", profile: { width, height, bkcolor: BG, margin: 10, align: "middleCenter" }, items: v.items, variables: {}, svgcontent: v.svgContent() };
}

function chartLine(name: string, color: string, label: string): { id: string; name: string; device: string; color: string; label: string; yaxis: number } {
  return { id: tagId(name), name, device: DEVICE_ID, color, label, yaxis: 1 };
}

export function fuxaCharts(): Array<{ id: string; name: string; lines: ReturnType<typeof chartLine>[] }> {
  return [
    { id: "chart_tanks", name: "Tank levels", lines: [chartLine("Tank1.LevelMl", "#7EC8E3", "T1 ml"), chartLine("Tank2.LevelMl", "#F4C430", "T2 ml")] },
    { id: "chart_tanks_wide", name: "Tank levels", lines: [chartLine("Tank1.LevelMl", "#7EC8E3", "T1 ml"), chartLine("Tank2.LevelMl", "#F4C430", "T2 ml")] },
    { id: "chart_rate", name: "Throughput", lines: [chartLine("Perf.ThroughputCpm", "#0284c7", "cans/min")] },
  ];
}

function trendsView(): FuxaView {
  const v = new ViewBuilder();
  const t = (name: string) => tagId(name);
  v.rect(0, 0, W, H, BG);
  v.text(24, 40, "Trends", 26, INK, "start", "bold");
  v.text(140, 40, "Last two minutes, sampled with the PLC poll", 16, MUTED);
  v.panel(16, 64, W - 32, 420, "Tank levels");
  v.chart(40, 110, W - 80, 340, "Tank levels", "chart_tanks_wide", t("Tank1.LevelMl"), [t("Tank1.LevelMl"), t("Tank2.LevelMl")]);
  v.panel(16, 500, W - 32, 420, "Throughput");
  v.chart(40, 546, W - 80, 340, "Throughput", "chart_rate", t("Perf.ThroughputCpm"), [t("Perf.ThroughputCpm")]);
  return viewOf(VIEW_TRENDS, "Trends", v, W, H);
}

function tankDiag(): FuxaView {
  const v = new ViewBuilder(720, 480);
  const t = (name: string) => tagId(name);
  v.rect(0, 0, 720, 480, BG);
  v.text(24, 36, "Tank diagnostics", 22, INK, "start", "bold");
  v.text(24, 64, "T1 Sky Blue and T2 Amber. A low banner on the overview blinks under 800 ml.", 13, MUTED);
  const rows: Array<[string, string, string]> = [
    ["T1 level", "Tank1.LevelMl", "ml"],
    ["T2 level", "Tank2.LevelMl", "ml"],
    ["T1 valve", "Tank1.ValveOpeningPct", "%"],
    ["T2 valve", "Tank2.ValveOpeningPct", "%"],
  ];
  rows.forEach(([label, name, unit], i) => {
    const y = 120 + i * 48;
    v.text(24, y, label, 16);
    v.value(280, y, t(name), label, 18);
    v.text(292, y, unit, 13, MUTED);
  });
  v.lamp(24, 330, t("Tank1.Flags"), "T1 enabled", "#15803d", 1 << TANK_FLAG_BITS.ENABLED);
  v.text(44, 334, "T1 enabled", 14);
  v.lamp(180, 330, t("Tank1.Flags"), "T1 low", "#dc2626", 1 << TANK_FLAG_BITS.LOW);
  v.text(200, 334, "T1 low", 14);
  v.lamp(24, 370, t("Tank2.Flags"), "T2 enabled", "#15803d", 1 << TANK_FLAG_BITS.ENABLED);
  v.text(44, 374, "T2 enabled", 14);
  v.lamp(180, 370, t("Tank2.Flags"), "T2 low", "#dc2626", 1 << TANK_FLAG_BITS.LOW);
  v.text(200, 374, "T2 low", 14);
  v.text(24, 430, "Levels over time are on the Trends page.", 13, MUTED);
  return viewOf(VIEW_TANKS, "Tank diagnostics", v, 720, 480);
}

function scanDiag(): FuxaView {
  const v = new ViewBuilder(720, 480);
  const t = (name: string) => tagId(name);
  v.rect(0, 0, 720, 480, BG);
  v.text(24, 36, "Scan gate", 22, INK, "start", "bold");
  v.text(24, 64, "A bad or missing QR is ejected on the QR reject slide before either tank fills.", 13, MUTED);
  const rows: Array<[string, string]> = [
    ["Parse result", "Scan.ParseResult"],
    ["Container", "Scan.ResultId"],
    ["Recipe ml", "Scan.TotalMl"],
    ["Read status", "Scan.Status"],
    ["Fault code", "Sys.FaultCode"],
  ];
  rows.forEach(([label, name], i) => {
    const y = 120 + i * 48;
    v.text(24, y, label, 16);
    v.value(320, y, t(name), label, 18);
  });
  v.text(24, 400, "Parse result 0 is a good read. Any other code rejects the can at this gate.", 13, MUTED);
  v.text(24, 424, "Fault codes 1, 2 and 7 light the scan marker on the overview.", 13, MUTED);
  return viewOf(VIEW_SCAN, "Scan gate", v, 720, 480);
}

function armDiag(): FuxaView {
  const v = new ViewBuilder(720, 480);
  const t = (name: string) => tagId(name);
  v.rect(0, 0, 720, 480, BG);
  v.text(24, 36, "Capping arm and lid press", 22, INK, "start", "bold");
  v.text(24, 64, "The arm places the lid. The press cylinder seats it.", 13, MUTED);
  v.lamp(24, 110, t("Station.ArmStatus"), "Homed", "#15803d", 1 << ARM_STATUS_BITS.HOMED);
  v.text(44, 114, "Homed", 15);
  v.lamp(160, 110, t("Station.ArmStatus"), "Busy", "#0284c7", 1 << ARM_STATUS_BITS.BUSY);
  v.text(180, 114, "Busy", 15);
  v.lamp(280, 110, t("Station.ArmStatus"), "Lid held", "#15803d", 1 << ARM_STATUS_BITS.LID_HELD);
  v.text(300, 114, "Lid held", 15);
  const rows: Array<[string, string]> = [
    ["Command", "Station.ArmCmd"],
    ["Result", "Station.ArmResult"],
    ["Command seq", "Station.ArmCmdSeq"],
    ["Done seq", "Station.ArmDoneSeq"],
    ["Fault code", "Sys.FaultCode"],
  ];
  rows.forEach(([label, name], i) => {
    const y = 170 + i * 44;
    v.text(24, y, label, 16);
    v.value(320, y, t(name), label, 18);
  });
  v.text(24, 420, "Fault codes 3, 4, 5 and 8 light the arm marker. Code 8 also lights the press.", 13, MUTED);
  return viewOf(VIEW_ARM, "Capping arm", v, 720, 480);
}

function sortDiag(): FuxaView {
  const v = new ViewBuilder(720, 480);
  const t = (name: string) => tagId(name);
  v.rect(0, 0, 720, 480, BG);
  v.text(24, 36, "Sort and lanes", 22, INK, "start", "bold");
  v.text(24, 64, "A good can of 250 ml or less takes Lane 1. A larger can takes Lane 2.", 13, MUTED);
  const rows: Array<[string, string, string]> = [
    ["Height", "Station.SortHeightMm", "mm"],
    ["Lane 1", "Counts.LaneA", ""],
    ["Lane 2", "Counts.LaneB", ""],
    ["Fault code", "Sys.FaultCode", ""],
  ];
  rows.forEach(([label, name, unit], i) => {
    const y = 120 + i * 52;
    v.text(24, y, label, 16);
    v.value(unit ? 280 : 320, y, t(name), label, 18);
    if (unit) v.text(292, y, unit, 13, MUTED);
  });
  v.text(24, 400, "Fault code 6 is the sort sensor. The line stops until RESET.", 13, MUTED);
  return viewOf(VIEW_SORT, "Sort", v, 720, 480);
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export function buildFuxaProject(opts: FuxaProjectOptions = DEFAULT_FUXA_OPTIONS): FuxaProject {
  const tags = Object.fromEntries(fuxaTags(opts.commands).map((tag) => [tag.id, tag]));
  return {
    version: "1.02",
    name: "Genesis filling line",
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
      views: [lineOverviewView(opts.commands), trendsView(), tankDiag(), scanDiag(), armDiag(), sortDiag()],
      layout: {
        start: VIEW_ID,
        zoom: "autoresize",
        navigation: {
          mode: "over",
          type: "inline",
          bkcolor: "#ffffff",
          fgcolor: INK,
          items: [
            { icon: "dashboard", view: VIEW_ID, link: "", text: "Line overview" },
            { icon: "timeline", view: VIEW_TRENDS, link: "", text: "Trends" },
          ],
        },
        header: { title: "Genesis SCADA", alarms: "fix", infos: "fix", bkcolor: "#f8fafc", fgcolor: INK },
        showdev: true,
        show_connection_error: true,
      },
    },
    alarms: fuxaAlarms(),
    texts: [],
    notifications: [],
    scripts: [],
    charts: fuxaCharts(),
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

export const FUXA_PROJECT_FILE = path.join(__dirname, "..", "..", "..", "deploy", "fuxa", "genesis-project.json");

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