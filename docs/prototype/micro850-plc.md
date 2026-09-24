# Allen-Bradley Micro850 PLC program specification

This is the functional specification for the line PLC program on the team's **Allen-Bradley Micro850, catalog number 2080-L50E-48QBB**. The team already owns the controller, so it isn't a purchase line in the [BOM](bom.md). This page isn't a program export: nothing here has been run on the Micro850 yet.

**The reference implementation is the virtual PLC.** For every rule below, [`twin/src/core.ts`](../../twin/src/core.ts), [`twin/src/safety.ts`](../../twin/src/safety.ts) (E-Stop, reset, start/stop, local/remote authority) and [`twin/src/plc/virtual-plc.ts`](../../twin/src/plc/virtual-plc.ts) show the expected behaviour, and `npm test` shows the handshakes working. When in doubt, match the virtual PLC. The register map is vendor-neutral: any PLC with a Modbus TCP server can implement it.

Hardware and software facts below come from Rockwell's Micro830/850/870 user manual (2080-UM002), the Micro800 selection guide (2080-SG001), the CCW Modbus Mapping help and Rockwell knowledgebase articles QA14133, QA20567 and QA23703, checked in September 2026. **Confirm them against the controller's firmware revision, the 48-point installation instructions that came with it and the CCW help before wiring.**

## 1. Controller, software and IO

### Software: no subscription needed

| Tool | Licence | Use |
| --- | --- | --- |
| **Connected Components Workbench (CCW) Standard Edition** | Free download from Rockwell's Product Compatibility and Download Center; needs a free Rockwell account, no activation | Programming (ladder, structured text, function block diagram), Modbus mapping, online monitoring, the demo Micro800 simulator |
| CCW Developer Edition | **Annual subscription** | Adds the full simulator and Archive Manager. **Not needed**; don't buy it |
| FactoryTalk Design Workbench | Licensing not confirmed | Rockwell's newer tool for the L50E controllers. Stick with CCW Standard |

The 2080-L50E is the current Micro850; it replaced the 2080-LC50, which was discontinued in 2023. **An L50E needs CCW 20.01 or later.** Use a CCW version whose project revision matches the controller's firmware (CCW shows the firmware when you connect), and update the firmware from CCW if the project needs a newer one.

### The controller: 2080-L50E-48QBB

From the Micro800 selection guide (2080-SG001):

| Feature | 2080-L50E-48QBB |
| --- | --- |
| Digital inputs | **28** × 12/24 V DC, sink or source |
| Digital outputs | **20** × 24 V DC **sourcing** (transistor): drive 24 V solenoids, stoppers and indicators directly |
| PTO/PWM | 3 channels on the embedded outputs (the installation instructions name the outputs) |
| High-speed counters | 6, on the embedded inputs |
| Embedded analog | **None**: analog outputs come from plug-ins |
| Plug-in slots | **5** (2080-… plug-ins, e.g. analog output 2080-OF2, IO 2080-IQ4OB4) |
| Expansion | Up to 4 **2085-…** modules on the right side, finished with a 2085-ECR end cap |
| Ports | USB (programming only); one 10/100 **Ethernet** port (EtherNet/IP, Modbus TCP client and server, CCW); one non-isolated **RS-232/RS-485 serial** port (Modbus RTU master or slave, CIP serial, ASCII) |
| Power | 24 V DC from a 24 V supply (or the optional 2080-PS120-240VAC) |

There's **no Wi-Fi**. The ESP32 nodes reach the PLC through an access point wired to the control switch ([communication.md §1](communication.md#1-network)).

Before designing the panel, list any plug-in or expansion modules already fitted to the team's controller or in the lab's parts bin.

### IO against the requirement

[io-map.md §3](io-map.md#3-io-count-and-sizing) needs **18 DI / 7 DO / 3–4 AO** for 3 tanks, or about **26 DI / 21 DO / 4 AO** with stoppers, the recommended extra inputs and indicators.

| Need | 2080-L50E-48QBB | What to add |
| --- | --- | --- |
| Digital inputs | 28 embedded: covers the required 18 and the full 26 | Nothing. With everything fitted only 2 are spare; a **2080-IQ4OB4** plug-in (4 DI + 4 sourcing DO) adds headroom |
| Digital outputs | 20 embedded: covers the required 7 plus 9 stoppers, with 4 left for the 5 optional indicators (stack light ×3, RESET lamp, buzzer) | **One short** with every indicator. Drop the optional buzzer (or sound it from the red stack-light output), or use the 2080-IQ4OB4's outputs |
| Analog outputs (valve angles, belt speed) | None embedded | **Two 2080-OF2 plug-ins** (2 channels each, 0–10 V or 0–20 mA, 12-bit, non-isolated) give 4 channels and use 2 of the 5 slots. One 2085-OF4 expansion module (4 channels, isolated) is the alternative |

- **Belt speed without an AO channel.** Drive the motor driver's speed input from one of the PWM outputs if the driver accepts PWM. The valves then need only 3 AO channels, which is still two 2080-OF2s.
- **One-bottle mode** ([bom.md D1](bom.md#6-open-decisions-for-the-team)) drops the 9 stopper outputs, so the embedded outputs cover everything with room to spare.
- **More tanks.** Each extra tank adds 2 inputs, 2 outputs (valve shutoff and stopper) and 1 analog output. The embedded IO runs out at about 4 tanks with stoppers; beyond that add a 2085-IQ16 / 2085-OB16 and a third 2080-OF2 or a 2085-OF4.
- **Distributor prices in September 2026** (they vary a lot, so get a quote): 2080-OF2 about $120–160; 2085-OF4 about $210–350. **Check the lab's parts bin first.**
- DC inputs must match the sensors (PNP sensors → wire the input common for sourcing sensors). The sourcing outputs switch +24 V to the load; return the load to 0 V.

### Modbus TCP connections

The Micro850 supports **16 simultaneous Modbus TCP server connections** (and 16 client connections). That's enough for everything that wants to talk to it:

| Client | Connections |
| --- | ---: |
| Bridge (monitoring PC) | 1 |
| SCADA (FUXA, [scada.md](scada.md#52-connect-to-the-plc)) | 1 |
| ESP32 #1, ESP32 #2 (+ optional tank node) | 2–3 |
| Touch panel on Ethernet (if used) | 1 |
| Modbus test tool while commissioning | 1 |

Every client should still hold **one persistent connection** and close it cleanly. An ESP32 that reconnects without closing its old socket wastes a connection until it times out.

### Local operator panel

The panel talks to PLC variables mapped in the **panel area** of the Modbus mapping (§2), never to register-map addresses. It isn't part of the register map, so the bridge never sees it.

| Option | Link to the Micro850 | Notes |
| --- | --- | --- |
| **No touch panel**: hardwired START/JOG next to STOP/RESET, plus the web HMI | — | Cheapest. The web HMI shows status; the hardwired buttons give local control |
| Budget touch panel | Modbus RTU master on the serial port, or Modbus TCP | Check that its configuration software is a **free** download and that it can be a Modbus master |
| C-more Micro EA3-S3ML | Modbus TCP (built-in Ethernet) or Modbus RTU master on RS-232 | Free programming software. It has no Micro800 driver; use its generic Modbus drivers with the §2 addresses |
| PanelView 800 (2711R) | EtherNet/IP; screens are built in CCW Standard (free) | Native Rockwell panel. Only if the lab has one; new units cost several hundred dollars |

For Modbus RTU, set the Micro850's serial port to **Modbus RTU slave** in CCW (Controller → Serial Port) and match baud rate, parity and node address on the panel.

## 2. Modbus address mapping

The Micro850 has **no fixed Modbus memory**. You map global variables to Modbus addresses in CCW under **Controller → Modbus Mapping**:

- **Enable the server.** In CCW 12 and later projects: Controller → Ethernet → Modbus TCP → **Enabled**. In older projects the server is always on. Port 502.
- **Addresses are 1-based.** CCW uses 6-digit Modicon addresses: `000001` is coil 0 on the wire and `400001` is holding register 0. So register-map holding register N maps to **400001 + N**, and coil N to **000001 + N**. The "Modicon" column in [io-map.md §4](io-map.md#4-register-map-modbus-tcp) is the same thing in 5-digit form (CCW accepts both).
- **Bridge settings.** Keep `PLC_COIL_BASE=0` (the default) and `PLC_UNIT_ID=1`. The bridge and the ESP32 firmware use the register-map addresses unchanged. At commissioning, check with a Modbus tool that holding register 0 reads `3` (`Sys.ProtocolVersion`).
- **Limits.** The mapping table takes at most **200 entries**, but an **array counts as one entry**. The register map has more than 200 addresses, so map it as one array per block:

| Global variable | Type | CCW start address | Register map |
| --- | --- | --- | --- |
| `MB_Cmd` | `ARRAY[0..15] OF BOOL` | `000001` | Coils 0–15 (`Cmd.*`, `Sim.Local*`) |
| `MB_Sys` | `ARRAY[0..19] OF UINT` | `400001` | 0–19 system, counts, OEE |
| `MB_Tank` | `ARRAY[0..47] OF UINT` | `400021` | 20–67 tank slots |
| `MB_Cont` | `ARRAY[0..39] OF UINT` | `400101` | 100–139 container tracking |
| `MB_Event` | `ARRAY[0..32] OF UINT` | `400201` | 200–232 event ring |
| `MB_Recipe` | `ARRAY[0..12] OF UINT` | `400301` | 300–312 recipe mailbox |
| `MB_Field` | `ARRAY[0..19] OF UINT` | `400401` | 400–419 field node inputs |
| `MB_Station` | `ARRAY[0..10] OF UINT` | `400421` | 420–430 station handshake |
| `MB_Sim` | `ARRAY[0..1] OF UINT` | `400451` | 450–451 simulation inputs |
| `MB_Panel` | e.g. `ARRAY[0..31] OF UINT` / `BOOL` | `401001` / `000101` | Touch-panel area (if a panel is used). Outside the register map |

So `Sys.PlcHeartbeat` (register 1) is `MB_Sys[1]`, `Sys.TankEnableMask` (4) is `MB_Sys[4]`, `Station.CapRequest` (423) is `MB_Station[3]` and `Cmd.Stop` (coil 5) is `MB_Cmd[5]`.

**Map every address in each block**, including unused ones such as 13 or 408–409. The bridge and SCADA read whole blocks (0–19, 20–67, 100–139, 200–232), and a read that touches an unmapped address fails or returns zeros depending on the firmware. Whole-block arrays avoid gaps.

**Keep the program's own data out of the map.** Only the `MB_*` arrays are mapped. Give the program named variables (`RunCmd`, `DigitalEStop`, `ContStatus[s]` …), copy the inputs the bridge and ESP32 nodes write out of `MB_*` at the start of the scan (§3, `S00_Inputs`), and copy the published values into `MB_*` at the end (`S07_Publish`). Put the register-map tag name in each copy's comment so the program stays readable.

**Unsigned registers.** Declare the arrays `UINT` (0–65 535), the same type as the register map. Wrap counters, heartbeats and sequence numbers explicitly instead of relying on overflow: `IF HB = 65535 THEN HB := 0; ELSE HB := HB + 1; END_IF;`. `Recipe.Seq`, `Events.LastSeq` and the event `Seq` fields skip 0 on wrap. The map has no 32-bit values, so word order doesn't come up (the Micro850 sends the most significant word first if you add any).

**Bit words.** Build `Sys.LineState` and `Sys.PhysicalEStopMask` from BOOLs, e.g. in structured text `LineState := ANY_TO_UINT(Running) + ANY_TO_UINT(EStopActive) * 2 + ANY_TO_UINT(SafetyOK) * 4 + …`. Bit 15 is never used.

**What the ESP32 nodes write.** Registers 300–311 (recipe mailbox), 400–412 (field levels and heartbeats) and 422, 424, 426–430 (station `Done` ids, sort sensor, fault bits). The program must treat those as inputs and never write them, except that it may clear `Station.*Done` after acting on it.

## 3. Program structure

A Micro850 project runs its programs one after another in each scan, in the order set in CCW's Project Organizer. Each program can be ladder, structured text or function block diagram. Create these programs, in this order:

1. `S00_Inputs`: copy the bridge- and ESP32-written registers out of `MB_*`; debounce presence sensors (20 ms `TON`/`TOF`); build `PhysicalMask` from `I_EStop_<Panel|Entry|Exit>_Mon`; read the low floats; update the tank level estimates (§5).
2. `S01_SafetyMode`: E-Stops, reset, run state, control authority (§6).
3. `S02_Commands`: rising-edge handling of `MB_Cmd[0..15]` ([io-map.md §5](io-map.md#5-handshakes)); tank-enable-mask writes (§7). Reset every command coil (`MB_Cmd[i] := FALSE`) in the scan it is handled.
4. `S03_Admission`: a bottle at LABEL (`I_Label_Present` rising) with a free container slot, the line running, `ActiveContainers < MaxConcurrent`, and lanes not full → create a container record.
5. `S04_Stations`: one state machine per station (§4). Each station is **acquired** before the container upstream is released.
6. `S05_Recipe`: the scanner node's mailbox (§4, SCAN).
7. `S06_Outputs`: map station, tank and belt states onto `O_*` / `AO_*`. **All motion outputs are forced off while `NOT Running`**, except stoppers, which de-energize to extended (holding). `O_Safety_RemoteEStopOK := NOT DigitalEStop`. `Station.RunPermit := Running`.
8. `S07_Publish`, gated by a 100 ms self-resetting `TON`: heartbeat, `Sys.LineState`, counters, OEE, throughput, container table, event ring (§8); then copy everything published into `MB_*`.

**Data layout.** Use arrays indexed by slot rather than one variable per slot:

```text
Container slot s (s = 0..7):  ContId[s], ContStatus[s], ContStation[s], ContLane[s] (0 A / 1 B),
                              ContParseResult[s], ContManualReject[s], ContFillMl_x10[s], ContTargetMl_x10[s],
                              ContStepTimer[s] (RTO instance), ContVolumeMl[s, 1..8], ContTankSlot[s, 1..8]
Tank slot k (k = 1..8):       TankEnabled[k], TankLow[k], TankLevelMl_x10[k], TankCapacityMl[k],
                              TankRateMlPerS_x10[k], TankValveOpeningPct[k]
Event ring:                   MB_Event itself (§8)
```

8 slots are small enough for a `FOR` loop in structured text, or one rung block per slot in ladder.

**Timers.** Use `RTO` (retentive on-delay timer) blocks with a separate reset for every station timer, enabled only while `Running`, so time pauses on a stop or E-Stop and resumes after reset + start. On L50E controllers an `RTO` keeps its time through a power cycle, so **reset every station timer on the first scan** (`_SYSVA_FIRST_SCAN`). If your controller's firmware has no `RTO`, accumulate the elapsed time yourself while `Running`.

## 4. Container sequence (per container)

Station order and codes come from [`config.ts`](../../twin/src/config.ts). This mirrors `TwinCore.progressContainer` in [`core.ts`](../../twin/src/core.ts).

```text
LABEL (station 2, status 3):  hold (I_Label_Present). LabelRequest := id.
                              wait LabelDone = id → LabelRequest := 0, release.
SCAN  (station 1, status 1):  hold. Take the scanner node's recipe from the mailbox (below).
                              ParseResult ≠ 0, no recipe within sensorWaitTimeoutSec, or the
                              volume count ≠ enabled tank count → mark BAD_BARCODE and SKIP
                              every station up to GATE (no scan diverter; the bottle rides through).
BAY-k (station 10+k, status 10+k), for each enabled tank slot k in belt order with Volume > 0:
                              hold (I_Bay<k>_Present). AO_Valve_Tk_Angle := ValveOpeningPct,
                              O_Valve_Tk_Open := 1 for Volume / Rate seconds (RTO).
                              Close; FillMl += delivered; level estimate −= delivered; release.
                              Tank disabled meanwhile → skip, event DISPENSE_SKIPPED.
CAP   (station 23, status 24):  hold. CapRequest := id. wait CapDone = id → CapRequest := 0, release.
PRESS (station 24, status 25):  hold. PressRequest := id. wait PressDone = id → PressRequest := 0, release.
QC    (station 21, status 21):  sort sensor. hold; wait SortSensorContainer = id (timeout → type 0, unknown).
                              Expected type: TotalMl ≤ smallBottleMaxMl → lane A (1), else lane B (2).
GATE  (station 22):  decide, in this order:
                       BAD_BARCODE                                         → reject (reason 1)
                       ManualReject                                        → reject (MANUAL_PUSHER)
                       |Fill − Target| > max(1 ml, Target × (variance + 1 %)) → reject (FILL_OUT_OF_TOLERANCE)
                       SortSensorType ≠ expected (0 = can't tell, or no reading) → reject (BOTTLE_TYPE_MISMATCH)
                       a Station.*NodeFaults bit hit this container's station  → reject (STATION_FAULT)
                     reject → pulse O_RejectDiverter_Extend, wait !I_Gate_Present, status 23 (or 2 for
                              a bad barcode), event CONTAINER_REJECTED.
                     else    → release to SORT.
SORT  (station 25, status 26):  O_SortDiverter_LaneB := (Lane = B) while the container passes.
                              Status 22 (lane A) or 27 (lane B); Counts.LaneA/B += 1;
                              event CONTAINER_ACCEPTED (arg2 = fill × 10).
```

**Analog output scaling.** A 2080-OF2 channel takes a raw integer for its range (see the plug-in's manual for the counts per volt or mA). Scale `ValveOpeningPct` (0–100) to that range in `S06_Outputs`; 0 % must give the valve's closed signal.

**Recipe mailbox.** The scanner node reads the label while the bottle is at SCAN and posts `ParseResult, TotalMl, Rounds, Vol1..VolN`, then `Recipe.Seq`. When `Recipe.Seq ≠ Recipe.AckSeq`, copy the recipe into the container at SCAN and set `AckSeq := Seq`. The virtual PLC differs here: its built-in feeder queues recipes first and admits one container per recipe. On the real line the bottle arrives first, so attach the recipe at SCAN.

**Rules**
- One container per station. Waiting for an occupied station, a presence sensor or an ESP32 `Done` counts toward `sensorWaitTimeoutSec` (running time only). A sensor timeout means `JAMMED` (event `CONTAINER_JAMMED`, arg2 = station code); an ESP32 timeout or fault bit means `FAULT` plus a `STATION_FAULT` reject.
- **Single-bottle option** (no stoppers, [bom.md D1](bom.md#6-open-decisions-for-the-team)): set `MaxConcurrent = 1` and stop the belt (`O_Belt_Run := 0`) while the container is held at a station instead of using a stopper. Everything else stays the same.
- Counters: `Accepted`, `Rejected` (including bad barcodes and jams) and `Total` increment exactly once per container.
- **Physical QC.** The software judges the fill from the delivered volume (rate × time). The sort sensor only confirms the bottle type. A load cell at QC (HX711 on ESP32 #2) would measure the fill for real; compare the net weight with `Σ volume_k × density_k` using the same tolerance rule.

## 5. Tanks without level sensors

The BOM has no level sensor or refill valve ([bom.md G8](bom.md#3-gaps-between-the-bom-and-the-software)):
- `TankLevelMl_x10` = capacity − Σ dispensed since the last refill. Publish it as `Tank<k>.LevelMl`.
- `I_Tank<k>_Low` (float), or the estimate falling below `RefillThresholdMl`, sets the tank's `LOW` flag and records `TANK_LOW` (7). Hold admission of containers whose recipe needs that tank.
- The operator refills by hand and presses "Tank k refilled" (touch panel, or a hardwired button if there's no panel): level := capacity, event `TANK_REFILLED` (8).
- If a level transmitter or ESP32 tank node is added later, use it instead of the estimate (validate the node heartbeat first).

## 6. Safety and control-authority logic (`S01_SafetyMode`)

State variables are **not retained**: every power-up starts with `DigitalEStop = 0`, `RunCmd = 0`, and the safety relay needing a reset. Check that these variables don't have the **Retained** attribute set in CCW, and clear them on the first scan (`_SYSVA_FIRST_SCAN`) anyway. Putting the controller in Program mode turns every output off, which de-energizes `O_Safety_RemoteEStopOK` and opens the safety circuit.

```text
PhysicalMask bit i := NOT I_EStop_<i>_Mon      // i = 0 PANEL, 1 ENTRY, 2 EXIT (config.safety.eStopButtons)
EStopActive        := DigitalEStop OR (PhysicalMask <> 0)
SafetyOK           := I_Safety_OK
LocalMode          := I_Panel_LocalMode
ResetRequired      := NOT EStopActive AND NOT SafetyOK
Running            := RunCmd AND SafetyOK AND NOT EStopActive
```

Rules, in scan order (stops before starts). Every refusal records `COMMAND_REFUSED` (31) with arg1 = command code and arg2 = reason code ([io-map.md §4](io-map.md#4-register-map-modbus-tcp)). START and JOG in LOCAL mode come from the touch panel or hardwired buttons; STOP and RESET must be hardwired.

| # | Trigger | Condition | Action | Event |
| --- | --- | --- | --- | --- |
| 1 | `Cmd.DigitalEStop` (coil 0) ↑ | always | `DigitalEStop := 1`; `RunCmd := 0` | `DIGITAL_ESTOP` (23); `LINE_STOPPED` (29, arg1 0) if it was running |
| 2 | bit i of `PhysicalMask` ↑ | always | `RunCmd := 0` (hardware already opened the circuit) | `PHYSICAL_ESTOP_PRESSED` (25, arg1 = i), `LINE_STOPPED` (29, 0) |
| 3 | bit i of `PhysicalMask` ↓ | — | — | `PHYSICAL_ESTOP_RELEASED` (26, arg1 = i) |
| 4 | `I_Panel_LocalMode` changes | — | `RunCmd := 0` | `CONTROL_MODE_CHANGED` (30, arg1 1 = LOCAL), `LINE_STOPPED` (29, 1) |
| 5 | `Cmd.Stop` (coil 5) ↑, touch-panel STOP, or `I_Panel_Stop_PB` = 0 | always, any mode | `RunCmd := 0` | `LINE_STOPPED` (29, 2 remote / 1 local) |
| 6 | `Cmd.ReleaseEStop` (coil 1) ↑ | `DigitalEStop` = 1, else refuse NOT_ACTIVE (8) | `DigitalEStop := 0` | `DIGITAL_ESTOP_RELEASED` (24) |
| 7 | `I_Panel_Reset_PB` ↑ | PhysicalMask = 0 (else ESTOP_STILL_PRESSED, 7); DigitalEStop = 0 (else ESTOP_ACTIVE, 3) | The safety relay resets in hardware; `RunCmd := 0` | `SAFETY_RESET` (27, arg1 1) when `I_Safety_OK` rises |
| 8 | `Cmd.Reset` (coil 6) ↑ | as 7, **plus** LocalMode = 0 (else LOCAL_MODE, 1) **and** REMOTE_RESET_ALLOWED (else 6) | Pulse the safety relay's remote reset input (only if wired and approved) | `SAFETY_RESET` (27, arg1 2) |
| 9 | Local START ↑ (touch panel or button) | LocalMode = 1 (else REMOTE_MODE, 2); not EStopActive (3); SafetyOK (else RESET_REQUIRED, 4) | `RunCmd := 1` | `LINE_STARTED` (28, 1) |
| 10 | `Cmd.Start` (coil 4) ↑ | LocalMode = 0 (else 1); not EStopActive (3); SafetyOK (4) | `RunCmd := 1` | `LINE_STARTED` (28, 2) |
| 11 | Jog: local JOG held (LOCAL) or `Cmd.Jog` (coil 2) ↑ (REMOTE) | mode matches; not EStopActive; SafetyOK; not Running (else LINE_RUNNING, 5) | Local: belt on **while held**. Remote: belt on for 0.5 s | `JOG` (12) |
| 12 | `Cmd.FirePusher` (coil 3) ↑ | LocalMode = 0; not EStopActive; SafetyOK | Mark the container at QC/GATE for reject | `PUSHER_FIRED` (14) / `PUSHER_NO_TARGET` (15) |
| 13 | `Sys.TankEnableMask` write | LocalMode = 0 (else refuse and restore the mask) | See §7 | §7 |

**Touch-panel JOG.** A touch panel can drop a "held" bit if its link stalls. Also stop the jog when the panel's link heartbeat stops, or use a hardwired hold-to-run button for JOG.

**Remote reset.** Leave `REMOTE_RESET_ALLOWED` = 0 unless the risk assessment approves it ([safety.md §1](safety.md#1-emergency-stop-physical-and-digital-working-together)).

**ESP32 supervision.** Drop `Station.RunPermit` whenever `Running` = 0. If a node's heartbeat (`Field.ScannerNodeHeartbeat`, `Field.StationNodeHeartbeat`) stops changing for 3 s, raise `FAULT`, hold the stations that node serves, and don't admit new containers ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)).

## 7. Commands and mask handling

| Input | Condition | Action | Event |
| --- | --- | --- | --- |
| `Cmd.FirePusher` ↑ | allowed (§6 #12), container at QC or GATE | `ManualReject := 1` | `PUSHER_FIRED` (14, arg1 = id) |
| `Cmd.FirePusher` ↑ | allowed, none there | none | `PUSHER_NO_TARGET` (15) |
| `Sys.TankEnableMask` written | LOCAL mode | Restore the old mask | `COMMAND_REFUSED` (31, 6, 1) |
| `Sys.TankEnableMask` written | new mask = 0 | Restore the old mask | `TANK_CHANGE_REFUSED` (18, arg1 = 4) |
| `Sys.TankEnableMask` written | valid | Enable/disable slots | `TANK_ENABLED` / `TANK_DISABLED` (16/17, arg1 = slot, arg2 = new count) |

The PLC detects a mask write by comparing `MB_Sys[4]` with its own copy each scan. Because `S07_Publish` copies published values into `MB_Sys`, handle the mask **before** publishing, and don't overwrite `MB_Sys[4]` with a stale copy in the same scan a write arrived.

## 8. Publishing

| Register | Rule |
| --- | --- |
| `Sys.ProtocolVersion` | Constant `3`. Change it only together with [`tag-map.ts`](../../twin/src/plc/tag-map.ts) |
| `Sys.PlcHeartbeat` | +1 every 100 ms, wrapping to 0 after 65 535 (§2) |
| `Sys.LineState` | bit0 `Running`, bit1 `EStopActive`, bit2 `SafetyOK`, bit3 any active fault, bit4 HMI heartbeat changed within 3 s, bit5 `DigitalEStop`, bit6 `PhysicalMask <> 0`, bit7 `ResetRequired`, bit8 `LocalMode`, bit9 remote reset allowed (constant), bit10 `SimInputs` |
| `Sys.PhysicalEStopMask` | `PhysicalMask` (bit 0 PANEL, 1 ENTRY, 2 EXIT) |
| `Counts.LaneA` / `Counts.LaneB` | Accepted containers per sort lane |
| `Tank<k>.ValveOpeningPct` | The calibrated opening for tank k ([io-map.md](io-map.md#calibration-values-per-tank)) |
| `Station.RunPermit` | `Running` |
| `Oee.*` | availability = 1 − downtime/elapsed (downtime = not running **or** any container blocked), **reported as 0 while not Running**; performance = min(1, idealCycle × total / operating time); quality = accepted/total; overall = product. All × 1000. Formula: [`twin/src/metrics.ts`](../../twin/src/metrics.ts). Simplify on the PLC if needed (the twin's numbers are the reference). The Micro850 has `REAL` maths, so compute in `REAL` and convert with `ANY_TO_UINT` at the end |
| `Perf.ThroughputCpm` | Accepted completions in the last 60 s × 60 / min(60 s, max(10 s, uptime)), × 100 |
| Container table | The first 8 slots (live first, then recently finished), status codes as in §4 |
| Event ring | On each event: shift Event1..7 to Event2..8, write Event1, increment `LastSeq` (skip 0). See [io-map.md §5](io-map.md#5-handshakes) |

## 9. Test-mode inputs

For [commissioning stage 3](commissioning.md#4-stage-3-real-plc-no-field-devices), add a `SimInputs` BOOL, **off by default and cleared on power-up**. When it's on:
- publish `LineState.SIMULATION` = 1;
- take the physical E-Stop mask from `Sim.PhysicalEStopMask` (register 450, `MB_Sim[0]`) and the key switch from `Sim.LocalMode` (451, `MB_Sim[1]`);
- take panel push-buttons from `Sim.LocalStart/Stop/Reset/Jog` (coils 8–11, `MB_Cmd[8..11]`);
- synthesize presence sensors from the station state machines (0.5 s arrival delay);
- complete LABEL/CAP/PRESS after the `stationTimesSec` values if no ESP32 is connected;
- drop the tank level estimates by the dispensed volume;
- treat `SafetyOK` as `NOT EStopActive` after a simulated reset;
- keep **all field outputs OFF** and `Station.RunPermit` = 0.

That lets you run the whole program, bridge and HMI (including the HMI's simulated local panel) with no field devices.

`SimInputs` must be impossible to enable while field outputs are powered. For example, require `I_Safety_OK` = 0 and a key switch, and have `SimInputs` force `O_Safety_RemoteEStopOK` = 0.
