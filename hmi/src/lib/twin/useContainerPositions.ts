"use client";

import { useEffect, useRef, useState } from "react";
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
 * The twin snapshot only carries each container's `status` (no coordinates),
 * so positions are a *visualization* concern. This hook maps each status to a
 * station via the shared layout, then tweens each container from its current
 * position toward that station using requestAnimationFrame. The result is
 * conveyor-like motion driven purely by status transitions — and it stays in
 * sync across the 2D and 3D views because both consume the same positions.
 */
export function useContainerPositions(state: TwinState): {
  layout: LineLayout;
  positions: ContainerPosition[];
} {
  const layout = computeLayout(state.tanks);
  const positionsRef = useRef<Map<string, ContainerPosition>>(new Map());
  const [, force] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  useEffect(() => {
    // Ensure every live container has an entry; seed at its target station.
    const map = positionsRef.current;
    for (const c of state.containers) {
      const target = stationForStatus(c.status, layout);
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
    const liveIds = new Set(state.containers.map((c) => c.id));
    for (const id of [...map.keys()]) {
      if (!liveIds.has(id)) map.delete(id);
    }

    const animate = (t: number) => {
      const last = lastFrameRef.current || t;
      const dt = Math.min(64, t - last) / 1000;
      lastFrameRef.current = t;
      let changed = false;
      for (const p of map.values()) {
        const k = 1 - Math.pow(0.0015, dt); // smoothing factor
        const dx = p.targetX - p.x;
        const dy = p.targetY - p.y;
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
          p.x += dx * k;
          p.y += dy * k;
          changed = true;
        } else {
          p.x = p.targetX;
          p.y = p.targetY;
        }
      }
      if (changed) force((n) => (n + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = 0;
    };
  }, [state, layout]);

  const positions = state.containers
    .map((c) => positionsRef.current.get(c.id))
    .filter((p): p is ContainerPosition => Boolean(p));

  return { layout, positions };
}
