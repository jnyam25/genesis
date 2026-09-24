# Operator guide

The HMI runs in a browser at `http://<line computer>:43123`. It shows the line live and lets you operate it remotely. The machine also has a **local control panel** that works without the HMI.

## Emergency stop

There are two kinds of emergency stop, and **both shut the machine down**:

| | Where | What happens |
| --- | --- | --- |
| **Physical E-Stop** | Red mushroom buttons on the machine: the local control panel, the **line entry** (labeling, where bottles are loaded) and the **line exit** (sort diverter and output lanes) | Power to all motion is cut in hardware immediately, including the robotic capping arm and the label applicator. The control system goes into E-Stop and the HMI shows **which button** was pressed |
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

## Station faults

The PLC watches the stations the two ESP32 nodes run (label applicator, barcode scanner, robotic capping arm, sort sensor). When one fails, or a node stops answering, the PLC **stops the line and latches a station fault**. An **orange banner** then appears on every HMI screen: "Station fault — the PLC stopped the line", followed by the cause from the latest `FAULT` event (for example "robotic arm could not pick a lid — check the lid magazine at CAP"). A station fault is not an emergency stop: the safety circuit stays closed, but nothing moves and **START is refused** ("start refused: a station fault is latched — fix it, then press RESET").

| Cause shown in the banner | What to do |
| --- | --- |
| label applicator fault | Check the label applicator for a jam or an empty label roll |
| barcode scanner not answering | Check the scanner module and its cable to the scanner node |
| robotic arm servo fault | Check the arm for an obstruction or a loose servo cable, then let it re-home |
| robotic arm could not pick a lid — check the lid magazine | Refill the lid magazine or straighten the lid stack (see below) |
| robotic arm dropped the lid | Remove the dropped lid from the belt or the arm's path |
| sort sensor fault | Check the sort sensor and its cable to the station node |
| scanner node (ESP32 #1) offline / station node (ESP32 #2, robotic arm) offline | Check that node's power and Wi-Fi |

To recover:

1. **Fix the cause** shown in the banner. Make the area safe first; use an E-Stop if you have to reach into the machine.
2. Press **RESET** on the local control panel (or on the Controls screen where remote reset is enabled). RESET clears the fault only if the cause is gone; if it's still there, the fault latches again straight away and the banner stays.
3. Press **START**.

The event log records the fault (`FAULT: …`) and the reset (`1 station fault(s) cleared by RESET`). The simulated line (`npm run dev`) doesn't produce station faults; the virtual PLC and the prototype do.

## Refilling the lid magazine

The robotic arm lifts each lid from the **lid magazine**, places it on the bottle at the capping station and presses it down. Keep the magazine stocked. When it runs empty, the arm fails to pick a lid three times in a row and the PLC latches the fault "robotic arm could not pick a lid — check the lid magazine". To refill, press **STOP** (or wait for the fault), load lids into the magazine the right way up and square in the stack, then press **START**. If the fault had latched, press **RESET** before START.

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
Labeling ─▶ Scan ─▶ Bay 1 ─▶ Bay 2 ─▶ Bay 3 ─▶ Capping arm ─▶ Sort sensor ─▶ Reject diverter ─▶ Sort diverter ─▶ Lane A (small)
                                                                              │                 └──▶ Lane B (large)
                                                                              └──▶ Reject lane
```

The reject diverter rejects bottles that are out of fill tolerance, the wrong bottle type (the sort sensor measured a height that doesn't match the bottle the recipe calls for), manually rejected, failed at a station, or had an unreadable/invalid barcode. There's no separate scan-reject lane: a bottle with a bad barcode, or one the scanner couldn't read at all, isn't filled or capped, and rides through to the reject diverter.

## Controls screen

| Section | Controls |
| --- | --- |
| **Emergency stop** | Large **DIGITAL E-STOP**; **Release digital E-Stop**; **Reset** (only where remote reset is enabled); status of the safety circuit, the digital E-Stop, and every physical E-Stop button |
| **Run control** | **Start** (REMOTE mode, after reset, no station fault latched) and **Stop** (always) |
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

Station faults show in the orange banner and in the alarm history rather than in this table ([Station faults](#station-faults)).

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
| `C-0012 barcode read — 250 ml recipe` | The PLC read and validated the label at the scanner |
| `C-0012 barcode rejected: TANK_COUNT_MISMATCH` | The barcode lists a different number of tanks than the line has |
| `C-0012 barcode rejected: NO_READ` | The scanner couldn't read a label (missing, damaged or badly placed). The bottle rides through to the reject diverter |
| `C-0012 REJECTED — fill out of tolerance` | Dispensed volume outside tolerance: check the valve calibration, a low tank (gravity feed slows), drips |
| `C-0012 REJECTED — bottle type does not match the recipe (sort sensor)` | The bottle's measured height doesn't match the lane its recipe calls for: the wrong bottle was loaded for that label |
| `FAULT: robotic arm dropped the lid at CAP — line stopped` | A station fault stopped the line ([Station faults](#station-faults)) |
| `1 station fault(s) cleared by RESET` | RESET cleared the fault; press START |
| `C-0012 ACCEPTED (fill 251.2 ml)` | Accepted and sorted to its lane (the simulated line adds "→ Lane A/B" to the message; the lane counts on the dashboard work in both) |
| `C-0012 JAMMED at BAY-2` | A container didn't arrive at or leave a station in time. At a station an ESP32 node runs (LABEL, SCAN, CAP, QC), it means the node didn't report back in time |

## SCADA view (FUXA, optional)

Besides the HMI, the line computer can run the **FUXA** SCADA, which reads the PLC directly for history, trends and alarms. It's optional: nothing on the line depends on it. Start it with `npm run fuxa` at the repo root, then open http://127.0.0.1:1881/home for the operator view ("Line overview": line state, production counts, the stations and the tanks). The editor is at `/editor`. By default the SCADA is view-only; operate the line from the HMI or the local panel. Setup and alarms: [prototype/scada.md](prototype/scada.md).
