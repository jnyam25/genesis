import type { TwinConfig } from "./config";

/**
 * Line metrics used by the twin core (and so the virtual PLC), specified for
 * the Micro850 PLC in docs/prototype/micro850-plc.md §8, so the simulator and
 * the physical line report identical numbers.
 */

export interface Oee {
  availability: number;
  performance: number;
  quality: number;
  overall: number;
}

/**
 * Standard OEE from elapsed time, downtime (blocked or halted), an ideal cycle
 * time, and completion counts. Values are clamped to [0, 1] and rounded to 3
 * decimals for stable transport.
 */
export function computeOee(args: {
  elapsedSec: number;
  downtimeSec: number;
  idealCycleSec: number;
  accepted: number;
  total: number;
}): Oee {
  const { elapsedSec, downtimeSec, idealCycleSec, accepted, total } = args;
  const operatingSec = Math.max(1, elapsedSec - downtimeSec);
  const availability = clamp01(1 - downtimeSec / Math.max(1, elapsedSec));
  const performance = clamp01((idealCycleSec * total) / operatingSec);
  const quality = total > 0 ? accepted / total : 0;
  return {
    availability: round3(availability),
    performance: round3(performance),
    quality: round3(quality),
    overall: round3(availability * performance * quality),
  };
}

/**
 * Ideal cycle time (s) used for OEE performance: the service time of every
 * non-dispense station on the line + an average dispense (5% of tank
 * capacity), plus belt transit across all stations.
 */
export function idealCycleSec(config: TwinConfig): number {
  const avgDispense =
    config.tanks.reduce((a, t) => a + (t.capacityMl * 0.05) / t.dispenseRateMlPerSec, 0) /
    Math.max(1, config.tanks.length);
  const t = config.stationTimesSec;
  const serviceSec: Record<string, number> = {
    LABEL: t.label,
    SCAN: t.scan,
    MIX: config.mixDurationSec,
    CAP: t.cap,
    PRESS: t.press,
    QC: t.qc,
    GATE: t.gate,
    SORT: t.sort,
  };
  const stationsSec = config.stations.reduce((a, s) => a + (serviceSec[s.id] ?? 0), 0);
  const transit = config.stationSpacingM / config.beltSpeedMPerSec;
  return stationsSec + avgDispense + transit * (config.stations.length - 1);
}

/** Events per minute over a rolling window. */
export class RollingRate {
  private times: number[] = [];

  constructor(private readonly windowSec: number) {}

  record(timeSec: number): void {
    this.times.push(timeSec);
  }

  /**
   * Rate per minute at `nowSec`. Early in a run the elapsed time is used
   * instead of the full window (with a 10 s floor so the first event does not
   * read as a spike).
   */
  perMinute(nowSec: number): number {
    const cutoff = nowSec - this.windowSec;
    while (this.times.length && this.times[0] < cutoff) this.times.shift();
    const spanSec = Math.max(10, Math.min(this.windowSec, nowSec));
    return Math.round(((this.times.length * 60) / spanSec) * 100) / 100;
  }
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
