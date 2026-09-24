# ESP32 station nodes

The bill of materials ([bom.md](bom.md)) budgets **two ESP32 boards**, linked to the Micro850 PLC **wirelessly** through an access point on the control switch. They run the stations that are awkward for a PLC: the label applicator, the barcode scanner, the robotic arm that lifts a lid and places it on the container, and the sort height sensor. Both are **Modbus TCP clients** of the PLC.

**The PLC makes every decision.** A node executes one PLC request at a time and reports what happened; it never validates a barcode, classifies a bottle, retries, or decides what the arm does next. The PLC validates the raw barcode text, classifies the measured bottle height, sequences the arm, and latches a fault (stopping the line) when a node fails or goes silent ([micro850-plc.md](micro850-plc.md)).

| Node | Job | Writes | Reads |
| --- | --- | --- | --- |
| **ESP32 #1 scanner node** (line entry) | Apply the label; trigger the barcode scanner and forward the raw text | `Scan.Status` 302, `Scan.Length` 303, `Scan.Text1..32` 304–335, then `Scan.Done` 301; `Station.LabelDone` 422; `Station.ScannerNodeFaults` 431; `Field.ScannerNodeHeartbeat` 411 | `Sys.PlcHeartbeat` 1, `Scan.Request` 300, `Station.RunPermit` 420, `Station.LabelRequest` 421 |
| **ESP32 #2 station node** (on the xArm) | Run the robotic arm command the PLC issues; measure the bottle height at the sort sensor | `Station.ArmResult` 426, then `Station.ArmDoneSeq` 425; `Station.ArmStatus` 427; `Station.SortHeightMm` 430, then `Station.SortDone` 429; `Station.StationNodeFaults` 432; `Field.StationNodeHeartbeat` 412 | `Sys.PlcHeartbeat` 1, `Station.RunPermit` 420, `Station.ArmCmd` 423, `Station.ArmCmdSeq` 424, `Station.SortRequest` 428 |
| Tank-level node (optional, not in the BOM) | Measure tank levels with sensors that have no industrial output (e.g. load cells, ultrasonic) | `Field.Tank<k>LevelMl` 400–407, `Field.TankNodeHeartbeat` 410 | `Sys.TankEnableMask` 4 |

Because nodes #1 and #2 drive actuators, the rules in [safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes) apply: actuator power comes through the safety relay, and the firmware stops on permit or heartbeat loss. Nothing on an ESP32 is part of the safety function.

If your level sensors have 4–20 mA outputs, wire them to PLC analog inputs instead and skip the tank node. Fewer parts means fewer failure modes.

**Firmware is in the repo** ([`firmware/`](../../firmware/README.md)): `scanner-node` and `station-node` are PlatformIO projects on the Arduino framework, sharing [`firmware/lib/captsone_node`](../../firmware/lib/captsone_node/src/captsone_node.h) (Wi-Fi, the Modbus TCP link, PLC supervision, settings and the serial console). The register numbers come from [`captsone_registers.h`](../../firmware/lib/captsone_node/src/captsone_registers.h), which `npm run tag-map` generates from [`twin/src/plc/tag-map.ts`](../../twin/src/plc/tag-map.ts); a test fails if the two drift apart. The virtual PLC's simulated nodes ([`simulated-nodes.ts`](../../twin/src/plc/simulated-nodes.ts)) follow the same contract, so the line runs end to end in software before the hardware exists.

## 1. Hardware

| Item | Recommendation |
| --- | --- |
| Board, node #1 | ESP32 DevKit (per the BOM), on **Wi-Fi to a dedicated access point** that is wired to the control switch, so the nodes reach the PLC's Ethernet address ([communication.md](communication.md#1-network)). Wired Ethernet boards (WT32-ETH01, Olimex ESP32-POE) are a drop-in upgrade if Wi-Fi drops cause heartbeat faults |
| Board, node #2 | The **xArm's own ESP32 controller** running the station-node firmware (it already has the servo-bus circuit), or an ESP32 DevKit wired to the servo bus through a half-duplex adapter. The bus pins are settings, because they differ between boards: check them against Hiwonder's schematic for your controller revision before the first power-up |
| Robotic arm (node #2) | Hiwonder xArm ESP32: 6 LX-series bus servos, servo 1 is the gripper, servos 2–6 the wrist rotate … base. Servo power from the safety-relay-switched supply |
| Lid magazine | A gravity-fed stack of lids in a fixed position the arm can reach; the top lid is always at the same height. The arm needs a clear straight approach from above |
| Sort height sensor (node #2) | VL53L1X time-of-flight sensor on I²C, mounted above the belt at QC looking down. Height = mount distance − measured distance |
| Label applicator (node #1) | Hobby servo driving the roller/peel mechanism (built, per the BOM) on its own 5–6 V supply from the safety-relay-switched rail. Optional label-present sensor (active low) to confirm each label |
| Scanner (node #1) | Fixed-mount GM65/GM861-class module with a TTL UART, **command-trigger mode**, CR/LF suffix. For RS-232 scanners, add a MAX3232 level shifter |
| Power | Dedicated 5 V supply (or PoE), in the electronics enclosure. Not powered from the 24 V field supply without a proper DC/DC converter |
| Logic levels | ESP32 GPIO is **3.3 V and not 5 V / 24 V tolerant**. Use optocouplers or isolated modules for any field signal |
| Load cells (tank node) | One HX711 amplifier per load cell (or per summed set of cells). Mount cells per the manufacturer's instructions; isolate from vibration |
| Enclosure | Away from liquids (see [safety.md](safety.md) §2) |

## 2. Protocol rules common to both nodes

- **One persistent Modbus TCP connection** to the PLC (`192.168.10.10:502`, unit 1). Reconnect after a 1 s back-off; never open a second connection.
- **Permit.** Actuators move only while `Station.RunPermit` = 1 **and** `Sys.PlcHeartbeat` (+1 every 100 ms) changed within the last second. When either drops, stop at once.
- **Handshakes.** A request (`Scan.Request`, `Station.LabelRequest`, `Station.SortRequest`) is new while `Request ≠ 0` and `Request ≠ Done`, so neither side stores sequence numbers and a node can reboot at any time. Results are written first and `Done` last.
- **Arm commands.** The PLC writes `ArmCmd`, then a new `ArmCmdSeq`. A command is new while `ArmCmdSeq ≠ 0` and `ArmCmdSeq ≠ ArmDoneSeq`. The node runs it once, writes `ArmResult`, then `ArmDoneSeq` = `ArmCmdSeq`.
- **Heartbeat.** Each node increments its `Field.*NodeHeartbeat` once per second. The PLC latches `SCANNER_NODE_OFFLINE` (7) or `STATION_NODE_OFFLINE` (8) if it stops changing for 3 s.
- **Fault bits** go in the node's own register (431 or 432), and nowhere else.
- **A node writes only its own registers** ([communication.md](communication.md)).

## 3. Scanner node (ESP32 #1)

**Scan.** On a new `Scan.Request`, the node flushes the scanner UART and triggers one read (GM65 command `7E 00 08 01 00 02 01 AB CD`; `scan_trig` also supports a trigger pin or a scanner in continuous mode). It discards the module's 7-byte acknowledgement, collects printable characters up to CR/LF, and reports:

| Outcome | `Scan.Status` | `Scan.Length` / `Scan.Text` |
| --- | ---: | --- |
| Text read | 0 `OK` | the raw text, 2 characters per register, first character in the high byte, unused bytes 0 |
| More than 64 characters | 2 `TOO_LONG` | the first 64 characters |
| Nothing within `scan_ms` (2 s) | 1 `NO_READ` | 0 |

It writes status, length and all 32 text registers in one request, then `Scan.Done` = the container id. Reading moves nothing, so it does not wait for `RunPermit`. The PLC validates the text (`PT1|T<totalMl>|<v1>,…,<vN>[|I<rounds>]`) and publishes `Scan.ParseResult`: 0 OK, 1–6 as in [`twin/src/barcode.ts`](../../twin/src/barcode.ts), 7 `NO_READ`. A rejected container rides through unfilled and is diverted at the reject gate.

**Label.** On a new `Station.LabelRequest` while permitted, the applicator servo strokes from `label_rest` to `label_apply` and back (`label_ms` each way). If the optional label sensor doesn't see a label at the end, the node sets fault bit0 instead of `LabelDone`. If the permit drops mid-stroke, the servo returns to rest and the node waits; the PLC keeps the request until the label is on.

**Fault bits** (`Station.ScannerNodeFaults`): bit0 labeler (no label detected), bit1 scanner (no acknowledgement to the trigger within 500 ms, command-trigger mode only). A bit reports a failed attempt. The PLC latches the fault and stops the line; the node clears the bit after the line has been stopped for 2 s, so RESET can proceed, and a problem that persists sets it again on the next attempt.

## 4. Station node (ESP32 #2): robotic arm and sort sensor

### The arm program

Each PLC command is a short list of moves between **taught poses** (servos 2–6), plus the gripper's open and empty-closed positions:

| Command | Moves |
| --- | --- |
| `HOME` (1) | To the HOME pose, clear of the belt and the magazine. Gripper unchanged. From an unknown position it moves slowly (`slow_ms`) |
| `PICK_LID` (2) | Above the magazine → open the gripper → down to the top lid → close → **check the lid** → up → HOME |
| `PLACE_LID` (3) | **Check the lid** → above the container at CAP → **check the lid** → down until the lid rests on the container → **press down** a few mm to seat it → open → up → HOME |

**Lid detection** needs no extra sensor: the gripper servo reports its position, and closing on a lid stalls it at least `lid_margin` short of the taught empty-closed position. No lid after closing → `NO_LID`; lid gone before placing → `LID_LOST`. Either way the arm opens the gripper and returns HOME before reporting.

**Every move is verified.** After each move's time plus 100 ms, the node reads the servo positions; a servo that doesn't answer, or isn't within `tolerance` 800 ms later, stops the arm and reports `SERVO_ERROR`. The press-down move is not verified, because it is meant to stall on the seated lid.

**Results** (`Station.ArmResult`) and what the PLC does with them ([`arm-sequencer.ts`](../../twin/src/plc/arm-sequencer.ts)):

| Result | Meaning | PLC |
| --- | --- | --- |
| 1 `OK` | Done, back at HOME | Next command |
| 2 `NO_LID` | Gripper closed on nothing | Retry up to 3 times, then latch `ARM_NO_LID` (4): refill or realign the magazine |
| 3 `LID_LOST` | The lid fell before placing | Latch `ARM_LID_LOST` (5); the container is rejected |
| 4 `SERVO_ERROR` | A servo didn't answer or didn't arrive | Latch `ARM_SERVO` (3) |
| 5 `ABORTED` | Permit or PLC heartbeat lost mid-move; every servo stopped where it was | Re-home on the next start; if the lid was already released, the container is rejected |
| 6 `REFUSED` | Not homed (only `HOME` allowed), unknown command, no permit, poses not taught, or servo bus down | Re-home |

`Station.ArmStatus` (bit0 `HOMED`, bit1 `BUSY`, bit2 `LID_HELD`) is written whenever it changes and at least once a second. `HOMED` is cleared by an abort, a servo error, teach mode, or a restart, so the PLC always sends `HOME` first. The PLC sequences HOME → PICK_LID (while the belt brings the next container) → PLACE_LID when a container is held at CAP → PICK_LID …

### Sort height

On a new `Station.SortRequest`, the node takes five fresh VL53L1X readings (up to 1 s), and writes the median height (`tof_mount` − distance) to `Station.SortHeightMm`, or 0 if fewer than three readings were valid or the height is below `tof_min`. Then it writes `Station.SortDone` = id. The PLC compares the height with the sort lanes (`config.sort`: lane A 120 mm, lane B 180 mm, ±15 mm) and rejects a bottle whose type doesn't match its recipe.

### Fault bits (`Station.StationNodeFaults`), live while the cause lasts

- **bit0 arm**: a servo stopped answering the idle probe (one servo every 500 ms, three misses in a row), the poses have not been taught, or teach mode is on. The PLC latches `ARM_SERVO`, so the line cannot start with an untaught arm or while someone is teaching it.
- **bit1 sort sensor**: the VL53L1X didn't initialise or delivered no data for 1 s. The node retries every 5 s.

### Teaching the poses (serial console, line stopped)

Connect USB, open the console (`pio device monitor`, 115200 baud), then:

1. `teach on`. This is refused while `RunPermit` = 1. From now on the node refuses PLC commands and reports the arm fault bit.
2. `limp`, support the arm, and move it by hand to the pose. Or `hold` and nudge it with `goto`.
3. `save home`, then likewise `mag_above`, `mag_pick` (gripper around the top lid), `cap_above`, `cap_place` (lid resting on the container mouth), and `cap_press` (a few mm lower).
4. With the gripper open, `save grip_open`; closed on **nothing**, `save grip_close`. Check lid detection: close on a lid and compare `pos` with `grip_close`. The difference must be clearly above `lid_margin` (30).
5. `poses` lists everything; `goto <pose>` replays each one slowly. Then `teach off`. The PLC homes the arm on the next start.

## 5. Settings and bench testing

Both nodes keep their settings in NVS; `show` lists them, `set <key> <value>` changes one, and `reboot` applies network changes.

| Setting | Default | Node |
| --- | --- | --- |
| `wifi_ssid`, `wifi_pass` | `captsone-ctl`, empty | both |
| `ip`, `gateway`, `subnet` | `192.168.10.31` / `.33`, `192.168.10.1`, `255.255.255.0` | both (empty `ip` = DHCP) |
| `plc_ip`, `plc_port`, `unit_id` | `192.168.10.10`, `502`, `1` | both |
| `scan_rx`, `scan_tx`, `scan_baud`, `scan_trig`, `scan_pin`, `scan_ms` | 16, 17, 9600, `serial`, −1, 2000 | scanner |
| `label_pin`, `label_rest`, `label_apply`, `label_ms`, `label_sense` | 25, 10°, 120°, 600 ms, −1 | scanner |
| `bus_rx`, `bus_tx`, `bus_txen`, `bus_rxen`, `bus_echo` | 16, 17, −1, −1, 1 | station |
| `move_ms`, `approach_ms`, `slow_ms`, `press_ms`, `grip_ms` | 1000, 700, 2500, 600, 500 | station |
| `tolerance`, `lid_margin`, `grip_open`, `grip_close`, `p_<pose>` | 40, 30, taught | station |
| `tof_sda`, `tof_scl`, `tof_mount`, `tof_min` | 21, 22, 300 mm, 30 mm | station |

**Against the virtual PLC, no hardware line needed:**

1. On a PC on the same network, run `VPLC_NODES=scanner npm run virtual-plc` (or `station`, or `all`) in `twin/`. The virtual PLC then expects the real node instead of simulating it, and watches its heartbeat.
2. On the node: `set plc_ip <PC IP>`, `set plc_port 5020`, `reboot`.
3. Watch the line in the HMI (`npm run dev:plc-sim` with the same `VPLC_NODES`) or in FUXA (`npm run fuxa`, see [scada.md](scada.md) §5). `status` on the console shows the link, the jobs and the fault bits.

Scanner bench commands: `scan` triggers one read and prints it; `stroke` runs one applicator stroke (line stopped only). Station: `height` prints one sensor reading; `pos` prints the servo positions.

**Test barcodes.** Code 128 handles `|` and `,`. Samples from [`config.ts`](../../twin/src/config.ts): `PT1|T250|100,80,70`, `PT1|T300|120,90,90|I4`, and `PT1|T200|200`, which fails on a 3-tank line with `TANK_COUNT_MISMATCH`. The scanner node forwards each one unchanged; the PLC's `Scan.ParseResult` shows the verdict.

## 6. Tank-level node firmware (optional, not in the repo)

```text
setup:
  Wi-Fi or wired Ethernet (static IP 192.168.10.32), Modbus client → PLC 192.168.10.10:502
  load per-slot calibration (offset, ml_per_count) from NVS

every 200 ms:
  for each slot k with a sensor:
    raw := median of 5 readings (HX711 or ultrasonic)
    ml  := clamp((raw - offset[k]) * ml_per_count[k], 0, 6553.5)
    level_x10[k] := round(ml * 10)
  write multiple @400: level_x10[0..7]     (slots without a sensor: 0)
every 1 s:
  write Field.TankNodeHeartbeat := heartbeat++
```

**PLC-side validation** (see [micro850-plc.md](micro850-plc.md)): use a slot's field value only if the node heartbeat changed within 3 s and the value is within 0..capacity; otherwise stop refilling that tank and alarm.

**Calibration** (serial console, stored in NVS): `tare k` with the tank empty stores the offset; `span k <ml>` after adding a known volume (weigh it: ml = g ÷ density) stores `ml_per_count`; `show` prints the raw and ml values for all slots.

## 7. Firmware quality checklist

- [ ] Actuators only move while `Station.RunPermit` = 1 and the PLC heartbeat is alive; tested by pulling the access point's power mid-sequence (the arm must stop and report `ABORTED` after reconnecting).
- [ ] Task watchdog enabled: the node reboots if the loop stalls for 5 s, and boots with every actuator idle and the arm un-homed.
- [ ] No blocking waits longer than 100 ms in the loop, apart from bounded Modbus timeouts (1.5 s worst case).
- [ ] Static IP, and the PLC address configurable over the serial console (stored in NVS).
- [ ] The heartbeat keeps running when the scanner, a servo or the sensor is unplugged, so the PLC can tell "node alive, device missing" (fault bit) from "node dead" (offline).
- [ ] Writes only the registers listed for the node.
- [ ] The arm's poses re-taught and replayed after any mechanical change; lid detection checked with and without a lid.
- [ ] `captsone_registers.h` regenerated (`npm run tag-map`) and the firmware rebuilt after any register-map change.
- [ ] OTA updates, if you add them, are password-protected and only reachable from the control network.
