import crypto from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RecorderLaunch } from "./platform-driver.js";
import { recorderRotationRequest, recorderRotationResult } from "./recorder-checkpoint.js";

/** Only current managed recorders advertise this; older CLIs keep their restart path. */
export const CONTINUOUS_RECORDER_CAPABILITY = '[recorder-capabilities] {"continuousOutput":true}';

export function rotateRecorderOutput(child: ChildProcessWithoutNullStreams,
  input: Pick<RecorderLaunch, "eventsFile" | "title">, timeoutMs = 12_000): Promise<void> {
  const command = recorderRotationRequest.parse({ kind: "rotate", id: crypto.randomUUID(), ...input });
  return new Promise((resolve, reject) => {
    let buffer = "", discard = false, done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      child.stdout.off("data", onData); child.off("exit", failed); child.off("error", failed);
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new Error("Recorder output rotation could not be confirmed"));
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
          if (!recorderRotationResult.parse(result).complete) return failed();
          finish();
        } catch { failed(); }
      }
    };
    const timer = setTimeout(failed, timeoutMs); timer.unref();
    child.stdout.on("data", onData); child.once("exit", failed); child.once("error", failed);
    if (!child.stdin.writable || child.exitCode !== null || child.signalCode !== null) return failed();
    child.stdin.write(JSON.stringify(command) + "\n", error => { if (error) failed(); });
  });
}
