/**
 * Robotic arm sequencing — PLC side (reference for the Micro850 program,
 * docs/prototype/micro850-plc.md).
 *
 * The station node (ESP32 on the xArm) executes one command at a time and
 * reports back; every decision is made here:
 *
 *   not homed (power-up, after an abort)     → HOME
 *   homed, no lid in the gripper             → PICK_LID   (pre-pick while the belt moves)
 *   homed, lid held, container held at CAP   → PLACE_LID  (place + press down + release)
 *
 * Results: NO_LID is retried up to ARM_PICK_ATTEMPTS times, then latches
 * ARM_NO_LID. LID_LOST and SERVO_ERROR latch a fault. ABORTED (RunPermit
 * dropped mid-move) re-homes; if the lid was already released during an
 * aborted PLACE_LID, that container is rejected, since the PLC cannot tell
 * whether its lid is seated.
 */

import { FaultCode } from "../events";
import { ARM_CMD, ARM_RESULT, ARM_STATUS_BITS, STATION, bit } from "./tag-map";

export const ARM_PICK_ATTEMPTS = 3;

export type CapOutcome = "capped" | "failed";

export class ArmSequencer {
  private seq = 0;
  private pending: { cmd: number; seq: number; target: number } | null = null;
  private needHome = true;
  private pickFailures = 0;
  private readonly outcomes = new Map<number, CapOutcome>();

  /** @param r the PLC's holding-register image */
  constructor(private readonly r: { [address: number]: number }) {}

  /** A command is out and the node has not reported it finished yet. */
  get busy(): boolean {
    return this.pending !== null;
  }

  /**
   * One PLC scan. `capTarget` = id of the container held at CAP (0 = none).
   * Returns a fault to latch, or null.
   */
  step(runPermit: boolean, faulted: boolean, capTarget: number): FaultCode | null {
    const r = this.r;
    const lidHeld = bit(r[STATION.ARM_STATUS], ARM_STATUS_BITS.LID_HELD);
    const homed = bit(r[STATION.ARM_STATUS], ARM_STATUS_BITS.HOMED);

    if (this.pending) {
      if (r[STATION.ARM_DONE_SEQ] !== this.pending.seq) return null;
      const { cmd, target } = this.pending;
      this.pending = null;
      r[STATION.ARM_CMD] = ARM_CMD.NONE;
      const placing = cmd === ARM_CMD.PLACE_LID;
      switch (r[STATION.ARM_RESULT]) {
        case ARM_RESULT.OK:
          if (cmd === ARM_CMD.HOME) this.needHome = false;
          if (cmd === ARM_CMD.PICK_LID) this.pickFailures = 0;
          if (placing) this.outcomes.set(target, "capped");
          return null;
        case ARM_RESULT.NO_LID:
          if (placing) this.outcomes.set(target, "failed");
          return ++this.pickFailures >= ARM_PICK_ATTEMPTS ? FaultCode.ARM_NO_LID : null;
        case ARM_RESULT.LID_LOST:
          if (placing) this.outcomes.set(target, "failed");
          return FaultCode.ARM_LID_LOST;
        case ARM_RESULT.ABORTED:
          this.needHome = true;
          if (placing && !lidHeld) this.outcomes.set(target, "failed");
          return null;
        case ARM_RESULT.REFUSED:
          this.needHome = true;
          return null;
        default:
          if (placing) this.outcomes.set(target, "failed");
          return FaultCode.ARM_SERVO;
      }
    }

    if (!runPermit || faulted) return null;
    if (this.needHome || !homed) this.issue(ARM_CMD.HOME, 0);
    else if (!lidHeld) this.issue(ARM_CMD.PICK_LID, 0);
    else if (capTarget !== 0 && !this.outcomes.has(capTarget)) this.issue(ARM_CMD.PLACE_LID, capTarget);
    return null;
  }

  /** Outcome of PLACE_LID for a container (consumed once read), or undefined while pending. */
  takeOutcome(containerId: number): CapOutcome | undefined {
    const outcome = this.outcomes.get(containerId);
    if (outcome) this.outcomes.delete(containerId);
    return outcome;
  }

  /** RESET: forget pick failures and re-home before the next command. */
  reset(): void {
    this.pickFailures = 0;
    this.needHome = true;
  }

  private issue(cmd: number, target: number): void {
    this.seq = (this.seq % 65535) + 1;
    this.r[STATION.ARM_CMD] = cmd;
    this.r[STATION.ARM_CMD_SEQ] = this.seq;
    this.pending = { cmd, seq: this.seq, target };
  }
}
