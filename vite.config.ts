import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  envDir: false,
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer/src") } },
  plugins: [
    tanstackRouter({ target: "react", routesDirectory: resolve(import.meta.dirname, "src/renderer/src/routes"), generatedRouteTree: resolve(import.meta.dirname, "src/renderer/src/routeTree.gen.ts"), tmpDir: resolve(import.meta.dirname, "src/renderer/.migration/router-tmp"), autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    { name: "third-party-notices", generateBundle() { this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.txt", source: readFileSync(resolve(import.meta.dirname, "src/renderer/THIRD_PARTY_NOTICES"), "utf8") }); } },
  ],
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT || 8787}`, changeOrigin: false } },
  },
});
