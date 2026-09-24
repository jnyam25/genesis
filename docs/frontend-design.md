# Captsone HMI — Frontend Design

Operator HMI for the **Captsone Industrial Paint Mixing System** digital twin.
This document explains every design decision: data-source abstraction, OEE
metric definitions, schematic layout, 3D scene structure, how dynamic tanks are
handled in each view, and state handling.

The app lives in `hmi/` (Next.js 16, TypeScript, Tailwind v4, shadcn/ui,
react-three-fiber). It runs standalone against a **mock twin feed** and is
built to swap to the real engine transport with no UI changes.

---

## 1. Data-source abstraction

The engine owns the transport (today: HTTP polling of the twin; later possibly
WebSocket/MQTT/OPC UA from a PLC bridge). The HMI must not couple to any of those, so the transport is hidden
behind a single interface in `src/lib/twin/source.ts`:

```ts
export interface TwinDataSource {
  start(onSnapshot: (state: TwinState) => void): () => void;
}
```

`useTwinState()` (`src/lib/twin/useTwinState.ts`) is the only hook any UI
component talks to. It subscribes to a `TwinDataSource`, holds the latest
snapshot, builds the rolling event log, and tracks `loading` / `stale` flags.
A source is created by `createTwinDataSource()`, which branches on
`NEXT_PUBLIC_TWIN_SOURCE`:
- `mock` (default) → `MockTwinDataSource`, which also exposes `commands`
  (E-Stop, reset, start/stop, jog, reject diverter, tanks, tank colours, simulated panel) so the Controls screen works
  standalone. Mock tank colour edits are kept in the browser's `localStorage`.
- `http` → `HttpTwinDataSource`, the **live twin**. Polls `/api/twin/state`
  every 500 ms (never overlapping) and POSTs operator `commands` to
  `/api/twin/command`. Those are Next.js route handlers
  (`src/app/api/twin/*`, `src/lib/twin/twin-proxy.ts`) that forward to the
  twin's `/hmi/state` and `/hmi/command` at `TWIN_HTTP_URL` (runtime env,
  default `http://127.0.0.1:43124`). Proxying through the HMI's own origin
  avoids CORS, works when the HMI is opened from another machine, and returns
  a 502 with a reason when the twin is down (the stale watchdog then shows
  "Feed stale"). The twin-side mapping is documented in
  `docs/engine-design.md` § "Operator HMI adapter". Running `npm run dev` at
  the repo root selects this source automatically.
- `ws` → `WebSocketTwinDataSource`, a skeleton PLC→HMI bridge that subscribes to
  a JSON snapshot stream (`NEXT_PUBLIC_TWIN_URL`) and auto-reconnects. This is
  the seam the engine worker will use to publish the real twin over
  WebSocket/MQTT/OPC UA wrapped to the same shape.

**Why this shape:**
- Consumers depend on `TwinState`, never on `fetch`/`WebSocket`/`fs`, so the
  transport is a single swap point.
- The hook owns cross-cutting UI concerns (event log, freshness watchdog) once,
  instead of every component re-deriving them.
- A stale watchdog flags the feed if no snapshot arrives within 3s, so the
  operator sees a "Feed stale" banner instead of silently frozen numbers.

### Snapshot contract

The HMI is built strictly against the twin's documented JSON shape:

```ts
{
  tanks: [{ id, name, colorCode, levelMl, capacityMl }],
  tankSlots?: [{ id, name, colorCode, enabled, custom }],
  containers: [{ id, status, fillMl, targetMl, lane? }],
  counts: { accepted, rejected, total },
  sortLanes?: [{ id, name, count }],
  throughputCpm,
  oee: { availability, performance, quality, overall },
  lastEvent, recentEvents?, safety?, timestamp
}
```

`tankSlots` lists all eight tank slots with their operator-editable name and
colour (see §9 "Tank colors"). Tank colours are data, not code: every view reads
`tanks[].colorCode`, so a recolour shows everywhere on the next poll.

`recentEvents` (optional, newest first) lets a source that can produce several
events between snapshots — the live twin or a PLC — deliver all of them; the
hook merges them into the log by event id and falls back to `lastEvent` for
sources that omit it (the mock). Two non-transport fields are added for UI
state only: `connected` (set by the source) and the client-side `events[]` log.
No visualization reads fields outside the contract.

### Shared subscription (`TwinProvider`)

`src/lib/twin/twin-context.tsx` creates **one** source at the layout level and
shares it across every route via React context (`useTwin()`). This means a
single mock engine / single WebSocket connection backs the whole app, and the
Controls screen's `commands` mutate that same engine so the dashboard,
schematic, and 3D views all update in sync.

### Mock feed (`src/lib/twin/mock-engine.ts`)

`MockTwinEngine` simulates the line: it spawns containers, walks them through
`label → scan → fill-1..N → cap → qc → sort → output` (lane A or B by
the engine's 250 ml rule) or `rejected`, with bad barcodes riding through as
`label → scan → qc → scan-rejected`. It drains tanks per recipe,
refills tanks when low, computes OEE, and emits events. It ticks every 500ms.
**To demonstrate the dynamic-tank requirement it starts with 3 tanks (slots
T1–T3) and enables a 4th (T4) after ~25s** — every view updates with no
code change because all rendering is driven from `tanks[]`. Tanks use the
twin's slot model and default names/colours (`lib/twin/tank-colors.ts` mirrors
`TANK_SLOTS`), so mock and live screens look the same.

---

## 2. OEE metric definitions

Overall Equipment Effectiveness is shown as four numbers. The definitions the
HMI assumes (and the mock computes) are the standard ones:

| Metric | Definition | Mock computation |
|---|---|---|
| **Availability** | Run time / planned time | `1` while running, `0` during a micro-stop; the mock schedules occasional 4s changeover stops so the value moves. |
| **Performance** | Actual throughput / ideal throughput | `0.85 + (throughputCpm / 12) * 0.15 ± noise`, clamped to `[0,1]`. Ideal rate = 12 containers/min. |
| **Quality** | Accepted / total produced | `counts.accepted / counts.total` (1 when nothing produced yet). |
| **OEE** | Availability × Performance × Quality | product of the three. |

These are displayed in `OeeGrid` (`src/components/dashboard/oee-grid.tsx`) as
four cards with a 0–100% bar. Color bands: ≥85% emerald, ≥60% amber, else rose —
applied to both the number and the bar so an operator can scan health at a
glance. OEE is the highlighted (primary-bordered) card because it is the
headline number operators watch first.

---

## 3. Shared line layout (`src/lib/twin/layout.ts`)

Both the 2D schematic and the 3D scene render the **same physical line**, so
they share one geometric model. `computeLayout(tanks)` returns station
positions in "line units" (~1m each) along the X axis:

```
                                                                              ┌─▶ [output-b] Lane B (branch up)
[label] [scan] [fill bay 1] ... [fill bay N] [cap] [qc] [gate] [sort] ────────┴─▶ [output-a] Lane A
                                                          │
                                                       [reject]  (branch down)
```

- **Labeling** at X=0.6 and **Barcode Scan** at 1.6; **fill bays** (internal
  kind `nozzle`) start at 2.7 and space 1.1 apart, one per tank; **Capping
  Arm** (the robotic arm that places and presses the lid), **Sort Sensor**
  (`qc`), **Reject Diverter** (`gate`) and **Sort Diverter** follow at fixed
  offsets. There is no lid press station.
- Tanks sit above their fill bay (Y=+1.6); the reject lane branches down from
  the reject diverter (Y=−1.7); Lane B branches up after the sort diverter
  (Y=+1.3) while Lane A runs straight on.
- `stationForStatus(container, layout)` maps a container's `status` (and
  `lane`) to a station: `fill-i` maps to fill bay i, `output` goes to Lane B
  when `lane === 1` and Lane A otherwise, and both `rejected` and
  `scan-rejected` go to the reject lane. `mix` (only on lines configured with
  a mixer) is shown at the last fill bay. This is the single place that
  translates the snapshot into geometry, so both views stay consistent and
  both scale with the tank count automatically.

### Container positions are a visualization concern

The snapshot carries no coordinates — only `status`. So positions are derived,
not transported. `useContainerPositions()` (`src/lib/twin/useContainerPositions.ts`)
keeps a per-container animated position and, on each status change, tweens it
toward the new station's coordinates with `requestAnimationFrame`. This yields
smooth conveyor motion from pure status transitions, and both views consume
the **same** animated positions, so a container is never in two places at once.

---

## 4. 2D schematic (`src/components/schematic/line-schematic.tsx`)

An inline `<svg>` (no images) drawn to a `viewBox` computed from the layout, so
it scales responsively and scrolls horizontally on narrow screens.

**Every component is identified with a label/callout:**
- **Labeling**, **Barcode Scan**, each **Fill Bay** (labeled with its tank),
  **Capping Arm**, **Sort Sensor**, **Reject Diverter**, **Sort
  Diverter**, **Reject Lane**, **Lane A** and **Lane B** (each output lane with
  its name and accepted count when the engine sends `sortLanes`), and every
  **Tank** (labeled "TANK n · Name" with fill %).
- An amber **DIVERTER** callout sits between the reject diverter and the reject
  lane; the sort diverter shows "→ Lane A/B" for the bottle at it.

**Live state shown on the schematic:**
- Stations light **green** when a container is at them; QC turns **red** while a
  reject is in flight.
- Tank bodies fill with their `colorCode` proportional to `levelMl/capacityMl`;
  the tank outline turns amber (<30%) or red (<15%) for low/critical.
- Containers are circles colored by status (tank color while filling, blended
  mixed color once filled, slate while empty, dark red when rejected, orange
  with a "BAD BARCODE" tag for a bad barcode) with a progress ring showing
  `fillMl/targetMl`.
- A flow arrow and belt stripes convey direction.

The viewBox reserves `TOP_PAD` (tank half-height + label space) above the
tank row, so the tank tops and their "TANK n" / name labels are never clipped.

**State handling:** when `tanks[]` is empty the schematic still renders the
fixed stations (label, scan, cap, sort sensor, diverters, lanes) with no fill bays; when containers are
absent the belt and stations simply show idle. No empty view is needed here
because the belt itself is the empty state — the dashboard tab covers the
explicit empty/loading/error states.

---

## 5. 3D visualization (`src/components/scene/line-scene.tsx`)

A react-three-fiber `<Canvas>` with drei `OrbitControls` (drag to orbit, scroll
to zoom, right-drag to pan; polar angle clamped so you stay above the floor).

**Scene structure** (world units = line units; Y up):
- A **conveyor belt** box spanning `spanX`, with dark stripe meshes for motion.
- A **reject lane** box branching off the reject diverter, and **Lane B**
  branching off the sort diverter on the near side of the belt.
- **Station pads** — one mesh per station, emissive in the station color when
  active.
- **Tanks** as cylinders above each fill bay, with an inner liquid cylinder
  scaled to `levelMl/capacityMl` in the tank color, a feed pipe to the bay,
  and a torus ring that glows amber/red when low/critical.
- **Station props** — small animated parts for the label applicator, the
  robotic capping arm (its boom swings from the lid stack beside the belt to
  over the container and lowers to seat the lid), the reject diverter (extends toward the reject lane while a
  bottle is rejected) and sort diverter (swings toward Lane B when a large
  bottle arrives), all tweened in `useFrame`.
- **Containers** as translucent cups with a liquid cylinder whose height tracks
  `fillMl/targetMl`, colored the same way as the schematic for consistency.

**Identification:** every station, tank, and container carries a drei `<Html>`
annotation (a small bordered pill) with its label and key detail (tank name +
fill %, container id, nozzle id). Annotations use `distanceFactor` so they scale
with distance and read clearly without cluttering the scene.

**Why dynamic import:** the canvas is loaded with `next/dynamic` `{ ssr: false }`
so three.js never runs on the server; the tab shows a "Loading 3D scene…"
skeleton until the client bundle is ready.

---

## 6. Dynamic tanks — how each view adapts

The requirement: adding a tank in the twin config must appear in the dashboard,
schematic, and 3D with **no frontend code change**. This works because nothing
hardcodes tank count:

| View | How it adapts to `tanks[]` |
|---|---|
| **Dashboard — Tank Levels** | `tanks.map(...)` renders one row per tank; the header badge shows the live count. |
| **Dashboard — OEE/counts/throughput** | Driven by `oee`/`counts`/`throughputCpm`, which the engine recomputes when the line changes. |
| **2D schematic** | `computeLayout(tanks)` inserts one fill bay per tank and shifts the capping arm and everything after it right; tanks render above their bay; `fill-i` statuses map to the new bays via `stationForStatus`. |
| **3D scene** | Same `computeLayout` + `useContainerPositions`; one `Tank3D` and one fill-bay pad per tank; conveyor length grows with `spanX`. |

The mock demonstrates this by starting at 3 tanks and adding a 4th (T4)
after ~25s — watch the schematic lengthen, a new fill bay + tank appear,
and containers start visiting `fill-4`. No view is reloaded or re-coded. The
Controls screen can also add/remove tanks on demand (see §8).

---

## 7. Bad barcodes (no scan diverter)

The bill of materials has no scan diverter, so a container that **fails the
scan** (bad/no barcode) can't leave the belt early. It gets no recipe, is not
filled or capped, and rides through to the reject diverter:

- **Status `scan-rejected`** in `ContainerStatus` is its final status. On the
  way it reports `label`, `scan` and then `qc` (target 0, no lane), so the
  views move it along the belt past the fill bays without filling it.
- `stationForStatus` maps `scan-rejected` to the normal **reject lane**; there
  is no separate scan-reject lane any more.
- Both views draw bad-barcode containers **orange** with a "BAD BARCODE" tag,
  to tell them apart from fill/type rejects (dark red). The legend matches.

---

## 8. State handling (empty / loading / error)

- **Loading:** before the first snapshot, `useTwinState` returns
  `loading=true`; the page shows a spinner ("Connecting to the paint mixing
  twin…") instead of empty cards, so the operator never sees unpopulated zeros.
- **Stale feed:** a 1s watchdog compares `Date.now()` to the last snapshot
  timestamp; if the gap exceeds 3s it sets `stale=true` and a destructive
  `Alert` ("Feed stale") appears at the top while the last-known values remain
  visible (a frozen display is more useful than a blank one during a blip).
- **Empty tanks list:** `TankLevels` renders an explicit "No tanks reported by
  the twin." card rather than a blank panel.
- **Empty event log:** shows "Waiting for events from the twin…".
- **Disconnected:** the header badge flips from "Live" (pulsing green dot) to
  "Feed stale"/"Connecting" (red dot) so connection state is always visible.
- **3D fallback:** the dynamically-imported canvas shows a skeleton while
  loading; if WebGL is unavailable the canvas simply stays empty without
  crashing the rest of the dashboard.

---

## 9. Layout, navigation & responsiveness

- A top `NavBar` (title, route links, live/stale badge, twin clock) is shared
  across all routes via the `TwinProvider` in the root layout.
- **Routes:** `/` (Dashboard with tabs: Dashboard / Schematic / 3D View),
  `/manual` (Controls), `/alarms` (Alarms). All consume the same shared
  twin subscription.
- The body uses a max-width 1400px container. The dashboard stacks OEE → counts
  → (schematic + event log on `lg`, stacked on mobile) → tank levels.
- **Controls screen** (`/manual`): operator controls that command the live
  twin source through `TwinCommands`: digital E-Stop and release, reset, start/stop,
  jog, fire reject diverter (command `firePusher`), and add/remove tank modules. Against the mock these mutate
  the engine directly; with the `http` source they go to the twin, which applies
  them to the simulated core or pulses the PLC command coils (docs/api.md). Every
  command resolves to `null` or its refusal message.
- **Safety UI** (`components/safety/safety-banner.tsx`, nav bar, `/manual` "Controls", `lib/twin/safety.ts`), driven by `state.safety`:
  - a **global banner under the nav bar on every screen**: red "EMERGENCY STOP — LINE SHUT DOWN" naming each pressed physical button and/or "Digital E-Stop active", with recovery steps; amber "Safety reset required"; orange "Station fault — the PLC stopped the line" while `safety.faultActive` is set, quoting the cause from the latest `FAULT` event in `recentEvents` and telling the operator to fix it, press RESET, then START; blue "LOCAL CONTROL — HMI is view-only"; grey "Line stopped";
  - a red **E-STOP** button in the nav bar on every screen (the digital E-Stop; no confirmation dialog, since an emergency stop must be one action) and a LOCAL/REMOTE badge;
  - **Controls** screen: large DIGITAL E-STOP, release, reset, safety circuit and per-button status, Start/Stop, Jog / Fire reject diverter, and tank modules. Each control is enabled from `refusal(state.safety, command)`, a client mirror of `twin/src/safety.ts`, and shows the reason when disabled. Commands return their refusal message, which appears in a feedback alert;
  - a dashed **"Local control panel & field E-Stops — SIMULATION"** card that appears only when `safety.simulated`, so the physical-control behaviour can be exercised from the browser.
  The mock engine implements the same rules (`MockSafety`), so the HMI behaves identically standalone.
- **Tank colors** (`components/controls/tank-colors.tsx`, on `/manual`, shown when the source sends `tankSlots`):
  - a **Tank colors** card listing all eight slots (ON LINE / SPARE, EDITED). **Edit** opens an inline editor with a native colour picker, a hex field, the tank name (max 24 characters) and preset swatches sized for touch; **Save** sends `setTankColor`, **Default** and **Reset all** send `resetTankColor`;
  - **Add tank** opens `AddTankForm` for the next free slot, prefilled with its saved name/colour, and sends `addTank({ name, colorCode })`;
  - input is checked client-side (`lib/twin/tank-colors.ts`) before sending; the twin re-validates. Colour edits aren't safety commands, so they are never disabled by LOCAL mode or an E-Stop. The twin saves them (`CAPTSONE_TANK_COLORS_FILE`); the mock saves them in `localStorage`.
- **Alarms screen** (`/alarms`): active alarms derived from the snapshot (feed
  stale, line halted/E-Stop, tanks low/critical) plus the rolling warn/error
  history from the event log.
- The SVG schematic scrolls horizontally on small screens (`min-w-[760px]` in an
  `overflow-x-auto` wrapper); the 3D canvas is a fixed 520px tall panel that
  fills width. Cards collapse from 4→2→1 columns from `lg` down to mobile.

---

## 10. File map

```
hmi/src/
  app/
    layout.tsx          # dark theme, metadata, TwinProvider + NavBar
    page.tsx            # Dashboard tabs: Dashboard / Schematic / 3D, loading & stale states
    manual/page.tsx     # Controls screen: E-Stop, run control, motion, tanks, tank colors, simulated panel
    alarms/page.tsx     # Alarms screen (active + history)
  lib/
    format.ts           # pct / clock / OEE color helpers
    twin/
      types.ts          # TwinState contract + TwinCommands
      layout.ts         # shared line layout + status/lane→station mapping (reject lane, Lane A/B)
      mock-engine.ts    # mock twin (3→4 tanks, BOM station order, sort lanes, bad barcodes, OEE, events, commands, tank colours)
      tank-colors.ts    # default slot names/colours, presets, colour validation
      safety.ts         # client mirror of the twin's safety rules + MockSafety
      source.ts         # TwinDataSource + Mock (localStorage colours) / Http / WebSocket sources
      useTwinState.ts   # the one data hook (events, loading, stale)
      twin-context.tsx  # TwinProvider / useTwin — one shared subscription across routes
      useContainerPositions.ts  # animated positions from status
  components/
    dashboard/          # nav-bar, oee-grid, counts-card, tank-levels, event-log
    controls/tank-colors.tsx      # Tank colors card + Add tank form
    safety/safety-banner.tsx      # global E-Stop / reset / LOCAL banner
    schematic/line-schematic.tsx  # 2D inline SVG (reject lane, Lane A/B)
    scene/line-scene.tsx          # 3D react-three-fiber scene (station props, reject lane, Lane A/B)
    ui/                 # shadcn primitives
```

## 11. Running

```bash
cd hmi
npm install
npm run dev   # http://localhost:43123 (mock feed)
```

Or from the repo root, twin + HMI wired together (see `INSTALL.md`):

```bash
npm run dev
```

Port **43123** (deliberately uncommon — not 3000/5173/8080). The data source is
chosen with `NEXT_PUBLIC_TWIN_SOURCE` (`mock` | `http` | `ws`, see §1 and
`hmi/.env.example`); no UI changes required.
