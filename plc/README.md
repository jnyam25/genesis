# Genesis Micro850 PLC program

Connected Components Workbench project for the line supervisor: the team's Allen-Bradley Micro850, catalog **2080-L50E-24QBB**.

Nothing here has been downloaded to the controller yet. Build the project in Connected Components Workbench by following [instruction-manual.md](instruction-manual.md). The functional specification is [docs/prototype/micro850-plc.md](../docs/prototype/micro850-plc.md). When a rule and the virtual PLC disagree, match the virtual PLC ([`twin/src/plc/virtual-plc.ts`](../twin/src/plc/virtual-plc.ts)). Addresses come from [`twin/src/plc/tag-map.ts`](../twin/src/plc/tag-map.ts) (protocol version 4).

## Open the project

[genesis.ccwsln](genesis.ccwsln) is a CCW 22 solution in the same layout as a Micro850 lab project: the solution file, `Controller\Controller.acfproj`, and `Controller\Controller\` (the program, the variable database, and the controller configuration). Open that `.ccwsln` in Connected Components Workbench. CCW will not open the solution file on its own if the `Controller` folder is missing.

The solution is already catalog **2080-L50E-24QBB**, firmware 22.100. `Prog1` is the Genesis ladder. Rung comments mark S00 (embedded and expansion inputs), S01 (E-Stop and the run seal), S02 (START, STOP, RESET, and jog), and S06 (field outputs). Barcode parsing, the arm sequencer, the station machines, and the Modbus publish are not in this ladder.

A 2085 expansion module is inputs or outputs, so the extra points are two modules. The first slot is a **2085-IQ16** (`_IO_X1_`). The second is a **2085-OB16** (`_IO_X2_`). Add both on the controller graphic before you build, then confirm those names. If CCW generates a different prefix, retarget the contacts. The two valve angles still need one **2080-OF2** in a plug-in slot; that analog is not in this ladder.

`Prog1`'s variables are in the project database. Leave **Retained** clear on `RunCmd` and `DigitalEStop`. `SimInputs` stays FALSE. Each rung label is unique (`S07_267` and the rest); CCW treats the first comment on a rung as that label. The first-scan contact is `__SYSVA_FIRST_SCAN`. `X1_DI_00` through `X1_DI_09` and `X2_DO_00` through `X2_DO_09` are stand-in variables. CCW rejects a user variable whose name starts with `_IO_`. After the 2085-IQ16 and 2085-OB16 are on the controller graphic, point those contacts at the real `_IO_X1_DI_` and `_IO_X2_DO_` points and delete the stand-ins. Read [safety.md](../docs/prototype/safety.md) before any download. Motion outputs stay off unless the line is running or a jog is held, and they stay off while `SimInputs` is on.

The eight programs below are still the scan order in the specification. `Prog1` covers the I/O and safety part of S00, S01, S02, and S06. Its last rungs clear the command coils and publish the words the bridge and FUXA require: protocol version 4, the 100 ms heartbeat, `Sys.LineState`, the physical E-Stop mask, tank count 2, and `Station.RunPermit`. Counts, OEE, containers and events stay 0 until the station programs exist. Add S03, S04, S05, and the rest of S07 inside CCW. A station bit written by a later program moves its output on the next scan.

| Order | Program | Job |
| --- | --- | --- |
| 1 | `S00_Inputs` | Copy bridge and ESP32 writes out of `MB_*`; debounce sensors; tank levels |
| 2 | `S01_SafetyMode` | E-Stop, reset, run state, LOCAL/REMOTE |
| 3 | `S02_Commands` | Command coils and the tank-enable mask; clear each coil in the scan it is handled |
| 4 | `S03_Admission` | A can at SCAN with a free slot becomes a container |
| 5 | `S04_Supervisor` | Node supervision, fault latch, barcode validation, arm sequencer, sort classification |
| 6 | `S05_Stations` | One state machine per station |
| 7 | `S06_Outputs` | Field outputs. Motion outputs stay off while the line is not running |
| 8 | `S07_Publish` | Heartbeat, counters, OEE, container table, event ring, then copy into `MB_*` |

Map only the `MB_*` arrays to Modbus (specification §2). Publish `Sys.ProtocolVersion` = 4, and change that constant only together with `tag-map.ts`.
