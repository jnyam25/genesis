# Bill of materials and physical requirements

This page reconciles the team's bill of materials (BOM) with the software: the twin engine, the PLC register map, the web HMI and the SCADA. It answers three questions:

1. What are we buying, and what does each part map to in the software? (§1, §2)
2. What does the software assume that the BOM doesn't budget, and the other way round? (§3)
3. Where is each physical requirement implemented and tested? (§5)

Prices are the team's estimates unless marked *Confirmed*. Verify every price and part number before ordering. The **Owner** column is for the team to fill in.

Two constraints from the team shape this page: the PLC is the **Allen-Bradley Micro850 2080-L50E-24QBB the team already owns**, and every piece of software must be usable **without a subscription** (§2a).

## 1. Line summary

| | BOM line (this build) | Before reconciliation (software) |
| --- | --- | --- |
| Supervisor | Allen-Bradley Micro850 2080-L50E-24QBB (team-owned), Modbus TCP server on its Ethernet port | Allen-Bradley PLC |
| Stations, in belt order | Scan gate → Tank 1 → Tank 2 → capping arm (places the lid) → lid press → sort sensor → reject diverter → sort diverter (lane 1 / lane 2). No labeling station | Scan → dispense bays → mixer → QC → accept/reject gate |
| Dosing | Two gravity tanks (blue, then orange) with proportional valves: open/close + angle | Dosing pumps |
| Bad scans | Ejected at the scan gate before either valve opens | Scan diverter to a scan-reject lane |
| E-Stops | Line start (infeed), line end (outfeed) | Panel, scan station, gate |
| Station control | Two ESP32 nodes run the barcode scanner, robotic arm and sort sensor on the PLC's requests and report back; the PLC makes every decision (barcode validation, bottle type, arm sequence, faults). On Wi-Fi through an access point wired to the PLC's network. No labeler on this conveyor | ESP32 nodes only read the scanner and tank levels |
| Local operator panel | Budget touch panel (or C-more Micro) on Modbus, or hardwired START/JOG buttons plus the web HMI | Hardwired push-button station |
| Monitoring | PC/laptop on wired Ethernet (bridge + web HMI + FUXA SCADA) | Raspberry Pi |

The software now follows the left column (protocol v4 of the register map). The default configuration in [`twin/src/config.ts`](../../twin/src/config.ts) is this line: two tanks, scan eject, lid press, two E-Stops.

Additions on this build: the conveyor has a **DC motor speed controller**; **touch sensors** detect a bottle at the dry stations; and line status is an **ONN-M4W** wall-mounted stack light (red / yellow / green and a buzzer, DC 24 V). The QR is already printed on the can, so the label applicator is not on this conveyor.

## 2. BOM with software mapping

As submitted by the team, plus a **Software mapping** column. Rows marked **(added)** are required by the software or the safety design and weren't in the original BOM; see §3 for why.

| Station / subsystem | Component | Qty | Unit | Total | Status | Software mapping | Owner |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Supervisor (PLC) | **Allen-Bradley Micro850 2080-L50E-24QBB**, team-owned: 14 DC inputs, 10 sourcing DC outputs, 5 plug-in slots. Ethernet: Modbus TCP server, 16 connections | 1 | $0.00 | $0.00 | Owned | Implements the register map ([io-map.md §4](io-map.md#4-register-map-modbus-tcp)) and the program in [micro850-plc.md](micro850-plc.md). Embedded IO covers the required outputs and 14 inputs; stoppers, the rest of the tower and the extra inputs need a 2085-IQ16 and a 2085-OB16 ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)) | Ashley |
| Supervisor (PLC) | Analog output plug-in **2080-OF2** (2 channels, 0–10 V / 0–20 mA each): one module for the two valve angles. Belt speed can use a PWM output instead of a second module | 1 | ~$140.00 | ~$140.00 | Distributor, Sep 2026 ($120–160 each). Check the lab first | `AO_Valve_T<k>_Angle` ← `Tank<k>.ValveOpeningPct`; `AO_Belt_SpeedRef` (or a PWM output) | Ashley |
| HMI | ALT: C-more Micro 3 in touch panel (EA3-S3ML) | 1 | $342.00 | $342.00 | Catalog, Sep 2026 (BOM had the 2018 price, $198) | Local operator panel: START/STOP, recipe select, status. Talks generic Modbus TCP/RTU to the Micro850's panel area; not part of the register map. Free programming software | Ashley |
| HMI | AMSAMOTION 4.3 in touch panel (budget) | 1 | $60.00 | $60.00 | Confirmed | Same role. **Pick one HMI**, not both, or neither (hardwired START/JOG + web HMI). Check its configuration software is free | Ashley |
| Local controller (MCU) | ESP32 DevKit board | 2 | $8.00 | $16.00 | Estimate | ESP32 #1 scanner node (preprinted QR), ESP32 #2 station node (robotic arm + sort sensor; can run on the xArm's own ESP32 controller instead). Firmware in [`firmware/`](../../firmware) ([esp32.md](esp32.md)) | Ashley |
| Labeling & scan | Label applicator mechanics (built: printed peel/tamp parts). **Not on this conveyor** | 1 | $0.00 | $0.00 | Estimate | Station `LABEL`, `Station.LabelRequest/Done`. Leave unwired. The QR is already on the can | Ashley |
| Labeling & scan | **STEPPERONLINE DM556Y Open Loop Stepper** (20–50 V DC, 1.7–5.6 A peak, step/dir/enable) **and a NEMA 23 bipolar stepper motor** (4-wire). **Not on this conveyor.** Catalog pairing if a labeler is added later and the motor is not already on hand: kit **1-DM556Y-23HS39** (motor 23HS39-5004S, 1.8°, 3.0 N·m, 5.0 A). Set the DIP current at or below the motor's rated phase current | 1 | ~$70.00 | ~$70.00 | Estimate, Sep 2026. Confirm the motor current before ordering | ESP32 #1 can pulse the driver (`label_step` / `label_dir` / `label_ena`) through `Station.LabelRequest/Done`. Driver supply through the safety relay. See [esp32.md](esp32.md) | Ashley |
| Labeling & scan | Barcode scanner module (Waveshare 1D/2D, GM65-class, UART) | 1 | $35.00 | $35.00 | Estimate | Station `SCAN`, scan mailbox `Scan.*`: the scanner node forwards the raw text and the PLC validates it (format in [`barcode.ts`](../../twin/src/barcode.ts)) | Ashley |
| Tanks 1/2 | Proportional (servo-driven) ball or butterfly valve | 2 | $35.00 | $70.00 | Estimate | `BAY-k`, `TankConfig.valveOpeningPct`, `dispenseRateMlPerSec` calibrated at that opening | Ashley |
| Tanks 1/2 | Tank body + fittings (built). Conveyor reservoirs: T1 blue, T2 orange | 2 | $15.00 | $30.00 | Estimate | `TankConfig.capacityMl` | Ashley |
| Sensors | Inductive/photoelectric proximity sensor (bottle position at the fill bays) | 3 | $15.00 | $45.00 | Estimate | `I_Bay<k>_Present` (2 bays) plus one spare. 24 V PNP into the PLC | Ashley |
| Sensors | **Touch sensors**, 24 V DC, PNP, normally open (bottle present at the dry stations) | 6 | ~$8.00 | ~$48.00 | Estimate. Confirm they are 24 V field sensors, not 3.3 V modules | `I_Scan_Present`, `I_Cap_Present`, `I_Press_Present`, `I_QC_Present`, `I_Gate_Present`, `I_Sort_Present`. Together with the two bay sensors this is the 8 presence inputs the software waits on | |
| Sensors | **(added)** VL53L1X time-of-flight distance sensor breakout (sort sensor, bottle height) | 1 | $10.00 | $10.00 | Estimate | Sort sensor at `QC` on ESP32 #2: `Station.SortRequest/Done`, `Station.SortHeightMm`. The PLC classifies the height against `config.sort` (Lane 1 120 mm, Lane 2 180 mm, ±15 mm) | |
| Capping arm | Robotic arm: **Hiwonder xArm ESP32**, 6-DOF, LX bus servos, with gripper. It lifts a lid from the lid magazine and places it on the container at CAP. The lid-press cylinder seats it | 1 | $130.00 | $130.00 | Estimate | Station `CAP`, arm commands `Station.ArmCmd` (`HOME`, `PICK_LID`, `PLACE_LID`) → `Station.ArmResult`, `Station.ArmStatus`. Station `PRESS` is `O_LidPress_Extend` | Ashley |
| Capping arm | **(added)** Lid magazine: gravity-fed stack of lids, 3D-printed or acrylic, fixed where the arm can reach | 1 | $5.00 | $5.00 | Estimate | `PICK_LID` lifts the top lid; an empty or misaligned magazine latches `ARM_NO_LID` (`Sys.FaultCode` 4) | |
| Reject & sort | Solenoid-actuated gate (reject diverter + sort diverter) | 2 | $25.00 | $50.00 | Estimate | `GATE` → `O_RejectDiverter_Extend`; `SORT` → `O_SortDiverter_LaneB`, `config.sort` | Ashley |
| Safety | E-Stop push-button, illuminated, NC contact | 2 | $18.00 | $36.00 | Estimate | `ENTRY`, `EXIT` in `config.safety.eStopButtons` | Ashley |
| Safety | **(optional, not in the software)** Extra E-Stop. The default mask is two buttons, Line start and Line end | 1 | $18.00 | $18.00 | Estimate | Add it only together with a new entry in `config.safety.eStopButtons` and a monitoring input. It is not bit 2 today | |
| Safety | Safety relay (hardwired E-Stop circuit) | 1 | $35.00 | $35.00 | Estimate | `I_Safety_OK`, [safety.md](safety.md) | Ashley |
| Indicators | **ONN-M4W** wall-mounted signal tower, **DC 24 V** (not the 220 V unit): 3 layers, red / yellow / green, buzzer >95 dB, steady or flash, PNP/NPN or contact | 1 | ~$20.00 | ~$20.00 | Catalog, about $17–22 | `O_Stack_Red`, `O_Stack_Amber` (yellow), `O_Stack_Green`, `O_Buzzer`. Common to 0 V so the Micro850's sourcing outputs turn each layer on. Indication only — not a safety device | |
| Conveyor | DC gear motor (or a reused wiper motor, $0) | 1 | $20.00 | $20.00 | Estimate | `beltSpeedMPerSec`. Run/stop is the speed controller's enable | Ashley |
| Conveyor | **DC motor speed controller** (PWM), with an enable input and a 0–10 V or PWM speed input | 1 | ~$15.00 | ~$15.00 | Estimate. Match the controller's supply to the motor | `O_Belt_Run` enables the controller; `AO_Belt_SpeedRef` (or one Micro850 PWM output) sets the speed. Power through the safety relay | |
| Conveyor | Conveyor belt + frame materials | 1 | $60.00 | $60.00 | Estimate | `stationSpacingM`, station positions | Ashley |
| Misc | Wiring, connectors, relays, power supply, enclosure hardware | 1 | $75.00 | $75.00 | Estimate | — | Ashley |
| Conveyor design | Schematics, 2D/3D model, BOM (design only) | 1 | $0.00 | $0.00 | Confirmed | `config.ts` stations and spacing; the twin, virtual PLC and HMI views ([commissioning.md §1–§2](commissioning.md)) | Ashley |

**Totals.** The original BOM summed to **$1,300.00** with *both* HMI options and a CLICK PLUS PLC ($330 for CPU and modules). Using the team's 2080-L50E-24QBB removes the CPU and the CLICK modules. Its 14 inputs and 10 outputs do not cover stoppers, the full tower and the extra sensors, so price a 2085-IQ16 and a 2085-OB16 as well. The conveyor has two tanks, so the valves and tank bodies are two each, and one 2080-OF2 covers both valve angles (about $140; a second module only if belt speed is analog). The arm places the lid and the press cylinder seats it. Re-check prices before ordering. The C-more Micro adds $282.

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
| G3 | **Presence sensors at every station** | The engine and PLC program wait for a container at SCAN, BAY-1, BAY-2, CAP, PRESS, QC, GATE, SORT: 8 on the 2-tank line | **Resolved in the BOM:** six touch sensors on the dry stations and the proximity sensors on the two fill bays. They must be **24 V PNP**. A 3.3 V touch module cannot go to a PLC input; add an optocoupler or buy the 24 V part | in §2 |
| G4 | **A way to hold a bottle at a station** | The software pipelines up to `maxConcurrentContainers` (4) bottles, which needs a stopper at each holding station (7 on the 2-tank line: scan, both bays, arm, lid press, fill check, fill reject). The BOM has none | **Decision needed.** (a) Budget: run **one bottle at a time**: set `maxConcurrentContainers: 1` and the PLC stops the belt at each station instead of using stoppers. (b) Add small solenoid/servo stoppers and keep pipelining | (a) $0 · (b) ~$50–90 |
| G5 | **Shutoff solenoid per tank** | A servo-driven valve holds its last position when power is cut, so it can keep pouring during an E-Stop ([safety.md §4](safety.md#4-hardware-design-rules)) | NC solenoid in series with each valve, powered through the safety relay (`O_Valve_T<k>_Open`) | ~$16 (2 × ~$8) |
| G6 | **Interposing force-guided relay** for the HMI's digital E-Stop | Lets the web HMI's E-STOP open the hardware safety circuit | Add, **or** accept that the digital E-Stop is only a PLC-level stop for the prototype and document it in the risk assessment | ~$30 |
| G7 | **Sort sensor** | Listed in the controller table but had no purchase line | **Resolved:** a VL53L1X time-of-flight sensor on ESP32 #2 measures the bottle height, and the PLC classifies it (row in §2) | in §2 |
| G8 | **Tank level** | The HMI shows tank levels and the line reacts to low tanks; the BOM has no level sensor or refill valve | PLC estimates level from dispensed volume; a low float per tank (`I_Tank<k>_Low`) confirms it; refill is manual with a "tank refilled" button on the touch panel. The simulator still auto-refills | ~$10 (2 floats) |
| G9 | **Wi-Fi access point + small Ethernet switch** | The Micro850 has one Ethernet port and no Wi-Fi. The monitoring PC, the ESP32 access point (and an Ethernet touch panel) all have to reach that port; keep them off the campus network ([communication.md §1](communication.md#1-network)) | A small unmanaged switch, and a spare router set up as a plain access point wired to the switch | ~$0–40 |
| G10 | **24 V DIN power supply**, a **20–50 V DC supply for the DM556Y**, and a separate 5–6 V supply for the arm servos | PLC, touch sensors, proximity sensors, solenoids and the ONN-M4W run on 24 V. The label stepper driver needs its own supply in the 20–50 V range (24 V is the low end; 36 V is the driver's typical). The arm still needs 5–6 V. Both actuator supplies are switched by the safety relay | Check that the $75 misc line covers the 24 V supply. Budget the stepper supply separately if it isn't already in the lab (~$20–40) | incl. in Misc? |
| G11 | **I/O count** | Required IO for 2 tanks is ~15 DI / 8 DO / 2 AO, more with stoppers, the QR reject and the lid press. The ONN-M4W adds 4 indicator outputs (red, yellow, green, buzzer) plus the RESET lamp ([io-map.md §3](io-map.md#3-io-count-and-sizing)) | The 2080-L50E-24QBB has 14 DI / 10 DO. The ladder puts safety, panel and station-present inputs on the base unit, and `I_Sort_Present`, lane-full, home, low-float, START and JOG on a 2085-IQ16. The 8 required outputs fit, with green and red on the two spare points. Stoppers, amber, the buzzer and the RESET lamp are on a 2085-OB16. One-bottle mode drops the stoppers but the rest of the tower still needs that output module. Analog outputs for the two valves come from one 2080-OF2; add a second only if the belt speed is an analog output ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)) | in §2 |

### What the BOM has that the software didn't model (now handled)

| BOM item | What changed in the software |
| --- | --- |
| Labeling station | Not on this conveyor. The QR is already on the can. `LABEL` stays optional in config; the default line does not include it |
| Robotic capping arm and lid press | `CAP` then `PRESS`. The PLC sequences the arm through `Station.ArmCmd` / `ArmCmdSeq` → `ArmResult` / `ArmDoneSeq`: `HOME`, `PICK_LID` (pre-picked while the belt moves), `PLACE_LID` (place, release, return HOME). The press cylinder (`O_LidPress_Extend`) seats the lid. A failed pick is retried up to 3 times, then latches `ARM_NO_LID`. Station-node firmware in [`firmware/station-node`](../../firmware/station-node) |
| Sort sensor + 2-path sort diverter | `QC` is the sort sensor: the station node reports the raw bottle height (`Station.SortHeightMm`) and the PLC classifies it against `config.sort` (lane heights, ±15 mm). New `SORT` station and `config.sort` (two lanes, bottle type from the recipe total); `Counts.LaneA/B`; `BOTTLE_TYPE_MISMATCH` reject reason; lane shown per container in the HMI |
| Reject diverter (slide) | Bad scans are ejected at the scan gate before either valve opens. `GATE` is the later reject, for a bad fill, a bad cap, or a bottle-type mismatch |
| Proportional valves (open/close + angle) | Pumps replaced by valves; `valveOpeningPct` per tank and `Tank<k>.ValveOpeningPct` register |
| E-Stops at the infeed and the outfeed | `ENTRY` ("Line start") and `EXIT` ("Line end"). Those are the two mushrooms on the conveyor |
| Allen-Bradley Micro850 2080-L50E-24QBB (team-owned) | PLC guide [micro850-plc.md](micro850-plc.md): free CCW Standard (20.01 or later), Modbus mapping of the register map, IO sizing. `PLC_COIL_BASE` stays 0 |
| ESP32 nodes controlling actuators, wireless link | Station handshake with `Station.RunPermit`; the nodes execute and report, the PLC decides. Heartbeats and node fault bits latch station faults (`Sys.FaultCode`) that stop the line until RESET. Safety rules in [safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes) |
| DM556Y and NEMA 23 motor on the label applicator | Same `Station.LabelRequest/Done` handshake. The scanner-node firmware steps the driver out and back; it no longer drives a hobby servo |
| Conveyor speed controller | `O_Belt_Run` is the enable, `AO_Belt_SpeedRef` or a PWM output is the speed, `beltSpeedMPerSec` in config |
| Touch sensors at LABEL, SCAN, CAP, QC, GATE, SORT | The presence inputs those stations already wait on (`I_<Station>_Present`) |
| ONN-M4W stack light | `O_Stack_Green` running, `O_Stack_Amber` stopped / warning, `O_Stack_Red` E-Stop or fault, `O_Buzzer` on E-Stop or a jam. The yellow layer is the amber output |
| PC/laptop monitoring over Ethernet | The bridge, web HMI and FUXA run on the laptop (or a Pi); FUXA installs and starts with `npm run fuxa` ([scada.md](scada.md)) |
| Touch-panel HMI with recipe select | Acts as the local control station. **Recipe select is not implemented yet**: today the recipe comes from the barcode (open decision D3) |

## 4. Budget

The department budget mentioned so far is about **$500**. The reconciled line is well above that:

| Scenario | Estimate |
| --- | ---: |
| BOM with the team's 2080-L50E-24QBB, one 2080-OF2 for the two valves, one budget HMI, lid magazine, lid press, VL53L1X, speed controller, touch sensors, ONN-M4W | re-check; two tanks and one analog module, not three tanks and two modules |
| + required gaps G1, G2, G5, G8 (G3 is in the BOM; one-bottle mode, no stoppers, digital E-Stop as PLC-level stop) | ~$1,250–1,280 |
| + stoppers (G4b), interposing relay (G6), AP/switch (G9) | ~$1,330–1,440 |
| With the C-more Micro instead of the budget panel | add ~$282 |
| With no touch panel (hardwired START/JOG + web HMI) | subtract ~$50 |

Levers to discuss, largest first:

1. **Analog output plug-in (~$140).** One 2080-OF2 covers both valve angles. Look in the lab before buying. Driving belt speed from a PWM output avoids a second module.
2. **Capping arm ($130).** Borrow a Hiwonder xArm from the lab, or run the line without capping (lids fitted by hand after the line): drop `CAP` from `config.stations`, and the PLC no longer sequences the arm.
3. **HMI ($0–342).** Use the budget panel, or rely on the web HMI on the laptop plus hardwired START/JOG/STOP/RESET for local control.
4. **Proportional valves ($70 for two).** `valveOpeningPct: 100` is on/off if a tank uses a plain solenoid. One 2080-OF2 already covers both valves.
5. **Conveyor motor ($20).** Reuse a wiper motor ($0), as discussed in class.
6. **One-bottle mode (G4a)** instead of stoppers saves ~$50–90.

## 5. Requirements traceability

| Physical requirement | Config | PLC / register map | Tests |
| --- | --- | --- | --- |
| E-Stop at the **line start** and the **line end**, hardwired through a safety relay | `safety.eStopButtons` = `ENTRY` "Line start", `EXIT` "Line end" | `I_EStop_Entry/Exit_Mon`; `Sys.PhysicalEStopMask` bits 0–1; events 25/26 name the location | `core.test.ts`: "physical E-Stop at the line start and at the line end…", "default line matches the concept…" |
| Digital E-Stop from the HMI opens the same circuit | — | `Cmd.DigitalEStop`, `O_Safety_RemoteEStopOK` (needs G6) | `core.test.ts`, `plc.test.ts` digital E-Stop tests |
| Station order matches the conveyor (two tanks, lid press, no labeler) | `stations` | Container status codes 1, 11–12, 24, 25, 21, 22/27 (PRESS is 25, SORT is 26) | "default line matches the concept: two tanks, lid press, two e-stops", "containers visit scan, both tanks, the arm, the lid press…" |
| Tank valves: open/close + angle | `TankConfig.valveOpeningPct`, `dispenseRateMlPerSec` | `O_Valve_T<k>_Open`, `AO_Valve_T<k>_Angle`, `Tank<k>.ValveOpeningPct` | `plc.test.ts`: "bridge decodes the virtual PLC…" (valve register) |
| Capping (arm places the lid) and the lid-press cylinder | `stationTimesSec`, `stationNodeTimeoutSec` | `Station.RunPermit`, `Station.ArmCmd/ArmCmdSeq/ArmDoneSeq/ArmResult/ArmStatus`, `O_LidPress_Extend` | `plc.test.ts`: "PLC supervises the simulated nodes…", "arm: a failed lid pick is retried…" |
| Barcode read → recipe (the PLC validates) | `SAMPLE_BARCODES`, barcode format | `Scan.*` mailbox: raw text from the scanner node, `Scan.ParseResult` / `Scan.TotalMl` from the PLC | `plc.test.ts`: "scan mailbox over Modbus…", "scan text packing…" |
| Bad scan is ejected at the scan gate before filling | — | `Scan.ParseResult` ≠ 0 → reject at SCAN, valves stay closed | `core.test.ts`: "a bad QR is ejected at the scan gate before filling" |
| Sort sensor re-confirms bottle type (the PLC classifies) | `sort.lanes[].bottleHeightMm`, `sort.heightToleranceMm`, `sort.smallBottleMaxMl` | `Station.SortRequest/Done`, `Station.SortHeightMm`, reject reason `BOTTLE_TYPE_MISMATCH` | `plc.test.ts`: "sort sensor: the PLC classifies the raw height…" |
| Station faults stop the line until RESET | `stationNodeTimeoutSec` | `Sys.FaultCode`, `LineState` bit3 FAULT, events `FAULT` (22) / `FAULT_CLEARED` (33), refusal reason `FAULT_ACTIVE` | `core.test.ts`: "station faults stop the line…", "station driver timeout…"; `plc.test.ts`: "node supervision…" |
| Reject diverter | — | `O_RejectDiverter_Extend`, `Cmd.FirePusher` | E-Stop and local-control tests exercise `firePusher` |
| 2-path sort | `sort.lanes` (Lane 1, Lane 2) | `O_SortDiverter_LaneB`, `Counts.LaneA/B`, status 22/27 | `core.test.ts`: "sort diverter: small bottles go to Lane 1…"; `plc.test.ts` lane checks |
| Conveyor run/stop + speed controller | `beltSpeedMPerSec` | `O_Belt_Run` enables the controller; `AO_Belt_SpeedRef` (or PWM) sets the speed | Flow tests |
| Label applicator is the DM556Y + NEMA 23 stepper | `stationTimesSec` (the twin's label time), scanner-node `label_steps` / `label_us` | `Station.LabelRequest/Done`. Driver alarm or a missed label sets scanner-node fault bit0 → `Sys.FaultCode` 1 | `plc.test.ts` label handshake; bench `stroke` on the scanner node |
| Touch sensors at the six dry stations, proximity at the bays | — | `I_Scan_Present`, `I_Bay<k>_Present`, `I_Cap_Present`, `I_Press_Present`, `I_QC_Present`, `I_Gate_Present`, `I_Sort_Present` | Admission and station-wait tests |
| ONN-M4W stack light (red, yellow, green, buzzer) | — | `O_Stack_Red` / `O_Stack_Amber` / `O_Stack_Green` / `O_Buzzer` | Commissioning: HMI-link loss lights yellow; E-Stop lights red |
| PLC ↔ ESP32 wireless link supervised | — | `Field.ScannerNodeHeartbeat`, `Field.StationNodeHeartbeat` (offline after 3 s → fault 7 / 8), `Station.RunPermit` | `plc.test.ts`: "node supervision…"; firmware in [`firmware/`](../../firmware) ([esp32.md](esp32.md)); `generated.test.ts` checks the firmware register header against `tag-map.ts` |
| PLC ↔ PC monitoring/logging | `PLC_HOST` etc. | Whole register map; SCADA is read-only by default (command coils only with `FUXA_COMMANDS=1`) | Bridge tests in `plc.test.ts`; FUXA project tests in `generated.test.ts`; SCADA in [scada.md](scada.md) |

## 6. Open decisions for the team

- **D1: Stoppers or one bottle at a time?** (G4.) One-bottle mode is cheaper and simpler to wire; stoppers keep throughput and match the simulator's default.
- **D2: Digital E-Stop hardware path?** (G6.) Buy the interposing relay, or document the web HMI's E-STOP as a PLC-level stop for the prototype.
- **D3: Where does the recipe come from?** Today the recipe is encoded in the barcode (`PT1|T250|150,100` on the two-tank line); the scanner node forwards the raw text and the PLC decodes and validates it. The QR is already printed on the can. The BOM's touch panel has "recipe select". Proposal: the operator selects the recipe on the touch panel; the PLC rejects a can whose QR doesn't match the selected recipe. This needs a "selected recipe" register, which isn't in the map yet.
- **D4: Level sensing and refill.** Estimate + low float + manual refill (G8), or real level sensors.
- **D5: Which HMI?** Budget panel, C-more Micro, or no touch panel (hardwired START/JOG + web HMI). A panel must be a Modbus TCP or RTU master to talk to the Micro850, and its configuration software must be free.
- **D6: Budget.** Which levers in §4 the team accepts.

### Decided

- **D7: PLC model.** The team's controller is the **2080-L50E-24QBB** (14 DI / 10 DO). It needs CCW Standard 20.01 or later. Budget a 2085-IQ16 and a 2085-OB16 for the inputs and outputs past the embedded points, and a 2080-OF2 for the valve angles ([micro850-plc.md §1](micro850-plc.md#the-controller-2080-l50e-24qbb)). Still list any plug-in or expansion modules already fitted or in the lab.
- **D8: ProtoTwin.** Dropped (subscription product). The Node twin and the virtual PLC (development stages 1–2) need no licence.
- **D9: SCADA.** [FUXA](https://github.com/frangoteam/FUXA) over Modbus TCP, installed natively with `npm run fuxa`. It is read-only by default; built with `FUXA_COMMANDS=1` it can also pulse the command coils, and the PLC applies the same authority rules as for the web HMI ([scada.md](scada.md)).
- **D10: Lid press.** On the conveyor. The arm places the lid at CAP; the cylinder at PRESS seats it.
