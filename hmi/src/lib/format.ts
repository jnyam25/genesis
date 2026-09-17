/** Small display helpers shared across the HMI. */

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function pct1(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
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
