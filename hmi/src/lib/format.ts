/**
 * Display helpers. Values are rounded to the PLC register scale, then trailing
 * zeros are dropped, which is how FUXA renders a scaled tag (parseFloat of a
 * fixed-decimal string). ml × 10, cpm × 100, OEE × 1000.
 */

function scaled(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}

/** Tank.Flags LOW and the SCADA level bar turn red below this (ml). */
export const TANK_LOW_ML = 800;

export function tankIsLow(t: { levelMl: number; low?: boolean }): boolean {
  return t.low ?? t.levelMl < TANK_LOW_ML;
}

export function ml(n: number): string {
  return scaled(n, 1);
}

export function cpm(n: number): string {
  return scaled(n, 2);
}

/** OEE factor, matching Oee.* on the PLC and SCADA. */
export function ratio(n: number): string {
  return scaled(n, 3);
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour12: false });
}

/** OEE band color helper. */
export function oeeColor(n: number): string {
  if (n >= 0.85) return "text-emerald-400";
  if (n >= 0.6) return "text-amber-400";
  return "text-rose-400";
}

export function oeeBg(n: number): string {
  if (n >= 0.85) return "bg-emerald-500";
  if (n >= 0.6) return "bg-amber-500";
  return "bg-rose-500";
}
