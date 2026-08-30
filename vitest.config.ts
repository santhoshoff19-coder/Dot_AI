import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * One SQLite file backs every test, and several suites seed or clear
     * shared tables (the model catalog, the policy corpus). Run files one at
     * a time so a suite cannot read a table another suite is midway through
     * rewriting: the failures that produced were races, not defects, and a
     * red suite that passes in isolation teaches everyone to ignore it.
     *
     * If this ever becomes the bottleneck, the fix is a database per worker,
     * not turning parallelism back on.
     */
    fileParallelism: false,
    /** Extraction and multimodal suites do real work and need the headroom. */
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
