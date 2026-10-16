import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        phone: resolve(import.meta.dirname, "phone.html"),
        status: resolve(import.meta.dirname, "status.html"),
      },
    },
  },
});
