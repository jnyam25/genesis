# IO map

Two layers:

1. **Field IO**: the physical sensors and actuators, and which controller each one is wired to (§1–§3). The split follows the team's bill of materials ([bom.md](bom.md)): the team's **Allen-Bradley Micro850 PLC** supervises the line, and two **ESP32** station nodes run the labeling, scanning, robotic capping and sort-sensing stations. The PLC makes every decision; the nodes only execute its requests and report back.
2. **Register map**: the data the PLC exchanges with the monitoring PC (bridge + web HMI, FUXA SCADA) and the ESP32 nodes over Modbus TCP (§4). This section is **generated from [`twin/src/plc/tag-map.ts`](../../twin/src/plc/tag-map.ts)**; regenerate it with `npm run tag-map` after changing the map.

The line layout it assumes (from [`twin/src/config.ts`](../../twin/src/config.ts)):

```
 E-Stop (line start)                                                                                 E-Stop (line end)
 load ─▶[SCAN]─▶[BAY-1]─▶[BAY-2]─▶[CAP]─▶[PRESS]─▶[QC]─▶[GATE]─▶[SORT]─▶ lane 1
            │ QR reject                              lid press        │ fill reject └──▶ lane 2
            ▼ slide
```

- **One-way belt, one fill bay per tank.** A container passes each station once, in belt order. See "Belt order" in [../engine-design.md](../engine-design.md#belt-order).
- **Holding a container at a station.** The software assumes every station except SORT can hold a container in place (a stopper, or stopping the belt on a single-bottle line) and has a presence sensor. The BOM does not budget stoppers yet; see the open decision in [bom.md](bom.md#3-gaps-between-the-bom-and-the-software).
- **QR reject slide at the scan gate.** A bad or missing QR is ejected before either fill valve opens. A bad fill or a bad cap uses the second reject slide at GATE.
- **Lid press.** The arm lifts a lid from the magazine and places it. A separate cylinder at PRESS seats it.
- **Two E-Stops**, one at the start of the line and one at the end. The QR is already printed on the can, so the default line has no labeling station.
- **Tank slots** `T1` and `T2` are fixed. Slot k always has id `Tk`, bay `BAY-k`, and register block `Tank<k>.*`.

### Who controls what

| Component | Signal | Type | Controller | Link |
| --- | --- | --- | --- | --- |
| E-Stop (line start), E-Stop (line end) | Emergency stop | Safety contacts → safety relay; NC monitoring contact → DI | Safety relay; PLC monitors | Hardwired |
| HMI touch panel (budget panel or C-more Micro; optional) | Recipe select, start/stop, status | Modbus TCP or serial Modbus RTU | PLC | Wired |
| Conveyor motor + DC speed controller | Run/stop (controller enable), speed (0–10 V or PWM) | DO + AO (or PWM) | PLC | Wired |
| Tank 1 / 2 valves | Open/close + angle | DO + AO | PLC | Wired |
| Reject diverter (slide) | Actuate reject | DO | PLC | Wired |
| Sort diverter (2-path split) | Path select | DO | PLC | Wired |
| Presence sensors | Bottle at station. Touch sensors (24 V PNP) at SCAN, CAP, PRESS, QC, GATE and SORT; proximity sensors at the two fill bays | DI | PLC | Wired |
| QR reject pusher | Pneumatic cylinder at the scan gate | DO | PLC | Wired |
| Lid press | Vertical pneumatic cylinder after the capping arm | DO | PLC | Wired |
| Label applicator (not on the default line) | STEPPERONLINE DM556Y Open Loop Stepper + NEMA 23 motor: one stroke out and back. The concept line uses a preprinted QR, so this station stays unwired unless a labeler is added | Step / dir / enable (5 V opto) | ESP32 #1 (scanner node) | Wired |
| Barcode scanner (GM65-class) | Read the QR on the can (forwarded raw; the PLC validates it) | UART | ESP32 #1 (scanner node) | Wired |
| Robotic arm (Hiwonder xArm ESP32, 6-DOF with gripper) | Lift a lid from the lid magazine, place it on the container at CAP, release, return HOME. The lid-press cylinder seats it | LX servo bus | ESP32 #2 (station node) | Wired |
| Sort sensor (VL53L1X time-of-flight) | Measure bottle height (the PLC classifies the bottle type) | I²C | ESP32 #2 (station node) | Wired |
| PLC ↔ ESP32 nodes | Scan text, station handshakes, arm commands, fault bits, heartbeats | Modbus TCP (`Scan.*`, `Station.*`, `Field.*`) | Supervisor link | Wireless (dedicated AP) |
| PLC ↔ monitoring PC | Bridge + web HMI, logging, FUXA SCADA | Modbus TCP | Supervisor link | Wired Ethernet |

## 1. Field inputs (PLC)

Tag names follow `I_<Area>_<Device>_<Signal>`. Counts are for the 2-tank line.

| PLC tag | Device | Type | Signal | Notes |
| --- | --- | --- | --- | --- |
| `I_Safety_OK` | Safety relay auxiliary (NO) contact | DI 24 V | 1 = safety circuit closed and reset | **Monitoring only** ([safety.md](safety.md)) → `LineState.SAFETY_OK` |
| `I_EStop_Entry_Mon` | Monitoring contact (NC) of the E-Stop at the **start of the line** (infeed, where cans are loaded) | DI | **0 = pressed** (NC opens) | → `Sys.PhysicalEStopMask` bit0 (`ENTRY`, "Line start"). The button's safety contacts go to the safety relay, not the PLC |
| `I_EStop_Exit_Mon` | Monitoring contact (NC) of the E-Stop at the **end of the line** (sort / output lanes) | DI | 0 = pressed | → mask bit1 (`EXIT`, "Line end"). One input per button in `config.safety.eStopButtons` |
| `I_Safety_RemoteRelay_Fb` | Force-guided NC feedback of the remote E-Stop interposing relay | DI | 1 = relay de-energized | Welded-contact check: must be 1 while `O_Safety_RemoteEStopOK` = 0 |
| `I_Panel_LocalMode` | LOCAL/REMOTE key selector | DI | 1 = LOCAL | → `LineState.LOCAL_MODE`. Changing position stops the line |
| `I_Panel_Stop_PB` | STOP push-button (red) | DI (**NC**) | **0 = pressed** | Controlled stop, **any mode**; a broken wire stops the line. The touch panel's STOP is an extra, not a replacement |
| `I_Panel_Reset_PB` | RESET push-button (blue, illuminated) | DI (NO) | 1 = pressed | Safety reset, any mode. Also wired to the safety relay reset input, so it must be a real button |
| START / JOG | Touch-panel buttons (or hardwired NO push-buttons) | Panel bit (or DI) | 1 = pressed | LOCAL mode only. JOG is hold-to-run |
| `I_Scan_Present` | Touch sensor at SCAN | DI (24 V PNP) | 1 = container present | First station |
| `I_Bay<k>_Present` | Proximity sensor at BAY-k (splash zone) | DI | 1 = present | One per tank (k = 1..2) |
| `I_Cap_Present` | Touch sensor at CAP | DI | 1 = present | |
| `I_Press_Present` | Touch sensor at the lid press | DI | 1 = present | |
| `I_QC_Present` | Touch sensor at the sort sensor (QC) | DI | 1 = present | Can be the sort sensor's own "object present" output via ESP32 #2 if it has one |
| `I_Gate_Present` | Touch sensor at the reject diverter | DI | 1 = present | |
| `I_Sort_Present` | Touch sensor at the sort diverter | DI | 1 = present | Optional if the diverter is timed from `I_Gate_Present` |
| `I_LaneA_Full` / `I_LaneB_Full` / `I_Reject_Full` | Sensors at the end of each output lane | DI | 1 = lane full | Recommended: PLC halts admission when full |
| `I_RejectDiverter_Home` / `I_SortDiverter_Home` | Limit or reed switches | DI | 1 = retracted | Recommended: fault if not home within 1 s |
| `I_Belt_Drive_Fault` | Motor driver fault output | DI | 1 = fault | Optional. Stops the line (`RunCmd := 0`). It has no fault code yet: if it's wired, add one to `FaultCode` in [`events.ts`](../../twin/src/events.ts) so it latches `LINE_STATE.FAULT` like the station faults |
| `I_Tank<k>_Low` | Low-level float switch, per tank | DI | 1 = low | Recommended: the BOM has no level sensor, so the PLC estimates the level from dispensed volume and this float confirms it (see [bom.md](bom.md#3-gaps-between-the-bom-and-the-software)) |
| `AI_Tank<k>_Level` | Level transmitter (4–20 mA) | AI | 4 mA = empty, 20 mA = capacity | Optional upgrade, or an ESP32 tank node (`Field.Tank<k>LevelMl`); pick one per tank |

## 2. Field outputs (PLC)

| PLC tag | Device | Type | ON means | De-energized state |
| --- | --- | --- | --- | --- |
| `O_Belt_Run` | Conveyor speed-controller enable | DO 24 V | Controller enabled, belt may run | Stopped (controller disabled) |
| `AO_Belt_SpeedRef` | Speed-controller speed input | AO 0–10 V (or a Micro850 PWM output) | Speed ∝ `beltSpeedMPerSec` | 0. Omit only if the controller's own knob is the speed setting |
| `O_Valve_T<k>_Open` | NC shutoff solenoid in series with tank k's proportional valve, and the valve's enable | DO | Tank k may flow | Closed (spring) |
| `AO_Valve_T<k>_Angle` | Proportional (servo-driven) valve position input | AO 0–10 V (or servo positioner) | Opening = `Tank<k>.ValveOpeningPct` while dispensing | 0 % (but a servo valve holds its last position without power, hence the shutoff solenoid) |
| `O_<Station>_Stopper` | Stopper actuator, one per holding station (SCAN, BAY-k, CAP, PRESS, QC, GATE) | DO | **Retract** (release container) | Extended, holding (spring return). Only if stoppers are fitted; on a single-bottle line the belt stop does this job |
| `O_QrReject_Extend` | Scan-gate ejector | DO | Push a bad QR onto the QR reject slide | Retracted (spring) |
| `O_LidPress_Extend` | Lid-press cylinder | DO | Seat the lid | Retracted (spring) |
| `O_RejectDiverter_Extend` | Fill-reject pusher | DO | Push a bad fill or bad cap onto the fill reject slide | Retracted (spring) |
| `O_SortDiverter_LaneB` | Sort diverter gate (solenoid) | DO | Route to lane B | Lane A (spring) |
| `O_Refill_T<k>_Valve` | Normally-closed refill solenoid | DO | Refill flowing | Closed. Not in the BOM: refill is manual unless added |
| `O_Safety_RemoteEStopOK` | Coil of the interposing safety relay (force-guided contacts in series with **both** E-Stop channels) | DO | **Energized = OK.** De-energized when the digital E-Stop is latched, which opens the safety circuit | **De-energized = E-Stop** (fail-safe: PLC off/Program mode opens the circuit) |
| `O_Stack_Green` | ONN-M4W green layer | DO 24 V sourcing | Line running | Off |
| `O_Stack_Amber` | ONN-M4W yellow layer | DO | Stopped, reset required, or warning (including HMI link lost) | Off |
| `O_Stack_Red` | ONN-M4W red layer | DO | E-Stop or latched fault | Off |
| `O_Panel_Lamp_Reset` | Blue lamp in the RESET button | DO | Flashing = reset required | Off |
| `O_Buzzer` | ONN-M4W buzzer | DO | Audible alarm (E-Stop, jam). Pulse it; a steady >95 dB tone is too loud for a warning that can sit | Off |

The **ONN-M4W** is the wall-mounted tower (order the **DC 24 V** unit, not AC 220 V). Wire its common to 0 V and each color wire, plus the buzzer wire, to a sourcing PLC output. Leave a separate flash terminal unused: the PLC turns a layer on steady, and pulses the buzzer itself. Mount it where the operator can see it from the load end. It is indication only; the safety relay does not switch it, so it can still show which E-Stop was pressed after motion power is gone.

Running, E-Stop and REMOTE indications can live on the touch panel as well as the tower. The RESET lamp stays a real lamp because it sits in the button.

The **safety relay** switches power to the conveyor motor driver, the valve shutoff solenoids and valve servos, both diverters, the label applicator and the capping arm's servo supply (the last two are driven by the ESP32 nodes). It does **not** switch the PLC, the ESP32 logic supply or the monitoring PC, so the control system stays alive to report which E-Stop was pressed. See [safety.md §1](safety.md#1-emergency-stop-physical-and-digital-working-together), [§2a](safety.md#2a-actuators-driven-by-the-esp32-nodes) and [§4](safety.md#4-hardware-design-rules).

### ESP32 station node IO (not PLC IO)

| Node | Device | Interface | Notes |
| --- | --- | --- | --- |
| ESP32 #1 scanner node | Barcode scanner (Waveshare 1D/2D, GM65-class module) | UART 3.3 V | On a new `Scan.Request` it triggers one read and writes the **raw** text (`Scan.Status`, `Scan.Length`, `Scan.Text1..32`), then `Scan.Done`. It never parses the barcode; the PLC validates it (`Scan.ParseResult`) |
| ESP32 #1 scanner node | Label applicator: **DM556Y** + NEMA 23 stepper | Step (PU), direction (DR), motor-free (MF), 5 V opto. Optional alarm input | On `Station.LabelRequest`, `label_steps` pulses out and the same number back, then `Station.LabelDone`. PU+/DR+/MF+ to the DevKit's +5 V; each minus pin is sunk by a small NPN or 2N7002 because the driver's high level is 5–24 V and an ESP32 pin is 3.3 V. GPIO high = opto on; a rising edge on the step pin is one step (falling edge on PU−). MF high = coils off. The **motor supply (20–50 V DC)** is switched by the safety relay, never taken from the ESP32 |
| ESP32 #2 station node | Robotic arm: Hiwonder xArm ESP32, 6 LX bus servos, servo 1 is the gripper | LX servo bus (half-duplex UART) | Runs one `Station.ArmCmd` per new `Station.ArmCmdSeq` (`HOME`, `PICK_LID` from the lid magazine, `PLACE_LID` at CAP), then writes `Station.ArmResult` and `Station.ArmDoneSeq`; keeps `Station.ArmStatus` current. The lid-press cylinder, not the arm, seats the lid. Lid detection uses the gripper servo's position (closing on a lid stalls short of the empty-closed position). Poses are taught in the node's serial-console teach mode (line stopped only). Servo power via the safety relay |
| ESP32 #2 station node | Sort sensor: VL53L1X time-of-flight, looking down at the bottle at QC | I²C 3.3 V | On a new `Station.SortRequest` it writes the measured height to `Station.SortHeightMm`, then `Station.SortDone`. It never classifies the bottle; the PLC does, against `config.sort` |

ESP32 GPIO is 3.3 V: never connect 24 V field signals directly. The firmware is in [`firmware/`](../../firmware) and described in [esp32.md](esp32.md).

### Safety circuit wiring (overview)

```
 +24V safety ──┬─ E-Stop START (ch1) ─ E-Stop END (ch1) ─ K_REMOTE NO (ch1) ─┬─▶ Safety relay S11/S12 (ch1)
               └─ E-Stop START (ch2) ─ E-Stop END (ch2) ─ K_REMOTE NO (ch2) ─┴─▶ Safety relay S21/S22 (ch2)
 RESET PB ─────────────────────────────────────────────────────────────────────────────────────────▶ Safety relay reset (S33/S34, edge-triggered)
 K_REMOTE NC (feedback) ─┬─ motor driver/contactor feedback NC ────────────────────────────────────▶ Safety relay feedback loop
 Safety relay outputs 13/14, 23/24 ──▶ conveyor speed controller, valve shutoff + servo supply, diverters, DM556Y supply, arm servo supply
 Safety relay aux 41/42 ──▶ I_Safety_OK
 PLC O_Safety_RemoteEStopOK ──▶ K_REMOTE coil (force-guided interposing safety relay)
 Each E-Stop NC monitoring contact ──▶ I_EStop_<Location>_Mon
```

Terminal names are generic. Follow your safety relay's manual.

## 3. IO count and sizing

For N tanks:

| | Formula | N = 2 |
| --- | --- | ---: |
| Digital inputs, required | 13 + N (safety OK, 2 E-Stop monitors, relay feedback, key, STOP, RESET, 6 + N presence sensors) | 15 |
| Digital inputs, recommended extras | 6 + N (3 lane-full, 3 actuator-home, 1 low float per tank) | 8 |
| Digital outputs, required | 6 + N (belt, QR reject, lid press, fill reject, sort diverter, remote E-Stop OK, 1 valve shutoff per tank) | 8 |
| Digital outputs, stoppers (if fitted) | 5 + N | 7 |
| Digital outputs, indicators (ONN-M4W + RESET lamp) | 5 (tower red / yellow / green, buzzer, RESET lamp) | 5 |
| Analog outputs | N valve angles (+1 belt speed) | 2–3 |

Size the Micro850's plug-in and expansion modules for the 2-tank line, plus about 20% spare ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)). With stoppers fitted, the line needs roughly 23 DI, 20 DO and 3 AO.

### Calibration values per tank

These live in the PLC and are published in the tank register block. Keep [`config.ts`](../../twin/src/config.ts) in sync so simulation matches the hardware.

| Value | Register | How to measure |
| --- | --- | --- |
| `valveOpeningPct` | `Tank<k>.ValveOpeningPct` | Pick the opening that gives a controllable fill time (start around 80 %); lower it for finer fills |
| `dispenseRateMlPerSec` | `Tank<k>.DispenseRate` (×10) | At that opening, open the valve for 30 s into a beaker on a scale; ml = g ÷ density. Re-measure when the tank level changes a lot (gravity feed slows as the head drops) |
| `capacityMl` | `Tank<k>.CapacityMl` | Usable volume above the valve outlet |
| `refillThresholdMl` | `Tank<k>.RefillThresholdMl` | At least the largest single-recipe volume for that tank plus a margin |
| Level estimate | (PLC internal) | Without a level sensor: level = capacity − Σ dispensed since the last refill; reset on "tank refilled" from the touch panel |

## 4. Register map (Modbus TCP)

**Conventions**
- Addresses are **0-based PDU addresses**. The "Modicon" column is the classic 1-based reference (40001+ for holding registers, 00001+ for coils) that some tools and PLC mapping screens use. How these are mapped onto Micro850 variables is in [micro850-plc.md §2](micro850-plc.md#2-modbus-address-mapping).
- All registers are **UINT16**. `× 10` means the register holds the value × 10.
- Counters wrap at 65 536.
- **R** = PLC writes, others read. **RW** = written by the bridge or an ESP32 node, as described.
- **Coils are one-shot commands.** The writer sets 1; the PLC acts on the rising edge and resets the coil to 0.
- **Unit id** 1. **Port** 502 on the PLC (5020 on the virtual PLC).

<!-- BEGIN GENERATED: tag-map -->
<!-- Generated from twin/src/plc/tag-map.ts (protocol v4) by `npm run tag-map -- --write`. Do not edit by hand. -->

### Holding registers — system (0–19)

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 0 | 40001 | `Sys.ProtocolVersion` | R | — | Register map version (currently 4). Bridge refuses to run on a mismatch. |
| 1 | 40002 | `Sys.PlcHeartbeat` | R | count | Incremented by the PLC at ≥ 1 Hz. Bridge marks the PLC offline if it stops changing for 3 s. |
| 2 | 40003 | `Sys.LineState` | R | bits | bit0 RUNNING, bit1 ESTOP_ACTIVE, bit2 SAFETY_OK (safety relay closed), bit3 FAULT (station fault latched, see Sys.FaultCode), bit4 HMI_LINK_OK, bit5 DIGITAL_ESTOP, bit6 PHYSICAL_ESTOP, bit7 RESET_REQUIRED, bit8 LOCAL_MODE, bit9 REMOTE_RESET_ALLOWED, bit10 SIMULATION. |
| 3 | 40004 | `Sys.TankCount` | R | count | Enabled tank modules. |
| 4 | 40005 | `Sys.TankEnableMask` | RW | bits | bit k-1 = tank slot k enabled. HMI add/remove tank writes this. PLC refuses a mask of 0; in-flight containers that still need a disabled tank are rejected (under-filled). Queued recipes with the old tank count are held back (event 19). |
| 5 | 40006 | `Counts.Accepted` | R | count | Containers accepted since PLC start (wraps). |
| 6 | 40007 | `Counts.Rejected` | R | count | Containers rejected, incl. scan rejects and jams (wraps). |
| 7 | 40008 | `Counts.Total` | R | count | Accepted + rejected (wraps). |
| 8 | 40009 | `Perf.ThroughputCpm` | R | cpm × 100 | Accepted containers per minute, rolling window. |
| 9 | 40010 | `Oee.Availability` | R | × 1000 | 0 while the line is not running (stopped, E-Stop, reset pending). |
| 10 | 40011 | `Oee.Performance` | R | × 1000 |  |
| 11 | 40012 | `Oee.Quality` | R | × 1000 |  |
| 12 | 40013 | `Oee.Overall` | R | × 1000 |  |
| 13 | 40014 | `Sys.HmiHeartbeat` | RW | count | Written by the Pi bridge every poll. PLC clears HMI_LINK_OK if it stops changing (alarm only — never a safety function). |
| 14 | 40015 | `Sys.UptimeS` | R | s (wraps) | Seconds since PLC run start. |
| 15 | 40016 | `Sys.ActiveContainers` | R | count | Containers currently on the belt. |
| 16 | 40017 | `Sys.PhysicalEStopMask` | R | bits | bit i = physical E-Stop button i pressed, from the safety relay's monitoring contacts (bit0 line start, bit1 line end — config.safety.eStopButtons). |
| 17 | 40018 | `Counts.LaneA` | R | count | Accepted containers sorted to lane A (config.sort.lanes[0]) (wraps). |
| 18 | 40019 | `Counts.LaneB` | R | count | Accepted containers sorted to lane B (config.sort.lanes[1]) (wraps). |
| 19 | 40020 | `Sys.FaultCode` | R | code | First latched station fault, 0 = none: 1 labeler, 2 scanner, 3 arm servo, 4 arm could not pick a lid, 5 arm dropped the lid, 6 sort sensor, 7 scanner node offline, 8 station node offline. Cleared by RESET once the cause is gone. |

### Holding registers — tank slots (20–67)

Six registers per slot k = 1..8, base `20 + 6·(k−1)`. Descriptions are given for slot 1 and apply to every slot.

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 20 | 40021 | `Tank1.LevelMl` | R | ml × 10 | Measured level (from field node or analog input). |
| 21 | 40022 | `Tank1.CapacityMl` | R | ml | Usable capacity. |
| 22 | 40023 | `Tank1.Flags` | R | bits | bit0 ENABLED, bit1 REFILLING, bit2 LOW. |
| 23 | 40024 | `Tank1.RefillThresholdMl` | R | ml | Auto-refill starts below this level. |
| 24 | 40025 | `Tank1.DispenseRate` | R | ml/s × 10 | Calibrated flow through the valve at ValveOpeningPct. |
| 25 | 40026 | `Tank1.ValveOpeningPct` | R | % | Proportional valve opening while dispensing (drives AO_Valve_T<k>_Angle). |
| 26 | 40027 | `Tank2.LevelMl` | R | ml × 10 |  |
| 27 | 40028 | `Tank2.CapacityMl` | R | ml |  |
| 28 | 40029 | `Tank2.Flags` | R | bits |  |
| 29 | 40030 | `Tank2.RefillThresholdMl` | R | ml |  |
| 30 | 40031 | `Tank2.DispenseRate` | R | ml/s × 10 |  |
| 31 | 40032 | `Tank2.ValveOpeningPct` | R | % |  |

### Holding registers — container tracking (100–139)

Five registers per slot i = 1..8, base `100 + 5·(i−1)`. Live containers first, then containers that finished in the last ~1.5 s.

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 100 | 40101 | `Container1.Id` | R | — | Container id, 0 = empty slot. |
| 101 | 40102 | `Container1.Status` | R | code | 0 none, 1 scan, 2 scan-rejected, 3 label, 11..18 fill at bay n (10+n), 20 mix, 21 sort sensor / reject diverter, 22 accepted to lane A, 23 rejected, 24 capping arm, 26 sort diverter, 27 accepted to lane B (25 reserved). |
| 102 | 40103 | `Container1.FillMl` | R | ml × 10 | Dispensed so far. |
| 103 | 40104 | `Container1.TargetMl` | R | ml × 10 | Recipe total. |
| 105 | 40106 | `Container2.Id` | R | — |  |
| 106 | 40107 | `Container2.Status` | R | code |  |
| 107 | 40108 | `Container2.FillMl` | R | ml × 10 |  |
| 108 | 40109 | `Container2.TargetMl` | R | ml × 10 |  |
| 110 | 40111 | `Container3.Id` | R | — |  |
| 111 | 40112 | `Container3.Status` | R | code |  |
| 112 | 40113 | `Container3.FillMl` | R | ml × 10 |  |
| 113 | 40114 | `Container3.TargetMl` | R | ml × 10 |  |
| 115 | 40116 | `Container4.Id` | R | — |  |
| 116 | 40117 | `Container4.Status` | R | code |  |
| 117 | 40118 | `Container4.FillMl` | R | ml × 10 |  |
| 118 | 40119 | `Container4.TargetMl` | R | ml × 10 |  |
| 120 | 40121 | `Container5.Id` | R | — |  |
| 121 | 40122 | `Container5.Status` | R | code |  |
| 122 | 40123 | `Container5.FillMl` | R | ml × 10 |  |
| 123 | 40124 | `Container5.TargetMl` | R | ml × 10 |  |
| 125 | 40126 | `Container6.Id` | R | — |  |
| 126 | 40127 | `Container6.Status` | R | code |  |
| 127 | 40128 | `Container6.FillMl` | R | ml × 10 |  |
| 128 | 40129 | `Container6.TargetMl` | R | ml × 10 |  |
| 130 | 40131 | `Container7.Id` | R | — |  |
| 131 | 40132 | `Container7.Status` | R | code |  |
| 132 | 40133 | `Container7.FillMl` | R | ml × 10 |  |
| 133 | 40134 | `Container7.TargetMl` | R | ml × 10 |  |
| 135 | 40136 | `Container8.Id` | R | — |  |
| 136 | 40137 | `Container8.Status` | R | code |  |
| 137 | 40138 | `Container8.FillMl` | R | ml × 10 |  |
| 138 | 40139 | `Container8.TargetMl` | R | ml × 10 |  |

### Holding registers — event ring (200–232)

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 200 | 40201 | `Events.LastSeq` | R | count | Sequence number of the newest event (wraps; 0 = none). |
| 201 | 40202 | `Event1.Seq` | R | count | Entries are newest first; Event1 is the newest. |
| 202 | 40203 | `Event1.Code` | R | EventCode | See the event code table. |
| 203 | 40204 | `Event1.Arg1` | R | — |  |
| 204 | 40205 | `Event1.Arg2` | R | — |  |
| 205 | 40206 | `Event2.Seq` | R | count |  |
| 206 | 40207 | `Event2.Code` | R | EventCode |  |
| 207 | 40208 | `Event2.Arg1` | R | — |  |
| 208 | 40209 | `Event2.Arg2` | R | — |  |
| 209 | 40210 | `Event3.Seq` | R | count |  |
| 210 | 40211 | `Event3.Code` | R | EventCode |  |
| 211 | 40212 | `Event3.Arg1` | R | — |  |
| 212 | 40213 | `Event3.Arg2` | R | — |  |
| 213 | 40214 | `Event4.Seq` | R | count |  |
| 214 | 40215 | `Event4.Code` | R | EventCode |  |
| 215 | 40216 | `Event4.Arg1` | R | — |  |
| 216 | 40217 | `Event4.Arg2` | R | — |  |
| 217 | 40218 | `Event5.Seq` | R | count |  |
| 218 | 40219 | `Event5.Code` | R | EventCode |  |
| 219 | 40220 | `Event5.Arg1` | R | — |  |
| 220 | 40221 | `Event5.Arg2` | R | — |  |
| 221 | 40222 | `Event6.Seq` | R | count |  |
| 222 | 40223 | `Event6.Code` | R | EventCode |  |
| 223 | 40224 | `Event6.Arg1` | R | — |  |
| 224 | 40225 | `Event6.Arg2` | R | — |  |
| 225 | 40226 | `Event7.Seq` | R | count |  |
| 226 | 40227 | `Event7.Code` | R | EventCode |  |
| 227 | 40228 | `Event7.Arg1` | R | — |  |
| 228 | 40229 | `Event7.Arg2` | R | — |  |
| 229 | 40230 | `Event8.Seq` | R | count |  |
| 230 | 40231 | `Event8.Code` | R | EventCode |  |
| 231 | 40232 | `Event8.Arg1` | R | — |  |
| 232 | 40233 | `Event8.Arg2` | R | — |  |

### Holding registers — scan mailbox (300–338)

The PLC holds a container at SCAN and writes its id to `Scan.Request`. The scanner node triggers one read, writes `Scan.Status`, `Scan.Length` and the raw text, then writes the same id to `Scan.Done` last. The PLC validates the text itself, publishes `Scan.ParseResult`, clears `Scan.Request` and releases the container. A request is new while `Request ≠ 0` and `Request ≠ Done`.

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 300 | 40301 | `Scan.Request` | R | id | Container id held at SCAN waiting for a read, 0 = none. A new non-zero value tells the scanner node to trigger one read. |
| 301 | 40302 | `Scan.Done` | RW | id | Scanner node writes the container id after Status, Length and Text (always last). The PLC acts when Done = Request. |
| 302 | 40303 | `Scan.Status` | RW | code | 0 OK, 1 NO_READ (nothing within the read timeout), 2 TOO_LONG (text truncated). |
| 303 | 40304 | `Scan.Length` | RW | chars | Characters in Scan.Text (0..64). |
| 304 | 40305 | `Scan.Text1` | RW | 2 × ASCII | Raw barcode text exactly as read, 2 characters per register, first character in the high byte, unused bytes 0. The node does not interpret it. |
| 305 | 40306 | `Scan.Text2` | RW | 2 × ASCII |  |
| 306 | 40307 | `Scan.Text3` | RW | 2 × ASCII |  |
| 307 | 40308 | `Scan.Text4` | RW | 2 × ASCII |  |
| 308 | 40309 | `Scan.Text5` | RW | 2 × ASCII |  |
| 309 | 40310 | `Scan.Text6` | RW | 2 × ASCII |  |
| 310 | 40311 | `Scan.Text7` | RW | 2 × ASCII |  |
| 311 | 40312 | `Scan.Text8` | RW | 2 × ASCII |  |
| 312 | 40313 | `Scan.Text9` | RW | 2 × ASCII |  |
| 313 | 40314 | `Scan.Text10` | RW | 2 × ASCII |  |
| 314 | 40315 | `Scan.Text11` | RW | 2 × ASCII |  |
| 315 | 40316 | `Scan.Text12` | RW | 2 × ASCII |  |
| 316 | 40317 | `Scan.Text13` | RW | 2 × ASCII |  |
| 317 | 40318 | `Scan.Text14` | RW | 2 × ASCII |  |
| 318 | 40319 | `Scan.Text15` | RW | 2 × ASCII |  |
| 319 | 40320 | `Scan.Text16` | RW | 2 × ASCII |  |
| 320 | 40321 | `Scan.Text17` | RW | 2 × ASCII |  |
| 321 | 40322 | `Scan.Text18` | RW | 2 × ASCII |  |
| 322 | 40323 | `Scan.Text19` | RW | 2 × ASCII |  |
| 323 | 40324 | `Scan.Text20` | RW | 2 × ASCII |  |
| 324 | 40325 | `Scan.Text21` | RW | 2 × ASCII |  |
| 325 | 40326 | `Scan.Text22` | RW | 2 × ASCII |  |
| 326 | 40327 | `Scan.Text23` | RW | 2 × ASCII |  |
| 327 | 40328 | `Scan.Text24` | RW | 2 × ASCII |  |
| 328 | 40329 | `Scan.Text25` | RW | 2 × ASCII |  |
| 329 | 40330 | `Scan.Text26` | RW | 2 × ASCII |  |
| 330 | 40331 | `Scan.Text27` | RW | 2 × ASCII |  |
| 331 | 40332 | `Scan.Text28` | RW | 2 × ASCII |  |
| 332 | 40333 | `Scan.Text29` | RW | 2 × ASCII |  |
| 333 | 40334 | `Scan.Text30` | RW | 2 × ASCII |  |
| 334 | 40335 | `Scan.Text31` | RW | 2 × ASCII |  |
| 335 | 40336 | `Scan.Text32` | RW | 2 × ASCII |  |
| 336 | 40337 | `Scan.ParseResult` | R | code | PLC's validation of the text: 0 OK, 1 BAD_HEADER, 2 BAD_TOTAL, 3 TANK_COUNT_MISMATCH, 4 NEGATIVE_VOLUME, 5 VOLUME_SUM_MISMATCH, 6 MALFORMED, 7 NO_READ. Non-zero → the container rides through unfilled and the reject diverter rejects it. |
| 337 | 40338 | `Scan.ResultId` | R | id | Container id that Scan.ParseResult and Scan.TotalMl belong to. |
| 338 | 40339 | `Scan.TotalMl` | R | ml | Recipe total the PLC decoded (0 when rejected). |

### Holding registers — field node inputs (400–419)

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 400 | 40401 | `Field.Tank1LevelMl` | RW | ml × 10 | Written by the ESP32 tank-level node; PLC validates range and heartbeat before using it. |
| 401 | 40402 | `Field.Tank2LevelMl` | RW | ml × 10 |  |
| 410 | 40411 | `Field.TankNodeHeartbeat` | RW | count | ESP32 tank node increments ≥ 1 Hz. |
| 411 | 40412 | `Field.ScannerNodeHeartbeat` | RW | count | ESP32 scanner node (labeling + barcode scanner) increments ≥ 1 Hz. |
| 412 | 40413 | `Field.StationNodeHeartbeat` | RW | count | ESP32 station node (robotic arm + sort sensor) increments ≥ 1 Hz. |

### Holding registers — microcontroller stations (420–432)

The PLC decides; the ESP32 nodes execute and report. Label and sort use the same request/done handshake as the scan mailbox. The robotic arm takes one command at a time: the PLC writes `ArmCmd`, then a new `ArmCmdSeq`; the station node runs it and writes `ArmResult`, then `ArmDoneSeq` = `ArmCmdSeq`. Nodes move actuators only while `Station.RunPermit` = 1 and `Sys.PlcHeartbeat` keeps changing. A station that does not report within `stationNodeTimeoutSec` jams its container; node fault bits, a lost heartbeat and arm failures latch a fault (`Sys.FaultCode`) and stop the line.

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 420 | 40421 | `Station.RunPermit` | R | 0/1 | 1 = line running with the safety circuit closed. ESP32 nodes must stop their actuators when 0 or when Sys.PlcHeartbeat stops changing for 1 s. Not a safety function: actuator power still goes through the safety relay. |
| 421 | 40422 | `Station.LabelRequest` | R | id | Container id held at LABEL waiting for its label, 0 = none. |
| 422 | 40423 | `Station.LabelDone` | RW | id | Scanner node writes the container id once the label is applied. |
| 423 | 40424 | `Station.ArmCmd` | R | code | Robotic arm command: 0 none, 1 HOME, 2 PICK_LID (lift the top lid from the magazine), 3 PLACE_LID (place the held lid on the container at CAP, release, return HOME). The lid-press cylinder seats the lid. Written before ArmCmdSeq. |
| 424 | 40425 | `Station.ArmCmdSeq` | R | count | PLC increments (1..65535, skips 0) to issue ArmCmd. The station node runs each sequence number once. |
| 425 | 40426 | `Station.ArmDoneSeq` | RW | count | Station node copies ArmCmdSeq here when the command has finished, after writing ArmResult. |
| 426 | 40427 | `Station.ArmResult` | RW | code | 1 OK, 2 NO_LID (gripper closed on nothing), 3 LID_LOST, 4 SERVO_ERROR, 5 ABORTED (RunPermit dropped mid-move), 6 REFUSED (not homed / unknown command). The PLC decides retries and faults. |
| 427 | 40428 | `Station.ArmStatus` | RW | bits | bit0 HOMED, bit1 BUSY, bit2 LID_HELD. Kept current by the station node. |
| 428 | 40429 | `Station.SortRequest` | R | id | Container id at the sort sensor (QC) waiting for a height reading, 0 = none. |
| 429 | 40430 | `Station.SortDone` | RW | id | Station node writes the container id after SortHeightMm. |
| 430 | 40431 | `Station.SortHeightMm` | RW | mm | Measured bottle height, 0 = no valid reading. The PLC classifies the bottle type (config.sort) and rejects a mismatch with the recipe (BOTTLE_TYPE_MISMATCH). |
| 431 | 40432 | `Station.ScannerNodeFaults` | RW | bits | Written only by the scanner node: bit0 labeler, bit1 scanner module not answering. Any bit → the PLC latches a fault and stops the line. |
| 432 | 40433 | `Station.StationNodeFaults` | RW | bits | Written only by the station node: bit0 arm servo bus, bit1 sort sensor. Same handling. |

### Holding registers — simulation inputs (450–451)

Honoured only while `LineState.SIMULATION` = 1 (virtual PLC, or a PLC in SimInputs mode with outputs unpowered).

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 450 | 40451 | `Sim.PhysicalEStopMask` | RW | bits | SIMULATION ONLY: drives the physical E-Stop inputs. Ignored unless LineState.SIMULATION = 1. A physical PLC must never act on it with real outputs powered. |
| 451 | 40452 | `Sim.LocalMode` | RW | 0/1 | SIMULATION ONLY: Local/Remote key switch (1 = LOCAL). |

### Coils (0–15)

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 0 | 1 | `Cmd.DigitalEStop` | RW | pulse | Digital E-Stop. PLC latches DIGITAL_ESTOP and de-energizes O_Safety_RemoteEStopOK, which opens the hardwired safety circuit. Always accepted, any mode. |
| 1 | 2 | `Cmd.ReleaseEStop` | RW | pulse | Release the digital E-Stop latch. Does not reset or start the line. |
| 2 | 3 | `Cmd.Jog` | RW | pulse | Jog the belt one step. Remote mode, line stopped, safety circuit reset. |
| 3 | 4 | `Cmd.FirePusher` | RW | pulse | Fire the reject diverter on the container at the sort sensor or reject diverter. Remote mode, no E-Stop. |
| 4 | 5 | `Cmd.Start` | RW | pulse | Start the line. Remote mode, safety circuit reset, no E-Stop. |
| 5 | 6 | `Cmd.Stop` | RW | pulse | Controlled stop. Always accepted, any mode. |
| 6 | 7 | `Cmd.Reset` | RW | pulse | Safety reset from the HMI. Only if REMOTE_RESET_ALLOWED, Remote mode, and no E-Stop active; otherwise refused (event COMMAND_REFUSED). |
| 8 | 9 | `Sim.LocalStart` | RW | pulse | SIMULATION ONLY: local panel START push-button. |
| 9 | 10 | `Sim.LocalStop` | RW | pulse | SIMULATION ONLY: local panel STOP push-button. |
| 10 | 11 | `Sim.LocalReset` | RW | pulse | SIMULATION ONLY: local panel RESET push-button. |
| 11 | 12 | `Sim.LocalJog` | RW | pulse | SIMULATION ONLY: local panel JOG push-button. |

### Event codes

| Code | Name | Severity |
| ---: | --- | --- |
| 1 | `BARCODE_QUEUED` | info |
| 2 | `CONTAINER_ENTERED` | info |
| 3 | `BARCODE_REJECTED` | warn |
| 4 | `CONTAINER_ACCEPTED` | success |
| 5 | `CONTAINER_REJECTED` | error |
| 6 | `CONTAINER_JAMMED` | error |
| 7 | `DISPENSE_SKIPPED` | warn |
| 8 | `TANK_LOW` | warn |
| 9 | `TANK_REFILLED` | success |
| 10 | `ESTOP` | error |
| 11 | `ESTOP_CLEARED` | success |
| 12 | `JOG` | info |
| 13 | `JOG_IGNORED` | warn |
| 14 | `PUSHER_FIRED` | warn |
| 15 | `PUSHER_NO_TARGET` | warn |
| 16 | `TANK_ENABLED` | warn |
| 17 | `TANK_DISABLED` | warn |
| 18 | `TANK_CHANGE_REFUSED` | warn |
| 19 | `STALE_BARCODES_HELD` | warn |
| 20 | `SAFETY_CIRCUIT_OPEN` | error |
| 21 | `SAFETY_CIRCUIT_OK` | success |
| 22 | `FAULT` | error |
| 23 | `DIGITAL_ESTOP` | error |
| 24 | `DIGITAL_ESTOP_RELEASED` | warn |
| 25 | `PHYSICAL_ESTOP_PRESSED` | error |
| 26 | `PHYSICAL_ESTOP_RELEASED` | warn |
| 27 | `SAFETY_RESET` | success |
| 28 | `LINE_STARTED` | success |
| 29 | `LINE_STOPPED` | warn |
| 30 | `CONTROL_MODE_CHANGED` | info |
| 31 | `COMMAND_REFUSED` | warn |
| 32 | `BARCODE_READ` | info |
| 33 | `FAULT_CLEARED` | success |

Argument meanings are documented on each code in `twin/src/events.ts`.

### Fault codes (`FAULT` arg1, `Sys.FaultCode`)

| Code | Name |
| ---: | --- |
| 1 | `LABELER` |
| 2 | `SCANNER` |
| 3 | `ARM_SERVO` |
| 4 | `ARM_NO_LID` |
| 5 | `ARM_LID_LOST` |
| 6 | `SORT_SENSOR` |
| 7 | `SCANNER_NODE_OFFLINE` |
| 8 | `STATION_NODE_OFFLINE` |

### Reject reasons (`CONTAINER_REJECTED` arg2)

| Code | Name |
| ---: | --- |
| 1 | `BAD_BARCODE` |
| 2 | `FILL_OUT_OF_TOLERANCE` |
| 3 | `MANUAL_PUSHER` |
| 4 | `WAIT_TIMEOUT` |
| 5 | `SERVICE_TIMEOUT` |
| 6 | `BOTTLE_TYPE_MISMATCH` |
| 7 | `STATION_FAULT` |

### Tank change refusals (`TANK_CHANGE_REFUSED` arg1)

| Code | Name |
| ---: | --- |
| 1 | `MAX_TANKS_REACHED` |
| 2 | `NO_FREE_SLOT` |
| 3 | `TANK_NOT_FOUND` |
| 4 | `LAST_TANK` |

### Refused commands (`COMMAND_REFUSED` arg1 = command, arg2 = reason)

| Code | Name |
| ---: | --- |
| 1 | `START` |
| 2 | `STOP` |
| 3 | `RESET` |
| 4 | `JOG` |
| 5 | `FIRE_PUSHER` |
| 6 | `TANK_CHANGE` |
| 7 | `RELEASE_ESTOP` |
| 8 | `DIGITAL_ESTOP` |
| 9 | `MODE_CHANGE` |

| Code | Name |
| ---: | --- |
| 1 | `LOCAL_MODE` |
| 2 | `REMOTE_MODE` |
| 3 | `ESTOP_ACTIVE` |
| 4 | `RESET_REQUIRED` |
| 5 | `LINE_RUNNING` |
| 6 | `REMOTE_RESET_NOT_ALLOWED` |
| 7 | `ESTOP_STILL_PRESSED` |
| 8 | `NOT_ACTIVE` |
| 9 | `FAULT_ACTIVE` |

<!-- END GENERATED: tag-map -->

## 5. Handshakes

**Operator command (bridge → PLC)**
1. The bridge checks the command against `Sys.LineState` using the shared rules. If it's refused (e.g. LOCAL mode), the operator gets the reason immediately and nothing is written.
2. The bridge writes coil = 1 (FC05).
3. On the rising edge, the PLC re-checks the command. It acts, or records `COMMAND_REFUSED`, and resets the coil to 0.
4. The result shows up in `Sys.LineState` and the event ring on the next poll.

**Digital E-Stop (bridge → PLC → hardware)**
1. The bridge writes `Cmd.DigitalEStop` = 1. This is never pre-refused.
2. The PLC latches `DIGITAL_ESTOP`, de-energizes `O_Safety_RemoteEStopOK`, drops the run command and `Station.RunPermit`, and records `DIGITAL_ESTOP` (23).
3. The interposing relay opens both E-Stop channels, and the safety relay removes actuator power. `I_Safety_OK` goes to 0, and the PLC publishes `SAFETY_OK` = 0 and `ESTOP_ACTIVE` = 1.
4. Recovery: `Cmd.ReleaseEStop` clears the latch and re-energizes the output. The PLC reports `RESET_REQUIRED`. RESET at the panel (or `Cmd.Reset` if remote reset is allowed), then START.

**Physical E-Stop (hardware → PLC → bridge)**
1. The button (panel, line entry or line exit) opens the safety circuit directly (hardware stop).
2. Its monitoring contact sets its bit in `Sys.PhysicalEStopMask`. The PLC drops the run command and `Station.RunPermit`, and records `PHYSICAL_ESTOP_PRESSED` (25, arg1 = button index).
3. The HMI shows "EMERGENCY STOP — Physical E-Stop pressed at *location*" (e.g. "Line entry") and disables all operational commands.
4. Releasing the button records `PHYSICAL_ESTOP_RELEASED` (26) and sets `RESET_REQUIRED`.

**Request/done station: label and sort (PLC ↔ ESP32 node)**
1. A container arrives at LABEL (or at the sort sensor, QC) and is held. The PLC writes its id to `Station.LabelRequest` (or `Station.SortRequest`).
2. A request is new while `Request ≠ 0` and `Request ≠ Done`; neither side stores sequence numbers. The node runs the station (apply the label, or measure the height), moving actuators only while `Station.RunPermit` = 1 and the PLC heartbeat is changing.
3. When finished, the node writes its results (`Station.SortHeightMm` for sort), then the same id to `Station.LabelDone` (or `Station.SortDone`), always last.
4. The PLC sees `Done = Request`, clears `Request` to 0 and releases the container. If `Done` doesn't match within `stationNodeTimeoutSec` (15 s, running time only), the container is JAMMED. A node fault bit latches a station fault (below).

**Sort sensor (ESP32 #2 → PLC decision)**
1. The station node's VL53L1X measures the bottle height at QC and reports it in `Station.SortHeightMm` (0 = no valid reading). The node doesn't classify it.
2. The PLC classifies the height against the lane heights in `config.sort` (lane A 120 mm, lane B 180 mm by default, ±15 mm) and compares the bottle type with the one the recipe calls for (total ≤ `sort.smallBottleMaxMl` → lane A). A mismatch, or no valid reading, rejects the container at the reject diverter with `BOTTLE_TYPE_MISMATCH`; a match sets `O_SortDiverter_LaneB` for lane B bottles when they reach SORT.

**Robotic arm (PLC ↔ ESP32 #2)**
1. The PLC writes `Station.ArmCmd` (1 HOME, 2 PICK_LID, 3 PLACE_LID), then a new `Station.ArmCmdSeq` (1..65535, skipping 0). It issues one command at a time.
2. The station node runs that command once, only while `Station.RunPermit` = 1 and the PLC heartbeat is changing, then writes `Station.ArmResult` and, last, `Station.ArmDoneSeq` = `ArmCmdSeq`. It keeps `Station.ArmStatus` (bit0 HOMED, bit1 BUSY, bit2 LID_HELD) current.
3. The PLC decides the next command: not homed → `HOME`; homed with no lid held → `PICK_LID` (a pre-pick while the belt moves); lid held and a container held at CAP → `PLACE_LID` (place the lid, press it down to seat it, release, return HOME). After `PLACE_LID` returns OK, the PLC releases the container.
4. Results: `NO_LID` is retried up to 3 times, then latches `ARM_NO_LID`. `LID_LOST` latches `ARM_LID_LOST` and `SERVO_ERROR` latches `ARM_SERVO`; the container at CAP is rejected with `STATION_FAULT`. `ABORTED` (the permit dropped mid-move) and `REFUSED` make the PLC re-home the arm first; if the lid was already released during an aborted `PLACE_LID`, that container is rejected, because the PLC can't tell whether its lid is seated.

**Station faults (PLC)**
1. The PLC latches a fault when a node sets a bit in `Station.ScannerNodeFaults` (bit0 labeler → 1, bit1 scanner → 2) or `Station.StationNodeFaults` (bit0 arm servo bus, untaught poses or teach mode → 3, bit1 sort sensor → 6), when the arm reports a failure (codes 3, 4, 5, see above), or when a node's heartbeat doesn't change for 3 s (7 scanner node offline, 8 station node offline).
2. It publishes the first latched code in `Sys.FaultCode`, sets `LineState` bit3 FAULT, records `FAULT` (22, arg1 = FaultCode), stops the line (`LINE_STOPPED` with source 3, "station fault") and drops `Station.RunPermit`.
3. While a fault is latched, START is refused (`COMMAND_REFUSED` reason 9, `FAULT_ACTIVE`).
4. RESET clears the faults (`FAULT_CLEARED`, 33) only once the cause is gone; a cause that is still present latches again on the next scan. Faults are not safety functions: the E-Stops and the safety relay remain the safety function.

**Tank enable (bridge → PLC)**
1. The bridge reads `Sys.TankEnableMask`, sets or clears one bit, and writes it back (FC06).
2. The PLC validates the new mask. It refuses 0 and records `TANK_CHANGE_REFUSED`.
3. The PLC applies the mask and republishes the effective mask.

**Scan mailbox (PLC ↔ ESP32 scanner node)**
1. A container is held at SCAN. The PLC writes its id to `Scan.Request`.
2. The scanner node sees a new request (`Scan.Request ≠ 0` and `≠ Scan.Done`) and triggers one read of the barcode scanner.
3. It writes `Scan.Status` (0 OK, 1 NO_READ, 2 TOO_LONG), `Scan.Length` and the raw text in `Scan.Text1..32` (2 ASCII characters per register, first character in the high byte, up to 64 characters), in one FC16 write starting at 302. Then it writes `Scan.Done` = the request id, last.
4. The PLC sees `Scan.Done = Scan.Request` and validates the text itself (PT1 format, tank count, volume sum). It publishes `Scan.ParseResult`, `Scan.ResultId` and `Scan.TotalMl`, records `BARCODE_READ` (32) or `BARCODE_REJECTED` (3), clears `Scan.Request` and releases the container. A rejected barcode rides through unfilled to the reject diverter. The node never interprets the barcode.

**Heartbeats**
- `Sys.PlcHeartbeat`: the PLC increments it every 100 ms. The bridge marks the PLC offline if it doesn't change for 3 s; the ESP32 nodes stop their actuators if it doesn't change for 1 s.
- `Sys.HmiHeartbeat`: the bridge increments it on every poll. The PLC clears `HMI_LINK_OK` if it doesn't change for 3 s (alarm only).
- `Field.*NodeHeartbeat`: the ESP32 nodes increment these at 1 Hz or faster. If a node's heartbeat stops for 3 s, the PLC treats the node as offline, ignores its data and latches `SCANNER_NODE_OFFLINE` (7) or `STATION_NODE_OFFLINE` (8), which stops the line. Over Wi-Fi, expect occasional drops; a fault stops the line, it never energizes anything.

**Event ring (PLC → bridge)**
- When the PLC records an event, it shifts entries 1..7 to 2..8, writes the new one as Event1 with `Seq = LastSeq + 1` (skipping 0 on wrap), then updates `Events.LastSeq`.
- The bridge de-duplicates by sequence number, so up to 8 events between polls are never lost.
