# Captsone Twin

The digital-twin core of the **Captsone Industrial Paint Mixing System**, built on the [prototwin](https://prototwin.com) framework.

This package contains two faces of one control model:

| Artifact | Role | Runs where |
| --- | --- | --- |
| `src/PaintLineController.ts` | prototwin `Component` that drives the physical line in the simulator | ProtoTwin Simulate/Connect script editor |
| `src/BarcodeMockSensor.ts` | prototwin `Component` that feeds preprinted barcodes on a timer | ProtoTwin Simulate/Connect script editor |
| `src/core.ts` | framework-agnostic simulation engine (state machine, pipelining, OEE, snapshot) | Node (here) |
| `src/run.ts` | runnable Node harness that drives `core.ts` and emits the HMI snapshot | Node (here) |
| `src/config.ts` `src/barcode.ts` `src/recipe.ts` | shared config, custom barcode parser, `mix_sequence` planner | both |

The prototwin controller and the Node harness share `config.ts` / `barcode.ts` / `recipe.ts` / `core.ts`, so the control logic is identical between the simulator and the local demo. The controller is typechecked against the ambient `prototwin` declaration in `src/prototwin.d.ts` (the real `prototwin` module is injected by the simulator, not published to npm).

## Quick start

```bash
cd twin
npm install
npm run typecheck   # tsc --noEmit
npm run build        # emit dist/
npm start            # node dist/run.js
```

Then open:

- **Dashboard** — http://127.0.0.1:43123/
- **Snapshot JSON** — http://127.0.0.1:43123/snapshot
- **Snapshot file** — `twin/runtime/snapshot.json` (rewritten each tick)

Override the port with `CAPTSONE_PORT=5000 npm start`.

## What it does

- Preprinted **custom barcodes** encode the dispense instructions directly (ml per tank). See `src/barcode.ts`.
- A **mock sensor** feeds barcodes on a timer; the controller reads `scanSensor.io.barcodeData`.
- Each container is its own **Entity** (`ContainerStateComponent`); the controller launches one sequence per container so multiple flow concurrently (**pipelining**).
- Tanks/nozzles/sensors are **data-driven** from `config.tanks`; adding a tank is a config edit, not a code change.
- `mix_sequence` supports **sequential or interleaved** dispensing (`config.mixPolicy`).
- Every sensor wait races a timeout; a jam force-rejects and releases the station.
- Tanks **auto-refill then ACCEPT** — never reject on low level.
- `dispenseVariance` is a tunable `@Units(UnitType.Percentage)` property.

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

## Files

```
twin/
  package.json
  tsconfig.json
  .gitignore
  src/
    config.ts              # data-driven line/tank/station config + sample barcodes
    barcode.ts             # custom preprinted barcode format parser + validator
    recipe.ts              # mix_sequence: per-tank volumes -> ordered dispense plan
    core.ts                # framework-agnostic simulation engine + snapshot builder
    PaintLineController.ts # prototwin Component (dynamic handles, timeout race, ECS)
    BarcodeMockSensor.ts   # prototwin Component feeding barcodes on a timer
    run.ts                 # Node harness: ticks core, emits snapshot over HTTP + file
    prototwin.d.ts         # ambient declaration of the prototwin runtime API
  runtime/                 # gitignored; snapshot.json lands here at runtime
```

See the root `../README.md` and `../docs/engine-design.md` for the system overview and full design rationale.
