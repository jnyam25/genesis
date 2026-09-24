# ESP32 station nodes

The bill of materials ([bom.md](bom.md)) budgets **two ESP32 DevKit boards**, linked to the Micro850 PLC **wirelessly** through an access point on the control switch. They run the stations that are awkward for a PLC: barcode parsing, the label applicator, the robotic capping arm, the lid press and the sort sensor. Both are **Modbus TCP clients** of the PLC. The PLC stays the supervisor: it decides when a container is at a station and when it may leave, and the nodes only act on the PLC's request while it grants `Station.RunPermit`.

| Node | Job | Writes | Reads |
| --- | --- | --- | --- |
| **ESP32 #1 scanner node** (line entry) | Apply the label; read the barcode scanner, parse and validate `PT1` barcodes, hand the recipe to the PLC | `Recipe.*` 301–311 then `Recipe.Seq` 300; `Station.LabelDone` 422; `Station.ScannerNodeFaults` 429; `Field.ScannerNodeHeartbeat` 411 | `Recipe.AckSeq` 312, `Sys.TankCount` 3, `Station.RunPermit` 420, `Station.LabelRequest` 421, `Sys.PlcHeartbeat` 1 |
| **ESP32 #2 station node** (after the fill bays) | Run the capping arm sequence and the lid press; read the sort sensor | `Station.CapDone` 424, `Station.PressDone` 426, `Station.SortSensorType` 427, `Station.SortSensorContainer` 428, `Station.StationNodeFaults` 430; `Field.StationNodeHeartbeat` 412 | `Station.RunPermit` 420, `Station.CapRequest` 423, `Station.PressRequest` 425, `Sys.PlcHeartbeat` 1 |
| Tank-level node (optional, not in the BOM) | Measure tank levels with sensors that have no industrial output (e.g. load cells, ultrasonic) | `Field.Tank<k>LevelMl` 400–407, `Field.TankNodeHeartbeat` 410 | `Sys.TankEnableMask` 4 |

Because nodes #1 and #2 drive actuators, the rules in [safety.md §2a](safety.md#2a-actuators-driven-by-the-esp32-nodes) apply: actuator power comes through the safety relay, and the firmware stops on permit or heartbeat loss. Nothing on an ESP32 is part of the safety function.

If your level sensors have 4–20 mA outputs, wire them to PLC analog inputs instead and skip the tank node. Fewer parts means fewer failure modes.

This document specifies the firmware. **No ESP32 firmware is included in the repo yet.**

## 1. Hardware

| Item | Recommendation |
| --- | --- |
| Board | ESP32 DevKit (per the BOM), on **Wi-Fi to a dedicated access point** that is wired to the control switch, so the nodes reach the PLC's Ethernet address ([communication.md](communication.md#1-network)). Wired Ethernet boards (WT32-ETH01, Olimex ESP32-POE) are a drop-in upgrade if Wi-Fi drops cause heartbeat faults |
| Label applicator (node #1) | Servo or stepper roller mechanism (built, per the BOM) on a driver board; driver power from the safety-relay-switched supply |
| Capping arm (node #2) | ESP32-based arm kit (Hiwonder xArm / LewanSoul MaxArm class). Drive it through its own controller over serial, or its servo bus; servo power from the safety-relay-switched supply |
| Lid press (node #2) | Linear actuator via relay/MOSFET module, or a pneumatic cylinder via a 24 V solenoid and an opto-isolated relay module. Spring-return |
| Sort sensor (node #2) | Whatever tells the two bottle types apart reliably (height via IR/ultrasonic, colour sensor, or a second barcode read). 3.3 V logic or level-shifted |
| Power | Dedicated 5 V supply (or PoE), in the electronics enclosure. Not powered from the 24 V field supply without a proper DC/DC converter |
| Logic levels | ESP32 GPIO is **3.3 V and not 5 V / 24 V tolerant**. Use optocouplers or isolated modules for any field signal |
| Scanner | A fixed-mount 1D/2D scanner module with a TTL UART or USB-CDC output (e.g. GM65/GM861-class modules), configured for **continuous or sensor-triggered mode** and a CR/LF suffix. For RS-232 scanners, add a MAX3232 level shifter |
| Load cells (tank node) | One HX711 amplifier per load cell (or per summed set of cells). Mount cells per the manufacturer's instructions; isolate from vibration |
| Ultrasonic level (alternative) | Sealed, IP-rated sensor; mind vapour and foam |
| Enclosure | Away from liquids (see [safety.md](safety.md) §2) |

## 2. Scanner node firmware

**Libraries.** An Arduino-framework Modbus TCP client that supports ESP32 (e.g. the `modbus-esp8266` library, which supports ESP32 despite its name), or ESP-IDF's `esp-modbus` component. Use Ethernet or Wi-Fi from the ESP32 core.

**Barcode rules.** These must match [`twin/src/barcode.ts`](../../twin/src/barcode.ts) exactly:

```
PT1|T<totalMl>|<v1>,<v2>,...,<vN>[|I<rounds>]
```

| Check | ParseResult |
| --- | ---: |
| OK | 0 |
| Header ≠ `PT1` | 1 `BAD_HEADER` |
| Total missing, not a number, or ≤ 0 | 2 `BAD_TOTAL` |
| Volume count ≠ `Sys.TankCount` | 3 `TANK_COUNT_MISMATCH` |
| Any volume < 0 | 4 `NEGATIVE_VOLUME` |
| `|Σ volumes − total| > 1 ml` | 5 `VOLUME_SUM_MISMATCH` |
| Wrong field count, non-numeric volume, bad `I` option | 6 `MALFORMED` |

Volumes and the total are whole millilitres on the wire (UINT16). Round fractional volumes to the nearest ml.

**Main loop:**

```text
setup:
  start Wi-Fi (static IP 192.168.10.31), Modbus client → PLC 192.168.10.10:502, unit 1
  (one persistent connection; close it cleanly before reconnecting — communication.md §2)
  seq := read(Recipe.AckSeq)            // resume after reboot without replaying

every 1 s:
  write Field.ScannerNodeHeartbeat := heartbeat++ (wrap 65535)

every 100 ms (label applicator):
  permit := read(Station.RunPermit) == 1 and Sys.PlcHeartbeat changed within 1 s
  req := read(Station.LabelRequest)
  if req != 0 and req != lastLabelled and permit:
    run the applicator stroke (abort to home and set ScannerNodeFaults bit0 if permit drops or the stroke times out)
    write Station.LabelDone := req; lastLabelled := req

on barcode line received (trim CR/LF; ignore empty; ignore a repeat of the same code within 500 ms):
  tankCount := read(Sys.TankCount)
  result, total, rounds, vols[] := parse(line, tankCount)
  wait until read(Recipe.AckSeq) == seq      (timeout 2 s → fault LED, keep waiting; don't drop the scan)
  write multiple @301: [result, total, rounds, vols[0..7] (unused = 0)]   // 11 registers
  seq := (seq == 65535) ? 1 : seq + 1
  write Recipe.Seq := seq
  blink OK LED; keep the last 20 scans in a ring buffer for diagnostics (serial console)

on Modbus error:
  back off 500 ms, reconnect, and retry the same write — never increment seq twice for one scan
```

**Testing without a PLC.**
1. Run `npm run virtual-plc` on a PC, and point the node at `<PC IP>:5020`.
2. Set `VPLC_FEED=0` so only your scans create containers.
3. Watch the containers on the HMI (`npm run dev:plc-sim` also works if you set `VPLC_FEED=0` in the environment).

**Printing test barcodes.** Code 128 handles `|` and `,`. Test with the samples in [`config.ts`](../../twin/src/config.ts):
- `PT1|T250|100,80,70`
- `PT1|T300|120,90,90|I4`
- `PT1|T200|200` (fails on a 3-tank line: `TANK_COUNT_MISMATCH`)

## 3. Station node firmware (capping arm, lid press, sort sensor)

```text
setup:
  Wi-Fi (static IP 192.168.10.33), Modbus client → PLC 192.168.10.10:502 (one persistent connection)
  home the arm to its park pose (clear of the belt); press retracted

every 1 s:
  write Field.StationNodeHeartbeat := heartbeat++

every 50 ms:
  permit := read(Station.RunPermit) == 1 and Sys.PlcHeartbeat changed within 1 s
  if not permit: stop motion, park the arm if it can do so safely, retract the press; do not resume a
                 half-finished sequence on its own — set the station's StationNodeFaults bit and wait for a new request

  cap := read(Station.CapRequest)
  if cap != 0 and cap != lastCapped and permit:
    pick lid → place on bottle → return to park          (timeout → StationNodeFaults bit0)
    write Station.CapDone := cap; lastCapped := cap

  press := read(Station.PressRequest)
  if press != 0 and press != lastPressed and permit:
    extend press, dwell, retract, confirm retracted      (timeout → StationNodeFaults bit1)
    write Station.PressDone := press; lastPressed := press

  on sort sensor reading for the container at QC:
    write Station.SortSensorType := 1 (lane A type) | 2 (lane B type) | 0 (can't tell → the PLC rejects)
    write Station.SortSensorContainer := id            // id from the PLC's container tracking (Container1..8)
```

Clear a fault bit only after the cause is fixed (arm re-homed, press retracted) and the operator has reset the line. The PLC treats a set bit as a fault for that station and rejects the container that was there.

## 4. Tank-level node firmware (optional)

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

**PLC-side validation** (see [micro850-plc.md](micro850-plc.md)):
- use a slot's field value only if the node heartbeat changed within 3 s and the value is within 0..capacity;
- otherwise raise `FAULT` and stop refilling that tank.

**Calibration** (serial console commands, stored in NVS):
1. `tare k` with the tank empty stores the offset.
2. `span k <ml>` after adding a known volume (weigh it: ml = g ÷ density) stores `ml_per_count`.
3. `show` prints the current raw and ml values for all slots.

## 5. Firmware quality checklist

- [ ] Actuators only move while `Station.RunPermit` = 1 and the PLC heartbeat is alive; tested by pulling the Wi-Fi AP power mid-sequence.
- [ ] Hardware watchdog enabled; the node reboots if the main loop stalls for more than 5 s, and boots with every actuator output off.
- [ ] No blocking waits longer than 100 ms in the loop, apart from bounded Modbus timeouts.
- [ ] Static IP, and the PLC IP configurable over the serial console (stored in NVS).
- [ ] The heartbeat keeps running when the scanner or sensors are unplugged, so the PLC can tell "node alive, sensor missing" from "node dead".
- [ ] Writes only the registers listed for the node ([communication.md §2](communication.md#who-writes-what)).
- [ ] OTA updates, if enabled, are password-protected and only reachable from the control network.
- [ ] Parse rules unit-tested against the barcode table above (the same cases as `twin/src/barcode.ts`).
