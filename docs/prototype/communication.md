# Communication: network, Modbus TCP, OPC UA

## 1. Network

The BOM's split ([bom.md](bom.md)): the **Micro850 PLC** talks to the monitoring **PC/laptop** over wired Ethernet, and to the two **ESP32 station nodes** over Wi-Fi. Put all of them on a **dedicated control network**: a small switch plus a dedicated access point, **not** the office or campus LAN, and not the internet. Modbus TCP has no authentication or encryption, so anything that can reach port 502 can drive the line.

The Micro850 has **one Ethernet port and no Wi-Fi**, so everything reaches it through the switch. The access point is wired to the switch and bridges the ESP32 nodes onto the same subnet:

```
 Monitoring PC/laptop ──┐                                              ┌── ESP32 #1 scanner node (label + scan)
 (bridge + web HMI,     ├── switch ──┬── Micro850 PLC (Ethernet)       │
  FUXA SCADA)           │            └── access point (bridge mode) ····┤
 Engineering laptop ────┘                 all on 192.168.10.x           └── ESP32 #2 station node (robotic arm, sort sensor)
                                     Touch panel (if used): Ethernet on the switch, or RS-232/485 to the PLC's serial port
```

Suggested addressing (adjust to your site):

| Device | IP | Port(s) |
| --- | --- | --- |
| Micro850 PLC | `192.168.10.10` | 502 (Modbus TCP server, 16 connections); 44818 (EtherNet/IP, used by CCW) |
| Monitoring PC/laptop (or Raspberry Pi), control side | `192.168.10.20` | Client only |
| Touch panel on Ethernet (optional) | `192.168.10.40` | Client only |
| Engineering laptop | `192.168.10.50` | CCW Standard |
| FUXA SCADA ([scada.md](scada.md)), if not on the monitoring PC | `192.168.10.60` | Client to the PLC; 1881 (FUXA web UI, loopback only unless `FUXA_HOST=0.0.0.0` is set after enabling FUXA login) |
| Access point (bridge mode, DHCP off, no uplink) | `192.168.10.2` (management) | — |
| ESP32 #1 scanner node | `192.168.10.31` | Client only |
| ESP32 tank-level node (optional) | `192.168.10.32` | Client only |
| ESP32 #2 station node | `192.168.10.33` | Client only |
| Monitoring PC, operator side (second NIC or Wi-Fi) | Site network | 43123 (HMI) only |

- Use **static IPs** (or DHCP reservations) for the PLC and the nodes. Set the Micro850's address in CCW (Controller → Ethernet → Internet Protocol).
- The access point is for the ESP32 nodes only: WPA2/WPA3 with its own passphrase, no internet uplink, SSID not shared with anything else. A spare home router works if you turn off its DHCP server and plug the switch into a **LAN** port, not the WAN port.
- **Expect Wi-Fi drops.** Node heartbeats are supervised by the PLC. A node whose heartbeat stops for 3 s latches a station fault and stops the line; the node itself stops its actuators when it loses the PLC heartbeat for 1 s. A lost link never moves anything ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)). E-Stops are hardwired and never depend on Wi-Fi. Wired Ethernet ESP32 boards (LAN8720/W5500) remove the problem if the team can route cables.
- If operators reach the HMI from the site network, the monitoring PC is the **only** device on both networks. Don't enable IP forwarding on it, and firewall everything except 43123 on the operator side ([raspberry-pi.md](raspberry-pi.md#5-firewall) shows the rules for a Pi).

## 2. Modbus TCP profile

| Parameter | Value |
| --- | --- |
| Role | PLC = **server**. Bridge, ESP32 nodes and SCADA = **clients** |
| Port | 502 (virtual PLC: 5020) |
| Unit id | 1 |
| Function codes used | 01 Read Coils, 03 Read Holding Registers, 05 Write Single Coil, 06 Write Single Register, 16 Write Multiple Registers (15 supported by the virtual PLC) |
| Data types | UINT16 registers; scaled integers (see the `Unit` column in [io-map.md](io-map.md#4-register-map-modbus-tcp)). On the Micro850 they're `UINT` arrays in the Modbus mapping ([micro850-plc.md §2](micro850-plc.md#2-modbus-address-mapping)) |
| Addressing | 0-based PDU addresses (Modicon = address + 40001). Micro850: holding register N is CCW address 400001 + N and coil N is 000001 + N, so `PLC_COIL_BASE=0` |
| Byte order | Standard Modbus big-endian per register. No 32-bit values are used, so there's no word-order question |
| Max registers per read | 125 (the bridge reads 4 blocks: 0–19, 20–67, 100–139, 200–232) |

### Who writes what

Each register has exactly one writer. The command coils are the only exception: both the bridge and FUXA (only when its project is built with command buttons, `FUXA_COMMANDS=1`) may pulse them, which is safe because the PLC acts on the rising edge and clears the coil itself. The PLC must reject, ignore or overwrite writes to its read-only (**R**) registers.

**The PLC makes every decision.** The ESP32 nodes only execute the PLC's requests and report what happened: the scanner node forwards the raw barcode text and never validates it, and the station node reports the measured bottle height and never classifies the bottle. The PLC validates the barcode (`Scan.ParseResult`), classifies the bottle type from `Station.SortHeightMm`, sequences the robotic arm, and decides retries, rejects and faults.

| Writer | Registers / coils |
| --- | --- |
| PLC | Everything marked **R**: `Sys.*` including `Sys.FaultCode` and `LineState` bit3 FAULT, `Scan.Request`, `Scan.ParseResult`, `Scan.ResultId`, `Scan.TotalMl`, `Station.RunPermit`, `Station.LabelRequest`, `Station.ArmCmd`, `Station.ArmCmdSeq`, `Station.SortRequest` |
| Bridge (monitoring PC) | `Sys.HmiHeartbeat`, `Sys.TankEnableMask`, all coils |
| ESP32 #1 scanner node | `Scan.Done`, `Scan.Status`, `Scan.Length`, `Scan.Text1..32` (301–335, `Scan.Done` written last), `Station.LabelDone`, `Station.ScannerNodeFaults`, `Field.ScannerNodeHeartbeat` |
| ESP32 #2 station node | `Station.ArmDoneSeq`, `Station.ArmResult`, `Station.ArmStatus`, `Station.SortDone`, `Station.SortHeightMm`, `Station.StationNodeFaults`, `Field.StationNodeHeartbeat` |
| ESP32 tank node (optional) | `Field.Tank<k>LevelMl`, `Field.TankNodeHeartbeat` |
| SCADA (FUXA) | Nothing by default: the generated project is read-only. With `FUXA_COMMANDS=1`, only the command coils `Cmd.Start`, `Cmd.Stop`, `Cmd.Reset`, `Cmd.Jog`, `Cmd.DigitalEStop`, `Cmd.ReleaseEStop`, `Cmd.FirePusher`. Never holding registers. The PLC applies the same authority rules as for the bridge, so it refuses FUXA's commands in LOCAL mode |

**Handshakes.** For label, scan and sort, a request is new while `Request ≠ 0` and `Request ≠ Done`; neither side stores sequence numbers. The node writes its results first and the `Done` id last. The robotic arm takes one command at a time: the PLC writes `Station.ArmCmd` (1 HOME, 2 PICK_LID, 3 PLACE_LID), then a new `Station.ArmCmdSeq`; the station node runs it, writes `Station.ArmResult`, then `Station.ArmDoneSeq` = `ArmCmdSeq`. The full sequences are in [io-map.md §5](io-map.md#5-handshakes).

**Station faults.** The PLC latches a fault in `Sys.FaultCode` and sets `LineState` bit3 FAULT when a node sets a bit in its `Station.*NodeFaults` register (labeler, scanner, arm servo bus, sort sensor), when the arm reports `SERVO_ERROR` or `LID_LOST`, when `PICK_LID` returns `NO_LID` three times in a row, or when a node's heartbeat stops changing for 3 s (codes 7 and 8, node offline). A latched fault stops the line (`LINE_STOPPED` with source 3, "station fault"), refuses START (`COMMAND_REFUSED` reason 9, `FAULT_ACTIVE`), and is cleared only by RESET once the cause is gone (`FAULT_CLEARED`, event 33). A station node that doesn't report within `stationNodeTimeoutSec` (15 s) jams its container instead. Faults are not safety functions: the E-Stops and the safety relay remain the safety function ([safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes)).

### Timing

| Item | Value | Where configured |
| --- | --- | --- |
| Bridge poll period | 250 ms | `PLC_POLL_MS` |
| Bridge request timeout | max(500 ms, 2 × poll) | `twin/src/plc/bridge.ts` |
| Bridge reconnect delay | 2 s | `twin/src/plc/modbus.ts` |
| PLC heartbeat (`Sys.PlcHeartbeat`) | +1 every 100 ms | PLC program |
| PLC heartbeat timeout (seen by bridge) | 3 s | `heartbeatTimeoutMs` |
| PLC heartbeat timeout (seen by ESP32 nodes) | 1 s: stop actuators | ESP32 firmware (`PLC_HEARTBEAT_TIMEOUT_MS`) |
| HMI heartbeat timeout (seen by PLC) | 3 s | PLC program |
| Field node heartbeat timeout (seen by PLC) | 3 s: node offline, station fault latched | PLC program |
| Station node report timeout | 15 s: container jammed | `stationNodeTimeoutSec` |
| ESP32 poll of `Scan.*` / `Station.*` | 100 ms (scanner node), 50 ms (station node) | ESP32 firmware |
| HMI stale-feed banner | 3 s without data | `hmi/src/lib/twin/useTwinState.ts` |

End-to-end, an operator command reaches the PLC within one HTTP round trip (under 50 ms on a PC or Pi). Its effect appears on the HMI within about 1 s: one bridge poll plus one HMI poll of 500 ms.

**Connection budget.** The Micro850 serves up to **16** Modbus TCP clients at once, so the bridge, FUXA, the ESP32 nodes, an Ethernet touch panel and a commissioning tool all fit ([micro850-plc.md §1](micro850-plc.md#modbus-tcp-connections)). Still keep each client on one persistent connection instead of reconnecting per request, and close sockets cleanly on reboot.

### Testing without hardware

```bash
npm run dev:plc-sim
```

This starts the virtual PLC on `0.0.0.0:5020`, the twin in bridge mode against it, and the HMI. Useful checks:

- `http://127.0.0.1:43124/health` shows the PLC link and the `LineState` bits.
- Any Modbus tool (e.g. *Modbus Poll*, *QModMaster*, or `mbpoll -m tcp -p 5020 -a 1 -r 1 -c 20 127.0.0.1`) can read the same registers the PLC will expose.
- Point ESP32 firmware ([esp32.md](esp32.md), sources in [`firmware/`](../../firmware)) at `<dev PC IP>:5020`. Allow the port through the PC firewall. By default the virtual PLC runs its own simulated nodes, which follow the same register contract as the firmware. Start it with `VPLC_NODES=scanner`, `station`, `scanner,station` or `all` to hand those stations to real ESP32 nodes instead: the virtual PLC then watches their heartbeats and fault bits and waits for their `Done` / `ArmDoneSeq` exactly as the Micro850 will. `VPLC_FEED=0` turns off bottle arrivals.

## 3. OPC UA mapping

The register map's tag names are the OPC UA **browse names**. An OPC UA server for the line exposes one folder per prefix:

```
Objects/
  Captsone/                         (ns = the server's namespace for the PLC tags)
    Sys/        ProtocolVersion, PlcHeartbeat, LineState, TankCount, TankEnableMask, HmiHeartbeat, UptimeS, ActiveContainers, PhysicalEStopMask, FaultCode
    Counts/     Accepted, Rejected, Total, LaneA, LaneB
    Perf/       ThroughputCpm
    Oee/        Availability, Performance, Quality, Overall
    Tank1..8/   LevelMl, CapacityMl, Flags, RefillThresholdMl, DispenseRate, ValveOpeningPct
    Container1..8/  Id, Status, FillMl, TargetMl
    Event1..8/  Seq, Code, Arg1, Arg2        + Events/LastSeq
    Scan/       Request, Done, Status, Length, Text1..Text32, ParseResult, ResultId, TotalMl
    Field/      Tank1..8LevelMl, TankNodeHeartbeat, ScannerNodeHeartbeat, StationNodeHeartbeat
    Station/    RunPermit, LabelRequest, LabelDone, ArmCmd, ArmCmdSeq, ArmDoneSeq, ArmResult, ArmStatus, SortRequest, SortDone, SortHeightMm, ScannerNodeFaults, StationNodeFaults
    Cmd/        DigitalEStop, ReleaseEStop, Jog, FirePusher, Start, Stop, Reset   (Boolean; same one-shot semantics)
```

**Types over OPC UA.**
- Use `UInt16` (or `Int32`) with the same scaling as Modbus, so bridge code and documentation stay identical.
- If your server exposes engineering values (e.g. `Float`), keep the scaled integer tags as well, or version the mapping. Don't silently change units.

**Getting OPC UA from a Micro850.** The Micro850 speaks Modbus TCP and EtherNet/IP on Ethernet (and Modbus RTU on its serial port); plan on it having **no** OPC UA server. FUXA doesn't need OPC UA: it reads Modbus TCP directly. If some other client needs OPC UA, run a free gateway on the monitoring PC that reads the PLC over Modbus TCP and publishes the tags above; Node-RED with an OPC UA server node can do this. Rockwell's own OPC products (FactoryTalk Linx Gateway) are paid, so avoid them.

**Security.** Unlike Modbus, OPC UA supports signed and encrypted sessions with user authentication. If an OPC UA gateway is exposed on a network shared with anything else, use `SignAndEncrypt` with certificate trust configured. Don't use `None`.

**Bridge support.**
- `PlcBridge` implements **Modbus TCP only** today.
- To add OPC UA, implement the same `PlcBridge` public surface (`start`, `stop`, `poll`, `status`, `hmiState`, `snapshot`, `command`) over an OPC UA client (e.g. the `node-opcua` package), reading the nodes above.
- `run.ts` selects the line source, so the HMI and API don't change.
- Reuse the virtual PLC tests as the acceptance criteria.

## 4. SCADA alongside the bridge

The SCADA, FUXA, is an extra Modbus TCP client of the PLC. It runs natively on the monitoring PC (no Docker): `npm run fuxa` from the repo root installs FUXA 1.3.4 into `deploy/fuxa` on first use and loads a project generated from the register map, pointing at `PLC_HOST:PLC_PORT` (default the virtual PLC, `127.0.0.1:5020`). Rules:

- **Read-only by default; commands only through the command coils.** The generated project writes nothing. Built with `FUXA_COMMANDS=1`, it adds buttons that write only `Cmd.Start`, `Cmd.Stop`, `Cmd.Reset`, `Cmd.Jog`, `Cmd.DigitalEStop`, `Cmd.ReleaseEStop` and `Cmd.FirePusher`, never a holding register. The PLC applies the same authority rules as for the bridge (LOCAL/REMOTE, E-Stop and fault refusals), so it refuses FUXA's commands in LOCAL mode. FUXA displays and forwards; every decision stays in the PLC.
- Poll no faster than 500 ms (the generated project polls every 1000 ms, `FUXA_POLL_MS`). The generated device reads every holding register of the map except the 32 raw barcode text registers (plus the command coils with `FUXA_COMMANDS=1`).
- Record the event ring by `Seq` (de-duplicate like the bridge) to get a line history.

Installation, tag addressing (FUXA addresses are the register number + 1) and alarms are in [scada.md](scada.md).
