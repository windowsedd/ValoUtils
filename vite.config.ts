import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  // Vite 8 resolves tsconfig `paths` (e.g. the "@/*" alias) natively,
  // replacing the previously-used vite-tsconfig-paths plugin.
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [react()],
  // Tauri expects a fixed port, fails if that port is not available.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    watch: {
      // Tell Vite to ignore watching `src-tauri`.
      ignored: ["**/src-tauri/**"],
    },
  },
});
