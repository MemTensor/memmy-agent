import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentTokenStatsService } from "../src/service/agent-token-stats-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agent token stats service", () => {
  it("parses nested Pi usage and groups usage by month", async () => {
    const homeDir = await createHome();
    const piDirectory = path.join(homeDir, ".pi", "agent", "sessions", "--workspace-demo--");
    await mkdir(piDirectory, { recursive: true });
    await writeJsonl(path.join(piDirectory, "pi-session.jsonl"), [
      { type: "session", timestamp: "2026-06-01T00:00:00.000Z", cwd: "/workspace/demo" },
      {
        type: "message",
        timestamp: "2026-06-12T10:00:00.000Z",
        message: {
          role: "assistant",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 5,
            reasoning: 7,
            totalTokens: 155,
            cost: { total: 0.42 }
          }
        }
      },
      {
        type: "assistant",
        timestamp: "2026-07-02T10:00:00.000Z",
        usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60 },
        cost: { total: 0.1 }
      }
    ]);

    const response = await createAgentTokenStatsService({ homeDir, cacheTtlMs: 0 }).getStats();
    const project = response.projects.find((item) => item.project === "/workspace/demo");
    const pi = project?.agents.find((agent) => agent.agent === "pi");

    expect(pi).toMatchObject({
      sessions: 1,
      apiCalls: 2,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      reasoningTokens: 7,
      totalTokens: 215
    });
    expect(pi?.cost).toBeCloseTo(0.52);
    expect(response.monthly.map((entry) => entry.month)).toEqual(["2026-07", "2026-06"]);
    expect(agentForMonth(response, "2026-06", "/workspace/demo", "pi")).toMatchObject({
      sessions: 1,
      apiCalls: 1,
      totalTokens: 155
    });
    expect(agentForMonth(response, "2026-07", "/workspace/demo", "pi")).toMatchObject({
      sessions: 1,
      apiCalls: 1,
      totalTokens: 60
    });
  });

  it("uses the last cumulative Codex usage and assigns it to its timestamp month", async () => {
    const homeDir = await createHome();
    const codexDirectory = path.join(homeDir, ".codex", "sessions", "2026", "07", "14");
    await mkdir(codexDirectory, { recursive: true });
    await writeJsonl(path.join(codexDirectory, "rollout-test.jsonl"), [
      { type: "session_meta", timestamp: "2026-07-14T09:00:00.000Z", payload: { cwd: "/workspace/demo" } },
      tokenCount("2026-07-14T09:01:00.000Z", 100),
      tokenCount("2026-07-14T09:02:00.000Z", 250)
    ]);

    const response = await createAgentTokenStatsService({ homeDir, cacheTtlMs: 0 }).getStats();
    expect(agentForMonth(response, "2026-07", "/workspace/demo", "codex")).toMatchObject({
      sessions: 1,
      apiCalls: 1,
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 250
    });
  });
});

async function createHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memmy-token-stats-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function tokenCount(timestamp: string, totalTokens: number) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: totalTokens - 50,
          output_tokens: 50,
          cached_input_tokens: 25,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 5,
          total_tokens: totalTokens
        }
      }
    }
  };
}

function agentForMonth(
  response: Awaited<ReturnType<ReturnType<typeof createAgentTokenStatsService>["getStats"]>>,
  month: string,
  project: string,
  agent: "pi" | "codex" | "claude_code"
) {
  return response.monthly
    .find((entry) => entry.month === month)
    ?.projects.find((item) => item.project === project)
    ?.agents.find((item) => item.agent === agent);
}
