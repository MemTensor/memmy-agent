import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSourceTool,
  buildCompleteTurns,
  normalizeAgentIdentity,
  renderFullMemorySkill,
  resolveSyncBoundaryAt,
  selectTurns,
  verifyAgentInstallation
} from "../../../../src/core/agent-runtime/tools/agent-source.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentSourceTool history selection", () => {
  it("keeps the latest 500 complete turns and exposes the 500th timestamp as the boundary", () => {
    const messages = Array.from({ length: 505 }, (_, index) => {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      return [
        {
          messageId: `user-${index}`,
          conversationId: `conversation-${index}`,
          role: "user" as const,
          content: `question ${index}`,
          createdAt
        },
        {
          messageId: `assistant-${index}`,
          conversationId: `conversation-${index}`,
          role: "assistant" as const,
          content: `answer ${index}`,
          createdAt
        }
      ];
    }).flat();

    const selected = selectTurns(buildCompleteTurns(messages), "initial_subset", null);

    expect(selected).toHaveLength(500);
    expect(selected[0]?.messages[0]?.messageId).toBe("user-504");
    expect(selected.at(-1)?.messages[0]?.messageId).toBe("user-5");
  });

  it("filters incremental turns after the recorded boundary and ignores incomplete turns", () => {
    const messages = [
      message("old-user", "old", "user", "2026-07-01T09:00:00.000Z"),
      message("old-assistant", "old", "assistant", "2026-07-01T09:00:01.000Z"),
      message("new-user", "new", "user", "2026-07-01T11:00:00.000Z"),
      message("new-assistant", "new", "assistant", "2026-07-01T11:00:01.000Z"),
      message("incomplete-user", "incomplete", "user", "2026-07-01T12:00:00.000Z")
    ];

    const selected = selectTurns(
      buildCompleteTurns(messages),
      "incremental",
      "2026-07-01T10:00:00.000Z"
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.messages.map((item) => item.messageId)).toEqual(["new-user", "new-assistant"]);
  });

  it("requires exact user-to-assistant turn boundaries", () => {
    const messages = [
      message("assistant-only", "assistant-only", "assistant", "2026-07-01T08:00:00.000Z"),
      message("user-tool-user", "mixed", "user", "2026-07-01T09:00:00.000Z"),
      { ...message("tool-tail", "mixed", "assistant", "2026-07-01T09:00:01.000Z"), role: "tool" as const },
      message("next-user", "mixed", "user", "2026-07-01T10:00:00.000Z"),
      message("next-assistant", "mixed", "assistant", "2026-07-01T10:00:01.000Z"),
      { ...message("empty-user", "empty", "user", "2026-07-01T11:00:00.000Z"), content: "query" },
      { ...message("empty-assistant", "empty", "assistant", "2026-07-01T11:00:01.000Z"), content: "" }
    ];

    const turns = buildCompleteTurns(messages);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.messages.map((item) => item.messageId)).toEqual(["next-user", "next-assistant"]);
  });

  it("requires an initial boundary before incremental sync", () => {
    expect(() => selectTurns([], "incremental", null)).toThrow("recorded initial sync boundary");
  });

  it("does not create a synthetic boundary for an empty initial scan", () => {
    expect(() => resolveSyncBoundaryAt("initial_subset", [], null)).toThrow(
      "no sync boundary was recorded"
    );
  });
});

describe("AgentSourceTool Skill rendering", () => {
  it("matches only case and separator variants of an installed Agent identity", () => {
    expect(normalizeAgentIdentity("KIMI-Code")).toBe(normalizeAgentIdentity("kimi code"));
    expect(normalizeAgentIdentity("kimi_code")).toBe(normalizeAgentIdentity("KIMI Code"));
    expect(normalizeAgentIdentity("我自己的agent")).not.toBe(normalizeAgentIdentity("memmy-agent"));

    const installationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-identity-"));
    tempRoots.push(installationRoot);
    const executablePath = path.join(installationRoot, "kimi_code");
    fs.writeFileSync(executablePath, "#!/bin/sh\n");
    fs.chmodSync(executablePath, 0o755);

    expect(verifyAgentInstallation("KIMI-Code", executablePath, "discovered")).toEqual({
      installationPath: executablePath,
      identity: "kimi_code"
    });

    const appPath = path.join(installationRoot, "Kimi Code.app");
    fs.mkdirSync(appPath);
    expect(verifyAgentInstallation("kimi-code", appPath, "discovered")).toEqual({
      installationPath: appPath,
      identity: "Kimi Code"
    });

    const packageRoot = path.join(installationRoot, "minimax-package");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/minimax-code" })
    );
    expect(verifyAgentInstallation("MiniMax_Code", packageRoot, "discovered")).toEqual({
      installationPath: packageRoot,
      identity: "minimax-code"
    });

    expect(() => verifyAgentInstallation("我自己的agent", executablePath, "discovered")).toThrow(
      'Agent installation not found for "我自己的agent"'
    );
    expect(verifyAgentInstallation("我自己的agent", executablePath, "user_provided")).toEqual({
      installationPath: executablePath,
      identity: "kimi_code"
    });
    expect(() =>
      verifyAgentInstallation("我自己的agent", path.join(installationRoot, "missing"), "user_provided")
    ).toThrow('Agent installation not found for "我自己的agent"');
  });

  it("does not accept a same-named history directory as installation evidence", () => {
    const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-history-"));
    tempRoots.push(historyRoot);

    expect(() => verifyAgentInstallation(path.basename(historyRoot), historyRoot, "user_provided")).toThrow(
      "Agent installation not found"
    );
  });

  it("keeps the onboarding Skill and every bundled reference English-only", () => {
    const skillRoot = path.resolve("src/skills/agent-memory-onboarding");
    const files = listTextFiles(skillRoot);
    const nonEnglish = files.flatMap((file) => {
      const content = fs.readFileSync(file, "utf8");
      return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(content)
        ? [path.relative(skillRoot, file)]
        : [];
    });

    expect(nonEnglish).toEqual([]);
  });

  it("replaces every source placeholder with the shell-quoted user-entered Agent name", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-source-"));
    tempRoots.push(workspace);
    const result = renderFullMemorySkill(workspace, "manual-id-1", "Agent $HOME's");
    const rendered = fs.readFileSync(result.skillPath, "utf8");

    expect(result.memorySource).toBe("Agent $HOME's");
    expect(result.skillPath.startsWith(workspace)).toBe(true);
    expect(rendered).not.toContain("{{SOURCE_ARG}}");
    expect(rendered).toContain("--source 'Agent $HOME'\"'\"'s'");
  });

  it("requires the exact automatic-sync recipe contract instead of an arbitrary object", () => {
    const tool = new AgentSourceTool();
    const parameters = tool.parameters;
    const recipe = parameters.properties.sync_recipe;

    expect(parameters.properties.action.enum).toContain("get_status");
    expect(parameters.properties.action.enum).toContain("verify_installation");
    expect(parameters.properties.installation_path_origin.enum).toEqual(["discovered", "user_provided"]);
    expect(recipe.required).toEqual(["version", "format", "path", "fields", "timestampFormat"]);
    expect(recipe.properties?.version?.enum).toEqual([1]);
    expect(recipe.properties?.format?.enum).toEqual(["jsonl", "json", "sqlite"]);
    expect(recipe.properties?.fields?.required).toEqual(["role", "content", "createdAt"]);
    expect(recipe.properties?.timestampFormat?.enum).toEqual(["auto", "iso", "unix_seconds", "unix_milliseconds"]);

    expect(
      tool.validateParams({
        action: "save_sync_recipe",
        source_id: "manual-id-1",
        sync_recipe: {
          type: "sqlite",
          id_field: "id",
          timestamp_format: "epoch_ms"
        }
      })
    ).toEqual([
      "missing required sync_recipe.version",
      "missing required sync_recipe.format",
      "missing required sync_recipe.path",
      "missing required sync_recipe.fields",
      "missing required sync_recipe.timestampFormat"
    ]);
  });

  it("makes GUI-visible readiness a mandatory connect completion check", () => {
    const skill = fs.readFileSync(path.resolve("src/skills/agent-memory-onboarding/SKILL.md"), "utf8");

    expect(skill).toContain('action="get_status"');
    expect(skill).toContain('status == "skill_installed"');
    expect(skill).toContain("syncBoundaryAt != null");
    expect(skill).toContain("syncReady == true");
    expect(skill).toContain("Imported memories are only bootstrap and validation evidence.");
  });

  it("requires installation identity verification before provisioning mutations", async () => {
    const memmyHome = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-verification-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-verification-workspace-"));
    const installationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-verification-install-"));
    tempRoots.push(memmyHome, workspace, installationRoot);
    fs.writeFileSync(
      path.join(memmyHome, "runtime.json"),
      JSON.stringify({ baseUrl: "http://127.0.0.1:19001", localToken: "local-token" })
    );
    const executablePath = path.join(installationRoot, "kimi_code");
    fs.writeFileSync(executablePath, "#!/bin/sh\n");
    fs.chmodSync(executablePath, 0o755);
    const previousMemmyHome = process.env.MEMMY_HOME;
    process.env.MEMMY_HOME = memmyHome;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify([{
          sourceId: "manual-id-1",
          displayName: "KIMI-Code",
          dataPath: "__MEMMY_DISCOVERY_PENDING__",
          builtin: false,
          available: true,
          status: "not_connected",
          messageCount: 0,
          lastScannedAt: null
        }]),
        { status: 200 }
      )
    );
    const tool = new AgentSourceTool({ workspace });

    try {
      await expect(tool.execute({
        action: "render_skill",
        source_id: "manual-id-1"
      })).rejects.toThrow("Agent installation is not verified");

      const verification = JSON.parse(await tool.execute({
        action: "verify_installation",
        source_id: "manual-id-1",
        installation_path: executablePath,
        installation_path_origin: "discovered"
      }));
      expect(verification).toMatchObject({ verified: true, identity: "kimi_code" });

      const rendered = JSON.parse(await tool.execute({
        action: "render_skill",
        source_id: "manual-id-1"
      }));
      expect(fs.existsSync(rendered.skillPath)).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (previousMemmyHome === undefined) delete process.env.MEMMY_HOME;
      else process.env.MEMMY_HOME = previousMemmyHome;
    }
  });

  it("tells onboarding to stop instead of substituting another product", () => {
    const skill = fs.readFileSync(path.resolve("src/skills/agent-memory-onboarding/SKILL.md"), "utf8");

    expect(skill).toContain("## Installation Identity Gate");
    expect(skill).toContain('action="verify_installation"');
    expect(skill).toContain("If no automatically discovered evidence passes `verify_installation`, stop and report that the requested Agent was not found.");
    expect(skill).toContain("Never substitute Memmy's own workspace or the current Agent surface");
    expect(skill).toContain('installation_path_origin="user_provided"');
    expect(skill).toContain("Do not keep searching or guess paths after asking.");
  });

  it("selects a scannable native projection before falling back to an event ledger", () => {
    const skill = fs.readFileSync(path.resolve("src/skills/agent-memory-onboarding/SKILL.md"), "utf8");
    const recipeReference = fs.readFileSync(
      path.resolve("src/skills/agent-memory-onboarding/references/sync-recipe.md"),
      "utf8"
    );

    expect(skill).toMatch(
      /flattened message projection[\s\S]+snapshot[\s\S]+raw event or ledger stream/u
    );
    expect(skill).toContain(
      "Do not declare the native format unsupported or request a custom adapter until every viable representation"
    );
    expect(skill).toContain(
      "Reject a JSONL event stream when extraction would require event filtering, array expansion"
    );
    expect(skill).toContain(
      "Never use a generic extension when sibling transcripts and ledgers share it."
    );
    expect(recipeReference).toContain("One JSONL line is one candidate message record.");
    expect(recipeReference).toContain("JSONL does not support `recordsPath`.");
    expect(recipeReference).toContain("prefer `display.jsonl` over `.jsonl`");
    expect(recipeReference).toContain(
      "Reject only the failing representation, not the entire Agent framework."
    );
  });

  it("reads the final managed source state used by the GUI", async () => {
    const memmyHome = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-source-status-"));
    tempRoots.push(memmyHome);
    fs.writeFileSync(
      path.join(memmyHome, "runtime.json"),
      JSON.stringify({
        baseUrl: "http://127.0.0.1:19001",
        localToken: "local-token"
      })
    );
    const previousMemmyHome = process.env.MEMMY_HOME;
    process.env.MEMMY_HOME = memmyHome;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            sourceId: "manual-id-1",
            displayName: "Example Agent",
            dataPath: "/Users/test/.example/history.db",
            builtin: false,
            available: true,
            status: "skill_installed",
            messageCount: 4,
            lastScannedAt: "2026-07-27T12:00:00.000Z",
            syncBoundaryAt: "2026-07-27T11:00:00.000Z",
            syncReady: true
          }
        ]),
        { status: 200 }
      )
    );

    try {
      const output = await new AgentSourceTool().execute({
        action: "get_status",
        source_id: "manual-id-1"
      });

      expect(JSON.parse(output)).toEqual({
        sourceId: "manual-id-1",
        displayName: "Example Agent",
        dataPath: "/Users/test/.example/history.db",
        builtin: false,
        available: true,
        status: "skill_installed",
        skillInstalled: true,
        messageCount: 4,
        lastScannedAt: "2026-07-27T12:00:00.000Z",
        syncBoundaryAt: "2026-07-27T11:00:00.000Z",
        syncReady: true
      });
    } finally {
      fetchMock.mockRestore();
      if (previousMemmyHome === undefined) delete process.env.MEMMY_HOME;
      else process.env.MEMMY_HOME = previousMemmyHome;
    }
  });
});

function listTextFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return listTextFiles(target);
    return entry.isFile() ? [target] : [];
  });
}

function message(
  messageId: string,
  conversationId: string,
  role: "user" | "assistant",
  createdAt: string
) {
  return {
    messageId,
    conversationId,
    role,
    content: messageId,
    createdAt
  };
}
