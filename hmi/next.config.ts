import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // hmi/ is its own npm project inside the repo (the root package.json only
  // orchestrates). Pin the root so Next doesn't pick the repo-root lockfile.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
