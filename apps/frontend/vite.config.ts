import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
  ],
  server: {
    port: 6677,
    proxy: {
      "/api": "http://localhost:6666",
      "/monitor": "http://localhost:6666",
      "/paper": "http://localhost:6666",
      "/positions": "http://localhost:6666",
      "/orders": "http://localhost:6666",
      "/risk": "http://localhost:6666",
      "/trading": "http://localhost:6666",
      "/health": "http://localhost:6666",
      "/ws": {
        target: "ws://localhost:6666",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
