# Captsone Twin — Engine Design

Every design decision in the Captsone digital twin, with specific reasoning. Companion to the code under `twin/src/`.

## 1. System overview

A container enters the belt and gets a label carrying a **preprinted custom barcode**. A scanner reads it. The controller parses the barcode into per-tank volumes, turns those into an ordered **mix_sequence** dispense plan, routes the container through the dispense bays it needs (one per tank, in belt order), dispenses with a small jitter, caps and presses it, checks it at the sort sensor (QC), rejects it at the reject diverter (GATE) or sends it to the sort diverter (SORT), which splits accepted containers into two lanes by bottle size. The default station list (`LABEL, SCAN, BAY-1..3, CAP, PRESS, QC, GATE, SORT`) follows the team's bill of materials (docs/prototype/bom.md); `LABEL`, `CAP`, `PRESS`, `SORT` and an optional `MIX` are configuration, not code. There's no scan diverter: a container with a bad barcode visits no service station and is rejected at GATE. Multiple containers do this **concurrently** — each has its own record and its own sequence of operations. Tanks auto-refill when low. Every wait is bounded by a timeout (paused while the line is halted); a jam rejects the container and frees the station.

Two faces, one model: `core.ts` + `run.ts` (the runnable Node twin), and the physical line's PLC (the team's Allen-Bradley Micro850), specified by the register map in `plc/tag-map.ts` with `plc/virtual-plc.ts` as its reference implementation and docs/prototype/micro850-plc.md as the program specification. The twin shares `config.ts`, `barcode.ts`, `recipe.ts`, `events.ts`, `safety.ts` and `metrics.ts`, and the PLC program implements the same rules. See docs/prototype/ for the hardware integration.

An earlier revision also carried a 3D model of the line as ProtoTwin components (`PaintLineController`, `TankModule`, `BarcodeMockSensor`). ProtoTwin is a subscription product, so the team dropped it: the Node twin, the virtual PLC and the HMI's 2D/3D views cover simulation and virtual commissioning without a licence.

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

## 3. Dynamic tanks (fixed slots, no hard-coded indices)

### The problem

A controller written around named per-tank references (`nozzleSensor1`, `tankLevel1`, …) is fixed at the number of tanks it was written for. Adding a 4th tank means editing every place that names a tank. That violates the requirement that adding a tank must not require rewriting the logic.

### The chosen approach — tank slots and data-driven loops

- `config.tanks` lists the enabled tanks; each one occupies a fixed **slot** from `TANK_SLOTS` (`T1..T8`), so a tank keeps its id, calibration, colour and PLC register block when others are enabled or disabled.
- Every piece of control logic loops over `config.tanks` (or over slots) and addresses tanks by **id**, never by a hard-coded index. Stations are data too: each tank has a `BAY-k` station in `config.stations`.
- Tanks can be bypassed at runtime through the tank-enable mask (bit k−1 = slot k), which is what the PLC's `Sys.TankEnableMask` holds.
- `MAX_TANKS = 8` bounds the slots and the register map, which reserves one tank block per slot. `addTank` refuses past it (`TANK_CHANGE_REFUSED`).

The PLC program follows the same pattern: arrays indexed by slot (`TankEnabled[k]`, `TankLevelMl_x10[k]` …) and a `FOR` loop or one rung block per slot (docs/prototype/micro850-plc.md §3).

### Why this approach

- **A generous static set** (`nozzleSensor1..8` as separate names) works, but forces every loop to skip unused names and still spreads the tank count through the code.
- **Looking tanks up by name at runtime** is fragile against renames and offers nothing over a slot index.
- Slots plus loops make "add a tank" a pure config edit (or a runtime command) and keep the register map stable.

## 4. Multi-container pipelining

### Decision

Each container carries its own state (id, barcode, parsed plan, fill, target, accept/reject flags, current op, deadline), and the engine advances every container on each tick, so multiple containers progress concurrently. The belt runs continuously at one global speed; each station has a presence sensor and a **stopper** that holds the arriving container, and a station is acquired (occupancy map) before a container is released toward it. Earlier revisions moved the belt to each container's next station, which cannot work with several containers on one belt — stoppers are how real indexing conveyors pipeline. On the PLC, the same thing is a container table indexed by slot plus one state machine per station (docs/prototype/micro850-plc.md §4).

### Why per-container state, not one sequence for the line

A single sequence processing containers one at a time would serialize the line — container 2 could not enter SCAN until container 1 reached GATE. Real lines pipeline: container 1 is dispensing at BAY-1 while container 2 is scanning and container 3 is in transit. Keeping the state on each container, and letting stations serve whichever container holds them, gives that concurrency without a special case per container.

### How pipelining is realized in the harness (`core.ts`)

The Node harness models the same pipelining with a tick loop and station occupancy:

- Each container has an ordered `ops` list (LABEL → SCAN → dispense steps → CAP → PRESS → QC → GATE → SORT, skipping stations that aren't configured; a bad barcode gets LABEL → SCAN → GATE only) and a state (`ENTERING`, `MOVING`, `SERVING`, `BLOCKED`, `ACCEPTED`, `REJECTED`, `JAMMED`).
- A station serves one container at a time (`occupancy: Map<stationId, containerId>`). A container that reaches an occupied station enters `BLOCKED` and races a timeout; if the timeout wins, it is force-rejected and the station is released.
- `maxConcurrentContainers` caps how many containers may be on the belt at once, modeling the physical belt length.
- Transit between stations takes `hops × stationSpacingM / beltSpeedMPerSec` (hops = how many station positions apart they are, so skipping stations costs belt time), so belt speed is the single global flow knob — raise it and the line speeds up (until a station becomes the bottleneck, which is exactly Little's Law).

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

### Belt order

On a one-way conveyor with **one bay per tank**, a container passes each bay exactly once, so it cannot return to BAY-1 after BAY-3. `beltOrderSteps(plan)` (in `recipe.ts`) collapses any plan into one step per tank, in belt order, with that tank's total volume; `core.ts` dispenses through it, and the PLC opens each bay's valve once for that tank's volume. Consequences:

- `sequential` and `interleaved` plans dispense identically on this layout (same per-tank totals, same order).
- The interleaved round-robin order becomes physical only with a **multi-nozzle manifold** at a single station (all tanks dispensing into a container that stays put). That layout is not modelled yet; `buildDispensePlan` keeps producing the full ordered plan for it.
- Earlier revisions of the twin routed interleaved steps back and forth between bays, which the HMI showed as containers moving backwards. A test (`containers only move forward along the belt`) now guards this.

### Precision handling

Interleaving splits a volume into `R` parts; `100 / 3` is not exact in milliliters. `buildDispensePlan` distributes the remainder into the first rounds (3-decimal ml precision), so the sum of a tank's sub-volumes always equals the barcode's per-tank volume. The gate validates the final fill against `T<totalMl>` within tolerance, so a 0.001 ml rounding never causes a false reject.

## 6. The four refinements

### (a) Refill-and-reject → auto-refill then ACCEPT

**Baseline behavior:** when a tank dropped below a threshold, the controller rejected the container.

**Fix:** in `core.ts`, when a dispense leaves a tank below `refillThresholdMl`, `dispense()` sets `tank.refilling = true` with a 1.5 s timer (event `TANK_LOW`) and continues; the refill then adds `refillAmountMl` (capped at capacity). The container carries on and its outcome stays ACCEPT (subject to the normal fill-tolerance check at the gate); it is never rejected solely because a tank ran low.

**Reasoning:** rejecting a good container because a tank needs topping up wastes a preprinted container and breaks the "dynamic, keeps running" requirement. Refill is a maintenance event, not a quality event.

**Physical prototype:** the BOM has no refill valve or level sensor, so on hardware the PLC estimates the level and the operator refills by hand (docs/prototype/micro850-plc.md §5). Containers still wait instead of being rejected; only the refill trigger differs from the simulation.

### (b) Barcodes arrive from the scanner, not from the controller

**Decision:** the controller never invents barcodes; it consumes them from a scanner source. In the Node twin that source is the mock feeder (`feeder.ts`), which queues a preprinted sample barcode every `mockSensorPeriodSec`. On the physical prototype the ESP32 scanner node reads the label, parses it and writes the PLC recipe mailbox; a sequence number (`Recipe.Seq`) makes two identical consecutive barcodes two containers (docs/prototype/esp32.md).

**Reasoning:** the scanner is a physical device with its own timing; keeping it a separate source keeps the controller free of scanner timing and lets the mock be swapped for the real scanner without touching the control logic. It also makes the "preprinted barcode enters the line" story explicit: the scanner emits, the controller consumes.

### (c) A timeout on every wait

**Decision:** in `core.ts`, the `BLOCKED` and `SERVING` states each carry a `deadlineSec` countdown set from `sensorWaitTimeoutSec`. If it runs out, the container is marked JAMMED (or rejected) and the station is released. `tick` does not advance the countdown while the line is halted. The PLC program does the same with an `RTO` timer per station, enabled only while running (docs/prototype/micro850-plc.md §3).

**Reasoning:** a stuck sensor or a jammed container would otherwise hang a wait forever, stalling the whole line; bounding every wait turns a stall into a reject, which is the correct physical response. The timeout must **pause while the line is halted**, so an operator stop doesn't jam every container.

### (d) `dispenseVariance` as a fraction

**Decision:** `config.dispenseVariance` is a fraction (0.02 = ±2 %). The twin jitters each target volume by up to that amount, and the fill-tolerance check at the gate allows `dispenseVariance + 1 %`.

**Reasoning:** variance is a tunable process parameter, not a constant in code. On the physical line the real variance comes from the valves; calibrate it during commissioning and keep the config in step so the simulation rejects at the same rate.

## 6a. Emergency stops, safety reset, and local/remote control

Implemented once in `safety.ts` (`LineSafety` state machine plus the pure `authorize()` rules), and used by `core.ts` (and so the virtual PLC) and the bridge's command pre-check. The hardware side is specified in docs/prototype/safety.md.

**State.** `digitalEStop` (latched), pressed physical buttons, `safetyCircuitOk` (models the safety relay), `runCommanded`, `controlMode` (`local` | `remote`). Derived: `eStopActive`, `resetRequired` = no E-Stop and the circuit open, `running` = circuit OK, run commanded, no E-Stop. The core moves nothing unless `running`.

**Decisions and reasons.**

- **Both E-Stops open the same circuit.** A physical E-Stop acts in hardware first; the software learns of it through monitoring inputs. The digital E-Stop drops a fail-safe PLC output wired into that circuit. Either way the result is identical: actuator power removed *and* the control system in E-Stop, with every operational command refused. This gives remote operators the same stopping power as someone at the machine, without making safety depend on software for the physical buttons.
- **Release ≠ reset ≠ start.** Three deliberate steps (ISO 13850 / IEC 60204-1 practice): releasing an E-Stop must never re-energize anything, and a reset must never start motion.
- **Reset is local by default** (`remoteResetAllowed = false`). The reset re-enables hazardous energy, so it's done where the hazard zone is visible. Remote reset is a configuration choice, gated on REMOTE mode.
- **The Local/Remote key decides authority for Start, Jog, pusher and tank changes; Stop and E-Stop work from anywhere.** Stopping should never need permission. Changing the key stops the line, so authority can't be seized from a running machine.
- **Refusals are events with reasons** (`COMMAND_REFUSED`, command + reason codes), so the HMI can say *why* instead of silently ignoring a click, and a PLC reports refusals the same way.
- **Simulation of physical controls is explicit.** `SafetyState.simulated` (virtual PLC: `LineState.SIMULATION`) gates the `sim*` commands and the HMI's simulated panel. A real PLC never exposes them.

**Tests.** `twin/src/test/core.test.ts` (digital E-Stop, physical E-Stop, local mode, remote reset config) and `plc.test.ts` (the same sequences through Modbus and the bridge).

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

### Structured events

Every event the core records carries a numeric `EventCode` and two arguments (`events.ts`) alongside its message. The same codes are what a PLC publishes in its event ring (docs/prototype/io-map.md), and `formatEvent(code, arg1, arg2)` renders operator text for PLC-sourced events. Codes are a wire contract: append only.

### OEE definitions

Implemented once in `metrics.ts` (`computeOee`, `RollingRate`, `idealCycleSec`) and used by `core.ts`; the PLC computes the same values (docs/prototype/micro850-plc.md §8).


- **availability** = `1 - downtimeSec / elapsedSec` — downtime is time with any container blocked behind an occupied station, plus time halted.
- **performance** = `(idealCycleSec * counts.total) / operatingSec` where `operatingSec = simTimeSec - lineBlockedSec` — actual throughput vs the ideal cycle time, capped at 1.
- **quality** = `counts.accepted / counts.total`.
- **overall** = `availability * performance * quality`.

### Transport

The twin emits the snapshot over two transports it can produce without the simulator:

1. **HTTP** — `GET http://127.0.0.1:43124/snapshot` returns the latest snapshot JSON with `Access-Control-Allow-Origin: *` so an HMI worker on any origin can poll it. `GET /` returns a tiny HTML dashboard that polls `/snapshot`. Port is configurable via `CAPTSONE_PORT`.
2. **File write** — `twin/runtime/snapshot.json` is overwritten every `config.snapshotPeriodSec` (0.5 s), for file-watch integrations.

3. **PLC bridge** — with `CAPTSONE_MODE=plc`, the same HTTP endpoints are fed from a physical (or virtual) PLC over Modbus TCP instead of the simulated core (`plc/bridge.ts`); see docs/prototype/.

We chose HTTP + file over WebSocket because the snapshot is small, fully recomputed each tick, and poll-based consumption is trivial for an HMI worker; a streaming socket would add complexity for no payload benefit. SCADA (FUXA) doesn't use this snapshot: it reads the PLC's register map directly over Modbus TCP (docs/prototype/scada.md).

### Operator HMI adapter (`hmi.ts`)

The operator HMI (`hmi/`) renders a visualization-oriented shape (`hmi/src/lib/twin/types.ts`), not the engine snapshot above. Rather than change the engine contract, `twin/src/hmi.ts` is a single translation layer, served by the same HTTP server:

| Endpoint | Purpose |
| --- | --- |
| `GET /hmi/state` | Live state in the HMI `TwinState` shape |
| `POST /hmi/command` | Operator command: `{ "command": "jogBelt" \| "firePusher" \| "addTank" \| "removeTank" \| "setTankColor" \| "resetTankColor" \| "eStop" \| "clearEStop", "tankId"?: string, "name"?: string, "colorCode"?: string }` → `{ ok, error? }` ([api.md](api.md#post-hmicommand)) |

Mapping decisions:

- **Container id** → `C-0001` (zero-padded string).
- **Status** is derived from the station of the container's current op: `LABEL` → `label`, `SCAN` → `scan`, `BAY-n` → `fill-n`, `MIX` → `mix`, `CAP` → `cap`, `PRESS` → `press`, `QC`/`GATE` → `qc`, `SORT` → `sort`; `ACCEPTED` → `output` (with `lane`, and per-lane counts in `sortLanes`); `REJECTED` with a barcode parse error → `scan-rejected`; other `REJECTED`/`JAMMED` → `rejected`. A container travelling between stations reports its destination; the HMI tweens toward it.
- **Finished containers** stay in the list for 1.5 s (sim) so the HMI can show them reaching the output/reject lane, then drop out (the engine keeps its own history).
- **Safety**: `safety` carries `SafetyState` (§6a). The HMI's global banner, the nav E-STOP button, the Controls screen and the Alarms screen are driven from it.
- **Events**: the core keeps a bounded log of `{ seq, simTimeSec, severity, message, code, arg1, arg2 }`; the latest becomes `lastEvent` (id `e<seq>`, wall-clock `at`) and the last 20 are sent newest-first as `recentEvents`, so the HMI's log has no gaps when several events happen between 500 ms polls.
- **OEE** is the engine's, except that while E-Stopped `availability` and `overall` report 0 — the line is not available *now*, and the HMI keys its "Line halted" state off `availability === 0`. `timestamp` is wall-clock ms.

Operator commands are implemented in `core.ts` (authorization in `safety.ts`, §6a):

- **eStop / releaseEStop / reset / start / stop** — see §6a. While not running nothing spawns or moves, tanks keep refilling, and the time counts as downtime in availability.
- **Simulation commands** `simControlMode`, `simLocalButton`, `simPhysicalEStop` operate the local panel and physical E-Stop buttons of the simulated line.
- **Jog** — REMOTE (or local panel in LOCAL), line stopped, safety circuit reset: advances in-transit containers by 0.5 s of belt travel.
- **Fire reject diverter** (`firePusher`) — fires the reject diverter on the container standing at QC/GATE (`manual reject (reject diverter)`).
- **Add tank** — enables the lowest free slot from `config.TANK_SLOTS` (slot k is always `Tk` with fixed calibration; its name and colour come from the operator palette), inserted in slot order, plus a matching `BAY-n` station after the last bay, up to `MAX_TANKS`. From then on barcodes must carry one more volume; the Node feeder synthesizes matching barcodes whenever the tank count differs from the config. An optional `name`/`colorCode` is saved to the slot before it is enabled.
- **Tank colours** — `setTankColor` / `resetTankColor` edit the `TankPalette` (`tank-colors.ts`): one name + colour per slot, defaults from `TANK_SLOTS`, edits persisted by `run.ts`. Presentation only, so no safety check. In PLC mode the bridge owns the palette; nothing goes to the PLC, and PLC event text uses the palette names.
- **Remove tank** — removes the tank and the last bay. Ops reference tanks by **id**, not index, so in-flight containers never dispense from the wrong tank; a container that still needed the removed tank is under-filled and rejected at the gate. After any tank change, barcodes still **queued upstream** with the old volume count are held back from the line (event `STALE_BARCODES_HELD`) instead of each failing `TANK_COUNT_MISMATCH` at the scanner and dragging quality down.

The HMI reaches these endpoints through its own `/api/twin/*` route handlers (a server-side proxy), so browsers never talk to the twin port directly.

## 8. Verification

- `npm test` (twin) runs the automated suite: line flow past the pipelining cap, every status visited, forward-only belt order, E-Stop latching, tank slots and stale-barcode handling, rolling throughput, structured events, the Modbus TCP client/server, virtual PLC ↔ bridge parity with the core, command handshakes, the recipe mailbox, and bridge offline handling.

- `npm run typecheck` (`tsc --noEmit`) passes clean.
- `npm run build` emits `dist/`.
- `npm start` runs the harness: containers enter, scan, dispense concurrently, refill, accept/reject, and the snapshot populates counts, throughput, and OEE. A 50 s run produced 3 accepted, 1 rejected (a deliberately mismatched sample barcode), throughput 2.35 cpm, OEE 0.741.
- **Fix — pipelining cap.** The spawn gate originally compared `containers.length` (which retains finished containers) against `maxConcurrentContainers`, so the line admitted exactly 4 containers and then stalled forever. It now counts only containers still on the belt. A 300 s simulated run completes 54 containers (40 accepted, 14 rejected — the one-in-four mismatched sample barcode).
- **Feeder backlog.** The mock feeder (every 3 s) is faster than the line; `run.ts` now holds back while `core.queuedBarcodes >= maxConcurrentContainers`, keeping the queue bounded.
- **Throughput** was a since-start average; it is now a rolling 60 s rate (the HMI contract always documented it as rolling).
- The Micro850 program is **specified, not yet built**. Commission it against the same checks per docs/prototype/commissioning.md.

## 9. File map

| File | Purpose |
| --- | --- |
| `twin/src/config.ts` | Data-driven line/tank/station config, `TANK_SLOTS`, sample barcodes; `MAX_TANKS` ceiling. |
| `twin/src/barcode.ts` | Custom preprinted barcode parser + validator. |
| `twin/src/recipe.ts` | `mix_sequence`: per-tank volumes → ordered dispense plan; `beltOrderSteps` for one-bay-per-tank lines. |
| `twin/src/events.ts` | Structured event/reject/station codes (wire contract) + operator text. |
| `twin/src/safety.ts` | E-Stop / reset / start-stop / local-remote state machine and authorization rules (§6a). |
| `twin/src/tank-colors.ts` | Operator-editable tank name/colour palette per slot: validation, defaults, JSON persistence. |
| `twin/src/metrics.ts` | OEE, rolling throughput, ideal cycle time. |
| `twin/src/feeder.ts` | Mock barcode feeder shared by the harness and the virtual PLC. |
| `twin/src/core.ts` | Framework-agnostic simulation engine + snapshot builder. |
| `twin/src/hmi.ts` | Adapter to the operator HMI's `TwinState` shape + command dispatch. |
| `twin/src/run.ts` | HTTP service: simulated line (`sim`) or PLC bridge (`plc`); `/snapshot`, `/hmi/state`, `/hmi/command`, `/health`, snapshot file, tank colours file. |
| `twin/src/plc/tag-map.ts` | PLC register map (Modbus TCP / OPC UA names) — the hardware contract. |
| `twin/src/plc/modbus.ts` | Dependency-free Modbus TCP client + server. |
| `twin/src/plc/virtual-plc.ts` | The core exposed on the register map — reference PLC for development and tests. |
| `twin/src/plc/bridge.ts` | Bridge (monitoring PC or Pi): PLC registers ↔ HMI state and commands; `coilBase` for PLCs whose coils don't start at 0 (0 for the Micro850). |
| `twin/src/plc/print-tag-map.ts` | Generates the register tables in docs/prototype/io-map.md. |
| `twin/src/test/*.test.ts` | Automated tests (`npm test`). |

