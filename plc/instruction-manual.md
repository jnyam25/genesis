# Genesis Micro850 instruction manual

How to create the line PLC project in **Connected Components Workbench (CCW) Standard**, build it, and download it to the team's **2080-L50E-24QBB**.

CCW stores a project as a solution file plus a folder of controller files. Those files have to be created by CCW. This manual is the procedure. The behaviour you type into the programs is [docs/prototype/micro850-plc.md](../docs/prototype/micro850-plc.md). Addresses are [docs/prototype/io-map.md](../docs/prototype/io-map.md). When a rule and the virtual PLC disagree, match the virtual PLC (`twin/src/plc/virtual-plc.ts`).

Save the finished solution in this folder (`plc/genesis.ccwsln` and the project folder CCW creates beside it) and commit it with the repo revision it implements.

## 1. Before you open CCW

Read [docs/prototype/safety.md](../docs/prototype/safety.md) before downloading anything to the controller.

- A download puts the controller in Program mode. Program mode turns every output off, which de-energizes `O_Safety_RemoteEStopOK` and opens the safety circuit. That is the safe state. Do not defeat it to "keep the line up" during a download.
- Leave `SimInputs` off. It must be impossible to turn on while field outputs can move. The rule in the specification is: `I_Safety_OK` = 0 and a key switch, and `SimInputs` forces `O_Safety_RemoteEStopOK` off.
- Physical E-Stops at the line start and the line end cut actuator power in hardware. The PLC only monitors them. Do not wire an E-Stop safety contact to a PLC input and call that the safety circuit.
- The first download is commissioning stage 3: PLC and network, no field devices, ESP32 nodes off. Follow [docs/prototype/commissioning.md](../docs/prototype/commissioning.md) from stage 3. Do not skip to a running belt.

## 2. What to install

| Item | Requirement |
| --- | --- |
| CCW Standard | **20.01 or later.** An L50E will not take an older project. Free from Rockwell's Product Compatibility and Download Center; a free Rockwell account, no activation. Do not buy CCW Developer Edition. |
| Controller | 2080-L50E-24QBB, already owned: 14 DC inputs, 10 sourcing DC outputs. In CCW, keep that catalog and set the major revision to the firmware CCW shows when you connect. Update firmware from CCW only when the project needs a newer revision. |
| This repo | The specification, the register map, and this folder. |
| Engineering PC | Static address `192.168.10.50` on the control network ([communication.md](../docs/prototype/communication.md)). USB is enough for the first download. |

Confirm the controller facts against the firmware revision, the 24-point installation instructions that came with the controller, and the CCW help, before you land a wire. Those Rockwell documents are the hardware manual. This page is the Genesis procedure.

## 3. Open the project

The solution is already in this folder, laid out the same way as a CCW 22 Micro850 project:

```
plc/
  genesis.ccwsln
  Controller/
    Controller.acfproj
    Controller/          program, variables, Modbus, Ethernet
```

1. Start **Connected Components Workbench 22** (20.01 or later still builds an L50E; this solution was saved by CCW 22).
2. On the start page, choose **Open Existing**.
3. Open `plc/genesis.ccwsln`. The `Controller` folder has to sit next to that file. CCW refuses a solution file that was copied without it.
4. The project opens as catalog **2080-L50E-24QBB**, firmware **22.100**. Leave that catalog. If the connected controller reports a different firmware revision, set the project revision to match before you download.
5. Open `Prog1`. It is the Genesis ladder: S00 inputs, S01 safety and run, S02 commands and jog, S06 field outputs. Leave those rungs. Station machines, the barcode parser, the arm sequencer, and publish are still the programs in §6. If the editor shows three rungs (AND, OR, XOR on `_IO_EM_DI_00` and `_IO_EM_DI_01`), the project database still has the lab copy. Close without saving, so that save does not write the lab rungs back over `Prog1.stf`.
6. On the controller graphic, add a **2085-IQ16** as expansion module 1 and a **2085-OB16** as expansion module 2 before you build. One 2085 module is inputs or outputs, so both are required. The ladder addresses the first as `_IO_X1_` and the second as `_IO_X2_`. After CCW creates them, confirm those names. If the prefix is different, change the contacts to match. The two valve angles need one **2080-OF2** in a plug-in slot. That analog is not in this ladder. Belt speed stays one of the two PWM outputs or the drive's own knob unless you add a second analog channel.

To move the project to another PC, copy `genesis.ccwsln` and the whole `Controller` folder, or use **File → Export** to produce a `.ccwarc` and **File → Import Project** on the other machine.

## 4. Controller settings

In the Project Organizer, open the controller:

| Setting | Value |
| --- | --- |
| Ethernet → Internet Protocol | Static `192.168.10.10`, mask `255.255.255.0`. Change the mask only if the control network is not a /24. |
| Ethernet → Modbus TCP | **Enabled.** Port 502. |
| Controller password | Set one, so a download or upload needs it. |
| Serial port | Leave unused unless a Modbus RTU panel is fitted. If it is, set **Modbus RTU slave** and match baud, parity, and node address to the panel. |

`REMOTE_RESET_ALLOWED` stays FALSE. Do not turn it on unless the risk assessment in safety.md says so.

Global variables in the next section are **not retained**. In the variable grid, leave **Retained** clear on every variable, including tank levels and the arm sequence. On L50E an `RTO` keeps its time through a power cycle anyway, so each station timer is reset on `_SYSVA_FIRST_SCAN`.

## 5. Global variables

Right-click the controller and open **Global Variables**. CCW does not convert types for you: a `UINT` compared with an `INT` needs `ANY_TO_*`.

The eight `MB_` arrays are already in Global Variables. Do not add them again. One array is one mapping entry, which is what keeps the map under CCW's 200-entry limit.

| Name | Data type | Initial | Comment |
| --- | --- | --- | --- |
| `MB_Cmd` | `ARRAY[0..15] OF BOOL` | FALSE | Coils 0–15. Command pulses and simulated panel buttons. |
| `MB_Sys` | `ARRAY[0..19] OF UINT` | 0 | Holding registers 0–19. |
| `MB_Tank` | `ARRAY[0..11] OF UINT` | 0 | Registers 20–31 (T1 and T2). |
| `MB_Cont` | `ARRAY[0..39] OF UINT` | 0 | Registers 100–139. |
| `MB_Event` | `ARRAY[0..32] OF UINT` | 0 | Registers 200–232. |
| `MB_Scan` | `ARRAY[0..38] OF UINT` | 0 | Registers 300–338. |
| `MB_Field` | `ARRAY[0..19] OF UINT` | 0 | Registers 400–419. |
| `MB_Station` | `ARRAY[0..12] OF UINT` | 0 | Registers 420–432. |
| `MB_Sim` | `ARRAY[0..1] OF UINT` | 0 | Registers 450–451. |

Only these arrays are mapped. Everything else stays a named variable.

Constants, from `twin/src/config.ts`. Change them in the PLC and in `config.ts` together.

| Name | Type | Value |
| --- | --- | --- |
| `ProtocolVersion` | `UINT` | 4 |
| `MaxConcurrent` | `UINT` | 4 |
| `SensorWaitTimeout` | `TIME` | `T#6s` |
| `StationNodeTimeout` | `TIME` | `T#15s` |
| `DispenseVariance` | `REAL` | 0.02 |
| `SmallBottleMaxMl` | `UINT` | 250 |
| `HeightLaneAMm` | `UINT` | 120 |
| `HeightLaneBMm` | `UINT` | 180 |
| `HeightToleranceMm` | `UINT` | 15 |
| `BeltSpeedMPerSec` | `REAL` | 0.20 |
| `RemoteResetAllowed` | `BOOL` | FALSE |
| `ScannerNodeFitted` | `BOOL` | TRUE when ESP32 #1 is on the line, else FALSE |
| `StationNodeFitted` | `BOOL` | TRUE when ESP32 #2 is on the line, else FALSE |
| `TankCapacityMl` | `UINT` | 5000, both tanks, until you measure them |
| `TankRefillThresholdMl` | `UINT` | 800 |
| `TankRateMlPerS_x10` | `UINT` | 250 (25.0 ml/s) |
| `TankValveOpeningPct` | `UINT` | 80 |

State. Initial values are the power-up state; `S00` also clears them on `_SYSVA_FIRST_SCAN`.

| Name | Type | Initial | Meaning |
| --- | --- | --- | --- |
| `RunCmd` | `BOOL` | FALSE | Latched run request. `Running` is this plus safety. |
| `DigitalEStop` | `BOOL` | FALSE | HMI E-Stop latch. |
| `PhysicalMask` | `UINT` | 0 | bit0 line start, bit1 line end. 1 = pressed. |
| `EStopActive` | `BOOL` | FALSE | Digital or any physical E-Stop. |
| `SafetyOK` | `BOOL` | FALSE | `I_Safety_OK`, or the simulated equivalent. |
| `LocalMode` | `BOOL` | FALSE | 1 = LOCAL. |
| `ResetRequired` | `BOOL` | FALSE | Not in E-Stop, and the safety relay is open. |
| `Running` | `BOOL` | FALSE | `RunCmd AND SafetyOK AND NOT EStopActive`. |
| `SimInputs` | `BOOL` | FALSE | Test mode. Off after every power-up. |
| `HmiLinkOk` | `BOOL` | FALSE | `MB_Sys[13]` changed within 3 s. Alarm only. |
| `ActiveContainers` | `UINT` | 0 | Containers on the belt. |
| `NextContId` | `UINT` | 1 | Next container id. Skip 0. |

Per container, index `0..7`:

| Name | Type |
| --- | --- |
| `ContId` | `ARRAY[0..7] OF UINT` |
| `ContStatus` | `ARRAY[0..7] OF UINT` |
| `ContStation` | `ARRAY[0..7] OF UINT` |
| `ContLane` | `ARRAY[0..7] OF UINT` |
| `ContParseResult` | `ARRAY[0..7] OF UINT` |
| `ContRejectReason` | `ARRAY[0..7] OF UINT` |
| `ContManualReject` | `ARRAY[0..7] OF BOOL` |
| `ContFillMl_x10` | `ARRAY[0..7] OF UINT` |
| `ContTargetMl_x10` | `ARRAY[0..7] OF UINT` |
| `ContVolumeMl` | `ARRAY[0..7, 1..2] OF UINT` |
| `ContStepTimer` | `ARRAY[0..7] OF RTO` |

Per tank, index `1..2` (registers 20–31). Container tracking still has eight slots:

| Name | Type | Initial |
| --- | --- | --- |
| `TankEnabled` | `ARRAY[1..2] OF BOOL` | TRUE |
| `TankLow` | `ARRAY[1..2] OF BOOL` | FALSE |
| `TankLevelMl_x10` | `ARRAY[1..2] OF UDINT` | capacity × 10 on first scan |
| `TankEnableMaskCopy` | `UINT` | 3 (both tanks) |

Arm and faults:

| Name | Type | Initial |
| --- | --- | --- |
| `ArmSeq` | `UINT` | 0. Not retained. |
| `ArmPending` | `BOOL` | FALSE |
| `ArmPendingCmd` | `UINT` | 0 |
| `ArmPendingTarget` | `UINT` | 0 |
| `ArmNeedHome` | `BOOL` | TRUE |
| `ArmPickFailures` | `UINT` | 0 |
| `CapOutcomeId` | `UINT` | 0 |
| `CapOutcome` | `UINT` | 0 (1 capped, 2 failed) |
| `FaultCode` | `UINT` | 0 |
| `FaultLatched` | `ARRAY[1..8] OF BOOL` | FALSE |
| `FaultSet` | `BOOL` | FALSE | One scan. S04 sets it when any `FaultLatched` bit is true. |
| `FaultHold` | `BOOL` | FALSE | Sealed in `Prog1`. RESET or first scan clears it. |
| `NodeHbLast` | `ARRAY[1..2] OF UINT` | 0 |
| `NodeHbTimer` | `ARRAY[1..2] OF TON` | |
| `PublishTimer` | `TON` | 100 ms publish tick |
| `HmiHbTimer` | `TON` | 3 s HMI link |
| `JogTimer` | `TON` | remote jog, 0.5 s. `Prog1` uses this instance. |
| `TON_BuzzOn` | `TON` | buzzer on half, 400 ms |
| `TON_BuzzOff` | `TON` | buzzer off half, 400 ms |

Field inputs and outputs are `BOOL` globals. Create one per row in §8. Do not give them Modbus addresses.

Rising-edge memory is `BOOL`, initial FALSE. `Prog1` uses `PrevLocalMode`, `PrevLocalStart`, `PrevRemoteStart`, `PrevRelease`, `PrevReset`, and `PrevJog`.

Those variables are already in this project's global variable table, with **Retained** clear. A rung comment that is only `S00`, `S02`, `S06`, or `S07` is a CCW label, so each one in `Prog1` now has the rung number on it (`S07_267`). The first-scan bit in the ladder is `__SYSVA_FIRST_SCAN`.

`Prog1` also needs these `BOOL` variables, all initial FALSE: `EntryPressed`, `ExitPressed`, `SortPresent`, `LaneAFull`, `LaneBFull`, `RejectFull`, `RejectHome`, `SortHome`, `ModeChanged`, `LocalStartRise`, `RemoteStartRise`, `StartPulse`, `ReleasePulse`, `ResetPulse`, `JogLocal`, `JogPulse`, `JogHold`, `JogBelt`, `Flash`, `Valve1Cmd`, `Valve2Cmd`, `QrRejectCmd`, `LidPressCmd`, `RejectCmd`, `SortLaneBCmd`, `RelScan`, `RelBay1`, `RelBay2`, `RelCap`, `RelPress`, `RelQC`, `RelGate`, `PublishRail`, `HbAtMax`, `MaskEmpty`. The station bits stay FALSE until S04 and S05 set them, so the valves, diverters, and stoppers stay off. `S00` copies the tank-low floats into `TankLow[1]` and `TankLow[2]`.

The bottom of `Prog1` is what the bridge, the HMI and FUXA read. These are already in the variable table:

| Name | Type | Initial | Meaning |
| --- | --- | --- | --- |
| `ProtocolVersion` | `UINT` | blank | The ladder writes the literal 4 into `MB_Sys[0]` every scan. Same number as `tag-map.ts`. Leave the initial value blank. |
| `ZeroU` | `UINT` | 0 | Zero for the word moves. |
| `Hb` / `HbNext` | `UINT` | 0 | Heartbeat. `MB_Sys[1]` increments every 100 ms and wraps after 65 535. |
| `Ls` / `LsNext` | `UINT` | 0 | Built into `MB_Sys[2]` (`Sys.LineState`). |
| `Pm` / `PmNext` | `UINT` | 0 | Built into `MB_Sys[16]` (`Sys.PhysicalEStopMask`). Bit0 is the line-start E-Stop, bit1 the line-end E-Stop. |
| `TON_Publish` | `TON` | | 100 ms publish tick. |

`MB_Sys[3]` is published as 2 (two tanks). `MB_Sys[4]` is set to 3 (both tanks enabled) only while it is still 0, so an HMI mask write is kept. `MB_Station[0]` (`Station.RunPermit`) is 1 only while `Running` is true and `SimInputs` is false. Counts, OEE, containers and the event ring stay 0 until `S03` through `S07` exist. `Cmd.FirePusher` and `Cmd.Reset` are cleared and not acted on: remote reset stays off, and the reject pusher waits for the station program.

Counts (`Accepted`, `Rejected`, `Total`, `LaneA`, `LaneB`) are `UINT`.

## 6. Add the remaining programs

`Prog1` already runs S00, S01, S02, and the S06 output map, in that rung order. Do not paste a second copy of that logic into new programs. Add the four programs that are not in the ladder. The controller runs programs from top to bottom of the Project Organizer, once per scan, and `Prog1` is already first. A station bit written after `Prog1` moves its output on the next scan.

For each name below:

1. Right-click **Programs → Add → New ST**.
2. Rename the new program to the name in the table. CCW's default name is not the Genesis name.
3. Drag it until the organizer is `Prog1`, then `S03_Admission`, `S04_Supervisor`, `S05_Stations`, `S07_Publish`.

| Program | Write this from the specification |
| --- | --- |
| `S03_Admission` | §4, admission. A new container starts at **SCAN** (`I_Scan_Present` rising), not at a labeler. Refuse a new container when the line is stopped, no slot is free, `ActiveContainers >= MaxConcurrent`, a lane is full, or the tanks that label needs are low. |
| `S04_Supervisor` | §6a, §4a, §4b, §4c, in that order. Set `FaultSet` for one scan when a fault is new; `Prog1` seals `FaultHold`. Then the barcode parser, the arm sequencer, and the height classification. The structured-text parser in §4a is the one to paste; it was checked against `barcode.ts`. |
| `S05_Stations` | §4. Station order: SCAN, BAY-1, BAY-2, CAP, PRESS, QC, GATE, SORT. A bad QR is ejected at the scan gate and never reaches a valve. Acquire the next station before releasing the previous one. Set `Valve1Cmd`, `Valve2Cmd`, `QrRejectCmd`, `LidPressCmd`, `RejectCmd`, `SortLaneBCmd`, and the `Rel*` bits. `Prog1` copies those bits to the outputs. |
| `S07_Publish` | §8. Gated by `PublishTimer` at `T#100ms`, self-resetting. Heartbeat wraps 65535 → 0. Then copy published values into `MB_*`. Do not write the registers the nodes own (specification §2, "Who writes what"). |

`S04` has to run before `S05` in the same scan, so the station machines see this scan's barcode, arm, and height results. S00 through S02 and the S06 output map stay in `Prog1`. S00 in the specification still has to copy node and bridge writes out of `MB_*`, debounce the presence inputs, and on first scan clear run state, reset every `ContStepTimer`, set `ArmNeedHome`, and set both tank levels to capacity. That copy and the first-scan housekeeping are not in the ladder yet. Add them at the top of `S03_Admission` until you split `Prog1` inside CCW.

Build after the variables exist, and again after each program (**Build** on the toolbar, or the Build command in the menu). Fix that program before starting the next. A clean build has no errors in the Output window.

CCW evaluates both sides of `AND` and `OR`. The barcode parser's extra array elements are there so a guarded index is still in range. Keep them.

## 7. Modbus mapping

**Controller → Modbus Mapping.** Map each array at the start address. CCW addresses are 6-digit: coil 0 is `000001`, holding register 0 is `400001`.

| Variable | CCW address | What a client sees |
| --- | --- | --- |
| `MB_Cmd` | `000001` | Coils 0–15 |
| `MB_Sys` | `400001` | Registers 0–19. Register 0 must read **4**. |
| `MB_Tank` | `400021` | Registers 20–31 |
| `MB_Cont` | `400101` | Registers 100–139 |
| `MB_Event` | `400201` | Registers 200–232 |
| `MB_Scan` | `400301` | Registers 300–338 |
| `MB_Field` | `400401` | Registers 400–419 |
| `MB_Station` | `400421` | Registers 420–432 |
| `MB_Sim` | `400451` | Registers 450–451 |

Map the whole array, including unused words. A client that reads a hole in the block gets a failed read or zeros, and the bridge reads 0–19, 20–31, 100–139, and 200–232 as blocks.

Do not map `RunCmd`, `ContId`, or any other internal variable. A touch panel, if you add one, uses a separate `MB_Panel` array at `401001` / `000101`, outside this map.

Coils the bridge and the simulator use:

| Coil | Name | Who pulses it |
| --- | --- | --- |
| 0 | `Cmd.DigitalEStop` | HMI, any mode |
| 1 | `Cmd.ReleaseEStop` | HMI, after the digital E-Stop |
| 2 | `Cmd.Jog` | HMI, REMOTE only |
| 3 | `Cmd.FirePusher` | HMI, REMOTE only |
| 4 | `Cmd.Start` | HMI, REMOTE only |
| 5 | `Cmd.Stop` | HMI, any mode. The hardwired STOP is separate and wins too |
| 6 | `Cmd.Reset` | HMI, REMOTE, and only if `RemoteResetAllowed` is TRUE |
| 8–11 | `Sim.LocalStart/Stop/Reset/Jog` | Simulated panel while `SimInputs` is on |

`MB_Sys[1]` is the heartbeat. `MB_Sys[4]` is the tank-enable mask the HMI writes. `MB_Sys[19]` is `FaultCode`. `MB_Scan[4]` is the first barcode word. `MB_Station[3]` is `ArmCmd`. `MB_Cmd[5]` is Stop.

## 8. Embedded I/O

Open **Embedded I/O** and assign each point to the global in the table. The base unit has **DI 0–13** and **DO 0–9**. **Change the point numbers to the panel drawing**, and check the terminal number against the 24-point installation instructions, before wiring. PNP sensors need the input commons wired for sourcing sensors. Outputs are 24 V sourcing; the load returns to 0 V.

Embedded inputs:

| Point | Variable | On means |
| --- | --- | --- |
| DI 0 | `I_Safety_OK` | Safety relay reset and closed. Monitor only. |
| DI 1 | `I_EStop_Entry_Mon` | NC monitor of the line-start E-Stop. **0 = pressed** (mask bit0). |
| DI 2 | `I_EStop_Exit_Mon` | NC monitor of the line-end E-Stop. **0 = pressed** (mask bit1). |
| DI 3 | `I_Safety_RemoteRelay_Fb` | 1 = remote-E-Stop relay de-energized. |
| DI 4 | `I_Panel_LocalMode` | 1 = LOCAL. |
| DI 5 | `I_Panel_Stop_PB` | NC. **0 = pressed.** |
| DI 6 | `I_Panel_Reset_PB` | 1 = pressed. |
| DI 7 | `I_Scan_Present` | Can at the scan gate. |
| DI 8 | `I_Bay1_Present` | Can at tank T1. |
| DI 9 | `I_Bay2_Present` | Can at tank T2. |
| DI 10 | `I_Cap_Present` | Can at the arm. |
| DI 11 | `I_Press_Present` | Can at the lid press. |
| DI 12 | `I_QC_Present` | Can at the height sensor. |
| DI 13 | `I_Gate_Present` | Can at the fill-reject pusher. |

Expansion inputs, **2085-IQ16**, module 1. Until that module is on the controller graphic, `Prog1` reads stand-ins `X1_DI_00` through `X1_DI_09`. After CCW creates the module points, change those contacts to `_IO_X1_DI_00` through `_IO_X1_DI_09` and delete the stand-ins. Sort present is wired here.

| Point | Variable | On means |
| --- | --- | --- |
| DI 0 | `I_Sort_Present` | Can at the sort gate. |
| DI 1 | `I_LaneA_Full` | Lane 1 is full. START is refused. |
| DI 2 | `I_LaneB_Full` | Lane 2 is full. START is refused. |
| DI 3 | `I_Reject_Full` | Reject lane is full. |
| DI 4 | `I_Tank1_Low` | T1 low float. Copied to `TankLow[1]`. |
| DI 5 | `I_Tank2_Low` | T2 low float. Copied to `TankLow[2]`. |
| DI 6 | `I_Panel_Start_PB` | Local START. Ignored in REMOTE. |
| DI 7 | `I_Panel_Jog_PB` | Local jog, hold to run. Ignored in REMOTE. |
| DI 8 | `I_RejectDiverter_Home` | Fill-reject pusher is home. |
| DI 9 | `I_SortDiverter_Home` | Sort diverter is home. |

Embedded outputs. These 10 are the whole base unit.

| Point | Variable | On means |
| --- | --- | --- |
| DO 0 | `O_Safety_RemoteEStopOK` | Energized = safety circuit allowed. Off = digital E-Stop. Fail-safe. |
| DO 1 | `O_Belt_Run` | Conveyor controller enabled. |
| DO 2 | `O_Valve_T1_Open` | T1 shutoff open. |
| DO 3 | `O_Valve_T2_Open` | T2 shutoff open. |
| DO 4 | `O_QrReject_Extend` | Scan-gate ejector. |
| DO 5 | `O_LidPress_Extend` | Lid-press cylinder. |
| DO 6 | `O_RejectDiverter_Extend` | Fill-reject pusher. |
| DO 7 | `O_SortDiverter_LaneB` | Lane 2. Off = lane 1. |
| DO 8 | `O_Stack_Green` | Running. |
| DO 9 | `O_Stack_Red` | E-Stop or latched fault. |

Expansion outputs, **2085-OB16**, module 2. Until that module is on the controller graphic, `Prog1` writes stand-ins `X2_DO_00` through `X2_DO_09`. After CCW creates the module points, change those coils to `_IO_X2_DO_00` through `_IO_X2_DO_09` and delete the stand-ins. A stopper output on means retracted (release). Off means the stopper is holding the can. One-bottle mode can leave the stopper rungs unused.

| Point | Variable | On means |
| --- | --- | --- |
| DO 0 | `O_Scan_Stopper` | `RelScan`, and the line is running. |
| DO 1 | `O_Bay1_Stopper` | `RelBay1`. |
| DO 2 | `O_Bay2_Stopper` | `RelBay2`. |
| DO 3 | `O_Cap_Stopper` | `RelCap`. |
| DO 4 | `O_Press_Stopper` | `RelPress`. |
| DO 5 | `O_QC_Stopper` | `RelQC`. |
| DO 6 | `O_Gate_Stopper` | `RelGate`. |
| DO 7 | `O_Stack_Amber` | Stopped or waiting for reset, and not in E-Stop. |
| DO 8 | `O_Buzzer` | Flashes while an E-Stop or `FaultHold` is present. |
| DO 9 | `O_Panel_Lamp_Reset` | `ResetRequired`. |

Analog. Add the 2080-OF2, then use the output names CCW creates for that slot. Do not invent a raw count: the plug-in manual gives the counts for 0–10 V or 0–20 mA. Scale `TankValveOpeningPct` (0–100) onto that range in `S06`. 0 % must be the valve's closed signal. Name the channels `AO_Valve_T1_Angle` and `AO_Valve_T2_Angle`.

Hardwired START and JOG, if you are not using a touch panel, need two inputs on the 2085-IQ16. The base unit has no spare inputs. LOCAL START and JOG are ignored in REMOTE. Remote jog runs the belt for 0.5 s; local jog runs it only while the button is held.

## 9. Build

Build the controller. The Output window should list no errors.

Typical errors on this program:

| Output window | Fix |
| --- | --- |
| Implicit conversion | Wrap the value in `ANY_TO_UINT`, `ANY_TO_INT`, `ANY_TO_UDINT`, or `ANY_TO_USINT`. |
| Array index out of range | The barcode buffer is `ARRAY[0..65]`. Keep the two spare bytes. |
| Unknown variable | It is missing from Global Variables, or it is still named `UntitledST`. |
| `RTO` not found | Reset the station timers yourself on first scan and accumulate time only while `Running`. |
| Program order | `S00` through `S07` top to bottom. `S07` last, so a mask write is seen before the publish copy. |

Then save. The `.ccwsln` and its folder in `plc/` are the program.

## 10. Download and prove it is the Genesis program

Do this with field power off and the ESP32 nodes unpowered.

1. Connect USB, or Ethernet at `192.168.10.50` to the PLC at `192.168.10.10`.
2. **Discover** the controller if this PC has not seen it, and check the firmware revision against the project.
3. Download. Enter the controller password. Stay in Program until the safety checks for this stage are done.
4. Switch to Run only when commissioning stage 3 says so. Outputs must still be unable to move: `SimInputs` off, or the safety circuit open.
5. With a Modbus TCP client, unit id 1, port 502, read holding register 0. It must be **4** (`Sys.ProtocolVersion`). Register 1 (`Sys.PlcHeartbeat`) must change about every 100 ms. CCW shows the same words as `MB_Sys[0]` and `MB_Sys[1]`.
6. From the repo root, with the PLC in Run:

```powershell
$env:PLC_HOST="192.168.10.10"
npm run line
```

`npm run line` reads protocol version 4 before it starts the virtual PLC, the coil link, the bridge, the HMI, and FUXA. Command coils are copied both ways. The virtual PLC repeats the Micro850 status words. The HMI is view and commands; it is not the safety system.

Watch one command in CCW's variable monitor: HMI Stop must set `MB_Cmd[5]` for one scan, then the program clears it and `RunCmd` is 0.

## 11. Test mode, still with nothing moving

`SimInputs` is how stage 3 runs the logic with no sensors. Turn it on only when `I_Safety_OK` is 0. While it is on:

- `LineState` bit10 (SIMULATION) is 1.
- Physical E-Stop and the key switch come from `MB_Sim[0]` and `MB_Sim[1]`.
- Panel buttons come from coils 8–11.
- Presence sensors are synthesized (about 0.5 s after a station is waiting).
- With no ESP32, SCAN is fed `PT1|T250|150,100`, which must parse as result 0, and QC is fed the nominal height of the expected lane.
- Set `ScannerNodeFitted` and `StationNodeFitted` FALSE for that bench, or a missing heartbeat latches fault 7 or 8 and START is refused.
- Every field output stays off, including `O_Safety_RemoteEStopOK`.

Labels worth typing into `MB_Scan` before the scanner exists, two characters per word, high byte first:

| Text | `ParseResult` |
| --- | --- |
| `PT1\|T200\|100,100` | 0 |
| `PT1\|T200\|200` | 3 (one volume, two tanks enabled) |
| `PT1\|T200\|100,90` | 5 |
| `XX1\|T200\|100,100` | 1 |
| `PT1\|200\|100,100` | 2 |
| `PT1\|T200\|100,8a` | 6 |
| `PT1\|T200\|100,100\|I0` | 6 |

A result other than 0 ejects that can at the scan gate. No valve opens.

## 12. When the real nodes and the belt are connected

That is commissioning stages 4 through 6, not this download.

- ESP32 nodes use the PLC address `192.168.10.10` port 502, not the virtual PLC's port 5020.
- A node heartbeat that stops changing for 3 s latches a fault and stops the line. START stays refused until RESET, and RESET only sticks if the cause is gone.
- `Station.RunPermit` (`MB_Station[0]`) is 1 only while `Running` is 1. The nodes are not allowed to move otherwise.
- Measure the real bottle heights and valve rates, then put the same numbers in the constants here and in `config.ts`.

## 13. Checklist

- [ ] Solution saved under `plc/` and it opens from `genesis.ccwsln` on a second try.
- [ ] Controller catalog 2080-L50E-24QBB, revision matched to the connected firmware.
- [ ] IP `192.168.10.10`, Modbus TCP enabled, controller password set.
- [ ] Nine `MB_*` arrays mapped at the addresses in §7, and no other variables mapped.
- [ ] Programs `S00` through `S07` in that order, build clean.
- [ ] Retained clear. First scan clears run state and the station timers.
- [ ] `MB_Sys[0]` = 4 and `MB_Sys[1]` is changing, read from a Modbus client.
- [ ] `SimInputs` off before any actuator is powered.
- [ ] Project exported or committed with the repo commit it matches.
