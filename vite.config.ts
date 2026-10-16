import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

/**
 * Vite stamps `crossorigin` onto every module script and stylesheet. That forces
 * CORS mode, and under a self-signed certificate the CORS preflight for the
 * very module that would run the page fails, so the bundle never executes and
 * the phone UI sits on its HTML default ("idle") forever. Same-origin assets do
 * not need the attribute; strip it so the camera page actually boots.
 */
function stripCrossOrigin(): Plugin {
  return {
    name: "strip-crossorigin",
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:="[^"]*")?/gi, "");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [stripCrossOrigin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        phone: resolve(import.meta.dirname, "phone.html"),
        status: resolve(import.meta.dirname, "status.html"),
      },
    },
  },
});
