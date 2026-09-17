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

The engine worker owns the transport (TBD: file watch, HTTP polling, or
WebSocket). The HMI must not couple to any of those, so the transport is hidden
behind a single interface in `src/lib/twin/source.ts`:

```ts
export interface TwinDataSource {
  start(onSnapshot: (state: TwinState) => void): () => void;
}
```

`useTwinState()` (`src/lib/twin/useTwinState.ts`) is the only hook any UI
component talks to. It subscribes to a `TwinDataSource`, holds the latest
snapshot, builds the rolling event log, and tracks `loading` / `stale` flags.
A source is created by `createTwinDataSource()`, which today returns
`MockTwinDataSource` but branches on `NEXT_PUBLIC_TWIN_SOURCE` so a future
`ws` / `poll` / `file` source can be added in one place.

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
  containers: [{ id, status, fillMl, targetMl }],
  counts: { accepted, rejected, total },
  throughputCpm,
  oee: { availability, performance, quality, overall },
  lastEvent, timestamp
}
```

Two non-transport fields are added by the hook for UI state only:
`connected` (set by the source) and the client-side `events[]` log (derived from
`lastEvent` changes). No visualization reads fields outside the contract.

### Mock feed (`src/lib/twin/mock-engine.ts`)

`MockTwinEngine` simulates the line: it spawns containers, walks them through
`scan → fill-1..N → mix → qc → output|rejected`, drains tanks per recipe,
refills tanks when low, computes OEE, and emits events. It ticks every 500ms.
**To demonstrate the dynamic-tank requirement it starts with 3 tanks (Red,
Green, Blue) and adds a 4th (Yellow) after ~25s** — every view updates with no
code change because all rendering is driven from `tanks[]`.

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
[scan] [nozzle-1] [nozzle-2] ... [nozzle-N] [mix] [qc] [output]
                                          │
                                       [reject]  (branch down)
```

- **Scan** at X=0.6; **nozzles** start at 1.7 and space 1.1 apart, one per tank;
  **mix**, **qc**, **output** follow at fixed offsets; **reject lane** branches
  off QC downward.
- Tanks sit above their nozzle (Y=+1.6); reject lane is below (Y=−1.7).
- `stationForStatus(status, layout)` maps a container's `status` to a station —
  `fill-i` maps to nozzle i. This is the single place that translates the
  snapshot into geometry, so both views stay consistent and both scale with the
  tank count automatically.

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
- **Scan Zone** (⌖), each **Nozzle** station (▼, labeled with its tank id),
- **Mix Station** (⟳), **QC Station** (✓), **Reject Lane** (✕), **Output
  Lane** (▶), and every **Tank** (labeled "TANK n · Name" with fill %).
- A **PUSHER** callout sits between QC and the reject lane.

**Live state shown on the schematic:**
- Stations light **green** when a container is at them; QC turns **red** while a
  reject is in flight.
- Tank bodies fill with their `colorCode` proportional to `levelMl/capacityMl`;
  the tank outline turns amber (<30%) or red (<15%) for low/critical.
- Containers are circles colored by status (tank color while filling, blended
  mixed color after mix, slate while empty, dark red when rejected) with a
  progress ring showing `fillMl/targetMl`.
- A flow arrow and belt stripes convey direction.

**State handling:** when `tanks[]` is empty the schematic still renders the
fixed stations (scan/mix/qc/output/reject) with no nozzles; when containers are
absent the belt and stations simply show idle. No empty view is needed here
because the belt itself is the empty state — the dashboard tab covers the
explicit empty/loading/error states.

---

## 5. 3D visualization (`src/components/scene/line-scene.tsx`)

A react-three-fiber `<Canvas>` with drei `OrbitControls` (drag to orbit, scroll
to zoom, right-drag to pan; polar angle clamped so you stay above the floor).

**Scene structure** (world units = line units; Y up):
- A **conveyor belt** box spanning `spanX`, with dark stripe meshes for motion.
- A **reject lane** box branching off QC downward.
- **Station pads** — one mesh per station, emissive in the station color when
  active (scan=sky, nozzle=slate, mix=violet, qc=emerald/rose, output=emerald,
  reject=rose).
- **Tanks** as cylinders above each nozzle, with an inner liquid cylinder
  scaled to `levelMl/capacityMl` in the tank color, a feed pipe to the nozzle,
  and a torus ring that glows amber/red when low/critical.
- **Mixer** — a hexagonal impeller at the mix station that spins (via
  `useFrame`) only while a container is mixing.
- **Pusher** — an amber block at QC that extends toward the reject lane (tweened
  in `useFrame`) only while a container is being rejected.
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
| **2D schematic** | `computeLayout(tanks)` inserts one nozzle per tank and shifts mix/qc/output right; tanks render above their nozzle; `fill-i` statuses map to the new nozzles via `stationForStatus`. |
| **3D scene** | Same `computeLayout` + `useContainerPositions`; one `Tank3D` and one nozzle pad per tank; conveyor length grows with `spanX`. |

The mock demonstrates this by starting at 3 tanks and adding a 4th (Yellow)
after ~25s — watch the schematic lengthen, a new nozzle + Yellow tank appear,
and containers start visiting `fill-4`. No view is reloaded or re-coded.

---

## 7. State handling (empty / loading / error)

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

## 8. Layout & responsiveness

- A top `Header` (title, live/stale badge, twin clock) is sticky-bordered.
- The body uses a max-width 1400px container. The dashboard stacks OEE → counts
  → (schematic + event log on `lg`, stacked on mobile) → tank levels.
- Tabs switch between **Dashboard**, **Schematic**, and **3D View**; the
  dashboard also embeds a schematic so the operator sees the line without
  switching tabs.
- The SVG schematic scrolls horizontally on small screens (`min-w-[760px]` in an
  `overflow-x-auto` wrapper); the 3D canvas is a fixed 520px tall panel that
  fills width. Cards collapse from 4→2→1 columns from `lg` down to mobile.

---

## 9. File map

```
hmi/src/
  app/
    layout.tsx          # dark theme, metadata
    page.tsx            # tabs: Dashboard / Schematic / 3D, loading & stale states
  lib/
    format.ts           # pct / clock / OEE color helpers
    twin/
      types.ts          # TwinState contract
      layout.ts         # shared line layout + status→station mapping
      mock-engine.ts    # mock twin (3→4 tanks, OEE, events)
      source.ts         # TwinDataSource interface + MockTwinDataSource
      useTwinState.ts   # the one data hook (events, loading, stale)
      useContainerPositions.ts  # animated positions from status
  components/
    dashboard/          # header, oee-grid, counts-card, tank-levels, event-log
    schematic/line-schematic.tsx  # 2D inline SVG
    scene/line-scene.tsx          # 3D react-three-fiber scene
    ui/                 # shadcn primitives
```

## 10. Running

```bash
cd hmi
npm install
npm run dev   # http://localhost:43123
```

Port **43123** (deliberately uncommon — not 3000/5173/8080). To point at a real
twin later, implement `TwinDataSource` and set `NEXT_PUBLIC_TWIN_SOURCE` to
select it; no UI changes required.
