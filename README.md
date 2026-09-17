# Captsone Industrial Paint Mixing System — Digital Twin

Captsone is an industrial paint-mixing line: empty containers ride a belt past a barcode scanner, a set of paint-source tanks with dispense nozzles, a quality-check station, and an accept/reject gate. Each container arrives with a **preprinted custom barcode** that encodes the dispense instructions directly — how many milliliters to draw from each paint source. The line reads the barcode, routes the container through the right dispense bays, fills it, checks it, and accepts or rejects it, all while multiple containers flow concurrently.

This repo holds the **digital twin** of that line, built on the [prototwin](https://prototwin.com) framework.

## Why a twin

The twin mirrors the control logic of the real line so operators and integrators can:

- preview how a new paint color / tank behaves before wiring hardware,
- validate new preprinted barcode formats without printing runs,
- watch live throughput, OEE, and accept/reject counts,
- feed an HMI worker from a stable JSON snapshot contract.

## Repository layout

```
/workspace
  README.md               # this file
  docs/
    engine-design.md      # full design rationale (user-facing)
  twin/                   # the digital twin (runnable)
    README.md             # twin-specific run guide
    src/                  # config, barcode, recipe, core, prototwin controller, harness
```

## Run the twin

```bash
cd twin
npm install
npm run build
npm start
```

- Dashboard: http://127.0.0.1:43123/
- Snapshot JSON: http://127.0.0.1:43123/snapshot
- Snapshot file: `twin/runtime/snapshot.json`

Override the port with `CAPTSONE_PORT=5000 npm start`.

## Key design points (see `docs/engine-design.md` for the full reasoning)

- **Dynamic paint sources.** Tanks, nozzles, sensors, and stations are data-driven from `twin/src/config.ts`. Adding a new paint color + tank is a config edit and a barcode with one more volume field — no controller or parser rewrite. The prototwin static-handle constraint is resolved by creating handles dynamically in `initialize()` from the config.
- **Custom preprinted barcode.** `PT1|T<totalMl>|<v1>,...,<vN>[|I<rounds>]` encodes per-tank volumes directly (not a recipe-id lookup).
- **mix_sequence.** Per-tank volumes are turned into an ordered dispense plan that supports sequential (layered) or interleaved dispensing.
- **Multi-container pipelining (ECS).** Each container is its own Entity with a `ContainerStateComponent`; the controller runs one sequence per container so throughput is real.
- **Four refinements.** Refill-then-ACCEPT; barcode from `scanSensor.io.barcodeData`; timeout race on every `Wait.value`; `dispenseVariance` as `@Units(UnitType.Percentage)`.
- **HMI data contract.** A documented JSON snapshot emitted over HTTP and file write.

## Status

Core slice complete and verified: the twin typechecks (`tsc --noEmit`), builds, and runs — containers enter, scan, dispense concurrently, refill, accept/reject, and the snapshot populates counts, throughput, and OEE.
