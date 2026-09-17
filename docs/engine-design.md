# Captsone Twin — Engine Design

Every design decision in the Captsone digital twin, with specific reasoning. Companion to the code under `twin/src/`.

## 1. System overview

A container enters the belt with a **preprinted custom barcode**. A scanner reads it. The controller parses the barcode into per-tank volumes, turns those into an ordered **mix_sequence** dispense plan, routes the container through the right dispense bays (one per tank), dispenses with a small jitter, runs a quality check, and accepts or rejects at the gate. Multiple containers do this **concurrently** — each is its own Entity, and the controller launches one sequence per container. Tanks auto-refill when low. Every sensor wait races a timeout; a jam force-rejects the container and frees the station.

Two faces, one model: `PaintLineController.ts` (prototwin `Component` for the simulator) and `core.ts` + `run.ts` (runnable Node harness). They share `config.ts`, `barcode.ts`, `recipe.ts`, so the logic is identical.

## 2. Custom preprinted barcode format

### Decision

```
PT1|T<totalMl>|<v1>,<v2>,...,<vN>[|I<rounds>]
```

- `PT1` — literal header ("PaintTwin", format version 1).
- `T<totalMl>` — target total fill in milliliters, e.g. `T250`.
- `<v1>,...,<vN>` — per-tank volume in ml, in `config.tanks` order, e.g. `100,80,70`.
- `|I<rounds>` — **optional** override of the interleaving round count from `config.mixPolicy`. Omit to use the config policy.

| Barcode | Meaning |
| --- | --- |
| `PT1\|T250\|100,80,70` | 3 tanks, 100+80+70 = 250 ml total |
| `PT1\|T300\|120,90,90\|I4` | 3 tanks, interleaved into 4 rounds |
| `PT1\|T200\|200` | single-tank fill (only valid if config has 1 tank) |

### Why this format

1. **Direct instructions, not a lookup.** The user's key requirement is that the barcode *encodes the dispense instructions directly* — how many units from each source — rather than a recipe ID the controller resolves against a database. `PT1|T250|100,80,70` is the entire instruction set. No recipe table, no lookup miss, no version skew between the printed label and the line's recipe store.
2. **Preprinted before entry.** The format is self-describing and stateless, so containers can be labeled at the filling plant and run on any Captsone line with the same tank order.
3. **Trivially extensible to more tanks.** Adding a tank is appending one more comma-separated number. The parser splits on `,` and validates the count against `config.tanks.length`; it never indexes named fields. A 4-tank line prints `PT1|T300|100,80,70,50`; a 1-tank line prints `PT1|T200|200`. No parser code changes between configurations.
4. **Versioned header.** `PT1` lets us evolve the format (`PT2`, …) without breaking existing labels. The parser rejects unknown headers with a structured `BAD_HEADER` error rather than misinterpreting them.
5. **Checksum-style total.** `T<totalMl>` is redundant with the sum of the per-tank volumes, but intentional: it lets the parser catch misprints (a wrong digit that breaks the sum is caught by `VOLUME_SUM_MISMATCH`) and gives the gate a target to validate the fill against, independent of the per-tank breakdown.
6. **Optional interleave override.** `|I<rounds>` keeps the barcode authoritative for *volumes* (the user's requirement) while letting a specific container demand a different layering than the line default. Omitting it means "use `config.mixPolicy`", so most labels stay short.

### Validation (in `barcode.ts`)

`parseBarcode(raw, config, toleranceMl = 1)` returns a `ParsedBarcode` or throws a `BarcodeError` with one of: `BAD_HEADER`, `BAD_TOTAL`, `TANK_COUNT_MISMATCH`, `NEGATIVE_VOLUME`, `VOLUME_SUM_MISMATCH`, `MALFORMED`. The controller force-rejects the container on any error and logs the code, so a misprint never silently produces the wrong paint.

### Why not a recipe-ID lookup

A recipe-ID barcode (`RECIPE:42`) would couple every label to a recipe table that lives on the line. Adding a paint color would mean editing the recipe table *and* the controller's tank wiring *and* reissuing labels. With direct encoding, adding a paint color is purely additive: append a tank to config, print new labels with one more volume. Old labels keep working on lines that still have the old tank count (the parser only requires the count to match *that line's* config). This is the "dynamic system" the user asked for.

## 3. Dynamic-tank mechanism (the static-handle constraint)

### The problem

The baseline prototwin `PaintLineController` declared its sensor/actuator references as **statically-named fields**:

```ts
public nozzleSensor1: Handle<SensorComponent> = this.handle(SensorComponent);
public nozzleSensor2: Handle<SensorComponent> = this.handle(SensorComponent);
public nozzleSensor3: Handle<SensorComponent> = this.handle(SensorComponent);
public tankLevel1: Handle<SensorComponent> = this.handle(SensorComponent);
```

That is fixed at 3 tanks. Adding a 4th tank means editing the source to add `nozzleSensor4`, `tankLevel4`, and every `Wait.value(this.nozzleSensor3.value!.io.state, true)` call site that hard-codes the index. That violates the user's requirement that adding a tank must not require disassembling or rewriting the logic.

### The constraint

`this.handle(Type)` is a **method** on `Component`, not a macro. The docs show it used as a field initializer (`public x: Handle<T> = this.handle(T)`), but that is a convention for inspector-editable references, not a language restriction. The method can be called any number of times, and the returned `Handle<T>` is lifetime-managed by the component (nulled automatically if the referenced object is deleted). There is no requirement that handles be declared as named fields.

### The chosen approach — dynamic handle arrays

`PaintLineController.initialize()` builds the handles from the config and stores them in arrays:

```ts
this.nozzleSensors = [];
this.tankLevelSensors = [];
this.nozzleActuators = [];
for (let i = 0; i < this.config.tanks.length; i++) {
  this.nozzleSensors.push(this.handle(SensorComponent));
  this.tankLevelSensors.push(this.handle(SensorComponent));
  this.nozzleActuators.push(this.handle(MotorComponent));
}
for (const s of this.config.stations) {
  this.stationSensors.set(s.id, this.handle(SensorComponent));
}
```

All control logic then indexes by tank index (`this.nozzleSensors[step.tankIndex].value`) or by station id (`this.stationSensors.get(stationId)`). No code path names a specific tank.

### Why this approach (and not the alternatives)

- **Alternative A — generous static max set.** Declare `nozzleSensor1..8`, `tankLevel1..8` and map config entries to them. This works and is robust if prototwin ever requires handles to be field-declared for inspector editing. We keep `MAX_TANKS = 8` in `config.ts` as a documented ceiling and `initialize()` asserts `tanks.length <= MAX_TANKS`. But we do **not** pre-declare 8 of each field, because (a) it wastes inspector UI on phantom tanks, (b) it forces the control loop to skip null handles, and (c) it still caps the line at a compile-time constant. Dynamic arrays have none of these drawbacks. `MAX_TANKS` remains only as a sanity guard and as the bound we would fall back to if a future prototwin version required field-declared handles.
- **Alternative B — `findComponent` at runtime.** Walk `entity.world.descendants` each tick to find tanks by name. Rejected: O(n) per tick per lookup, fragile against renames, and offers nothing over handles (handles already give lifetime-safe weak references).
- **Alternative C — a single `@HandleArray` decorator.** prototwin offers `@HandleArray(Entity)`, attractive for a design-time model. We did not use it because the controller needs *typed pairs* (nozzle sensor + tank level + nozzle actuator per tank), and a single array of entities would still require per-tank component lookups. Dynamic arrays of typed handles express the pairing directly. If the model is later wired in the prototwin editor, `@HandleArray` is the natural place to expose the wiring; the control logic would not change.

### Justification summary

Dynamic creation in `initialize()` is faithful to the prototwin API (handles are method results, lifetime-managed), removes the compile-time tank ceiling, and makes "add a tank" a pure config edit. `MAX_TANKS` is retained as a sanity ceiling and as the documented fallback for the static-declaration alternative.

## 4. Multi-container pipelining via ECS

### Decision

Each container is its own **Entity** carrying a `ContainerStateComponent` (id, barcode, parsed plan, fill, target, accept/reject flags). The controller launches **one `Sequence` per container** so multiple containers progress concurrently. Station mutual exclusion is enforced by checking the station's presence sensor before routing a container onto it. Belt speed is a single global setting (`io.beltSpeed` / `beltMotor`).

### Why ECS, not a single coroutine

A single coroutine processing containers one at a time would serialize the line — container 2 could not enter SCAN until container 1 reached GATE. Real lines pipeline: container 1 is dispensing at BAY-1 while container 2 is scanning and container 3 is in transit. Modeling each container as its own Entity with its own state component and its own sequence is the natural ECS expression of that: the controller is a thin orchestrator, the per-container state lives on the container, and concurrency falls out of launching independent sequences.

### How pipelining is realized in the harness (`core.ts`)

The Node harness models the same pipelining with a tick loop and station occupancy:

- Each container has an ordered `ops` list (SCAN → dispense steps → QC → GATE) and a state (`ENTERING`, `MOVING`, `SERVING`, `BLOCKED`, `ACCEPTED`, `REJECTED`, `JAMMED`).
- A station serves one container at a time (`occupancy: Map<stationId, containerId>`). A container that reaches an occupied station enters `BLOCKED` and races a timeout; if the timeout wins, it is force-rejected and the station is released.
- `maxConcurrentContainers` caps how many containers may be on the belt at once, modeling the physical belt length.
- Transit between stations takes `stationSpacingM / beltSpeedMPerSec`, so belt speed is the single global flow knob — raise it and the line speeds up (until a station becomes the bottleneck, which is exactly Little's Law).

### Why belt speed is global

The user asked for "global belt speed + per-station routing." A single belt has one speed; per-station routing is which bay a container stops at (driven by its mix plan). Splitting belt speed per station would model a segmented belt the physical line does not have. So: one `beltSpeed`, many routes.

## 5. mix_sequence — advanced recipe parsing

### Decision

`recipe.ts` turns a parsed barcode's per-tank volumes into an ordered `DispensePlan`: a list of `MixStep { tankIndex, volumeMl, order }`. Two policies:

- **sequential** — dispense each tank's full volume, one tank at a time, in config order. Produces a layered (bottom-up) fill.
- **interleaved:R** — split each tank's volume into `R` equal sub-volumes and emit them round-robin across tanks. Produces an interleaved/stratified fill, useful for suspensions that settle or for gradient effects.

The active policy comes from `config.mixPolicy` unless the barcode carries `|I<rounds>`, which overrides it for that container.

### Why this satisfies "not just a flat ratios array"

A flat ratios array (`[0.4, 0.32, 0.28]`) only describes *proportions*. It cannot express *order*: which color goes in first, whether to interleave, how many layers. `mix_sequence` is an ordered list of concrete steps with explicit `order` indices, so it can represent "lay down 50 ml of white, then 40 ml of red, then 50 ml of white, then 40 ml of red" — a 2-round interleave — as four distinct steps. The barcode supplies the volumes; the policy supplies the order. Adding a new tank adds one more column to the round-robin automatically; no step-list code changes.

### Precision handling

Interleaving splits a volume into `R` parts; `100 / 3` is not exact in milliliters. `buildDispensePlan` distributes the remainder into the first rounds (3-decimal ml precision), so the sum of a tank's sub-volumes always equals the barcode's per-tank volume. The gate validates the final fill against `T<totalMl>` within tolerance, so a 0.001 ml rounding never causes a false reject.

## 6. The four refinements

### (a) Refill-and-reject → auto-refill then ACCEPT

**Baseline behavior:** when a tank dropped below a threshold, the controller rejected the container.

**Fix:** in `PaintLineController.dispenseStep`, if `level < refillThresholdMl`, the controller opens the refill actuator (`nozzle.moveTo(capacity)`), waits for the level to recover past `refillThresholdMl + refillAmountMl`, then proceeds to dispense and eventually ACCEPT. The container is never rejected solely because a tank ran low. In `core.ts`, `dispense()` sets `tank.refilling = true` with a 1.5 s timer and continues; the container's service time grows but its outcome stays ACCEPT (subject to the normal fill-tolerance check at the gate).

**Reasoning:** rejecting a good container because a tank needs topping up wastes a preprinted container and breaks the "dynamic, keeps running" requirement. Refill is a maintenance event, not a quality event.

### (b) Barcode from sensor IO (`scanSensor.io.barcodeData`)

**Decision:** a separate `BarcodeMockSensor` prototwin component holds a `StringSignal barcodeData` and writes a new preprinted barcode to it every `periodSec`. The controller reads `scanSensor.io.barcodeData` instead of a hard-coded value.

**Reasoning:** the scanner is a physical device with its own IO; modeling it as its own component keeps the controller free of scanner timing and lets you swap the mock for a real scanner driver without touching the controller. It also makes the "preprinted barcode enters the line" story explicit: the sensor emits, the controller consumes.

### (c) Timeout safety on every `Wait.value`

**Decision:** every sensor wait goes through `waitForSignal`, which races the value wait against a timeout:

```ts
private async waitForSignal<T>(signal: IReadable<T>, expected: T): Promise<boolean> {
  const winner = await Wait.any([
    Wait.value(signal, expected),
    Wait.seconds(this.config.sensorWaitTimeoutSec),
  ]);
  return winner === expected;
}
```

If the timeout wins, the caller force-rejects the container (`forceReject`) and releases the station. In `core.ts`, the `BLOCKED` and `SERVING` states each carry a `deadlineSec` countdown with the same effect.

**Reasoning:** a stuck sensor or a jammed container would otherwise hang a `Wait.value` forever, stalling the whole line. Racing with `Wait.any` bounds every wait to `sensorWaitTimeoutSec` and turns a stall into a reject, which is the correct physical response (divert the jammed container, keep the line running). `Wait.any` resolves with the first completed future's value, so `winner === expected` cleanly distinguishes "signal arrived" from "timeout".

### (d) `dispenseVariance` as `@Units(UnitType.Percentage)`

**Decision:** `dispenseVariance` is exposed as a getter/setter on `PaintLineController` decorated with `@Units(UnitType.Percentage)`. Internally it is a fraction (0.02 = ±2%); the inspector shows and edits it as a percentage (2 → 2%). The IO signal `dispenseVariancePct` carries the percent value so PLC/HMI clients see 0–100.

**Note on the enum name:** the user wrote `UnitType.Percent`, but the prototwin API enum member is `UnitType.Percentage` (a value of 1 displays as 100%). We use `UnitType.Percentage` to match the real API; this is the only place the user's shorthand differs from the framework.

**Reasoning:** variance is a tunable process parameter an operator should set at the HMI, not a constant in code. Exposing it through `@Units` + an IO signal makes it inspector-editable and PLC-writable, and the percent unit matches how operators think about tolerance.

## 7. HMI data contract

### Shape

```ts
interface Snapshot {
  tanks: { id: string; name: string; colorCode: string; levelMl: number; capacityMl: number }[];
  containers: { id: number; status: ContainerStatus; fillMl: number; targetMl: number }[];
  counts: { accepted: number; rejected: number; total: number };
  throughputCpm: number;
  oee: { availability: number; performance: number; quality: number; overall: number };
  lastEvent: string;
  timestamp: number;
}
```

`ContainerStatus` is one of `ENTERING | MOVING | SERVING | BLOCKED | ACCEPTED | REJECTED | JAMMED`. All numeric fields are rounded for stable transport (ml to 1 decimal, OEE to 3 decimals). `timestamp` is simulated seconds since start.

### Example payload

```json
{
  "tanks": [
    { "id": "T1", "name": "Titanium White", "colorCode": "#F4F1EA", "levelMl": 4889.6, "capacityMl": 5000 }
  ],
  "containers": [
    { "id": 1, "status": "ACCEPTED", "fillMl": 247.1, "targetMl": 250 }
  ],
  "counts": { "accepted": 3, "rejected": 1, "total": 4 },
  "throughputCpm": 2.35,
  "oee": { "availability": 0.988, "performance": 1, "quality": 0.75, "overall": 0.741 },
  "lastEvent": "container 1 ACCEPTED (247.1/250 ml)",
  "timestamp": 50.0
}
```

### OEE definitions

- **availability** = `1 - lineBlockedSec / simTimeSec` — the fraction of time the line was not blocked behind a jammed/occupied station.
- **performance** = `(idealCycleSec * counts.total) / operatingSec` where `operatingSec = simTimeSec - lineBlockedSec` — actual throughput vs the ideal cycle time, capped at 1.
- **quality** = `counts.accepted / counts.total`.
- **overall** = `availability * performance * quality`.

### Transport

The twin emits the snapshot over two transports it can produce without the simulator:

1. **HTTP** — `GET http://127.0.0.1:43123/snapshot` returns the latest snapshot JSON with `Access-Control-Allow-Origin: *` so an HMI worker on any origin can poll it. `GET /` returns a tiny HTML dashboard that polls `/snapshot`. Port is configurable via `CAPTSONE_PORT`.
2. **File write** — `twin/runtime/snapshot.json` is overwritten every `config.snapshotPeriodSec` (0.5 s), for file-watch integrations.

We chose HTTP + file over WebSocket because the snapshot is small, fully recomputed each tick, and poll-based consumption is trivial for an HMI worker; a streaming socket would add complexity for no payload benefit. In the real simulator, the same shape is also exposed through the controller's `PaintLineControllerIO.snapshotJson` `StringSignal`, so a PLC/Python client can read it via the IO Browser.

## 8. Verification

- `npm run typecheck` (`tsc --noEmit`) passes clean against the ambient `prototwin` declaration.
- `npm run build` emits `dist/`.
- `npm start` runs the harness: containers enter, scan, dispense concurrently, refill, accept/reject, and the snapshot populates counts, throughput, and OEE. A 50 s run produced 3 accepted, 1 rejected (a deliberately mismatched sample barcode), throughput 2.35 cpm, OEE 0.741.

## 9. File map

| File | Purpose |
| --- | --- |
| `twin/src/config.ts` | Data-driven line/tank/station config + sample barcodes; `MAX_TANKS` ceiling. |
| `twin/src/barcode.ts` | Custom preprinted barcode parser + validator. |
| `twin/src/recipe.ts` | `mix_sequence`: per-tank volumes → ordered dispense plan. |
| `twin/src/core.ts` | Framework-agnostic simulation engine + snapshot builder. |
| `twin/src/PaintLineController.ts` | prototwin `Component`: dynamic handles, timeout race, ECS pipelining. |
| `twin/src/BarcodeMockSensor.ts` | prototwin `Component` feeding barcodes on a timer. |
| `twin/src/run.ts` | Node harness: ticks core, emits snapshot over HTTP + file. |
| `twin/src/prototwin.d.ts` | Ambient declaration of the `prototwin` runtime API (offline typecheck). |

