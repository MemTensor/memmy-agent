import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const timingFiles = [
  "tests/embedding-maintenance.test.ts",
  "tests/service/worker/worker-provider-lane-fairness.test.ts"
];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "memory-parallel",
          include: configDefaults.include.map(pattern => `tests/${pattern}`),
          exclude: [...configDefaults.exclude, ...timingFiles],
          sequence: { groupOrder: 0 }
        }
      },
      {
        test: {
          name: "memory-timing-sensitive",
          include: timingFiles,
          exclude: [...configDefaults.exclude],
          // Isolate file-level CPU/I/O contention, retaining each test's own concurrency and budgets.
          fileParallelism: false,
          sequence: { groupOrder: 1 }
        }
      }
    ]
  }
});
