import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildHelpText,
  builtinCommandPalette,
  cmdGoal,
  cmdStop,
} from "../../src/command/builtin.js";
import { CommandContext } from "../../src/command/router.js";
import { Config } from "../../src/config/schema.js";
import { AgentLoop } from "../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";

function makeLoop(): AgentLoop {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-goal-command-"));
  return new AgentLoop({
    workspace,
    config: new Config({
      fileMemory: { enabled: false },
      memmyMemory: { enabled: false },
    }),
    provider: {
      generation: { maxTokens: 4_096 },
      getDefaultModel: () => "test-model",
    },
  });
}

function context(
  loop: AgentLoop,
  raw: string,
  turnId: string | null = null,
  channel = "cli",
  metadata: Record<string, any> = {},
): CommandContext {
  const msg = new InboundMessage({
    channel,
    chatId: "direct",
    senderId: "user",
    content: raw,
    metadata,
  });
  const session = loop.sessions.getOrCreate(msg.sessionKey);
  return new CommandContext({
    msg,
    session,
    key: msg.sessionKey,
    raw,
    args: raw.startsWith("/goal ") ? raw.slice("/goal ".length) : "",
    loop,
    turnId,
  });
}

describe("/goal command", () => {
  it("returns the same authoritative state for bare and status forms", async () => {
    const loop = makeLoop();
    const bare = await cmdGoal(context(loop, "/goal"));
    const status = await cmdGoal(context(loop, "/goal status"));

    expect(bare.content).toBe(status.content);
    expect(bare.content).toContain('"goal_id": null');
    expect(bare.content).toContain("Available: create <objective>");
  });

  it("documents every control and exposes the new command in global help", async () => {
    const loop = makeLoop();
    const help = await cmdGoal(context(loop, "/goal help"));

    for (const command of ["status", "create", "pause", "resume", "edit", "budget", "clear"]) {
      expect(help.content).toContain(`/goal ${command}`);
    }
    expect(buildHelpText()).toContain("/goal [status|help|create <objective>|pause|resume|edit <objective>|budget <n|none>|clear]");
    expect(buildHelpText()).not.toContain("long_task");
    expect(builtinCommandPalette()).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "/goal", title: "Manage persistent goal" }),
    ]));
  });

  it("supports explicit create for objectives beginning with a reserved subcommand", async () => {
    const loop = makeLoop();
    const rejected = await cmdGoal(context(loop, "/goal pause migration", "turn-rejected"));
    expect(rejected.content).toContain("invalid_transition");

    const created = await cmdGoal(context(loop, "/goal create pause migration", "turn-create"));
    expect(created.content).toContain("Goal created.");
    expect(loop.goalRuntime.get("cli:direct")?.objective).toBe("pause migration");
  });

  it("preserves multiline formatting in an explicitly created objective", async () => {
    const loop = makeLoop();
    await cmdGoal(context(loop, "/goal create first line\n\n- keep this item", "turn-create"));

    expect(loop.goalRuntime.get("cli:direct")?.objective).toBe(
      "first line\n\n- keep this item",
    );
  });

  it("marks only successful WebUI Goal creation acknowledgements as hidden", async () => {
    const webuiLoop = makeLoop();
    const created = await cmdGoal(context(
      webuiLoop,
      "/goal create ship it",
      "turn-webui",
      "websocket",
      { webui: true },
    ));
    expect(created.metadata.webuiGoalCreateAck).toBe(true);
    expect(created.content).toContain("Goal created.");

    const cliLoop = makeLoop();
    const cliCreated = await cmdGoal(context(cliLoop, "/goal create ship it", "turn-cli"));
    expect(cliCreated.metadata.webuiGoalCreateAck).toBeUndefined();

    const failed = await cmdGoal(context(
      webuiLoop,
      "/goal create another goal",
      "turn-failed",
      "websocket",
      { webui: true },
    ));
    expect(failed.content).toContain("Goal command failed:");
    expect(failed.metadata.webuiGoalCreateAck).toBeUndefined();
  });

  it("covers pause, edit, budget, resume, and clear state restrictions", async () => {
    const loop = makeLoop();
    await cmdGoal(context(loop, "/goal create ship it", "turn-create"));
    const activeEdit = await cmdGoal(context(loop, "/goal edit change it"));
    expect(activeEdit.content).toContain("invalid_transition");

    expect((await cmdGoal(context(loop, "/goal pause"))).content).toContain("Goal paused.");
    expect((await cmdGoal(context(loop, "/goal edit ship and verify it"))).content).toContain("Goal updated.");
    expect((await cmdGoal(context(loop, "/goal budget 9000"))).content).toContain("Goal budget updated.");
    expect((await cmdGoal(context(loop, "/goal resume"))).content).toContain("Goal resumed.");
    expect((await cmdGoal(context(loop, "/goal clear"))).content).toContain("Goal cleared.");
    expect(loop.goalRuntime.get("cli:direct")).toBeNull();
  });

  it("maps Stop to one Pause cancellation for an active Goal", async () => {
    const loop = makeLoop();
    await cmdGoal(context(loop, "/goal create ship it", "turn-create"));
    const cancel = vi.spyOn(loop, "cancelActiveTasks");
    const pause = vi.spyOn(loop.goalRuntime, "pauseAndCancel");

    const output = await cmdStop(context(loop, "/stop"));

    expect(output.content).toBe("Goal paused.");
    expect(pause).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(loop.goalRuntime.get("cli:direct")?.status).toBe("paused");
  });
});
