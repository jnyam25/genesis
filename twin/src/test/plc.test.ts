import { test } from "node:test";
import * as assert from "node:assert/strict";
import { once } from "node:events";

import { ModbusException, ModbusTcpClient, ModbusTcpServer } from "../plc/modbus";
import { PlcBridge } from "../plc/bridge";
import { VirtualPlc } from "../plc/virtual-plc";
import { COIL, LINE_STATE_BITS, RECIPE, STATION, SYS, TANK_FIELD, bit, tankRegister } from "../plc/tag-map";
import { toHmiState } from "../hmi";
import { DEFAULT_CONFIG } from "../config";

async function connectedClient(port: number): Promise<ModbusTcpClient> {
  const client = new ModbusTcpClient({ host: "127.0.0.1", port, timeoutMs: 1000 });
  client.on("error", () => {});
  const ready = once(client, "connect");
  client.connect();
  await ready;
  return client;
}

test("modbus: registers and coils round-trip; illegal address raises an exception", async () => {
  const server = new ModbusTcpServer({ holdingRegisters: 50, coils: 16 });
  await server.listen(0, "127.0.0.1");
  const client = await connectedClient(server.address!.port);
  try {
    server.registers[10] = 1234;
    assert.deepEqual(await client.readHoldingRegisters(9, 3), [0, 1234, 0]);

    await client.writeSingleRegister(20, 65535);
    await client.writeMultipleRegisters(30, [1, 2, 3]);
    assert.equal(server.registers[20], 65535);
    assert.deepEqual([...server.registers.slice(30, 33)], [1, 2, 3]);

    await client.writeSingleCoil(5, true);
    assert.deepEqual(await client.readCoils(4, 3), [false, true, false]);

    await assert.rejects(client.readHoldingRegisters(49, 2), (err: unknown) => err instanceof ModbusException && err.exceptionCode === 2);
  } finally {
    client.close();
    await server.close();
  }
});

test("bridge coilBase offsets command coils (for PLCs with fixed coil memory); registers unchanged", async () => {
  const image = new VirtualPlc({ feed: false });
  image.scan(0.1);
  const coilBase = 16384;
  const server = new ModbusTcpServer({ holdingRegisters: image.server.registers.length, coils: coilBase + 16 });
  server.registers.set(image.server.registers);
  await server.listen(0, "127.0.0.1");
  const bridge = new PlcBridge({ host: "127.0.0.1", port: server.address!.port, pollMs: 50, coilBase });
  bridge.start();
  try {
    for (let i = 0; i < 50 && !bridge.status().online; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await bridge.poll();
    }
    assert.ok(bridge.status().online, `bridge offline: ${bridge.status().reason}`);
    assert.equal(await bridge.command({ command: "stop" }), null);
    assert.equal(server.coils[coilBase + COIL.CMD_STOP], 1);
    assert.equal(server.coils[COIL.CMD_STOP], 0);
  } finally {
    bridge.stop();
    await server.close();
  }
});

/** Start a virtual PLC on an ephemeral port without its own scan timer. */
async function startPlc(): Promise<{ plc: VirtualPlc; port: number }> {
  const plc = new VirtualPlc({ feed: true });
  await plc.server.listen(0, "127.0.0.1");
  return { plc, port: plc.server.address!.port };
}

async function startBridge(port: number): Promise<PlcBridge> {
  const bridge = new PlcBridge({ host: "127.0.0.1", port, pollMs: 50 });
  bridge.start();
  for (let i = 0; i < 50 && !bridge.status().online; i++) {
    await new Promise((r) => setTimeout(r, 20));
    await bridge.poll();
  }
  assert.ok(bridge.status().online, `bridge offline: ${bridge.status().reason}`);
  return bridge;
}

test("bridge decodes the virtual PLC into the same HMI state as the core", async () => {
  const { plc, port } = await startPlc();
  const bridge = await startBridge(port);
  try {
    for (let i = 0; i < 400; i++) plc.scan(0.1); // 40 s of line time
    await bridge.poll();

    const viaPlc = bridge.hmiState()!;
    const direct = toHmiState(plc.core);
    assert.deepEqual(viaPlc.tanks.map((t) => [t.id, t.name, t.colorCode, t.capacityMl]), direct.tanks.map((t) => [t.id, t.name, t.colorCode, t.capacityMl]));
    viaPlc.tanks.forEach((t, i) => assert.ok(Math.abs(t.levelMl - direct.tanks[i].levelMl) <= 0.1));
    assert.deepEqual(viaPlc.counts, direct.counts);
    assert.deepEqual(
      viaPlc.containers.map((c) => [c.id, c.status]).sort(),
      direct.containers.slice(0, 8).map((c) => [c.id, c.status]).sort(),
    );
    for (const k of ["availability", "performance", "quality", "overall"] as const) {
      assert.ok(Math.abs(viaPlc.oee[k] - direct.oee[k]) <= 0.001, k);
    }
    assert.equal(viaPlc.recentEvents!.length, 8);
    assert.ok(viaPlc.lastEvent!.message.length > 0);
    assert.ok(bridge.snapshot()!.counts.total === direct.counts.total);
    assert.deepEqual(viaPlc.sortLanes, direct.sortLanes);
    assert.deepEqual(bridge.snapshot()!.sortLanes, direct.sortLanes);
    const directLanes = new Map(direct.containers.filter((c) => c.status === "output").map((c) => [c.id, c.lane]));
    for (const c of viaPlc.containers.filter((x) => x.status === "output")) {
      assert.equal(c.lane, directLanes.get(c.id), `${c.id} lane`);
    }
    assert.equal(plc.server.registers[tankRegister(1, TANK_FIELD.VALVE_OPENING_PCT)], DEFAULT_CONFIG.tanks[0].valveOpeningPct);
  } finally {
    bridge.stop();
    await plc.stop();
  }
});

test("virtual PLC publishes the microcontroller station handshake: run permit and label/cap/press requests", async () => {
  const plc = new VirtualPlc({ feed: false });
  const r = plc.server.registers;
  plc.core.enqueueBarcode("PT1|T250|100,80,70");
  const requested = new Set<string>();
  for (let i = 0; i < 600 && plc.core.counts.total === 0; i++) {
    plc.scan(0.1);
    assert.equal(r[STATION.RUN_PERMIT], 1);
    if (r[STATION.LABEL_REQUEST] === 1) requested.add("label");
    if (r[STATION.CAP_REQUEST] === 1) requested.add("cap");
    if (r[STATION.PRESS_REQUEST] === 1) requested.add("press");
  }
  assert.equal(plc.core.counts.accepted, 1);
  assert.deepEqual([...requested].sort(), ["cap", "label", "press"]);
  assert.equal(r[SYS.COUNT_LANE_A], 1, "a 250 ml recipe is a small bottle (lane A)");
  plc.core.eStop();
  plc.scan(0.1);
  assert.equal(r[STATION.RUN_PERMIT], 0, "E-Stop drops the run permit");
});

test("bridge commands drive the PLC: digital E-Stop, release, reset, start, tank enable/disable", async () => {
  const { plc, port } = await startPlc();
  const bridge = await startBridge(port);
  const step = async () => {
    plc.scan(0.1);
    await bridge.poll();
  };
  try {
    await step();
    assert.equal(await bridge.command({ command: "eStop" }), null);
    await step();
    assert.ok(plc.core.isHalted);
    assert.equal(plc.server.coils[COIL.CMD_DIGITAL_ESTOP], 0, "command coil is acknowledged (reset)");
    const ls = bridge.status().lineState!;
    assert.ok(ls.eStopActive && ls.digitalEStop && !ls.safetyOk && !ls.running);
    assert.equal(bridge.hmiState()!.oee.availability, 0);
    assert.ok(bridge.hmiState()!.safety!.digitalEStop);
    assert.ok(bridge.hmiState()!.recentEvents!.some((e) => /DIGITAL E-STOP/.test(e.message)));

    assert.match((await bridge.command({ command: "start" }))!, /emergency stop is active/, "bridge pre-check");
    assert.equal(await bridge.command({ command: "releaseEStop" }), null);
    await step();
    assert.ok(bridge.status().lineState!.resetRequired);
    assert.match((await bridge.command({ command: "reset" }))!, /local control panel/);

    // Local panel reset (simulated physical input), then remote start.
    assert.equal(await bridge.command({ command: "simLocalButton", button: "reset" }), null);
    await step();
    assert.ok(bridge.status().lineState!.safetyOk);
    assert.equal(await bridge.command({ command: "start" }), null);
    await step();
    assert.ok(!plc.core.isHalted);
    assert.ok(bridge.status().lineState!.running);

    assert.equal(await bridge.command({ command: "addTank" }), null);
    await step();
    assert.deepEqual(plc.core.tanks.map((t) => t.id), ["T1", "T2", "T3", "T4"]);
    assert.deepEqual(bridge.hmiState()!.tanks.map((t) => t.id), ["T1", "T2", "T3", "T4"]);

    assert.equal(await bridge.command({ command: "removeTank", tankId: "T2" }), null);
    await step();
    assert.deepEqual(plc.core.tanks.map((t) => t.id), ["T1", "T3", "T4"]);

    assert.match((await bridge.command({ command: "removeTank", tankId: "T2" }))!, /not enabled/);
    assert.match((await bridge.command({ command: "nope" }))!, /unknown command/);

    // Tank names/colors live on the Pi: the HMI and PLC event text use them; the PLC is untouched.
    assert.equal(await bridge.command({ command: "setTankColor", tankId: "T3", name: "Navy", colorCode: "#000080" }), null);
    assert.equal(await bridge.command({ command: "addTank", name: "Mint", colorCode: "#3EB489" }), null);
    await step();
    const tanks = bridge.hmiState()!.tanks;
    const t3 = tanks.find((t) => t.id === "T3");
    assert.deepEqual([t3?.name, t3?.colorCode], ["Navy", "#000080"]);
    assert.equal(tanks.find((t) => t.id === "T2")?.name, "Mint", "addTank fills the lowest free slot with the given color");
    assert.ok(bridge.hmiState()!.recentEvents!.some((e) => e.message.includes("T2 (Mint) added")));
    assert.equal(plc.core.tanks.find((t) => t.id === "T3")?.name, DEFAULT_CONFIG.tanks[2].name);
    assert.equal(bridge.hmiState()!.tankSlots!.find((s) => s.id === "T3")?.custom, true);

    // HMI heartbeat reaches the PLC.
    await step();
    await step();
    assert.ok(bit(plc.server.registers[SYS.LINE_STATE], LINE_STATE_BITS.HMI_LINK_OK));
  } finally {
    bridge.stop();
    await plc.stop();
  }
});

test("physical E-Stop and local mode through the PLC: register bits, button names, HMI view-only", async () => {
  const { plc, port } = await startPlc();
  const bridge = await startBridge(port);
  const step = async () => {
    plc.scan(0.1);
    await bridge.poll();
  };
  try {
    await step();
    assert.equal(await bridge.command({ command: "simPhysicalEStop", buttonId: "PANEL", pressed: true }), null);
    await step();
    let safety = bridge.hmiState()!.safety!;
    assert.ok(safety.eStopActive && !safety.digitalEStop && !safety.running);
    assert.deepEqual(safety.eStopButtons.filter((b) => b.pressed).map((b) => b.id), ["PANEL"]);
    assert.equal(plc.server.registers[SYS.PHYSICAL_ESTOP_MASK], 1);
    assert.ok(bridge.hmiState()!.recentEvents!.some((e) => /PHYSICAL E-STOP pressed at Local control panel/.test(e.message)));
    assert.match((await bridge.command({ command: "firePusher" }))!, /emergency stop is active/);

    assert.equal(await bridge.command({ command: "simPhysicalEStop", buttonId: "PANEL", pressed: false }), null);
    await step();
    assert.ok(bridge.hmiState()!.safety!.resetRequired);

    assert.equal(await bridge.command({ command: "simControlMode", mode: "local" }), null);
    await step();
    safety = bridge.hmiState()!.safety!;
    assert.equal(safety.controlMode, "local");
    assert.match((await bridge.command({ command: "addTank" }))!, /local control is active/);
    assert.equal(await bridge.command({ command: "simLocalButton", button: "reset" }), null);
    await step();
    assert.equal(await bridge.command({ command: "simLocalButton", button: "start" }), null);
    await step();
    assert.ok(bridge.hmiState()!.safety!.running);
    assert.equal(await bridge.command({ command: "stop" }), null, "HMI stop always allowed");
    await step();
    assert.ok(!bridge.hmiState()!.safety!.running);
  } finally {
    bridge.stop();
    await plc.stop();
  }
});

test("recipe mailbox: scanner node writes fields then Seq; PLC queues and acknowledges", async () => {
  const plc = new VirtualPlc({ feed: false });
  await plc.server.listen(0, "127.0.0.1");
  const client = await connectedClient(plc.server.address!.port);
  try {
    await client.writeMultipleRegisters(RECIPE.PARSE_RESULT, [0, 250, 0, 100, 80, 70]);
    await client.writeSingleRegister(RECIPE.SEQ, 1);
    plc.scan(0.1);
    assert.equal(plc.server.registers[RECIPE.ACK_SEQ], 1);
    for (let i = 0; i < 600; i++) plc.scan(0.1);
    assert.equal(plc.core.counts.accepted, 1);

    // A scanner-side parse failure rides through and is rejected at the reject diverter.
    await client.writeSingleRegister(RECIPE.PARSE_RESULT, 3);
    await client.writeSingleRegister(RECIPE.SEQ, 2);
    for (let i = 0; i < 600; i++) plc.scan(0.1);
    assert.equal(plc.server.registers[RECIPE.ACK_SEQ], 2);
    assert.equal(plc.core.counts.rejected, 1);
  } finally {
    client.close();
    await plc.stop();
  }
});

test("bridge reports offline when the PLC is unreachable", async () => {
  const bridge = new PlcBridge({ host: "127.0.0.1", port: 1, pollMs: 50 });
  bridge.start();
  try {
    await new Promise((r) => setTimeout(r, 100));
    await bridge.poll();
    assert.equal(bridge.status().online, false);
    assert.equal(bridge.hmiState(), null);
    assert.match((await bridge.command({ command: "eStop" }))!, /PLC offline/);
  } finally {
    bridge.stop();
  }
});
