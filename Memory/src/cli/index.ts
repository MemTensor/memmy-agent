#!/usr/bin/env node
// Must load first: resolve MEMMY_CLOUD_SERVICE from external env, packaged manifest, or development .env.
import "./load-env.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLI_ANALYTICS_EVENTS,
  createCliAnalytics,
  createNoopCliAnalytics,
  elapsedMs,
  errorCodeFromUnknown,
  resolveCliAnalyticsParams,
  shouldTrackCliAnalytics,
  type CliLifecycleAnalytics,
} from "./analytics.js";
import { formatOutput, runCommand } from "./commands.js";

export type MainDeps = {
  analytics?: CliLifecycleAnalytics;
  now?: () => number;
  argvPath?: string;
};

export async function main(argv = process.argv.slice(2), deps: MainDeps = {}): Promise<void> {
  const startedAt = (deps.now ?? Date.now)();
  const analytics = resolveMainAnalytics(argv, deps);
  const baseParams = resolveCliAnalyticsParams(argv, { argvPath: deps.argvPath });
  if (shouldTrackCliAnalytics(argv)) {
    analytics.track(CLI_ANALYTICS_EVENTS.invoked, baseParams);
  }

  try {
    const result = await runCommand({ argv });
    process.stdout.write(formatOutput(result));
    if (shouldTrackCliAnalytics(argv)) {
      await analytics.trackAwait(CLI_ANALYTICS_EVENTS.completed, {
        ...baseParams,
        exit_code: 0,
        duration_ms: elapsedMs(startedAt),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (shouldTrackCliAnalytics(argv)) {
      await analytics.trackAwait(CLI_ANALYTICS_EVENTS.failed, {
        ...baseParams,
        exit_code: 1,
        duration_ms: elapsedMs(startedAt),
        error_code: errorCodeFromUnknown(error),
      });
    }
    if (isDirectRun()) {
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

function resolveMainAnalytics(argv: string[], deps: MainDeps): CliLifecycleAnalytics {
  if (deps.analytics) return deps.analytics;
  if (!shouldTrackCliAnalytics(argv)) {
    return createNoopCliAnalytics();
  }
  // Avoid accidental network calls from CLI tests that invoke main().
  if (process.env.VITEST) {
    return createCliAnalytics({ baseUrl: null });
  }
  return createCliAnalytics();
}

export function isDirectRun(argvPath = process.argv[1], modulePath = fileURLToPath(import.meta.url)): boolean {
  return argvPath !== undefined && realpathOrSelf(argvPath) === realpathOrSelf(modulePath);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (isDirectRun()) {
  void main();
}
