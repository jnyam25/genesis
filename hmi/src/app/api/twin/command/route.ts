import { proxyToTwin } from "@/lib/twin/twin-proxy";

/** Operator command (`{ command, tankId? }`), forwarded to the twin's `/hmi/command`. */
export async function POST(request: Request) {
  const body = await request.text();
  return proxyToTwin("/hmi/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
