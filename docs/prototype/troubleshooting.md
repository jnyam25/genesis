# Troubleshooting

One place for every Genesis system: the PC, the simulated line, the virtual PLC, the physical line, the HMI, FUXA, the Raspberry Pi, the Micro850, and both ESP32 nodes.

Start with `/health` on the computer that runs the bridge (the monitoring PC, or the Pi):

```bash
curl -s http://127.0.0.1:43124/health
```

| `/health` shows | What is wrong | Go to |
| --- | --- | --- |
| Connection refused | The twin process is not running | [Twin service](#6-twin-service) |
| `"mode": "sim"` when you expected the PLC | The HMI is on the simulated line, not the bridge | [Startup commands](#2-startup-commands-and-matching-numbers) |
| `online: false`, `reason: "connecting to PLC …"` | The bridge cannot open Modbus to the PLC | [PLC link](#7-plc-link-modbus-tcp) |
| `online: false`, `reason: "PLC heartbeat stopped …"` | The PLC is not publishing | [PLC program](#8-plc-program) |
| `online: false`, `reason: "PLC register map version …"` | The PLC and this software disagree on the map | [PLC program](#8-plc-program) |
| `online: true` and the HMI stays on "Connecting…" or "Feed stale" | The HMI is not reading this twin | [HMI](#9-hmi) |
| `online: true`, `safetyOk: false` | The safety circuit is open | [Field and safety](#13-field-and-safety) |
| `online: true` and the HMI shows a station fault | `Sys.FaultCode` is latched | [Station faults](#14-station-faults) |
| The HMI is live and FUXA is not | SCADA is on a different PLC, or FUXA is down | [FUXA](#15-fuxa-scada) |
| HMI, FUXA, and the twin dashboard show different tank levels | Two engines are running | [Startup commands](#2-startup-commands-and-matching-numbers) |

PC install failures (`npm` missing, `EADDRINUSE`, native binaries) are in [§1](#1-pc-node-and-ports) and [INSTALL.md](../../INSTALL.md#troubleshooting).

## Systems

| System | What it does | First check |
| --- | --- | --- |
| PC / Node | Runs the scripts | `npm run doctor` |
| Simulated line | `npm run dev` — no PLC | HMI at http://localhost:43123, twin at http://127.0.0.1:43124/health (`"mode": "sim"`) |
| Virtual PLC | `npm run dev:plc-sim` — Modbus stand-in on port 5020 | Log says `Modbus TCP server on 0.0.0.0:5020`; `/health` is `"mode": "plc"` and `online: true` |
| Physical line | `npm run line` — real Micro850 | Script prints `register map v4`, then HMI, twin, and SCADA URLs |
| HMI | Operator screens | http://localhost:43123 |
| Twin / bridge | Turns PLC registers into the HMI feed | `curl http://127.0.0.1:43124/health` |
| FUXA SCADA | Trends, alarms, the line overview | http://127.0.0.1:1881/home |
| Raspberry Pi | Bridge + HMI as services | `systemctl status genesis-twin genesis-hmi` |
| Micro850 | Every line decision | Ping it, then read holding register 0 (`Sys.ProtocolVersion` = 4) |
| ESP32 scanner node | Label applicator and barcode text | USB console, 115200 baud, `status` |
| ESP32 station node | Capping arm and bottle height | USB console, 115200 baud, `status` |

The ESP32 nodes and the PLC are not started by `npm run line`. Power them, then start the PC software. Ctrl+C stops the PC software and leaves the PLC running.

## 1. PC, Node, and ports

| Symptom | Fix |
| --- | --- |
| `npm` is not recognized | Install Node.js 22 LTS (`winget install --id OpenJS.NodeJS.LTS -e` on Windows), open a new terminal, then `npm install` at the repo root |
| `twin/node_modules is missing` or `hmi/node_modules is missing` | Run `npm install` at the repo root. `npm run setup` reinstalls both |
| `npm run doctor` reports native binaries for another platform | `node_modules` was copied from another computer. `npm run clean`, then `npm install` on this machine |
| `EADDRINUSE` on 43123, 43124, 5020, or 1881 | That Genesis process is already running. `npm run doctor` names the HMI and twin ports. Stop the old process, or pick another port (`GENESIS_PORT`, `VPLC_PORT`, `FUXA_PORT`) |
| Doctor says port 43123 is free, then `next dev` fails with `EADDRINUSE :::43123` | Something is listening on IPv6 only. Doctor now checks both `127.0.0.1` and `::`. Stop the existing Next.js process |
| `npm run dev:mock` starts, then "stopping the rest" | The HMI failed to bind 43123, so the script stopped the twin it had just started. It does not stop a twin that was already running on 43124 |
| HMI stays on "Connecting…" at `http://127.0.0.1:43123` during `next dev` | `127.0.0.1` is allowed. Open http://127.0.0.1:43123 or http://localhost:43123 |
| `Blocked cross-origin request` for `/_next/hmr` | The page was opened by an address this computer did not have when dev started. Restart `npm run dev`. `localhost`, `127.0.0.1`, `*.local`, and this computer's LAN addresses are allowed |
| `Failed to fetch font 'Geist'` | The machine is offline. Connect once so Next.js can cache the font |

`npm run dev`, `dev:mock`, `dev:plc-sim`, and `line` each refuse to share a port. If one child exits, that script stops the processes it started. It does not stop a virtual PLC or FUXA you started yourself in another terminal.

## 2. Startup commands and matching numbers

The HMI, the twin dashboard, and FUXA show the same tank level, counts, throughput, and OEE only when they read the **same** PLC.

| Command | Source of the numbers | FUXA |
| --- | --- | --- |
| `npm run dev` | A simulated twin on port 43124. No Modbus PLC | Not started. A FUXA left over from earlier still shows the old PLC |
| `npm run dev:mock` | Numbers built into the HMI. The twin, if it starts, is ignored | Not started |
| `npm run dev:plc-sim` | Virtual PLC on port 5020, through the bridge | Start it yourself: `npm run fuxa`, pointed at `127.0.0.1:5020` |
| `npm run line` | The Micro850 at `PLC_HOST` port 502, through the bridge. FUXA's line overview is that PLC. The PLC link view also reads the virtual PLC on port 5020, which repeats the Micro850 status words | Started by the script, including the virtual PLC in follow mode and the link |

| Symptom | Fix |
| --- | --- |
| HMI tank levels move and FUXA stays at old numbers, or the other way around | Two engines. Stop the extra twin and the extra virtual PLC. For the real line, only `npm run line` should be running, and `/health` must say `"mode": "plc"` with `online: true` |
| FUXA shows one plant and the HMI another | FUXA's device is still `127.0.0.1:5020`. Set `PLC_HOST` and `PLC_PORT`, then `npm run fuxa:project` while FUXA is running. `npm run line` does this when it starts |
| Counts match, throughput differs by about 1 can/min | Normal. Throughput is a rolling rate. The bridge and FUXA poll every 250 ms, so they can sit one sample apart |
| OEE is `0.573` on one screen and `57.3%` on another | Both are the same ratio. Current screens print the PLC's 0.000–1.000 value (`Oee.Overall` is × 1000) |
| Millilitres differ by a trailing zero (`2406` and `2406.0`) | Same reading. Displays drop trailing zeros after rounding to the register scale (ml × 10, cans/min × 100, OEE × 1000) |
| "TANK LOW" on FUXA but not on the HMI, or the reverse | Low is the PLC flag: level under 800 ml (`Tank.Flags` bit LOW), not 15% or 30% of capacity |
| HMI link lamp on FUXA stays off | The bridge is not writing `Sys.HmiHeartbeat`. `/health` must be `"mode": "plc"` and `online: true`. A simulated twin (`npm run dev`) does not set that bit |

## 3. Simulated line

`npm run dev` runs the twin in `sim` mode and the HMI against it. There is no PLC and no FUXA.

| Symptom | Fix |
| --- | --- |
| Dashboard never leaves "Connecting…" | The twin is down or the page was opened as `127.0.0.1`. Use http://localhost:43123 and check http://127.0.0.1:43124/health |
| A can jams at a fill bay | One dose is longer than the 6 s station timeout. At 25 ml/s that is about 145 ml. Keep a single dose at or below 140 ml. Do not raise `sensorWaitTimeoutSec` |
| Sample barcode `PT1\|T200\|200` is rejected at the scan gate | Expected on the two-tank line. The barcode has one volume and the line has two tanks (`TANK_COUNT_MISMATCH`) |
| Tanks are not Sky Blue and Amber | A saved palette is in the way. The live twin and the mock both start as T1 Sky Blue and T2 Amber. Delete `twin/runtime/tank-colors.json`, or clear the mock palette in the browser |

## 4. Virtual PLC

`npm run virtual-plc` is only the Modbus server (port 5020). `npm run dev:plc-sim` is that server plus the bridge plus the HMI. Do not start a second copy while 5020 is already taken: the new one fails, and `dev:plc-sim` then stops the rest of its own processes.

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE` on 5020 | A virtual PLC is already running. Use that one, or stop it |
| `/health` says `connecting to PLC at 127.0.0.1:5020` | The virtual PLC process has stopped. Start it again, or use `npm run dev:plc-sim` with the ports free |
| Real ESP32 nodes never appear | Point them at `<this PC>:5020` (`set plc_port 5020`, then `reboot`) and start the virtual PLC with `VPLC_NODES=scanner`, `station`, or `all`. Without that, the virtual PLC simulates the nodes and ignores the boards |
| FUXA stays disconnected | FUXA defaults to `127.0.0.1:5020`. The virtual PLC must be running. If you changed `VPLC_PORT`, set `PLC_PORT` to the same value and run `npm run fuxa:project` |

## 5. Physical line (`npm run line`)

This is the command once the Micro850 is on the control network. It starts a virtual PLC on port 5020 in follow mode. Command coils are copied both ways, and the Micro850 status words (line state through fault code, and run permit) are copied onto the virtual PLC. Each heartbeat stays on its own controller. The HMI and the bridge stay on the Micro850. The ESP32 nodes connect to the PLC by themselves.

```powershell
$env:PLC_HOST="192.168.10.10"
npm run line
```

`PLC_PORT` defaults to 502. `PLC_COIL_BASE` defaults to 0.

| Symptom | Fix |
| --- | --- |
| `npm run line needs PLC_HOST` | Set the Micro850's address, then run it again |
| `cannot reach the PLC` | Power and Ethernet. Ping the PLC from this PC. Confirm Modbus TCP is enabled in CCW and the port is 502. See [§7](#7-plc-link-modbus-tcp) |
| `speaks register map vN; this software expects v4` | The PLC program and `twin/src/plc/tag-map.ts` have diverged. Download a program that publishes `Sys.ProtocolVersion` = 4, or update both sides together and reflash the ESP32 nodes (`npm run tag-map`) |
| `already running: HMI port 43123, twin port 43124` | Stop the earlier `npm run dev` or bridge before starting the physical line. Two twins means two sets of numbers |
| Script prints `register map v4`, then a child exits | Read that child's log. A port already taken, a failed FUXA install, or a twin that cannot bind 43124 stops the other two |
| SCADA has no START / STOP buttons | By design, unless you set `FUXA_COMMANDS=1` before `npm run line`. Stop and the digital E-Stop are the buttons that script adds. Turn on FUXA login before exposing port 1881 |

## 6. Twin service

On a PC this is `node dist/run.js` (from `npm run dev`, `dev:plc-sim`, or `line`). On the Pi it is `genesis-twin`.

| Symptom | Fix |
| --- | --- |
| `systemctl status genesis-twin` shows failed | `journalctl -u genesis-twin -n 50`. Common causes: `PLC_HOST` missing, wrong Node path in the unit file, `dist/` missing (`npm run build` in `/opt/genesis`) |
| `port 43124 is already in use` | Another twin is running. Stop it, or set `GENESIS_PORT` and `TWIN_HTTP_URL` to the same new port |
| `/health` flips between online and offline | The PLC or the network is dropping. See [§7](#7-plc-link-modbus-tcp). A `reason` of `connecting to PLC` means the TCP session is down; `PLC heartbeat stopped` means TCP works and register 1 is frozen |

## 7. PLC link (Modbus TCP)

| Symptom | Fix |
| --- | --- |
| Can't ping the PLC | Cable, switch, IP, or subnet. The monitoring PC's control-side NIC must be on the control subnet ([communication.md](communication.md)) |
| Ping works, Modbus times out | Modbus TCP is not enabled in CCW (Controller → Ethernet → Modbus TCP), the project with the mapping was not downloaded, the port is not 502, or the Micro850's 16 server connections are used up (ESP32 nodes reconnecting without closing old sockets) |
| Modbus exception 2 (illegal data address), or zeros, on reads | A block the bridge reads (0–19, 20–31 for two tanks, 100–139, 200–232) is not fully covered by the Micro850 mapping. Map each block as one array ([micro850-plc.md §2](micro850-plc.md#2-modbus-address-mapping)) |
| Modbus exception 2 on **commands** only | Coils 0–15 are not mapped (`MB_Cmd` at CCW address 000001), or `PLC_COIL_BASE` is not `0` |
| Values look ×10 / ×100 off | The display is showing the raw register. Levels are ml × 10, throughput is cans/min × 100, OEE is × 1000. The bridge and FUXA divide those out |
| Everything is off by one address | The PDU address N is CCW address 400001 + N. A mapping that starts at 400000 or 400002 shifts every register. FUXA's tag addresses are already 1-based |
| Intermittent offline | Poll too fast (`PLC_POLL_MS=500`), Wi-Fi between the PC and the PLC, or a duplicate IP. Keep the monitoring PC on Ethernet |

## 8. PLC program

| Symptom | Fix |
| --- | --- |
| Heartbeat stopped | The PLC is in Stop or Program mode, or it is faulted, or the publish subroutine is not being called |
| Version mismatch | `Sys.ProtocolVersion` must equal `PROTOCOL_VERSION` in `twin/src/plc/tag-map.ts` (currently 4). Reflash both ESP32 nodes after a map change: `npm run tag-map`, then `pio run -t upload` in each firmware project |
| Commands do nothing | Wrong `PLC_COIL_BASE`; the PLC is not clearing the coil (the next press has no rising edge); reset refused because `SAFETY_OK` is 0; START refused because a station fault is latched (reason 9, [§14](#14-station-faults)) |
| HMI Reset does nothing on the real PLC | Remote reset is off (`remoteResetAllowed` is false). Reset at the local panel. In simulation, that is the simulated panel, not the HMI Reset button |
| Containers never get a recipe | The scanner node must write `Scan.Done` = `Scan.Request` after `Scan.Status`, `Scan.Length`, and `Scan.Text`. Then read `Scan.ParseResult`: 7 is NO_READ, 3 is a volume count that does not match the two tanks. The node only forwards text |
| Every container jams at the same station | Presence sensor (wiring, alignment, debounce), stopper not releasing, or the dose is longer than 6 s. At SCAN, CAP, or QC the ESP32 node has `stationNodeTimeoutSec` (15 s) to answer; watch its serial console |
| Every container rejected at the scan gate | Bad or missing QR, or the barcode's volume count is not 2. Good cans are not labeled on this line; the QR is already on the can |
| Every container rejected as "bottle type mismatch" | `Station.SortHeightMm` is 0 or is not within ±15 mm of the lane height (defaults 120 mm for Lane 1 and 180 mm for Lane 2). Measure the bottles and update the PLC and `config.ts` |
| Events missing on the HMI | The PLC must shift the ring and increment `LastSeq` for every event. Seq must never be 0 |

## 9. HMI

Open the dev server at http://localhost:43123. Production (`next start` on the Pi) accepts either host name.

| Symptom | Fix |
| --- | --- |
| "Connecting…" forever | The page was opened as `127.0.0.1` against `next dev`, or the twin is down. Use localhost and check `/health` |
| "Feed stale" while `/health` is online | `TWIN_HTTP_URL` does not point at the twin. Open `http://localhost:43123/api/twin/state`; a 502 includes the reason |
| HMI numbers never match FUXA | The HMI is on the mock feed, or it is still on `npm run dev` while FUXA reads the PLC. See [§2](#2-startup-commands-and-matching-numbers). Both feeds start as Sky Blue and Amber unless a saved palette overrides them |
| Can't reach the HMI from another device | Allow TCP 43123 through the firewall. The service listens on all interfaces; the twin stays on `127.0.0.1` |
| 3D view is blank or the stations are not clickable | You are on an old production build. Stop it and start the current `npm run dev` or `npm run line` |
| Tank low does not match the SCADA banner | Both follow the PLC: under 800 ml. Refill the tank. On the simulated line the twin refills by itself |

## 10. Raspberry Pi

The Pi runs `genesis-twin` (`GENESIS_MODE=plc`) and `genesis-hmi` (`next start`). Setup is in [raspberry-pi.md](raspberry-pi.md). FUXA is not one of those units; run it on the monitoring PC with the same `PLC_HOST`, or start it on the Pi the same way.

| Symptom | Fix |
| --- | --- |
| `genesis-twin` failed at boot | `journalctl -u genesis-twin -n 50`. Set `PLC_HOST` in `/etc/genesis/genesis.env`. `PLC_PORT` is 502 for the Micro850 and 5020 only when the PLC is a virtual PLC on a PC |
| `/health` from the Pi is `online: false` | The Pi's `eth0` must reach the PLC. A Wi-Fi path to the PLC is the wrong network |
| HMI on the Pi shows mock tanks | The HMI was built without `NEXT_PUBLIC_TWIN_SOURCE=http`. From `/opt/genesis`, `npm run build`, then `sudo systemctl restart genesis-hmi` |
| Kiosk browser shows a blank page | The desktop file waits for port 43123. `systemctl status genesis-hmi` and `curl -s http://127.0.0.1:43124/health` |
| Operators can open the HMI, nobody can open the twin port | Expected. `GENESIS_HOST` stays `127.0.0.1`. Other devices use `http://<pi>:43123` |

## 11. ESP32 scanner node

Firmware: `firmware/scanner-node`. Console: `pio device monitor` at 115200 baud. Boot should print `Genesis scanner node, register map v4`.

Shared console commands: `help`, `show`, `set <key> <value>`, `reboot`. This node also has `status`, `scan`, and `stroke`.

| Symptom | Fix |
| --- | --- |
| `pio run` fails with `CERTIFICATE_VERIFY_FAILED` | A proxy is re-signing HTTPS. Point `REQUESTS_CA_BUNDLE` at a PEM bundle that includes the machine's root certificates, then build again |
| Console shows a register map version other than 4 | Run `npm run tag-map` at the repo root and flash the node again |
| `status` shows no Wi-Fi or no PLC | `set wifi_ssid`, `set wifi_pass`, `set plc_ip`, and `set plc_port` (`502` for the Micro850, `5020` for the virtual PLC), then `reboot` |
| `scan` prints text, the PLC still has no barcode | The node only reads when `Scan.Request` is non-zero (a can is held at the scan gate). Watch `status` for the request id. The PLC publishes `Scan.ParseResult` |
| `stroke` does nothing or the DM556Y faults | The line must be stopped. Check the driver alarm, the motor supply (it drops when the safety relay is open), and the DIP current against the motor rating |
| PLC latches fault 7 | `Field.ScannerNodeHeartbeat` (register 411) stopped for 3 s. Power, Wi-Fi, PLC IP, or the PLC's 16 Modbus connections are full |

## 12. ESP32 station node

Firmware: `firmware/station-node`. Console: 115200 baud. Boot should print `Genesis station node, register map v4` and either `Poses taught` or `NOT TAUGHT`.

Extra commands: `status`, `teach on`, `teach off`, `poses`, `height`, `grip open`, `grip close`, and the pose moves described in [esp32.md](esp32.md).

| Symptom | Fix |
| --- | --- |
| `NOT TAUGHT` or fault 3 as soon as you try to start | Teach `home`, `mag_above`, `mag_pick`, `cap_above`, `cap_place`, and `cap_press`, plus `grip_open` and `grip_close` (closed on nothing), then `teach off`. Teach is refused while `Station.RunPermit` is 1 |
| Arm never moves and there is no fault | The PLC sends arm commands only while the line is running. `status` should show `ArmCmdSeq` changing. `ArmResult` 6 means the node refused (not homed, or no permit); the PLC homes it on the next start |
| `height` says `sensor not answering` | I²C wiring (`tof_sda` 21, `tof_scl` 22 by default) or 3.3 V to the VL53L1X. The PLC latches fault 6 |
| Height is off by a fixed amount | `set tof_mount` to the sensor's height above the belt, in mm, then `reboot`. `height` prints distance and the bottle height |
| Fault 8 | `Field.StationNodeHeartbeat` (register 412) stopped for 3 s. Same network checks as the scanner node |
| Arm or applicator still moves after an E-Stop | Stop with a physical E-Stop and treat it as a safety fault. That supply is not going through the safety relay ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)) |

## 13. Field and safety

| Symptom | Fix |
| --- | --- |
| Red "EMERGENCY STOP" banner won't clear | Release every pressed physical button (the banner names them) and the digital E-Stop (Controls → Release digital E-Stop) |
| "Safety reset required" stays after pressing RESET | The safety relay did not reset: an E-Stop channel is still open, the interposing relay is still de-energized, the relay's feedback loop is open, or RESET is wired to the PLC only. Check the relay's LEDs |
| HMI Reset disabled / "reset must be done at the local control panel" | By design. Reset at the machine |
| HMI Start refused "local control is active" | Key switch on LOCAL. Use the panel START, or turn the key to REMOTE |
| Panel START does nothing | Key on REMOTE, reset required, or an E-Stop is active. The HMI event log has the refusal reason |
| Digital E-Stop clicked but the machine keeps running | **Treat this as a safety fault and stop with a physical E-Stop.** Check `O_Safety_RemoteEStopOK` and the interposing relay into both E-Stop channels (commissioning 5.1a) |
| Physical E-Stop pressed but the HMI does not name it | The monitoring contact is not wired, or the bit order does not match `config.safety.eStopButtons` (Line start, then Line end) |
| `SAFETY_OK` false with no E-Stop shown | A guard is open, a relay fault, or the safety relay needs a reset |
| Stack light is dark | The ONN-M4W is 24 V DC from the PLC, and it stays powered when an E-Stop cuts actuator power. Green is running, yellow is stopped or the HMI link is down, red is an E-Stop or a latched fault, the buzzer is an E-Stop or a jam |
| Rejects for "fill out of tolerance" | Recalibrate the valve rates at `ValveOpeningPct` ([commissioning.md](commissioning.md) wet run). A nearly empty tank flows slower. Check the nozzle for drips |
| Lid press never happens | The press station finishes on its timer (0.8 s). It is not an arm move. A cap fault skips the press and sends the can to the fill-reject slide |

## 14. Station faults

A station fault latches in `Sys.FaultCode` (the first one; the HMI event log lists all of them), sets `LineState` bit 3, stops the line, and refuses START until you fix the cause and press RESET. RESET clears it only when the cause is gone. These faults are not a substitute for an E-Stop. Node consoles are in [esp32.md](esp32.md).

| `Sys.FaultCode` | Meaning | Fix |
| --- | --- | --- |
| 1 `LABELER` | Scanner node set `Station.ScannerNodeFaults` bit 0 | Peel-mechanism jam, DM556Y alarm, or the motor supply is off because the safety relay is open. With the line stopped, `stroke` runs one applicator move. The default simulated line has no label station; this fault still applies when the applicator is fitted |
| 2 `SCANNER` | Scanner node set bit 1: the barcode module is not answering | UART TX/RX crossed, scanner power, baud (`scan_baud`, default 9600), trigger mode (`scan_trig`). `scan` on the console reads once without the PLC |
| 3 `ARM_SERVO` | Station node set `Station.StationNodeFaults` bit 0, or the arm reported `SERVO_ERROR` | `status`: a servo stopped answering, the servo supply is off, poses are not taught, or teach mode is still on (`teach off`) |
| 4 `ARM_NO_LID` | `PICK_LID` closed on nothing three times | Magazine empty or misaligned. Refill with the line stopped. If it is not empty, re-teach `mag_pick` and `grip_close` (closed on nothing) |
| 5 `ARM_LID_LOST` | The lid left the gripper between pick and place. That can is rejected | Grip, `move_ms`, or the path into `cap_above` |
| 6 `SORT_SENSOR` | The VL53L1X at QC is not answering | I²C wiring and 3.3 V. `height` on the station console |
| 7 `SCANNER_NODE_OFFLINE` | Heartbeat register 411 frozen for 3 s | Power, Wi-Fi, PLC address, or the PLC's connection limit. `status` shows the link |
| 8 `STATION_NODE_OFFLINE` | Heartbeat register 412 frozen for 3 s | Same checks as code 7, on the station node |

| Symptom | Fix |
| --- | --- |
| RESET does not clear the fault | The cause is still present. Read `Station.ScannerNodeFaults` or `Station.StationNodeFaults`, and the node console |
| Arm never moves, no fault | `Station.RunPermit` is 0, so the PLC is not issuing commands. After an abort or RESET the next command is `HOME` |

## 15. FUXA SCADA

FUXA is the SCADA at http://127.0.0.1:1881 (`/editor`, operator view `/home`). `npm run fuxa` starts it. `npm run line` starts it already pointed at the real PLC.

| Symptom | Fix |
| --- | --- |
| **"plugin is missing"** on the device | `npm install` in `deploy/fuxa`, then restart FUXA |
| `npm run fuxa` fails during install | Network or a TLS-inspecting proxy. Retry with `NODE_OPTIONS=--use-system-ca` |
| Device disconnected | Nothing is answering at the project's `PLC_HOST:PLC_PORT`. For the virtual PLC, start `npm run virtual-plc`. For the Micro850, set `PLC_HOST` and `PLC_PORT=502` and run `npm run fuxa:project` while FUXA is up |
| Tags missing or stale after a register-map change | `npm run fuxa:project`. This replaces the whole project, including edits made only in the editor |
| Port 1881 already in use | Another FUXA is running. Stop it, or set `FUXA_PORT` |
| Can't open FUXA from another device | It listens on `127.0.0.1`. Turn on FUXA login first, then `FUXA_HOST=0.0.0.0` and allow TCP 1881 |
| No command buttons | The project is read-only unless `FUXA_COMMANDS=1` was set when it was generated |
| Buttons do nothing | The PLC refused the command: LOCAL, E-Stop, reset required, or a station fault. The HMI event log has `COMMAND_REFUSED`. Stop and the digital E-Stop are accepted in either mode |
| A chart legend shows `12/31/1969` until you hover a point | The crosshair is parked at the start of the axis. Move onto a point. The series itself is the scaled engineering value |
| E-Stop banner stays up as an empty box, or the text disappears | Do not add a blink action to that banner. It is show/hide only: hidden at 0, solid red while `LineState` bit ESTOP_ACTIVE is set |
| Remote FUXA (not on the control LAN) shows no device | It must use the Pi's SCADA door, not the PLC address. Operator Wi-Fi: `PLC_HOST` is the Pi's address on that Wi-Fi, port `5502`. Any other network: bring up WireGuard, then `PLC_HOST=10.44.0.1` and `PLC_PORT=5502`. On the Pi, `SCADA_GATEWAY_HOST` must list that address and `npm run scada-gateway` (or `npm run line` with the variable set) must be running |
| Door log says `refusing to bind 0.0.0.0` | Name the operator or WireGuard address. Binding every interface would put the command door on the control network |
| Remote Start does nothing, Stop works | The PLC is in LOCAL, or a fault / E-Stop / reset is holding the line. The door forwarded the coil. The HMI event log shows `COMMAND_REFUSED` |
| Remote screen can ping the PLC | The tunnel `AllowedIPs` on the SCADA PC includes the control subnet, or the Pi is forwarding. `AllowedIPs` must be `10.44.0.1/32` only. Leave IP forwarding off |
