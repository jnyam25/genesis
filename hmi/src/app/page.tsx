"use client";

import dynamic from "next/dynamic";
import { Boxes, LayoutGrid, LineChart } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OeeGrid } from "@/components/dashboard/oee-grid";
import { CountsCard } from "@/components/dashboard/counts-card";
import { TankLevels } from "@/components/dashboard/tank-levels";
import { EventLog } from "@/components/dashboard/event-log";
import { LineSchematic } from "@/components/schematic/line-schematic";
import { Card, CardContent } from "@/components/ui/card";
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
              <CardContent className="pt-4">
                <LineSchematic state={state} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="scene3d" className="mt-4">
            <Card>
              <CardContent className="pt-4" title="Drag to orbit. Scroll to zoom. Click a station.">
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
            <CardContent className="pt-4">
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

function LoadingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">
        Connecting
      </p>
    </div>
  );
}

function SceneSkeleton() {
  return (
    <div className="flex h-[520px] w-full items-center justify-center rounded-lg border border-border/60 bg-slate-50 text-sm text-muted-foreground">
      …
    </div>
  );
}

function StaleAlert() {
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>No data</AlertTitle>
      <AlertDescription>Twin offline.</AlertDescription>
    </Alert>
  );
}
