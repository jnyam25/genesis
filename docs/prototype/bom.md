# Bill of materials and physical requirements

This page reconciles the team's bill of materials (BOM) with the software: the twin engine, the PLC register map, the web HMI and the SCADA. It answers three questions:

1. What are we buying, and what does each part map to in the software? (§1, §2)
2. What does the software assume that the BOM doesn't budget, and the other way round? (§3)
3. Where is each physical requirement implemented and tested? (§5)

Prices are the team's estimates unless marked *Confirmed*. Verify every price and part number before ordering. The **Owner** column is for the team to fill in.

Two constraints from the team shape this page: the PLC is the **Allen-Bradley Micro850 2080-L50E-48QBB the team already owns**, and every piece of software must be usable **without a subscription** (§2a).

## 1. Line summary

| | BOM line (this build) | Before reconciliation (software) |
| --- | --- | --- |
| Supervisor | Allen-Bradley Micro850 2080-L50E-48QBB (team-owned), Modbus TCP server on its Ethernet port | Allen-Bradley PLC |
| Stations, in belt order | Labeling → barcode scan → Tank 1/2/3 fill → capping arm (lifts a lid from the magazine, places it and presses it down; no separate lid press) → sort sensor → reject diverter → sort diverter (lane A / lane B) | Scan → dispense bays → mixer → QC → accept/reject gate |
| Dosing | Gravity tanks with proportional (servo-driven) valves: open/close + angle | Dosing pumps |
| Bad scans | Ride through unfilled to the reject diverter (no scan diverter) | Scan diverter to a scan-reject lane |
| E-Stops | Panel, line entry, line exit | Panel, scan station, gate |
| Station control | Two ESP32 nodes run the label applicator, barcode scanner, robotic arm and sort sensor on the PLC's requests and report back; the PLC makes every decision (barcode validation, bottle type, arm sequence, faults). On Wi-Fi through an access point wired to the PLC's network | ESP32 nodes only read the scanner and tank levels |
| Local operator panel | Budget touch panel (or C-more Micro) on Modbus, or hardwired START/JOG buttons plus the web HMI | Hardwired push-button station |
| Monitoring | PC/laptop on wired Ethernet (bridge + web HMI + FUXA SCADA) | Raspberry Pi |

The software now follows the left column (protocol v4 of the register map). The default configuration in [`twin/src/config.ts`](../../twin/src/config.ts) is this line.

## 2. BOM with software mapping

As submitted by the team, plus a **Software mapping** column. Rows marked **(added)** are required by the software or the safety design and weren't in the original BOM; see §3 for why.

| Station / subsystem | Component | Qty | Unit | Total | Status | Software mapping | Owner |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Supervisor (PLC) | **Allen-Bradley Micro850 2080-L50E-48QBB**, team-owned: 28 DC inputs, 20 sourcing DC outputs, 5 plug-in slots. Ethernet: Modbus TCP server, 16 connections | 1 | $0.00 | $0.00 | Owned | Implements the register map ([io-map.md §4](io-map.md#4-register-map-modbus-tcp)) and the program in [micro850-plc.md](micro850-plc.md). Embedded IO covers all digital field IO ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)) | Ashley |
| Supervisor (PLC) | Analog output plug-in **2080-OF2** (2 channels, 0–10 V / 0–20 mA each): 2 of them for 3 valve angles (+ belt speed) | 2 | ~$140.00 | ~$280.00 | Distributor, Sep 2026 ($120–160 each). Check the lab first | `AO_Valve_T<k>_Angle` ← `Tank<k>.ValveOpeningPct`; `AO_Belt_SpeedRef` (or a PWM output) | Ashley |
| HMI | ALT: C-more Micro 3 in touch panel (EA3-S3ML) | 1 | $342.00 | $342.00 | Catalog, Sep 2026 (BOM had the 2018 price, $198) | Local operator panel: START/STOP, recipe select, status. Talks generic Modbus TCP/RTU to the Micro850's panel area; not part of the register map. Free programming software | Ashley |
| HMI | AMSAMOTION 4.3 in touch panel (budget) | 1 | $60.00 | $60.00 | Confirmed | Same role. **Pick one HMI**, not both, or neither (hardwired START/JOG + web HMI). Check its configuration software is free | Ashley |
| Local controller (MCU) | ESP32 DevKit board | 2 | $8.00 | $16.00 | Estimate | ESP32 #1 scanner node (label + scan), ESP32 #2 station node (robotic arm + sort sensor; can run on the xArm's own ESP32 controller instead). Firmware in [`firmware/`](../../firmware) ([esp32.md](esp32.md)) | Ashley |
| Labeling & scan | Label applicator (built: servo/stepper + printed parts) | 1 | $0.00 | $0.00 | Estimate | Station `LABEL`, `Station.LabelRequest/Done` | Ashley |
| Labeling & scan | Barcode scanner module (Waveshare 1D/2D, GM65-class, UART) | 1 | $35.00 | $35.00 | Estimate | Station `SCAN`, scan mailbox `Scan.*`: the scanner node forwards the raw text and the PLC validates it (format in [`barcode.ts`](../../twin/src/barcode.ts)) | Ashley |
| Tanks 1/2/3 | Proportional (servo-driven) ball or butterfly valve | 3 | $35.00 | $105.00 | Estimate | `BAY-k`, `TankConfig.valveOpeningPct`, `dispenseRateMlPerSec` calibrated at that opening | Ashley |
| Tanks 1/2/3 | Tank body + fittings (built) | 3 | $15.00 | $45.00 | Estimate | `TankConfig.capacityMl` | Ashley |
| Sensors | Inductive/photoelectric proximity sensor (bottle position) | 4 | $15.00 | $60.00 | Estimate | `I_<Station>_Present`. **The software needs 9 for 3 tanks** (§3) | Ashley |
| Sensors | **(added)** VL53L1X time-of-flight distance sensor breakout (sort sensor, bottle height) | 1 | $10.00 | $10.00 | Estimate | Sort sensor at `QC` on ESP32 #2: `Station.SortRequest/Done`, `Station.SortHeightMm`. The PLC classifies the height against `config.sort` (lane A 120 mm, lane B 180 mm, ±15 mm) | |
| Capping arm | Robotic arm: **Hiwonder xArm ESP32**, 6-DOF, LX bus servos, with gripper. It lifts a lid from the lid magazine, places it on the container at CAP and presses it down to seat it | 1 | $130.00 | $130.00 | Estimate | Station `CAP`, arm commands `Station.ArmCmd` (`HOME`, `PICK_LID`, `PLACE_LID`) → `Station.ArmResult`, `Station.ArmStatus` | Ashley |
| Capping arm | **(added)** Lid magazine: gravity-fed stack of lids, 3D-printed or acrylic, fixed where the arm can reach | 1 | $5.00 | $5.00 | Estimate | `PICK_LID` lifts the top lid; an empty or misaligned magazine latches `ARM_NO_LID` (`Sys.FaultCode` 4) | |
| Reject & sort | Solenoid-actuated gate (reject diverter + sort diverter) | 2 | $25.00 | $50.00 | Estimate | `GATE` → `O_RejectDiverter_Extend`; `SORT` → `O_SortDiverter_LaneB`, `config.sort` | Ashley |
| Safety | E-Stop push-button, illuminated, NC contact | 2 | $18.00 | $36.00 | Estimate | `ENTRY`, `EXIT` in `config.safety.eStopButtons` | Ashley |
| Safety | **(added)** Third E-Stop for the local control panel | 1 | $18.00 | $18.00 | Estimate | `PANEL` | |
| Safety | Safety relay (hardwired E-Stop circuit) | 1 | $35.00 | $35.00 | Estimate | `I_Safety_OK`, [safety.md](safety.md) | Ashley |
| Conveyor | DC gear motor + driver (or a reused wiper motor, $0) | 1 | $20.00 | $20.00 | Estimate | `O_Belt_Run`, `AO_Belt_SpeedRef`, `beltSpeedMPerSec` | Ashley |
| Conveyor | Conveyor belt + frame materials | 1 | $60.00 | $60.00 | Estimate | `stationSpacingM`, station positions | Ashley |
| Misc | Wiring, connectors, relays, power supply, enclosure hardware | 1 | $75.00 | $75.00 | Estimate | — | Ashley |
| Conveyor design | Schematics, 2D/3D model, BOM (design only) | 1 | $0.00 | $0.00 | Confirmed | `config.ts` stations and spacing; the twin, virtual PLC and HMI views ([commissioning.md §1–§2](commissioning.md)) | Ashley |

**Totals.** The original BOM summed to **$1,300.00** with *both* HMI options and a CLICK PLUS PLC ($330 for CPU and modules). Using the team's 2080-L50E-48QBB removes the CPU and the CLICK modules, and its embedded IO covers the digital field IO; what's left to buy for the PLC is the analog output (about $280). The lid press (about $45) was removed: the robotic arm now presses the lid on itself. With the budget panel, the third E-Stop, the lid magazine and the VL53L1X sort sensor, the line is about **$1,040** before the §3 items. The C-more Micro adds $282. Re-check prices before ordering.

### 2a. Software (no subscriptions)

| Software | Licence | Used for |
| --- | --- | --- |
| Connected Components Workbench **Standard Edition** | Free download (Rockwell account, no activation). The Developer Edition is an annual subscription and isn't needed | Programming the Micro850 ([micro850-plc.md §1](micro850-plc.md#software-no-subscription-needed)) |
| Twin, bridge and web HMI (this repo) | The team's own code on Node.js and Next.js (open source) | Simulation, virtual PLC, operator HMI |
| [FUXA](https://github.com/frangoteam/FUXA) (chosen SCADA) | MIT, no runtime licence. Installed natively from npm by `npm run fuxa` (no Docker) | SCADA: history, alarms, trends ([scada.md](scada.md)) |
| PlatformIO, the Arduino core for ESP32, and open-source Modbus TCP and VL53L1X libraries | Open source | ESP32 firmware in [`firmware/`](../../firmware) ([esp32.md](esp32.md)) |
| C-more Micro programming software (only if that panel is chosen) | Free download | Touch-panel screens |

Ignition, FactoryTalk View and CCW Developer Edition were ruled out because they need a paid, leased or subscription licence ([scada.md §3](scada.md#3-options-compared)). ProtoTwin (a subscription 3D simulator) was dropped too: the twin, the virtual PLC and the HMI's views cover simulation and virtual commissioning.

## 3. Gaps between the BOM and the software

### What the software (or the safety design) needs that the BOM doesn't budget

| # | Needed | Why | Proposed resolution | Rough cost |
| --- | --- | --- | --- | ---: |
| G1 | **RESET push-button** (blue, illuminated) | The safety relay needs a hardwired manual reset input; a touch panel can't provide it ([safety.md §1](safety.md#1-emergency-stop-physical-and-digital-working-together)) | Add | ~$10 |
| G2 | **Hardwired STOP** (NC) and **LOCAL/REMOTE key switch** | STOP must work with a broken wire or a dead touch panel; the key decides whether the panel or the web HMI is in control ([safety.md §3](safety.md#3-control-authority-local-vs-remote)) | Add both. If the team drops the key, fix the mode in the PLC and set `safety.initialMode` to match | ~$25 |
| G3 | **Presence sensors at every station** | The engine and PLC program wait for a container at LABEL, SCAN, BAY-1..3, CAP, QC, GATE, SORT: 9 for 3 tanks, versus 4 in the BOM | Use low-cost diffuse IR sensors for most stations; keep the industrial ones where liquid splashes (bays). 24 V sensors go to the PLC; don't put 24 V on ESP32 pins | ~$30–60 |
| G4 | **A way to hold a bottle at a station** | The software pipelines up to `maxConcurrentContainers` (4) bottles, which needs a stopper at each holding station (8 for 3 tanks). The BOM has none | **Decision needed.** (a) Budget: run **one bottle at a time**: set `maxConcurrentContainers: 1` and the PLC stops the belt at each station instead of using stoppers. (b) Add small solenoid/servo stoppers and keep pipelining | (a) $0 · (b) ~$50–90 |
| G5 | **Shutoff solenoid per tank** | A servo-driven valve holds its last position when power is cut, so it can keep pouring during an E-Stop ([safety.md §4](safety.md#4-hardware-design-rules)) | NC solenoid in series with each valve, powered through the safety relay (`O_Valve_T<k>_Open`) | ~$25 (3 × ~$8) |
| G6 | **Interposing force-guided relay** for the HMI's digital E-Stop | Lets the web HMI's E-STOP open the hardware safety circuit | Add, **or** accept that the digital E-Stop is only a PLC-level stop for the prototype and document it in the risk assessment | ~$30 |
| G7 | **Sort sensor** | Listed in the controller table but had no purchase line | **Resolved:** a VL53L1X time-of-flight sensor on ESP32 #2 measures the bottle height, and the PLC classifies it (row in §2) | in §2 |
| G8 | **Tank level** | The HMI shows tank levels and the line reacts to low tanks; the BOM has no level sensor or refill valve | PLC estimates level from dispensed volume; a low float per tank (`I_Tank<k>_Low`) confirms it; refill is manual with a "tank refilled" button on the touch panel. The simulator still auto-refills | ~$10 (3 floats) |
| G9 | **Wi-Fi access point + small Ethernet switch** | The Micro850 has one Ethernet port and no Wi-Fi. The monitoring PC, the ESP32 access point (and an Ethernet touch panel) all have to reach that port; keep them off the campus network ([communication.md §1](communication.md#1-network)) | A small unmanaged switch, and a spare router set up as a plain access point wired to the switch | ~$0–40 |
| G10 | **24 V DIN power supply** and a separate 5–6 V supply for servos | PLC, sensors and solenoids run on 24 V; the arm and label servos need their own switched supply | Check that the $75 misc line covers them | incl. in Misc? |
| G11 | **I/O count** | Required IO for 3 tanks is ~17 DI / 7 DO / 3 AO, more with stoppers and indicators ([io-map.md §3](io-map.md#3-io-count-and-sizing)) | The 2080-L50E-48QBB's 28 DI / 20 DO cover the digital IO; with stoppers and every optional indicator it uses all 20 outputs, with no spare. Analog outputs come from two 2080-OF2 plug-ins ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)) | in §2 |

### What the BOM has that the software didn't model (now handled)

| BOM item | What changed in the software |
| --- | --- |
| Labeling station | New `LABEL` station before `SCAN`; `Station.LabelRequest/Done` handshake |
| Robotic capping arm (the lid press was removed) | `CAP` station. The PLC sequences the arm through `Station.ArmCmd` / `ArmCmdSeq` → `ArmResult` / `ArmDoneSeq`: `HOME`, `PICK_LID` (pre-picked while the belt moves), `PLACE_LID` (place, press down, release, return HOME). A failed pick is retried up to 3 times, then latches `ARM_NO_LID`. Station-node firmware in [`firmware/station-node`](../../firmware/station-node) |
| Sort sensor + 2-path sort diverter | `QC` is the sort sensor: the station node reports the raw bottle height (`Station.SortHeightMm`) and the PLC classifies it against `config.sort` (lane heights, ±15 mm). New `SORT` station and `config.sort` (two lanes, bottle type from the recipe total); `Counts.LaneA/B`; `BOTTLE_TYPE_MISMATCH` reject reason; lane shown per container in the HMI |
| Reject diverter (slide) | `GATE` is the reject diverter. Bad scans ride through to it because there is no scan diverter |
| Proportional valves (open/close + angle) | Pumps replaced by valves; `valveOpeningPct` per tank and `Tank<k>.ValveOpeningPct` register |
| E-Stops at entry and exit | `ENTRY` and `EXIT` buttons (plus `PANEL`) |
| Allen-Bradley Micro850 2080-L50E-48QBB (team-owned) | PLC guide [micro850-plc.md](micro850-plc.md): free CCW Standard (20.01 or later), Modbus mapping of the register map, IO sizing. `PLC_COIL_BASE` stays 0 |
| ESP32 nodes controlling actuators, wireless link | Station handshake with `Station.RunPermit`; the nodes execute and report, the PLC decides. Heartbeats and node fault bits latch station faults (`Sys.FaultCode`) that stop the line until RESET. Safety rules in [safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes) |
| PC/laptop monitoring over Ethernet | The bridge, web HMI and FUXA run on the laptop (or a Pi); FUXA installs and starts with `npm run fuxa` ([scada.md](scada.md)) |
| Touch-panel HMI with recipe select | Acts as the local control station. **Recipe select is not implemented yet**: today the recipe comes from the barcode (open decision D3) |

## 4. Budget

The department budget mentioned so far is about **$500**. The reconciled line is well above that:

| Scenario | Estimate |
| --- | ---: |
| BOM with the team's 2080-L50E-48QBB, two 2080-OF2, one budget HMI, third E-Stop, lid magazine, VL53L1X sort sensor (no lid press) | ~$1,040 |
| + required gaps G1, G2, G3, G5, G8 (one-bottle mode, no stoppers, digital E-Stop as PLC-level stop) | ~$1,140–1,170 |
| + stoppers (G4b), interposing relay (G6), AP/switch (G9) | ~$1,220–1,330 |
| With the C-more Micro instead of the budget panel | add ~$282 |
| With no touch panel (hardwired START/JOG + web HMI) | subtract ~$50 |

Levers to discuss, largest first:

1. **Analog output plug-ins (~$280).** Look for 2080-OF2 / 2085-OF4 analog modules in the lab before buying; they often come with a Micro850 trainer. Driving belt speed from one of the 48QBB's PWM outputs saves an analog channel.
2. **Capping arm ($130).** Borrow a Hiwonder xArm from the lab, or run the line without capping (lids fitted by hand after the line): drop `CAP` from `config.stations`, and the PLC no longer sequences the arm.
3. **HMI ($0–342).** Use the budget panel, or rely on the web HMI on the laptop plus hardwired START/JOG/STOP/RESET for local control.
4. **Proportional valves ($105) and their analog outputs.** Use one proportional valve for fine fills and plain solenoid valves on the other tanks (`valveOpeningPct: 100` means on/off; calibrate the flow). With only one proportional valve, one 2080-OF2 is enough (saves ~$140).
5. **Conveyor motor ($20).** Reuse a wiper motor ($0), as discussed in class.
6. **One-bottle mode (G4a)** instead of stoppers saves ~$50–90.

## 5. Requirements traceability

| Physical requirement | Config | PLC / register map | Tests |
| --- | --- | --- | --- |
| E-Stop at the **line entry** and the **line exit** (plus the panel), hardwired through a safety relay | `safety.eStopButtons` = `PANEL`, `ENTRY`, `EXIT` | `I_EStop_Panel/Entry/Exit_Mon`; `Sys.PhysicalEStopMask` bits 0–2; events 25/26 name the location | `core.test.ts`: "physical E-Stop at the line entry and at the line exit…", "default line matches the BOM…" |
| Digital E-Stop from the HMI opens the same circuit | — | `Cmd.DigitalEStop`, `O_Safety_RemoteEStopOK` (needs G6) | `core.test.ts`, `plc.test.ts` digital E-Stop tests |
| Station order matches the BOM (no lid press) | `stations` | Container status codes 3, 1, 11–18, 24, 21, 26, 22/27 (25, the former lid press, is reserved) | "default line matches the BOM…", "containers visit label, scan, …" |
| Tank valves: open/close + angle | `TankConfig.valveOpeningPct`, `dispenseRateMlPerSec` | `O_Valve_T<k>_Open`, `AO_Valve_T<k>_Angle`, `Tank<k>.ValveOpeningPct` | `plc.test.ts`: "bridge decodes the virtual PLC…" (valve register) |
| Labeling and capping (arm lifts, places and presses the lid) on the microcontroller | `stationTimesSec`, `stationNodeTimeoutSec` | `Station.RunPermit`, `Station.LabelRequest/Done`, `Station.ArmCmd/ArmCmdSeq/ArmDoneSeq/ArmResult/ArmStatus`, `Station.ScannerNodeFaults`, `Station.StationNodeFaults` | `plc.test.ts`: "PLC supervises the simulated nodes…", "arm: a failed lid pick is retried…" |
| Barcode read → recipe (the PLC validates) | `SAMPLE_BARCODES`, barcode format | `Scan.*` mailbox: raw text from the scanner node, `Scan.ParseResult` / `Scan.TotalMl` from the PLC | `plc.test.ts`: "scan mailbox over Modbus…", "scan text packing…" |
| Bad scan is rejected (no scan diverter) | — | `Scan.ParseResult` ≠ 0 → reject at `GATE` | `core.test.ts`: "no scan diverter: a bad barcode rides through…" |
| Sort sensor re-confirms bottle type (the PLC classifies) | `sort.lanes[].bottleHeightMm`, `sort.heightToleranceMm`, `sort.smallBottleMaxMl` | `Station.SortRequest/Done`, `Station.SortHeightMm`, reject reason `BOTTLE_TYPE_MISMATCH` | `plc.test.ts`: "sort sensor: the PLC classifies the raw height…" |
| Station faults stop the line until RESET | `stationNodeTimeoutSec` | `Sys.FaultCode`, `LineState` bit3 FAULT, events `FAULT` (22) / `FAULT_CLEARED` (33), refusal reason `FAULT_ACTIVE` | `core.test.ts`: "station faults stop the line…", "station driver timeout…"; `plc.test.ts`: "node supervision…" |
| Reject diverter | — | `O_RejectDiverter_Extend`, `Cmd.FirePusher` | E-Stop and local-control tests exercise `firePusher` |
| 2-path sort | `sort.lanes` | `O_SortDiverter_LaneB`, `Counts.LaneA/B`, status 22/27 | `core.test.ts`: "sort diverter: small bottles go to lane A…"; `plc.test.ts` lane checks |
| Conveyor run/stop + speed | `beltSpeedMPerSec` | `O_Belt_Run`, `AO_Belt_SpeedRef` | Flow tests |
| PLC ↔ ESP32 wireless link supervised | — | `Field.ScannerNodeHeartbeat`, `Field.StationNodeHeartbeat` (offline after 3 s → fault 7 / 8), `Station.RunPermit` | `plc.test.ts`: "node supervision…"; firmware in [`firmware/`](../../firmware) ([esp32.md](esp32.md)); `generated.test.ts` checks the firmware register header against `tag-map.ts` |
| PLC ↔ PC monitoring/logging | `PLC_HOST` etc. | Whole register map; SCADA is read-only by default (command coils only with `FUXA_COMMANDS=1`) | Bridge tests in `plc.test.ts`; FUXA project tests in `generated.test.ts`; SCADA in [scada.md](scada.md) |

## 6. Open decisions for the team

- **D1: Stoppers or one bottle at a time?** (G4.) One-bottle mode is cheaper and simpler to wire; stoppers keep throughput and match the simulator's default.
- **D2: Digital E-Stop hardware path?** (G6.) Buy the interposing relay, or document the web HMI's E-STOP as a PLC-level stop for the prototype.
- **D3: Where does the recipe come from?** Today the recipe is encoded in the barcode (`PT1|T250|100,80,70`); the scanner node forwards the raw text and the PLC decodes and validates it. The BOM's touch panel has "recipe select", and a label applicator can't print. Proposal: labels are pre-printed per recipe; the operator selects the recipe on the touch panel; the PLC rejects a bottle whose label doesn't match the selected recipe. This needs a "selected recipe" register, which isn't in the map yet.
- **D4: Level sensing and refill.** Estimate + low float + manual refill (G8), or real level sensors.
- **D5: Which HMI?** Budget panel, C-more Micro, or no touch panel (hardwired START/JOG + web HMI). A panel must be a Modbus TCP or RTU master to talk to the Micro850, and its configuration software must be free.
- **D6: Budget.** Which levers in §4 the team accepts.

### Decided

- **D7: PLC model.** The team's controller is the **2080-L50E-48QBB**: its embedded IO covers the digital field IO, so no digital expansion is budgeted; it needs CCW Standard 20.01 or later ([micro850-plc.md §1](micro850-plc.md#the-controller-2080-l50e-48qbb)). Still list any plug-in or expansion modules already fitted or in the lab.
- **D8: ProtoTwin.** Dropped (subscription product). The Node twin and the virtual PLC (development stages 1–2) need no licence.
- **D9: SCADA.** [FUXA](https://github.com/frangoteam/FUXA) over Modbus TCP, installed natively with `npm run fuxa`. It is read-only by default; built with `FUXA_COMMANDS=1` it can also pulse the command coils, and the PLC applies the same authority rules as for the web HMI ([scada.md](scada.md)).
- **D10: Lid press.** Removed. The robotic arm lifts each lid from a gravity-fed magazine, places it on the container at CAP and presses it down itself.
