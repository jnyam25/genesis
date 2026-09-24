/**
 * Tank color helpers shared by the mock engine and the color editor. Same rules
 * as twin/src/tank-colors.ts (the twin re-validates every edit).
 */

import { TANK_NAME_MAX_LENGTH, type TankColor } from "./types";

/** Default slot names/colors — same as the twin's config.TANK_SLOTS. */
export const DEFAULT_TANK_SLOTS: ({ id: string } & TankColor)[] = [
  { id: "T1", name: "Titanium White", colorCode: "#F4F1EA" },
  { id: "T2", name: "Cadmium Red", colorCode: "#C8362B" },
  { id: "T3", name: "Ultramarine Blue", colorCode: "#1F3A93" },
  { id: "T4", name: "Hansa Yellow", colorCode: "#F2C230" },
  { id: "T5", name: "Phthalo Green", colorCode: "#1F7A5A" },
  { id: "T6", name: "Carbon Black", colorCode: "#2B2B2B" },
  { id: "T7", name: "Quinacridone Magenta", colorCode: "#A4245E" },
  { id: "T8", name: "Burnt Sienna", colorCode: "#8A4B2A" },
];

/** Quick-pick swatches for the color editor (touch friendly). */
export const PRESET_COLORS = [
  "#F4F1EA", "#2B2B2B", "#C8362B", "#E8702A", "#F2C230", "#7CB342",
  "#1F7A5A", "#26A69A", "#1F3A93", "#5E35B1", "#A4245E", "#8A4B2A",
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Normalized patch, or an error message. */
export function validateTankColor(input: Partial<TankColor>): { patch: Partial<TankColor> } | { error: string } {
  const patch: Partial<TankColor> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length === 0) return { error: "name must not be empty" };
    if (name.length > TANK_NAME_MAX_LENGTH) return { error: `name must be at most ${TANK_NAME_MAX_LENGTH} characters` };
    patch.name = name;
  }
  if (input.colorCode !== undefined) {
    if (!HEX_COLOR.test(input.colorCode)) return { error: 'colorCode must be a hex color like "#C8362B"' };
    patch.colorCode = input.colorCode.toUpperCase();
  }
  return { patch };
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}
