import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The hub and worker tests start the real eval service (a Python process). With the default
    // of one worker per core they starve each other and time out on machines with many cores,
    // so the number of test files that run in parallel is capped.
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/{hub,worker,mcp-stdio}/{src,test}/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 90_000,
        },
      },
      "apps/pwa",
    ],
  },
});
