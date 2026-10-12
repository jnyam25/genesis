/**
 * Tank color helpers shared by the mock engine and the color editor. Same rules
 * as twin/src/tank-colors.ts (the twin re-validates every edit).
 */

import { TANK_NAME_MAX_LENGTH, type TankColor } from "./types";

/** Default slot names/colors — same as the twin's config.TANK_SLOTS. */
export const DEFAULT_TANK_SLOTS: ({ id: string } & TankColor)[] = [
  { id: "T1", name: "Sky Blue", colorCode: "#7EC8E3" },
  { id: "T2", name: "Amber", colorCode: "#F4C430" },
];

/** Quick-pick swatches for the color editor. */
export const PRESET_COLORS = [
  "#7EC8E3", "#F4C430", "#F4A6C8", "#A8E6CF", "#C5B4E3", "#F6D6AD",
  "#9AD1F5", "#F7E38A", "#F2B5A0", "#B7E4C7", "#D4C4A8", "#E8F1F8",
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
