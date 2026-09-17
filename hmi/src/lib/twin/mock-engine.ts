/**
 * Mock twin engine.
 *
 * Produces a live `TwinState` stream that mimics the real digital twin so the
 * HMI runs standalone before the engine is wired in. It advances containers
 * through the line, drains/refills tanks, computes OEE, and emits events.
 *
 * To demonstrate the DYNAMIC requirement, it starts with 3 tanks and adds a
 * 4th tank ("Yellow") after ~25s — the frontend re-renders all three views
 * with no code change because everything is driven from `tanks[]`.
 */

import type {
  Container,
  ContainerStatus,
  Counts,
  Oee,
  Tank,
  TwinEvent,
  TwinState,
} from "./types";

interface Recipe {
  /** Dose in ml per tank id. */
  doses: Record<string, number>;
  targetMl: number;
}

interface SimContainer extends Container {
  recipe: Recipe;
  /** ms spent in current status. */
  dwell: number;
  /** Index of the next nozzle to visit (for fill-i sequencing). */
  nextNozzle: number;
}

const TANK_DEFS_3 = [
  { id: "tank-red", name: "Red", colorCode: "#e53935", capacityMl: 5000 },
  { id: "tank-green", name: "Green", colorCode: "#43a047", capacityMl: 5000 },
  { id: "tank-blue", name: "Blue", colorCode: "#1e88e5", capacityMl: 5000 },
];
const TANK_DEFS_4 = [
  ...TANK_DEFS_3,
  { id: "tank-yellow", name: "Yellow", colorCode: "#fdd835", capacityMl: 5000 },
];

/** Extra colors for tanks added on demand via the Manual/Jog screen. */
const EXTRA_TANK_COLORS = [
  { name: "Cyan", colorCode: "#26c6da" },
  { name: "Magenta", colorCode: "#ec407a" },
  { name: "Orange", colorCode: "#fb8c00" },
  { name: "Violet", colorCode: "#8e24aa" },
  { name: "Teal", colorCode: "#00897b" },
];

const STATUS_DWELL_MS: Record<string, number> = {
  scan: 1200,
  "scan-rejected": 1400,
  mix: 1800,
  qc: 1400,
  output: 1000,
  rejected: 1500,
};
const FILL_DWELL_MS = 900;
const REJECT_RATE = 0.06;
const SCAN_FAIL_RATE = 0.08;
const IDEAL_CPM = 12;

let eventCounter = 0;
function ev(
  severity: TwinEvent["severity"],
  message: string,
  at = Date.now(),
): TwinEvent {
  return { id: `e${++eventCounter}`, at, severity, message };
}

export class MockTwinEngine {
  private tanks: Tank[];
  private containers: SimContainer[] = [];
  private counts: Counts = { accepted: 0, rejected: 0, total: 0 };
  private oee: Oee = {
    availability: 1,
    performance: 0.92,
    quality: 1,
    overall: 0.92,
  };
  private throughputCpm = 0;
  private lastEvent: TwinEvent | null = null;
  private lastSpawn = 0;
  private spawnCounter = 0;
  private lastTick = Date.now();
  private startedAt = Date.now();
  private fourthTankAdded = false;
  private downtimeUntil = 0;
  /** Latched E-Stop — line stays halted until explicitly cleared. */
  private eStopped = false;
  private completionsInLastMinute: number[] = [];

  constructor() {
    this.tanks = TANK_DEFS_3.map((t) => ({
      ...t,
      levelMl: Math.round(t.capacityMl * 0.85),
    }));
    this.lastEvent = ev("success", "Line started — 3 tanks online");
  }

  /** Advance simulation by wall-clock delta and return a fresh snapshot. */
  tick(now: number): TwinState {
    const dt = Math.min(now - this.lastTick, 1000);
    this.lastTick = now;

    this.maybeAddFourthTank(now);
    this.spawnContainers(now);
    // While E-Stopped the line is frozen: no container advancement.
    if (!this.eStopped) this.advanceContainers(now, dt);
    this.refillTanks(dt);
    this.updateOee(now);
    this.pruneCompletions(now);

    return this.snapshot(now);
  }

  // ---- Operator command API (used by the Manual/Jog screen) ----

  jogBelt(): void {
    this.lastEvent = ev("info", "Manual: belt jog");
  }

  firePusher(): void {
    this.lastEvent = ev("warn", "Manual: reject pusher fired");
  }

  addTank(): void {
    const used = new Set(this.tanks.map((t) => t.colorCode));
    const def = EXTRA_TANK_COLORS.find((c) => !used.has(c.colorCode));
    if (!def) {
      this.lastEvent = ev("warn", "Manual: no more tank color slots available");
      return;
    }
    const id = `tank-${def.name.toLowerCase()}`;
    if (this.tanks.some((t) => t.id === id)) {
      this.lastEvent = ev("warn", `Manual: tank ${def.name} already exists`);
      return;
    }
    this.tanks.push({
      id,
      name: def.name,
      colorCode: def.colorCode,
      capacityMl: 5000,
      levelMl: Math.round(5000 * 0.85),
    });
    this.lastEvent = ev(
      "warn",
      `Manual: tank ${def.name} added — line re-balanced to ${this.tanks.length} tanks`,
    );
  }

  removeTank(tankId: string): void {
    if (this.tanks.length <= 1) {
      this.lastEvent = ev("warn", "Manual: cannot remove the last tank");
      return;
    }
    const t = this.tanks.find((x) => x.id === tankId);
    if (!t) return;
    this.tanks = this.tanks.filter((x) => x.id !== tankId);
    this.lastEvent = ev(
      "warn",
      `Manual: tank ${t.name} removed — line re-balanced to ${this.tanks.length} tanks`,
    );
  }

  eStop(): void {
    this.eStopped = true;
    this.lastEvent = ev("error", "E-STOP triggered — line halted (latched)");
  }

  clearEStop(): void {
    if (!this.eStopped) return;
    this.eStopped = false;
    this.lastEvent = ev("success", "E-STOP cleared — line resumed");
  }

  private maybeAddFourthTank(now: number) {
    if (!this.fourthTankAdded && now - this.startedAt > 25_000) {
      this.fourthTankAdded = true;
      const def = TANK_DEFS_4[3];
      this.tanks.push({ ...def, levelMl: Math.round(def.capacityMl * 0.85) });
      this.lastEvent = ev(
        "warn",
        "Tank 4 (Yellow) added to line config — re-balancing nozzles",
        now,
      );
    }
  }

  private spawnContainers(now: number) {
    if (now - this.lastSpawn < 2600) return;
    if (this.downtimeUntil > now) return;
    if (this.eStopped) return;
    this.lastSpawn = now;

    this.spawnCounter += 1;
    const id = `C-${String(this.spawnCounter).padStart(4, "0")}`;
    const recipe = this.randomRecipe();
    this.containers.push({
      id,
      status: "scan",
      fillMl: 0,
      targetMl: recipe.targetMl,
      recipe,
      dwell: 0,
      nextNozzle: 0,
    });
    this.lastEvent = ev("info", `${id} entered scan zone`, now);
  }

  private randomRecipe(): Recipe {
    const doses: Record<string, number> = {};
    let total = 0;
    for (const tank of this.tanks) {
      const d = Math.round(40 + Math.random() * 120);
      doses[tank.id] = d;
      total += d;
    }
    return { doses, targetMl: total };
  }

  private advanceContainers(now: number, dt: number) {
    for (const c of this.containers) {
      c.dwell += dt;
      const needed = STATUS_DWELL_MS[c.status] ?? FILL_DWELL_MS;
      if (c.dwell < needed) continue;
      c.dwell = 0;
      this.transition(c, now);
    }
    // Drop containers that have left output/reject
    this.containers = this.containers.filter((c) => {
      if (c.status === "output" && c.dwell === 0) {
        // just transitioned away — keep one more tick then remove
        return true;
      }
      return true;
    });
    this.containers = this.containers.filter(
      (c) =>
        !(c.status === "output" && c.dwell > 400) &&
        !(c.status === "rejected" && c.dwell > 600) &&
        !(c.status === "scan-rejected" && c.dwell > 1500),
    );
  }

  private transition(c: SimContainer, now: number) {
    switch (c.status) {
      case "scan": {
        // Scan resolves the recipe. A failed scan (bad/no barcode) cannot be
        // filled, so the container is rerouted to the scan-reject lane and
        // never reaches the nozzles.
        const scanFail = Math.random() < SCAN_FAIL_RATE;
        if (scanFail) {
          c.status = "scan-rejected";
          c.dwell = 0;
          this.counts.rejected += 1;
          this.counts.total += 1;
          this.lastEvent = ev(
            "error",
            `${c.id} SCAN FAIL — no recipe, rerouted to scan-reject lane`,
            now,
          );
        } else {
          c.status = `fill-${c.nextNozzle + 1}` as ContainerStatus;
          c.dwell = 0;
          this.lastEvent = ev(
            "info",
            `${c.id} at Nozzle ${c.nextNozzle + 1}`,
            now,
          );
        }
        return;
      }
      case "mix":
        c.status = "qc";
        this.lastEvent = ev("info", `${c.id} → QC`, now);
        return;
      case "qc": {
        const reject = Math.random() < REJECT_RATE;
        if (reject) {
          c.status = "rejected";
          this.counts.rejected += 1;
          this.counts.total += 1;
          this.lastEvent = ev("error", `${c.id} REJECTED — color out of spec`, now);
        } else {
          c.status = "output";
          this.counts.accepted += 1;
          this.counts.total += 1;
          this.completionsInLastMinute.push(now);
          this.lastEvent = ev("success", `${c.id} accepted → output`, now);
        }
        return;
      }
      case "output":
      case "rejected":
        return; // will be pruned
    }

    // fill-i states
    const m = /^fill-(\d+)$/.exec(c.status);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      const tank = this.tanks[idx];
      if (tank) {
        const dose = c.recipe.doses[tank.id] ?? 0;
        const drawn = Math.min(dose, tank.levelMl);
        tank.levelMl = Math.max(0, tank.levelMl - drawn);
        c.fillMl += drawn;
      }
      c.nextNozzle += 1;
      if (c.nextNozzle < this.tanks.length) {
        c.status = `fill-${c.nextNozzle + 1}` as ContainerStatus;
      } else {
        c.status = "mix";
        this.lastEvent = ev("info", `${c.id} → mix station`, now);
      }
    }
  }

  private refillTanks(dt: number) {
    const refillRate = 6; // ml per tick (~per 100ms)
    for (const tank of this.tanks) {
      if (tank.levelMl < tank.capacityMl * 0.25) {
        tank.levelMl = Math.min(
          tank.capacityMl,
          tank.levelMl + refillRate * (dt / 100),
        );
      }
    }
  }

  private pruneCompletions(now: number) {
    const cutoff = now - 60_000;
    this.completionsInLastMinute = this.completionsInLastMinute.filter(
      (t) => t >= cutoff,
    );
    this.throughputCpm = this.completionsInLastMinute.length;
  }

  private updateOee(now: number) {
    // Availability: 0 while E-Stopped (latched) or during a micro-stop window.
    const availability = this.eStopped || now < this.downtimeUntil ? 0 : 1;
    // Occasionally schedule a short micro-stop to make availability move
    // (but never while E-Stopped — that is operator-controlled).
    if (!this.eStopped && Math.random() < 0.0008 && this.downtimeUntil < now) {
      this.downtimeUntil = now + 4000;
      this.lastEvent = ev("warn", "Micro-stop: nozzle changeover (4s)", now);
    }
    const performance = Math.min(
      1,
      0.85 + (this.throughputCpm / IDEAL_CPM) * 0.15 + (Math.random() - 0.5) * 0.02,
    );
    const quality =
      this.counts.total > 0
        ? this.counts.accepted / this.counts.total
        : 1;
    const overall = availability * performance * quality;
    this.oee = {
      availability,
      performance: Math.max(0, performance),
      quality,
      overall,
    };
  }

  private snapshot(now: number): TwinState {
    return {
      tanks: this.tanks.map((t) => ({ ...t, levelMl: Math.round(t.levelMl) })),
      containers: this.containers.map((c) => ({
        id: c.id,
        status: c.status,
        fillMl: Math.round(c.fillMl),
        targetMl: c.targetMl,
      })),
      counts: { ...this.counts },
      throughputCpm: this.throughputCpm,
      oee: {
        availability: round(this.oee.availability),
        performance: round(this.oee.performance),
        quality: round(this.oee.quality),
        overall: round(this.oee.overall),
      },
      lastEvent: this.lastEvent,
      timestamp: now,
      connected: true,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
