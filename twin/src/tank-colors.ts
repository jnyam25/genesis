/**
 * Tank color palette — the operator-editable name and swatch color of each
 * tank slot.
 *
 * The line has MAX_TANKS fixed slots (T1..T8, one PLC register block each).
 * Which slots are enabled is line state (PLC / core); what each slot is called
 * and what color it shows is presentation data owned by the Pi, so it lives
 * here and never goes over Modbus. Defaults come from `config.TANK_SLOTS`;
 * operator edits are kept as overrides and persisted by the caller (run.ts
 * writes them to a JSON file).
 */

import * as fs from "fs";
import * as path from "path";

import { MAX_TANKS, TANK_SLOTS, tankSlot } from "./config";

export interface TankColor {
  name: string;
  colorCode: string;
}

/** One palette slot as shown to the HMI. */
export interface TankColorSlot extends TankColor {
  id: string;
  /** Differs from the built-in default for this slot. */
  custom: boolean;
}

export const TANK_NAME_MAX_LENGTH = 24;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate a (partial) color edit. Returns the normalized patch (trimmed name,
 * upper-case hex) or an error message.
 */
export function validateTankColor(input: { name?: unknown; colorCode?: unknown }): { patch: Partial<TankColor> } | { error: string } {
  const patch: Partial<TankColor> = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string") return { error: "name must be a string" };
    const name = input.name.trim();
    if (name.length === 0) return { error: "name must not be empty" };
    if (name.length > TANK_NAME_MAX_LENGTH) return { error: `name must be at most ${TANK_NAME_MAX_LENGTH} characters` };
    if (/[\u0000-\u001f\u007f]/.test(name)) return { error: "name must not contain control characters" };
    patch.name = name;
  }
  if (input.colorCode !== undefined) {
    if (typeof input.colorCode !== "string" || !HEX_COLOR.test(input.colorCode)) {
      return { error: 'colorCode must be a hex color like "#C8362B"' };
    }
    patch.colorCode = input.colorCode.toUpperCase();
  }
  return { patch };
}

export class TankPalette {
  private readonly entries: TankColor[];

  /**
   * @param overrides saved edits keyed by tank id (`{ "T2": { name, colorCode } }`); invalid entries are ignored
   * @param onChange  called after every successful edit (persist here)
   */
  constructor(
    overrides: Record<string, Partial<TankColor>> = {},
    private readonly onChange?: (palette: TankPalette) => void,
  ) {
    this.entries = TANK_SLOTS.map((t) => ({ name: t.name, colorCode: t.colorCode }));
    for (const [id, value] of Object.entries(overrides)) {
      const slot = tankSlot(id);
      const result = validateTankColor(value ?? {});
      if (slot !== null && "patch" in result) Object.assign(this.entries[slot - 1], result.patch);
    }
  }

  /** Color of a tank slot by id (`T3`), or undefined for a non-slot id. */
  get(tankId: string): TankColor | undefined {
    const slot = tankSlot(tankId);
    return slot === null ? undefined : { ...this.entries[slot - 1] };
  }

  /** Apply a validated edit. Returns an error message, or null on success. */
  set(tankId: string, input: { name?: unknown; colorCode?: unknown }): string | null {
    const slot = tankSlot(tankId);
    if (slot === null) return `unknown tank ${JSON.stringify(tankId)}; expected T1..T${MAX_TANKS}`;
    const result = validateTankColor(input);
    if ("error" in result) return result.error;
    if (result.patch.name === undefined && result.patch.colorCode === undefined) return "give a name and/or colorCode";
    Object.assign(this.entries[slot - 1], result.patch);
    this.onChange?.(this);
    return null;
  }

  /** Restore one slot (or every slot when tankId is omitted) to its default. */
  reset(tankId?: string): string | null {
    const slots = tankId === undefined ? TANK_SLOTS.map((_, i) => i + 1) : [tankSlot(tankId)];
    if (slots[0] === null) return `unknown tank ${JSON.stringify(tankId)}; expected T1..T${MAX_TANKS}`;
    for (const slot of slots as number[]) {
      const def = TANK_SLOTS[slot - 1];
      this.entries[slot - 1] = { name: def.name, colorCode: def.colorCode };
    }
    this.onChange?.(this);
    return null;
  }

  /** Every slot, in slot order. */
  slots(): TankColorSlot[] {
    return this.entries.map((e, i) => {
      const def = TANK_SLOTS[i];
      return { id: def.id, ...e, custom: e.name !== def.name || e.colorCode.toUpperCase() !== def.colorCode.toUpperCase() };
    });
  }

  /** Only the edited slots — what gets persisted. */
  overrides(): Record<string, TankColor> {
    const out: Record<string, TankColor> = {};
    for (const s of this.slots()) if (s.custom) out[s.id] = { name: s.name, colorCode: s.colorCode };
    return out;
  }
}

/** Read saved overrides. A missing file means no edits; an unreadable one is reported and ignored. */
export function loadTankColors(file: string): Record<string, Partial<TankColor>> {
  if (!fs.existsSync(file)) return {};
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, Partial<TankColor>>;
    throw new Error("expected an object keyed by tank id");
  } catch (err) {
    console.warn(`[captsone] ignoring tank colors file ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function saveTankColors(file: string, palette: TankPalette): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(palette.overrides(), null, 2));
  fs.renameSync(tmp, file);
}
