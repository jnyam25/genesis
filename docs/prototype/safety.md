# Safety

The prototype combines moving machinery (conveyor, stoppers, reject and sort diverters, a robotic capping arm that lifts each lid, places it on the container and presses it down, a label applicator), gravity-fed liquids through proportional valves (paint, cleaning fluid), possibly pneumatics, and mains/24 V electrics. This page defines the emergency-stop and control-authority design that the rest of the documentation, the PLC program and the software all implement.

> This is engineering guidance for a prototype, not a certified safety assessment. Before anyone other than the development team operates the line, have a qualified person do a risk assessment against the standards that apply where you are (§7).

## 1. Emergency stop: physical and digital, working together

The line has **two ways to trigger an emergency stop**. Both end in the same hardwired safety circuit, so both **shut the physical system down**, and both put the **control system (PLC, bridge, HMI) into E-Stop state**.

| | Physical E-Stop | Digital E-Stop |
| --- | --- | --- |
| Where | Red mushroom buttons on the machine: local control panel, **line entry** (start of the belt, at the labeling station) and **line exit** (end of the belt, at the sort diverter) (`config.safety.eStopButtons`: `PANEL`, `ENTRY`, `EXIT`) | Red **E-STOP** button in the HMI nav bar (every screen) and on the Controls screen; FUXA's Line overview has the same button (`Cmd.DigitalEStop`) when its project is built with command buttons (`FUXA_COMMANDS=1`) |
| How it stops the hardware | The button's **safety contacts** open the safety relay's input circuit directly | The PLC de-energizes **`O_Safety_RemoteEStopOK`**. That output drives an interposing safety relay whose **force-guided NO contacts sit in series with the E-Stop chain**, so the safety circuit opens |
| How the control system learns about it | The button's **monitoring contact** (NC) → PLC input `I_EStop_<Location>_Mon` → `Sys.PhysicalEStopMask` / `LineState.PHYSICAL_ESTOP` | Latched in the PLC (`LineState.DIGITAL_ESTOP`) |
| What the HMI shows | Red banner on every screen: **"EMERGENCY STOP — Physical E-Stop pressed at *location*"**, plus an active alarm per button | Red banner: **"EMERGENCY STOP — Digital E-Stop active (activated from the HMI)"** |
| Latched until | The button is **twisted/pulled out** on the machine | **Release digital E-Stop** on the HMI |

### The rules

1. **Either E-Stop opens the safety circuit.** The safety relay removes power from every actuator: belt drive, tank valves (and their shutoff solenoids), the capping arm's servo supply, the label applicator, both diverters, any refill valves, and the pneumatic supply (dump valve) if pneumatics are used. That includes the actuators the ESP32 nodes drive (§2a).
2. **Either E-Stop puts the control system into E-Stop.** The PLC drops the run command and `Station.RunPermit`, stops all sequences (timers pause), and refuses every operational command. The HMI shows the alert and disables Start, Jog, Fire reject diverter, and tank changes. Both can be active at once, and the HMI lists every active source.
3. **Releasing never restarts.** Releasing a physical button, or the digital E-Stop, leaves the line in **"Safety reset required"**. Nothing moves.
4. **Reset closes the safety circuit, and only when no E-Stop is active.** Every physical button must be released and the digital E-Stop released first; otherwise the reset is refused, with the reason shown.
5. **Reset is done at the machine** (local control panel RESET button, which also resets the safety relay). The person resetting must be able to see that the hazard zone is clear. Remote reset from the HMI is **disabled by default** (`config.safety.remoteResetAllowed = false`, reported as `LineState.REMOTE_RESET_ALLOWED`). Enable it only after a documented risk assessment, and even then it's accepted only in REMOTE mode.
6. **Start is a separate, deliberate action** after reset: local START in LOCAL mode, or HMI Start in REMOTE mode.

### Recovery sequence (what operators do)

```
E-Stop active ──▶ make the area safe
             ──▶ release physical button(s)   (twist/pull on the machine)
             ──▶ release digital E-Stop        (HMI, if it was used)
             ──▶ "Safety reset required"
             ──▶ RESET at the local control panel
             ──▶ "Line stopped"
             ──▶ START (panel in LOCAL, HMI in REMOTE)
```

### How reliable is the digital E-Stop?

The digital E-Stop travels HMI → Raspberry Pi → Modbus TCP → PLC → output → interposing relay, typically in well under a second. Its **effect** on the machine is hardwired, but its **trigger** passes through software and a network. So:

- It's a **complementary stop**: it lets a remote operator shut the line down with the same force as a physical button. It doesn't replace physical buttons, and it doesn't count toward the safety function's required performance level unless the whole path is designed and validated for that (e.g. a safety PLC with a safety protocol).
- **Fail-safe direction.** `O_Safety_RemoteEStopOK` is **energized = OK**. PLC power loss, PLC Program/Fault mode, a broken wire or a failed relay coil all **open** the safety circuit.
- **Loss of the HMI link** (Pi heartbeat stops) is an alarm (`HMI_LINK_OK = 0`, amber stack light), not an E-Stop. The physical buttons and local panel remain in control. If a site requires "stop when the remote station is lost", implement it as a controlled stop in the PLC and document it.
- **Monitoring.** The interposing relay's force-guided NC feedback contact goes into the safety relay's feedback loop (or a PLC input, `I_Safety_RemoteRelay_Fb`), so a welded contact is detected at the next reset.

## 2. Local control station

Like any remotely operated machine, the line has a **local control station** on the machine. It keeps working when the Pi, HMI or network is down.

| Device | Type | Function |
| --- | --- | --- |
| **E-Stop** (red mushroom, yellow background) | Safety, 2 NC safety contacts + 1 NC monitoring contact | Physical E-Stop (location `PANEL`) |
| **LOCAL / REMOTE** key selector | 2-position, key removable in both positions | Control authority (§3) |
| **START** (green, flush) | NO | Start the line (LOCAL mode only) |
| **STOP** (red, NC wiring) | NC → PLC input | Controlled stop (**any mode**). A broken wire reads as STOP |
| **RESET** (blue, illuminated) | NO → safety relay reset input **and** PLC input | Safety reset (any mode). The lamp flashes when a reset is required |
| **JOG** (black, hold-to-run) | NO | Belt moves only while held; LOCAL mode, line stopped, safety circuit reset |
| Indicator lamps | — | Green RUNNING · Red E-STOP/FAULT · Blue (flashing) RESET REQUIRED · White REMOTE |

Two more E-Stop buttons give reach from both ends of the line: one at the **line entry** (`ENTRY`, by the labeling station where bottles are loaded) and one at the **line exit** (`EXIT`, by the sort diverter and output lanes where bottles are unloaded). With the panel button that makes three, wired in series in both channels of the safety relay. Add a button for every other place an operator can stand; each needs its own monitoring input and an entry in `config.safety.eStopButtons`.

On the physical line the "local control station" is the PLC's touch-panel HMI (the budget panel or C-more Micro from the BOM, or hardwired START/JOG buttons if the team skips the panel) for START/STOP, recipe select and status, **plus** hardwired devices the touch panel can't replace: the panel E-Stop, the RESET button (it must reach the safety relay's reset input), the LOCAL/REMOTE key and a hardwired STOP. See [bom.md](bom.md) for the parts.

## 2a. Actuators driven by the ESP32 nodes

The BOM puts the label applicator (ESP32 #1, scanner node) and the robotic capping arm (ESP32 #2, station node: a Hiwonder xArm that lifts a lid from the lid magazine, places it on the container at CAP and presses it down) under ESP32 control. The **PLC makes every decision**: it requests each label, issues each arm command (`HOME`, `PICK_LID`, `PLACE_LID`) through the station handshake in [io-map.md §4](io-map.md#4-register-map-modbus-tcp), and decides retries and faults. The nodes only execute and report. The firmware is in [`firmware/`](../../firmware) and described in [esp32.md](esp32.md). That's acceptable for a prototype only with these rules:

| Rule | Why |
| --- | --- |
| The **power** for the arm's servo bus and the label applicator comes from a supply switched by the **safety relay**, never straight from the ESP32's USB/5 V supply | An E-Stop must stop them even if the ESP32 firmware hangs or the Wi-Fi link is down |
| The ESP32 drives actuators only while `Station.RunPermit` = 1 **and** `Sys.PlcHeartbeat` keeps changing (stop within 1 s of either failing). The PLC drops `RunPermit` whenever the line isn't running, including on an E-Stop, a controlled stop and a latched station fault | A controlled stop and a lost link stop the stations too. This is a functional stop, not the safety function |
| On permit loss the arm stops where it is and reports `ArmResult` = `ABORTED`; it doesn't resume on its own. The PLC re-homes it (`HOME`) on the next start, and rejects a container whose lid was released during an aborted `PLACE_LID` | No surprise motion when the permit comes back |
| **Teach mode interlock.** The station node's serial-console teach mode (used to store the arm poses and gripper positions) can be switched on only while `Station.RunPermit` = 0 (line stopped). While it's on, the node ignores PLC commands and sets its arm fault bit, so the PLC latches `ARM_SERVO` and refuses START. The same fault bit is set while the poses haven't been taught. Leaving teach mode un-homes the arm, so the PLC re-homes it before the next command | Nobody can run the line while someone is moving the arm by hand, and an untaught arm can't be started |
| **Station faults are not safety functions.** The PLC latches a fault (`Sys.FaultCode`, `LineState` bit3 FAULT) and stops the line when a node reports a fault bit, when the arm reports a servo error or a lost lid, when a lid pick fails three times, or when a node's heartbeat stops for 3 s. The fault refuses START until RESET, once the cause is gone. It's a functional stop through the PLC and Wi-Fi; the E-Stops and the safety relay remain the safety function | A fault stop depends on software and a network, so it can't be credited as a safety function |
| The arm is guarded or its reach is kept clear of the operator's hands while running; check whether the arm drops a held lid when servo power is cut | Hobby arms have no brakes and no force limiting |
| Wireless link: PLC ↔ ESP32 over a dedicated access point on the control network ([communication.md](communication.md)) | Wi-Fi drops are expected, so the heartbeat rules above must hold |

## 3. Control authority: LOCAL vs REMOTE

| Action | REMOTE (HMI in control) | LOCAL (machine panel in control) |
| --- | --- | --- |
| Physical E-Stop | ✅ | ✅ |
| Digital E-Stop (HMI) | ✅ | ✅ |
| Stop (HMI or panel) | ✅ | ✅ |
| Release digital E-Stop (HMI) | ✅ | ✅ |
| Reset (panel) | ✅ | ✅ |
| Reset (HMI) | only if `remoteResetAllowed` | ❌ |
| Start / Jog | HMI only | Panel only |
| Fire reject diverter, add/remove tank | HMI only | ❌ (HMI is view-only) |

- **Switching the key changes authority and stops the line.** Neither side can take over a running line by surprise.
- **Stop and E-Stop always win.** Whichever station issues them, from either mode, in the same PLC scan as a start.
- The HMI shows the key position in the nav bar (**LOCAL/REMOTE**) and a blue "LOCAL CONTROL — HMI is view-only" banner. Refused commands come back with the reason, e.g. "start refused: local control is active".

## 4. Hardware design rules

| Rule | Why |
| --- | --- |
| Safety relay (or safety PLC) sized for the E-Stop category chosen in the risk assessment; **dual-channel** E-Stop wiring with cross-monitoring | A single short or open fault must not defeat the stop |
| Safety relay contacts switch **actuator power** (conveyor motor driver, valve and shutoff-solenoid supply, arm servo supply, labeler, diverters, pneumatic dump). The PLC, ESP32 logic and the monitoring PC stay powered | The control system must stay alive to report *why* the line stopped |
| A **normally-closed shutoff solenoid** in series with each servo-driven proportional valve, powered through the safety relay | A servo valve holds its last position when power is lost, so on its own it can keep pouring during an E-Stop |
| `O_Safety_RemoteEStopOK` → **interposing safety relay with force-guided contacts**, NO contacts in series in **both** E-Stop channels, feedback NC into the reset/feedback loop | The digital E-Stop opens the same circuit without creating a channel discrepancy; welded contacts are detected |
| Manual reset with **edge detection** (the relay resets on the release of RESET, not while it's held) | A stuck RESET button can't auto-reset |
| STOP wired **NC** to the PLC | A broken wire stops the line |
| Monitoring contacts from each E-Stop to separate PLC inputs | The HMI can name the exact button pressed |
| Stoppers spring-extended, shutoff and refill valves normally closed, reject diverter and sort diverter spring-return | De-energized state is the safe state |
| Independent high-level float switch wired to cut refill valve power | Overflow is prevented even if the PLC fails |

## 5. Design rules the control software follows

Implemented in [`twin/src/safety.ts`](../../twin/src/safety.ts): the twin, virtual PLC and bridge all use it, and it's covered by automated tests. The Micro850 program **must** implement the same rules ([micro850-plc.md](micro850-plc.md)).

1. **De-energize to stop.** Tank valves, refill valves, diverters and the belt run only while their output is ON. All outputs are forced OFF (valve angle to 0) while not running, `Station.RunPermit` drops to 0, and actuator power is removed anyway while the safety circuit is open.
2. **Every wait is bounded.** A container that doesn't arrive at or leave a station in time is JAMMED and its station released. Timeouts **pause while the line isn't running**, so a stop or E-Stop never causes jams.
3. **Command coils are one-shot.** The PLC acts on the rising edge and resets the coil, so a stuck coil can't repeat an action.
4. **Refusals are explicit.** A refused command produces event `COMMAND_REFUSED` (with command and reason codes), and the HMI shows the reason.
5. **Tank-enable changes are bounded.** The last tank can't be disabled. An in-flight container that still needs a disabled tank is under-filled and rejected, never dispensed from the wrong tank. Change tank modules while the line is stopped and empty; in LOCAL mode, tank changes from the HMI are refused.
6. **The simulated panel is simulation-only.** `Sim.*` registers/coils (and the HMI's "Local control panel & field E-Stops" card) are honoured only while `LineState.SIMULATION = 1`. A PLC must never act on them with real outputs powered.
7. **Station faults latch and stop.** A station fault (`Sys.FaultCode` 1–8) stops the line, refuses START with `FAULT_ACTIVE`, and clears only on RESET once the cause is gone (`FAULT_CLEARED`). The PLC never retries a faulted station on its own; the only automatic retry is a failed lid pick, up to three attempts. This is a functional stop, not a safety function (§2a).

## 6. Other hazards and measures

| Hazard | Where | Minimum measures |
| --- | --- | --- |
| Entanglement / pinch | Belt rollers, stoppers, reject and sort diverters, label applicator | Guard the rollers and the label applicator; limit actuator force/speed; E-Stop within reach at both ends of the line; interlocked guards in the same safety circuit |
| Impact / pinch from the robot | Capping arm: its whole reach, the gripper, the lid magazine, and the container mouth while it presses a lid down | Keep hands out of its reach while running (guard or marked zone); refill the lid magazine only with the line stopped; the arm stops on permit loss and is re-homed by the PLC; teach mode only with the line stopped (§2a); servo power through the safety relay |
| Unexpected start-up | Anything the PLC can energize | Manual reset + separate START; lockout/tagout (§8); PLC outputs OFF on power-up and in Program mode |
| Stored energy | Pneumatics (if used); tank head pressure; a servo valve that holds its position unpowered | Lockable dump/isolation valve on the air supply; NC shutoff solenoid per tank; close the tank outlet valve before opening a fitting |
| Chemical exposure / fire | Paints, solvents, cleaning agents | Ventilation; SDS available; spill tray; water-based paints for the prototype, or a hazardous-area assessment for solvents |
| Electrical + liquid | Pumps, valves and sensors near liquid | Electronics enclosure above and away from liquids; IP65+ field devices; drip loops; RCD/GFCI on mains |
| Overflow | Tank refill, container over-fill | NC refill valves; PLC refill timeout; hardwired high-level float |
| Low-voltage wiring faults | 24 V field wiring; ESP32 3.3 V logic | Fuse every 24 V branch; never connect 24 V directly to ESP32 pins (use optocouplers/isolated I/O); documented grounding |

## 7. Standards to consult

- **ISO 13850**: emergency stop function (stop category, reset behaviour, button design).
- **ISO 13849-1** / **IEC 62061**: safety-related parts of control systems (performance level / SIL). Determines the safety relay category and whether the digital E-Stop path may be credited.
- **IEC 60204-1** (in the US also **NFPA 79**): electrical equipment of machines, including stop categories, control stations and remote operation.
- **ISO 14118**: prevention of unexpected start-up.
- **ISO 14120** (guards), **ISO 13857** (safety distances).
- Local chemical-handling and ventilation regulations.

## 8. Maintenance (lockout/tagout)

1. Press **Stop**, then press a **physical E-Stop**.
2. Switch the key to **LOCAL** and remove the key (the HMI is now view-only).
3. Isolate and lock the **main electrical isolator** and the **pneumatic dump valve**, and apply personal locks and tags.
4. Verify zero energy: try START (nothing moves); pneumatic gauges read 0.
5. Relieve paint-line pressure into a container before disconnecting any fitting.
6. To restore: remove locks, clear the area, release the E-Stop, **RESET at the panel**, START.
