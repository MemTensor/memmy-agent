import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SummaryRetries } from "../../../../src/tools/computer-history/core/summary-retry.js";

let root: string;
let file: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-retries-"));
  file = path.join(root, "retries.json");
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

it("persists each attempt and cooldown across restarts, stops after five, and accepts changed input", () => {
  let retries = new SummaryRetries(file);
  retries.setModel("model-1", false);
  for (const wait of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    expect(retries.eligible("A", "input-1")).toBe(true);
    retries.start("A", "input-1");
    retries.fail("A", "input-1", "input");
    retries = new SummaryRetries(file);
    retries.setModel("model-1", false);
    expect(retries.eligible("A", "input-1")).toBe(false);
    expect(retries.eligible("B", "input-b")).toBe(true);
    vi.advanceTimersByTime(wait);
  }
  expect(retries.eligible("A", "input-1")).toBe(false);
  expect(retries.stoppedCount).toBe(1);
  expect(retries.eligible("A", "corrected-input")).toBe(true);
  retries.setModel("model-2", true);
  expect(retries.eligible("A", "input-1")).toBe(true);
});

it("counts an interrupted attempt and does not immediately replay it after a restart", () => {
  const retries = new SummaryRetries(file);
  retries.start("A", "input");
  const restarted = new SummaryRetries(file);
  expect(restarted.eligible("A", "input")).toBe(false);
  vi.advanceTimersByTime(60_000);
  restarted.start("A", "input");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).items.A.attempts).toBe(2);
});

it("persists shared service cooldown without exhausting any record's retry budget", () => {
  let retries = new SummaryRetries(file);
  for (const wait of [60_000, 120_000, 240_000, 300_000, 300_000, 300_000]) {
    retries.start("A", "input");
    retries.fail("A", "input", "service");
    retries = new SummaryRetries(file);
    expect(retries.eligible("B", "input-b")).toBe(false);
    expect(retries.stoppedCount).toBe(0);
    vi.advanceTimersByTime(wait);
    expect(retries.eligible("A", "input")).toBe(true);
    expect(retries.needsProbe).toBe(true);
  }
  retries.start("A", "input");
  retries.success("A", "input", retries.epoch);
  expect(retries.needsProbe).toBe(false);
  expect(retries.eligible("B", "input-b")).toBe(true);
});

it("opens the shared cooldown only after matching failures from three distinct records", () => {
  const retries = new SummaryRetries(file);
  for (const id of ["A", "A", "B"]) {
    retries.start(id, "input");
    retries.fail(id, "input", "empty");
    expect(retries.needsProbe).toBe(false);
    vi.advanceTimersByTime(120_000);
  }
  retries.start("C", "input");
  retries.fail("C", "input", "empty");
  expect(retries.needsProbe).toBe(true);
  expect(retries.eligible("D", "input")).toBe(false);
});

it("resets the uncertain failure streak on success and ignores stale successes for the circuit", () => {
  const retries = new SummaryRetries(file);
  retries.start("A", "input");
  retries.fail("A", "input", "empty");
  retries.start("B", "input");
  retries.success("B", "input", retries.epoch);
  for (const id of ["C", "D"]) {
    retries.start(id, "input"); retries.fail(id, "input", "empty");
  }
  expect(retries.needsProbe).toBe(false);
  const epoch = retries.epoch;
  retries.start("E", "input"); retries.start("F", "input");
  retries.fail("E", "input", "service");
  vi.advanceTimersByTime(60_000);
  retries.success("F", "input", epoch);
  expect(retries.needsProbe).toBe(true);
});

it("reopens the service cooldown when its recovery probe returns an empty response", () => {
  const retries = new SummaryRetries(file);
  retries.start("A", "input"); retries.fail("A", "input", "service");
  vi.advanceTimersByTime(60_000);
  retries.start("A", "input"); retries.fail("A", "input", "empty");
  expect(retries.retryAt).toBe(Date.now() + 120_000);
  expect(retries.eligible("B", "input")).toBe(false);
});

it("fails closed on corrupt metadata and removes deleted records from durable state", () => {
  const retries = new SummaryRetries(file);
  retries.start("A", "input");
  retries.remove("A");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).items).toEqual({});
  fs.writeFileSync(file, '{"version":1,"items":{"A":{"attempts":-1}}}');
  expect(() => new SummaryRetries(file).eligible("A", "input")).toThrow("retry state is unreadable");
});
