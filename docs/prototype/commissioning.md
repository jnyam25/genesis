# Commissioning

A staged bring-up. **Don't skip a stage.** Each one adds one layer and has pass criteria. Record results (date, who, pass/fail, notes) in a copy of this checklist.

Before stage 3, the [safety](safety.md) measures must be in place: E-Stop chain wired and tested, guards fitted, lockout points identified.

---

## 1. Stage 1: software on a PC

| # | Check | Pass criteria |
| --- | --- | --- |
| 1.1 | `npm install`, then `npm run doctor` | All checks ✓ |
| 1.2 | `npm test` | All tests pass |
| 1.3 | `npm run typecheck` and `npm run lint` | No errors |
| 1.4 | `npm run dev`, open `http://localhost:43123` | Dashboard live. Containers go label → scan → fill-1..3 → cap → press → qc → sort → output, split between lane A and lane B. About 1 in 4 rides through unfilled and is rejected at the reject diverter (the sample barcode `PT1\|T200\|200`) |
| 1.5 | Controls → simulated panel: **press** the Line exit E-Stop | Red banner on every screen: "EMERGENCY STOP — Physical E-Stop pressed at Line exit"; nav shows E-STOP ACTIVE; counts freeze; Start/Jog/Fire reject diverter/tank buttons disabled with reasons |
| 1.5a | Press the nav **E-STOP** (digital) as well, then release the Line exit button | Banner lists the Digital E-Stop; Reset is refused ("an emergency stop is active") |
| 1.5b | Release digital E-Stop; try HMI Reset | Amber "Safety reset required … at the local control panel"; HMI Reset disabled/refused |
| 1.5c | Simulated panel **RESET**, then HMI **Start** | Banner changes to "Line stopped", then disappears; line runs |
| 1.5d | Key switch **LOCAL** | Blue "LOCAL CONTROL" banner; line stops; HMI Start/Jog/Fire reject diverter/tanks refused (tank colour edits still allowed); HMI Stop and E-STOP still work; panel START runs the line |
| 1.5e | Repeat 1.5 with the **Line entry** and **Local control panel** E-Stops | Each banner names that location |
| 1.6 | Controls: add tank, remove T2, add tank | T4 appears, then T2 is removed and re-added in slot order. No stream of rejects afterwards |

## 2. Stage 2: monitoring PC against the virtual PLC

The virtual PLC ([`virtual-plc.ts`](../../twin/src/plc/virtual-plc.ts)) serves the simulated line on the exact register map the Micro850 will implement, so this stage tests the whole Modbus path before the PLC is programmed.

| # | Check | Pass criteria |
| --- | --- | --- |
| 2.1 | On a PC: `npm run virtual-plc` (firewall allows 5020) | Log shows `Modbus TCP server on 0.0.0.0:5020` |
| 2.2 | Monitoring PC (or Pi, [raspberry-pi.md](raspberry-pi.md)) with `PLC_HOST=<PC IP>`, `PLC_PORT=5020`, `PLC_COIL_BASE=0` | `curl 127.0.0.1:43124/health` shows `online: true` |
| 2.3 | Open the HMI from an operator device | Live data. Repeat 1.5–1.6 through the bridge: identical behaviour and messages |
| 2.4 | Stop the virtual PLC | Within 3 s the HMI shows "Feed stale" and `/health` gives a reason. Restart it: recovers by itself |
| 2.5 | Point ESP32 firmware at the virtual PLC (`<PC IP>:5020`) | Scanner node recipes are acknowledged (`Recipe.AckSeq`); station node sees `Station.*Request` ids and `Station.RunPermit` |

## 3. Stage 2: FUXA SCADA against the virtual PLC

Set up FUXA per [scada.md §5](scada.md#5-setting-up-fuxa), with the virtual PLC still running.

| # | Check | Pass criteria |
| --- | --- | --- |
| 3.1 | `cd deploy/fuxa`, `docker compose up -d`, open `http://localhost:1881` | FUXA editor loads; version 1.3.4 |
| 3.2 | Add the Modbus TCP device (`host.docker.internal:5020`, slave id 1) and the system-block tags | Device connected. FUXA address 1 (`Sys.ProtocolVersion`) reads `3`; address 2 (`Sys.PlcHeartbeat`) keeps changing |
| 3.3 | Tags for every register in 0–67 and 200–232; capture with Wireshark (filter `tcp.port == 5020 && modbus`) | FUXA's connection sends one read per block per poll and no writes (no function codes 5, 6, 15 or 16) |
| 3.4 | Simulated Line exit E-Stop from the HMI | FUXA's E-Stop alarm is active within 1 s and clears after release, reset and start |
| 3.5 | Let the trends log for an hour, then `docker compose restart` | History is still there |
| 3.6 | Stop the virtual PLC | FUXA shows the device disconnected and raises the heartbeat alarm; the web HMI is unaffected apart from its own stale-feed banner |

## 4. Stage 3: real PLC, no field devices

Field output power is **off** (safety relay not reset). The PLC runs with `SimInputs = 1` ([micro850-plc.md §9](micro850-plc.md#9-test-mode-inputs)).

| # | Check | Pass criteria |
| --- | --- | --- |
| 4.1 | Ping the PLC from the monitoring PC; a Modbus tool reads holding register 0 (CCW address 400001, `MB_Sys[0]`) | `Sys.ProtocolVersion = 3` |
| 4.2 | Compare a register dump with the virtual PLC for the same situation (idle, 3 tanks) | Same addresses populated and same scaling: `Tank1.CapacityMl = 5000`, `Tank1.Flags` bit0 = 1, `Tank1.ValveOpeningPct = 80`, `Sys.TankEnableMask = 7` |
| 4.3 | `Sys.PlcHeartbeat` read twice, 1 s apart | Increased by ≥ 1 |
| 4.4 | Bridge with `PLC_HOST=<plc ip>`, `PLC_PORT=502`, `PLC_COIL_BASE=0` | `/health` shows `online: true`; `hmiLinkOk` true within 3 s; HMI Stop sets `MB_Cmd[5]` for one scan (watch it in CCW's variable monitor, [micro850-plc.md §2](micro850-plc.md#2-modbus-address-mapping)) |
| 4.5 | With a simulated bottle at SCAN, write a test recipe with a Modbus tool (fields at 301–306, then Seq at 300) | `Recipe.AckSeq` follows. The container walks through its statuses on the HMI; `Station.LabelRequest/CapRequest/PressRequest` show its id in turn |
| 4.6 | Commands from the HMI: start, stop, jog while stopped, fire reject diverter at QC, add/remove tank | Each produces the events in [micro850-plc.md §6/§7](micro850-plc.md#6-safety-and-control-authority-logic-s01_safetymode), and coils read back 0 |
| 4.6a | `SimInputs` = 1: repeat 1.5–1.5e using the HMI's simulated panel | Same banners, refusals and events as the virtual PLC; `LineState` bits 1, 5–8 follow each step |
| 4.6b | HMI digital E-STOP; measure `O_Safety_RemoteEStopOK` | Output de-energizes within 500 ms of the click; stays off until "Release digital E-Stop" |
| 4.6c | Unplug the PLC's output connector for `O_Safety_RemoteEStopOK` (or put the PLC in Stop/Program mode) | Safety circuit opens (fail-safe) |
| 4.7 | Write `Sys.TankEnableMask = 0` with a Modbus tool | Mask restored; event `TANK_CHANGE_REFUSED` |
| 4.8 | Unplug the monitoring PC's Ethernet for 10 s | PLC keeps its state; `HMI_LINK_OK` = 0; stack light amber; **local panel still fully operates the line** (LOCAL). Reconnect: bit returns and the HMI recovers |
| 4.8a | Point FUXA at `192.168.10.10:502` with the bridge, both ESP32 nodes and a Modbus tool connected | All stay connected; FUXA address 1 reads `3`; the bridge's poll latency doesn't change noticeably |
| 4.9 | PLC to Stop/Program mode | Bridge reports "PLC heartbeat stopped"; HMI stale; ESP32 nodes stop their actuators within 1 s |

## 5. Stage 4: field devices, dry (water only)

`SimInputs = 0`. Tanks empty or filled with **water**. One device at a time.

| # | Check | Pass criteria |
| --- | --- | --- |
| 5.1 | **Physical E-Stop test:** press **each** E-Stop button (panel, line entry, line exit) in turn while the belt runs and a valve dispenses | All motion stops immediately (hardware, before any software): belt, valve shutoff solenoids, diverters, lid press, label applicator, arm servo supply. The HMI names **that** button's location within 1 s; `Sys.PhysicalEStopMask` shows the right bit; event `PHYSICAL_ESTOP_PRESSED` |
| 5.1a | **Digital E-Stop test:** click E-STOP on the HMI while running | Safety relay opens (hear it, check its LEDs) if the interposing relay is fitted ([bom.md D2](bom.md#6-open-decisions-for-the-team)); all motion stops; the HMI shows "Digital E-Stop active" |
| 5.1b | Try to restart while the E-Stop is held/latched: panel RESET, panel START, HMI Start | Nothing moves; the reset and start refusals appear on the HMI |
| 5.1c | Release the E-Stop, **don't** reset; press START | Nothing moves ("reset required") |
| 5.1d | Reset at the panel | Line does **not** start by itself; START needed |
| 5.1e | Hold RESET pressed, then press and release an E-Stop | Relay does **not** auto-reset (edge-triggered reset) |
| 5.1f | Force a weld: jumper the interposing relay's NO contacts, trigger the digital E-Stop, try to reset | Safety relay refuses reset (feedback loop), or the PLC flags `I_Safety_RemoteRelay_Fb` discrepancy |
| 5.1g | Break the STOP push-button wire while running | Line stops (NC wiring) |
| 5.1h | Key switch LOCAL ↔ REMOTE while running | Line stops each time; authority follows the key (see [safety.md §3](safety.md#3-control-authority-local-vs-remote)) |
| 5.1i | Unpower ESP32 #2 while the arm is moving | Arm servo supply is still cut by the safety relay on an E-Stop; with the node off, the PLC raises FAULT and holds CAP |
| 5.2 | Open each interlocked guard (arm, press) | Same as 5.1 |
| 5.3 | Each presence sensor: place a container | Correct `I_*_Present` input only |
| 5.4 | Each stopper (if fitted): toggle its output with a guard in place | Retracts when ON; extends when OFF **and on power loss**. Single-bottle line: the belt stops with the bottle at each station instead |
| 5.5 | Belt direction and speed | Moves toward the line exit; measured speed ≈ `beltSpeedMPerSec` (±10%) |
| 5.6 | Reject diverter and sort diverter | Full stroke, return home, home switch made within 1 s; sort diverter rests on lane A |
| 5.7 | Each valve: command 0 %, `ValveOpeningPct`, 0 % with the shutoff solenoid energized; then cut power at 50 % open | Angle follows the command; with power cut, **no flow** (shutoff solenoid closed) |
| 5.8 | Low float on each tank | `I_Tank<k>_Low` = 1 below the float; `TANK_LOW` event |
| 5.9 | ESP32 scanner node: label applicator + scanner | Label applied only while `Station.RunPermit` = 1; the three sample barcodes give ParseResult 0, 0, 3 on a 3-tank line |
| 5.10 | ESP32 station node: arm, press, sort sensor | Each station runs once per `Request` id and writes `Done`; dropping `RunPermit` mid-move parks the arm and retracts the press; the sort sensor reports type 1 for a small bottle and 2 for a large one |

## 6. Stage 4: wet run

| # | Check | Pass criteria |
| --- | --- | --- |
| 6.1 | Valve calibration, each tank, at its `ValveOpeningPct` ([io-map.md](io-map.md#calibration-values-per-tank)) | Three 30 s runs agree within ±2%; enter the rate in the PLC and `config.ts`. Re-check with the tank half empty (gravity feed slows as the level drops) |
| 6.2 | Dispense accuracy: 10 containers with `PT1\|T250\|100,80,70`, weigh each | Every net volume within the QC tolerance (±`dispenseVariance` + 1%); the PLC's accept decision matches the scale |
| 6.3 | Refill: dispense until a tank's low float trips, refill by hand, press "Tank refilled" on the touch panel | `TANK_LOW` holds recipes that need the tank; after the refill button the level estimate resets and `TANK_REFILLED` is recorded |
| 6.4 | Throughput: 15 minutes of continuous feed | No jams. `Counts.Total` matches a manual count; `Counts.LaneA + Counts.LaneB` = accepted. Throughput and OEE on the HMI are plausible |
| 6.5 | Recovery: Stop mid-dispense, then Start | Valve resumes the remaining time; the container is still accepted |
| 6.5a | Recovery: physical E-Stop mid-dispense, release, local reset, Start | Valve resumes the remaining time; no double dose; the container is accepted if within tolerance |
| 6.6 | Jam: hold a container at a bay by hand | JAMMED after the timeout, station released, line continues |
| 6.7 | Leak check after the run | No drips on electronics; spill tray dry except at nozzles |

## 7. Handover

- [ ] All stages passed and recorded.
- [ ] `config.ts` calibration values match the PLC (commit them).
- [ ] PLC program exported and version-tagged together with the repo commit (`Sys.ProtocolVersion` = `tag-map.ts`).
- [ ] Network diagram with the final IPs added to this folder.
- [ ] Operators trained on [../operator-guide.md](../operator-guide.md): Stop vs E-Stop, physical vs digital E-Stop, the reset-at-the-machine rule, and LOCAL/REMOTE authority.
- [ ] E-Stop tests 5.1–5.1i repeated and recorded after any change to the safety wiring or PLC safety logic.
