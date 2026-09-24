import { proxyToTwin } from "@/lib/twin/twin-proxy";

export const dynamic = "force-dynamic";

/** Live twin state in the HMI `TwinState` shape (proxied from the twin's `/hmi/state`). */
export async function GET() {
  return proxyToTwin("/hmi/state");
}
