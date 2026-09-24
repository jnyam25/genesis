# Captsone Twin

The digital-twin core of the **Captsone Industrial Paint Mixing System**: plain TypeScript on Node, with no simulator or framework dependency.

This package contains one control model with several faces:

| Artifact | Role | Runs where |
| --- | --- | --- |
| `src/core.ts` | Framework-agnostic simulation engine (state machine, pipelining, commands, events, snapshot) | Node |
| `src/run.ts` | HTTP service: simulated line (`CAPTSONE_MODE=sim`) or PLC bridge (`CAPTSONE_MODE=plc`) | Node (PC or Raspberry Pi) |
| `src/plc/virtual-plc.ts` | The core exposed on the PLC register map over Modbus TCP: the reference PLC | Node |
| `src/plc/bridge.ts` | Reads a real or virtual PLC and serves the HMI | Node (Raspberry Pi) |
| `src/config.ts`, `barcode.ts`, `recipe.ts`, `events.ts`, `metrics.ts` | Shared config, barcode parser, dispense planning, event codes, OEE maths | All of the above |

The physical line's PLC (an Allen-Bradley Micro850) implements the same register map; its program is specified in [`../docs/prototype/micro850-plc.md`](../docs/prototype/micro850-plc.md), with the virtual PLC as the reference.

## Quick start

```bash
cd twin
npm install
npm run typecheck   # tsc --noEmit
npm run build        # emit dist/
npm start            # node dist/run.js
npm test             # automated tests
npm run virtual-plc  # Modbus TCP virtual PLC on :5020
```

PLC-bridge mode (e.g. against the virtual PLC):

```bash
CAPTSONE_MODE=plc PLC_HOST=127.0.0.1 PLC_PORT=5020 npm start
```

In PowerShell: `$env:CAPTSONE_MODE="plc"; $env:PLC_HOST="127.0.0.1"; $env:PLC_PORT="5020"; npm start`. Or run `npm run dev:plc-sim` at the repo root, which starts all three pieces.

Then open:

- **Dashboard** — http://127.0.0.1:43124/
- **Snapshot JSON** — http://127.0.0.1:43124/snapshot
- **Snapshot file** — `twin/runtime/snapshot.json` (rewritten each tick)

Override the port with the `CAPTSONE_PORT` environment variable (e.g. `CAPTSONE_PORT=5000 npm start` on macOS/Linux, `$env:CAPTSONE_PORT=5000; npm start` in PowerShell). `CAPTSONE_HOST` sets the bind address (default `127.0.0.1`).

To run the twin together with the operator HMI, use `npm run dev` at the repo root (see `../INSTALL.md`).

## What it does

- Preprinted **custom barcodes** encode the dispense instructions directly (ml per tank). See `src/barcode.ts`.
- Containers are labelled and scanned, stop at **one bay per tank, in belt order**, then pass the capping arm, lid press, sort sensor (QC), reject diverter and sort diverter. Several containers flow at once (**pipelining**), held at stations by stoppers.
- Tanks come from **fixed slots** (`TANK_SLOTS`, `T1..T8`). Adding or removing a tank is a config edit or a runtime command, not a code change.
- `mix_sequence` builds sequential or interleaved plans (`config.mixPolicy`). They become physical order only with a multi-nozzle manifold.
- Every wait is **bounded by a timeout** that pauses while halted; a jam rejects the container and releases the station.
- Tanks **auto-refill, then ACCEPT**: a container is never rejected for a low tank.
- **Emergency stops and control authority** (`src/safety.ts`):
  - digital and physical E-Stops, which both shut the line down;
  - release → reset (local by default) → start;
  - a LOCAL/REMOTE key switch; stop and E-Stop work from anywhere.
- **Operator commands:** start, stop, jog, reject pusher, enable/disable tank, plus `sim*` commands that operate the simulated local panel and physical E-Stops.
- Events carry **structured codes** (`src/events.ts`), identical to what the PLC publishes.
- `dispenseVariance` (a fraction: 0.02 = ±2 %) jitters each simulated fill.

## HMI data contract

See `docs/engine-design.md` for the full shape. The live snapshot is:

```json
{
  "tanks": [{ "id": "T1", "name": "Titanium White", "colorCode": "#F4F1EA", "levelMl": 4889.6, "capacityMl": 5000 }],
  "containers": [{ "id": 1, "status": "ACCEPTED", "fillMl": 247.1, "targetMl": 250 }],
  "counts": { "accepted": 3, "rejected": 1, "total": 4 },
  "throughputCpm": 2.35,
  "oee": { "availability": 0.988, "performance": 1, "quality": 0.75, "overall": 0.741 },
  "lastEvent": "container 1 ACCEPTED (247.1/250 ml)",
  "timestamp": 50.0
}
```

Transports: **HTTP** `GET /snapshot` (CORS-enabled) and **file write** `runtime/snapshot.json`, both emitted every `config.snapshotPeriodSec` (0.5 s).

### Operator HMI endpoints

The operator HMI (`../hmi`) uses a visualization-oriented shape, translated by `src/hmi.ts`:

| Endpoint | Purpose |
| --- | --- |
| `GET /hmi/state` | Live state in the HMI `TwinState` shape (string ids, station-based statuses, structured events) |
| `POST /hmi/command` | `{ "command": "jogBelt" \| "firePusher" \| "addTank" \| "removeTank" \| "setTankColor" \| "resetTankColor" \| "eStop" \| "clearEStop", "tankId"?: "T2", "name"?: "Crimson", "colorCode"?: "#B00020" }` ([docs/api.md](../docs/api.md#post-hmicommand)) |

Commands are implemented in `core.ts`: latched E-Stop, jog while halted, manual reject at QC, and adding/removing tanks at runtime. See `../docs/engine-design.md` § "Operator HMI adapter".

## Files

```
twin/
  src/
    config.ts              # line/tank/station config, TANK_SLOTS, sample barcodes
    barcode.ts             # custom preprinted barcode format parser + validator
    recipe.ts              # mix_sequence planner + beltOrderSteps
    events.ts              # structured event / reject / station codes (wire contract)
    metrics.ts             # OEE, rolling throughput, ideal cycle time
    feeder.ts              # mock barcode feeder
    core.ts                # simulation engine + operator commands + snapshot builder
    hmi.ts                 # adapter to the operator HMI state shape + command dispatch
    run.ts                 # HTTP service (sim or PLC bridge), snapshot file
    plc/
      tag-map.ts           # PLC register map (the hardware contract)
      modbus.ts            # Modbus TCP client + server (no dependencies)
      virtual-plc.ts       # reference PLC: core on the register map
      bridge.ts            # Raspberry Pi bridge: PLC ↔ HMI
      print-tag-map.ts     # generates docs/prototype/io-map.md tables (npm run tag-map)
    safety.ts              # E-Stop / reset / local-remote state machine
    tank-colors.ts         # saved operator tank names and colours
    test/                  # node:test suites (npm test)
  runtime/                 # gitignored; snapshot.json lands here at runtime
```

See `../README.md`, `../docs/engine-design.md`, `../docs/api.md` and `../docs/prototype/`.
