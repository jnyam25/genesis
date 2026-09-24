/**
 * Simulated ESP32 field nodes for the virtual PLC.
 *
 * Each class follows exactly the register contract the real firmware
 * implements (firmware/scanner-node, firmware/station-node): it reacts to the
 * PLC's requests, executes, and writes results back. None of them makes a line
 * decision. A request is new while `Request != 0 && Request != Done`, so neither
 * side needs to remember sequence numbers across restarts.
 *
 * They read the simulated containers only for physical truth: the text printed
 * on a label, and the bottle height the sort sensor would see.
 */

import type { TwinConfig } from "../config";
import type { Container } from "../core";
import {
  ARM_CMD,
  ARM_RESULT,
  ARM_STATUS_BITS,
  FIELD,
  SCAN,
  SCAN_STATUS,
  SCAN_TEXT_MAX_CHARS,
  STATION,
  packScanText,
  u16,
} from "./tag-map";

type Registers = { [address: number]: number };
type FindContainer = (id: number) => Container | undefined;

/** Seconds the simulated arm needs per command (PLACE_LID uses stationTimesSec.cap). */
export const SIM_ARM_SEC = { HOME: 1.0, PICK_LID: 1.5 } as const;

/** Runs one request/done handshake that takes `durationSec` while RunPermit = 1. */
class Handshake {
  private working = 0;
  private elapsed = 0;

  constructor(
    private readonly request: number,
    private readonly done: number,
    private readonly needsPermit: boolean,
  ) {}

  /** Returns the request id when the work is finished (caller writes results, then Done). */
  step(r: Registers, dt: number, durationSec: number): number | null {
    const req = r[this.request];
    if (req === 0 || req === r[this.done]) {
      this.working = 0;
      return null;
    }
    if (req !== this.working) {
      this.working = req;
      this.elapsed = 0;
    }
    if (this.needsPermit && r[STATION.RUN_PERMIT] !== 1) return null;
    this.elapsed += dt;
    return this.elapsed >= durationSec ? req : null;
  }
}

/** ESP32 #1: label applicator + barcode scanner. Forwards the raw text; never parses it. */
export class SimulatedScannerNode {
  private heartbeat = 0;
  private readonly label = new Handshake(STATION.LABEL_REQUEST, STATION.LABEL_DONE, true);
  private readonly scan = new Handshake(SCAN.REQUEST, SCAN.DONE, false);

  constructor(private readonly config: TwinConfig) {}

  step(r: Registers, dt: number, find: FindContainer): void {
    r[FIELD.SCANNER_NODE_HEARTBEAT] = this.heartbeat = u16(this.heartbeat + 1);

    const labelled = this.label.step(r, dt, this.config.stationTimesSec.label);
    if (labelled !== null) r[STATION.LABEL_DONE] = labelled;

    const scanned = this.scan.step(r, dt, this.config.stationTimesSec.scan);
    if (scanned !== null) {
      const text = find(scanned)?.labelText ?? null;
      const regs = packScanText(text ?? "");
      for (let i = 0; i < regs.length; i++) r[SCAN.TEXT_BASE + i] = regs[i];
      r[SCAN.LENGTH] = text === null ? 0 : Math.min(text.length, SCAN_TEXT_MAX_CHARS);
      r[SCAN.STATUS] = text === null ? SCAN_STATUS.NO_READ : text.length > SCAN_TEXT_MAX_CHARS ? SCAN_STATUS.TOO_LONG : SCAN_STATUS.OK;
      r[SCAN.DONE] = scanned;
    }
  }
}

/** ESP32 #2 on the xArm: executes arm commands and measures bottle height at the sort sensor. */
export class SimulatedStationNode {
  private heartbeat = 0;
  private homed = false;
  private lidHeld = false;
  private running: { cmd: number; seq: number; elapsed: number } | null = null;
  private readonly sort = new Handshake(STATION.SORT_REQUEST, STATION.SORT_DONE, false);

  constructor(private readonly config: TwinConfig) {}

  step(r: Registers, dt: number, find: FindContainer): void {
    r[FIELD.STATION_NODE_HEARTBEAT] = this.heartbeat = u16(this.heartbeat + 1);
    this.stepArm(r, dt);
    this.publishStatus(r);

    const measured = this.sort.step(r, dt, this.config.stationTimesSec.qc);
    if (measured !== null) {
      const c = find(measured);
      r[STATION.SORT_HEIGHT_MM] = c ? this.config.sort.lanes[c.lane].bottleHeightMm : 0;
      r[STATION.SORT_DONE] = measured;
    }
  }

  private stepArm(r: Registers, dt: number): void {
    const seq = r[STATION.ARM_CMD_SEQ];
    if (!this.running && seq !== 0 && seq !== r[STATION.ARM_DONE_SEQ]) {
      const cmd = r[STATION.ARM_CMD];
      const known = cmd === ARM_CMD.HOME || cmd === ARM_CMD.PICK_LID || cmd === ARM_CMD.PLACE_LID;
      if (!known || r[STATION.RUN_PERMIT] !== 1 || (cmd !== ARM_CMD.HOME && !this.homed)) {
        this.finish(r, seq, ARM_RESULT.REFUSED);
        return;
      }
      if (cmd === ARM_CMD.PLACE_LID && !this.lidHeld) {
        this.finish(r, seq, ARM_RESULT.LID_LOST);
        return;
      }
      this.running = { cmd, seq, elapsed: 0 };
    }
    if (!this.running) return;
    if (r[STATION.RUN_PERMIT] !== 1) {
      // Stop where it is; the position is no longer trusted until the next HOME.
      this.homed = false;
      this.finish(r, this.running.seq, ARM_RESULT.ABORTED);
      return;
    }
    this.running.elapsed += dt;
    const { cmd } = this.running;
    const duration = cmd === ARM_CMD.HOME ? SIM_ARM_SEC.HOME : cmd === ARM_CMD.PICK_LID ? SIM_ARM_SEC.PICK_LID : this.config.stationTimesSec.cap;
    if (this.running.elapsed < duration) return;
    if (cmd === ARM_CMD.HOME) this.homed = true;
    if (cmd === ARM_CMD.PICK_LID) this.lidHeld = true;
    if (cmd === ARM_CMD.PLACE_LID) this.lidHeld = false;
    this.finish(r, this.running.seq, ARM_RESULT.OK);
  }

  private finish(r: Registers, seq: number, result: number): void {
    this.running = null;
    r[STATION.ARM_RESULT] = result;
    r[STATION.ARM_DONE_SEQ] = seq;
  }

  private publishStatus(r: Registers): void {
    let status = 0;
    if (this.homed) status |= 1 << ARM_STATUS_BITS.HOMED;
    if (this.running) status |= 1 << ARM_STATUS_BITS.BUSY;
    if (this.lidHeld) status |= 1 << ARM_STATUS_BITS.LID_HELD;
    r[STATION.ARM_STATUS] = status;
  }
}
