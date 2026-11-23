import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const timingFiles = [
  "tests/embedding-maintenance.test.ts",
  "tests/service/worker/worker-provider-lane-fairness.test.ts"
];
const excludes = [...configDefaults.exclude, "**/dist/**"];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "memory-parallel",
          include: configDefaults.include.flatMap(pattern => [`tests/${pattern}`, `src/${pattern}`]),
          exclude: [...excludes, ...timingFiles],
          sequence: { groupOrder: 0 }
        }
      },
      {
        test: {
          name: "memory-timing-sensitive",
          include: timingFiles,
          exclude: excludes,
          fileParallelism: false,
          sequence: { groupOrder: 1 }
        }
      }
    ]
  }
});
