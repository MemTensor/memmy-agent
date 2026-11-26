import { Worker } from "node:worker_threads";
import type { PolicyEvidenceRecovery, PolicyMaintenanceAlgorithm } from "../evolution/policy-evidence-maintenance.js";

type SkillTask = { type: "skills"; pageSize: number };
type PolicyTask = { type: "policies"; at: string; limit: number };
export type MaintenanceTask = SkillTask | PolicyTask;

interface Settings {
  enableMemoryAdd: boolean;
  embedAfterCapture: boolean;
  algorithm?: PolicyMaintenanceAlgorithm;
}

export type MaintenanceCommand = { type: "step"; settings: Settings } | { type: "stop" };
export type MaintenanceReply = { type: "next" } | { type: "done"; result?: PolicyEvidenceRecovery };

/** Each step starts after the previous one commits or rolls back. Stop acknowledges by closing the connection. */
export function runMaintenanceWorker(path: string, task: SkillTask, signal: AbortSignal, settings: () => Settings): Promise<void>;
export function runMaintenanceWorker(path: string, task: PolicyTask, signal: AbortSignal, settings: () => Settings): Promise<PolicyEvidenceRecovery>;
export async function runMaintenanceWorker(
  path: string, task: MaintenanceTask, signal: AbortSignal, settings: () => Settings
): Promise<void | PolicyEvidenceRecovery> {
  signal.throwIfAborted();
  const source = import.meta.url.endsWith(".ts");
  const url = new URL(source ? "./startup-maintenance-worker.ts" : "./startup-maintenance-worker.js", import.meta.url);
  const workerData = { path, task };
  const worker = source
    ? new Worker(`import('tsx/esm/api').then(({register})=>{register();return import(${JSON.stringify(url.href)})})`,
        { eval: true, workerData })
    : new Worker(url, { workerData });
  return new Promise((resolve, reject) => {
    let done: Extract<MaintenanceReply, { type: "done" }> | undefined;
    let failure: unknown;
    let lastAlgorithm: PolicyMaintenanceAlgorithm | undefined;
    const step = () => {
      if (signal.aborted) {
        worker.postMessage({ type: "stop" } satisfies MaintenanceCommand);
        return;
      }
      const { algorithm, ...flags } = settings();
      const changed = algorithm !== lastAlgorithm;
      lastAlgorithm = algorithm;
      const command: MaintenanceCommand = { type: "step", settings: changed ? { ...flags, algorithm } : flags };
      worker.postMessage(command);
    };
    signal.addEventListener("abort", step, { once: true });
    worker.on("message", (reply: MaintenanceReply) => {
      if (reply.type === "done") done = reply;
      else if (!signal.aborted) step();
    });
    worker.once("error", error => { failure = error; });
    worker.once("exit", code => {
      signal.removeEventListener("abort", step);
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0 || !done || (task.type === "policies" && !done.result)) {
        reject(failure ?? new Error(`Startup maintenance worker (${task.type}) exited (${code})`));
      } else resolve(done.result);
    });
    step();
  });
}
