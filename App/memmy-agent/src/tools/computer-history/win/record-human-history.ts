import path from "node:path";
import { fileURLToPath } from "node:url";
import { WindowsHistoryRecorder, type WindowsRecorderOptions } from "./recorder.js";
import { WindowsPolicySession } from "./session-policy.js";
import { resolveWindowsCollector } from "./settings.js";
import { recorderHealthReporter } from "../mac/recorder-health.js";
import { contentQuality } from "./capture-quality.js";

export function parseRecorderArgs(argv: string[]): (WindowsRecorderOptions & { settingsFile?: string }) | null {
  if (argv.length === 1 && argv[0] === "--help") return null;
  const supported = new Set(["--binary", "--policy", "--settings", "--out", "--title", "--seconds", "--sample-ms", "--append", "--input-hooks", "--observation-settings", "--wechat-consent"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; ++index) {
    const flag = argv[index]!;
    if ((flag === "--append" || flag === "--input-hooks") && !values.has(flag)) { values.set(flag, "true"); continue; }
    const value = argv[++index];
    if (!supported.has(flag) || values.has(flag) || !value || value.startsWith("--")) throw new Error("windows_recorder_arguments_invalid");
    values.set(flag, value);
  }
  const policyFile = values.get("--policy");
  const settingsFile = values.get("--settings");
  const eventsFile = values.get("--out");
  if ((!policyFile && !settingsFile) || (policyFile && settingsFile) || !eventsFile || (settingsFile && !path.isAbsolute(settingsFile))) throw new Error("windows_recorder_arguments_invalid");
  const numeric = (key: string, fallback: number): number => {
    const value = values.get(key);
    if (value !== undefined && !/^[1-9][0-9]*$/u.test(value)) throw new Error("windows_recorder_arguments_invalid");
    return value === undefined ? fallback : Number(value);
  };
  return { binary: values.get("--binary"), policyFile: policyFile ?? "", settingsFile, eventsFile,
    observationSettingsFile: values.get("--observation-settings"), weChatConsentFile: values.get("--wechat-consent"), appendToRecording: values.has("--append"), inputHooks: values.has("--input-hooks"), title: values.get("--title") ?? "Computer History Windows",
    seconds: numeric("--seconds", 30), sampleMs: numeric("--sample-ms", 1000) };
}

export async function runWindowsRecorder(argv = process.argv.slice(2)): Promise<void> {
  const options = parseRecorderArgs(argv);
  if (!options) {
    console.log("Usage: node dist/tools/computer-history/win/record-human-history.js [--binary <absolute exe>] (--policy <absolute JSON> | --settings <absolute JSON>) --out <absolute JSONL> [--title <text>] [--seconds 1..86400] [--sample-ms 200..60000] [--input-hooks] [--append]");
    return;
  }
  const binary = resolveWindowsCollector(options.binary);
  const policySession = options.settingsFile ? await WindowsPolicySession.create(options.settingsFile, binary, options.observationSettingsFile) : null;
  const health = recorderHealthReporter();
  let recorder: WindowsHistoryRecorder;
  try {
    recorder = await WindowsHistoryRecorder.start({ ...options, binary, policyFile: policySession?.file ?? options.policyFile,
      // Report only persisted events. The native Windows collector has no heartbeat protocol.
      onEvent: (event) => {
        health.report("event_recorded", { timestamp: event.timestamp });
        const quality = contentQuality(event);
        if (quality) console.log("[recorder-quality] " + JSON.stringify(quality));
      },
    });
  }
  catch (error) { health.close(); await policySession?.dispose(); throw error; }
  let refreshError: Error | null = null;
  policySession?.monitor(recorder, (error) => { refreshError = error; });
  const status = () => console.log(JSON.stringify({ kind: "recorder.state", state: recorder.state }));
  const diagnostic = (error: unknown) => {
    console.error(error instanceof Error && /^windows_[a-z_]+$/u.test(error.message) ? error.message : "windows_recorder_failed");
  };
  const onOutputError = () => { process.exitCode = 1; void recorder.stop().catch(() => {}); };
  process.stdout.on("error", onOutputError);
  status();
  let pending = Promise.resolve();
  let line = "";
  let overflow = false;
  const execute = (command: string) => {
    if (command === "stop") { void recorder.stop().catch(diagnostic); return; }
    if (command !== "pause" && command !== "resume") { diagnostic(new Error("windows_control_unknown")); return; }
    pending = pending.then(async () => {
      if (recorder.state === "stopping" || recorder.state === "stopped" || recorder.state === "failed") return;
      await (command === "pause" ? recorder.pause() : recorder.resume());
      status();
    }).catch(diagnostic);
  };
  const onData = (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 10) {
        if (overflow) diagnostic(new Error("windows_control_too_long")); else execute(line.trim());
        line = ""; overflow = false;
      } else if (line.length >= 128 || byte > 127) { overflow = true; }
      else if (!overflow) line += String.fromCharCode(byte);
    }
  };
  const onEnd = () => { void recorder.endInput().catch(diagnostic); };
  const onInterrupt = () => { void recorder.stop().catch(diagnostic); };
  process.stdin.on("data", onData);
  process.stdin.once("end", onEnd);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try { await recorder.finished; if (refreshError) throw refreshError; status(); }
  finally {
    health.close();
    process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.pause();
    process.off("SIGINT", onInterrupt); process.off("SIGTERM", onInterrupt);
    process.stdout.off("error", onOutputError);
    await policySession?.dispose();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWindowsRecorder().catch((error) => {
    console.error(error instanceof Error && /^windows_[a-z_]+$/u.test(error.message) ? error.message : "windows_recorder_failed");
    process.exitCode = 1;
  });
}
