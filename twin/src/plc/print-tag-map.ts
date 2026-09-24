/**
 * Prints the PLC register map as Markdown (generated section of
 * docs/prototype/io-map.md).
 *
 *   npm run tag-map                 → stdout
 *   npm run tag-map -- --write      → replaces the generated block in the doc
 */

import * as fs from "fs";
import * as path from "path";

import { EVENT_SEVERITY, EventCode, RefusalReason, RejectReason, SafetyCommand, TankChangeRefusal } from "../events";
import { COIL_COUNT, PROTOCOL_VERSION, coilTable, registerTable, type RegisterDef } from "./tag-map";

const BEGIN = "<!-- BEGIN GENERATED: tag-map -->";
const END = "<!-- END GENERATED: tag-map -->";

function table(rows: RegisterDef[], modiconBase: number): string {
  const lines = [
    "| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |",
    "| ---: | ---: | --- | :---: | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(`| ${r.address} | ${r.address + modiconBase} | \`${r.name}\` | ${r.access} | ${r.unit} | ${r.description.replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n");
}

function enumTable<T extends Record<string, string | number>>(e: T, extra?: (v: number) => string): string {
  const header = extra ? "| Code | Name | Severity |\n| ---: | --- | --- |" : "| Code | Name |\n| ---: | --- |";
  const rows = Object.entries(e)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => (extra ? `| ${v} | \`${k}\` | ${extra(v as number)} |` : `| ${v} | \`${k}\` |`));
  return [header, ...rows].join("\n");
}

export function renderTagMap(): string {
  const regs = registerTable();
  const inRange = (lo: number, hi: number) => regs.filter((r) => r.address >= lo && r.address <= hi);
  return [
    BEGIN,
    `<!-- Generated from twin/src/plc/tag-map.ts (protocol v${PROTOCOL_VERSION}) by \`npm run tag-map -- --write\`. Do not edit by hand. -->`,
    "",
    "### Holding registers — system (0–19)",
    "",
    table(inRange(0, 19), 40001),
    "",
    "### Holding registers — tank slots (20–67)",
    "",
    "Six registers per slot k = 1..8, base `20 + 6·(k−1)`. Descriptions are given for slot 1 and apply to every slot.",
    "",
    table(inRange(20, 67), 40001),
    "",
    "### Holding registers — container tracking (100–139)",
    "",
    "Five registers per slot i = 1..8, base `100 + 5·(i−1)`. Live containers first, then containers that finished in the last ~1.5 s.",
    "",
    table(inRange(100, 139), 40001),
    "",
    "### Holding registers — event ring (200–232)",
    "",
    table(inRange(200, 232), 40001),
    "",
    "### Holding registers — recipe mailbox (300–312)",
    "",
    table(inRange(300, 312), 40001),
    "",
    "### Holding registers — field node inputs (400–419)",
    "",
    table(inRange(400, 419), 40001),
    "",
    "### Holding registers — microcontroller station handshake (420–430)",
    "",
    "The PLC holds a container at LABEL, CAP or PRESS and publishes its id in the station's `Request` register. The ESP32 runs the station only while `Station.RunPermit` = 1, then writes the same id to `Done`. The PLC releases the container when `Done` = `Request`, and rejects it with `STATION_FAULT` on a timeout or a fault bit. The virtual PLC publishes the requests and run permit but completes each station on its own timer.",
    "",
    table(inRange(420, 430), 40001),
    "",
    "### Holding registers — simulation inputs (450–451)",
    "",
    "Honoured only while `LineState.SIMULATION` = 1 (virtual PLC, or a PLC in SimInputs mode with outputs unpowered).",
    "",
    table(inRange(450, 451), 40001),
    "",
    `### Coils (0–${COIL_COUNT - 1})`,
    "",
    table(coilTable(), 1),
    "",
    "### Event codes",
    "",
    enumTable(EventCode as unknown as Record<string, number>, (v) => EVENT_SEVERITY[v as EventCode]),
    "",
    "Argument meanings are documented on each code in `twin/src/events.ts`.",
    "",
    "### Reject reasons (`CONTAINER_REJECTED` arg2)",
    "",
    enumTable(RejectReason as unknown as Record<string, number>),
    "",
    "### Tank change refusals (`TANK_CHANGE_REFUSED` arg1)",
    "",
    enumTable(TankChangeRefusal as unknown as Record<string, number>),
    "",
    "### Refused commands (`COMMAND_REFUSED` arg1 = command, arg2 = reason)",
    "",
    enumTable(SafetyCommand as unknown as Record<string, number>),
    "",
    enumTable(RefusalReason as unknown as Record<string, number>),
    "",
    END,
  ].join("\n");
}

if (require.main === module) {
  const md = renderTagMap();
  if (process.argv.includes("--write")) {
    const doc = path.join(__dirname, "..", "..", "..", "docs", "prototype", "io-map.md");
    const text = fs.readFileSync(doc, "utf8");
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if (start < 0 || end < 0) {
      console.error(`[tag-map] markers not found in ${doc}`);
      process.exit(1);
    }
    fs.writeFileSync(doc, text.slice(0, start) + md + text.slice(end + END.length));
    console.log(`[tag-map] updated ${doc}`);
  } else {
    console.log(md);
  }
}
