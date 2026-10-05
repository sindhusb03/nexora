import { defineConfig } from "vitest/config";

// Run the generated document/HTTP corpora separately from timing-sensitive auth tests.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/accuracy.test.ts",
      "test/adversarial-accuracy.test.ts",
      "test/round1-accuracy.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
