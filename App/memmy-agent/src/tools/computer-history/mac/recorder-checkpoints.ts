import readline from "node:readline";
import type { Readable } from "node:stream";
import type { CaptureRange } from "../core/event-capture-source.js";
import { checkpointRequest, persistedCheckpoint, recorderRotationRequest, type PersistedCheckpoint } from "../core/recorder-checkpoint.js";
import type { z } from "zod";

type DurablePosition = Pick<PersistedCheckpoint, "through" | "watermark" | "issues">;

/** Acknowledgement follows the native barrier, queued normalization and fsync. */
export function recorderCheckpoints(options: {
  input: Readable; requestNative?: (id: string, range?: CaptureRange) => void;
  persist: (event?: Record<string, unknown>, through?: string) => Promise<DurablePosition | void>;
  rotate?: (command: z.infer<typeof recorderRotationRequest>, event: Record<string, unknown>, through: string) => Promise<void>;
  write: (line: string) => void; timeoutMs?: number;
}) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; through: string; finishing: boolean;
    rotation?: z.infer<typeof recorderRotationRequest> }>();
  const lines = readline.createInterface({ input: options.input });
  let closed = false;
  const finish = async (id: string, complete: boolean, rangeEvaluated = false, event?: Record<string, unknown>) => {
    const request = pending.get(id);
    if (!request || request.finishing) return;
    request.finishing = true; clearTimeout(request.timer);
    let result: Record<string, unknown>;
    try {
      if (request.rotation) {
        if (!complete || !event || !options.rotate) throw new Error("Native rotation boundary unavailable");
        await options.rotate(request.rotation, event, request.through);
        result = { id, complete: true };
      } else {
        const durable = await options.persist(event, request.through);
        if (durable?.issues.length) complete = false;
        result = durable ? persistedCheckpoint.parse({ id, complete, rangeEvaluated, ...durable })
          : { id, complete, ...(rangeEvaluated ? { rangeEvaluated: true } : {}) };
      }
    }
    catch { result = { id, complete: false }; }
    pending.delete(id);
    if (!closed) options.write((request.rotation ? "[recorder-rotation] " : "[recorder-checkpoint] ") + JSON.stringify(result));
  };
  lines.on("line", line => {
    if (closed || line.length > 32_768 || pending.size >= 16) return;
    try {
      const value = JSON.parse(line);
      const rotation = value.kind === "rotate" ? recorderRotationRequest.parse(value) : undefined;
      if (!rotation && line.length > 512) return;
      const command = rotation ? { kind: "checkpoint" as const, id: rotation.id, from: undefined, through: undefined }
        : checkpointRequest.parse(value);
      if (pending.has(command.id)) return;
      if (rotation && (!options.rotate || [...pending.values()].some(request => request.rotation))) {
        options.write("[recorder-rotation] " + JSON.stringify({ id: command.id, complete: false })); return;
      }
      const range = command.from ? { from: command.from, ...(command.through ? { through: command.through } : {}) } : undefined;
      const timer = setTimeout(() => { void finish(command.id, false); }, options.timeoutMs ?? 9_000);
      timer.unref(); pending.set(command.id, { timer, through: command.through ?? new Date().toISOString(), finishing: false,
        ...(rotation ? { rotation } : {}) });
      if (!options.requestNative) { void finish(command.id, false); return; }
      try { range ? options.requestNative(command.id, range) : options.requestNative(command.id); } catch { void finish(command.id, false); }
    } catch { /* Recorder stdin carries controls, never executable instructions. */ }
  });
  return {
    acknowledge(event: Record<string, unknown>): boolean {
      if (event.kind !== "session.checkpoint") return false;
      if (typeof event.id === "string") void finish(event.id, event.complete === true, event.rangeEvaluated === true, event);
      return true;
    },
    close() { closed = true; lines.close(); for (const request of pending.values()) clearTimeout(request.timer); pending.clear(); }
  };
}
