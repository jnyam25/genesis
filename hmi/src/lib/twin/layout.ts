/**
 * Shared line layout model.
 *
 * Both the 2D schematic and the 3D scene render the *same* physical line, so
 * they share one geometric model. Stations are placed along the X axis in
 * "line units" (1 unit ~= 1 meter). Tanks sit above their nozzle stations; the
 * reject lane branches off the QC station downward.
 *
 * The layout is computed from the live `tanks[]` array, so adding a tank in the
 * twin config re-positions nozzle stations and lengthens the conveyor in both
 * views with no per-view code change.
 */

import type { ContainerStatus, Tank } from "./types";

export interface StationPosition {
  id: string;
  kind:
    | "scan"
    | "nozzle"
    | "mix"
    | "qc"
    | "output"
    | "reject";
  /** Center X in line units. */
  x: number;
  /** Y in line units (0 = conveyor centerline, + = above, - = below). */
  y: number;
  label: string;
  /** Tank id this station is fed by (nozzles only). */
  tankId?: string;
}

export interface LineLayout {
  /** Ordered stations left-to-right (and reject branch). */
  stations: StationPosition[];
  /** Conveyor span [minX, maxX] in line units. */
  spanX: [number, number];
  /** Conveyor width (Y extent of the belt). */
  beltHalfHeight: number;
  /** Tank row Y. */
  tankY: number;
  /** Reject lane Y. */
  rejectY: number;
}

const SCAN_X = 0.6;
const NOZZLE_SPACING = 1.1;
const NOZZLE_START = 1.7;
const MIX_OFFSET = 1.2;
const QC_OFFSET = 1.4;
const OUTPUT_OFFSET = 1.4;
const TANK_Y = 1.6;
const REJECT_Y = -1.7;
const BELT_HALF = 0.22;

export function computeLayout(tanks: Tank[]): LineLayout {
  const stations: StationPosition[] = [];

  stations.push({
    id: "scan",
    kind: "scan",
    x: SCAN_X,
    y: 0,
    label: "Scan Zone",
  });

  tanks.forEach((tank, i) => {
    stations.push({
      id: `nozzle-${tank.id}`,
      kind: "nozzle",
      x: NOZZLE_START + i * NOZZLE_SPACING,
      y: 0,
      label: `Nozzle ${i + 1}`,
      tankId: tank.id,
    });
  });

  const lastNozzleX =
    tanks.length > 0
      ? NOZZLE_START + (tanks.length - 1) * NOZZLE_SPACING
      : NOZZLE_START;

  const mixX = lastNozzleX + MIX_OFFSET;
  const qcX = mixX + QC_OFFSET;
  const outputX = qcX + OUTPUT_OFFSET;

  stations.push({ id: "mix", kind: "mix", x: mixX, y: 0, label: "Mix Station" });
  stations.push({ id: "qc", kind: "qc", x: qcX, y: 0, label: "QC Station" });
  stations.push({
    id: "output",
    kind: "output",
    x: outputX,
    y: 0,
    label: "Output Lane",
  });
  stations.push({
    id: "reject",
    kind: "reject",
    x: qcX,
    y: REJECT_Y,
    label: "Reject Lane",
  });

  return {
    stations,
    spanX: [0, outputX + 0.6],
    beltHalfHeight: BELT_HALF,
    tankY: TANK_Y,
    rejectY: REJECT_Y,
  };
}

/**
 * Map a container status to the station it should be displayed at.
 * `fill-i` maps to nozzle i (1-indexed) for the i-th tank.
 */
export function stationForStatus(
  status: ContainerStatus,
  layout: LineLayout,
): StationPosition {
  if (status === "idle") return layout.stations[0];
  if (status === "scan") return byId(layout, "scan");
  if (status === "mix") return byId(layout, "mix");
  if (status === "qc") return byId(layout, "qc");
  if (status === "output") return byId(layout, "output");
  if (status === "rejected") return byId(layout, "reject");
  const m = /^fill-(\d+)$/.exec(status);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    const nozzles = layout.stations.filter((s) => s.kind === "nozzle");
    return nozzles[idx] ?? nozzles[nozzles.length - 1] ?? byId(layout, "scan");
  }
  return layout.stations[0];
}

function byId(layout: LineLayout, id: string): StationPosition {
  return layout.stations.find((s) => s.id === id) ?? layout.stations[0];
}

/** Station index in the left-to-right traversal (for "active station" badges). */
export function stationOrder(layout: LineLayout): string[] {
  return layout.stations
    .filter((s) => s.kind !== "reject")
    .map((s) => s.id);
}
