import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          sequence: { groupOrder: 0 },
          include: ["test/unit/**/*.test.ts"],
          setupFiles: ["test/setup.ts"],
          // Heavy matcher and eval tests: generous so that a loaded machine never fails them on time.
          testTimeout: 120000,
          hookTimeout: 60000,
        },
      },
      {
        test: {
          name: "integration",
          // After the unit tests, in its own group: worker ids restart at 1 and stop at maxWorkers,
          // and global-setup makes one database per worker. A fixed count keeps the Postgres
          // connections well under its default limit of 100 on a machine with many cores.
          sequence: { groupOrder: 1 },
          maxWorkers: 4,
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["test/setup.ts", "test/setup-integration.ts"],
          globalSetup: ["test/global-setup.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
