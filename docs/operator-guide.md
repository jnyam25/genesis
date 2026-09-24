# Operator guide

The HMI runs in a browser at `http://<line computer>:43123`. It shows the line live and lets you operate it remotely. The machine also has a **local control panel** that works without the HMI.

## Emergency stop

There are two kinds of emergency stop, and **both shut the machine down**:

| | Where | What happens |
| --- | --- | --- |
| **Physical E-Stop** | Red mushroom buttons on the machine: the local control panel, the **line entry** (labeling, where bottles are loaded) and the **line exit** (sort diverter and output lanes) | Power to all motion is cut in hardware immediately, including the capping arm, lid press and label applicator. The control system goes into E-Stop and the HMI shows **which button** was pressed |
| **Digital E-Stop** | Red **E-STOP** button at the top of every HMI screen, and on the Controls screen | The PLC opens the same safety circuit, so the machine loses power to all motion. Works in any mode |

> If someone is in danger, use the **nearest** E-Stop. On the machine that's a physical button; away from the machine, the HMI E-STOP. Don't press anything else first.

While an E-Stop is active:
- a **red banner** appears on every HMI screen, listing each pressed button and/or "Digital E-Stop active";
- the nav button reads **E-STOP ACTIVE**;
- Start, Jog, Fire reject diverter and tank changes are disabled;
- the Alarms screen lists each active E-Stop.

### Getting going again

1. Find out why the stop happened and make the area safe.
2. **Release** every pressed physical E-Stop (twist or pull the button on the machine).
3. If the Digital E-Stop was used: **Controls → Release digital E-Stop**.
4. The banner turns amber: **"Safety reset required"**. Nothing moves yet.
5. Press **RESET** on the **local control panel** at the machine. Reset is done at the machine so the person resetting can see nobody is at risk. The HMI's Reset button is disabled unless your site has enabled remote reset.
6. The banner shows **"Line stopped"**. Press **START**: on the panel in LOCAL mode, or on the HMI Controls screen in REMOTE mode.

Releasing a button or resetting **never** restarts the line on its own.

## Local control panel (on the machine)

The panel combines a small **touch screen** wired to the PLC with a few **hardwired** buttons. The hardwired ones work even if the touch screen is off.

| Control | Where | Function |
| --- | --- | --- |
| **E-Stop** (red mushroom) | Hardwired | Physical emergency stop. There are two more at the line entry and the line exit |
| **LOCAL / REMOTE** key | Hardwired | Who's in control. Turning it **stops the line** |
| **STOP** (red) | Hardwired | Controlled stop. Works in **any** mode |
| **RESET** (blue, lights up) | Hardwired | Safety reset after an E-Stop; flashes when a reset is needed. Works in any mode |
| **START** | Touch screen | Start the line. LOCAL mode only |
| **JOG** | Touch screen | Moves the belt while held. LOCAL mode, line stopped, after reset |
| Status, tank refilled | Touch screen | Running / E-Stop / REMOTE indication; press "Tank *k* refilled" after refilling a tank by hand |

## LOCAL vs REMOTE

| | REMOTE (key on REMOTE) | LOCAL (key on LOCAL) |
| --- | --- | --- |
| Who runs the line | The HMI | The local panel |
| HMI | Full control | **View-only**, except **E-STOP** and **Stop**, which always work |
| Panel START/JOG | Disabled | Active |
| Panel STOP, RESET, E-Stops | Active | Active |

The HMI shows the key position in the top bar (**LOCAL**/**REMOTE**). In LOCAL mode a blue banner reads "LOCAL CONTROL — HMI is view-only". If you try something that isn't allowed, the HMI tells you why, e.g. "start refused: local control is active — switch the panel key to REMOTE".

For maintenance, switch to **LOCAL and remove the key** so nobody can start the line from the HMI.

## Header

| Element | Meaning |
| --- | --- |
| **LOCAL / REMOTE** | Key switch position |
| **E-STOP** / **E-STOP ACTIVE** | Digital E-Stop button (pulsing red while any E-Stop is active) |
| **Live** (green, pulsing) | Data is arriving |
| **Connecting** / **Feed stale** (red) | No data for 3 s: the line computer, PLC link, or network is down. Numbers on screen are **last known values**. The machine's physical controls still work |
| Clock | Time of the latest data |
| Dashboard / Controls / Alarms | Screens |

## Dashboard

- **OEE cards.** Availability, Performance, Quality, and OEE = A × P × Q.
  - Colours: green ≥ 85%, amber ≥ 60%, red below.
  - Availability shows **0% while the line isn't running**.
- **Counts.** Accepted, Rejected (includes bad barcodes and jams), Total, **Throughput** (accepted containers per minute over the last minute), and the accepted count for **Lane A** (small bottles) and **Lane B** (large bottles).
- **Tabs:**
  - **Dashboard.** Line schematic, event log, tank levels.
  - **Schematic.** Full-width line diagram. Stations light up while a container is at them. Container colour: grey = empty; tank colour = filling; mixed colour once filled; dark red = rejected; orange = bad barcode. The sort diverter shows which lane the current bottle goes to.
  - **3D View.** The same line in 3D. Drag to orbit, scroll to zoom.
- **Tank levels.** Amber below 30%, red below 15%. On the simulated line tanks refill automatically; on the prototype you refill by hand when the low alarm shows, then press "Tank refilled" on the touch screen. Containers wait for the refill rather than being rejected.
- **Event log.** Newest first. Colours: blue info, green success, amber warning, red error.

### Container path

```
Labeling ─▶ Scan ─▶ Bay 1 ─▶ Bay 2 ─▶ Bay 3 ─▶ Capping arm ─▶ Lid press ─▶ Sort sensor ─▶ Reject diverter ─▶ Sort diverter ─▶ Lane A (small)
                                                                                           │                 └──▶ Lane B (large)
                                                                                           └──▶ Reject lane
```

The reject diverter rejects bottles that are out of fill tolerance, the wrong bottle type, manually rejected, or had an unreadable/invalid barcode. There's no separate scan-reject lane: a bottle with a bad barcode isn't filled, capped or pressed, and rides through to the reject diverter.

## Controls screen

| Section | Controls |
| --- | --- |
| **Emergency stop** | Large **DIGITAL E-STOP**; **Release digital E-Stop**; **Reset** (only where remote reset is enabled); status of the safety circuit, the digital E-Stop, and every physical E-Stop button |
| **Run control** | **Start** (REMOTE mode, after reset) and **Stop** (always) |
| **Motion** | **Jog belt** (REMOTE, line stopped, after reset); **Fire reject diverter** (rejects the bottle at the sort sensor or reject diverter) |
| **Tank modules** | **Add tank** / **Remove** (REMOTE mode). **Add tank** opens a small form for the new tank's name and colour, prefilled with that slot's saved choice. Stop the line and let it empty first. Containers already on the line that need a removed tank are rejected, and barcodes already read for the old number of tanks are held back |
| **Tank colors** | All eight tank slots, on the line or spare. **Edit** a slot to change its name and colour: use the colour picker, type a hex code (`#C8362B`), or tap a preset swatch; then **Save**. **Default** undoes one slot; **Reset all** undoes every slot. Changes show on every screen immediately and are kept after a restart. They only change what the screens show, so they're allowed in any mode, even during an E-Stop. After you refill a tank with a different paint, rename and recolour it here |

After each command, a message confirms it was sent or explains why it was refused.

On a **simulated** line (training, testing), an extra dashed card, **"Local control panel & field E-Stops — SIMULATION"**, lets you operate the key switch, panel buttons and physical E-Stop buttons from the browser. It never appears when the HMI is connected to the real machine.

## Alarms

**Active alarms:**

| Alarm | Meaning | Action |
| --- | --- | --- |
| PHYSICAL E-STOP pressed at *location* | That button is pressed; line shut down | Make safe, release the button, reset at the panel, start |
| DIGITAL E-STOP active | E-Stop from the HMI; line shut down | Make safe, Release digital E-Stop, reset at the panel, start |
| Safety reset required | E-Stops released, not yet reset | RESET at the local control panel |
| LOCAL control | Key switch on LOCAL | Information: HMI is view-only |
| Twin feed stale | No data for 3 s | Check the line computer / network ([prototype/troubleshooting.md](prototype/troubleshooting.md)). The machine's own controls still work |
| Tank *X* low / CRITICAL | Below 30% / 15% | Refill the tank by hand and press "Tank refilled" on the touch screen (the simulated line refills by itself) |

**Alarm history** lists recent warning and error events.

**Common events:**

| Event | Meaning |
| --- | --- |
| `PHYSICAL E-STOP pressed at Line exit …` / `… released — safety reset required` | Physical E-Stop activity |
| `DIGITAL E-STOP activated from the HMI …` / `Digital E-Stop released …` | Digital E-Stop activity |
| `Safety circuit reset (local) — press START to run` | Reset done at the panel |
| `Line started (remote)` / `Line stopped (local)` / `Line stopped by emergency stop` | Run state changes and who caused them |
| `Control mode: LOCAL — HMI is view-only` | Key switch turned |
| `start refused: …` | A command wasn't allowed, and why |
| `C-0012 barcode rejected: TANK_COUNT_MISMATCH` | The barcode lists a different number of tanks than the line has |
| `C-0012 REJECTED — fill out of tolerance` | Dispensed volume outside tolerance: check the valve calibration, a low tank (gravity feed slows), drips |
| `C-0012 ACCEPTED (fill 251.2 ml)` | Accepted and sorted to its lane (the simulated line adds "→ Lane A/B" to the message; the lane counts on the dashboard work in both) |
| `C-0012 JAMMED at BAY-2` | A container didn't arrive at or leave a station in time |
