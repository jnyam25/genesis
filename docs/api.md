# HTTP API reference

Two HTTP servers are involved:

| Server | Default address | Audience |
| --- | --- | --- |
| **Twin service** (`twin/src/run.ts`) | `http://127.0.0.1:43124` | The HMI server, scripts, diagnostics. Keep it on localhost in production |
| **HMI proxy** (`hmi/src/app/api/twin/*`) | `http://<host>:43123/api/twin` | Browsers. Forwards to the twin service at `TWIN_HTTP_URL` |

The twin service answers the same way whether it's simulating the line (`CAPTSONE_MODE=sim`) or bridging a PLC (`CAPTSONE_MODE=plc`).

All responses are JSON with `Cache-Control: no-store`. The twin service sends permissive CORS headers (`Access-Control-Allow-Origin: *`) and answers `OPTIONS` preflights with 204.

---

## Twin service

### `GET /hmi/state`

Live line state in the HMI's `TwinState` shape (mirrors `hmi/src/lib/twin/types.ts`).

**200**

```json
{
  "tanks": [
    { "id": "T1", "name": "Titanium White", "colorCode": "#F4F1EA", "levelMl": 4520.3, "capacityMl": 5000 }
  ],
  "tankSlots": [
    { "id": "T1", "name": "Titanium White", "colorCode": "#F4F1EA", "custom": false, "enabled": true },
    { "id": "T4", "name": "Lemon", "colorCode": "#FFF44F", "custom": true, "enabled": false }
  ],
  "containers": [
    { "id": "C-0012", "status": "fill-2", "fillMl": 60, "targetMl": 250, "lane": 0 }
  ],
  "counts": { "accepted": 9, "rejected": 3, "total": 12 },
  "sortLanes": [
    { "id": "A", "name": "Lane A (small bottles)", "count": 6 },
    { "id": "B", "name": "Lane B (large bottles)", "count": 3 }
  ],
  "throughputCpm": 6.5,
  "oee": { "availability": 0.94, "performance": 1, "quality": 0.75, "overall": 0.705 },
  "lastEvent": { "id": "e87", "at": 1789650000123, "severity": "success", "message": "container 11 ACCEPTED (fill 251.2/250 ml)" },
  "recentEvents": [ { "id": "e87", "at": 1789650000123, "severity": "success", "message": "…" } ],
  "safety": {
    "eStopActive": false,
    "digitalEStop": false,
    "eStopButtons": [
      { "id": "PANEL", "name": "Local control panel", "pressed": false },
      { "id": "ENTRY", "name": "Line entry", "pressed": false },
      { "id": "EXIT", "name": "Line exit", "pressed": false }
    ],
    "safetyCircuitOk": true,
    "resetRequired": false,
    "running": true,
    "controlMode": "remote",
    "remoteResetAllowed": false,
    "simulated": true
  },
  "timestamp": 1789650000456,
  "connected": true
}
```

| Field | Notes |
| --- | --- |
| `tanks[]` | Enabled tanks in slot order (`T1..T8`). `levelMl` 0.1 ml resolution. `name`/`colorCode` are the operator's current choice for that slot |
| `tankSlots[]` | All eight slots, enabled or not, with their editable `name`/`colorCode`. `custom` = edited away from the default; `enabled` = on the line. Optional (the HMI hides the colour editor without it) |
| `containers[].id` | `C-` + zero-padded id |
| `containers[].status` | In belt order: `label`, `scan`, `fill-<bay>`, `mix` (only if a mixer is configured), `cap`, `press`, `qc` (sort sensor and reject diverter), `sort` (sort diverter), then `output` (accepted) or `rejected`. `scan-rejected` = bad barcode, rejected at the reject diverter. Finished containers stay listed for about 1.5 s |
| `containers[].lane` | Index into `sortLanes` the container is (or will be) sorted to. The simulated twin knows it from the recipe; from a PLC it appears once the container is sorted. Optional |
| `sortLanes[]` | Output lanes after the sort diverter (`config.sort.lanes`) with accepted counts. Optional |
| `throughputCpm` | Accepted containers per minute over a rolling 60 s window |
| `oee.*` | 0..1. `availability` (and `overall`) read **0 while the line isn't running** (stopped, E-Stop, reset pending) |
| `safety` | Emergency-stop and control-authority state ([prototype/safety.md](prototype/safety.md)). `eStopActive` = digital latched **or** any physical button pressed; `resetRequired` = no E-Stop active but the safety circuit not yet reset; `controlMode` = local panel key switch; `simulated` = the physical controls can be operated through the `sim*` commands |
| `lastEvent` / `recentEvents` | `recentEvents` is newest first (20 in sim mode, 8 from a PLC). `id` is unique per event: `e<seq>` (sim) or `p<epoch>-<seq>` (PLC); `at` is epoch ms |
| `timestamp` | Epoch ms when the state was produced |

**503** while there's no data (PLC offline): `{ "ok": false, "error": "PLC heartbeat stopped (PLC in program mode or faulted?)" }`

### `POST /hmi/command`

Body: `{ "command": <name>, ...args }`

**Operator commands** (source: remote). Safety and authority rules: [prototype/safety.md](prototype/safety.md#3-control-authority-local-vs-remote).

| `command` | Effect | Allowed | PLC coil |
| --- | --- | --- | --- |
| `eStop` | **Digital E-Stop.** Opens the safety circuit (hardware shutdown) and puts the control system in E-Stop. Latched | Always, any mode | `Cmd.DigitalEStop` |
| `releaseEStop` (alias `clearEStop`) | Release the digital E-Stop latch. Doesn't reset or start | While the digital E-Stop is active | `Cmd.ReleaseEStop` |
| `reset` | Safety reset from the HMI | Only if `safety.remoteResetAllowed`, REMOTE mode, no E-Stop active. **Refused by default: reset at the machine** | `Cmd.Reset` |
| `start` | Run the line | REMOTE mode, safety circuit reset, no E-Stop | `Cmd.Start` |
| `stop` | Controlled stop | Always, any mode | `Cmd.Stop` |
| `jogBelt` | Advance the belt one short step | REMOTE, stopped, safety reset, no E-Stop | `Cmd.Jog` |
| `firePusher` | Fire the reject diverter on the container at the sort sensor (QC) or reject diverter (GATE) | REMOTE, no E-Stop, safety reset | `Cmd.FirePusher` |
| `addTank` (+ optional `name`, `colorCode`) | Enable the lowest free tank slot. `name`/`colorCode` are saved to that slot first | REMOTE | `Sys.TankEnableMask` bit set |
| `removeTank` + `tankId` | Disable a tank (not the last) | REMOTE | `Sys.TankEnableMask` bit cleared |
| `setTankColor` + `tankId`, `name` and/or `colorCode` | Rename/recolour a tank slot, enabled or spare. Saved to `CAPTSONE_TANK_COLORS_FILE` | Always, any mode (display only) | none: kept on the Pi |
| `resetTankColor` (+ optional `tankId`) | Restore one slot's default name/colour, or every slot's without `tankId` | Always, any mode | none |

`name` is trimmed, 1–24 characters. `colorCode` is `#RRGGBB` and is stored upper-case. In PLC mode the colour commands work even while the PLC is offline.

**Simulation commands** operate the *physical* controls of a simulated line. Accepted only when `safety.simulated` is true: the simulated twin, or a PLC reporting `LineState.SIMULATION`.

| `command` | Args | Simulates |
| --- | --- | --- |
| `simControlMode` | `mode`: `"local"` \| `"remote"` | The LOCAL/REMOTE key switch |
| `simLocalButton` | `button`: `"start"` \| `"stop"` \| `"reset"` \| `"jog"` | A local panel push-button |
| `simPhysicalEStop` | `buttonId` (`"PANEL"`, `"ENTRY"` or `"EXIT"`), `pressed`: boolean | Pressing or releasing a physical E-Stop button |

| Status | Body |
| --- | --- |
| 200 | `{ "ok": true }`: accepted |
| 400 | `{ "ok": false, "error": "…" }`: unknown command, bad arguments, invalid JSON, or a **refusal with its reason**, e.g. `"start refused: local control is active — the HMI is view-only (switch the panel key to REMOTE)"` or `"reset refused: reset must be done at the local control panel"` |
| 405 | Not a POST |

In PLC mode, the bridge pre-checks commands against the PLC's `LineState` with the same rules. The PLC re-checks on the rising edge and records `COMMAND_REFUSED` if it disagrees. A 400 is also returned when the PLC is offline (`"PLC offline: …"`), a Modbus write fails, or a `sim*` command is sent to a real PLC.

### `GET /snapshot`

The engine snapshot contract ([engine-design.md §7](engine-design.md#7-hmi-data-contract)): numeric container ids, engine statuses (`ENTERING`, `MOVING`, `SERVING`, `BLOCKED`, `ACCEPTED`, `REJECTED`, `JAMMED`), `lastEvent` as a string, and `timestamp` in seconds of line time. It's also written to `twin/runtime/snapshot.json` every 0.5 s. 503 while there's no data.

In PLC mode, live containers report `SERVING`; the PLC register map doesn't distinguish moving from serving.

### `GET /health`

Always 200.

```json
{ "ok": true, "mode": "sim", "halted": false, "simTimeSec": 1234, "safety": { "eStopActive": false, "controlMode": "remote", "…": "same shape as /hmi/state safety" } }
```

```json
{
  "ok": true,
  "mode": "plc",
  "plc": {
    "online": true,
    "connected": true,
    "reason": null,
    "lastPollAt": 1789650000456,
    "lineState": {
      "running": true, "eStopActive": false, "digitalEStop": false, "physicalEStop": false,
      "resetRequired": false, "localMode": false, "simulation": false,
      "safetyOk": true, "fault": false, "hmiLinkOk": true
    }
  }
}
```

### `GET /`

A minimal HTML dashboard that polls `/snapshot`. Use it for diagnostics without the HMI.

---

## HMI proxy

| Route | Forwards to | Notes |
| --- | --- | --- |
| `GET /api/twin/state` | `GET {TWIN_HTTP_URL}/hmi/state` | Status and body passed through |
| `POST /api/twin/command` | `POST {TWIN_HTTP_URL}/hmi/command` | Body passed through |

If the twin service can't be reached within 2 s, it returns **502** `{ "ok": false, "error": "twin unreachable at http://127.0.0.1:43124 (fetch failed)" }`.

`TWIN_HTTP_URL` is read at request time (default `http://127.0.0.1:43124`), so it can change without rebuilding the HMI.

## Examples

```bash
curl -s http://127.0.0.1:43124/health
```

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"command":"eStop"}' http://127.0.0.1:43124/hmi/command
```

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"command":"simPhysicalEStop","buttonId":"EXIT","pressed":true}' http://127.0.0.1:43124/hmi/command
```

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"command":"removeTank","tankId":"T2"}' http://localhost:43123/api/twin/command
```

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"command":"setTankColor","tankId":"T2","name":"Crimson","colorCode":"#B00020"}' http://127.0.0.1:43124/hmi/command
```
