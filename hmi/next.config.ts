import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * Hosts that may load the dev server besides `localhost`.
 * Next blocks `/_next` (including hot reload) from any other host.
 * This list is this computer's own LAN addresses, so opening
 * `http://<this-computer>:43123` works on whatever network it joined.
 */
function devOrigins(): string[] {
  const origins = new Set<string>(["127.0.0.1", "*.local"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== "IPv4" && family !== 4)) continue;
      origins.add(entry.address);
    }
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  // hmi/ is its own npm project inside the repo (the root package.json only
  // orchestrates). Pin the root so Next doesn't pick the repo-root lockfile.
  turbopack: {
    root: __dirname,
  },
  allowedDevOrigins: devOrigins(),
};

export default nextConfig;
