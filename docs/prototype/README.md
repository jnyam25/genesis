# Physical prototype — integration guide

This folder explains how to connect the Captsone digital twin and operator HMI to the physical bottling prototype described in the team's bill of materials. The prototype uses:

- the team's **Allen-Bradley Micro850 PLC (2080-L50E-48QBB)**, which supervises the line (belt, tank valves, reject and sort diverters, E-Stop monitoring), with a small **touch panel** or hardwired buttons for local control;
- two **ESP32 station nodes**: #1 runs the label applicator and barcode scanner, #2 runs the robotic capping arm (a Hiwonder xArm that lifts a lid from the lid magazine, places it and presses it down) and the sort sensor. They reach the PLC over **Wi-Fi** through an access point on the control switch, and they only execute the PLC's requests and report back: **the PLC makes every decision**. Their firmware is in [`firmware/`](../../firmware) ([esp32.md](esp32.md));
- a **monitoring PC/laptop** (or a Raspberry Pi) on wired Ethernet, which runs the bridge, the web HMI and the **FUXA** SCADA;
- **Modbus TCP** between them, with an OPC UA mapping for later;
- only software that needs **no subscription**: free CCW Standard for the PLC, open-source tools elsewhere, including FUXA ([bom.md §2a](bom.md#2a-software-no-subscriptions)).

Station order: labeling → barcode scan → Tank 1/2/3 fill → capping arm → sort sensor → reject diverter → sort diverter (lane A / lane B).

> **Read [safety.md](safety.md) before powering anything.** Physical E-Stops (at the control panel, the **line entry** and the **line exit**) act in hardware. The HMI's **Digital E-Stop** opens the same safety circuit through a fail-safe PLC output, so it shuts the machine down too. Either one puts the whole control system into E-Stop, and the line restarts only after release, a **reset at the machine**, and START.

## Documents

| Document | Read it when |
| --- | --- |
| [architecture overview](#architecture) (below) | You need the big picture |
| [bom.md](bom.md) | Buying parts: the BOM mapped to the software, the gaps, the budget, and open decisions |
| [safety.md](safety.md) | Before designing the panel and before first power-up |
| [io-map.md](io-map.md) | Wiring field devices, writing the PLC program, and writing ESP32 firmware. Contains the full **register map** |
| [communication.md](communication.md) | Setting up the network (wired + Wi-Fi), Modbus TCP, or OPC UA |
| [micro850-plc.md](micro850-plc.md) | The 2080-L50E-48QBB's IO, mapping the register map in CCW, and writing the PLC program |
| [esp32.md](esp32.md) | Building and flashing the scanner node and the station node (firmware in `firmware/`) |
| [scada.md](scada.md) | Running FUXA (`npm run fuxa`) for history, alarms and trends |
| [raspberry-pi.md](raspberry-pi.md) | Running the bridge and HMI on a Pi instead of the laptop |
| [commissioning.md](commissioning.md) | Bringing the line up step by step, with acceptance checks |
| [troubleshooting.md](troubleshooting.md) | Something doesn't work |

Related: [../api.md](../api.md) (HTTP API), [../configuration.md](../configuration.md) (line configuration), [../operator-guide.md](../operator-guide.md) (using the HMI).

## Architecture

```
                         Operator browser(s)
                                 │ HTTP :43123
┌────────────────────────────────┼──────────────────── Monitoring PC / laptop (or Pi) ─┐
│   ┌────────────────────────────▼──────────┐                                          │
│   │ HMI (Next.js)  /api/twin/* proxy      │          FUXA SCADA :1881 (read-only)    │
│   └────────────────────────────┬──────────┘                                          │
│                                │ HTTP 127.0.0.1:43124  (/hmi/state, /hmi/command)    │
│   ┌────────────────────────────▼──────────┐                                          │
│   │ Twin service, CAPTSONE_MODE=plc       │  PlcBridge: polls every 250 ms,          │
│   │ (twin/src/run.ts + plc/bridge.ts)     │  command pulses, heartbeat               │
│   └────────────────────────────┬──────────┘                                          │
└────────────────────────────────┼─────────────────────────────────────────────────────┘
                                 │ Modbus TCP :502, wired Ethernet (control network, isolated)
┌────────────────────────────────▼────────────────────────── Allen-Bradley Micro850 ┐
│ Tracking · interlocks · belt · valves · reject/sort diverters · counters · events │
│ E-Stop monitoring · LOCAL/REMOTE · Register map: twin/src/plc/tag-map.ts          │
└──────┬─────────────────────┬─────────────────────────┬────────────────────────────┘
       │ 24 V DI/DO, 0–10 V   │ Modbus TCP or serial    │ Modbus TCP over Wi-Fi (AP on the switch)
       ▼                     ▼                         ▼
 Presence sensors,     Touch panel          ┌──────────────────────┐  ┌──────────────────────────┐
 belt motor, valves,   (START, recipe,      │ ESP32 #1 scanner node│  │ ESP32 #2 station node    │
 diverters, stack      status)              │ label applicator,    │  │ xArm capping arm,        │
 light                                      │ raw barcode → Scan.* │  │ sort sensor → Station.*  │
                                            └──────────────────────┘  └──────────────────────────┘
 Hardwired E-Stop chain (panel, line entry, line exit) → safety relay → removes power from every
 actuator, including the ones the ESP32 nodes drive
```

### Who owns what

| Layer | Owns | Never does |
| --- | --- | --- |
| **Safety relay and E-Stop chain** | Removing actuator power when a physical E-Stop is pressed, a guard opens, or the PLC's fail-safe **digital E-Stop** output drops | Depend on software (or Wi-Fi) for the physical buttons |
| **Local control station** (touch panel + hardwired STOP/RESET, key switch) | LOCAL/REMOTE, START/JOG and recipe on the touch panel; hardwired STOP and RESET; operates the line without the monitoring PC | Get overridden by the web HMI in LOCAL mode |
| **Micro850 PLC** | Every line decision: container tracking, stoppers or belt stops, barcode validation, valve timing, robotic arm sequencing, bottle-type classification, reject/QC decision, sort lane, counters, OEE, event ring; watching the ESP32 heartbeats and fault bits and latching station faults (`Sys.FaultCode`); E-Stop state, reset/start/stop logic, LOCAL/REMOTE authority, the digital E-Stop output; `Station.RunPermit` for the ESP32 nodes | Wait for the monitoring PC. The line (and the local panel) keeps working if the PC or HMI goes away |
| **ESP32 nodes** | Executing and reporting: the label applicator; reading the barcode and forwarding the raw text (`Scan.*`); one robotic arm command at a time (home, pick a lid, place and press it); measuring the bottle height (`Station.SortHeightMm`). Each runs on a PLC request and only while `Station.RunPermit` = 1 and the PLC heartbeat is alive | Any line decision (they don't parse barcodes, choose lanes or reject bottles), and anything safety-related. Their actuators are powered through the safety relay ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)) |
| **Monitoring PC: twin service** | Translating PLC registers into the HMI's JSON; turning operator commands into command pulses | Run control logic |
| **Monitoring PC: HMI / SCADA** | Operator screens, logging | Talk to the PLC directly (HMI); write to the PLC (SCADA) |

### Why this split

- **Supervision stays in the PLC.** Timing-critical, safety-adjacent logic runs on deterministic, industrial hardware. The PC and HMI can reboot without stopping the line.
- **The ESP32 nodes drive the fiddly hardware.** Bus-servo motion, the scanner module's serial link and the height sensor are awkward in ladder logic and cheap on an ESP32. The PLC stays in charge through a request/done handshake per station: it validates the raw barcode text, sends the arm one command at a time, and classifies the measured bottle height, so a node can't move or judge a bottle on its own. A node that fails or stops sending its heartbeat latches a station fault and stops the line.
- **One register map is the contract.** [`twin/src/plc/tag-map.ts`](../../twin/src/plc/tag-map.ts) (protocol version 4) defines every address. The virtual PLC, the bridge, the documentation tables, the firmware header (`firmware/lib/captsone_node/src/captsone_registers.h`) and the FUXA project are all generated from or checked against it, so the PLC programmer, the firmware developers and the PC side can't drift apart.
- **Modbus TCP first.** The Micro850, ESP32 libraries and the bridge all support it, and it's simple to debug. OPC UA uses the same tag names and is covered in [communication.md](communication.md).

## Development path: software first, then hardware

You can bring the prototype up in four stages. Each stage keeps the HMI and API identical, so problems stay isolated to the layer you just added.

| Stage | Command | What's real |
| --- | --- | --- |
| 1. Simulation | `npm run dev` | Nothing. The twin simulates the line |
| 2. Virtual PLC | `npm run dev:plc-sim` (+ `npm run fuxa`) | The **Modbus protocol path**: virtual PLC ↔ bridge ↔ HMI, and virtual PLC ↔ FUXA. Optionally real ESP32 nodes (`VPLC_NODES`) |
| 3. Real PLC, no field devices | Twin service with `PLC_HOST=<plc ip>` (`PLC_COIL_BASE=0`); PLC with simulated inputs | PLC program and network |
| 4. Full prototype | Same as 3 | Everything |

- **Stage 2** runs [`twin/src/plc/virtual-plc.ts`](../../twin/src/plc/virtual-plc.ts), which exposes the simulated line on the exact register map the Micro850 must implement. Use it as the **reference implementation** when writing the PLC program. It simulates both ESP32 nodes in-process by default. To test real nodes before the PLC exists, point their firmware at `<dev PC IP>:5020` and start the virtual PLC with `VPLC_NODES=scanner`, `station` or `all` ([../configuration.md](../configuration.md#virtual-plc-npm-run-virtual-plc)); the virtual PLC then watches their heartbeats and latches a fault if one goes offline.
- **Automated tests** (`npm test`) cover the Modbus implementation, the register encoding, the scan mailbox, the robotic arm handshake, station faults, command handshakes against the virtual PLC, and that the generated firmware header and FUXA project match the register map.

## What has and hasn't been verified

| Item | Status |
| --- | --- |
| Twin engine (BOM station order, 3 E-Stops, sort lanes, station faults), HMI, Modbus client/server, virtual PLC ↔ bridge round trip with simulated ESP32 nodes | Automated tests |
| ESP32 firmware (`firmware/scanner-node`, `firmware/station-node`, `firmware/lib/captsone_node`) | Written against the register map ([esp32.md](esp32.md)); **not yet proven on the hardware** |
| Micro850 program, wiring | **Not written or tested yet.** These documents are the specification for them |
| 2080-L50E-48QBB facts (Modbus mapping, IO, connection limits, CCW 20.01+) | From Rockwell's published material; **verify** against the team's controller and its firmware ([micro850-plc.md](micro850-plc.md)) |
| FUXA | Installed natively with `npm run fuxa`; the project is generated from the register map and runs against the virtual PLC ([scada.md](scada.md)). **Not tested against the Micro850 yet** (commissioning §3) |
| OPC UA | Tag mapping specified; the bridge implements Modbus TCP only |
