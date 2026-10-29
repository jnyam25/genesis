"use client";

import { KeyRound, OctagonX, RotateCcw, TriangleAlert } from "lucide-react";
import { useTwin } from "@/lib/twin/twin-context";

/** One line when the line is not free to run. Actions sit in the bar below. */
export function SafetyBanner() {
  const { state, loading } = useTwin();
  const safety = state.safety;
  if (loading || !safety) return null;

  const pressed = safety.eStopButtons.filter((b) => b.pressed);
  const faultEvent = (state.recentEvents ?? (state.lastEvent ? [state.lastEvent] : [])).find((e) => e.message.startsWith("FAULT"));
  const fault = faultEvent ? faultEvent.message.replace(/^FAULT:\s*/, "").replace(/ — line stopped$/, "") : "Station fault";

  if (safety.eStopActive) {
    const where = [
      ...pressed.map((b) => b.name),
      ...(safety.digitalEStop ? ["Digital"] : []),
    ].join(" · ");
    return (
      <Banner tone="bg-red-800 text-white" icon={<OctagonX className="h-5 w-5 shrink-0" />}>
        E-STOP{where ? ` · ${where}` : ""}
      </Banner>
    );
  }
  if (safety.resetRequired) {
    return (
      <Banner tone="bg-amber-800 text-white" icon={<RotateCcw className="h-5 w-5 shrink-0" />}>
        Reset required
      </Banner>
    );
  }
  if (safety.faultActive) {
    return (
      <Banner tone="bg-orange-800 text-white" icon={<TriangleAlert className="h-5 w-5 shrink-0" />}>
        {fault}
      </Banner>
    );
  }
  if (safety.controlMode === "local") {
    return (
      <Banner tone="bg-sky-900 text-white" icon={<KeyRound className="h-5 w-5 shrink-0" />}>
        LOCAL
      </Banner>
    );
  }
  return null;
}

function Banner({ tone, icon, children }: { tone: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-3 pt-3 sm:px-6" aria-live="assertive">
      <div role="alert" className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-bold tracking-wide ${tone}`}>
        {icon}
        <span>{children}</span>
      </div>
    </div>
  );
}
