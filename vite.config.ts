import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Only PORT is read here. Nothing from .env reaches the browser bundle: Vite exposes
  // only VITE_-prefixed variables to client code, and this project defines none.
  const port = loadEnv(mode, process.cwd(), "PORT").PORT ?? "8787";
  const api = `http://localhost:${port}`;
  return {
    plugins: [react()],
    build: { outDir: "dist/web", emptyOutDir: true },
    server: {
      // Listens on the network too, so a phone on the same Wi-Fi can open the visitor page.
      host: true,
      // Not Vite's default 5173, which other local projects tend to hold. Fails loudly if taken.
      port: 5180,
      strictPort: true,
      proxy: { "/api": api, "/health": api },
    },
  };
});
