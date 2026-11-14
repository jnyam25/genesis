# Genesis station programs (structured text)

`Prog1` (the ladder) runs safety, run state, commands, and the output map. These five structured-text programs run the rest of the line: the station machines, the barcode check, the arm, the counters and publishing. The reference is the virtual PLC, `twin/src/plc/virtual-plc.ts` and the `core.ts` it drives. Where a real belt needs something different, this page says so (see "Where the programs differ from the twin").

| Order | Program | What it does |
| --- | --- | --- |
| 1 | [`S00_Inputs`](S00_Inputs.st) | 100 ms time base, presence debounce, `Cmd.FirePusher`, tank-enable mask, tank level and low flags. **Above Prog1.** |
| 2 | `Prog1` | Already in the project. Leave it. |
| 3 | [`S03_Admission`](S03_Admission.st) | A can on the SCAN eye becomes a container record, if the line can take it. |
| 4 | [`S04_Supervisor`](S04_Supervisor.st) | Node heartbeats and the fault latch, the arm sequencer, the scan mailbox and barcode check, the bottle height check. |
| 5 | [`S05_Stations`](S05_Stations.st) | One machine per container through SCAN, BAY-1, BAY-2, CAP, PRESS, QC, GATE, SORT. Sets the station bits Prog1 maps to outputs. |
| 6 | [`S07_Publish`](S07_Publish.st) | Event ring, counts, OEE, throughput, tank block, container table. |

`S00_Inputs` has to run **before** Prog1. Prog1 clears every command coil and writes `MB_Sys[4] := 3` while it reads 0, so a later program never sees `Cmd.FirePusher` or an HMI write of an empty tank mask.

## Add them in CCW

1. Open **Global Variables** and add every row of [`variables.csv`](variables.csv) (212 variables). The grid accepts rows pasted from a spreadsheet: open the CSV in Excel, copy the rows, and paste them into the grid's empty row. Leave **Retained** clear on all of them. None of them clash with Prog1's variables. CCW names are case-insensitive, and the list was checked for that.
2. For each program: **Programs → Add → New ST**, rename it, and paste the whole `.st` file.
3. Drag the programs into the order in the table above. `S00_Inputs` goes above `Prog1`.
4. Build after each program. These files have never been through the CCW compiler. If CCW rejects something, fix it in CCW, then copy the change back into the `.st` file here so the tests keep checking the real code. Typical fixes are in [instruction-manual.md §9](instruction-manual.md#9-build).

## How the programs connect

| Variable | Written by | Read by | Meaning |
| --- | --- | --- | --- |
| `Tick`, `NowDs` | S00 | all | One scan every 100 ms; time since power-up in 0.1 s. Station times count only while `Running`. |
| `Pres[1..8]` | S00 | S03, S05 | Debounced eyes: SCAN, BAY-1, BAY-2, CAP, PRESS, QC, GATE, SORT (DI 7–13, then 2085-IQ16 DI 0). |
| `StArmed[1..8]` | S00, S05 | S05 | The eye has read 0 since the last arrival it was used for. An arrival is a rising edge. |
| `FirePulse` | S00 | S05 | `Cmd.FirePusher`, already authorized (REMOTE, no E-Stop, no reset pending). |
| `TankEnabled[1..2]`, `TankLevelMl_x10[1..2]`, `TankLowAny[1..2]` | S00, S05 | S03, S04, S05, S07 | Tank state. A level is capacity minus what was dispensed. |
| `TankRefilled[1..2]` | coils 12 and 13, then S00 | S00 | Operator: tank k refilled. Sets the level to capacity. |
| `ContId`, `ContState`, `ContSt`, … `[0..7]` | S03, S05 | S04, S07 | Container slots. `ContState`: 0 free, 1 at a station, 2 moving, 3 waiting for a station, 10 accepted, 11 rejected, 12 jammed. |
| `StOccId[1..8]` | S03, S05 | S03, S05 | Container id at each station. |
| `ScanHeldId`, `CapHeldId`, `QcHeldId` | S03, S05 | S04 | Container being worked at SCAN, CAP and QC. |
| `ScanReady…`, `CapOutcome…`, `SortReady…` | S04 | S05 | This scan's barcode, cap and height results. S05 takes each one in the same scan. |
| `FaultSet` | S04 | Prog1 | TRUE while a fault is latched. Prog1 seals `FaultHold`, drops `RunCmd`, refuses START. |
| `EvQCode/EvQArg1/EvQArg2[0..15]`, `EvQCount` | all | S07 | Events raised this scan. S07 writes them into the event ring and empties the queue. |
| `Valve1Cmd`, `Valve2Cmd`, `QrRejectCmd`, `LidPressCmd`, `RejectCmd`, `SortLaneBCmd`, `Rel*` | S05 | Prog1 | Station bits. Prog1 drives the outputs from them, only while `Running`. |

Registers each program writes: S00 `MB_Sys[4]`; S04 `MB_Station[3]`, `[4]`, `[8]`, `MB_Scan[0]`, `[36..38]`, `MB_Sys[19]`; S07 `MB_Sys[2]` bit 4, `MB_Sys[3..15]`, `[17]`, `[18]`, `MB_Tank`, `MB_Cont`, `MB_Event`. None of them writes a register a node owns.

## Where the programs differ from the twin

The twin moves a container from one station to the next on a timer and does not model where the can physically is. Running both on a simulated belt with stoppers, eyes and cylinders showed six places where the twin's logic loses track of a can on a real conveyor. The programs here fix them:

1. **QC to GATE.** The twin decides GATE the moment QC finishes and fires the fill-reject pusher at once. On this belt GATE is 0.5 m further on (`config.ts` positions), so the push hits nothing and the rejected can rides into a lane. Here the can travels to the GATE eye and is decided there.
2. **Manual reject at QC.** The twin rejects a can at QC on the spot, with the same miss. Here it is flagged and GATE pushes it, as spec §7 describes.
3. **Back-to-back rejects.** The twin holds a pusher out for 1 s. A second reject inside that second gets no new stroke, and the can goes through. Here each reject gets its own stroke, with a 0.3 s retract in between.
4. **Stopper on a rejected can.** The twin retracts a stopper as soon as its can is rejected, so the belt can carry the can away before the pusher reaches it. Here the stopper stays closed on a rejected or jammed can.
5. **Release while stopped.** The twin's 2 s stopper release keeps counting while the line is stopped, when Prog1 holds every stopper output off anyway. After a fault stop, the can that was leaving is held again and jams the line. Here the release and pusher timers count only while `Running`.
6. **Cans skipping stations.** The twin sends a failed-cap can straight to GATE. On the belt it still has to pass the PRESS and QC stoppers. Here it stops at each one and is released at once (no press stroke, no height reading).

Also:

- **Sort diverter.** The twin sets the diverter for the oldest can anywhere from QC to SORT. Once cans travel QC→GATE, that is not the can crossing the sort point. Here it follows the can heading for SORT.
- **Bay timeout.** The twin gives every station 6 s. A bay with more than about 145 ml for one tank needs longer (25 ml/s plus 0.2 s), so the twin jams it. Here a bay's timeout is its fill time plus 6 s. The sample labels stay at 130 ml or less.
- **Disabling a tank.** The twin removes the bay, and containers still on their way to it jam. Here, as spec §4 says, the bay is skipped (`DISPENSE_SKIPPED`), the fill comes up short, and GATE rejects the can.
- **Tank refill.** The twin refills a low tank by itself after 1.5 s. The line has no refill valve (spec §5), so here a low tank holds admission until `TankRefilled[k]` is set.

The twin is still right about everything else: barcode results, arm commands, faults, events and counts agree whenever its own counts match the belt (see "Tests").

## Events

S04 and S05 record the station events (`CONTAINER_*`, `BARCODE_*`, `FAULT`, `FAULT_CLEARED`, `PUSHER_*`, `DISPENSE_SKIPPED`, `TANK_*`, `COMMAND_REFUSED` for the pusher and the mask). Prog1 records none, so S07 derives these from changes in its state: `DIGITAL_ESTOP` and `_RELEASED`, `PHYSICAL_ESTOP_PRESSED` and `_RELEASED`, `CONTROL_MODE_CHANGED`, `SAFETY_RESET` (when `SafetyOK` rises), `LINE_STARTED`, `LINE_STOPPED` and `JOG`.

Two of them are best guesses until Prog1 records its own events:

- `LINE_STOPPED`'s source (0 E-Stop, 1 local, 2 remote) is inferred.
- A refused START, RESET or JOG records nothing.

## Still not done

- **Presence eyes in test mode.** `S00_Inputs` drives the safety, key-switch and panel points from `MB_Sim` and coils 8–11 while `SimInputs` is on, so the line can run with the safety relay open. The eyes are still the wired inputs. A bench with no sensors needs those eyes synthesized (spec §9, 0.5 s after a station is waiting), and a stand-in scanner and station node when `ScannerNodeFitted` or `StationNodeFitted` is FALSE.
- **`AoFullScale`.** `S05_Stations` already scales the slot-2 valve channels. The count stays 0, and both channels stay 0, until it is read from the slot-2 OF2 configuration page. Do not guess it. Slot 3 is a second 2080-OF2; `S05_Stations` writes 0 to both of its channels.

## Tests

```bash
cd twin && npm ci && npm run build
```

```bash
node plc/test/run.mjs
```

[`plc/test`](test) runs the real `.st` files and Prog1's compiled ladder (`Controller/.../PROG1.txt`, the structured text CCW generates from the ladder) through a small structured-text interpreter. It enforces the CCW rules that matter here:

- every variable declared, from `decls.mjs`, the source of `variables.csv`;
- names case-insensitive;
- values kept in range for their type;
- both sides of `AND`/`OR` evaluated, so a guarded array index out of range fails the test.

Each scenario runs the programs and the virtual PLC on two copies of the same simulated belt, with the twin's simulated ESP32 nodes. A scenario passes when every can ends up where the PLC's counters say, none is in the wrong lane, and none is left on the belt. When the twin also matches the belt, every can must end the same way as with the twin.

The ten scenarios: mixed good and bad labels; stop and start; a digital E-Stop with release, reset and start; a station node going silent (fault, reset, start); the reject pusher every 7 s; disabling tank 2 mid-run; wrong bottles at QC; one empty lid pick; an empty magazine (fault); and a dropped lid (reject and fault).

Earlier checks of S04 alone: 300 000 labels against `barcode.ts`, the arm sequencer against `arm-sequencer.ts`, and supervision against `VirtualPlc`.

## Global variables

The same list as [`variables.csv`](variables.csv). "Program" is where each is written; "const" rows are the constants from `twin/src/config.ts`. Change them here and in `config.ts` together.

| Name | Type | Initial | Program | Note |
| --- | --- | --- | --- | --- |
| `MaxConcurrent` | `UINT` | 4 | const | Containers on the belt at once |
| `ScannerNodeFitted` | `BOOL` | TRUE | const | FALSE on a bench without ESP32 #1 |
| `StationNodeFitted` | `BOOL` | TRUE | const | FALSE on a bench without ESP32 #2 |
| `SmallBottleMaxMl` | `UINT` | 250 | const | Total at or below → lane 1 |
| `HeightLaneAMm` | `UINT` | 120 | const |  |
| `HeightLaneBMm` | `UINT` | 180 | const |  |
| `HeightToleranceMm` | `UINT` | 15 | const |  |
| `TankCapacityMl` | `UINT` | 5000 | const | Both tanks |
| `TankRefillThresholdMl` | `UINT` | 800 | const |  |
| `TankRateMlPerS_x10` | `UINT` | 250 | const | 25.0 ml/s. Must not be 0 |
| `TankValveOpeningPct` | `UINT` | 80 | const |  |
| `AoFullScale` | `INT` | 0 | S05 | Raw count at 100% from the slot-2 OF2 page. 0 holds the valve channels at 0 |
| `Tick` | `BOOL` | FALSE | S00 | One scan every 100 ms |
| `NowDs` | `UDINT` | 0 | S00 | 0.1 s since power-up |
| `DownDs` | `UDINT` | 0 | S05 | 0.1 s stopped or blocked (OEE) |
| `TON_Clock` | `TON` |  | S00 | Runs 24 h, read through ET |
| `ClockDays` | `UDINT` | 0 | S00 |  |
| `ClockDs` | `UDINT` | 0 | S00 |  |
| `TON_Pres1` | `TON` |  | S00 | One per presence input |
| `TON_Pres2` | `TON` |  | S00 |  |
| `TON_Pres3` | `TON` |  | S00 |  |
| `TON_Pres4` | `TON` |  | S00 |  |
| `TON_Pres5` | `TON` |  | S00 |  |
| `TON_Pres6` | `TON` |  | S00 |  |
| `TON_Pres7` | `TON` |  | S00 |  |
| `TON_Pres8` | `TON` |  | S00 |  |
| `Pres` | `ARRAY[1..8] OF BOOL` | FALSE | S00 | Debounced presence, by station |
| `StArmed` | `ARRAY[1..8] OF BOOL` | TRUE | S00/S05 | Eye has read 0 since its last arrival |
| `FirePulse` | `BOOL` | FALSE | S00 | Cmd.FirePusher, authorized |
| `SimCircuitOk` | `BOOL` | FALSE | S00 | Simulated safety relay while SimInputs is on |
| `NewMask` | `UINT` | 0 | S00 |  |
| `Want` | `BOOL` | FALSE | S00 |  |
| `NEnabled` | `UINT` | 0 | S00 |  |
| `TankEnabled` | `ARRAY[1..2] OF BOOL` | TRUE | S00 |  |
| `TankEnableMaskCopy` | `UINT` | 3 | S00 |  |
| `TankLevelMl_x10` | `ARRAY[1..2] OF UDINT` | 50000 | S00/S05 |  |
| `TankRefilled` | `ARRAY[1..2] OF BOOL` | FALSE | panel | Operator: tank k refilled (one scan) |
| `TankLowAny` | `ARRAY[1..2] OF BOOL` | FALSE | S00 | Float or estimate below threshold |
| `TankLowPrev` | `ARRAY[1..2] OF BOOL` | FALSE | S00 |  |
| `EvQCode` | `ARRAY[0..15] OF UINT` | 0 | all | Events raised this scan |
| `EvQArg1` | `ARRAY[0..15] OF UINT` | 0 | all |  |
| `EvQArg2` | `ARRAY[0..15] OF UINT` | 0 | all |  |
| `EvQCount` | `UINT` | 0 | all |  |
| `ContId` | `ARRAY[0..7] OF UINT` | 0 | S03/S05 |  |
| `ContState` | `ARRAY[0..7] OF UINT` | 0 | S03/S05 | 0 free, 1 serving, 2 moving, 3 blocked, 10 accepted, 11 rejected, 12 jammed |
| `ContSt` | `ARRAY[0..7] OF UINT` | 0 | S03/S05 | Station 1..8 |
| `ContTimerDs` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContTransitDs` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContFill_x10` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContTarget_x10` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContLane` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContVol1` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContVol2` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContReject` | `ARRAY[0..7] OF UINT` | 0 | S05 |  |
| `ContScanRejected` | `ARRAY[0..7] OF BOOL` | FALSE | S05 |  |
| `ContDoneDs` | `ARRAY[0..7] OF UDINT` | 0 | S05 |  |
| `StOccId` | `ARRAY[1..8] OF UINT` | 0 | S03/S05 | Container id at each station |
| `StHeldId` | `ARRAY[1..8] OF UINT` | 0 | S05 |  |
| `StAwaited` | `ARRAY[1..8] OF BOOL` | FALSE | S05 |  |
| `NextContId` | `UINT` | 1 | S03 |  |
| `ActiveContainers` | `UINT` | 0 | S03/S05 |  |
| `ScanPrev` | `BOOL` | FALSE | S03 |  |
| `ScanStuckDs` | `UINT` | 0 | S03 |  |
| `Stuck` | `BOOL` | FALSE | S03 |  |
| `TrackedAtScan` | `BOOL` | FALSE | S03 |  |
| `TanksOk` | `BOOL` | FALSE | S03 |  |
| `Free` | `INT` | 0 | S03 |  |
| `s` | `INT` | 0 | S03/S05/S07 |  |
| `n` | `INT` | 0 | S05/S07 |  |
| `qi` | `INT` | 0 | S07 |  |
| `b` | `INT` | 0 | S07 |  |
| `Ord` | `ARRAY[0..7] OF INT` | 0 | S05 |  |
| `NOrd` | `INT` | 0 | S05 |  |
| `Target` | `INT` | 0 | S05 |  |
| `St` | `UINT` | 0 | S05 |  |
| `NextSt` | `UINT` | 0 | S05 |  |
| `Done` | `BOOL` | FALSE | S05 |  |
| `Act` | `UINT` | 0 | S05 |  |
| `Fin` | `UINT` | 0 | S05 |  |
| `FinReason` | `UINT` | 0 | S05 |  |
| `T` | `UINT` | 0 | S05 |  |
| `BayVol` | `UINT` | 0 | S05 |  |
| `OpenDs` | `UDINT` | 0 | S05 |  |
| `Amt` | `UDINT` | 0 | S05 |  |
| `Dev` | `UINT` | 0 | S05 |  |
| `FillTol` | `UINT` | 0 | S05 |  |
| `AnyBlocked` | `BOOL` | FALSE | S05 |  |
| `QrPulseDs` | `UINT` | 0 | S05 |  |
| `QrGapDs` | `UINT` | 0 | S05 |  |
| `RejGapDs` | `UINT` | 0 | S05 |  |
| `QrPending` | `BOOL` | FALSE | S05 |  |
| `RejPending` | `BOOL` | FALSE | S05 |  |
| `QrFire` | `BOOL` | FALSE | S05 |  |
| `RejFire` | `BOOL` | FALSE | S05 |  |
| `MovesOn` | `BOOL` | FALSE | S05 |  |
| `RejPulseDs` | `UINT` | 0 | S05 |  |
| `LaneBCmdNext` | `BOOL` | FALSE | S05 |  |
| `LaneBSeen` | `BOOL` | FALSE | S05 |  |
| `StopHeldPrev` | `ARRAY[1..7] OF UINT` | 0 | S05 |  |
| `StopReleaseDs` | `ARRAY[1..7] OF UINT` | 0 | S05 |  |
| `StopRel` | `ARRAY[1..7] OF BOOL` | FALSE | S05 |  |
| `CountAccepted` | `UINT` | 0 | S05 |  |
| `CountRejected` | `UINT` | 0 | S05 |  |
| `CountTotal` | `UINT` | 0 | S05 |  |
| `LaneACount` | `UINT` | 0 | S05 |  |
| `LaneBCount` | `UINT` | 0 | S05 |  |
| `AccDs` | `ARRAY[0..63] OF UDINT` | 0 | S05/S07 | Accept times, throughput window |
| `AccHead` | `UINT` | 0 | S05 |  |
| `AccN` | `UINT` | 0 | S05 |  |
| `FaultLatched` | `ARRAY[1..8] OF BOOL` | FALSE | S04 |  |
| `FaultReq` | `ARRAY[1..8] OF BOOL` | FALSE | S04 |  |
| `FaultCode` | `UINT` | 0 | S04 |  |
| `FaultCount` | `UINT` | 0 | S04 |  |
| `FaultAny` | `BOOL` | FALSE | S04 |  |
| `LineStopSent` | `BOOL` | FALSE | S04 |  |
| `Code` | `INT` | 0 | S04/S05 |  |
| `StCode` | `INT` | 0 | S04 |  |
| `NodeHbLast1` | `UINT` | 0 | S04 |  |
| `NodeHbLast2` | `UINT` | 0 | S04 |  |
| `NodeHbSeen1` | `BOOL` | FALSE | S04 |  |
| `NodeHbSeen2` | `BOOL` | FALSE | S04 |  |
| `NodeHbRestart` | `BOOL` | FALSE | S04 |  |
| `HbSame1` | `BOOL` | FALSE | S04 |  |
| `HbSame2` | `BOOL` | FALSE | S04 |  |
| `TON_ScanNodeHb` | `TON` |  | S04 |  |
| `TON_StationNodeHb` | `TON` |  | S04 |  |
| `ArmSeq` | `UINT` | 0 | S04 |  |
| `ArmPendingCmd` | `UINT` | 0 | S04 |  |
| `ArmPendingTarget` | `UINT` | 0 | S04 |  |
| `ArmPickFailures` | `UINT` | 0 | S04 |  |
| `ArmFault` | `UINT` | 0 | S04 |  |
| `ArmIssue` | `UINT` | 0 | S04 |  |
| `ArmIssueTarget` | `UINT` | 0 | S04 |  |
| `ArmPending` | `BOOL` | FALSE | S04 |  |
| `ArmNeedHome` | `BOOL` | TRUE | S04 |  |
| `ArmPlacing` | `BOOL` | FALSE | S04 |  |
| `ArmHomed` | `BOOL` | FALSE | S04 |  |
| `ArmLidHeld` | `BOOL` | FALSE | S04 |  |
| `CapOutcomeId` | `UINT` | 0 | S04/S05 |  |
| `CapOutcome` | `UINT` | 0 | S04/S05 | 1 capped, 2 failed |
| `ScanHeldId` | `UINT` | 0 | S03/S05 |  |
| `CapHeldId` | `UINT` | 0 | S05 |  |
| `QcHeldId` | `UINT` | 0 | S05 |  |
| `ScanReady` | `BOOL` | FALSE | S04 |  |
| `SortReady` | `BOOL` | FALSE | S04 |  |
| `ScanReadyId` | `UINT` | 0 | S04 |  |
| `ScanParseResult` | `UINT` | 0 | S04 |  |
| `ScanTotalMl` | `UINT` | 0 | S04 |  |
| `ScanLane` | `UINT` | 0 | S04 |  |
| `SortReadyId` | `UINT` | 0 | S04 |  |
| `ScanVolMl` | `ARRAY[1..2] OF UINT` | 0 | S04 |  |
| `SortMeasuredLane` | `INT` | 0 | S04 | -1 unknown |
| `i` | `INT` | 0 | S04/S05/S07 |  |
| `j` | `INT` | 0 | S04/S05 |  |
| `k` | `INT` | 0 | all |  |
| `Len` | `INT` | 0 | S04 |  |
| `First` | `INT` | 0 | S04 |  |
| `Last` | `INT` | 0 | S04 |  |
| `NF` | `INT` | 0 | S04 |  |
| `Digits` | `INT` | 0 | S04 |  |
| `NVol` | `INT` | 0 | S04 |  |
| `TankCount` | `INT` | 0 | S04 |  |
| `Result` | `INT` | 0 | S04 |  |
| `H` | `INT` | 0 | S04 |  |
| `OffA` | `INT` | 0 | S04 |  |
| `OffB` | `INT` | 0 | S04 |  |
| `Tol` | `UINT` | 0 | S04/S05 |  |
| `Ch` | `ARRAY[0..65] OF USINT` | 0 | S04 |  |
| `FS` | `ARRAY[1..5] OF INT` | 0 | S04 |  |
| `FE` | `ARRAY[1..5] OF INT` | 0 | S04 |  |
| `Vol` | `ARRAY[0..7] OF UINT` | 0 | S04 |  |
| `Acc` | `UDINT` | 0 | S04 |  |
| `Total` | `UDINT` | 0 | S04 |  |
| `Sum` | `UDINT` | 0 | S04 |  |
| `Neg` | `BOOL` | FALSE | S04 |  |
| `AnyNeg` | `BOOL` | FALSE | S04 |  |
| `Gap` | `BOOL` | FALSE | S04 |  |
| `EvSeq` | `UINT` | 0 | S07 |  |
| `PrevDigital` | `BOOL` | FALSE | S07 |  |
| `PrevEntry` | `BOOL` | FALSE | S07 |  |
| `PrevExit` | `BOOL` | FALSE | S07 |  |
| `PrevLocal` | `BOOL` | FALSE | S07 |  |
| `PrevRunCmd` | `BOOL` | FALSE | S07 |  |
| `PrevSafetyOK` | `BOOL` | FALSE | S07 |  |
| `PrevJogBelt` | `BOOL` | FALSE | S07 |  |
| `BNow` | `BOOL` | FALSE | S07 |  |
| `BWas` | `BOOL` | FALSE | S07 |  |
| `HmiHbLast` | `UINT` | 0 | S07 |  |
| `HmiSame` | `BOOL` | FALSE | S07 |  |
| `TON_HmiLink` | `TON` |  | S07 |  |
| `HmiLinkOk` | `BOOL` | FALSE | S07 |  |
| `Bit4` | `BOOL` | FALSE | S07 |  |
| `NTanks` | `UINT` | 0 | S07 |  |
| `NRecent` | `UINT` | 0 | S07 |  |
| `SpanS` | `REAL` | 0 | S07 |  |
| `Rv` | `REAL` | 0 | S07 |  |
| `ElapsedS` | `REAL` | 0 | S07 |  |
| `DownS` | `REAL` | 0 | S07 |  |
| `RateMlS` | `REAL` | 0 | S07 |  |
| `IdealS` | `REAL` | 0 | S07 |  |
| `Avail` | `REAL` | 0 | S07 |  |
| `OperS` | `REAL` | 0 | S07 |  |
| `Perf` | `REAL` | 0 | S07 |  |
| `Qual` | `REAL` | 0 | S07 |  |
| `Overall` | `REAL` | 0 | S07 |  |
| `Flags` | `UINT` | 0 | S07 |  |
| `Row` | `INT` | 0 | S07 |  |
| `Pass` | `INT` | 0 | S07 |  |
| `LastId` | `UINT` | 0 | S07 |  |
| `Pick` | `INT` | 0 | S07 |  |
| `Status` | `UINT` | 0 | S07 |  |
| `AoOut` | `INT` | 0 | S05 | Valve angle raw count this scan |
