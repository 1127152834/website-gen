import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer/src") } },
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT || 8787}`, changeOrigin: false } },
  },
});
