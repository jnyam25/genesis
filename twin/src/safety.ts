/**
 * Line safety and control-authority state machine.
 *
 * Models the interplay of the physical and digital emergency stops, the safety
 * relay, the local control station (Local/Remote key switch, Start, Stop,
 * Reset, Jog), and remote (HMI) control. Used by the Node twin core (and thus
 * the virtual PLC) and by the bridge's command pre-check, and specified for the
 * Micro850 PLC in docs/prototype/micro850-plc.md — so every layer enforces
 * identical rules.
 *
 * Rules (docs/prototype/safety.md):
 *   - Physical E-Stop pressed  → safety circuit opens (hardware removes actuator
 *     power) AND the control system enters E-Stop: the line stops, commands are
 *     refused, the HMI shows which button was pressed.
 *   - Digital E-Stop (HMI)     → the PLC drops its fail-safe "remote E-Stop OK"
 *     output wired into the same safety circuit, so the hardware shuts down too.
 *     Latched until released from the HMI.
 *   - Releasing either E-Stop never restarts anything: a RESET closes the safety
 *     circuit (only when no E-Stop is active), then a START runs the line.
 *   - RESET is local by default (operator must see the hazard zone);
 *     remote reset is allowed only if `remoteResetAllowed` and in Remote mode.
 *   - Local/Remote key switch decides who may START, JOG, fire the pusher, and
 *     change tanks. STOP and both E-Stops work from anywhere, in any mode.
 *     Changing mode stops the line.
 */

import { COMMAND_TEXT, EventCode, REFUSAL_TEXT, RefusalReason, SafetyCommand } from "./events";

export { COMMAND_TEXT, REFUSAL_TEXT, RefusalReason, SafetyCommand };

export type ControlSource = "local" | "remote";
export type ControlMode = "local" | "remote";

export interface EStopButtonConfig {
  /** Stable id (also the bit order in the PLC's physical E-Stop mask). */
  id: string;
  /** Location shown to operators. */
  name: string;
}

export interface SafetyConfig {
  /** Physical E-Stop buttons, in PLC mask bit order (max 16). */
  eStopButtons: EStopButtonConfig[];
  /** Allow a safety reset from the HMI (Remote mode only). Default false: reset at the machine. */
  remoteResetAllowed: boolean;
  /** Initial control mode. */
  initialMode: ControlMode;
  /**
   * Simulation convenience: start with the safety circuit reset and the line
   * running. A physical PLC always powers up needing RESET then START.
   */
  startRunning: boolean;
}

export interface Refusal {
  command: SafetyCommand;
  reason: RefusalReason;
  message: string;
}

/** Operator-facing safety state (part of the HMI contract). */
export interface SafetyState {
  /** Any E-Stop (digital latched or physical pressed) is active. */
  eStopActive: boolean;
  digitalEStop: boolean;
  eStopButtons: Array<EStopButtonConfig & { pressed: boolean }>;
  /** Safety relay closed: actuator power available. */
  safetyCircuitOk: boolean;
  /** No E-Stop active, but the safety circuit has not been reset yet. */
  resetRequired: boolean;
  /** Line commanded to run (and safety OK). */
  running: boolean;
  controlMode: ControlMode;
  remoteResetAllowed: boolean;
  /** The source is a simulation: local-panel/E-Stop buttons can be operated from the HMI. */
  simulated: boolean;
}

/**
 * Authorization rules, as a pure function of the current state, so the PLC
 * bridge can pre-check commands with exactly the rules the controller applies.
 */
export function authorize(state: SafetyState, command: SafetyCommand, source: ControlSource): Refusal | null {
  const refuse = (reason: RefusalReason): Refusal => ({
    command,
    reason,
    message: `${COMMAND_TEXT[command]} refused: ${REFUSAL_TEXT[reason]}`,
  });
  const physicalPressed = state.eStopButtons.some((b) => b.pressed);

  switch (command) {
    case SafetyCommand.DIGITAL_ESTOP:
    case SafetyCommand.STOP:
      return null; // always allowed, from anywhere
    case SafetyCommand.RELEASE_ESTOP:
      return state.digitalEStop ? null : refuse(RefusalReason.NOT_ACTIVE);
    case SafetyCommand.MODE_CHANGE:
      return source === "local" ? null : refuse(RefusalReason.LOCAL_MODE);
    case SafetyCommand.RESET:
      if (physicalPressed) return refuse(RefusalReason.ESTOP_STILL_PRESSED);
      if (state.digitalEStop) return refuse(RefusalReason.ESTOP_ACTIVE);
      if (source === "remote") {
        if (state.controlMode !== "remote") return refuse(RefusalReason.LOCAL_MODE);
        if (!state.remoteResetAllowed) return refuse(RefusalReason.REMOTE_RESET_NOT_ALLOWED);
      }
      return null;
  }

  // START, JOG, FIRE_PUSHER, TANK_CHANGE: need control authority.
  if (source !== state.controlMode) {
    return refuse(source === "remote" ? RefusalReason.LOCAL_MODE : RefusalReason.REMOTE_MODE);
  }
  if (command === SafetyCommand.TANK_CHANGE) return null; // configuration change; allowed while stopped too
  if (state.eStopActive) return refuse(RefusalReason.ESTOP_ACTIVE);
  if (state.resetRequired) return refuse(RefusalReason.RESET_REQUIRED);
  if (command === SafetyCommand.JOG && state.running) return refuse(RefusalReason.LINE_RUNNING);
  return null;
}

export type SafetyEventSink = (code: EventCode, arg1: number, arg2: number, message: string) => void;

export const SOURCE_CODE: Record<ControlSource, number> = { local: 1, remote: 2 };

export class LineSafety {
  private digital = false;
  private readonly pressed = new Set<string>();
  private circuitOk: boolean;
  private runCommanded: boolean;
  private mode: ControlMode;

  constructor(
    private readonly config: SafetyConfig,
    private readonly emit: SafetyEventSink,
    private readonly simulated = false,
  ) {
    this.circuitOk = config.startRunning;
    this.runCommanded = config.startRunning;
    this.mode = config.initialMode;
  }

  /** Motion and dispensing allowed. */
  get lineEnabled(): boolean {
    return this.circuitOk && this.runCommanded && !this.eStopActive;
  }

  get eStopActive(): boolean {
    return this.digital || this.pressed.size > 0;
  }

  get controlMode(): ControlMode {
    return this.mode;
  }

  state(): SafetyState {
    const eStopActive = this.eStopActive;
    return {
      eStopActive,
      digitalEStop: this.digital,
      eStopButtons: this.config.eStopButtons.map((b) => ({ ...b, pressed: this.pressed.has(b.id) })),
      safetyCircuitOk: this.circuitOk,
      resetRequired: !eStopActive && !this.circuitOk,
      running: this.lineEnabled,
      controlMode: this.mode,
      remoteResetAllowed: this.config.remoteResetAllowed,
      simulated: this.simulated,
    };
  }

  /** Bit mask of pressed physical E-Stops (bit i = config.eStopButtons[i]). */
  physicalMask(): number {
    return this.config.eStopButtons.reduce((m, b, i) => (this.pressed.has(b.id) ? m | (1 << i) : m), 0);
  }

  private refused(r: Refusal): Refusal {
    this.emit(EventCode.COMMAND_REFUSED, r.command, r.reason, r.message);
    return r;
  }

  private check(command: SafetyCommand, source: ControlSource): Refusal | null {
    const r = authorize(this.state(), command, source);
    return r ? this.refused(r) : null;
  }

  /** Authorize an operational command (JOG, FIRE_PUSHER, TANK_CHANGE); records a refusal event. */
  authorize(command: SafetyCommand, source: ControlSource): Refusal | null {
    return this.check(command, source);
  }

  /** Digital E-Stop from the HMI: opens the safety circuit (via the PLC's fail-safe output). */
  pressDigitalEStop(): void {
    const wasEnabled = this.lineEnabled;
    if (!this.digital) {
      this.digital = true;
      this.emit(EventCode.DIGITAL_ESTOP, SOURCE_CODE.remote, 0, "DIGITAL E-STOP activated from the HMI — safety circuit opened, all motion de-energized");
    }
    this.openCircuit(wasEnabled);
  }

  releaseDigitalEStop(): Refusal | null {
    const r = this.check(SafetyCommand.RELEASE_ESTOP, "remote");
    if (r) return r;
    this.digital = false;
    this.emit(EventCode.DIGITAL_ESTOP_RELEASED, SOURCE_CODE.remote, 0, "Digital E-Stop released — safety reset required at the local panel");
    return null;
  }

  /** Physical E-Stop button state (from the safety relay's monitoring inputs). */
  setPhysicalEStop(buttonId: string, pressed: boolean): void {
    const index = this.config.eStopButtons.findIndex((b) => b.id === buttonId);
    if (index < 0) return;
    const name = this.config.eStopButtons[index].name;
    if (pressed && !this.pressed.has(buttonId)) {
      const wasEnabled = this.lineEnabled;
      this.pressed.add(buttonId);
      this.emit(EventCode.PHYSICAL_ESTOP_PRESSED, index, 0, `PHYSICAL E-STOP pressed at ${name} — safety circuit opened, all motion de-energized`);
      this.openCircuit(wasEnabled);
    } else if (!pressed && this.pressed.has(buttonId)) {
      this.pressed.delete(buttonId);
      this.emit(EventCode.PHYSICAL_ESTOP_RELEASED, index, 0, `Physical E-Stop at ${name} released — safety reset required`);
    }
  }

  reset(source: ControlSource): Refusal | null {
    const r = this.check(SafetyCommand.RESET, source);
    if (r) return r;
    if (this.circuitOk) return null;
    this.circuitOk = true;
    this.runCommanded = false; // a reset never starts the line
    this.emit(EventCode.SAFETY_RESET, SOURCE_CODE[source], 0, `Safety circuit reset (${source}) — press START to run`);
    return null;
  }

  start(source: ControlSource): Refusal | null {
    const r = this.check(SafetyCommand.START, source);
    if (r) return r;
    if (this.runCommanded) return null;
    this.runCommanded = true;
    this.emit(EventCode.LINE_STARTED, SOURCE_CODE[source], 0, `Line started (${source})`);
    return null;
  }

  stop(source: ControlSource): void {
    if (!this.runCommanded) return;
    this.runCommanded = false;
    this.emit(EventCode.LINE_STOPPED, SOURCE_CODE[source], 0, `Line stopped (${source})`);
  }

  /** Local/Remote key switch (a physical input: local source only). */
  setMode(mode: ControlMode, source: ControlSource = "local"): Refusal | null {
    const r = this.check(SafetyCommand.MODE_CHANGE, source);
    if (r) return r;
    if (mode === this.mode) return null;
    this.mode = mode;
    this.emit(EventCode.CONTROL_MODE_CHANGED, mode === "local" ? 1 : 0, 0, `Control mode: ${mode.toUpperCase()}${mode === "local" ? " — HMI is view-only" : ""}`);
    this.stop("local");
    return null;
  }

  private openCircuit(wasEnabled: boolean): void {
    this.circuitOk = false;
    this.runCommanded = false;
    if (wasEnabled) this.emit(EventCode.LINE_STOPPED, 0, 0, "Line stopped by emergency stop");
  }
}
