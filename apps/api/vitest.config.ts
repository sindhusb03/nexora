import { defineConfig } from "vitest/config";

const accuracy = [
  "test/accuracy.test.ts",
  "test/adversarial-accuracy.test.ts",
  "test/round1-accuracy.test.ts",
];
const ingestion = [
  "test/imports.test.ts",
  "test/ingestion*.test.ts",
  "test/adversarial-ingestion.test.ts",
  "test/round1-regressions.test.ts",
  "test/heldout-extraction.test.ts",
  "test/families.test.ts",
  "test/layout.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 4,
    // Keep all default safety tests, but do not overlap database/parser startup
    // with application HTTP tests or auth's unchanged wall-clock assertions.
    projects: [
      {
        extends: true,
        test: {
          name: "application",
          include: ["test/**/*.test.ts"],
          exclude: [...accuracy, ...ingestion, "test/auth-factors.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: "ingestion", include: ingestion, sequence: { groupOrder: 1 } },
      },
      {
        extends: true,
        test: {
          name: "auth-timing",
          include: ["test/auth-factors.test.ts"],
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
