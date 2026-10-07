import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // SF_BASE_PATH=root → 域名根部署（无 basePath）；默认 /scorefollow
  basePath: process.env.SF_BASE_PATH === "root" ? undefined : "/scorefollow",
  experimental: {
    workerThreads: false,
    cpus: 1,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
