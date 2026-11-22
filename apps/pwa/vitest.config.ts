import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

// Project "pwa" of the root config (vitest.config.ts → projects: ["apps/pwa"]).
export default defineProject({
  plugins: [react()],
  test: {
    name: "pwa",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
