import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeGoalStates } from "../src/migrations/v1.0.7/0003-normalize-goal-state.js";

const roots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-goal-migration-"));
  roots.push(root);
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir);
  return {
    root,
    sessionsDir,
    context: {
      profileWorkspace: root,
      sessionsDir,
      runtimeConfigFile: path.join(root, "config.yaml"),
      sessionDagDir: path.join(root, "session-dag"),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
}

function metadataRecord(
  key: string,
  goalState: unknown,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recordType: "metadata",
    key,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    metadata: { ...metadata, goalState },
    lastConsolidated: 0,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("normalize GoalState migration", () => {
  it("converts legacy metadata, preserves message bytes, and is idempotent", async () => {
    const { sessionsDir, context } = await fixture();
    const file = path.join(sessionsDir, "websocket_chat-1.jsonl");
    const message = '{"role":"user","content":"keep exact spacing"}\n';
    const metadata = {
      recordType: "metadata",
      key: "websocket:chat-1",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      metadata: {
        goalState: {
          status: "active",
          objective: "Finish the migration",
          uiSummary: "migration",
          startedAt: "2026-07-01T01:00:00.000Z",
        },
      },
      lastConsolidated: 0,
    };
    await fs.writeFile(file, `${JSON.stringify(metadata)}\n${message}`);

    await expect(normalizeGoalStates(context)).resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });
    const first = await fs.readFile(file, "utf8");
    const firstNewline = first.indexOf("\n");
    const line = first.slice(0, firstNewline);
    const migrated = JSON.parse(line!);
    expect(migrated.metadata.goalState).toEqual({
      goalId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      objective: "Finish the migration",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2026-07-01T01:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(migrated.metadata.goalRoute).toEqual({ channel: "websocket", chatId: "chat-1" });
    expect(first.slice(firstNewline + 1)).toBe(message);

    await expect(normalizeGoalStates(context)).resolves.toEqual({ scanned: 1, changed: 0, ignored: 1 });
    await expect(fs.readFile(file, "utf8")).resolves.toBe(first);
  });

  it("blocks an active Goal whose route cannot be recovered", async () => {
    const { sessionsDir, context } = await fixture();
    const file = path.join(sessionsDir, "unified_default.jsonl");
    await fs.writeFile(file, `${JSON.stringify({
      recordType: "metadata",
      key: "unified:default",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      metadata: { goalState: JSON.stringify({ status: "active", objective: "Recover me" }) },
      lastConsolidated: 0,
    })}\n`);

    await normalizeGoalStates(context);
    const migrated = JSON.parse((await fs.readFile(file, "utf8")).trim());
    expect(migrated.metadata.goalState.status).toBe("blocked");
    expect(migrated.metadata).not.toHaveProperty("goalRoute");
    expect(context.logger.warn).toHaveBeenCalledWith(
      "migration_goal_route_unavailable",
      expect.objectContaining({ errorCode: "goal_route_unavailable" }),
    );
  });

  it("maps complete active/completed fields with legacy timestamp priority and removes legacy-only fields", async () => {
    const { sessionsDir, context } = await fixture();
    const preservedGoalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    await fs.writeFile(path.join(sessionsDir, "a.jsonl"), `${JSON.stringify(metadataRecord(
      "telegram:chat-a",
      {
        goalId: preservedGoalId,
        objective: "Active objective",
        status: "active",
        tokenBudget: 500,
        tokensUsed: 12,
        timeUsedSeconds: 3,
        createdAt: "2026-06-01T00:00:00.000Z",
        startedAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
        uiSummary: "remove",
      },
      { goalRoute: { channel: "telegram", chatId: "chat-a" } },
    ))}\n`);
    await fs.writeFile(path.join(sessionsDir, "b.jsonl"), `${JSON.stringify(metadataRecord(
      "websocket:chat-b",
      {
        objective: "Completed objective",
        status: "completed",
        tokenBudget: -1,
        tokensUsed: -1,
        timeUsedSeconds: Number.NaN,
        startedAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
        completedAt: "2026-05-03T00:00:00.000Z",
        recap: "remove",
      },
      { goalRoute: { channel: "websocket", chatId: "chat-b" } },
    ))}\n`);

    await expect(normalizeGoalStates(context)).resolves.toEqual({ scanned: 2, changed: 2, ignored: 0 });
    const active = JSON.parse((await fs.readFile(path.join(sessionsDir, "a.jsonl"), "utf8")).trim()).metadata;
    const completed = JSON.parse((await fs.readFile(path.join(sessionsDir, "b.jsonl"), "utf8")).trim()).metadata;
    expect(active.goalState).toEqual({
      goalId: preservedGoalId,
      objective: "Active objective",
      status: "active",
      tokenBudget: 500,
      tokensUsed: 12,
      timeUsedSeconds: 3,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });
    expect(active.goalRoute).toEqual({ channel: "telegram", chatId: "chat-a" });
    expect(completed.goalState).toEqual({
      goalId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      objective: "Completed objective",
      status: "completed",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });
    expect(completed).not.toHaveProperty("goalRoute");
  });

  it("parses string GoalState, generates a stable goalId, and removes invalid state without logging content", async () => {
    const { sessionsDir, context } = await fixture();
    const legacy = metadataRecord(
      "slack:C123",
      JSON.stringify({ status: "active", objective: "Stable objective", startedAt: "2026-06-01T00:00:00.000Z" }),
    );
    const invalid = metadataRecord(
      "slack:C999",
      { status: "unknown", objective: "secret objective" },
      { goalRoute: { channel: "slack", chatId: "C999" } },
    );
    await fs.writeFile(path.join(sessionsDir, "a.jsonl"), `${JSON.stringify(legacy)}\n`);
    await fs.writeFile(path.join(sessionsDir, "b.jsonl"), `${JSON.stringify(legacy)}\n`);
    await fs.writeFile(path.join(sessionsDir, "invalid.jsonl"), `${JSON.stringify(invalid)}\n`);

    await normalizeGoalStates(context);
    const firstId = JSON.parse((await fs.readFile(path.join(sessionsDir, "a.jsonl"), "utf8")).trim()).metadata.goalState.goalId;
    const secondId = JSON.parse((await fs.readFile(path.join(sessionsDir, "b.jsonl"), "utf8")).trim()).metadata.goalState.goalId;
    const removed = JSON.parse((await fs.readFile(path.join(sessionsDir, "invalid.jsonl"), "utf8")).trim()).metadata;
    expect(firstId).toBe(secondId);
    expect(removed).not.toHaveProperty("goalState");
    expect(removed).not.toHaveProperty("goalRoute");
    expect(JSON.stringify(context.logger.warn.mock.calls)).not.toContain("secret objective");
  });

  it("preserves mode, CRLF, missing trailing newline, and all message bytes", async () => {
    const { sessionsDir, context } = await fixture();
    const file = path.join(sessionsDir, "bytes.jsonl");
    const suffix = Buffer.from('{"role":"user","content":"exact 🥟 bytes"}', "utf8");
    const source = Buffer.concat([
      Buffer.from(`${JSON.stringify(metadataRecord("websocket:bytes", { status: "active", objective: "Bytes" }))}\r\n`),
      suffix,
    ]);
    await fs.writeFile(file, source, { mode: 0o666 });
    const originalMode = (await fs.stat(file)).mode & 0o777;

    await normalizeGoalStates(context);

    const output = await fs.readFile(file);
    const metadataEnd = output.indexOf(Buffer.from("\r\n"));
    expect(output.subarray(metadataEnd + 2)).toEqual(suffix);
    expect(output.subarray(-1)[0]).toBe(suffix.at(-1));
    expect((await fs.stat(file)).mode & 0o777).toBe(originalMode);
  });

  it("does not follow JSONL symlinks", async () => {
    if (process.platform === "win32") return;
    const { root, sessionsDir, context } = await fixture();
    const target = path.join(root, "outside.jsonl");
    const source = `${JSON.stringify(metadataRecord("websocket:outside", { status: "active", objective: "Outside" }))}\n`;
    await fs.writeFile(target, source);
    await fs.symlink(target, path.join(sessionsDir, "linked.jsonl"));

    await expect(normalizeGoalStates(context)).resolves.toEqual({ scanned: 0, changed: 0, ignored: 0 });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(source);
  });

  it("detects concurrent source changes, removes temporary output, and succeeds on retry", async () => {
    const { sessionsDir, context } = await fixture();
    const file = path.join(sessionsDir, "racing.jsonl");
    const source = `${JSON.stringify(metadataRecord("websocket:racing", { status: "active", objective: "Race" }))}\n`;
    await fs.writeFile(file, source);

    await expect(normalizeGoalStates(context, {
      beforeCommit: async (candidate) => {
        await fs.appendFile(candidate, '{"role":"user","content":"concurrent"}\n');
      },
    })).rejects.toMatchObject({ code: "migration_source_changed" });
    expect((await fs.readdir(sessionsDir)).some((name) => name.endsWith(".tmp"))).toBe(false);

    await expect(normalizeGoalStates(context)).resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect(await fs.readFile(file, "utf8")).toContain('"content":"concurrent"');
  });

  it("cleans only strict temporary remnants for this migration", async () => {
    const { sessionsDir, context } = await fixture();
    const stale = `.legacy.jsonl.v1.0.7-0003.123.${randomUUID()}.tmp`;
    const unrelated = [
      ".legacy.jsonl.v1.0.7-0004.123.00000000-0000-4000-8000-000000000000.tmp",
      ".legacy.jsonl.v1.0.7-0003.123.not-a-uuid.tmp",
      "ordinary.tmp",
    ];
    await fs.writeFile(path.join(sessionsDir, stale), "stale");
    await Promise.all(unrelated.map((name) => fs.writeFile(path.join(sessionsDir, name), "keep")));

    await normalizeGoalStates(context);

    const remaining = await fs.readdir(sessionsDir);
    expect(remaining).not.toContain(stale);
    expect(remaining).toEqual(expect.arrayContaining(unrelated));
  });
});
