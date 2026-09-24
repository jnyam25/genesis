# SCADA: FUXA

**The team's SCADA is [FUXA](https://github.com/frangoteam/FUXA)** ([documentation](https://frangoteam.github.io/FUXA/)): open source (MIT), web-based, with no runtime licence and no subscription. It runs on the monitoring laptop next to the bridge and reads the Micro850 (2080-L50E-48QBB) over Modbus TCP, using the same register map as the bridge.

This page explains what SCADA adds (§1–§2), why FUXA was chosen (§3–§4), how to install and configure it (§5), and how to map the register map onto trends, history and alarms (§6). FUXA is installed from the repo (`npm run fuxa`) and has been tested against the virtual PLC; it hasn't been connected to the real Micro850 yet. Record results in the §7 checklist. Facts were checked against FUXA's repository and documentation and vendor sources in September 2026. Anything marked **unverified** still needs checking.

Two team constraints apply: the PLC is the team's **Allen-Bradley Micro850 2080-L50E-48QBB**, and the software must work **without a subscription** (no annual fees, leased or time-limited licences).

## 1. Purpose and scope

**SCADA** (supervisory control and data acquisition) is the layer above the PLC and the operator panels. For this line it means:

- **Supervisory monitoring.** One or more overview screens (line state, E-Stops, tanks, counts, stations) that anyone on the control network can open.
- **Historian / logging.** Tank levels, counts, throughput, OEE and line state are stored on the monitoring PC with timestamps, so a run can be reviewed afterwards.
- **Alarming.** A persistent alarm list with start and clear times and acknowledgement, built from the PLC's state bits and event ring.
- **Trending.** Plots of stored values over minutes, hours or a whole demo day.
- **Multi-screen operator views.** Separate screens for overview, tanks, alarms and reports, instead of the web HMI's single operator view.

**What already exists.** The Micro850 runs all control. The local control station (touch panel or hardwired buttons) is the operator station at the machine. The web HMI and its bridge ([README](README.md#architecture)) already give live state, operator commands, and the last 8 PLC events (`recentEvents` in [../api.md](../api.md)). What the current software doesn't have is **history, a persistent alarm journal, trends and reports**. That gap is the reason to add SCADA.

**SCADA is supervisory only.** It never replaces:
- the **PLC's control logic**: sequencing, interlocks, E-Stop latching, reset and start rules all stay in the Micro850 program ([micro850-plc.md](micro850-plc.md));
- the **hardwired E-Stop / safety relay chain**: physical E-Stops remove actuator power in hardware, whatever any software does ([safety.md](safety.md)).

The line must keep running, and stop safely, if the SCADA PC is off, crashed or disconnected.

**Writes.** SCADA is **read-only** by default ([communication.md §2](communication.md#who-writes-what)). If the team decides SCADA needs command buttons, it may only use the **same command coils the web HMI uses** (`Cmd.*`, coils 0–15), with the same one-shot pulse semantics. The generated project adds exactly those buttons when built with `FUXA_COMMANDS=1` (§6.5). The PLC decides whether to act on them: it applies the same LOCAL/REMOTE and E-Stop refusals as for the bridge ([safety.md §3](safety.md#3-control-authority-local-vs-remote)). SCADA must never write holding registers, `Sim.*` inputs, ESP32 mailbox registers or anything outside the register map, and it must never be the only way to stop the line.

## 2. Requirements

Derived from the register map ([io-map.md §4](io-map.md#4-register-map-modbus-tcp)), the BOM ([bom.md](bom.md)) and the team's constraints.

| # | Requirement | Why |
| --- | --- | --- |
| R1 | **Modbus TCP client** to the Micro850 (port 502, unit id 1) | The Micro850 has no OPC UA server. Modbus TCP is what the bridge and ESP32 nodes already use |
| R2 | Reads the **existing register map** unchanged: holding registers at 0-based addresses 0–499, with UINT16 values, integer scaling (`× 10`, `× 100`, `× 1000`) and bit-packed words (`Sys.LineState`, `Tank<k>.Flags`) | One map is the contract; SCADA must not need PLC changes |
| R3 | **Block reads** (one request per contiguous block, up to 125 registers) at a configurable rate | Predictable load on the PLC; the blocks match the Micro850's Modbus mapping arrays ([micro850-plc.md §2](micro850-plc.md#2-modbus-address-mapping)) |
| R4 | **Historian** on the PC/laptop: counts, OEE, throughput, tank levels, line state, events and alarms | The main gap in the current software |
| R5 | **Alarm list** with active/cleared state, timestamps and acknowledgement | Replaces "last 8 events" with a journal |
| R6 | **Trends** of any logged value over a chosen time range | Review of runs and the final presentation |
| R7 | Runs on the team's **Windows laptop**; ideally also on a **Raspberry Pi / Linux** | The monitoring PC may be either ([raspberry-pi.md](raspberry-pi.md)) |
| R8 | **No subscription**: free to use indefinitely, no leased or time-limited licence, and terms that allow a university capstone | Team decision; the hardware BOM is also over the ~$500 budget ([bom.md §4](bom.md#4-budget)) |
| R9 | **Student-friendly**: installs in an afternoon, documented, active community | Limited time in one semester |
| R10 | **Read-only by default**, with user accounts if exposed beyond one PC | §1 and §6.5 |
| R11 | Can also read the **virtual PLC** on port 5020 | Develop and test before the hardware exists (`npm run dev:plc-sim`) |

## 3. Options compared

| Option | Licence | No subscription? | Modbus TCP client | Historian / logging | Runs on | Fit for this project |
| --- | --- | --- | --- | --- | --- | --- |
| **FUXA** | MIT; no runtime licence (optional €100 one-time "Pro", not needed) | **Yes** | Built in (also an Allen-Bradley EtherNet/IP driver) | Built-in DAQ (SQLite, InfluxDB) | Node.js: Windows, Linux, Pi | **Chosen**: all-in-one, free, web-based |
| Node-RED + node-red-contrib-modbus + Dashboard 2.0 (+ InfluxDB / Grafana) | Apache 2.0 / BSD-3 / Apache 2.0 (+ MIT/Apache, AGPLv3) | **Yes** | Yes (contrib nodes) | DIY: CSV/SQLite, or InfluxDB + Grafana | Node.js: Windows, Linux, Pi | Fallback for event-ring journaling; alarms and screens are more work |
| Rapid SCADA 6 | Apache 2.0 | **Yes** | Built-in driver | Built-in archives (files, PostgreSQL, InfluxDB) | Windows, Linux | Capable but heavier to learn |
| AdvancedHMI | GPLv2 | **Yes** | Built-in drivers, including EtherNet/IP for Micro800 | None built in (write your own) | Windows (.NET) | HMI toolkit rather than SCADA |
| Ignition (trial, Maker, EEP, Edge, standard) | Commercial | **No** | Built-in driver | Tag Historian | Windows, Linux, macOS | **Ruled out** (see below) |
| Rockwell FactoryTalk View SE / ME, FactoryTalk Optix | Commercial | **No** (paid; Rockwell sells FactoryTalk software through subscription bundles) | — | — | Windows | **Ruled out** |
| PanelView 800 / C-more Micro / budget panel | Panel hardware; screen software is free (CCW Standard, C-more Micro software) | Yes | — | None | Panel | **HMI, not SCADA** |

### FUXA

FUXA is a web-based SCADA/HMI written in Node.js and Angular, MIT-licensed. Its documentation states that it "does not require any runtime licenses", for any number or size of projects. It has Modbus RTU/TCP, Allen-Bradley EtherNet/IP, OPC UA, S7, MQTT and other drivers; a built-in historian (DAQ) on SQLite or InfluxDB; alarms; real-time and historical charts; user permissions; and a browser-based drag-and-drop editor. It runs on Windows, Linux, macOS, Docker and Raspberry Pi. The optional **FUXA Pro** (€100 one-time) adds white-labelling, templates and extra event logging; the open-source version is complete without it. The project is active: v1.3.4 was released on 12 August 2026.

FUXA also has an **Allen-Bradley EtherNet/IP** driver. Use **Modbus TCP** anyway, so FUXA reads exactly the register map the bridge reads, with the same scaling and no PLC changes.

Things to watch:
- FUXA's documentation still recommends **Node.js 18 LTS**, while this repo targets Node 22 (`.nvmrc`). FUXA 1.3.4 installed from npm runs on the repo's Node: the team tested it on Node 24 against the virtual PLC (§5.1). If a future FUXA release breaks on newer Node, use the headless portable binary instead.
- A 2023 report ([issue #959](https://github.com/frangoteam/FUXA/issues/959)) had Modbus TCP devices stop updating in one release installed from source; reinstalling fixed it. **Pin a version** that works against the virtual PLC and don't upgrade before the demo.
- Alarms are limit-based on tag values. Journaling the PLC's **event ring** (de-duplicating by sequence number) needs a server-side script, or a small Node-RED flow next to FUXA. How well FUXA scripts handle this is **unverified**.

### Node-RED (+ node-red-contrib-modbus, Dashboard 2.0, InfluxDB / Grafana)

Node-RED (Apache 2.0) is a flow-based tool that many students already know. [`node-red-contrib-modbus`](https://flows.nodered.org/node/node-red-contrib-modbus) (BSD-3-Clause, LTS line v5.x) provides a Modbus TCP client with periodic reads (FC1–4), writes (FC5/6/15/16), a request queue and automatic reconnect. Screens come from **Dashboard 2.0** (`@flowfuse/node-red-dashboard`, Apache 2.0); the original `node-red-dashboard` is deprecated. For history, the simplest path is appending rows to CSV or SQLite from a flow. The fuller path is **InfluxDB 3 Core** ([MIT / Apache 2.0](https://www.influxdata.com/products/influxdb/)) plus **Grafana OSS** (AGPLv3; free to use internally). Everything runs on Windows and a Pi. Stick to the open-source editions: FlowFuse's hosted Node-RED and Grafana Cloud are paid services.

Node-RED is excellent at the logging part: decoding scaled values, splitting bit words, and journaling the event ring by sequence number are a few function nodes. It has no built-in alarm system or SCADA screens, so alarm acknowledgement and multi-screen views are extra work.

### Rapid SCADA

[Rapid SCADA 6](https://github.com/RapidScada/scada-v6) is Apache 2.0 open source with no tag or time limits. It has a Modbus driver, archives in files, PostgreSQL or InfluxDB, events with acknowledgement, a web interface, user activity logging and HTTPS ([feature list](https://rapidscada.net/docs/en/6.4/software-overview/introduction)). It's supported on Windows and Linux. Older forum posts show it running on a Raspberry Pi, but we didn't find a current guide for version 6 on a Pi (**unverified**). It's a real SCADA and a reasonable choice, but its .NET-based configuration tools and concepts (channels, devices, communicator lines) take longer to learn than FUXA, and its community is smaller.

### AdvancedHMI

[AdvancedHMI](https://www.advancedhmi.com/) is a free (GPLv2) set of .NET controls for Visual Studio Community. It has Modbus TCP and Allen-Bradley EtherNet/IP drivers, including one for the Micro800 family ([SourceForge](https://sourceforge.net/projects/advancedhmi/)). It builds fast Windows desktop HMIs without code, but the historian, alarm journal and trends would have to be written in VB or C#. The stable 3.99x line no longer gets updates. It's a good fit for a team that wants to write C#; for this project it's an HMI toolkit, not a SCADA.

### Why Ignition is ruled out

Ignition is the most widely used "modern" SCADA platform and has everything this project wants, but none of its routes meets R8:
- **Trial mode** stops device polling, clients and reports every 2 hours until someone clicks "Reset Trial" ([licensing docs](https://www.docs.inductiveautomation.com/docs/8.1/platform/licensing-and-activation)). That leaves gaps in a historian.
- **Maker Edition** is free but for individuals' personal use only. The [licence agreement](https://inductiveautomation.com/ignition/license) excludes use for the benefit of an educational institution, and the [Maker page](https://inductiveautomation.com/ignition/maker-edition) excludes schools and non-profits. It also uses a **leased licence** that must check in with Inductive Automation every hour and falls back to trial mode after 48 hours offline ([leased licensing](https://www.docs.inductiveautomation.com/docs/8.1/platform/licensing-and-activation/leased-licensing)).
- **Educational licences** through the [Educational Engagement Program](https://inductiveautomation.com/educational-engagement) are granted case by case and need the sponsoring professor in the discussion. They aren't free software the team controls.
- **Edge and standard licences** are paid ($945 and up), with renewing support plans.

### Rockwell's own options

- **FactoryTalk View** and **FactoryTalk Optix** are Rockwell's SCADA/HMI products. They're paid, and Rockwell sells FactoryTalk software through subscription bundles, so they fail R8. Rockwell's OPC gateway (FactoryTalk Linx Gateway) is paid too.
- **PanelView 800** terminals are **HMIs**, not SCADA: one local screen, no PC-side historian. Their screens are built in CCW Standard, which is free ([micro850-plc.md §1](micro850-plc.md#local-operator-panel)).
- **CCW Developer Edition** is an annual subscription and isn't needed; CCW Standard programs the Micro850.

## 4. Decision

**FUXA is the SCADA. It runs on the monitoring laptop next to the bridge, as a second Modbus TCP client of the Micro850 that reads the same register map and, by default, writes nothing.** If FUXA can't journal the event ring cleanly, add a small Node-RED flow for that one job. There's no paid upgrade path in the plan; Rapid SCADA is the open-source alternative if FUXA falls short.

Reasoning:
- **No subscription.** FUXA is MIT-licensed, needs no runtime licence and is complete without payment (R8). Every Ignition and FactoryTalk route needs a paid, leased or time-limited licence.
- **Coverage.** FUXA covers R1–R7 in one install: Modbus TCP client, historian, alarms, trends and multiple web views. Node-RED needs InfluxDB and Grafana, plus hand-built alarms, to reach the same point.
- **Fit with the team.** FUXA is Node.js and browser-based like the rest of the repo. `npm run fuxa` installs and starts it from the repo with no Docker and no admin rights, on Windows or a Pi.
- **Independence.** A direct Modbus client keeps working if the bridge or web HMI is restarted, which is what SCADA is for. The Micro850 has plenty of connections for it (below). The alternative, reading the bridge's `GET /hmi/state`, stops when the bridge stops.

**Where it sits in the architecture.** SCADA is one more client on the wired control network. It reads the PLC in parallel with the bridge, writes nothing (unless command buttons are turned on, §6.5), and stores its history on the laptop's disk.

```
                   Monitoring PC/laptop (192.168.10.20)
   ┌──────────────────────────────────────────────────────────────┐
   │ Web HMI ── bridge (Modbus client #1, writes coils/heartbeat) │
   │ FUXA SCADA (Modbus client #2, reads only) → local historian  │
   └───────────────┬──────────────────────────────────────────────┘
                   │ wired Ethernet, control network only
                switch ──── Micro850 Ethernet (up to 16 Modbus TCP server connections)
                   ├─────── access point (bridge mode) ── ESP32 #1, ESP32 #2
                   └─────── touch panel on Ethernet (if used)
```

**Concurrent connections on the Micro850.** Rockwell's user manual lists **16 simultaneous Modbus TCP server connections** for the Micro850 ([2080-UM002](https://literature.rockwellautomation.com/idc/groups/literature/documents/um/2080-um002_-en-e.pdf)). Everything the team wants to connect fits:

| Client | Connections |
| --- | ---: |
| Bridge | 1 |
| SCADA (FUXA) | 1 |
| ESP32 #1, ESP32 #2 (+ optional tank node) | 2–3 |
| Touch panel on Ethernet (if used) | 1 |
| Modbus test tool (mbpoll, QModMaster) while commissioning | 1 |

That's at most 7 of 16. Each client should still keep **one persistent connection** and close it cleanly. Whether and when the Micro850 times out half-open connections is **unverified**.

## 5. Setting up FUXA

### 5.1 Install

**FUXA installs from the repo, natively, with no Docker and no admin rights.** From the repo root:

```bash
npm run virtual-plc   # terminal 1: the virtual PLC on 127.0.0.1:5020 (skip when using the real Micro850)
npm run fuxa          # terminal 2: installs FUXA on first use, then starts it
```

Then open the editor at <http://127.0.0.1:1881/editor> or the operator view at <http://127.0.0.1:1881/home> (Chrome is FUXA's recommended browser). Ctrl+C stops FUXA.

What [`scripts/fuxa.mjs`](../../scripts/fuxa.mjs) does:

- **Install (first run only, a few minutes).** It runs `npm ci` in [`deploy/fuxa`](../../deploy/fuxa/package.json), which pins **`@frangoteam/fuxa` 1.3.4** and **`modbus-serial` 8.0.19**. FUXA's Modbus driver needs `modbus-serial`; without it the Modbus device shows "plugin is missing". The packages go to `deploy/fuxa/node_modules` (gitignored). Behind a TLS-inspecting proxy, retry with `NODE_OPTIONS=--use-system-ca`.
- **Settings.** It seeds `deploy/fuxa/data/_appdata/settings.js` from FUXA's defaults so FUXA listens on **127.0.0.1 only**. Set `FUXA_HOST=0.0.0.0` to serve panels on the LAN, but only after turning on login (§5.4).
- **Project.** On the first start (or with `npm run fuxa -- --load`), it loads the project generated from the register map (§5.3). FUXA keeps the project, history (DAQ), alarms and logs in `deploy/fuxa/data` (gitignored), so they survive restarts.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FUXA_PORT` | 1881 | FUXA's web port |
| `FUXA_HOST` | 127.0.0.1 | Listen address; `0.0.0.0` for the LAN (§5.4 first) |
| `FUXA_DATA` | `deploy/fuxa/data` | Project, history and logs |
| `PLC_HOST`, `PLC_PORT`, `PLC_UNIT_ID` | 127.0.0.1, 5020, 1 | The PLC the generated project reads |
| `FUXA_POLL_MS` | 1000 | Polling period of the generated device |
| `FUXA_COMMANDS` | unset (read-only) | `1` adds the command coils and buttons (§6.5) |

FUXA 1.3.4 ran on the repo's Node version (tested on Node 24) even though FUXA's documentation still recommends Node 18. On a Raspberry Pi, the same `npm run fuxa` applies.

**Alternatives (all free),** if the npm install doesn't work on a machine:

| Option | How | Notes |
| --- | --- | --- |
| Headless portable binary | Download `fuxa-headless-win-x64.exe` (or the Linux/macOS/ARM build) from the [headless build artifacts](https://github.com/frangoteam/FUXA/actions/workflows/headless_packaging.yml) and run it | No Node needed. Data lives in `~/.fuxa-headless-data`. Needs a GitHub login to download; built from the latest code, so record the build date as the "version". Load the project with **Open Project** (§5.5) |
| Electron desktop app | [Electron build artifacts](https://github.com/frangoteam/FUXA/actions/workflows/electron_latest.yml) | Stand-alone window instead of a browser |

Whatever the install, FUXA listens on port **1881**.

### 5.2 Connect to the PLC

The generated project already contains the PLC as a Modbus TCP device named **Micro850**; you don't create it by hand. Its settings:

| Setting | Virtual PLC (stage 2) | Micro850 (stage 3 onward) |
| --- | --- | --- |
| Type | Modbus TCP | Modbus TCP |
| Address | `127.0.0.1:5020` | `192.168.10.10:502` |
| Slave ID (unit id) | 1 | 1 |
| Polling | 1000 ms | 1000 ms |

To switch to the real PLC, regenerate and reload the project with the PLC's address (PowerShell shown; use `PLC_HOST=... npm run fuxa:project` in bash):

```powershell
$env:PLC_HOST="192.168.10.10"; $env:PLC_PORT="502"; npm run fuxa:project
```

`npm run fuxa:project` needs FUXA running; it replaces the whole FUXA project (edits made in the FUXA editor are lost, §5.5). You can also change the address under **Connections** in the editor. Allow port 5020 through the Windows firewall if FUXA can't reach the virtual PLC, and start the virtual PLC with `npm run virtual-plc` (alone) or `npm run dev:plc-sim` (the whole chain with the HMI).

### 5.3 Tags, alarms and the overview screen (generated)

[`twin/src/plc/fuxa-project.ts`](../../twin/src/plc/fuxa-project.ts) builds the FUXA project from the same register table as [io-map.md](io-map.md#4-register-map-modbus-tcp) and the bridge, so the tags can't drift from the PLC. `npm run fuxa-project --prefix twin` writes it to [`deploy/fuxa/captsone-project.json`](../../deploy/fuxa/captsone-project.json); `npm run fuxa:project` also loads it into the running FUXA. The twin tests check that every screen item and alarm points at an existing tag.

- **Tags:** one `UInt16` holding-register tag per register-map entry, named as in the map (`Sys.LineState`, `Tank1.LevelMl` …). The 32 raw barcode text registers (`Scan.Text*`, 304–335) are left out; the PLC's parse result and recipe id (336–338) are included.
- **Addresses:** FUXA addresses are **1-based**, like CCW: register-map holding register **N** is FUXA address **N + 1** (FUXA sends N on the wire). The generator does this. `Sys.ProtocolVersion` (register 0) is address 1 and must read **4**; `Sys.PlcHeartbeat` (register 1) keeps changing.
- **Scaling:** registers whose unit says `× 10`, `× 100` or `× 1000` get FUXA's divisor and matching decimals, so `Tank1.LevelMl` shows millilitres, not tenths.
- **Bits:** status words (`Sys.LineState`, `Tank<k>.Flags`, `Station.ArmStatus`) are shown as lamps that test one bit (FUXA's bitmask), so no scripts are needed.
- **History:** DAQ logging is on for every register except the heartbeat counters: a value is stored on every change and at least once a minute (§6.1).
- **Alarms:** the §6.2 alarms are part of the project.
- **Screen:** one dark **Line overview** view: line state and E-Stops, production counts and OEE, stations (last scan result, robotic arm status and result, sort height), tanks, and a command panel (read-only text unless `FUXA_COMMANDS=1`).

Add more views, charts or tags in the FUXA editor if needed, then keep them as described in §5.5.

**Block reads:** FUXA merges tags into one Modbus read only when their addresses are contiguous, and it starts a new read at every 100-register boundary. The generated tags cover the register map's blocks, so FUXA reads each block in a few requests; the gap left by `Scan.Text*` costs one extra request per poll.

§6 lists what to read, trend and alarm on.

### 5.4 Login and access

FUXA starts **without login**, and its default account is `admin` / `123456`. Before anyone else can reach port 1881:

1. Edit `deploy/fuxa/data/_appdata/settings.js`: set `secureEnabled: true`, a long random `secretCode`, and `tokenExpiresIn` (e.g. `'1d'`). Restart FUXA (Ctrl+C, then `npm run fuxa`).
2. Log in as `admin`, change its password, and create read-only viewer accounts for the demo.
3. Only then start FUXA with `FUXA_HOST=0.0.0.0` so other machines can reach port 1881 (§6.4).

### 5.5 Keep the project in git

FUXA saves the project to its internal database (`deploy/fuxa/data`, not in git) after every change. The committed source of truth is the generator and its output, [`deploy/fuxa/captsone-project.json`](../../deploy/fuxa/captsone-project.json), which always matches the repo's register map (`Sys.ProtocolVersion`). When the register map changes, run `npm run fuxa:project` to regenerate and reload it.

`npm run fuxa:project` and `npm run fuxa -- --load` **replace** the whole FUXA project. Changes made only in the FUXA editor are lost unless you either:
- add them to the generator (preferred for anything permanent: tags, alarms, the overview screen), or
- export them with **Save Project As** to a separate file such as `deploy/fuxa/captsone-custom.json`, commit that, and load it with **Open Project** instead of regenerating.

## 6. Integration notes

### 6.1 What to read, trend and log

The bridge (`twin/src/plc/bridge.ts`) reads **0–19** (system), **20–67** (tanks), **100–139** (containers) and **200–232** (event ring). The generated FUXA project reads those plus the barcode scan mailbox (**300–303** and **336–338**, without the raw text), the field block (**400–412**: ESP32 heartbeats), the station block (**420–432**: run permit, robotic arm command/result/status, sort height, node fault bits) and the simulation inputs (450–451). Scaling follows the `Unit` column in [io-map.md §4](io-map.md#4-register-map-modbus-tcp), and the generator applies it (§5.3). DAQ stores every tag on change and at least once a minute, which covers the table below.

| Data | Registers (0-based) | Scale | Store |
| --- | --- | --- | --- |
| Tank levels | `Tank<k>.LevelMl` = 20 + 6(k−1) | ÷ 10 → ml | Trend every 1 s |
| Throughput | `Perf.ThroughputCpm` = 8 | ÷ 100 → containers/min | Trend every 1 s |
| OEE | `Oee.Availability/Performance/Quality/Overall` = 9–12 | ÷ 1000 → 0..1 | Trend every 1 s (availability reads 0 while stopped, by design) |
| Active containers | `Sys.ActiveContainers` = 15 | count | Trend every 1 s |
| Counts | `Counts.Accepted/Rejected/Total` = 5–7, `Counts.LaneA/LaneB` = 17–18 | count | Log on change (and every minute) |
| Line state | `Sys.LineState` = 2, `Sys.PhysicalEStopMask` = 16 | bits | Log on change; drives alarms |
| Tank config | `Sys.TankCount` = 3, `Sys.TankEnableMask` = 4, `Tank<k>.Flags`, `Tank<k>.ValveOpeningPct` | bits / % | Log on change |
| Events | `Events.LastSeq` = 200, `Event1..8.Seq/Code/Arg1/Arg2` = 201–232 | codes | Journal every new event once (§6.2) |
| Stations | `Scan.ParseResult/ResultId` = 336–337, `Station.ArmResult/ArmStatus` = 426–427, `Station.SortHeightMm` = 430 | codes / bits / mm | Log on change |
| Faults | `Sys.FaultCode` = 19, `Station.ScannerNodeFaults/StationNodeFaults` = 431–432 | code / bits | Log on change; drives alarms |
| Link health | `Sys.PlcHeartbeat` = 1, `Field.*NodeHeartbeat` = 410–412 | count | Alarm if unchanged for 3 s; don't trend (DAQ is off for these) |

All registers are UINT16. Heartbeats, sequence numbers and counters wrap from 65 535 to 0 (sequence numbers skip 0), so compute per-shift totals as differences that allow for one wrap. Remember the FUXA address is the register number + 1 (§5.3).

For per-container fill accuracy, use the `CONTAINER_ACCEPTED` / `CONTAINER_REJECTED` events (arg2 carries the fill or reject reason) rather than the container table. Finished containers stay in the table for only about 1.5 s.

### 6.2 Alarms

Build alarms from **state bits and codes** (an alarm is active while the condition holds), and journal the **event ring** separately (events are one-off records). In FUXA, alarms are set on tags ([alarm guide](https://frangoteam.github.io/FUXA/)); a bit is tested with the alarm's bitmask and a code with a min/max range. The PLC makes every fault decision: it latches **one** `Sys.FaultCode` and sets `LineState` bit3, so SCADA only reports what the PLC decided.

The **Generated** column marks the 18 alarms already in the generated project; add the others in the FUXA editor (and keep them as in §5.5) if the team wants them.

| Condition | Source | Priority | Generated |
| --- | --- | --- | --- |
| E-Stop active | `LineState` bit1 | Critical | Yes |
| Line fault: labeler, barcode scanner, arm servo, arm found no lid, arm lost the lid, sort sensor, scanner node offline, station node offline | `Sys.FaultCode` = 1…8 (one alarm per code, text from the PLC's fault table) | High | Yes (8) |
| Safety reset required | `LineState` bit7 | Warning | Yes |
| Tank k low | `Tank<k>.Flags` bit2 | Warning | Yes (one per tank slot, 8) |
| Digital E-Stop latched | `LineState` bit5 | Critical | No |
| Physical E-Stop pressed (panel / line entry / line exit) | `LineState` bit6 + `PhysicalEStopMask` bits 0/1/2 | Critical, one alarm per button | No |
| Safety circuit open | `LineState` bit2 = 0 | High | No |
| ESP32 node fault bits (raw report behind a fault code) | `Station.ScannerNodeFaults` (431: bit0 labeler, bit1 scanner), `Station.StationNodeFaults` (432: bit0 arm, bit1 sort sensor) | Info | No |
| Bridge link lost (as seen by the PLC) | `LineState` bit4 = 0 | Warning | No |
| PLC heartbeat stopped / SCADA can't reach the PLC | `Sys.PlcHeartbeat` unchanged 3 s, or device connection error | High | No (FUXA shows the device connection state) |
| PLC in simulated-input mode | `LineState` bit10 | Info (should be 0 on a live line) | No |

ESP32 node heartbeats need no SCADA alarm: the PLC supervises them and raises fault code 7 or 8 when a node goes silent.

`LOCAL_MODE` (bit8) and `RUNNING` (bit0) are states, not alarms. Show them on the overview screen and log their changes.

**Event ring journal.** On each poll, read `Events.LastSeq`. If it differs from the last value seen, walk `Event1..8` (newest first) and store every entry whose `Seq` is newer than the last one stored, then remember the new `LastSeq`. If `LastSeq` has advanced by more than 8 since the previous poll, events were overwritten; record a "N events missed" entry. Map severity from the event code table in [io-map.md §4](io-map.md#event-codes): `error` → alarm journal, `warn` → warning, `info` / `success` → event log. Try a FUXA server script first; use a Node-RED flow if that's awkward.

### 6.3 Polling rate

The bridge already reads 4 blocks every 250 ms (about 16 requests/s) on its connection. SCADA doesn't need to be that fast:

- **Everything at 1 s** (the generated device's polling, `FUXA_POLL_MS`). That's enough for trends and alarms. The generated tags make FUXA read about 8 blocks per poll, so roughly 8 requests/s.
- **Event ring (200–232):** 1 s is fine; with 8 entries, events are lost only if more than 8 happen between polls.
- **Slower if needed.** If measurements (§7) show load on the PLC, set `FUXA_POLL_MS=2000` and regenerate, or delete tags a screen doesn't use (for example the container block 100–139).
- **No writes by default.** A read-only SCADA can't disturb the command handshakes. With `FUXA_COMMANDS=1`, FUXA writes a command coil only when someone presses a button.

Measure before trusting this. Compare the bridge's poll latency and the Micro850's scan time (shown in CCW while online) with and without SCADA connected (§7).

### 6.4 Network placement

- Put SCADA on the **dedicated control network** ([communication.md §1](communication.md#1-network)). The simplest option is on the monitoring laptop itself (it only needs outbound connections to `192.168.10.10:502`); otherwise use a wired Pi at `192.168.10.60`.
- **No internet exposure.** Don't port-forward 502 or 1881, and don't connect the control switch or the ESP32 access point to the campus network.
- If people outside the control network need SCADA screens, turn on FUXA login (§5.4), then publish 1881 on the laptop's operator-side interface only. That's the same rule as the web HMI's port 43123. Don't enable IP forwarding between the two interfaces.

### 6.5 Security

Modbus TCP has **no authentication and no encryption**. Any device that can reach port 502 can read everything the Micro850 maps and pulse any command coil, including `Cmd.Start` and the digital E-Stop. Mitigations, in order of value:

1. **Isolation.** A dedicated control network (§6.4).
2. **Map only the register map.** Only variables in the CCW Modbus mapping are reachable over Modbus; everything else in the program isn't ([micro850-plc.md §2](micro850-plc.md#2-modbus-address-mapping)).
3. **Controller password.** Set a password on the Micro850 in CCW so nobody can download, upload or change the program without it. We found no Modbus client allow list on the Micro850 (**unverified**), so isolation does that job.
4. **SCADA read-only by default.** The generated project has no coil tags and no buttons unless it is regenerated with `FUXA_COMMANDS=1`. That option adds buttons for the same `Cmd.*` coils the web HMI uses (Start, Stop, Reset, Jog, digital E-Stop and release, fire reject), and the PLC still decides: it refuses them in LOCAL mode or when unsafe, like any remote command. Turn it on only with FUXA login enabled and the default `admin` / `123456` password changed (§5.4), and never make FUXA the only way to stop the line.
5. **Wi-Fi.** WPA2/WPA3 on the ESP32 access point with its own passphrase, and no internet uplink.

None of these makes Modbus safe on an open network. Safety still comes only from the hardwired E-Stop chain.

## 7. Open questions and checklist

### Open questions for the team

- **Command buttons?** Does SCADA need command buttons for the demo (`FUXA_COMMANDS=1`), or is it purely monitoring? (Recommendation: read-only, the default.)
- **Host.** Will FUXA run on the same laptop as the bridge, or on a separate Pi?
- **Retention.** How long must history be kept: one demo day, a week, or the whole semester? This sets the DAQ database (SQLite vs InfluxDB) and disk use.
- **Micro850 behaviour** to confirm on hardware: does it drop idle or half-open Modbus connections, and after how long? Does a read that touches an unmapped address return an exception or zeros?

### Checklist

- [x] Install FUXA 1.3.4 natively with `npm run fuxa` (tested on Windows with Node 24).
- [x] Start the virtual PLC (`npm run virtual-plc`) and load the generated project (§5.2–§5.3).
- [x] Check the addressing: `Sys.ProtocolVersion` reads 4, `Sys.PlcHeartbeat` is changing, and `Tank1.LevelMl` shows scaled millilitres.
- [x] Alarm drill against the virtual PLC: the digital E-Stop raised the E-Stop alarm and it cleared after release.
- [x] With command buttons (`FUXA_COMMANDS=1`): STOP and START changed `Sys.LineState` in Remote mode.
- [ ] Install on the demo laptop (and on the Pi, if used); record the Node version.
- [ ] Build one trend screen (tank levels, throughput, OEE) from the DAQ history and let it log for an hour; check the history survives a FUXA restart.
- [ ] Add any §6.2 alarms marked "No" that the team wants, and run an E-Stop drill from the web HMI (simulated line-exit E-Stop). FUXA should show it within 1 s.
- [ ] Force each station fault on the bench (unplug the barcode scanner, take the lids out of the magazine) and check FUXA shows the matching fault-code alarm.
- [ ] Journal the event ring with sequence de-duplication (FUXA script, or a Node-RED flow). Record which approach worked.
- [ ] Measure poll load with Wireshark (filter `tcp.port == 5020 && modbus`): requests per second from FUXA's connection, and bridge poll latency with and without FUXA.
- [ ] With the default read-only project, confirm FUXA never writes (Wireshark filter `modbus.func_code == 5 || modbus.func_code == 6 || modbus.func_code == 15 || modbus.func_code == 16`).
- [ ] Turn on login and change the `admin` password (§5.4); commit any editor-only changes as in §5.5.
- [ ] On the real Micro850: connect the bridge, FUXA, both ESP32 nodes and a Modbus tool at the same time and confirm all stay connected.
- [ ] On the real Micro850: set the controller password and confirm the bridge and FUXA still connect.
- [ ] Write the results, the version and screenshots back into this page.

## 8. Sources

**FUXA**
- Documentation: <https://frangoteam.github.io/FUXA/> (features and "no runtime licenses"; installing and running; devices and tags; settings and authentication; save/load project)
- Repository, README and MIT licence: <https://github.com/frangoteam/FUXA>; releases (v1.3.4, 12 August 2026): <https://github.com/frangoteam/FUXA/releases>
- npm package `@frangoteam/fuxa`: <https://www.npmjs.com/package/@frangoteam/fuxa>
- Modbus driver (1-based tag addresses, contiguous-range merging, 100-register read windows): <https://github.com/frangoteam/FUXA/blob/master/server/runtime/devices/modbus/index.js>
- FUXA Pro (optional, one-time): <https://frangoteam.org/>
- Modbus TCP issue #959: <https://github.com/frangoteam/FUXA/issues/959>

**Rockwell Automation (Micro850, CCW)**
- *Micro830, Micro850 and Micro870 Programmable Controllers User Manual* (2080-UM002): 16 Modbus TCP client and 16 server connections; Modbus mapping: <https://literature.rockwellautomation.com/idc/groups/literature/documents/um/2080-um002_-en-e.pdf>
- Modbus Mapping help (address ranges 000001–065536 / 400001–465536, 200-variable limit): <https://www.rockwellautomation.com/en-us/docs/factorytalk-design-workbench/1-01-00/ftdw-help-ditamap/micro800-controller/micro800-controller-configuration/controller-modbus-mapping.html>
- QA14133, *Configure the Ethernet port for Modbus TCP in the Micro850*: <https://support.rockwellautomation.com/app/answers/answer_view/a_id/530973>
- QA23703, *Transferring data between two Micro820/850 using Modbus TCP* (arrays count as one mapping entry): <https://support.rockwellautomation.com/app/answers/answer_view/a_id/574730>
- QA20567, *Downloading Connected Components Workbench Standard Edition* (free): <https://support.rockwellautomation.com/app/answers/answer_view/a_id/628485>
- CCW editions (Standard free; Developer an annual subscription): <https://www.rockwellautomation.com/en-us/capabilities/industrial-automation-control/design-and-configuration-software.html>
- Micro850 product page (2080-LC50 discontinued; L50E and CCW 20.01+): <https://www.rockwellautomation.com/en-us/products/hardware/programmable-controllers/micro850-controllers.html>

**Inductive Automation (Ignition), for the licensing reasons in §3**
- Maker Edition: <https://inductiveautomation.com/ignition/maker-edition>
- Master Software License Agreement: <https://inductiveautomation.com/ignition/license>
- Leased licensing: <https://www.docs.inductiveautomation.com/docs/8.1/platform/licensing-and-activation/leased-licensing>
- Educational Engagement Program: <https://inductiveautomation.com/educational-engagement>

**Other open-source options**
- node-red-contrib-modbus: <https://flows.nodered.org/node/node-red-contrib-modbus>, <https://github.com/BiancoRoyal/node-red-contrib-modbus>
- InfluxDB 3 Core: <https://www.influxdata.com/products/influxdb/>
- Rapid SCADA 6: <https://github.com/RapidScada/scada-v6>, <https://rapidscada.net/docs/en/6.4/software-overview/introduction>
- AdvancedHMI: <https://www.advancedhmi.com/>, <https://sourceforge.net/projects/advancedhmi/>

**Other**
- C-more Micro EA3-S3ML spec sheet (Modbus TCP/IP and Modbus RTU master drivers): <https://cdn.automationdirect.com/static/specs/ea3s3ml.pdf>
