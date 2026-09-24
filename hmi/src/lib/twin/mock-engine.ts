/**
 * Mock twin engine.
 *
 * Produces a live `TwinState` stream that mimics the real digital twin so the
 * HMI runs standalone before the engine is wired in. It advances containers
 * through the line (label → scan → fill bays → capping arm → sort sensor /
 * reject diverter → sort diverter → Lane A/B), drains/refills tanks, computes
 * OEE, and emits events.
 *
 * To demonstrate the DYNAMIC requirement, it starts with 3 tanks and adds a
 * 4th tank (slot T4) after ~25s — the frontend re-renders all three views
 * with no code change because everything is driven from `tanks[]`.
 *
 * Tanks use the twin's 8-slot model (T1..T8) with an editable name/color per
 * slot; saved edits are passed in and reported through `onColorsChange`.
 */

import type {
  Container,
  ContainerStatus,
  Counts,
  Oee,
  SortLane,
  Tank,
  TankColor,
  TwinEvent,
  TwinState,
} from "./types";
import { MockSafety } from "./safety";
import { DEFAULT_TANK_SLOTS, validateTankColor } from "./tank-colors";

interface Recipe {
  /** Dose in ml per tank id. */
  doses: Record<string, number>;
  targetMl: number;
}

interface SimContainer extends Container {
  recipe: Recipe;
  /** ms spent in current status. */
  dwell: number;
  /** Index of the next fill bay to visit (for fill-i sequencing). */
  nextNozzle: number;
  /** Barcode failed at scan: rides through unfilled to the reject diverter. */
  badBarcode: boolean;
}

const TANK_CAPACITY_ML = 5000;
const INITIAL_TANKS = 3;

const STATUS_DWELL_MS: Record<string, number> = {
  label: 1000,
  scan: 800,
  cap: 2000,
  qc: 1200,
  sort: 800,
};
const FILL_DWELL_MS = 900;
/** Bad-barcode containers report `qc` all the way from scan to the reject diverter. */
const BAD_BARCODE_TRANSIT_MS = 3500;
/** Finished containers stay visible at their output/reject lane this long. */
const COMPLETED_LINGER_MS = 1500;
const FINAL_STATUSES: ContainerStatus[] = ["output", "rejected", "scan-rejected"];
const REJECT_RATE = 0.06;
const SCAN_FAIL_RATE = 0.08;
const IDEAL_CPM = 12;

/** Same defaults as the twin (config.sort). */
const SORT_LANES = [
  { id: "A", name: "Lane A (small bottles)" },
  { id: "B", name: "Lane B (large bottles)" },
];
const SMALL_BOTTLE_MAX_ML = 250;

let eventCounter = 0;
function ev(
  severity: TwinEvent["severity"],
  message: string,
  at = Date.now(),
): TwinEvent {
  return { id: `e${++eventCounter}`, at, severity, message };
}

export class MockTwinEngine {
  /** Enabled tanks, in slot order. */
  private tanks: Tank[];
  /** Name/color per slot (index = slot - 1). */
  private palette: TankColor[];
  private containers: SimContainer[] = [];
  private counts: Counts = { accepted: 0, rejected: 0, total: 0 };
  /** Accepted containers per sort lane (index = SORT_LANES). */
  private laneCounts = SORT_LANES.map(() => 0);
  private oee: Oee = {
    availability: 1,
    performance: 0.92,
    quality: 1,
    overall: 0.92,
  };
  private throughputCpm = 0;
  private latestEvent: TwinEvent | null = null;
  /** Newest first, bounded — sent as recentEvents so no event is lost between polls. */
  private recent: TwinEvent[] = [];

  private get lastEvent(): TwinEvent | null {
    return this.latestEvent;
  }
  private set lastEvent(e: TwinEvent | null) {
    this.latestEvent = e;
    if (e) this.recent = [e, ...this.recent].slice(0, 20);
  }
  private lastSpawn = 0;
  private spawnCounter = 0;
  private lastTick = Date.now();
  private startedAt = Date.now();
  private fourthTankAdded = false;
  private downtimeUntil = 0;
  /** E-Stops, safety circuit, local/remote control (same rules as the twin). */
  private safety = new MockSafety((severity, message) => {
    this.lastEvent = ev(severity, message);
  });
  private completionsInLastMinute: number[] = [];

  /**
   * @param savedColors    operator edits keyed by slot id (`{ T2: { name, colorCode } }`)
   * @param onColorsChange called with the edited slots after every change (persist here)
   */
  constructor(
    savedColors: Record<string, Partial<TankColor>> = {},
    private readonly onColorsChange?: (edited: Record<string, TankColor>) => void,
  ) {
    this.palette = DEFAULT_TANK_SLOTS.map((d) => {
      const saved = validateTankColor(savedColors[d.id] ?? {});
      return { name: d.name, colorCode: d.colorCode, ...("patch" in saved ? saved.patch : {}) };
    });
    this.tanks = DEFAULT_TANK_SLOTS.slice(0, INITIAL_TANKS).map((d) => this.newTank(d.id));
    this.lastEvent = ev("success", `Line started — ${INITIAL_TANKS} tanks online`);
  }

  private slotIndex(tankId: string): number {
    return DEFAULT_TANK_SLOTS.findIndex((d) => d.id === tankId);
  }

  private newTank(id: string): Tank {
    return { id, ...this.palette[this.slotIndex(id)], capacityMl: TANK_CAPACITY_ML, levelMl: Math.round(TANK_CAPACITY_ML * 0.85) };
  }

  /** Enable a slot, keeping tanks in slot order (= fill bay order). */
  private enableSlot(id: string): Tank {
    const tank = this.newTank(id);
    const at = this.tanks.filter((t) => this.slotIndex(t.id) < this.slotIndex(id)).length;
    this.tanks.splice(at, 0, tank);
    return tank;
  }

  private colorsChanged() {
    for (const t of this.tanks) Object.assign(t, this.palette[this.slotIndex(t.id)]);
    const edited: Record<string, TankColor> = {};
    DEFAULT_TANK_SLOTS.forEach((d, i) => {
      const p = this.palette[i];
      if (p.name !== d.name || p.colorCode !== d.colorCode) edited[d.id] = { ...p };
    });
    this.onColorsChange?.(edited);
  }

  /** Advance simulation by wall-clock delta and return a fresh snapshot. */
  tick(now: number): TwinState {
    const dt = Math.min(now - this.lastTick, 1000);
    this.lastTick = now;

    this.maybeAddFourthTank(now);
    this.spawnContainers(now);
    // While stopped or E-Stopped the line is frozen: no container advancement.
    if (this.safety.lineEnabled) this.advanceContainers(now, dt);
    this.refillTanks(dt);
    this.updateOee(now);
    this.pruneCompletions(now);

    return this.snapshot(now);
  }

  // ---- Operator command API (used by the Manual/Jog screen) ----
  // Each returns null on success or the refusal message.

  eStop(): string | null {
    return this.safety.pressDigitalEStop();
  }

  releaseEStop(): string | null {
    return this.safety.releaseDigitalEStop();
  }

  reset(source: "local" | "remote" = "remote"): string | null {
    return this.safety.reset(source);
  }

  start(source: "local" | "remote" = "remote"): string | null {
    return this.safety.start(source);
  }

  stop(source: "local" | "remote" = "remote"): string | null {
    return this.safety.stop(source);
  }

  setControlMode(mode: "local" | "remote"): string | null {
    return this.safety.setMode(mode);
  }

  setPhysicalEStop(buttonId: string, pressed: boolean): string | null {
    return this.safety.setPhysicalEStop(buttonId, pressed);
  }

  jogBelt(source: "local" | "remote" = "remote"): string | null {
    const refused = this.safety.check("jog", source);
    if (refused) return refused;
    this.lastEvent = ev("info", `Manual: belt jog (${source})`);
    return null;
  }

  firePusher(): string | null {
    const refused = this.safety.check("firePusher", "remote");
    if (refused) return refused;
    const target = this.containers.find((c) => c.status === "qc");
    if (!target) {
      this.lastEvent = ev("warn", "Manual: reject diverter fired — no container at the sort sensor or reject diverter");
      return null;
    }
    this.lastEvent = ev("warn", `Manual: reject diverter fired on ${target.id}`);
    this.reject(target, target.badBarcode ? "scan-rejected" : "rejected", "manual reject (reject diverter)", Date.now());
    return null;
  }

  addTank(color?: Partial<TankColor>): string | null {
    const checked = validateTankColor(color ?? {});
    if ("error" in checked) return checked.error;
    const refused = this.safety.check("tankChange", "remote");
    if (refused) return refused;
    const free = DEFAULT_TANK_SLOTS.find((d) => !this.tanks.some((t) => t.id === d.id));
    if (!free) return "all tank slots are already enabled";
    Object.assign(this.palette[this.slotIndex(free.id)], checked.patch);
    if (Object.keys(checked.patch).length > 0) this.colorsChanged();
    const tank = this.enableSlot(free.id);
    this.lastEvent = ev(
      "warn",
      `Manual: tank ${tank.id} (${tank.name}) added — line re-balanced to ${this.tanks.length} tanks`,
    );
    return null;
  }

  setTankColor(tankId: string, color: Partial<TankColor>): string | null {
    const slot = this.slotIndex(tankId);
    if (slot < 0) return `unknown tank ${tankId}`;
    const checked = validateTankColor(color);
    if ("error" in checked) return checked.error;
    if (Object.keys(checked.patch).length === 0) return "give a name and/or colorCode";
    Object.assign(this.palette[slot], checked.patch);
    this.colorsChanged();
    return null;
  }

  resetTankColor(tankId?: string): string | null {
    const slots = tankId === undefined ? DEFAULT_TANK_SLOTS.map((_, i) => i) : [this.slotIndex(tankId)];
    if (slots[0] < 0) return `unknown tank ${tankId}`;
    for (const i of slots) this.palette[i] = { name: DEFAULT_TANK_SLOTS[i].name, colorCode: DEFAULT_TANK_SLOTS[i].colorCode };
    this.colorsChanged();
    return null;
  }

  removeTank(tankId: string): string | null {
    const refused = this.safety.check("tankChange", "remote");
    if (refused) return refused;
    if (this.tanks.length <= 1) {
      this.lastEvent = ev("warn", "Manual: cannot remove the last tank");
      return "cannot remove the last tank";
    }
    const t = this.tanks.find((x) => x.id === tankId);
    if (!t) return `tank ${tankId} not found`;
    this.tanks = this.tanks.filter((x) => x.id !== tankId);
    this.lastEvent = ev(
      "warn",
      `Manual: tank ${t.id} (${t.name}) removed — line re-balanced to ${this.tanks.length} tanks`,
    );
    return null;
  }

  private maybeAddFourthTank(now: number) {
    if (this.fourthTankAdded || now - this.startedAt <= 25_000) return;
    this.fourthTankAdded = true;
    const id = DEFAULT_TANK_SLOTS[INITIAL_TANKS].id;
    if (this.tanks.some((t) => t.id === id)) return;
    const tank = this.enableSlot(id);
    this.lastEvent = ev("warn", `Tank ${tank.id} (${tank.name}) added to line config — re-balancing fill bays`, now);
  }

  private spawnContainers(now: number) {
    if (now - this.lastSpawn < 2600) return;
    if (this.downtimeUntil > now) return;
    if (!this.safety.lineEnabled) return;
    this.lastSpawn = now;

    this.spawnCounter += 1;
    const id = `C-${String(this.spawnCounter).padStart(4, "0")}`;
    const recipe = this.randomRecipe();
    this.containers.push({
      id,
      status: "label",
      fillMl: 0,
      targetMl: recipe.targetMl,
      lane: recipe.targetMl <= SMALL_BOTTLE_MAX_ML ? 0 : 1,
      recipe,
      dwell: 0,
      nextNozzle: 0,
      badBarcode: false,
    });
    this.lastEvent = ev("info", `${id} entered labeling station`, now);
  }

  /** Picks a bottle size first so both sort lanes see traffic. */
  private randomRecipe(): Recipe {
    const small = Math.random() < 0.5;
    const totalMl = small ? 150 + Math.random() * 90 : 300 + Math.random() * 180;
    const weights = this.tanks.map(() => 0.5 + Math.random());
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const doses: Record<string, number> = {};
    let total = 0;
    this.tanks.forEach((tank, i) => {
      const d = Math.round((totalMl * weights[i]) / weightSum);
      doses[tank.id] = d;
      total += d;
    });
    return { doses, targetMl: total };
  }

  private dwellMs(c: SimContainer): number {
    if (c.status === "qc" && c.badBarcode) return BAD_BARCODE_TRANSIT_MS;
    return STATUS_DWELL_MS[c.status] ?? FILL_DWELL_MS;
  }

  private advanceContainers(now: number, dt: number) {
    for (const c of this.containers) {
      c.dwell += dt;
      if (FINAL_STATUSES.includes(c.status)) continue;
      if (c.dwell < this.dwellMs(c)) continue;
      c.dwell = 0;
      this.transition(c, now);
    }
    this.containers = this.containers.filter(
      (c) => !(FINAL_STATUSES.includes(c.status) && c.dwell > COMPLETED_LINGER_MS),
    );
  }

  private reject(c: SimContainer, status: "rejected" | "scan-rejected", reason: string, now: number) {
    c.status = status;
    c.dwell = 0;
    this.counts.rejected += 1;
    this.counts.total += 1;
    this.lastEvent = ev("error", `${c.id} REJECTED at reject diverter — ${reason}`, now);
  }

  private toFillOrCap(c: SimContainer, now: number) {
    if (c.nextNozzle < this.tanks.length) {
      c.status = `fill-${c.nextNozzle + 1}` as ContainerStatus;
      this.lastEvent = ev("info", `${c.id} at Fill Bay ${c.nextNozzle + 1}`, now);
    } else {
      c.status = "cap";
      this.lastEvent = ev("info", `${c.id} → capping arm`, now);
    }
  }

  private transition(c: SimContainer, now: number) {
    switch (c.status) {
      case "label":
        c.status = "scan";
        return;
      case "scan": {
        // A failed scan (bad/no barcode) has no recipe: there is no scan
        // diverter, so the container rides through unfilled and is rejected
        // at the reject diverter.
        if (Math.random() < SCAN_FAIL_RATE) {
          c.badBarcode = true;
          c.status = "qc";
          c.targetMl = 0;
          c.lane = undefined;
          this.lastEvent = ev(
            "warn",
            `${c.id} barcode unreadable — riding through unfilled to the reject diverter`,
            now,
          );
        } else {
          this.toFillOrCap(c, now);
        }
        return;
      }
      case "cap":
        c.status = "qc";
        this.lastEvent = ev("info", `${c.id} lid placed → sort sensor`, now);
        return;
      case "qc":
        if (c.badBarcode) this.reject(c, "scan-rejected", "bad barcode", now);
        else if (Math.random() < REJECT_RATE) this.reject(c, "rejected", "fill out of tolerance", now);
        else c.status = "sort";
        return;
      case "sort": {
        const lane = c.lane ?? 0;
        c.status = "output";
        this.counts.accepted += 1;
        this.counts.total += 1;
        this.laneCounts[lane] += 1;
        this.completionsInLastMinute.push(now);
        this.lastEvent = ev("success", `${c.id} accepted → ${SORT_LANES[lane].name}`, now);
        return;
      }
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
      this.toFillOrCap(c, now);
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
    // Availability: 0 while stopped/E-Stopped or during a micro-stop window.
    const availability = !this.safety.lineEnabled || now < this.downtimeUntil ? 0 : 1;
    // Occasionally schedule a short micro-stop to make availability move
    // (but never while stopped — that is operator-controlled).
    if (this.safety.lineEnabled && Math.random() < 0.0008 && this.downtimeUntil < now) {
      this.downtimeUntil = now + 4000;
      this.lastEvent = ev("warn", "Micro-stop: fill bay changeover (4s)", now);
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

  private sortLanes(): SortLane[] {
    return SORT_LANES.map((l, i) => ({ ...l, count: this.laneCounts[i] }));
  }

  private snapshot(now: number): TwinState {
    return {
      tanks: this.tanks.map((t) => ({ ...t, levelMl: Math.round(t.levelMl) })),
      tankSlots: DEFAULT_TANK_SLOTS.map((d, i) => ({
        id: d.id,
        ...this.palette[i],
        enabled: this.tanks.some((t) => t.id === d.id),
        custom: this.palette[i].name !== d.name || this.palette[i].colorCode !== d.colorCode,
      })),
      containers: this.containers.map((c) => ({
        id: c.id,
        status: c.status,
        fillMl: Math.round(c.fillMl),
        targetMl: c.targetMl,
        lane: c.lane,
      })),
      counts: { ...this.counts },
      sortLanes: this.sortLanes(),
      throughputCpm: this.throughputCpm,
      oee: {
        availability: round(this.oee.availability),
        performance: round(this.oee.performance),
        quality: round(this.oee.quality),
        overall: round(this.oee.overall),
      },
      lastEvent: this.lastEvent,
      recentEvents: this.recent,
      safety: this.safety.state(),
      timestamp: now,
      connected: true,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
