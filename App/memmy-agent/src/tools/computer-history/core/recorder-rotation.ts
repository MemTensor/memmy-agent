import crypto from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { recorderRotationRequest, recorderRotationResult } from "./recorder-checkpoint.js";

/** Only current managed recorders advertise this; older CLIs keep their restart path. */
export const CONTINUOUS_RECORDER_CAPABILITY = '[recorder-capabilities] {"continuousOutput":true}';

export class RecorderRotationDeclined extends Error {}

export function rotateRecorderOutput(child: ChildProcessWithoutNullStreams,
  input: { eventsFile: string; title: string }, timeoutMs = 12_000): Promise<void> {
  const command = recorderRotationRequest.parse({ kind: "rotate", id: crypto.randomUUID(), ...input });
  return new Promise((resolve, reject) => {
    let buffer = "", discard = false, done = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (retry) clearTimeout(retry);
      child.stdout.off("data", onData); child.stdin.off("error", failed); child.off("exit", failed); child.off("error", failed);
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new Error("Recorder output rotation could not be confirmed"));
    const send = () => {
      retry = null;
      if (!child.stdin.writable || child.exitCode !== null || child.signalCode !== null) return failed();
      child.stdin.write(JSON.stringify(command) + "\n", error => { if (error) failed(); });
    };
    const onData = (chunk: Buffer) => {
      for (const piece of chunk.toString("utf8").split(/(?<=\n)/u)) {
        if (!discard) buffer += piece;
        if (buffer.length > 4_096) { buffer = ""; discard = true; }
        if (!piece.endsWith("\n")) continue;
        const line = discard ? "" : buffer.trimEnd();
        buffer = ""; discard = false;
        if (!line.startsWith("[recorder-rotation] ")) continue;
        try {
          const result = JSON.parse(line.slice("[recorder-rotation] ".length));
          if (result.id !== command.id) continue;
          const ack = recorderRotationResult.parse(result);
          if ("retrySync" in ack) {
            // The writer has switched. Retry the same target under the original deadline.
            if (!done && !retry) retry = setTimeout(send, 250);
            continue;
          }
          if (!ack.complete) {
            finish(new RecorderRotationDeclined("Recorder retained the previous output"));
            continue;
          }
          finish();
        } catch { failed(); }
      }
    };
    const timer = setTimeout(failed, timeoutMs); timer.unref();
    child.stdout.on("data", onData); child.stdin.once("error", failed); child.once("exit", failed); child.once("error", failed);
    send();
  });
}
