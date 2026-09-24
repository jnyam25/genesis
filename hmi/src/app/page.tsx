"use client";

import dynamic from "next/dynamic";
import { Activity, Boxes, LayoutGrid, LineChart } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OeeGrid } from "@/components/dashboard/oee-grid";
import { CountsCard } from "@/components/dashboard/counts-card";
import { TankLevels } from "@/components/dashboard/tank-levels";
import { EventLog } from "@/components/dashboard/event-log";
import { LineSchematic } from "@/components/schematic/line-schematic";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useTwin } from "@/lib/twin/twin-context";

const LineScene = dynamic(
  () => import("@/components/scene/line-scene").then((m) => m.LineScene),
  { ssr: false, loading: () => <SceneSkeleton /> },
);

export default function Page() {
  const { state, events, loading, stale } = useTwin();

  return (
    <main className="mx-auto w-full max-w-[1400px] flex-1 px-3 py-4 sm:px-6">
      {loading && <LoadingState />}
      {!loading && stale && <StaleAlert />}
      {!loading && (
        <Tabs defaultValue="dashboard" className="gap-4">
          <TabsList className="h-9">
            <TabsTrigger value="dashboard" className="gap-1.5">
              <LayoutGrid className="h-4 w-4" /> Dashboard
            </TabsTrigger>
            <TabsTrigger value="schematic" className="gap-1.5">
              <LineChart className="h-4 w-4" /> Schematic
            </TabsTrigger>
            <TabsTrigger value="scene3d" className="gap-1.5">
              <Boxes className="h-4 w-4" /> 3D View
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="mt-4">
            <DashboardView state={state} events={events} />
          </TabsContent>

          <TabsContent value="schematic" className="mt-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-4 w-4" /> Line Schematic
                </CardTitle>
                <span className="font-mono text-xs text-muted-foreground">
                  {state.tanks.length} tanks · {state.containers.length} in-flight
                </span>
              </CardHeader>
              <CardContent>
                <LineSchematic state={state} />
                <SchematicLegend />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="scene3d" className="mt-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Boxes className="h-4 w-4" /> 3D Visualization
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  Drag to orbit · scroll to zoom · right-drag to pan
                </span>
              </CardHeader>
              <CardContent>
                <LineScene state={state} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

function DashboardView({
  state,
  events,
}: {
  state: ReturnType<typeof useTwin>["state"];
  events: ReturnType<typeof useTwin>["events"];
}) {
  return (
    <div className="space-y-4">
      <OeeGrid oee={state.oee} />
      <CountsCard counts={state.counts} throughputCpm={state.throughputCpm} sortLanes={state.sortLanes} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card className="h-full">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <LineChart className="h-4 w-4" /> Line Schematic
              </CardTitle>
              <span className="font-mono text-xs text-muted-foreground">
                {state.tanks.length} tanks · {state.containers.length} in-flight
              </span>
            </CardHeader>
            <CardContent>
              <LineSchematic state={state} />
            </CardContent>
          </Card>
        </div>
        <EventLog events={events} />
      </div>
      <TankLevels tanks={state.tanks} />
    </div>
  );
}

function SchematicLegend() {
  const items = [
    { c: "#22c55e", t: "Active station" },
    { c: "#475569", t: "Idle station" },
    { c: "#ef4444", t: "Reject in flight / reject lane" },
    { c: "#f59e0b", t: "Reject & sort diverters" },
    { c: "#fb923c", t: "Bad barcode (rejected unfilled)" },
  ];
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.t} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: i.c }} />
          {i.t}
        </span>
      ))}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">
        Connecting to the paint mixing twin…
      </p>
    </div>
  );
}

function SceneSkeleton() {
  return (
    <div className="flex h-[520px] w-full items-center justify-center rounded-lg border border-border/60 bg-slate-950 text-sm text-muted-foreground">
      Loading 3D scene…
    </div>
  );
}

function StaleAlert() {
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>Feed stale</AlertTitle>
      <AlertDescription>
        No snapshot received from the twin within the freshness window. Check
        the engine worker or the data source configuration.
      </AlertDescription>
    </Alert>
  );
}
