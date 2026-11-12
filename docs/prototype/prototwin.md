# ProtoTwin plant (virtual PLC)

ProtoTwin can stand in for the physical line: its 3D model owns the presence sensors and moves the cans, and the virtual PLC runs the line logic against it over Modbus TCP. This is development stage 2 with a 3D plant instead of the twin's travel timers. It does not change the Micro850 program or the register map the bridge, HMI and FUXA use.

> D8 in [bom.md](bom.md) dropped ProtoTwin as a required tool. This page is optional: nothing else in the repo depends on it.

## How it works

```
ProtoTwin (Simulate + Connect)            virtual PLC (twin/, port 5020)
  presence sensors  ── Plant.*_Present ──▶  arrivals wait for each sensor's rising edge
  conveyor, stoppers ◀── Plant.O_* ───────  belt, valves, pushers, press, sort gate, stoppers, stack light
  arm animation      ◀── Plant.ArmMotion ─
```

- **Plant.Mode = 1** (or start the PLC with `VPLC_PLANT=1`): the PLC stops its own bottle feed. ProtoTwin loads the cans; each rising edge of the SCAN sensor admits one can.
- **Arrivals.** A can reaches a station when that station's sensor goes 0 → 1, not when the travel timer runs out. A can that never reaches the next sensor jams after twice `sensorWaitTimeoutSec` (12 s).
- **Partial models.** `Plant.SensorMask` says which sensors ProtoTwin models. Stations whose bit is 0 keep the timer, so you can start with SCAN and the two bays and add the rest later.
- **Stoppers** follow the Micro850 ladder (instruction-manual.md §8): 1 = retracted. SCAN always catches a can. Another station catches a can only when the PLC has work for it there; otherwise the can rides through. After a station finishes, its stopper retracts until the sensor clears (2 s at most).
- **Pushers** (QR ejector, fill-reject pusher) are held on for 1 s.
- The scanner and station ESP32 nodes stay simulated unless `VPLC_NODES` says otherwise ([esp32.md](esp32.md)).

## Run it

```bash
cd twin
VPLC_PLANT=1 npm run virtual-plc      # Modbus TCP on 0.0.0.0:5020, unit id 1
```

On Windows PowerShell: `$env:VPLC_PLANT=1; npm run virtual-plc`.

Run the HMI against it as usual (`npm run dev` from the repo root with the bridge pointed at port 5020) to watch counts and events while ProtoTwin runs.

## ProtoTwin setup

1. Install **ProtoTwin Connect** (desktop app). The web app alone cannot reach a Modbus device.
2. Add a **Modbus TCP** device: the PC running the virtual PLC (127.0.0.1 on the same PC), port **5020**, unit id **1**.
3. Every signal below is one **holding register** with value 0 or 1 (`Plant.ArmMotion` and `Plant.ScanContainerId` are small integers). Addresses are 0-based; use the Modicon column if ProtoTwin asks for 4xxxx references.
4. In the scene, for each station:
   - a **sensor** (trigger volume) at the station, about one can wide, wired to its `Plant.*_Present` register;
   - a **stopper**: a thin kinematic box across the belt, raised when its `Plant.O_*_Stopper` register is **0** and lowered when it is **1**.
5. The belt's Transport Surface motor runs at **0.2 m/s** while `Plant.O_Belt_Run` = 1 (the twin's `beltSpeedMPerSec`). Space the stations 0.5 m apart as in `config.ts`, or change `stationSpacingM` and `positionM` to match the model.
6. Pistons: the QR ejector, lid press and fill-reject pusher are prismatic joints driven by their `O_*_Extend` registers. The sort gate is a hinge driven by `Plant.O_SortDiverter_LaneB`.
7. Write **Plant.Mode = 1** from ProtoTwin at start, or start the PLC with `VPLC_PLANT=1`.
8. Spawn a can upstream of SCAN every few seconds. The line starts running (`startRunning`), so the green light and belt come on at once.

## Signals

| 460 | 40461 | `Plant.Mode` | ProtoTwin → PLC | 1 = the external plant (ProtoTwin) owns the presence sensors and loads the cans; the virtual PLC stops its own feed timer and waits for each sensor. |
| 461 | 40462 | `Plant.SCAN_Present` | ProtoTwin → PLC | Presence sensor at SCAN (I_SCAN_Present on the Micro850). Written by the plant. |
| 462 | 40463 | `Plant.BAY1_Present` | ProtoTwin → PLC | Presence sensor at BAY-1 (I_BAY1_Present on the Micro850). Written by the plant. |
| 463 | 40464 | `Plant.BAY2_Present` | ProtoTwin → PLC | Presence sensor at BAY-2 (I_BAY2_Present on the Micro850). Written by the plant. |
| 464 | 40465 | `Plant.CAP_Present` | ProtoTwin → PLC | Presence sensor at CAP (I_CAP_Present on the Micro850). Written by the plant. |
| 465 | 40466 | `Plant.PRESS_Present` | ProtoTwin → PLC | Presence sensor at PRESS (I_PRESS_Present on the Micro850). Written by the plant. |
| 466 | 40467 | `Plant.QC_Present` | ProtoTwin → PLC | Presence sensor at QC (I_QC_Present on the Micro850). Written by the plant. |
| 467 | 40468 | `Plant.GATE_Present` | ProtoTwin → PLC | Presence sensor at GATE (I_GATE_Present on the Micro850). Written by the plant. |
| 468 | 40469 | `Plant.SORT_Present` | ProtoTwin → PLC | Presence sensor at SORT (I_SORT_Present on the Micro850). Written by the plant. |
| 470 | 40471 | `Plant.SensorMask` | ProtoTwin → PLC | bit i = the plant models sensor i (order as above). Stations whose bit is 0 keep the twin's travel timer. 0 = all sensors. |
| 480 | 40481 | `Plant.O_Belt_Run` | PLC → ProtoTwin | Conveyor running. |
| 481 | 40482 | `Plant.O_Valve_T1_Open` | PLC → ProtoTwin | Tank T1 valve open (dispensing at BAY-1). |
| 482 | 40483 | `Plant.O_Valve_T2_Open` | PLC → ProtoTwin | Tank T2 valve open (dispensing at BAY-2). |
| 483 | 40484 | `Plant.O_QrReject_Extend` | PLC → ProtoTwin | Scan-gate ejector out (bad QR), held 1 s. |
| 484 | 40485 | `Plant.O_LidPress_Extend` | PLC → ProtoTwin | Lid-press cylinder down. |
| 485 | 40486 | `Plant.O_RejectDiverter_Extend` | PLC → ProtoTwin | Fill-reject pusher out, held 1 s. |
| 486 | 40487 | `Plant.O_SortDiverter_LaneB` | PLC → ProtoTwin | Sort gate set to Lane 2 for the next can. |
| 487 | 40488 | `Plant.O_Stack_Green` | PLC → ProtoTwin | Running. |
| 488 | 40489 | `Plant.O_Stack_Amber` | PLC → ProtoTwin | Stopped or reset required. |
| 489 | 40490 | `Plant.O_Stack_Red` | PLC → ProtoTwin | E-Stop or latched fault. |
| 490 | 40491 | `Plant.O_SCAN_Stopper` | PLC → ProtoTwin | Stopper at SCAN: 1 = retracted (can passes), 0 = extended (can held). |
| 491 | 40492 | `Plant.O_BAY1_Stopper` | PLC → ProtoTwin | Stopper at BAY-1: 1 = retracted (can passes), 0 = extended (can held). |
| 492 | 40493 | `Plant.O_BAY2_Stopper` | PLC → ProtoTwin | Stopper at BAY-2: 1 = retracted (can passes), 0 = extended (can held). |
| 493 | 40494 | `Plant.O_CAP_Stopper` | PLC → ProtoTwin | Stopper at CAP: 1 = retracted (can passes), 0 = extended (can held). |
| 494 | 40495 | `Plant.O_PRESS_Stopper` | PLC → ProtoTwin | Stopper at PRESS: 1 = retracted (can passes), 0 = extended (can held). |
| 495 | 40496 | `Plant.O_QC_Stopper` | PLC → ProtoTwin | Stopper at QC: 1 = retracted (can passes), 0 = extended (can held). |
| 496 | 40497 | `Plant.O_GATE_Stopper` | PLC → ProtoTwin | Stopper at GATE: 1 = retracted (can passes), 0 = extended (can held). |
| 497 | 40498 | `Plant.ArmMotion` | PLC → ProtoTwin | Arm move in progress: 0 idle, 1 HOME, 2 PICK_LID, 3 PLACE_LID. |
| 498 | 40499 | `Plant.ScanContainerId` | PLC → ProtoTwin | Container id held at SCAN, 0 = none. |

## Checked by

`twin/src/test/plant.test.ts` runs a small physics plant against the virtual PLC through these registers only: cans ride the belt, stoppers catch them, pushers remove rejects, and at least five cans finish with no jams.
