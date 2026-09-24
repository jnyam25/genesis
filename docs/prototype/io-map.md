# IO map

Two layers:

1. **Field IO**: the physical sensors and actuators, and which controller each one is wired to (§1–§3). The split follows the team's bill of materials ([bom.md](bom.md)): the team's **Allen-Bradley Micro850 PLC** supervises the line, and two **ESP32** station nodes run the labeling, scanning, capping, pressing and sort-sensing stations.
2. **Register map**: the data the PLC exchanges with the monitoring PC (bridge + web HMI, FUXA SCADA) and the ESP32 nodes over Modbus TCP (§4). This section is **generated from [`twin/src/plc/tag-map.ts`](../../twin/src/plc/tag-map.ts)**; regenerate it with `npm run tag-map` after changing the map.

The line layout it assumes (from [`twin/src/config.ts`](../../twin/src/config.ts)):

```
 E-Stop ENTRY                                                                                   E-Stop EXIT
 load ─▶[LABEL]─▶[SCAN]─▶[BAY-1]─▶[BAY-2]─▶[BAY-3]─▶ … ─▶[CAP]─▶[PRESS]─▶[QC]─▶[GATE]─▶[SORT]─▶ lane A (small)
                                                                     sort    │ reject      └──▶ lane B (large)
                                                                     sensor  ▼ diverter
                                                                          reject lane
```

- **One-way belt, one fill bay per tank.** A container passes each station once, in belt order. See "Belt order" in [../engine-design.md](../engine-design.md#belt-order).
- **Holding a container at a station.** The software assumes every station except SORT can hold a container in place (a stopper, or stopping the belt on a single-bottle line) and has a presence sensor. The BOM does not budget stoppers yet; see the open decision in [bom.md](bom.md#3-gaps-between-the-bom-and-the-software).
- **No scan diverter.** A container whose barcode fails is not served anywhere; it rides through to the reject diverter.
- **Tank slots** `T1..T8` are fixed. Slot k always has id `Tk`, bay `BAY-k`, and register block `Tank<k>.*`.

### Who controls what

| Component | Signal | Type | Controller | Link |
| --- | --- | --- | --- | --- |
| E-Stop (line entry), E-Stop (line exit), E-Stop (panel) | Emergency stop | Safety contacts → safety relay; NC monitoring contact → DI | Safety relay; PLC monitors | Hardwired |
| HMI touch panel (budget panel or C-more Micro; optional) | Recipe select, start/stop, status | Modbus TCP or serial Modbus RTU | PLC | Wired |
| Conveyor motor | Run/stop, speed | DO + AO (or PWM) | PLC | Wired |
| Tank 1 / 2 / 3 valves | Open/close + angle | DO + AO | PLC | Wired |
| Reject diverter (slide) | Actuate reject | DO | PLC | Wired |
| Sort diverter (2-path split) | Path select | DO | PLC | Wired |
| Presence sensors | Bottle at station | DI | PLC | Wired |
| Labeling station | Apply-label trigger | GPIO → driver | ESP32 #1 (scanner node) | Wired |
| Barcode scanner | Read label ID | UART | ESP32 #1 (scanner node) | Wired |
| Robotic arm (lid placement) | Multi-axis servo sequence | Servo bus / arm controller | ESP32 #2 (station node) | Wired to driver |
| Lid press | Press actuate | GPIO → relay/MOSFET | ESP32 #2 (station node) | Wired |
| Sort sensor | Re-confirm bottle type | GPIO / UART | ESP32 #2 (station node) | Wired |
| PLC ↔ ESP32 nodes | Recipe data, station handshake, heartbeats | Modbus TCP (`Recipe.*`, `Station.*`, `Field.*`) | Supervisor link | Wireless (dedicated AP) |
| PLC ↔ monitoring PC | Bridge + web HMI, logging, FUXA SCADA | Modbus TCP | Supervisor link | Wired Ethernet |

## 1. Field inputs (PLC)

Tag names follow `I_<Area>_<Device>_<Signal>`. Counts are for the default 3-tank line; the notes say what changes with N tanks.

| PLC tag | Device | Type | Signal | Notes |
| --- | --- | --- | --- | --- |
| `I_Safety_OK` | Safety relay auxiliary (NO) contact | DI 24 V | 1 = safety circuit closed and reset | **Monitoring only** ([safety.md](safety.md)) → `LineState.SAFETY_OK` |
| `I_EStop_Panel_Mon` | Monitoring contact (NC) of the E-Stop on the local control panel | DI | **0 = pressed** (NC opens) | → `Sys.PhysicalEStopMask` bit0, `LineState.PHYSICAL_ESTOP`. The button's safety contacts go to the safety relay, not the PLC |
| `I_EStop_Entry_Mon` | Monitoring contact (NC) of the E-Stop at the **line entry** (labeling station, where bottles are loaded) | DI | 0 = pressed | → mask bit1 |
| `I_EStop_Exit_Mon` | Monitoring contact (NC) of the E-Stop at the **line exit** (sort diverter / output lanes) | DI | 0 = pressed | → mask bit2. One input per button in `config.safety.eStopButtons` |
| `I_Safety_RemoteRelay_Fb` | Force-guided NC feedback of the remote E-Stop interposing relay | DI | 1 = relay de-energized | Welded-contact check: must be 1 while `O_Safety_RemoteEStopOK` = 0 |
| `I_Panel_LocalMode` | LOCAL/REMOTE key selector | DI | 1 = LOCAL | → `LineState.LOCAL_MODE`. Changing position stops the line |
| `I_Panel_Stop_PB` | STOP push-button (red) | DI (**NC**) | **0 = pressed** | Controlled stop, **any mode**; a broken wire stops the line. The touch panel's STOP is an extra, not a replacement |
| `I_Panel_Reset_PB` | RESET push-button (blue, illuminated) | DI (NO) | 1 = pressed | Safety reset, any mode. Also wired to the safety relay reset input, so it must be a real button |
| START / JOG | Touch-panel buttons (or hardwired NO push-buttons) | Panel bit (or DI) | 1 = pressed | LOCAL mode only. JOG is hold-to-run |
| `I_Label_Present` | Presence sensor at LABEL | DI (PNP) | 1 = container present | First station; admission waits for it to clear |
| `I_Scan_Present` | Presence sensor at SCAN | DI | 1 = present | |
| `I_Bay<k>_Present` | Presence sensor at BAY-k | DI | 1 = present | One per tank (k = 1..N) |
| `I_Cap_Present` | Presence sensor at CAP | DI | 1 = present | |
| `I_Press_Present` | Presence sensor at PRESS | DI | 1 = present | |
| `I_QC_Present` | Presence at the sort sensor (QC) | DI | 1 = present | Can be the sort sensor's own "object present" output via ESP32 #2 if it has one |
| `I_Gate_Present` | Presence at the reject diverter | DI | 1 = present | |
| `I_Sort_Present` | Presence at the sort diverter | DI | 1 = present | Optional if the diverter is timed from `I_Gate_Present` |
| `I_LaneA_Full` / `I_LaneB_Full` / `I_Reject_Full` | Sensors at the end of each output lane | DI | 1 = lane full | Recommended: PLC halts admission when full |
| `I_RejectDiverter_Home` / `I_SortDiverter_Home` | Limit or reed switches | DI | 1 = retracted | Recommended: fault if not home within 1 s |
| `I_Belt_Drive_Fault` | Motor driver fault output | DI | 1 = fault | → `LINE_STATE.FAULT`, event `FAULT` |
| `I_Tank<k>_Low` | Low-level float switch, per tank | DI | 1 = low | Recommended: the BOM has no level sensor, so the PLC estimates the level from dispensed volume and this float confirms it (see [bom.md](bom.md#3-gaps-between-the-bom-and-the-software)) |
| `AI_Tank<k>_Level` | Level transmitter (4–20 mA) | AI | 4 mA = empty, 20 mA = capacity | Optional upgrade, or an ESP32 tank node (`Field.Tank<k>LevelMl`); pick one per tank |

## 2. Field outputs (PLC)

| PLC tag | Device | Type | ON means | De-energized state |
| --- | --- | --- | --- | --- |
| `O_Belt_Run` | Conveyor motor driver enable / relay | DO 24 V | Belt runs | Stopped |
| `AO_Belt_SpeedRef` | Motor driver speed input | AO 0–10 V (or PWM) | Speed ∝ `beltSpeedMPerSec` | 0. Omit for a fixed-speed motor |
| `O_Valve_T<k>_Open` | NC shutoff solenoid in series with tank k's proportional valve, and the valve's enable | DO | Tank k may flow | Closed (spring) |
| `AO_Valve_T<k>_Angle` | Proportional (servo-driven) valve position input | AO 0–10 V (or servo positioner) | Opening = `Tank<k>.ValveOpeningPct` while dispensing | 0 % (but a servo valve holds its last position without power, hence the shutoff solenoid) |
| `O_<Station>_Stopper` | Stopper actuator, one per holding station (LABEL, SCAN, BAY-k, CAP, PRESS, QC, GATE) | DO | **Retract** (release container) | Extended, holding (spring return). Only if stoppers are fitted; on a single-bottle line the belt stop does this job |
| `O_RejectDiverter_Extend` | Reject diverter slide (solenoid) | DO | Push to reject lane | Retracted (spring) |
| `O_SortDiverter_LaneB` | Sort diverter gate (solenoid) | DO | Route to lane B | Lane A (spring) |
| `O_Refill_T<k>_Valve` | Normally-closed refill solenoid | DO | Refill flowing | Closed. Not in the BOM: refill is manual unless added |
| `O_Safety_RemoteEStopOK` | Coil of the interposing safety relay (force-guided contacts in series with **both** E-Stop channels) | DO | **Energized = OK.** De-energized when the digital E-Stop is latched, which opens the safety circuit | **De-energized = E-Stop** (fail-safe: PLC off/Program mode opens the circuit) |
| `O_Stack_Green` / `O_Stack_Amber` / `O_Stack_Red` | Stack light (optional) | DO | Running / stopped, reset required or warning / E-Stop, fault | Off |
| `O_Panel_Lamp_Reset` | Blue lamp in the RESET button | DO | Flashing = reset required | Off |
| `O_Buzzer` | Buzzer (optional) | DO | Audible alarm (E-Stop, jam) | Off |

Running, E-Stop and REMOTE indications can live on the touch panel instead of separate lamps; the RESET lamp stays a real lamp because it sits in the button.

The **safety relay** switches power to the conveyor motor driver, the valve shutoff solenoids and valve servos, both diverters, the lid press, the label applicator and the capping arm's servo supply (the last three are driven by the ESP32 nodes). It does **not** switch the PLC, the ESP32 logic supply or the monitoring PC, so the control system stays alive to report which E-Stop was pressed. See [safety.md §1](safety.md#1-emergency-stop-physical-and-digital-working-together), [§2a](safety.md#2a-actuators-driven-by-the-esp32-nodes) and [§4](safety.md#4-hardware-design-rules).

### ESP32 station node IO (not PLC IO)

| Node | Device | Interface | Notes |
| --- | --- | --- | --- |
| ESP32 #1 scanner node | Barcode scanner (Waveshare 1D/2D module) | UART 3.3 V | Parses `PT1` barcodes → `Recipe.*` mailbox |
| ESP32 #1 scanner node | Label applicator (servo or stepper + driver) | GPIO → driver | Runs on `Station.LabelRequest`, reports `Station.LabelDone`. Driver power via the safety relay |
| ESP32 #2 station node | Robotic capping arm (xArm / MaxArm class) | Arm controller serial/bus | Runs on `Station.CapRequest`, reports `Station.CapDone`. Servo power via the safety relay |
| ESP32 #2 station node | Lid press (linear actuator or pneumatic cylinder + solenoid) | GPIO → relay/MOSFET | Runs on `Station.PressRequest`, reports `Station.PressDone`. Spring-return, power via the safety relay |
| ESP32 #2 station node | Sort sensor (bottle type: height/colour/ID) | GPIO or UART | Writes `Station.SortSensorType` + `Station.SortSensorContainer` |

ESP32 GPIO is 3.3 V: never connect 24 V field signals directly ([esp32.md](esp32.md)).

### Safety circuit wiring (overview)

```
 +24V safety ──┬─ E-Stop PANEL (ch1) ─ E-Stop ENTRY (ch1) ─ E-Stop EXIT (ch1) ─ K_REMOTE NO (ch1) ─┬─▶ Safety relay S11/S12 (ch1)
               └─ E-Stop PANEL (ch2) ─ E-Stop ENTRY (ch2) ─ E-Stop EXIT (ch2) ─ K_REMOTE NO (ch2) ─┴─▶ Safety relay S21/S22 (ch2)
 RESET PB ─────────────────────────────────────────────────────────────────────────────────────────▶ Safety relay reset (S33/S34, edge-triggered)
 K_REMOTE NC (feedback) ─┬─ motor driver/contactor feedback NC ────────────────────────────────────▶ Safety relay feedback loop
 Safety relay outputs 13/14, 23/24 ──▶ conveyor driver enable, valve shutoff + servo supply, diverters, press, labeler, arm servo supply
 Safety relay aux 41/42 ──▶ I_Safety_OK
 PLC O_Safety_RemoteEStopOK ──▶ K_REMOTE coil (force-guided interposing safety relay)
 Each E-Stop NC monitoring contact ──▶ I_EStop_<Location>_Mon
```

Terminal names are generic. Follow your safety relay's manual.

## 3. IO count and sizing

For N tanks:

| | Formula | N = 3 | N = 8 |
| --- | --- | ---: | ---: |
| Digital inputs, required | 15 + N (safety OK, 3 E-Stop monitors, relay feedback, key, STOP, RESET, 7 + N presence sensors) | 18 | 23 |
| Digital inputs, recommended extras | 5 + N (3 lane-full, 2 diverter-home, 1 low float per tank) | 8 | 13 |
| Digital outputs, required | 4 + N (belt, reject diverter, sort diverter, remote E-Stop OK, 1 valve shutoff per tank) | 7 | 12 |
| Digital outputs, stoppers (if fitted) | 6 + N | 9 | 14 |
| Digital outputs, indicators (optional) | 5 (stack light ×3, RESET lamp, buzzer) | 5 | 5 |
| Analog outputs | N valve angles (+1 belt speed) | 3–4 | 8–9 |

Size the Micro850's plug-in and expansion modules for the **largest tank count you plan to support**, plus about 20% spare ([micro850-plc.md §1](micro850-plc.md#io-against-the-requirement)). With stoppers fitted, a 3-tank line needs roughly 26 DI, 21 DO and 4 AO.

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
<!-- Generated from twin/src/plc/tag-map.ts (protocol v3) by `npm run tag-map -- --write`. Do not edit by hand. -->

### Holding registers — system (0–19)

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 0 | 40001 | `Sys.ProtocolVersion` | R | — | Register map version (currently 3). Bridge refuses to run on a mismatch. |
| 1 | 40002 | `Sys.PlcHeartbeat` | R | count | Incremented by the PLC at ≥ 1 Hz. Bridge marks the PLC offline if it stops changing for 3 s. |
| 2 | 40003 | `Sys.LineState` | R | bits | bit0 RUNNING, bit1 ESTOP_ACTIVE, bit2 SAFETY_OK (safety relay closed), bit3 FAULT, bit4 HMI_LINK_OK, bit5 DIGITAL_ESTOP, bit6 PHYSICAL_ESTOP, bit7 RESET_REQUIRED, bit8 LOCAL_MODE, bit9 REMOTE_RESET_ALLOWED, bit10 SIMULATION. |
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
| 16 | 40017 | `Sys.PhysicalEStopMask` | R | bits | bit i = physical E-Stop button i pressed, from the safety relay's monitoring contacts (bit0 local control panel, bit1 line entry, bit2 line exit — config.safety.eStopButtons). |
| 17 | 40018 | `Counts.LaneA` | R | count | Accepted containers sorted to lane A (config.sort.lanes[0]) (wraps). |
| 18 | 40019 | `Counts.LaneB` | R | count | Accepted containers sorted to lane B (config.sort.lanes[1]) (wraps). |

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
| 32 | 40033 | `Tank3.LevelMl` | R | ml × 10 |  |
| 33 | 40034 | `Tank3.CapacityMl` | R | ml |  |
| 34 | 40035 | `Tank3.Flags` | R | bits |  |
| 35 | 40036 | `Tank3.RefillThresholdMl` | R | ml |  |
| 36 | 40037 | `Tank3.DispenseRate` | R | ml/s × 10 |  |
| 37 | 40038 | `Tank3.ValveOpeningPct` | R | % |  |
| 38 | 40039 | `Tank4.LevelMl` | R | ml × 10 |  |
| 39 | 40040 | `Tank4.CapacityMl` | R | ml |  |
| 40 | 40041 | `Tank4.Flags` | R | bits |  |
| 41 | 40042 | `Tank4.RefillThresholdMl` | R | ml |  |
| 42 | 40043 | `Tank4.DispenseRate` | R | ml/s × 10 |  |
| 43 | 40044 | `Tank4.ValveOpeningPct` | R | % |  |
| 44 | 40045 | `Tank5.LevelMl` | R | ml × 10 |  |
| 45 | 40046 | `Tank5.CapacityMl` | R | ml |  |
| 46 | 40047 | `Tank5.Flags` | R | bits |  |
| 47 | 40048 | `Tank5.RefillThresholdMl` | R | ml |  |
| 48 | 40049 | `Tank5.DispenseRate` | R | ml/s × 10 |  |
| 49 | 40050 | `Tank5.ValveOpeningPct` | R | % |  |
| 50 | 40051 | `Tank6.LevelMl` | R | ml × 10 |  |
| 51 | 40052 | `Tank6.CapacityMl` | R | ml |  |
| 52 | 40053 | `Tank6.Flags` | R | bits |  |
| 53 | 40054 | `Tank6.RefillThresholdMl` | R | ml |  |
| 54 | 40055 | `Tank6.DispenseRate` | R | ml/s × 10 |  |
| 55 | 40056 | `Tank6.ValveOpeningPct` | R | % |  |
| 56 | 40057 | `Tank7.LevelMl` | R | ml × 10 |  |
| 57 | 40058 | `Tank7.CapacityMl` | R | ml |  |
| 58 | 40059 | `Tank7.Flags` | R | bits |  |
| 59 | 40060 | `Tank7.RefillThresholdMl` | R | ml |  |
| 60 | 40061 | `Tank7.DispenseRate` | R | ml/s × 10 |  |
| 61 | 40062 | `Tank7.ValveOpeningPct` | R | % |  |
| 62 | 40063 | `Tank8.LevelMl` | R | ml × 10 |  |
| 63 | 40064 | `Tank8.CapacityMl` | R | ml |  |
| 64 | 40065 | `Tank8.Flags` | R | bits |  |
| 65 | 40066 | `Tank8.RefillThresholdMl` | R | ml |  |
| 66 | 40067 | `Tank8.DispenseRate` | R | ml/s × 10 |  |
| 67 | 40068 | `Tank8.ValveOpeningPct` | R | % |  |

### Holding registers — container tracking (100–139)

Five registers per slot i = 1..8, base `100 + 5·(i−1)`. Live containers first, then containers that finished in the last ~1.5 s.

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 100 | 40101 | `Container1.Id` | R | — | Container id, 0 = empty slot. |
| 101 | 40102 | `Container1.Status` | R | code | 0 none, 1 scan, 2 scan-rejected, 3 label, 11..18 fill at bay n (10+n), 20 mix, 21 sort sensor / reject diverter, 22 accepted to lane A, 23 rejected, 24 cap, 25 press, 26 sort diverter, 27 accepted to lane B. |
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

### Holding registers — recipe mailbox (300–312)

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 300 | 40301 | `Recipe.Seq` | RW | count | Scanner node increments after writing the fields below (write fields first, SEQ last). |
| 301 | 40302 | `Recipe.ParseResult` | RW | code | 0 OK, 1 BAD_HEADER, 2 BAD_TOTAL, 3 TANK_COUNT_MISMATCH, 4 NEGATIVE_VOLUME, 5 VOLUME_SUM_MISMATCH, 6 MALFORMED. Non-zero → the container rides through unfilled and the reject diverter rejects it. |
| 302 | 40303 | `Recipe.TotalMl` | RW | ml |  |
| 303 | 40304 | `Recipe.Rounds` | RW | count | Interleave rounds override, 0 = line policy. |
| 304 | 40305 | `Recipe.Vol1` | RW | ml | Volume for the k-th enabled tank, in barcode order. |
| 305 | 40306 | `Recipe.Vol2` | RW | ml |  |
| 306 | 40307 | `Recipe.Vol3` | RW | ml |  |
| 307 | 40308 | `Recipe.Vol4` | RW | ml |  |
| 308 | 40309 | `Recipe.Vol5` | RW | ml |  |
| 309 | 40310 | `Recipe.Vol6` | RW | ml |  |
| 310 | 40311 | `Recipe.Vol7` | RW | ml |  |
| 311 | 40312 | `Recipe.Vol8` | RW | ml |  |
| 312 | 40313 | `Recipe.AckSeq` | R | count | PLC copies Recipe.Seq here once queued. Writer waits for AckSeq = Seq before the next recipe. |

### Holding registers — field node inputs (400–419)

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 400 | 40401 | `Field.Tank1LevelMl` | RW | ml × 10 | Written by the ESP32 tank-level node; PLC validates range and heartbeat before using it. |
| 401 | 40402 | `Field.Tank2LevelMl` | RW | ml × 10 |  |
| 402 | 40403 | `Field.Tank3LevelMl` | RW | ml × 10 |  |
| 403 | 40404 | `Field.Tank4LevelMl` | RW | ml × 10 |  |
| 404 | 40405 | `Field.Tank5LevelMl` | RW | ml × 10 |  |
| 405 | 40406 | `Field.Tank6LevelMl` | RW | ml × 10 |  |
| 406 | 40407 | `Field.Tank7LevelMl` | RW | ml × 10 |  |
| 407 | 40408 | `Field.Tank8LevelMl` | RW | ml × 10 |  |
| 410 | 40411 | `Field.TankNodeHeartbeat` | RW | count | ESP32 tank node increments ≥ 1 Hz. |
| 411 | 40412 | `Field.ScannerNodeHeartbeat` | RW | count | ESP32 scanner node (labeling + barcode scanner) increments ≥ 1 Hz. |
| 412 | 40413 | `Field.StationNodeHeartbeat` | RW | count | ESP32 station node (capping arm, lid press, sort sensor) increments ≥ 1 Hz. |

### Holding registers — microcontroller station handshake (420–430)

The PLC holds a container at LABEL, CAP or PRESS and publishes its id in the station's `Request` register. The ESP32 runs the station only while `Station.RunPermit` = 1, then writes the same id to `Done`. The PLC releases the container when `Done` = `Request`, and rejects it with `STATION_FAULT` on a timeout or a fault bit. The virtual PLC publishes the requests and run permit but completes each station on its own timer.

| Address | Modicon | Tag (OPC UA browse name) | Access | Unit | Description |
| ---: | ---: | --- | :---: | --- | --- |
| 420 | 40421 | `Station.RunPermit` | R | 0/1 | 1 = line running with the safety circuit closed. ESP32 nodes must stop their actuators when 0 or when Sys.PlcHeartbeat stops changing for 1 s. Not a safety function: actuator power still goes through the safety relay. |
| 421 | 40422 | `Station.LabelRequest` | R | id | Container id held at LABEL waiting for its label, 0 = none. |
| 422 | 40423 | `Station.LabelDone` | RW | id | Scanner node writes the container id once the label is applied. |
| 423 | 40424 | `Station.CapRequest` | R | id | Container id held at CAP waiting for the arm to place a lid, 0 = none. |
| 424 | 40425 | `Station.CapDone` | RW | id | Station node writes the container id once the lid is placed and the arm is clear. |
| 425 | 40426 | `Station.PressRequest` | R | id | Container id held at PRESS waiting for the lid press, 0 = none. |
| 426 | 40427 | `Station.PressDone` | RW | id | Station node writes the container id once the press has retracted. |
| 427 | 40428 | `Station.SortSensorType` | RW | code | Bottle type the sort sensor read: 0 unknown, 1 = lane A type, 2 = lane B type. PLC rejects on mismatch with the recipe (BOTTLE_TYPE_MISMATCH). |
| 428 | 40429 | `Station.SortSensorContainer` | RW | id | Container id the sort-sensor reading belongs to. |
| 429 | 40430 | `Station.ScannerNodeFaults` | RW | bits | Written only by the scanner node: bit0 labeler, bit1 scanner. Any bit → PLC raises FAULT and rejects the affected container (STATION_FAULT). |
| 430 | 40431 | `Station.StationNodeFaults` | RW | bits | Written only by the station node: bit0 capping arm, bit1 lid press, bit2 sort sensor. Same handling. |

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

Argument meanings are documented on each code in `twin/src/events.ts`.

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

**Microcontroller station (PLC ↔ ESP32 station)**
1. A container arrives at LABEL, CAP or PRESS and is held. The PLC writes its id to `Station.<Label|Cap|Press>Request`.
2. The ESP32 sees a new request id and runs the station (apply label, place lid, press), but only while `Station.RunPermit` = 1 and the PLC heartbeat is changing. If the permit drops mid-motion it parks safely and waits.
3. When finished, the ESP32 writes the same id to `Station.<…>Done`.
4. The PLC sees `Done = Request`, clears `Request` to 0 and releases the container. If `Done` doesn't match within `sensorWaitTimeoutSec` (running time only), or the node's `Station.*NodeFaults` register has the station's bit set, the PLC raises `FAULT` and rejects the container with `STATION_FAULT`.

**Sort sensor (ESP32 #2 → PLC)**
1. While a container is at QC, ESP32 #2 reads the sort sensor and writes `Station.SortSensorType` (1 = lane A type, 2 = lane B type), then `Station.SortSensorContainer` = container id.
2. The PLC compares it with the lane the recipe calls for (total ≤ `sort.smallBottleMaxMl` → lane A). A mismatch rejects the container at the reject diverter with `BOTTLE_TYPE_MISMATCH`; a match sets `O_SortDiverter_LaneB` for lane B bottles when they reach SORT.

**Tank enable (bridge → PLC)**
1. The bridge reads `Sys.TankEnableMask`, sets or clears one bit, and writes it back (FC06).
2. The PLC validates the new mask. It refuses 0 and records `TANK_CHANGE_REFUSED`.
3. The PLC applies the mask and republishes the effective mask.

**Recipe mailbox (ESP32 scanner node → PLC)**
1. Wait until `Recipe.AckSeq == Recipe.Seq`, meaning the previous recipe was consumed.
2. Write `ParseResult, TotalMl, Rounds, Vol1..VolN` in one FC16 write, starting at 301.
3. Write `Recipe.Seq = Seq + 1` (skip 0 on wrap).
4. The PLC queues the container and sets `Recipe.AckSeq = Seq`. If there's no ack within 2 s, the node raises its own fault LED and retries the same Seq; the PLC ignores a Seq it has already acknowledged.

**Heartbeats**
- `Sys.PlcHeartbeat`: the PLC increments it at 1 Hz or faster. The bridge marks the PLC offline if it doesn't change for 3 s; the ESP32 nodes stop their actuators if it doesn't change for 1 s.
- `Sys.HmiHeartbeat`: the bridge increments it on every poll. The PLC clears `HMI_LINK_OK` if it doesn't change for 3 s (alarm only).
- `Field.*NodeHeartbeat`: the ESP32 nodes increment these at 1 Hz or faster. The PLC ignores a node's data, and raises `FAULT`, if its heartbeat stops for 3 s. Over Wi-Fi, expect occasional drops; a fault holds the affected station, it never energizes anything.

**Event ring (PLC → bridge)**
- When the PLC records an event, it shifts entries 1..7 to 2..8, writes the new one as Event1 with `Seq = LastSeq + 1` (skipping 0 on wrap), then updates `Events.LastSeq`.
- The bridge de-duplicates by sequence number, so up to 8 events between polls are never lost.
