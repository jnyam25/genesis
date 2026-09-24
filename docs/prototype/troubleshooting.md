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
| Version mismatch | `Sys.ProtocolVersion` must equal `PROTOCOL_VERSION` in `twin/src/plc/tag-map.ts` (currently 3) |
| Commands do nothing | Wrong `PLC_COIL_BASE`; PLC doesn't reset coils (the next press has no rising edge); reset refused because `SAFETY_OK = 0` |
| Containers never get a recipe | Recipe mailbox: `AckSeq` must follow `Seq`. Check `ParseResult` (non-zero = bad barcode) and that the volume count matches `Sys.TankCount` |
| Every container JAMMED at the same station | Presence sensor not seen (wiring, alignment, debounce), stopper not releasing, or timeout too short for the belt speed |
| Every container rejected with "station fault" at LABEL, CAP or PRESS | The ESP32 node isn't writing `Done` with the request id (check its heartbeat and serial console), `Station.RunPermit` is 0, or a bit is set in `Station.ScannerNodeFaults` / `Station.StationNodeFaults` |
| Every container rejected as "bottle type mismatch" | Sort sensor reading 0 (can't tell) or the wrong type; check its threshold against `sort.smallBottleMaxMl` and that it writes `SortSensorContainer` after `SortSensorType` |
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
| Scanner reads, but the PLC gets nothing | Scanner node not connected (its heartbeat register isn't changing), or waiting for `AckSeq`. See the node's serial console |
| Rejects for "fill out of tolerance" | Recalibrate the valve rates at `ValveOpeningPct` ([commissioning.md 6.1](commissioning.md#6-stage-4-wet-run)); a nearly empty tank flows slower (gravity feed); check for nozzle drips |
| Arm, press or labeler moves after an E-Stop | **Safety fault.** Its power isn't switched by the safety relay ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)) |
