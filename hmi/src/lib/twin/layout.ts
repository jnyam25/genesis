/**
 * Line geometry matching the concept: scan gate, QR reject, two tanks,
 * capping arm, lid press, fill reject, then lane 1 and lane 2.
 */

import type { Container, Tank } from "./types";

export interface StationPosition {
  id: string;
  kind:
    | "label"
    | "scan"
    | "qr-reject"
    | "nozzle"
    | "cap"
    | "press"
    | "qc"
    | "gate"
    | "sort"
    | "output"
    | "reject";
  /** Center X in line units. */
  x: number;
  /** Y in line units (0 = conveyor centerline, + = above, - = below). */
  y: number;
  label: string;
  /** Tank id this station is fed by (nozzles only). */
  tankId?: string;
  /** Output lane index (outputs only): 0 = Lane A, 1 = Lane B. */
  lane?: number;
}

export interface LineLayout {
  /** Ordered stations left-to-right (plus the reject and Lane B branches). */
  stations: StationPosition[];
  /** Conveyor span [minX, maxX] in line units. */
  spanX: [number, number];
  /** Conveyor width (Y extent of the belt). */
  beltHalfHeight: number;
  /** Tank row Y. */
  tankY: number;
  /** Reject lane Y. */
  rejectY: number;
  /** Lane B (sort branch) Y. */
  laneBY: number;
}

const SCAN_X = 1.2;
const QR_REJECT_X = 2.15;
const NOZZLE_SPACING = 1.15;
const NOZZLE_START = 3.3;
const CAP_OFFSET = 1.35;
const STATION_SPACING = 1.0;
const OUTPUT_OFFSET = 1.4;
const TANK_Y = 1.6;
const REJECT_Y = -1.7;
const LANE_B_Y = 1.3;
const BELT_HALF = 0.22;

export function computeLayout(tanks: Tank[]): LineLayout {
  const stations: StationPosition[] = [];

  stations.push({ id: "scan", kind: "scan", x: SCAN_X, y: 0, label: "Scan gate" });
  stations.push({ id: "qr-reject", kind: "qr-reject", x: QR_REJECT_X, y: REJECT_Y, label: "QR reject" });

  tanks.forEach((tank, i) => {
    stations.push({
      id: `nozzle-${tank.id}`,
      kind: "nozzle",
      x: NOZZLE_START + i * NOZZLE_SPACING,
      y: 0,
      label: `Fill Bay ${i + 1}`,
      tankId: tank.id,
    });
  });

  const lastNozzleX =
    tanks.length > 0
      ? NOZZLE_START + (tanks.length - 1) * NOZZLE_SPACING
      : NOZZLE_START;

  const capX = lastNozzleX + CAP_OFFSET;
  const pressX = capX + STATION_SPACING;
  const qcX = pressX + STATION_SPACING;
  const gateX = qcX + STATION_SPACING;
  const sortX = gateX + STATION_SPACING;
  const outputX = sortX + OUTPUT_OFFSET;

  stations.push({ id: "cap", kind: "cap", x: capX, y: 0, label: "Robotic capping arm" });
  stations.push({ id: "press", kind: "press", x: pressX, y: 0, label: "Lid press" });
  stations.push({ id: "qc", kind: "qc", x: qcX, y: 0, label: "Fill check" });
  stations.push({ id: "gate", kind: "gate", x: gateX, y: 0, label: "Fill reject" });
  stations.push({ id: "sort", kind: "sort", x: sortX, y: 0, label: "Sort / split" });
  stations.push({ id: "output-a", kind: "output", x: outputX, y: 0, label: "Lane 1", lane: 0 });
  stations.push({ id: "output-b", kind: "output", x: outputX, y: LANE_B_Y, label: "Lane 2", lane: 1 });
  stations.push({ id: "reject", kind: "reject", x: gateX, y: REJECT_Y, label: "Fill reject slide" });

  return {
    stations,
    spanX: [0, outputX + 0.6],
    beltHalfHeight: BELT_HALF,
    tankY: TANK_Y,
    rejectY: REJECT_Y,
    laneBY: LANE_B_Y,
  };
}

/**
 * Map a container to the station it should be displayed at.
 * `fill-i` maps to fill bay i (1-indexed) for the i-th tank; `mix` (only on
 * lines with a mixer) is shown at the last fill bay; `output` uses the
 * container's lane; both reject statuses end in the reject lane.
 */
export function stationForStatus(
  container: Pick<Container, "status" | "lane">,
  layout: LineLayout,
): StationPosition {
  const { status } = container;
  const nozzles = layout.stations.filter((s) => s.kind === "nozzle");
  switch (status) {
    case "idle":
      return layout.stations[0];
    case "label":
    case "scan":
    case "cap":
    case "press":
    case "qc":
    case "sort":
      return byId(layout, status);
    case "scan-rejected":
      return byId(layout, "qr-reject");
    case "mix":
      return nozzles[nozzles.length - 1] ?? byId(layout, "scan");
    case "output":
      return byId(layout, container.lane === 1 ? "output-b" : "output-a");
    case "rejected":
      return byId(layout, "reject");
  }
  const m = /^fill-(\d+)$/.exec(status);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    return nozzles[idx] ?? nozzles[nozzles.length - 1] ?? byId(layout, "scan");
  }
  return layout.stations[0];
}

function byId(layout: LineLayout, id: string): StationPosition {
  return layout.stations.find((s) => s.id === id) ?? layout.stations[0];
}

/** Station index in the left-to-right traversal (for "active station" badges). */
export function stationOrder(layout: LineLayout): string[] {
  return layout.stations.filter((s) => s.kind !== "reject").map((s) => s.id);
}
