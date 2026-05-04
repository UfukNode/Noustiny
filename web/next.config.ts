import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // MCP Playwright runs inside Docker, so it reaches the host-side
  // dev server via `host.docker.internal`.  Next.js 15+ rejects cross-
  // origin dev requests unless explicitly allowed, which made the
  // client bundle refuse to hydrate and the page froze on the boot
  // splash under automated browser testing.  Only loopback hostnames.
  allowedDevOrigins: ['host.docker.internal', 'localhost', '127.0.0.1'],
};

export default nextConfig;
