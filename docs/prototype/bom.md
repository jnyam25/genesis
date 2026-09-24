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
| Stations, in belt order | Labeling → barcode scan → Tank 1/2/3 fill → capping arm → lid press → sort sensor → reject diverter → sort diverter (lane A / lane B) | Scan → dispense bays → mixer → QC → accept/reject gate |
| Dosing | Gravity tanks with proportional (servo-driven) valves: open/close + angle | Dosing pumps |
| Bad scans | Ride through unfilled to the reject diverter (no scan diverter) | Scan diverter to a scan-reject lane |
| E-Stops | Panel, line entry, line exit | Panel, scan station, gate |
| Station control | Two ESP32 nodes run label, scan, arm, press, sort sensor; on Wi-Fi through an access point wired to the PLC's network | ESP32 nodes only read the scanner and tank levels |
| Local operator panel | Budget touch panel (or C-more Micro) on Modbus, or hardwired START/JOG buttons plus the web HMI | Hardwired push-button station |
| Monitoring | PC/laptop on wired Ethernet (bridge + web HMI + FUXA SCADA) | Raspberry Pi |

The software now follows the left column (protocol v3 of the register map). The default configuration in [`twin/src/config.ts`](../../twin/src/config.ts) is this line.

## 2. BOM with software mapping

As submitted by the team, plus a **Software mapping** column. Rows marked **(added)** are required by the software or the safety design and weren't in the original BOM; see §3 for why.

| Station / subsystem | Component | Qty | Unit | Total | Status | Software mapping | Owner |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Supervisor (PLC) | **Allen-Bradley Micro850 2080-L50E-48QBB**, team-owned: 28 DC inputs, 20 sourcing DC outputs, 5 plug-in slots. Ethernet: Modbus TCP server, 16 connections | 1 | $0.00 | $0.00 | Owned | Implements the register map ([io-map.md §4](io-map.md#4-register-map-modbus-tcp)) and the program in [micro850-plc.md](micro850-plc.md). Embedded IO covers all digital field IO ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)) | Ashley |
| Supervisor (PLC) | Analog output plug-in **2080-OF2** (2 channels, 0–10 V / 0–20 mA each): 2 of them for 3 valve angles (+ belt speed) | 2 | ~$140.00 | ~$280.00 | Distributor, Sep 2026 ($120–160 each). Check the lab first | `AO_Valve_T<k>_Angle` ← `Tank<k>.ValveOpeningPct`; `AO_Belt_SpeedRef` (or a PWM output) | Ashley |
| HMI | ALT: C-more Micro 3 in touch panel (EA3-S3ML) | 1 | $342.00 | $342.00 | Catalog, Sep 2026 (BOM had the 2018 price, $198) | Local operator panel: START/STOP, recipe select, status. Talks generic Modbus TCP/RTU to the Micro850's panel area; not part of the register map. Free programming software | Ashley |
| HMI | AMSAMOTION 4.3 in touch panel (budget) | 1 | $60.00 | $60.00 | Confirmed | Same role. **Pick one HMI**, not both, or neither (hardwired START/JOG + web HMI). Check its configuration software is free | Ashley |
| Local controller (MCU) | ESP32 DevKit board | 2 | $8.00 | $16.00 | Estimate | ESP32 #1 scanner node (label + scan), ESP32 #2 station node (arm, press, sort sensor) ([esp32.md](esp32.md)) | Ashley |
| Labeling & scan | Label applicator (built: servo/stepper + printed parts) | 1 | $0.00 | $0.00 | Estimate | Station `LABEL`, `Station.LabelRequest/Done` | Ashley |
| Labeling & scan | Barcode scanner module (Waveshare 1D/2D) | 1 | $35.00 | $35.00 | Estimate | Station `SCAN`, recipe mailbox `Recipe.*`, barcode format in [`barcode.ts`](../../twin/src/barcode.ts) | Ashley |
| Tanks 1/2/3 | Proportional (servo-driven) ball or butterfly valve | 3 | $35.00 | $105.00 | Estimate | `BAY-k`, `TankConfig.valveOpeningPct`, `dispenseRateMlPerSec` calibrated at that opening | Ashley |
| Tanks 1/2/3 | Tank body + fittings (built) | 3 | $15.00 | $45.00 | Estimate | `TankConfig.capacityMl` | Ashley |
| Sensors | Inductive/photoelectric proximity sensor (bottle position) | 4 | $15.00 | $60.00 | Estimate | `I_<Station>_Present`. **The software needs 10 for 3 tanks** (§3) | Ashley |
| Capping arm | ESP32-based robotic arm kit (Hiwonder xArm / LewanSoul MaxArm) | 1 | $130.00 | $130.00 | Estimate | Station `CAP`, `Station.CapRequest/Done` | Ashley |
| Lid press | Small linear actuator or pneumatic cylinder + solenoid | 1 | $45.00 | $45.00 | Estimate | Station `PRESS`, `Station.PressRequest/Done` | Ashley |
| Reject & sort | Solenoid-actuated gate (reject diverter + sort diverter) | 2 | $25.00 | $50.00 | Estimate | `GATE` → `O_RejectDiverter_Extend`; `SORT` → `O_SortDiverter_LaneB`, `config.sort` | Ashley |
| Safety | E-Stop push-button, illuminated, NC contact | 2 | $18.00 | $36.00 | Estimate | `ENTRY`, `EXIT` in `config.safety.eStopButtons` | Ashley |
| Safety | **(added)** Third E-Stop for the local control panel | 1 | $18.00 | $18.00 | Estimate | `PANEL` | |
| Safety | Safety relay (hardwired E-Stop circuit) | 1 | $35.00 | $35.00 | Estimate | `I_Safety_OK`, [safety.md](safety.md) | Ashley |
| Conveyor | DC gear motor + driver (or a reused wiper motor, $0) | 1 | $20.00 | $20.00 | Estimate | `O_Belt_Run`, `AO_Belt_SpeedRef`, `beltSpeedMPerSec` | Ashley |
| Conveyor | Conveyor belt + frame materials | 1 | $60.00 | $60.00 | Estimate | `stationSpacingM`, station positions | Ashley |
| Misc | Wiring, connectors, relays, power supply, enclosure hardware | 1 | $75.00 | $75.00 | Estimate | — | Ashley |
| Conveyor design | Schematics, 2D/3D model, BOM (design only) | 1 | $0.00 | $0.00 | Confirmed | `config.ts` stations and spacing; the twin, virtual PLC and HMI views ([commissioning.md §1–§2](commissioning.md)) | Ashley |

**Totals.** The original BOM summed to **$1,300.00** with *both* HMI options and a CLICK PLUS PLC ($330 for CPU and modules). Using the team's 2080-L50E-48QBB removes the CPU and the CLICK modules, and its embedded IO covers the digital field IO; what's left to buy for the PLC is the analog output (about $280). With the budget panel and the third E-Stop, the line is about **$1,070** before the §3 items. The C-more Micro adds $282. Re-check prices before ordering.

### 2a. Software (no subscriptions)

| Software | Licence | Used for |
| --- | --- | --- |
| Connected Components Workbench **Standard Edition** | Free download (Rockwell account, no activation). The Developer Edition is an annual subscription and isn't needed | Programming the Micro850 ([micro850-plc.md §1](micro850-plc.md#software-no-subscription-needed)) |
| Twin, bridge and web HMI (this repo) | The team's own code on Node.js and Next.js (open source) | Simulation, virtual PLC, operator HMI |
| [FUXA](https://github.com/frangoteam/FUXA) (chosen SCADA) | MIT, no runtime licence. Run in Docker (Docker Desktop is free for education; Docker Engine is open source) or as a portable binary | SCADA: history, alarms, trends ([scada.md](scada.md)) |
| Arduino core / ESP-IDF and a Modbus TCP library | Open source | ESP32 firmware ([esp32.md](esp32.md)) |
| C-more Micro programming software (only if that panel is chosen) | Free download | Touch-panel screens |

Ignition, FactoryTalk View and CCW Developer Edition were ruled out because they need a paid, leased or subscription licence ([scada.md §3](scada.md#3-options-compared)). ProtoTwin (a subscription 3D simulator) was dropped too: the twin, the virtual PLC and the HMI's views cover simulation and virtual commissioning.

## 3. Gaps between the BOM and the software

### What the software (or the safety design) needs that the BOM doesn't budget

| # | Needed | Why | Proposed resolution | Rough cost |
| --- | --- | --- | --- | ---: |
| G1 | **RESET push-button** (blue, illuminated) | The safety relay needs a hardwired manual reset input; a touch panel can't provide it ([safety.md §1](safety.md#1-emergency-stop-physical-and-digital-working-together)) | Add | ~$10 |
| G2 | **Hardwired STOP** (NC) and **LOCAL/REMOTE key switch** | STOP must work with a broken wire or a dead touch panel; the key decides whether the panel or the web HMI is in control ([safety.md §3](safety.md#3-control-authority-local-vs-remote)) | Add both. If the team drops the key, fix the mode in the PLC and set `safety.initialMode` to match | ~$25 |
| G3 | **Presence sensors at every station** | The engine and PLC program wait for a container at LABEL, SCAN, BAY-1..3, CAP, PRESS, QC, GATE, SORT: 10 for 3 tanks, versus 4 in the BOM | Use low-cost diffuse IR sensors for most stations; keep the industrial ones where liquid splashes (bays). 24 V sensors go to the PLC; don't put 24 V on ESP32 pins | ~$30–60 |
| G4 | **A way to hold a bottle at a station** | The software pipelines up to `maxConcurrentContainers` (4) bottles, which needs a stopper at each holding station (9 for 3 tanks). The BOM has none | **Decision needed.** (a) Budget: run **one bottle at a time**: set `maxConcurrentContainers: 1` and the PLC stops the belt at each station instead of using stoppers. (b) Add small solenoid/servo stoppers and keep pipelining | (a) $0 · (b) ~$50–90 |
| G5 | **Shutoff solenoid per tank** | A servo-driven valve holds its last position when power is cut, so it can keep pouring during an E-Stop ([safety.md §4](safety.md#4-hardware-design-rules)) | NC solenoid in series with each valve, powered through the safety relay (`O_Valve_T<k>_Open`) | ~$25 (3 × ~$8) |
| G6 | **Interposing force-guided relay** for the HMI's digital E-Stop | Lets the web HMI's E-STOP open the hardware safety circuit | Add, **or** accept that the digital E-Stop is only a PLC-level stop for the prototype and document it in the risk assessment | ~$30 |
| G7 | **Sort sensor** | Listed in the controller table but has no purchase line | IR/ultrasonic height sensor or colour sensor on ESP32 #2 | ~$5–15 |
| G8 | **Tank level** | The HMI shows tank levels and the line reacts to low tanks; the BOM has no level sensor or refill valve | PLC estimates level from dispensed volume; a low float per tank (`I_Tank<k>_Low`) confirms it; refill is manual with a "tank refilled" button on the touch panel. The simulator still auto-refills | ~$10 (3 floats) |
| G9 | **Wi-Fi access point + small Ethernet switch** | The Micro850 has one Ethernet port and no Wi-Fi. The monitoring PC, the ESP32 access point (and an Ethernet touch panel) all have to reach that port; keep them off the campus network ([communication.md §1](communication.md#1-network)) | A small unmanaged switch, and a spare router set up as a plain access point wired to the switch | ~$0–40 |
| G10 | **24 V DIN power supply** and a separate 5–6 V supply for servos | PLC, sensors and solenoids run on 24 V; the arm and label servos need their own switched supply | Check that the $75 misc line covers them | incl. in Misc? |
| G11 | **I/O count** | Required IO for 3 tanks is ~18 DI / 7 DO / 3 AO, more with stoppers and indicators ([io-map.md §3](io-map.md#3-io-count-and-sizing)) | The 2080-L50E-48QBB's 28 DI / 20 DO cover the digital IO (with every optional indicator, one output short: drop the buzzer). Analog outputs come from two 2080-OF2 plug-ins ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)) | in §2 |

### What the BOM has that the software didn't model (now handled)

| BOM item | What changed in the software |
| --- | --- |
| Labeling station | New `LABEL` station before `SCAN`; `Station.LabelRequest/Done` handshake |
| Robotic capping arm, lid press | New `CAP` and `PRESS` stations; `Station.CapRequest/Done`, `Station.PressRequest/Done`; ESP32 station node spec |
| Sort sensor + 2-path sort diverter | `QC` is the sort sensor; new `SORT` station and `config.sort` (two lanes, bottle type from the recipe total); `Counts.LaneA/B`; `BOTTLE_TYPE_MISMATCH` reject reason; lane shown per container in the HMI |
| Reject diverter (slide) | `GATE` is the reject diverter. Bad scans ride through to it because there is no scan diverter |
| Proportional valves (open/close + angle) | Pumps replaced by valves; `valveOpeningPct` per tank and `Tank<k>.ValveOpeningPct` register |
| E-Stops at entry and exit | `ENTRY` and `EXIT` buttons (plus `PANEL`) |
| Allen-Bradley Micro850 2080-L50E-48QBB (team-owned) | PLC guide [micro850-plc.md](micro850-plc.md): free CCW Standard (20.01 or later), Modbus mapping of the register map, IO sizing. `PLC_COIL_BASE` stays 0 |
| ESP32 nodes controlling actuators, wireless link | Station handshake with `Station.RunPermit`; safety rules in [safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes) |
| PC/laptop monitoring over Ethernet | The bridge, web HMI and FUXA run on the laptop (or a Pi); FUXA setup in [scada.md §5](scada.md#5-setting-up-fuxa) |
| Touch-panel HMI with recipe select | Acts as the local control station. **Recipe select is not implemented yet**: today the recipe comes from the barcode (open decision D3) |

## 4. Budget

The department budget mentioned so far is about **$500**. The reconciled line is well above that:

| Scenario | Estimate |
| --- | ---: |
| BOM with the team's 2080-L50E-48QBB, two 2080-OF2, one budget HMI, third E-Stop | ~$1,070 |
| + required gaps G1, G2, G3, G5, G7, G8 (one-bottle mode, no stoppers, digital E-Stop as PLC-level stop) | ~$1,180–1,220 |
| + stoppers (G4b), interposing relay (G6), AP/switch (G9) | ~$1,260–1,380 |
| With the C-more Micro instead of the budget panel | add ~$282 |
| With no touch panel (hardwired START/JOG + web HMI) | subtract ~$50 |

Levers to discuss, largest first:

1. **Analog output plug-ins (~$280).** Look for 2080-OF2 / 2085-OF4 analog modules in the lab before buying; they often come with a Micro850 trainer. Driving belt speed from one of the 48QBB's PWM outputs saves an analog channel.
2. **Capping arm ($130).** Replace it with a gravity lid chute plus the lid press, or borrow an arm from the lab. The software keeps working: drop `CAP` from `config.stations`, or keep it as a timed station.
3. **HMI ($0–342).** Use the budget panel, or rely on the web HMI on the laptop plus hardwired START/JOG/STOP/RESET for local control.
4. **Proportional valves ($105) and their analog outputs.** Use one proportional valve for fine fills and plain solenoid valves on the other tanks (`valveOpeningPct: 100` means on/off; calibrate the flow). With only one proportional valve, one 2080-OF2 is enough (saves ~$140).
5. **Conveyor motor ($20).** Reuse a wiper motor ($0), as discussed in class.
6. **One-bottle mode (G4a)** instead of stoppers saves ~$50–90.

## 5. Requirements traceability

| Physical requirement | Config | PLC / register map | Tests |
| --- | --- | --- | --- |
| E-Stop at the **line entry** and the **line exit** (plus the panel), hardwired through a safety relay | `safety.eStopButtons` = `PANEL`, `ENTRY`, `EXIT` | `I_EStop_Panel/Entry/Exit_Mon`; `Sys.PhysicalEStopMask` bits 0–2; events 25/26 name the location | `core.test.ts`: "physical E-Stop at the line entry and at the line exit…", "default line matches the BOM…" |
| Digital E-Stop from the HMI opens the same circuit | — | `Cmd.DigitalEStop`, `O_Safety_RemoteEStopOK` (needs G6) | `core.test.ts`, `plc.test.ts` digital E-Stop tests |
| Station order matches the BOM | `stations` | Container status codes 3, 1, 11–18, 24, 25, 21, 26, 22/27 | "default line matches the BOM…", "containers visit label, scan, …" |
| Tank valves: open/close + angle | `TankConfig.valveOpeningPct`, `dispenseRateMlPerSec` | `O_Valve_T<k>_Open`, `AO_Valve_T<k>_Angle`, `Tank<k>.ValveOpeningPct` | `plc.test.ts`: "bridge decodes the virtual PLC…" (valve register) |
| Labeling, capping, pressing on the microcontroller | `stationTimesSec` | `Station.RunPermit`, `Station.<Label/Cap/Press>Request/Done`, `Station.ScannerNodeFaults`, `Station.StationNodeFaults` | `plc.test.ts`: "virtual PLC publishes the microcontroller station handshake…" |
| Barcode read → recipe | `SAMPLE_BARCODES`, barcode format | `Recipe.*` mailbox | `plc.test.ts`: "recipe mailbox…" |
| Bad scan is rejected (no scan diverter) | — | `Recipe.ParseResult` ≠ 0 → reject at `GATE` | `core.test.ts`: "no scan diverter: a bad barcode rides through…" |
| Sort sensor re-confirms bottle type | `sort.smallBottleMaxMl` | `Station.SortSensorType/Container`, reject reason `BOTTLE_TYPE_MISMATCH` | Not simulated (the twin assumes the sensor agrees) |
| Reject diverter | — | `O_RejectDiverter_Extend`, `Cmd.FirePusher` | E-Stop and local-control tests exercise `firePusher` |
| 2-path sort | `sort.lanes` | `O_SortDiverter_LaneB`, `Counts.LaneA/B`, status 22/27 | `core.test.ts`: "sort diverter: small bottles go to lane A…"; `plc.test.ts` lane checks |
| Conveyor run/stop + speed | `beltSpeedMPerSec` | `O_Belt_Run`, `AO_Belt_SpeedRef` | Flow tests |
| PLC ↔ ESP32 wireless link supervised | — | `Field.ScannerNodeHeartbeat`, `Field.StationNodeHeartbeat`, `Station.RunPermit` | Spec only ([esp32.md](esp32.md)) |
| PLC ↔ PC monitoring/logging | `PLC_HOST` etc. | Whole register map, read-only for SCADA | Bridge tests in `plc.test.ts`; SCADA in [scada.md](scada.md) |

## 6. Open decisions for the team

- **D1: Stoppers or one bottle at a time?** (G4.) One-bottle mode is cheaper and simpler to wire; stoppers keep throughput and match the simulator's default.
- **D2: Digital E-Stop hardware path?** (G6.) Buy the interposing relay, or document the web HMI's E-STOP as a PLC-level stop for the prototype.
- **D3: Where does the recipe come from?** Today the recipe is encoded in the barcode (`PT1|T250|100,80,70`) and the scanner node hands it to the PLC. The BOM's touch panel has "recipe select", and a label applicator can't print. Proposal: labels are pre-printed per recipe; the operator selects the recipe on the touch panel; the scanner node rejects a bottle whose label doesn't match the selected recipe. This needs a "selected recipe" register, which isn't in the map yet.
- **D4: Level sensing and refill.** Estimate + low float + manual refill (G8), or real level sensors.
- **D5: Which HMI?** Budget panel, C-more Micro, or no touch panel (hardwired START/JOG + web HMI). A panel must be a Modbus TCP or RTU master to talk to the Micro850, and its configuration software must be free.
- **D6: Budget.** Which levers in §4 the team accepts.

### Decided

- **D7: PLC model.** The team's controller is the **2080-L50E-48QBB**: its embedded IO covers the digital field IO, so no digital expansion is budgeted; it needs CCW Standard 20.01 or later ([micro850-plc.md §1](micro850-plc.md#the-controller-2080-l50e-48qbb)). Still list any plug-in or expansion modules already fitted or in the lab.
- **D8: ProtoTwin.** Dropped (subscription product). The Node twin and the virtual PLC (development stages 1–2) need no licence.
- **D9: SCADA.** [FUXA](https://github.com/frangoteam/FUXA), read-only over Modbus TCP ([scada.md](scada.md)).
