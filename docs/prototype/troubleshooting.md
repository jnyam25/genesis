# Troubleshooting the prototype

Start with the health endpoint on the monitoring PC (or Pi). It tells you which layer is failing:

```bash
curl -s http://127.0.0.1:43124/health
```

| `/health` shows | Layer | Go to |
| --- | --- | --- |
| Connection refused | Twin service not running | §1 |
| `"mode": "sim"` | Wrong mode | Set `CAPTSONE_MODE=plc` in `/etc/captsone/captsone.env`, restart |
| `online: false`, `reason: "connecting to PLC …"` | Network / Modbus | §2 |
| `online: false`, `reason: "PLC heartbeat stopped …"` | PLC program | §3 |
| `online: false`, `reason: "PLC register map version …"` | Version mismatch | §3 |
| `online: true` but the HMI is stale | HMI service / browser | §4 |
| `online: true`, `safetyOk: false` | Safety circuit | §5 |
| `online: true`, `LineState` bit3 FAULT set, or the HMI shows "FAULT: …" | Station fault (`Sys.FaultCode`) | §6 |
| The web HMI works but FUXA doesn't | FUXA SCADA | §7 |

## 1. Twin service

| Symptom | Fix |
| --- | --- |
| `systemctl status captsone-twin` shows failed | `journalctl -u captsone-twin -n 50`. Common causes: `PLC_HOST` missing, wrong Node path in the unit file (nvm installs), `dist/` missing (run `npm run build`) |
| `port 43124 is already in use` | Another instance is running (e.g. a manual `npm run dev`). Stop it |

## 2. PLC link (Modbus TCP)

| Symptom | Fix |
| --- | --- |
| Can't ping the PLC | Cable, switch, IP/subnet. The monitoring PC's control-side NIC must be on the control subnet |
| Ping works, Modbus times out | The Modbus TCP server isn't enabled in the CCW project (Controller → Ethernet → Modbus TCP), the project with the Modbus mapping wasn't downloaded, the port isn't 502, or the Micro850's 16 server connections are used up (ESP32 nodes reconnecting without closing old sockets) |
| Modbus exception 2 (illegal data address), or zeros, on reads | A block the bridge reads (0–19, 20–67, 100–139, 200–232) isn't fully covered by the Micro850's Modbus mapping. Map each block as one array ([micro850-plc.md §2](micro850-plc.md#2-modbus-address-mapping)) |
| Modbus exception 2 on **commands** only | Coils 0–15 aren't mapped (`MB_Cmd` at CCW address 000001), or `PLC_COIL_BASE` isn't `0` |
| Values look ×10 / ×100 off | Scaling mismatch: compare against the `Unit` column |
| Everything is off by one address | Addressing convention: the PDU address N is CCW address 400001 + N (Modicon 40001 + N). A mapping that starts at 400000 or 400002 shifts every register |
| Intermittent offline | Poll period too fast for the PLC or network (`PLC_POLL_MS=500`); Wi-Fi in the path; duplicate IP |

## 3. PLC program

| Symptom | Fix |
| --- | --- |
| Heartbeat stopped | PLC in Stop/Program mode or faulted, or the publish subroutine isn't being called |
| Version mismatch | `Sys.ProtocolVersion` must equal `PROTOCOL_VERSION` in `twin/src/plc/tag-map.ts` (currently 4). Also reflash the ESP32 nodes after a map change: their `captsone_registers.h` is generated from `tag-map.ts` by `npm run tag-map` |
| Commands do nothing | Wrong `PLC_COIL_BASE`; PLC doesn't reset coils (the next press has no rising edge); reset refused because `SAFETY_OK = 0`; START refused because a station fault is latched (reason 9, see §6) |
| Containers never get a recipe | Scan mailbox: the scanner node must write `Scan.Done` = `Scan.Request` (after `Scan.Status`, `Scan.Length` and `Scan.Text`). Then check `Scan.ParseResult` for that `Scan.ResultId`: non-zero means the PLC rejected the barcode (7 = NO_READ, 3 = the volume count doesn't match `Sys.TankCount`). The node only forwards raw text; the validation is the PLC's |
| Every container JAMMED at the same station | Presence sensor not seen (wiring, alignment, debounce), stopper not releasing, or timeout too short for the belt speed. At LABEL, SCAN, CAP or QC: the ESP32 node didn't report within `stationNodeTimeoutSec` (15 s); check its serial console |
| Every container rejected with "station fault" at LABEL or CAP | The ESP32 node isn't writing `Station.LabelDone` with the request id, or the arm failed a `PLACE_LID` (check `Station.ArmResult`). Usually a fault is latched too (§6) |
| Every container rejected as "bottle type mismatch" | `Station.SortHeightMm` is 0 (no valid reading) or not within ±`sort.heightToleranceMm` (15 mm) of the lane heights in `config.sort` (defaults 120 mm and 180 mm). Measure the real bottles and update the heights in the PLC and `config.ts`; check the VL53L1X mounting distance on the station node (`tof_mount`) with its console `height` command |
| Events missing on the HMI | The PLC must shift the ring and increment `LastSeq` for every event; Seq must never be 0 |

## 4. HMI

| Symptom | Fix |
| --- | --- |
| Red/Green/Blue tanks instead of the real ones | The HMI was built with the mock source. Rebuild with `npm run build` at the repo root, then restart `captsone-hmi` |
| "Feed stale" while `/health` is online | `TWIN_HTTP_URL` in the env file doesn't point at the twin service. Check `http://<pi>:43123/api/twin/state`: a 502 includes the reason |
| Can't reach the HMI from another device | Firewall (allow 43123), wrong network, or the service is bound to localhost |

## 5. Field and safety

| Symptom | Fix |
| --- | --- |
| Red "EMERGENCY STOP" banner won't clear | Release **every** pressed physical button (the banner names them) **and** the digital E-Stop (Controls → Release digital E-Stop) |
| "Safety reset required" stays after pressing RESET | The safety relay didn't reset: an E-Stop channel is still open, the interposing relay is still de-energized (digital E-Stop latched in the PLC), the relay's feedback loop is open (welded contactor or K_REMOTE), or RESET is wired to the PLC only. Check the relay's LEDs |
| HMI Reset button disabled / "reset must be done at the local control panel" | By design (`remoteResetAllowed = false`). Reset at the machine |
| HMI Start refused "local control is active" | Key switch on LOCAL. Use the panel START, or turn the key to REMOTE |
| Panel START does nothing | Key on REMOTE (panel START disabled), reset required, or an E-Stop active. The HMI event log shows the refusal reason |
| Digital E-Stop clicked but machine keeps running | **Treat as a safety fault; stop with a physical E-Stop.** Check `O_Safety_RemoteEStopOK` and the interposing relay wiring into both E-Stop channels (commissioning 5.1a) |
| Physical E-Stop pressed but the HMI doesn't name it | Monitoring contact not wired, or the wrong bit order vs `config.safety.eStopButtons` |
| `SAFETY_OK` false with no E-Stop shown | A guard is open, a relay fault, or the safety relay needs a reset |
| Level readings jump | ESP32 node: check the heartbeat register, median filtering, grounding of load-cell wiring, vibration isolation |
| Scanner reads, but the PLC gets nothing | Scanner node not connected (its heartbeat register isn't changing), or `Scan.Request` is 0 (no container held at SCAN, so the node doesn't trigger a read). See the node's serial console |
| Rejects for "fill out of tolerance" | Recalibrate the valve rates at `ValveOpeningPct` ([commissioning.md 6.1](commissioning.md#6-stage-4-wet-run)); a nearly empty tank flows slower (gravity feed); check for nozzle drips |
| Arm or labeler moves after an E-Stop | **Safety fault.** Its power isn't switched by the safety relay ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)) |

## 6. Station faults

A station fault latches in `Sys.FaultCode` (the first one; the HMI event log lists all of them), sets `LineState` bit3 FAULT, stops the line (`LINE_STOPPED` with source "station fault") and refuses START with "a station fault is latched — fix it, then press RESET". Fix the cause, then press RESET: the fault clears (`FAULT_CLEARED`) only if the cause is gone, otherwise it latches again at once. Station faults are not safety functions; they never replace an E-Stop. The node consoles are described in [esp32.md](esp32.md).

| `Sys.FaultCode` | Meaning | Fix |
| --- | --- | --- |
| 1 `LABELER` | Scanner node set `Station.ScannerNodeFaults` bit0: label applicator fault | Check the applicator for a jam, its driver and its supply (switched by the safety relay, so reset it first). With the line stopped, the scanner node's console `stroke` runs one applicator stroke |
| 2 `SCANNER` | Scanner node set bit1: the barcode scanner module isn't answering | UART wiring (TX/RX crossed), scanner power, baud rate (`scan_baud`, default 9600) and trigger mode (`scan_trig`: a GM65-class module must be in command-trigger mode for `serial`). The console `scan` command triggers one read without the PLC |
| 3 `ARM_SERVO` | Station node set `Station.StationNodeFaults` bit0, or the arm reported `SERVO_ERROR` | On the station node console, `status` shows the cause: a servo stopped answering or missed its position (servo supply off because the safety relay isn't reset, bus wiring, an overloaded joint), poses **NOT TAUGHT**, or teach mode still **ON** (`teach off`) |
| 4 `ARM_NO_LID` | `PICK_LID` closed on nothing three times in a row | Lid magazine empty or misaligned. Refill it with the line stopped. If it isn't empty, re-teach `mag_pick`, and check that `grip_close` was taught with the gripper closed on **nothing** (lid detection compares the gripper position with it; `lid_margin`) |
| 5 `ARM_LID_LOST` | The lid slipped out of the gripper between pick and place; that container is rejected | Lid size against the gripper, grip strength (`grip_close`), moves too fast (`move_ms`), or the arm hits something on the way to CAP (re-teach `cap_above`) |
| 6 `SORT_SENSOR` | Station node set bit1: the VL53L1X at QC isn't answering | I²C wiring (`tof_sda` 21, `tof_scl` 22 by default), 3.3 V supply, loose connector |
| 7 `SCANNER_NODE_OFFLINE` | `Field.ScannerNodeHeartbeat` (411) hasn't changed for 3 s | Node power, Wi-Fi (access point, SSID, signal), wrong PLC IP in the node settings, or the PLC's 16 Modbus connections used up. The console `status` shows the Wi-Fi and PLC link |
| 8 `STATION_NODE_OFFLINE` | `Field.StationNodeHeartbeat` (412) hasn't changed for 3 s | Same checks as code 7, on the station node |

| Symptom | Fix |
| --- | --- |
| RESET doesn't clear the fault | The cause is still there (a node fault bit is still set, or the node's heartbeat still isn't changing). Read `Station.ScannerNodeFaults` / `Station.StationNodeFaults` and the node console |
| `ARM_SERVO` right after power-up or after teaching | Poses not taught, or teach mode left on. Teach mode can only be switched on while the line is stopped ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)) |
| Arm never moves, no fault | The PLC issues arm commands only while the line runs (`Station.RunPermit` = 1). Check that `Station.ArmCmdSeq` changes and that the station node copies it to `Station.ArmDoneSeq`. `ArmResult` 6 (REFUSED) means the node wasn't homed or had no permit; the PLC re-homes the arm next, as it does after every abort and every RESET |

## 7. FUXA SCADA

FUXA runs natively from the repo root with `npm run fuxa` ([scada.md](scada.md)).

| Symptom | Fix |
| --- | --- |
| FUXA's device shows **"plugin is missing"** | The `modbus-serial` driver isn't installed in `deploy/fuxa`. Run `npm install` in `deploy/fuxa`, then restart `npm run fuxa` |
| `npm run fuxa` fails while installing | Network or proxy problem. Behind a TLS-inspecting proxy, retry with `NODE_OPTIONS=--use-system-ca` |
| Device disconnected | The PLC isn't reachable at the project's `PLC_HOST:PLC_PORT` (default the virtual PLC, `127.0.0.1:5020`; start it with `npm run virtual-plc`). To point FUXA at another PLC, set `PLC_HOST` / `PLC_PORT` and run `npm run fuxa:project` while FUXA runs |
| Tags missing or wrong after a register map change | Regenerate and reload the project: `npm run fuxa:project` |
| Can't open FUXA from another device | FUXA listens on `127.0.0.1:1881` only. Enable FUXA login first, then start it with `FUXA_HOST=0.0.0.0` and allow port 1881 through the firewall |
| FUXA has no command buttons | By design: the generated project is read-only. To add buttons, set `FUXA_COMMANDS=1` and run `npm run fuxa:project` while FUXA runs (turn on FUXA login first, [scada.md](scada.md)) |
| FUXA buttons do nothing (project built with `FUXA_COMMANDS=1`) | The PLC refused the command: key switch in LOCAL, an E-Stop active, reset required, or a station fault latched. The HMI event log shows the `COMMAND_REFUSED` reason. Stop and digital E-Stop are always accepted |
| FUXA doesn't start because port 1881 is in use | Another FUXA is running. Stop it, or set `FUXA_PORT` |
