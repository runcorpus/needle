import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  outputFileTracingExcludes: { "/*": ["./.evals/**/*"] },
};

export default config;
