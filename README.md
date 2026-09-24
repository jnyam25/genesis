# Captsone Industrial Paint Mixing System — Digital Twin

Captsone is an industrial paint-mixing and bottling line. Empty bottles ride a belt past, in order:
- a label applicator and a barcode scanner,
- one fill bay per tank (gravity tanks with proportional valves),
- a robotic capping arm, which lifts a lid from a lid magazine, places it on the bottle and presses it down,
- a sort sensor (quality check: it measures the bottle height),
- a reject diverter,
- and a sort diverter that splits accepted bottles into lane A (small) and lane B (large).

Each bottle's label carries a **preprinted custom barcode** that encodes the dispense instructions directly: how many millilitres to draw from each tank. The line reads the barcode, stops the bottle at the bays it needs, fills and caps it, checks it, and rejects it or sorts it, with multiple bottles flowing at once. E-Stops sit at the line entry, the line exit and the control panel.

This repo holds:
- the **digital twin** of that line (a Node/TypeScript simulation engine plus a virtual PLC that speaks the real PLC's register map),
- the **operator HMI**,
- the **integration layer and documentation for the physical prototype**: the team's Allen-Bradley Micro850 PLC (2080-L50E-48QBB), two ESP32 station nodes and a monitoring PC, connected over Modbus TCP, with the bill of materials reconciled against the software ([docs/prototype/bom.md](docs/prototype/bom.md)),
- the **ESP32 firmware** for the two station nodes (`firmware/`) and the **FUXA SCADA** setup (`deploy/fuxa/`).

## Why a twin

The twin mirrors the control logic of the real line, so operators and integrators can:

- preview how a new paint colour or tank behaves before wiring hardware,
- validate new preprinted barcode formats without printing runs,
- watch live throughput, OEE, and accept/reject counts,
- develop the HMI, the Pi bridge and the field-node firmware against a **virtual PLC** before the hardware exists.

## Repository layout

```
genesis/
  README.md               # this file
  INSTALL.md              # setting up on a new computer (USB copy, scripts, troubleshooting)
  package.json            # root orchestration scripts (no dependencies)
  scripts/                # install / run-all / build / doctor / clean / fuxa helpers (plain Node)
  docs/
    engine-design.md      # twin design rationale
    frontend-design.md    # HMI design rationale
    api.md                # HTTP API reference
    configuration.md      # line config + environment variables
    operator-guide.md     # using the HMI
    prototype/            # physical prototype: BOM, safety, IO map, Micro850 PLC, ESP32, SCADA, commissioning
  deploy/
    raspberry-pi/         # systemd units, env template, kiosk autostart
    fuxa/                 # native FUXA install (npm run fuxa) and the generated SCADA project
  firmware/               # ESP32 firmware (PlatformIO)
    scanner-node/         # ESP32 #1: label applicator + barcode scanner
    station-node/         # ESP32 #2: robotic capping arm + sort sensor
    lib/captsone_node/    # shared Modbus/register library; captsone_registers.h is generated
  twin/                   # twin engine, PLC bridge, virtual PLC, tests
    src/plc/              # register map, Modbus TCP, virtual PLC, simulated ESP32 nodes, bridge, FUXA project
  hmi/                    # operator HMI (Next.js 16)
```

## Quick start

Requires **Node.js 20.9+** (LTS 22 recommended). From the repo root:

```bash
npm install
```

```bash
npm run dev
```

`npm install` also installs `twin/` and `hmi/`. `npm run dev` starts both, with the HMI showing the live twin:

- HMI: http://localhost:43123 (Controls: digital E-Stop, start/stop, jog, tanks go to the twin)
- Twin dashboard: http://127.0.0.1:43124/
- API and health: http://127.0.0.1:43124/hmi/state, http://127.0.0.1:43124/health ([docs/api.md](docs/api.md))

| Command | What runs |
| --- | --- |
| `npm run dev` | Simulated line + HMI |
| `npm run dev:plc-sim` | **Virtual PLC (Modbus TCP) → twin in PLC-bridge mode → HMI**: the physical architecture, in software |
| `npm run dev:mock` | HMI on its built-in mock feed |
| `npm run virtual-plc` | Only the virtual PLC (Modbus TCP on port 5020), with both ESP32 nodes simulated. `VPLC_NODES=scanner`, `station` or `all` uses real ESP32 nodes instead ([docs/configuration.md](docs/configuration.md#virtual-plc-npm-run-virtual-plc)) |
| `npm run fuxa` | FUXA SCADA at http://127.0.0.1:1881 (editor `/editor`, operator view `/home`). Installs FUXA into `deploy/fuxa` on first use ([docs/prototype/scada.md](docs/prototype/scada.md)) |
| `npm run fuxa:project` | Regenerates the FUXA project from the register map and loads it into a running FUXA |
| `npm run tag-map` | Regenerates the register tables in [docs/prototype/io-map.md](docs/prototype/io-map.md) and the firmware header `captsone_registers.h` |
| `npm test` | Automated tests (twin engine, Modbus, virtual PLC ↔ bridge, simulated ESP32 nodes, generated files) |
| `npm run build` then `npm start` | Production |
| `npm run doctor` | Environment check |

Moving the project to another computer, or having install problems: see **[INSTALL.md](INSTALL.md)**.

## Physical prototype

Start at **[docs/prototype/README.md](docs/prototype/README.md)**, and read **[docs/prototype/safety.md](docs/prototype/safety.md)** before powering hardware. In short:
- the team's Allen-Bradley Micro850 PLC (2080-L50E-48QBB) supervises the line (belt, valves, diverters, E-Stop monitoring) with a touch panel or hardwired buttons for local control; it's programmed with the free CCW Standard Edition;
- two ESP32 nodes on Wi-Fi execute PLC requests and report back: the scanner node runs the label applicator and forwards the raw barcode text, and the station node runs the robotic capping arm (a Hiwonder xArm) and measures the bottle height at the sort sensor. The **PLC makes every decision**: it validates the barcode, sequences the arm, classifies the bottle type and latches a station fault when a node fails or goes offline ([docs/prototype/esp32.md](docs/prototype/esp32.md));
- a monitoring PC (or a Raspberry Pi) runs the bridge (`CAPTSONE_MODE=plc`), the HMI and the SCADA, [FUXA](https://github.com/frangoteam/FUXA) (open source, MIT), installed natively with `npm run fuxa` ([docs/prototype/scada.md](docs/prototype/scada.md)). Nothing in the stack needs a software subscription ([docs/prototype/bom.md §2a](docs/prototype/bom.md#2a-software-no-subscriptions)).

Everything is specified by one register map ([`twin/src/plc/tag-map.ts`](twin/src/plc/tag-map.ts), protocol version 4, tables in [docs/prototype/io-map.md](docs/prototype/io-map.md)). The firmware header and the FUXA project are generated from it.

## Key design points

See [docs/engine-design.md](docs/engine-design.md) for the full reasoning.

- **Dynamic paint sources.**
  - Eight fixed tank slots (`T1..T8`), each with its own bay and PLC register block.
  - Adding a tank is a config edit, or an "add tank" command at runtime, plus barcodes with one more volume field.
  - No controller or parser rewrite.
- **Custom preprinted barcode.** `PT1|T<totalMl>|<v1>,...,<vN>[|I<rounds>]` encodes per-tank volumes directly (not a recipe-id lookup).
- **mix_sequence and belt order.**
  - Per-tank volumes become an ordered dispense plan.
  - On a one-way belt with one bay per tank, each container visits each bay once, in belt order.
- **Multi-container pipelining.** Station stoppers hold containers while the belt runs continuously; one control sequence per container.
- **Bounded waits.** Every wait has a timeout that pauses while the line is halted. A jam rejects that container and frees the station.
- **The PLC decides; the field nodes execute.**
  - The scanner node only forwards what it read. The PLC validates the barcode, and a no-read or a bad barcode rejects the container.
  - The station node only reports the measured bottle height. The PLC compares it with the lane the recipe calls for and rejects a mismatch.
  - A failing or silent node latches a **station fault**: the line stops, START is refused, and RESET clears the fault once the cause is fixed.
- **One set of rules.**
  - Barcode parsing, structured event codes and OEE/throughput maths are defined once and used by the Node twin and the virtual PLC; the bridge decodes the PLC's events with the same codes.
  - A physical PLC reports the same numbers and events.
- **Physical and digital E-Stops work together.**
  - Physical buttons cut power in hardware and put the whole control system into E-Stop; the HMI names the button.
  - The HMI's Digital E-Stop opens the same safety circuit through a fail-safe PLC output.
  - Restart takes release, a reset at the machine, then START.
- **Local control station.** A LOCAL/REMOTE key and START/STOP/RESET/JOG on the machine. In LOCAL mode the HMI is view-only, except E-Stop and Stop.

## Status

- **Verified by automated tests and end-to-end runs (including the E-Stop and local/remote sequences):**
  - the Node twin and HMI;
  - the Modbus TCP client/server;
  - the virtual PLC ↔ bridge ↔ HMI chain, including commands, the scan mailbox, the robotic arm handshake, station faults and the simulated ESP32 nodes;
  - the generated firmware header and FUXA project, which the tests check against the register map.
- **Written, not yet proven on hardware:** the ESP32 firmware (`firmware/`, see [docs/prototype/esp32.md](docs/prototype/esp32.md)) and the FUXA setup (`npm run fuxa`, run against the virtual PLC).
- **Specified but not yet built:** the Micro850 program and the wiring ([docs/prototype/commissioning.md](docs/prototype/commissioning.md)).
