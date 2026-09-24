/**
 * Prints the PLC register map as Markdown (generated section of
 * docs/prototype/io-map.md).
 *
 *   npm run tag-map                 → stdout
 *   npm run tag-map -- --write      → replaces the generated block in the doc and
 *                                     regenerates the ESP32 firmware register header
 */

import * as fs from "fs";
import * as path from "path";

import { EVENT_SEVERITY, EventCode, FaultCode, RefusalReason, RejectReason, SafetyCommand, TankChangeRefusal } from "../events";
import {
  ARM_CMD,
  ARM_RESULT,
  ARM_STATUS_BITS,
  COIL_COUNT,
  FIELD,
  PROTOCOL_VERSION,
  SCAN,
  SCAN_STATUS,
  SCAN_TEXT_MAX_CHARS,
  SCAN_TEXT_REGISTERS,
  STATION,
  STATION_BLOCK,
  SYS,
  coilTable,
  registerTable,
  type RegisterDef,
} from "./tag-map";

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
    "### Holding registers — scan mailbox (300–338)",
    "",
    "The PLC holds a container at SCAN and writes its id to `Scan.Request`. The scanner node triggers one read, writes `Scan.Status`, `Scan.Length` and the raw text, then writes the same id to `Scan.Done` last. The PLC validates the text itself, publishes `Scan.ParseResult`, clears `Scan.Request` and releases the container. A request is new while `Request ≠ 0` and `Request ≠ Done`.",
    "",
    table(inRange(300, 338), 40001),
    "",
    "### Holding registers — field node inputs (400–419)",
    "",
    table(inRange(400, 419), 40001),
    "",
    "### Holding registers — microcontroller stations (420–432)",
    "",
    "The PLC decides; the ESP32 nodes execute and report. Label and sort use the same request/done handshake as the scan mailbox. The robotic arm takes one command at a time: the PLC writes `ArmCmd`, then a new `ArmCmdSeq`; the station node runs it and writes `ArmResult`, then `ArmDoneSeq` = `ArmCmdSeq`. Nodes move actuators only while `Station.RunPermit` = 1 and `Sys.PlcHeartbeat` keeps changing. A station that does not report within `stationNodeTimeoutSec` jams its container; node fault bits, a lost heartbeat and arm failures latch a fault (`Sys.FaultCode`) and stop the line.",
    "",
    table(inRange(420, 432), 40001),
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
    "### Fault codes (`FAULT` arg1, `Sys.FaultCode`)",
    "",
    enumTable(FaultCode as unknown as Record<string, number>),
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

/** C++ header for the ESP32 firmware: the registers and codes the field nodes use. */
export function renderFirmwareHeader(): string {
  const block = (title: string, prefix: string, e: Record<string, number>) => [
    `// ${title}`,
    ...Object.entries(e).map(([k, v]) => `constexpr uint16_t ${prefix}${k} = ${v};`),
    "",
  ];
  return [
    "// Captsone PLC register map for the ESP32 field nodes.",
    `// Generated from twin/src/plc/tag-map.ts (protocol v${PROTOCOL_VERSION}) by \`npm run tag-map\`. Do not edit by hand.`,
    "// Addresses are 0-based Modbus PDU addresses of holding registers.",
    "#pragma once",
    "#include <stdint.h>",
    "",
    "namespace reg {",
    "",
    `constexpr uint16_t PROTOCOL_VERSION = ${PROTOCOL_VERSION};`,
    "",
    ...block("System", "SYS_", { PROTOCOL_VERSION: SYS.PROTOCOL_VERSION, PLC_HEARTBEAT: SYS.PLC_HEARTBEAT, LINE_STATE: SYS.LINE_STATE }),
    ...block("Scan mailbox. Scan.Text holds 2 characters per register, first character in the high byte", "SCAN_", {
      ...SCAN,
      TEXT_REGISTERS: SCAN_TEXT_REGISTERS,
      TEXT_MAX_CHARS: SCAN_TEXT_MAX_CHARS,
    }),
    ...block("Scan.Status values (written by the scanner node)", "SCAN_STATUS_", SCAN_STATUS),
    ...block("Field node heartbeats", "", {
      TANK_NODE_HEARTBEAT: FIELD.TANK_NODE_HEARTBEAT,
      SCANNER_NODE_HEARTBEAT: FIELD.SCANNER_NODE_HEARTBEAT,
      STATION_NODE_HEARTBEAT: FIELD.STATION_NODE_HEARTBEAT,
    }),
    ...block("Microcontroller stations", "STATION_", { ...STATION, BLOCK_START: STATION_BLOCK.start, BLOCK_LENGTH: STATION_BLOCK.length }),
    ...block("Station.ArmCmd values", "ARM_CMD_", ARM_CMD),
    ...block("Station.ArmResult values", "ARM_RESULT_", ARM_RESULT),
    ...block("Station.ArmStatus bit numbers", "ARM_STATUS_BIT_", ARM_STATUS_BITS),
    "// Station.ScannerNodeFaults / Station.StationNodeFaults bit numbers",
    "constexpr uint16_t SCANNER_FAULT_BIT_LABELER = 0;",
    "constexpr uint16_t SCANNER_FAULT_BIT_SCANNER = 1;",
    "constexpr uint16_t STATION_FAULT_BIT_ARM_SERVO = 0;",
    "constexpr uint16_t STATION_FAULT_BIT_SORT_SENSOR = 1;",
    "",
    "}  // namespace reg",
    "",
  ].join("\n");
}

export const FIRMWARE_HEADER = path.join(__dirname, "..", "..", "..", "firmware", "lib", "captsone_node", "src", "captsone_registers.h");

if (require.main === module) {
  const md = renderTagMap();
  if (process.argv.includes("--write")) {
    fs.writeFileSync(FIRMWARE_HEADER, renderFirmwareHeader());
    console.log(`[tag-map] updated ${FIRMWARE_HEADER}`);
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
