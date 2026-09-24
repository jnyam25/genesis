/**
 * Server-side proxy to the twin's HTTP API (used by `app/api/twin/*` routes).
 *
 * The browser talks only to the HMI's own origin (`/api/twin/...`); the Next
 * server forwards to the twin. This avoids CORS, keeps working when operators
 * open the HMI from another machine (the twin itself binds to 127.0.0.1), and
 * lets `TWIN_HTTP_URL` be changed at runtime without rebuilding.
 */

const DEFAULT_TWIN_HTTP_URL = "http://127.0.0.1:43124";
const TIMEOUT_MS = 2000;

export function twinBaseUrl(): string {
  return (process.env.TWIN_HTTP_URL ?? DEFAULT_TWIN_HTTP_URL).replace(/\/+$/, "");
}

export async function proxyToTwin(path: string, init?: RequestInit): Promise<Response> {
  const url = `${twinBaseUrl()}${path}`;
  try {
    const upstream = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, error: `twin unreachable at ${twinBaseUrl()} (${reason})` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
