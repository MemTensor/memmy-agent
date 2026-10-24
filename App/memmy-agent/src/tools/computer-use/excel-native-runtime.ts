import { spawn } from "node:child_process";

export type NativeExcelRunner = (file: string, args: string[], input?: string) => Promise<string>;
export type NativeExcelStatus = {
  available: boolean;
  connected: boolean;
  workbooks: Array<{ id: string; name: string }>;
  activeWorkbookId: string | null;
};

/** Fixed native scripts receive cell data as data, never as executable source. */
export function nativeExcelRunner(options: { timeoutMs?: number; signal?: AbortSignal | null } = {}): NativeExcelRunner {
  return (file, args, input) => new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("Excel operation cancelled before dispatch")); return; }
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: Error, value?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value ?? "");
    };
    const uncertain = (reason: string) => {
      child.kill();
      finish(new Error(`Excel operation ${reason}; result may be unknown and was not replayed`));
    };
    const abort = () => uncertain("cancelled after dispatch");
    const timer = setTimeout(() => uncertain("timed out"), options.timeoutMs ?? 30_000);
    timer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { uncertain("exceeded the response limit"); return; }
      target.push(chunk);
    };
    child.stdout.on("data", chunk => collect(output, Buffer.from(chunk)));
    child.stderr.on("data", chunk => collect(errors, Buffer.from(chunk)));
    child.on("error", error => finish(error));
    child.stdin.on("error", () => { /* Exit/error below owns the outcome. */ });
    child.on("close", code => {
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (code !== 0) finish(new Error(stderr.slice(0, 500) || `Excel native connection exited (${code})`));
      else finish(undefined, Buffer.concat(output).toString("utf8").trim());
    });
    child.stdin.end(input ?? "");
  });
}

export const runNativeExcelCommand = nativeExcelRunner();
