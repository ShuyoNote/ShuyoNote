import { defineConfig } from "vitest/config";

// Isolated Vitest config so the app's Vite build configs (vite.config.ts for
// desktop, vite.web.config.ts for web) are untouched. Pure-function unit tests
// run in a Node environment (no DOM/React).
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
