/**
 * HMI adapter — maps the twin core onto the HMI's `TwinState` contract.
 *
 * The engine's own snapshot (`core.snapshot()`, served at `/snapshot`) is the
 * documented engine contract and stays unchanged. The operator HMI
 * (`hmi/src/lib/twin/types.ts`) renders a different, visualization-oriented
 * shape: string container ids, station-based statuses (`scan`, `fill-N`, `qc`,
 * `output`, `rejected`, `scan-rejected`), structured events, and wall-clock
 * timestamps. This module is the single translation point between the two, and
 * also dispatches operator commands coming back from the HMI.
 *
 * The types below mirror `hmi/src/lib/twin/types.ts`; keep them in sync.
 */

import type { Container as CoreContainer, CoreEvent, Snapshot, TwinCore } from "./core";
import type { Refusal, SafetyState } from "./safety";
import { validateTankColor, type TankColorSlot, type TankPalette } from "./tank-colors";

export type HmiContainerStatus =
  | "idle"
  | "label"
  | "scan"
  | "scan-rejected"
  | `fill-${number}`
  | "mix"
  | "cap"
  | "press"
  | "qc"
  | "sort"
  | "output"
  | "rejected";

export interface HmiSortLane {
  id: string;
  name: string;
  /** Accepted containers sent to this lane. */
  count: number;
}

export interface HmiEvent {
  id: string;
  /** Wall-clock ms. */
  at: number;
  severity: "info" | "warn" | "error" | "success";
  message: string;
}

/** A tank slot's editable name/color and whether it is on the line. */
export interface HmiTankSlot extends TankColorSlot {
  enabled: boolean;
}

export interface HmiState {
  tanks: { id: string; name: string; colorCode: string; levelMl: number; capacityMl: number }[];
  /** Every tank slot (enabled or not) with its editable name/color (optional contract extension). */
  tankSlots?: HmiTankSlot[];
  containers: {
    id: string;
    status: HmiContainerStatus;
    fillMl: number;
    targetMl: number;
    /** Output lane (index into sortLanes) the container is sorted to. */
    lane?: number;
  }[];
  counts: { accepted: number; rejected: number; total: number };
  /** Output lanes after the sort diverter with accepted counts (optional contract extension). */
  sortLanes?: HmiSortLane[];
  throughputCpm: number;
  oee: { availability: number; performance: number; quality: number; overall: number };
  lastEvent: HmiEvent | null;
  /**
   * Recent events, newest first (optional contract extension). Lets the HMI
   * keep a gap-free log even when several events happen between polls.
   */
  recentEvents?: HmiEvent[];
  /**
   * Emergency-stop, safety-circuit, and local/remote control state (optional
   * contract extension; see safety.ts). The HMI shows a global E-Stop alert and
   * enables controls from it.
   */
  safety?: SafetyState;
  /** Wall-clock ms. */
  timestamp: number;
  connected: boolean;
}

/** Operator commands from the HMI (source: remote). */
export const HMI_COMMANDS = [
  "eStop", // digital E-Stop
  "releaseEStop", // release the digital E-Stop latch
  "clearEStop", // alias of releaseEStop (v1 name)
  "reset",
  "start",
  "stop",
  "jogBelt",
  "firePusher",
  "addTank", // optional name/colorCode for the new tank
  "removeTank",
  "setTankColor", // rename/recolor a tank slot (presentation only)
  "resetTankColor", // restore a slot's (or, without tankId, every slot's) default name/color
] as const;

/**
 * Simulation-only commands that operate the *physical* controls of a simulated
 * line (local control panel and E-Stop buttons). Refused by a real PLC.
 */
export const SIM_COMMANDS = ["simControlMode", "simLocalButton", "simPhysicalEStop"] as const;

export type HmiCommand = (typeof HMI_COMMANDS)[number];
export type SimCommand = (typeof SIM_COMMANDS)[number];
export const LOCAL_BUTTONS = ["start", "stop", "reset", "jog"] as const;
export type LocalButton = (typeof LOCAL_BUTTONS)[number];

/** How many recent events each state carries. */
const RECENT_EVENTS = 20;

/** Finished containers stay visible at the output/reject lane this long (sim s). */
const COMPLETED_LINGER_SEC = 1.5;

export function hmiContainerId(id: number): string {
  return `C-${String(id).padStart(4, "0")}`;
}

/** Map a core container to the station-based status the HMI animates. */
export function hmiStatus(c: CoreContainer): HmiContainerStatus {
  if (c.state === "ACCEPTED") return "output";
  if (c.state === "REJECTED") return c.parseError ? "scan-rejected" : "rejected";
  if (c.state === "JAMMED") return "rejected";

  // Live: show the station the container is at (or travelling to).
  const op = c.ops[Math.min(c.opIndex, c.ops.length - 1)];
  if (!op) return "scan";
  switch (op.stationId) {
    case "LABEL":
      return "label";
    case "SCAN":
      return "scan";
    case "MIX":
      return "mix";
    case "CAP":
      return "cap";
    case "PRESS":
      return "press";
    case "QC":
    case "GATE":
      return "qc";
    case "SORT":
      return "sort";
  }
  const bay = /^BAY-(\d+)$/.exec(op.stationId);
  if (bay) return `fill-${Number(bay[1])}`;
  return "scan";
}

function hmiEvent(e: CoreEvent, core: TwinCore, nowMs: number): HmiEvent {
  return {
    id: `e${e.seq}`,
    at: Math.round(nowMs - (core.simTimeSec - e.simTimeSec) * 1000),
    severity: e.severity,
    message: e.message,
  };
}

/** Containers the HMI should show: everything on the belt plus briefly-lingering finished ones. */
export function visibleContainers(core: TwinCore): CoreContainer[] {
  return core.containers.filter(
    (c) => c.completedAtSec === null || core.simTimeSec - c.completedAtSec <= COMPLETED_LINGER_SEC,
  );
}

/**
 * OEE as shown to operators. The engine's availability is cumulative; while
 * E-Stopped the line is not available *now*, and the HMI keys its "Line halted"
 * state off availability === 0, so report the instantaneous value then.
 */
export function liveOee(core: TwinCore, snap: Snapshot = core.snapshot()): Snapshot["oee"] {
  return core.isHalted ? { ...snap.oee, availability: 0, overall: 0 } : snap.oee;
}

export function hmiTankSlots(palette: TankPalette, enabledIds: Iterable<string>): HmiTankSlot[] {
  const enabled = new Set(enabledIds);
  return palette.slots().map((s) => ({ ...s, enabled: enabled.has(s.id) }));
}

export function toHmiState(core: TwinCore, nowMs = Date.now()): HmiState {
  const snap = core.snapshot();
  const last = core.events[core.events.length - 1];

  return {
    tanks: snap.tanks,
    tankSlots: hmiTankSlots(core.palette, core.tanks.map((t) => t.id)),
    containers: visibleContainers(core).map((c) => ({
      id: hmiContainerId(c.id),
      status: hmiStatus(c),
      fillMl: Math.round(c.fillMl * 10) / 10,
      targetMl: c.targetMl,
      lane: c.lane,
    })),
    counts: snap.counts,
    sortLanes: snap.sortLanes,
    throughputCpm: snap.throughputCpm,
    oee: liveOee(core, snap),
    safety: core.safety.state(),
    lastEvent: last ? hmiEvent(last, core, nowMs) : null,
    recentEvents: core.events
      .slice(-RECENT_EVENTS)
      .reverse()
      .map((e) => hmiEvent(e, core, nowMs)),
    timestamp: nowMs,
    connected: true,
  };
}

export interface CommandRequest {
  command?: unknown;
  tankId?: unknown;
  /** addTank / setTankColor: tank display name */
  name?: unknown;
  /** addTank / setTankColor: "#RRGGBB" */
  colorCode?: unknown;
  /** simControlMode: "local" | "remote" */
  mode?: unknown;
  /** simLocalButton: "start" | "stop" | "reset" | "jog" */
  button?: unknown;
  /** simPhysicalEStop: E-Stop button id (config.safety.eStopButtons) */
  buttonId?: unknown;
  /** simPhysicalEStop: pressed (true) or released (false) */
  pressed?: unknown;
}

export function isKnownCommand(command: unknown): command is HmiCommand | SimCommand {
  return typeof command === "string" && ([...HMI_COMMANDS, ...SIM_COMMANDS] as readonly string[]).includes(command);
}

export function unknownCommandMessage(command: unknown): string {
  return `unknown command ${JSON.stringify(command)}; expected one of ${[...HMI_COMMANDS, ...SIM_COMMANDS].join(", ")}`;
}

const message = (r: Refusal | null): string | null => (r ? r.message : null);

/** Validated optional name/colorCode of an addTank request. */
export function addTankColor(req: CommandRequest): { color?: { name?: string; colorCode?: string } } | { error: string } {
  if (req.name === undefined && req.colorCode === undefined) return {};
  const result = validateTankColor(req);
  return "error" in result ? result : { color: result.patch };
}

/** Apply setTankColor / resetTankColor to a palette owner (core or bridge). */
export function applyTankColorCommand(
  target: { setTankColor(id: string, c: CommandRequest): string | null; resetTankColor(id?: string): string | null },
  req: CommandRequest,
): string | null {
  if (req.command === "setTankColor") {
    if (typeof req.tankId !== "string") return "setTankColor requires a string tankId";
    return target.setTankColor(req.tankId, { name: req.name, colorCode: req.colorCode });
  }
  if (req.tankId !== undefined && typeof req.tankId !== "string") return "resetTankColor tankId must be a string";
  return target.resetTankColor(req.tankId as string | undefined);
}

/**
 * Validate and apply an operator command to the simulated core. Returns an
 * error message (unknown command, bad arguments, or a safety/authority
 * refusal), or null on success.
 */
export function applyHmiCommand(core: TwinCore, req: CommandRequest): string | null {
  const command = req.command;
  if (!isKnownCommand(command)) return unknownCommandMessage(command);
  switch (command) {
    case "eStop":
      return message(core.eStop());
    case "releaseEStop":
    case "clearEStop":
      return message(core.clearEStop());
    case "reset":
      return message(core.reset("remote"));
    case "start":
      return message(core.start("remote"));
    case "stop":
      return message(core.stop("remote"));
    case "jogBelt":
      return message(core.jogBelt("remote"));
    case "firePusher":
      return message(core.firePusher("remote"));
    case "addTank": {
      const color = addTankColor(req);
      if ("error" in color) return color.error;
      return message(core.addTank("remote", color.color));
    }
    case "removeTank":
      if (typeof req.tankId !== "string") return "removeTank requires a string tankId";
      return message(core.removeTank(req.tankId, "remote"));
    case "setTankColor":
    case "resetTankColor":
      return applyTankColorCommand(core, req);
    case "simControlMode":
      if (req.mode !== "local" && req.mode !== "remote") return 'simControlMode requires mode "local" or "remote"';
      return message(core.setControlMode(req.mode));
    case "simLocalButton":
      switch (req.button) {
        case "start":
          return message(core.start("local"));
        case "stop":
          return message(core.stop("local"));
        case "reset":
          return message(core.reset("local"));
        case "jog":
          return message(core.jogBelt("local"));
        default:
          return `simLocalButton requires button ${LOCAL_BUTTONS.map((b) => `"${b}"`).join(" | ")}`;
      }
    case "simPhysicalEStop": {
      const ids = core.config.safety.eStopButtons.map((b) => b.id);
      if (typeof req.buttonId !== "string" || !ids.includes(req.buttonId)) {
        return `simPhysicalEStop requires buttonId one of ${ids.join(", ")}`;
      }
      if (typeof req.pressed !== "boolean") return "simPhysicalEStop requires boolean pressed";
      core.setPhysicalEStop(req.buttonId, req.pressed);
      return null;
    }
  }
}
