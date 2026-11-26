import { on } from "node:events";
import { Worker } from "node:worker_threads";
import type { PolicyEvidenceRecovery, PolicyMaintenanceAlgorithm } from "../evolution/policy-evidence-maintenance.js";

type SkillTask = { type: "skills" | "retrieval"; pageSize: number };
type PolicyTask = { type: "policies"; at: string; limit: number };
export type MaintenanceTask = SkillTask | PolicyTask;

interface Settings {
  embedAfterCapture: boolean;
  algorithm?: PolicyMaintenanceAlgorithm;
}

export interface MaintenanceEnvironment {
  writeEnabled: Int32Array;
  acquire: (signal: AbortSignal) => Promise<() => void>;
  settings: () => Settings;
}

export type MaintenanceCommand = { type: "step"; settings: Settings } | { type: "stop" };
export type MaintenanceReply = { type: "next" } | { type: "done"; result?: PolicyEvidenceRecovery };

/** A worker holds write admission for one step, including the initial connection setup. */
export function runMaintenanceWorker(path: string, task: SkillTask, signal: AbortSignal, env: MaintenanceEnvironment): Promise<void>;
export function runMaintenanceWorker(path: string, task: PolicyTask, signal: AbortSignal, env: MaintenanceEnvironment): Promise<PolicyEvidenceRecovery>;
export async function runMaintenanceWorker(
  path: string, task: MaintenanceTask, signal: AbortSignal, env: MaintenanceEnvironment
): Promise<void | PolicyEvidenceRecovery> {
  let release = await env.acquire(signal);
  try {
    signal.throwIfAborted();
    const source = import.meta.url.endsWith(".ts");
    const url = new URL(source ? "./startup-maintenance-worker.ts" : "./startup-maintenance-worker.js", import.meta.url);
    const workerData = { path, task, writeEnabled: env.writeEnabled };
    const worker = source
      ? new Worker(`import('tsx/esm/api').then(({register})=>{register();return import(${JSON.stringify(url.href)})})`,
          { eval: true, workerData })
      : new Worker(url, { workerData });
    const exited = new Promise<number>(resolve => worker.once("exit", resolve));
    const stop = () => worker.postMessage({ type: "stop" } satisfies MaintenanceCommand);
    signal.addEventListener("abort", stop, { once: true });
    let algorithmSent: PolicyMaintenanceAlgorithm | undefined;
    const replies = on(worker, "message", { close: ["exit"] });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { algorithm, embedAfterCapture } = env.settings();
        worker.postMessage({ type: "step", settings: { embedAfterCapture,
          ...(algorithm !== algorithmSent ? { algorithm } : {}) } } satisfies MaintenanceCommand);
        algorithmSent = algorithm;
        const message = await replies.next();
        signal.throwIfAborted();
        if (message.done) throw new Error(`Startup maintenance worker (${task.type}) exited before completing`);
        const reply = message.value[0] as MaintenanceReply;
        if (reply.type === "done") {
          if (await exited !== 0 || (task.type === "policies" && !reply.result)) {
            throw new Error(`Startup maintenance worker (${task.type}) failed to complete`);
          }
          return reply.result;
        }
        release();
        release = await env.acquire(signal);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      await exited;
      await replies.return?.();
    }
  } finally {
    release();
  }
}
