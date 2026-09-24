/**
 * Client-side mirror of the safety/authority rules in twin/src/safety.ts. Used
 * to enable/disable HMI controls and by the mock engine. The twin/PLC remains
 * authoritative: a refused command comes back with its reason.
 */

import type { ControlMode, SafetyState, TwinEvent } from "./types";

export type ControlSource = "local" | "remote";
export type SafetyCommand =
  | "start"
  | "stop"
  | "reset"
  | "jog"
  | "firePusher"
  | "tankChange"
  | "releaseEStop"
  | "eStop";

const COMMAND_TEXT: Record<SafetyCommand, string> = {
  start: "start",
  stop: "stop",
  reset: "reset",
  jog: "jog",
  firePusher: "fire reject diverter",
  tankChange: "tank change",
  releaseEStop: "release digital E-Stop",
  eStop: "digital E-Stop",
};

const LOCAL_MODE = "local control is active — the HMI is view-only (switch the panel key to REMOTE)";
const REMOTE_MODE = "remote control is active — local panel buttons are disabled (switch the panel key to LOCAL)";

/** null if allowed, otherwise the refusal message (same wording as the twin). */
export function refusal(
  state: SafetyState | undefined,
  command: SafetyCommand,
  source: ControlSource = "remote",
): string | null {
  if (!state) return null; // source without safety data: let the backend decide
  const refuse = (reason: string) => `${COMMAND_TEXT[command]} refused: ${reason}`;
  const physicalPressed = state.eStopButtons.some((b) => b.pressed);
  switch (command) {
    case "eStop":
    case "stop":
      return null;
    case "releaseEStop":
      return state.digitalEStop ? null : refuse("the digital E-Stop is not active");
    case "reset":
      if (physicalPressed) return refuse("a physical E-Stop is still pressed — release it first");
      if (state.digitalEStop) return refuse("an emergency stop is active");
      if (source === "remote") {
        if (state.controlMode !== "remote") return refuse(LOCAL_MODE);
        if (!state.remoteResetAllowed) return refuse("reset must be done at the local control panel");
      }
      return null;
  }
  if (source !== state.controlMode) return refuse(source === "remote" ? LOCAL_MODE : REMOTE_MODE);
  if (command === "tankChange") return null;
  if (state.eStopActive) return refuse("an emergency stop is active");
  if (state.resetRequired) return refuse("safety reset required");
  if (command === "jog" && state.running) return refuse("stop the line first");
  return null;
}

type Emit = (severity: TwinEvent["severity"], message: string) => void;

/** Same as the twin's config.safety.eStopButtons, in PLC mask bit order. */
const DEFAULT_BUTTONS = [
  { id: "PANEL", name: "Local control panel" },
  { id: "ENTRY", name: "Line entry" },
  { id: "EXIT", name: "Line exit" },
];

/** Safety state machine for the mock engine (same rules as the twin). */
export class MockSafety {
  private digital = false;
  private pressed = new Set<string>();
  private circuitOk = true;
  private runCommanded = true;
  private mode: ControlMode = "remote";

  constructor(
    private readonly emit: Emit,
    private readonly buttons = DEFAULT_BUTTONS,
    private readonly remoteResetAllowed = false,
  ) {}

  get lineEnabled(): boolean {
    return this.circuitOk && this.runCommanded && !this.eStopActive;
  }

  get eStopActive(): boolean {
    return this.digital || this.pressed.size > 0;
  }

  state(): SafetyState {
    const eStopActive = this.eStopActive;
    return {
      eStopActive,
      digitalEStop: this.digital,
      eStopButtons: this.buttons.map((b) => ({ ...b, pressed: this.pressed.has(b.id) })),
      safetyCircuitOk: this.circuitOk,
      resetRequired: !eStopActive && !this.circuitOk,
      running: this.lineEnabled,
      controlMode: this.mode,
      remoteResetAllowed: this.remoteResetAllowed,
      simulated: true,
    };
  }

  /** Check a command; emits a warning event when refused. */
  check(command: SafetyCommand, source: ControlSource): string | null {
    const r = refusal(this.state(), command, source);
    if (r) this.emit("warn", r);
    return r;
  }

  private open(): void {
    const wasEnabled = this.lineEnabled;
    this.circuitOk = false;
    this.runCommanded = false;
    if (wasEnabled) this.emit("warn", "Line stopped by emergency stop");
  }

  pressDigitalEStop(): null {
    if (!this.digital) {
      this.digital = true;
      this.emit("error", "DIGITAL E-STOP activated from the HMI — safety circuit opened, all motion de-energized");
    }
    this.open();
    return null;
  }

  releaseDigitalEStop(): string | null {
    const r = this.check("releaseEStop", "remote");
    if (r) return r;
    this.digital = false;
    this.emit("warn", "Digital E-Stop released — safety reset required at the local panel");
    return null;
  }

  setPhysicalEStop(buttonId: string, pressed: boolean): string | null {
    const button = this.buttons.find((b) => b.id === buttonId);
    if (!button) return `unknown E-Stop button ${buttonId}`;
    if (pressed && !this.pressed.has(buttonId)) {
      this.pressed.add(buttonId);
      this.emit("error", `PHYSICAL E-STOP pressed at ${button.name} — safety circuit opened, all motion de-energized`);
      this.open();
    } else if (!pressed && this.pressed.has(buttonId)) {
      this.pressed.delete(buttonId);
      this.emit("warn", `Physical E-Stop at ${button.name} released — safety reset required`);
    }
    return null;
  }

  reset(source: ControlSource): string | null {
    const r = this.check("reset", source);
    if (r) return r;
    if (this.circuitOk) return null;
    this.circuitOk = true;
    this.runCommanded = false;
    this.emit("success", `Safety circuit reset (${source}) — press START to run`);
    return null;
  }

  start(source: ControlSource): string | null {
    const r = this.check("start", source);
    if (r) return r;
    if (this.runCommanded) return null;
    this.runCommanded = true;
    this.emit("success", `Line started (${source})`);
    return null;
  }

  stop(source: ControlSource): null {
    if (this.runCommanded) {
      this.runCommanded = false;
      this.emit("warn", `Line stopped (${source})`);
    }
    return null;
  }

  setMode(mode: ControlMode): null {
    if (mode === this.mode) return null;
    this.mode = mode;
    this.emit("info", `Control mode: ${mode.toUpperCase()}${mode === "local" ? " — HMI is view-only" : ""}`);
    this.stop("local");
    return null;
  }
}
