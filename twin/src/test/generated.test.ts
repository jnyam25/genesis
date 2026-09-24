import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";

import { FaultCode } from "../events";
import { buildFuxaProject, tagId } from "../plc/fuxa-project";
import { FIRMWARE_HEADER, renderFirmwareHeader } from "../plc/print-tag-map";
import { SCAN, STATION, SYS, coilTable, registerTable } from "../plc/tag-map";

test("firmware register header is up to date with tag-map.ts (run `npm run tag-map`)", () => {
  assert.equal(fs.readFileSync(FIRMWARE_HEADER, "utf8").replace(/\r\n/g, "\n"), renderFirmwareHeader());
  assert.match(renderFirmwareHeader(), /^[\x00-\x7f]*$/, "the header must stay ASCII");
});

type Device = { type: string; property: { address: string }; tags: Record<string, { address: string; memaddress: string; type: string; divisor?: number }> };
type View = { items: Record<string, { type: string; property: { variableId: string; events: Array<{ action: string; actparam: string }> } }>; svgcontent: string };

test("FUXA project: tags use 1-based Modbus addresses and every view item and alarm points at a tag", () => {
  const project = buildFuxaProject({ plcHost: "192.168.10.10", plcPort: 502, unitId: 1, pollingMs: 1000, commands: true });
  const device = Object.values(project.devices)[0] as Device;
  assert.equal(device.type, "ModbusTCP");
  assert.equal(device.property.address, "192.168.10.10:502");

  const tags = device.tags;
  assert.deepEqual(
    { address: tags[tagId("Sys.FaultCode")].address, memaddress: tags[tagId("Sys.FaultCode")].memaddress },
    { address: String(SYS.FAULT_CODE + 1), memaddress: "400000" },
  );
  assert.equal(tags[tagId("Station.ArmStatus")].address, String(STATION.ARM_STATUS + 1));
  assert.equal(tags[tagId("Tank1.LevelMl")].divisor, 10);
  assert.equal(tags[tagId("Cmd.Start")].memaddress, "000000");
  assert.equal(tags[tagId("Scan.Text1")], undefined, "raw barcode text registers are left out");
  assert.equal(Object.keys(tags).length, registerTable().length - (SCAN.PARSE_RESULT - SCAN.TEXT_BASE) + coilTable().length);

  const view = project.hmi.views[0] as View;
  for (const [id, item] of Object.entries(view.items)) {
    assert.ok(tags[item.property.variableId], `${id} → ${item.property.variableId}`);
    assert.ok(view.svgcontent.includes(`id="${id}"`), `${id} has an SVG element`);
    if (item.type === "svg-ext-html_button") {
      assert.equal(tags[item.property.variableId].type, "Bool", "buttons write command coils");
      assert.deepEqual(item.property.events.map((e) => [e.action, e.actparam]), [["onSetValue", "1"]]);
    }
  }
  for (const alarm of project.alarms) assert.ok(tags[alarm.property.variableId], alarm.name);
  const faultAlarms = project.alarms.filter((a) => a.property.variableId === tagId("Sys.FaultCode"));
  assert.equal(faultAlarms.length, Object.values(FaultCode).filter((v) => typeof v === "number").length);
});

test("FUXA project: read-only variant has no coil tags and no buttons", () => {
  const project = buildFuxaProject({ plcHost: "127.0.0.1", plcPort: 5020, unitId: 1, pollingMs: 1000, commands: false });
  const device = Object.values(project.devices)[0] as Device;
  assert.ok(Object.values(device.tags).every((t) => t.memaddress === "400000"));
  const view = project.hmi.views[0] as View;
  assert.ok(Object.values(view.items).every((i) => i.type !== "svg-ext-html_button"));
});
