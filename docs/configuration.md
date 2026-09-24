# Configuration reference

## Line configuration (`twin/src/config.ts`)

`DEFAULT_CONFIG` describes the line. The Node twin and the virtual PLC both use it. On the physical prototype, the **PLC holds the authoritative calibration values**; keep `config.ts` in sync so simulation matches the hardware ([prototype/io-map.md](prototype/io-map.md#calibration-values-per-tank)).

| Key | Default | Meaning |
| --- | --- | --- |
| `lineId` | `CAP-LINE-01` | Line identifier |
| `beltSpeedMPerSec` | `0.20` | Belt speed. The twin converts it into transit time between stations |
| `stationSpacingM` | `0.50` | Distance between adjacent stations |
| `maxConcurrentContainers` | `4` | Pipelining cap: containers on the belt at once |
| `sensorWaitTimeoutSec` | `6.0` | Maximum wait for a station or sensor before a container is JAMMED (paused while halted) |
| `dispenseVariance` | `0.02` | Dosing jitter in simulation (±2%). QC tolerance is `max(1 ml, target × (variance + 1%))` |
| `tanks` | `TANK_SLOTS[0..2]` | Enabled tanks at start, in slot order. Barcode volume order = this order |
| `stations` | LABEL, SCAN, BAY-1..3, CAP, PRESS, QC, GATE, SORT | Stations in belt order. One `BAY-k` per tank. `SCAN`, `QC` (sort sensor) and `GATE` (reject diverter) are required; `LABEL`, `MIX`, `CAP`, `PRESS` and `SORT` are optional. The default matches the bill of materials ([prototype/bom.md](prototype/bom.md)) and has no mixer |
| `stationTimesSec` | label 1.0, scan 0.5, cap 2.5, press 0.8, qc 0.4, gate 0.3, sort 0.3 | Time a container spends at each non-dispense station. Each must stay below `sensorWaitTimeoutSec`. On the physical line, LABEL, CAP and PRESS end when the ESP32 station node reports Done ([prototype/io-map.md](prototype/io-map.md#4-register-map-modbus-tcp)) |
| `sort.lanes` | `A` "Lane A (small bottles)", `B` "Lane B (large bottles)" | The two output lanes after the sort diverter. `lanes[0]` is the diverter at rest |
| `sort.smallBottleMaxMl` | `250` | Bottle type rule: recipes totalling at most this go to `lanes[0]`, larger ones to `lanes[1]`. The sort sensor re-confirms the type on the physical line |
| `mixPolicy` | interleaved, 2 rounds | Dispense ordering for a multi-nozzle manifold. On one-bay-per-tank lines, dispensing follows belt order ([engine-design.md](engine-design.md#belt-order)) |
| `mixDurationSec` | `1.5` | Mixer run time (only if a `MIX` station is configured) |
| `refillAmountMl` | `4000` | Refill target above the threshold |
| `throughputWindowSec` | `60` | Rolling throughput window |
| `safety.eStopButtons` | `PANEL` "Local control panel", `ENTRY` "Line entry", `EXIT` "Line exit" | Physical E-Stop buttons `{ id, name }` in PLC mask bit order (max 16). `name` is what the HMI shows ("pressed at Line exit"). Must match the PLC's `I_EStop_*_Mon` inputs |
| `safety.remoteResetAllowed` | `false` | Allow a safety reset from the HMI (REMOTE mode only). Leave `false` unless a risk assessment approves it; the physical PLC must match (`LineState.REMOTE_RESET_ALLOWED`) |
| `safety.initialMode` | `remote` | Starting key-switch position in simulation |
| `safety.startRunning` | `true` | Simulation convenience: start reset and running. A physical PLC always powers up needing RESET then START |
| `mockSensorPeriodSec` | `3.0` | Simulated barcode feeder period |
| `snapshotPeriodSec` | `0.5` | Snapshot file write period |

**Tank slots** (`TANK_SLOTS`): eight fixed definitions `T1..T8`, each with a name, colour, `capacityMl`, `refillThresholdMl`, `dispenseRateMlPerSec` and `valveOpeningPct`. `valveOpeningPct` (default 80) is the proportional valve opening the PLC's analog output commands while dispensing; `dispenseRateMlPerSec` is the flow measured **at that opening**, so recalibrate the rate whenever you change the opening. Slot k always maps to bay `BAY-k` and PLC register block `Tank<k>`. Change calibration here.

The names and colours in `TANK_SLOTS` are only **defaults**. Operators rename and recolour any slot (including spare ones) from **Controls → Tank colors** in the HMI, or give a new tank its name and colour when they add it. Edits are saved to `CAPTSONE_TANK_COLORS_FILE` (only the edited slots) and reloaded when the twin starts. "Reset" restores these defaults. Names and colours are display data on the Pi; they never go to the PLC.

`MAX_TANKS` = 8 bounds the slots and the PLC register map.

**Sample barcodes** (`SAMPLE_BARCODES`) feed the simulator. `PT1|T200|200` deliberately fails on a 3-tank line to exercise the bad-scan path: the bottle rides through unfilled and the reject diverter removes it. `PT1|T300|…` exercises sort lane B.

## Environment variables

### Twin service (`twin/`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAPTSONE_MODE` | `sim` | `sim` = simulated line; `plc` = bridge to a PLC |
| `CAPTSONE_PORT` | `43124` | HTTP port |
| `CAPTSONE_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` exposes it on the network, which is normally not needed) |
| `PLC_HOST` | — | PLC IP (**required** in `plc` mode) |
| `PLC_PORT` | `502` | PLC Modbus TCP port |
| `PLC_UNIT_ID` | `1` | Modbus unit id |
| `PLC_POLL_MS` | `250` | Bridge poll period |
| `PLC_COIL_BASE` | `0` | Modbus address of register-map coil 0. `0` for the virtual PLC and the Micro850, whose Modbus mapping puts coil 0 at CCW address 000001 ([prototype/micro850-plc.md §2](prototype/micro850-plc.md#2-modbus-address-mapping)). Only a PLC with fixed coil memory elsewhere needs another value |
| `CAPTSONE_TANK_COLORS_FILE` | `twin/runtime/tank-colors.json` | Where operator tank name/colour edits are saved (both modes). Delete it to return to the `TANK_SLOTS` defaults. A missing or unreadable file means defaults |

### Virtual PLC (`npm run virtual-plc`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `VPLC_PORT` | `5020` | Modbus TCP port (502 needs admin/root) |
| `VPLC_HOST` | `0.0.0.0` | Bind address |
| `VPLC_UNIT_ID` | `1` | Unit id it answers |
| `VPLC_FEED` | on | `0` disables the built-in barcode feeder, so only recipes written to the mailbox (e.g. by the ESP32 scanner node) enter |

### HMI (`hmi/`)

| Variable | When read | Default | Meaning |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_TWIN_SOURCE` | **Build time** | `mock` (`http` when started or built from the repo root) | `mock`, `http` (live twin through `/api/twin`) or `ws` (skeleton) |
| `NEXT_PUBLIC_TWIN_URL` | Build time | `/api/twin` (http) | Base URL for `http`; WebSocket URL for `ws` |
| `TWIN_HTTP_URL` | Runtime | `http://127.0.0.1:43124` | Where the `/api/twin` proxy finds the twin service |

See `hmi/.env.example`. An explicit `NEXT_PUBLIC_TWIN_SOURCE`, in the shell or `hmi/.env.local`, overrides the root scripts' default.

### Root scripts

| Variable | Meaning |
| --- | --- |
| `VPLC_PORT` | Port used by `npm run dev:plc-sim` for the virtual PLC and the bridge |
| `CAPTSONE_PORT` | Also used by `npm run doctor` and the root scripts to find the twin |
