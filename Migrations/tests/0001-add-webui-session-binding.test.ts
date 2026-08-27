import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateWebuiSessionBindings } from "../src/migrations/v1.0.4/0001-add-webui-session-binding.js";
import type { MigrationLogger } from "../src/types.js";

const temporaryDirectories: string[] = [];

function metadataRecord(
  metadata: Record<string, unknown>,
  key = "websocket:test-chat",
): Record<string, unknown> {
  return {
    recordType: "metadata",
    key,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    metadata,
    lastConsolidated: 0,
  };
}

function createLogger(): MigrationLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function createWorkspace(): Promise<{
  workspace: string;
  sessionsDir: string;
  logger: MigrationLogger;
}> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-migration-0001-"));
  temporaryDirectories.push(temporary);
  const workspace = await fs.realpath(temporary);
  const sessionsDir = path.join(workspace, "sessions");
  await fs.mkdir(sessionsDir);
  return { workspace, sessionsDir, logger: createLogger() };
}

async function runMigration(
  workspace: string,
  sessionsDir: string,
  logger: MigrationLogger,
  hooks: Parameters<typeof migrateWebuiSessionBindings>[1] = {},
) {
  return migrateWebuiSessionBindings(
    {
      profileWorkspace: workspace,
      sessionsDir,
      runtimeConfigFile: path.join(workspace, "config.yaml"),
      sessionDagDir: path.join(workspace, "session-dag"),
      logger,
    },
    hooks,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("v1.0.4/0001-add-webui-session-binding", () => {
  it("adds a standalone binding without changing business metadata or message bytes", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const filePath = path.join(sessionsDir, "legacy.jsonl");
    const originalMetadata = metadataRecord({ webui: true, title: "保留标题" });
    const suffix = Buffer.from(
      `${JSON.stringify({ role: "user", content: "hello" })}\n` +
        `${JSON.stringify({ role: "assistant", content: "world" })}\n`,
    );
    const source = Buffer.concat([
      Buffer.from("\n \n"),
      Buffer.from(`${JSON.stringify(originalMetadata)}\r\n`),
      suffix,
    ]);
    await fs.writeFile(filePath, source, { mode: 0o640 });
    const originalMode = (await fs.stat(filePath)).mode & 0o777;

    await expect(runMigration(workspace, sessionsDir, logger)).resolves.toEqual({
      scanned: 1,
      changed: 1,
      ignored: 0,
    });

    const migrated = await fs.readFile(filePath);
    expect(migrated.subarray(0, 3)).toEqual(Buffer.from("\n \n"));
    const metadataEnd = migrated.indexOf(Buffer.from("\r\n"), 3);
    const record = JSON.parse(migrated.subarray(3, metadataEnd).toString("utf8"));
    expect(record).toEqual({
      ...originalMetadata,
      metadata: {
        webui: true,
        title: "保留标题",
        webuiProjectId: null,
        webuiWorkspaceCwd: workspace,
      },
    });
    expect(migrated.subarray(metadataEnd + 2)).toEqual(suffix);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(originalMode);
  });

  it("preserves a missing trailing newline and handles Unicode metadata", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const filePath = path.join(sessionsDir, "unicode.jsonl");
    await fs.writeFile(
      filePath,
      JSON.stringify(metadataRecord({ webui: true, title: "项目 🥟" })),
    );

    await runMigration(workspace, sessionsDir, logger);

    const output = await fs.readFile(filePath, "utf8");
    expect(output.endsWith("\n")).toBe(false);
    expect(JSON.parse(output).metadata).toMatchObject({
      title: "项目 🥟",
      webuiProjectId: null,
      webuiWorkspaceCwd: workspace,
    });
  });

  it.each([
    ["non-WebUI", metadataRecord({ webui: false })],
    ["non-WebSocket", metadataRecord({ webui: true }, "telegram:test-chat")],
    [
      "valid standalone",
      metadataRecord({
        webui: true,
        webuiProjectId: null,
        webuiWorkspaceCwd: "/tmp/standalone",
      }),
    ],
    [
      "valid project binding",
      metadataRecord({
        webui: true,
        webuiProjectId: "project-a",
        webuiWorkspaceCwd: "/tmp/project-a",
      }),
    ],
  ])("leaves %s sessions byte-for-byte unchanged", async (_label, record) => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const filePath = path.join(sessionsDir, "ignored.jsonl");
    const source = `${JSON.stringify(record)}\n{"role":"user","content":"unchanged"}\n`;
    await fs.writeFile(filePath, source);

    await expect(runMigration(workspace, sessionsDir, logger)).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it.each([
    [
      "partial binding",
      metadataRecord({ webui: true, webuiProjectId: null }),
      "webui_binding_invalid",
    ],
    [
      "invalid binding",
      metadataRecord({
        webui: true,
        webuiProjectId: null,
        webuiWorkspaceCwd: "relative/path",
      }),
      "webui_binding_invalid",
    ],
    ["invalid metadata", { ...metadataRecord({ webui: true }), metadata: [] }, "metadata_value_invalid"],
  ])("warns and does not guess ownership for %s", async (_label, record, code) => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const filePath = path.join(sessionsDir, "anomaly.jsonl");
    const source = `${JSON.stringify(record)}\n`;
    await fs.writeFile(filePath, source);

    await runMigration(workspace, sessionsDir, logger);

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(source);
    expect(logger.warn).toHaveBeenCalledWith("migration_session_ignored", {
      migrationId: "v1.0.4/0001-add-webui-session-binding",
      scope: "agent-workspace",
      filePath,
      errorCode: code,
    });
  });

  it("warns for corrupt first metadata JSON without logging its contents", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const filePath = path.join(sessionsDir, "corrupt.jsonl");
    const secret = '{"recordType":"metadata","secret":"do-not-log"\n';
    await fs.writeFile(filePath, secret);

    await runMigration(workspace, sessionsDir, logger);

    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("do-not-log");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(secret);
  });

  it("does not follow a direct JSONL symlink", async () => {
    if (process.platform === "win32") return;
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const target = path.join(workspace, "outside.jsonl");
    const link = path.join(sessionsDir, "linked.jsonl");
    const source = `${JSON.stringify(metadataRecord({ webui: true }))}\n`;
    await fs.writeFile(target, source);
    await fs.symlink(target, link);

    await expect(runMigration(workspace, sessionsDir, logger)).resolves.toEqual({
      scanned: 1,
      changed: 0,
      ignored: 1,
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(source);
  });

  it("detects a concurrent source change and never overwrites it", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const filePath = path.join(sessionsDir, "racing.jsonl");
    const source = `${JSON.stringify(metadataRecord({ webui: true }))}\n`;
    await fs.writeFile(filePath, source);

    const promise = runMigration(workspace, sessionsDir, logger, {
      beforeCommit: async (candidatePath) => {
        await fs.appendFile(candidatePath, '{"role":"user","content":"concurrent"}\n');
      },
    });

    await expect(promise).rejects.toMatchObject({
      code: "migration_source_changed",
      migrationId: "v1.0.4/0001-add-webui-session-binding",
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      `${source}{"role":"user","content":"concurrent"}\n`,
    );
    expect((await fs.readdir(sessionsDir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("keeps completed files and resumes remaining files after a mid-run failure", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    for (const name of ["a.jsonl", "b.jsonl"]) {
      await fs.writeFile(
        path.join(sessionsDir, name),
        `${JSON.stringify(metadataRecord({ webui: true }, `websocket:${name}`))}\n`,
      );
    }

    await expect(
      runMigration(workspace, sessionsDir, logger, {
        beforeCommit: async (filePath) => {
          if (filePath.endsWith("b.jsonl")) throw new Error("injected failure");
        },
      }),
    ).rejects.toMatchObject({ code: "migration_io_failed" });

    expect(JSON.parse((await fs.readFile(path.join(sessionsDir, "a.jsonl"), "utf8")).trim()).metadata)
      .toMatchObject({ webuiWorkspaceCwd: workspace });
    expect(JSON.parse((await fs.readFile(path.join(sessionsDir, "b.jsonl"), "utf8")).trim()).metadata)
      .not.toHaveProperty("webuiWorkspaceCwd");

    await expect(runMigration(workspace, sessionsDir, logger)).resolves.toEqual({
      scanned: 2,
      changed: 1,
      ignored: 1,
    });
  });

  it("cleans only strict remnants belonging to this migration", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const staleName =
      `.legacy.jsonl.v1.0.4-0001.123.${randomUUID()}.tmp`;
    const unrelatedNames = [
      ".legacy.jsonl.v1.0.4-0002.123.00000000-0000-4000-8000-000000000000.tmp",
      "ordinary.tmp",
      "still-a-session.jsonl",
    ];
    await fs.writeFile(path.join(sessionsDir, staleName), "stale");
    for (const name of unrelatedNames) await fs.writeFile(path.join(sessionsDir, name), "");

    await runMigration(workspace, sessionsDir, logger);

    const remaining = await fs.readdir(sessionsDir);
    expect(remaining).not.toContain(staleName);
    expect(remaining).toEqual(expect.arrayContaining(unrelatedNames));
  });

  it("streams a large message suffix without changing a byte", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    const filePath = path.join(sessionsDir, "large.jsonl");
    const suffix = Buffer.from(
      `${JSON.stringify({ role: "user", content: "x".repeat(2 * 1024 * 1024) })}\n`,
    );
    await fs.writeFile(
      filePath,
      Buffer.concat([
        Buffer.from(`${JSON.stringify(metadataRecord({ webui: true }))}\n`),
        suffix,
      ]),
    );
    const expectedHash = createHash("sha256").update(suffix).digest("hex");

    await runMigration(workspace, sessionsDir, logger);

    const output = await fs.readFile(filePath);
    const firstNewline = output.indexOf(0x0a);
    expect(createHash("sha256").update(output.subarray(firstNewline + 1)).digest("hex"))
      .toBe(expectedHash);
  });

  it("is a no-op when the sessions directory does not exist", async () => {
    const { workspace, sessionsDir, logger } = await createWorkspace();
    await fs.rm(sessionsDir, { recursive: true });

    await expect(runMigration(workspace, sessionsDir, logger)).resolves.toEqual({
      scanned: 0,
      changed: 0,
      ignored: 0,
    });
  });
});
