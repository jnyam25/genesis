"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Hand, KeyRound, OctagonX, RotateCcw } from "lucide-react";
import { useTwin } from "@/lib/twin/twin-context";

/**
 * Global safety banner shown under the nav bar on every screen.
 *
 * - E-Stop active (physical and/or digital): red, names every pressed button
 *   and whether the digital E-Stop is latched, with recovery steps.
 * - Safety reset required: amber, tells the operator where to reset.
 * - Local control: blue, explains the HMI is view-only.
 */
export function SafetyBanner() {
  const { state, loading } = useTwin();
  const pathname = usePathname();
  const safety = state.safety;
  if (loading || !safety) return null;

  const pressed = safety.eStopButtons.filter((b) => b.pressed);
  const remoteReset = safety.remoteResetAllowed && safety.controlMode === "remote";
  const controlsLink =
    pathname === "/manual" ? null : (
      <Link href="/manual" className="shrink-0 rounded-md border border-current/40 px-2.5 py-1 text-xs font-semibold hover:bg-white/10">
        Open controls
      </Link>
    );

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-2 px-3 pt-3 sm:px-6" aria-live="assertive">
      {safety.eStopActive && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border-2 border-red-500 bg-red-950/80 px-4 py-3 text-red-100 shadow-[0_0_24px_rgba(239,68,68,0.35)] sm:flex-row sm:items-center"
        >
          <OctagonX className="h-8 w-8 shrink-0 animate-pulse text-red-400" />
          <div className="flex-1 space-y-1">
            <div className="text-base font-bold tracking-wide">EMERGENCY STOP — LINE SHUT DOWN</div>
            <ul className="space-y-0.5 text-sm">
              {pressed.map((b) => (
                <li key={b.id}>
                  <span className="font-semibold">Physical E-Stop pressed</span> at {b.name}
                </li>
              ))}
              {safety.digitalEStop && (
                <li>
                  <span className="font-semibold">Digital E-Stop active</span> (activated from the HMI)
                </li>
              )}
            </ul>
            <p className="text-xs text-red-200/90">
              Safety circuit open — all motion de-energized. To recover: make the area safe,{" "}
              {pressed.length > 0 && "release the physical E-Stop button(s), "}
              {safety.digitalEStop && "release the digital E-Stop, "}
              press RESET at the local control panel, then START.
            </p>
          </div>
          {controlsLink}
        </div>
      )}

      {!safety.eStopActive && safety.resetRequired && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-amber-500/70 bg-amber-950/60 px-4 py-2.5 text-amber-100 sm:flex-row sm:items-center"
        >
          <RotateCcw className="h-5 w-5 shrink-0 text-amber-400" />
          <div className="flex-1 text-sm">
            <span className="font-semibold">Safety reset required.</span>{" "}
            {remoteReset
              ? "Reset from the Controls screen or at the local control panel, then START."
              : "Press RESET at the local control panel (reset must be done at the machine), then START."}
          </div>
          {remoteReset && controlsLink}
        </div>
      )}

      {safety.controlMode === "local" && (
        <div className="flex items-center gap-2 rounded-lg border border-sky-500/60 bg-sky-950/50 px-4 py-2 text-sm text-sky-100">
          <KeyRound className="h-4 w-4 shrink-0 text-sky-400" />
          <span>
            <span className="font-semibold">LOCAL CONTROL</span> — the line is operated from the machine panel. The HMI is
            view-only; <span className="font-semibold">Digital E-Stop</span> and <span className="font-semibold">Stop</span>{" "}
            remain available.
          </span>
        </div>
      )}

      {!safety.eStopActive && !safety.resetRequired && !safety.running && (
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          <Hand className="h-4 w-4 shrink-0" />
          <span>
            Line stopped — press START {safety.controlMode === "local" ? "at the local control panel" : "on the Controls screen"} to run.
          </span>
        </div>
      )}
    </div>
  );
}
