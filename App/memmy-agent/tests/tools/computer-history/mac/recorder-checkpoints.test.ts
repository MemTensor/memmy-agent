import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { recorderCheckpoints } from "../../../../src/tools/computer-history/mac/recorder-checkpoints.js";
const id = "c892ee91-1d7c-4b43-b149-97284fe3caff";

describe("recorder native-to-disk checkpoint", () => {
  it("rotates only at its native barrier and waits for the durable handoff before acknowledging", async () => {
    const input = new PassThrough(), write = vi.fn(), requestNative = vi.fn();
    let finish!: () => void;
    const rotate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const persist = vi.fn(async () => {});
    const queue = recorderCheckpoints({ input, write, requestNative, persist, rotate });
    const command = { kind: "rotate", id, eventsFile: "/private/tmp/教学/next/events.jsonl", title: "下一段" };
    try {
      input.write(JSON.stringify(command) + "\n");
      expect(requestNative).toHaveBeenCalledExactlyOnceWith(id);
      const marker = { kind: "session.checkpoint", id, complete: true, issues: ["ax_snapshot_failed"] };
      queue.acknowledge(marker); queue.acknowledge(marker);
      expect(rotate).toHaveBeenCalledExactlyOnceWith(command, marker, expect.any(String));
      expect(write).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
      finish(); await delay(0);
      expect(write).toHaveBeenCalledExactlyOnceWith('[recorder-rotation] ' + JSON.stringify({ id, complete: true }));
    } finally { queue.close(); input.destroy(); }
  });
  it.each(["timeout", "native-incomplete", "disk-failure"])("does not certify an output rotation after %s", async failure => {
    const input = new PassThrough(), write = vi.fn(), rotate = vi.fn(async () => { throw new Error("disk full"); });
    const queue = recorderCheckpoints({ input, write, requestNative: () => {}, persist: async () => {}, rotate, timeoutMs: 5 });
    try {
      input.write(JSON.stringify({ kind: "rotate", id, eventsFile: "/tmp/next/events.jsonl", title: "next" }) + "\n");
      if (failure !== "timeout") queue.acknowledge({ kind: "session.checkpoint", id, complete: failure !== "native-incomplete" });
      await delay(15);
      expect(write).toHaveBeenCalledExactlyOnceWith('[recorder-rotation] ' + JSON.stringify({ id, complete: false }));
      expect(rotate).toHaveBeenCalledTimes(failure === "disk-failure" ? 1 : 0);
    } finally { queue.close(); input.destroy(); }
  });
  it("forwards a bounded interval and preserves its native completeness scope after fsync", async () => {
    const input = new PassThrough(), write = vi.fn(), requestNative = vi.fn();
    const range = { from: "2026-10-21T00:00:00.000Z", through: "2026-10-21T00:00:01.000Z" };
    const queue = recorderCheckpoints({ input, write, requestNative, persist: async () => {} });
    try {
      input.write(JSON.stringify({ kind: "checkpoint", id, ...range }) + "\n");
      input.write(JSON.stringify({ kind: "checkpoint", id, ...range }) + "\n");
      expect(requestNative).toHaveBeenCalledExactlyOnceWith(id, range);
      queue.acknowledge({ kind: "session.checkpoint", id, complete: true, rangeEvaluated: true });
      await delay(0);
      expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: true, rangeEvaluated: true });
    } finally { queue.close(); input.destroy(); }
  });
  it("acknowledges only the requested native barrier after queued writes finish", async () => {
    const input = new PassThrough(), write = vi.fn(), requestNative = vi.fn();
    let persist!: () => void; const written = new Promise<void>(resolve => { persist = resolve; });
    const queue = recorderCheckpoints({ input, write, requestNative, persist: () => written });
    try {
      input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n"); expect(requestNative).toHaveBeenCalledWith(id);
      queue.acknowledge({ kind: "session.checkpoint", id: "unrelated", complete: true }); expect(write).not.toHaveBeenCalled();
      queue.acknowledge({ kind: "session.checkpoint", id, complete: true }); expect(write).not.toHaveBeenCalled();
      persist(); await delay(0); expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: true });
    } finally { queue.close(); input.destroy(); }
  });
  it("reports unconfirmed completion when the native provider is absent or persistence fails", async () => {
    const input = new PassThrough(), write = vi.fn();
    const queue = recorderCheckpoints({ input, write, persist: async () => { throw new Error("disk failure"); } });
    try {
      input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n"); await delay(0);
      expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: false });
    } finally { queue.close(); input.destroy(); }
  });
  it("bounds a nonresponding provider and releases pending controls on shutdown", async () => {
    const input = new PassThrough(), write = vi.fn();
    const queue = recorderCheckpoints({ input, write, requestNative: () => {}, persist: async () => {}, timeoutMs: 5 });
    input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n"); await delay(15);
    expect(JSON.parse(write.mock.calls[0]![0].slice(22)).complete).toBe(false);
    queue.close(); input.destroy();
  });
  it("keeps the durable watermark and deduplicates acknowledgements while persistence is pending", async () => {
    const input = new PassThrough(), write = vi.fn();
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const through = "2026-10-21T01:00:00.000Z";
    const position = { through, watermark: { nativeSessionId: "a".repeat(32), nativeSequence: 10, captureSequence: 10, recordingSequence: 2, bytes: 512 }, issues: [] };
    const persist = vi.fn(async () => { await gate; return position; });
    const queue = recorderCheckpoints({ input, write, requestNative: () => {}, persist });
    try {
      const command = JSON.stringify({ kind: "checkpoint", id, from: through, through }) + "\n";
      input.write(command);
      const marker = { kind: "session.checkpoint", id, complete: true };
      queue.acknowledge(marker); queue.acknowledge(marker); input.write(command);
      expect(persist).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled();
      finish(); await delay(0);
      expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: true, rangeEvaluated: false, ...position });
    } finally { queue.close(); input.destroy(); }
  });
  it("keeps an ordered boundary but never certifies completeness while a native fault was throttled", async () => {
    const input = new PassThrough(), write = vi.fn();
    const position = { through: "2026-10-21T01:00:00.000Z", watermark: { nativeSessionId: "a".repeat(32), nativeSequence: 10, captureSequence: 10, recordingSequence: 2, bytes: 512 }, issues: ["enrichment_backlog"] };
    const queue = recorderCheckpoints({ input, write, requestNative: () => {}, persist: async () => position });
    try {
      input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n");
      queue.acknowledge({ kind: "session.checkpoint", id, complete: true }); await delay(0);
      expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: false, rangeEvaluated: false, ...position });
    } finally { queue.close(); input.destroy(); }
  });
  it("returns an unconfirmed result rather than an unhandled rejection for an invalid durable position", async () => {
    const input = new PassThrough(), write = vi.fn();
    const queue = recorderCheckpoints({ input, write, requestNative: () => {}, persist: async () => ({ through: "invalid",
      watermark: { nativeSessionId: "a".repeat(32), nativeSequence: 1, captureSequence: 1, recordingSequence: 1, bytes: 1 }, issues: [] }) });
    try {
      input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n");
      queue.acknowledge({ kind: "session.checkpoint", id, complete: true }); await delay(0);
      expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: false });
    } finally { queue.close(); input.destroy(); }
  });
});
