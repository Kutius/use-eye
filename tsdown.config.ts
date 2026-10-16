import { defineConfig } from "tsdown";

/**
 * Bundles the agent-facing CLI into a single Node ESM file.
 * Output lands in bin/, not dist/, so it never collides with the Vite build
 * that ships the phone and status pages.
 */
export default defineConfig({
  entry: { "use-eye": "cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "bin",
  clean: true,
  dts: false,
  minify: false,
  treeshake: true,
});
