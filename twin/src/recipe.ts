/**
 * mix_sequence — turning per-tank volumes into an ordered dispense plan.
 *
 * The barcode gives us "how many ml from each tank". The mix_sequence layer
 * decides the ORDER in which those mls are dispensed, supporting layered and
 * interleaved dispensing instead of a single flat pass per tank.
 *
 * A `MixStep` is one dispense action: which tank, how many ml, and its order
 * index in the overall sequence. `buildDispensePlan` produces the full ordered
 * list from a parsed barcode + a `MixPolicy`:
 *
 *   - sequential: dispense each tank's full volume, one tank at a time, in
 *     config order. Layered (bottom-up) fills.
 *   - interleaved: split each tank's volume into `rounds` equal sub-volumes
 *     and emit them round-robin across tanks. Produces interleaved/stratified
 *     fills — useful for suspensions that settle or for gradient effects.
 *
 * Adding a tank never touches this code: it operates on whatever
 * `perTankMl.length` the barcode carries.
 */

import type { MixPolicy } from "./config";
import type { ParsedBarcode } from "./barcode";

export interface MixStep {
  /** 0-based index into config.tanks / parsed.perTankMl. */
  tankIndex: number;
  /** Milliliters to dispense in this step. */
  volumeMl: number;
  /** Order index (0-based) of this step in the overall sequence. */
  order: number;
}

export interface DispensePlan {
  steps: MixStep[];
  totalMl: number;
  /** Effective policy used to build the plan (config policy, or barcode override). */
  policy: MixPolicy;
}

export function buildDispensePlan(
  parsed: ParsedBarcode,
  configPolicy: MixPolicy,
): DispensePlan {
  const policy: MixPolicy =
    parsed.interleaveRounds != null
      ? { kind: "interleaved", rounds: parsed.interleaveRounds }
      : configPolicy;

  const steps: MixStep[] = [];
  const perTank = parsed.perTankMl;

  if (policy.kind === "sequential") {
    let order = 0;
    for (let t = 0; t < perTank.length; t++) {
      const v = perTank[t];
      if (v <= 0) continue;
      steps.push({ tankIndex: t, volumeMl: v, order: order++ });
    }
    return { steps, totalMl: parsed.totalMl, policy };
  }

  // interleaved
  const rounds = Math.max(1, policy.rounds);
  // base sub-volume per round, plus a remainder distributed to the first rounds.
  const subVolumes = perTank.map((v) => {
    const base = Math.floor((v / rounds) * 1000) / 1000; // 3-decimal ml precision
    const remainder = Math.round((v - base * rounds) * 1000) / 1000;
    const arr = new Array(rounds).fill(base);
    let r = remainder;
    for (let i = 0; i < rounds && r > 0.0005; i++) {
      const add = Math.min(r, 0.001);
      arr[i] = Math.round((arr[i] + add) * 1000) / 1000;
      r = Math.round((r - add) * 1000) / 1000;
    }
    return arr;
  });

  let order = 0;
  for (let r = 0; r < rounds; r++) {
    for (let t = 0; t < perTank.length; t++) {
      const v = subVolumes[t][r];
      if (v <= 0.0005) continue;
      steps.push({ tankIndex: t, volumeMl: Math.round(v * 1000) / 1000, order: order++ });
    }
  }
  return { steps, totalMl: parsed.totalMl, policy };
}

/**
 * Physical dispense order for a linear line with one bay per tank.
 *
 * A container on a one-way conveyor passes each bay exactly once, so it cannot
 * return to BAY-1 after BAY-3. This collapses any plan into one step per tank,
 * in belt (tank index) order, with that tank's total volume. Interleaved plans
 * therefore dispense sequentially on this layout; the plan's round-robin order
 * only becomes physical with a multi-nozzle manifold at a single station.
 */
export function beltOrderSteps(plan: DispensePlan): MixStep[] {
  const perTank = new Map<number, number>();
  for (const step of plan.steps) {
    perTank.set(step.tankIndex, (perTank.get(step.tankIndex) ?? 0) + step.volumeMl);
  }
  return [...perTank.entries()]
    .filter(([, v]) => v > 0.0005)
    .sort(([a], [b]) => a - b)
    .map(([tankIndex, v], order) => ({ tankIndex, volumeMl: Math.round(v * 1000) / 1000, order }));
}
