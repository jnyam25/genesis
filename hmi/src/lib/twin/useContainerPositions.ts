"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Container, TwinState } from "./types";
import { computeLayout, stationForStatus, type LineLayout } from "./layout";

export interface ContainerPosition {
  id: string;
  /** Current X in line units (animated). */
  x: number;
  /** Current Y in line units (animated). */
  y: number;
  /** Target station X. */
  targetX: number;
  /** Target station Y. */
  targetY: number;
  status: Container["status"];
}

/**
 * Derives smooth container positions from the live snapshot.
 *
 * The twin snapshot only carries each container's `status` and output `lane`
 * (no coordinates), so positions are a *visualization* concern. This hook maps
 * each container to a station via the shared layout, then tweens it from its current
 * position toward that station using requestAnimationFrame. The result is
 * conveyor-like motion driven purely by status transitions — and it stays in
 * sync across the 2D and 3D views because both consume the same positions.
 *
 * The mutable tween state lives in a ref (touched only inside effects/frames);
 * each animated frame publishes an immutable copy through state for rendering.
 * The frame loop stops once every container has settled and restarts when the
 * next snapshot moves a target.
 */
export function useContainerPositions(state: TwinState): {
  layout: LineLayout;
  positions: ContainerPosition[];
} {
  const layout = useMemo(() => computeLayout(state.tanks), [state.tanks]);
  const tweensRef = useRef<Map<string, ContainerPosition>>(new Map());
  const [positions, setPositions] = useState<ContainerPosition[]>([]);

  useEffect(() => {
    // Ensure every live container has an entry; seed at its target station.
    const map = tweensRef.current;
    for (const c of state.containers) {
      const target = stationForStatus(c, layout);
      const existing = map.get(c.id);
      if (!existing) {
        map.set(c.id, {
          id: c.id,
          x: target.x,
          y: target.y,
          targetX: target.x,
          targetY: target.y,
          status: c.status,
        });
      } else {
        existing.status = c.status;
        existing.targetX = target.x;
        existing.targetY = target.y;
      }
    }
    // Drop containers no longer present.
    const liveIds = state.containers.map((c) => c.id);
    const live = new Set(liveIds);
    for (const id of [...map.keys()]) {
      if (!live.has(id)) map.delete(id);
    }

    const publish = () =>
      setPositions(
        liveIds
          .map((id) => map.get(id))
          .filter((p): p is ContainerPosition => Boolean(p))
          .map((p) => ({ ...p })),
      );

    let raf: number | null = null;
    let lastFrame = 0;
    let firstFrame = true;
    const animate = (t: number) => {
      const dt = Math.min(64, lastFrame ? t - lastFrame : 0) / 1000;
      lastFrame = t;
      const k = 1 - Math.pow(0.0015, dt); // smoothing factor
      let moving = false;
      for (const p of map.values()) {
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
          p.x += dx * k;
          p.y += dy * k;
          moving = true;
        } else {
          p.x = p.targetX;
          p.y = p.targetY;
        }
      }
      if (moving || firstFrame) publish();
      firstFrame = false;
      raf = moving ? requestAnimationFrame(animate) : null;
    };
    raf = requestAnimationFrame(animate);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [state.containers, layout]);

  return { layout, positions };
}
