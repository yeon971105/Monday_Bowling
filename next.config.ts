import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["libsql", "pdf-parse"],
};

export default nextConfig;
