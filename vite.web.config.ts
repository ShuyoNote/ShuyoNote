import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dedicated config for running the app in a plain browser (no Tauri backend).
// The Web platform (localStorage-backed mock) serves the ~60 backend commands,
// so `pnpm dev:web` works without the Rust/SQLite host. Uses its own port so it
// can run alongside the Tauri dev server (which uses 1420).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    open: true,
  },
});
