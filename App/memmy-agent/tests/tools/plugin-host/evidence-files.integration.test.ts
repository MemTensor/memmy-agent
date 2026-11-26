import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { it, expect, vi } from "vitest";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import { shutdownNativePlugins } from "../../../src/tools/plugin-host/native-services.js";
import { ReadFileTool } from "../../../src/core/agent-runtime/tools/filesystem.js";
import { ExecTool } from "../../../src/core/agent-runtime/tools/shell.js";

const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
it.skipIf(!process.env.TEACH_REAL_RECORDING)("uses an unchanged real recording COPY through the authenticated Host route, plugin and restricted file tools", async () => {
  const source = process.env.TEACH_REAL_RECORDING!;
  const root = fs.mkdtempSync(path.join(process.env.TEACH_REPORT_DIRECTORY ?? os.tmpdir(), "real-evidence-"));
  const workspace = path.join(root, "workspace"), dataRoot = path.join(root, "data");
  fs.mkdirSync(workspace);
  const metadata = JSON.parse(fs.readFileSync(path.join(source, "session.json"), "utf8"));
  const sessionId = metadata.id;
  const originalHash = digest(path.join(source, "events.jsonl"));
  const originalMetadataHash = digest(path.join(source, "session.json"));
  const copy = path.join(dataRoot, "teach-mode", "event-sessions", sessionId);
  fs.mkdirSync(copy, { recursive: true });
  for (const name of ["session.json", "events.jsonl", ...(metadata.captureIntegrity?.proofSha256 ? ["capture-proof.jsonl"] : [])]) fs.copyFileSync(path.join(source, name), path.join(copy, name));
  const sessions = new SessionManager(path.join(root, "sessions"));
  const conversationId = metadata.conversationId;
  const session = sessions.getOrCreate(`websocket:${conversationId}`);
  session.metadata.webui = true; session.metadata.webuiProjectId = null; session.metadata.webuiWorkspaceCwd = workspace; sessions.save(session);
  const channel = new WebSocketChannel({}, new MessageBus(), { sessionManager: sessions, workspacePath: path.join(root, "wrong-profile-workspace") });
  channel.apiTokens.set("fixture-only-token", Date.now() / 1000 + 60);
  const route = async (action: string, input: Record<string, unknown> = {}, auth = true) => channel.dispatchHttp({}, {
    path: "/api/plugin-host/services", method: "POST", headers: auth ? { Authorization: "Bearer fixture-only-token" } : {},
    body: JSON.stringify({ pluginId: "teach-mode", service: "event-sessions", dataRoot, input: { action, conversationId, ...input } }),
  });
  const calls: string[] = [], publish = vi.fn();
  try {
    expect((await route("evidence-files", { session_id: sessionId }, false))?.status).toBe(401);
    expect((await route("evidence-files", { session_id: sessionId, conversationId: "unknown-chat", workspace }))?.status).toBe(409);
    const { createConversationTeachPlugin } = await import(process.env.TEACH_PLUGIN_SOURCE!);
    const plugin = createConversationTeachPlugin(async (service: string, input: Record<string, unknown>) => {
      if (service === "plugin-context") return { dataDirectory: path.join(dataRoot, "teach-mode"), language: "en-US" };
      if (service === "skills") { publish(input); return { ok: true }; }
      calls.push(String(input.action));
      const response = await route(String(input.action), input);
      if (response?.status !== 200) throw new Error(String(response?.body));
      const result = JSON.parse(String(response.body));
      // Fixture supplies the test tool catalog, not a running model.
      if (input.action === "configuration") result.toolNames = ["read_file", "exec"];
      return result;
    });
    const stopped = await plugin.invoke("recording_stop", { session_id: sessionId });
    const prepared = await plugin.invoke("create_skill", { action: "prepare", session_id: sessionId });
    expect(calls).not.toContain("read"); expect(calls).not.toContain("summary");
    for (const result of [stopped, prepared]) {
      expect(result.eventsSha256).toBe(originalHash); expect(result.eventCount).toBe(metadata.eventCount);
      expect(result).not.toHaveProperty("events"); expect(result).not.toHaveProperty("overview");
      expect(digest(result.eventsPath)).toBe(originalHash);
      expect(result.eventsPath.startsWith(workspace + path.sep)).toBe(true);
    }
    const reader = new ReadFileTool({ workspace, allowedDir: workspace });
    expect(await reader.execute({ path: prepared.metadataPath })).toContain(sessionId);
    expect(await reader.execute({ path: prepared.eventsPath, offset: 1, limit: 1 })).toContain('"index"');
    expect(await reader.execute({ path: path.join(copy, "events.jsonl") })).toContain("Error");
    const scanFile = path.join(workspace, "scan-recording.cjs");
    fs.writeFileSync(scanFile, `const fs=require('fs'),crypto=require('crypto');const bytes=fs.readFileSync(process.argv[2]);const rows=bytes.toString().trim().split('\\n').map(JSON.parse);const types={};for(const row of rows)types[row.event.eventType]=(types[row.event.eventType]||0)+1;console.log(JSON.stringify({count:rows.length,indices:rows.every((row,i)=>row.index===i),types,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));`);
    const exec = new ExecTool({ workspace, restrictToWorkspace: true });
    const scanOutput = await exec.execute({ command: `node "${scanFile}" "${prepared.eventsPath}"` });
    expect(scanOutput).toContain(originalHash); expect(scanOutput).toContain('"indices":true');
    expect(scanOutput).toContain(`"count":${metadata.eventCount}`);
    const page = await plugin.invoke("recording_read", { session_id: sessionId, offset: 200, limit: 2 });
    expect(page.events.map((event: { index: number }) => event.index)).toEqual([200, 201]);
    fs.appendFileSync(path.join(copy, "events.jsonl"), "\n");
    await expect(plugin.invoke("create_skill", { action: "save", session_id: sessionId, events_sha256: originalHash, generate: true,
      draft: { name: "fixture-real-recording", description: "Fixture verifies source validation only", goal: "Test validation", prerequisites: [], parameters: [],
        steps: [{ instruction: "Inspect evidence", evidenceIndexes: [0] }], tools: ["read_file"], completionChecks: ["Verify evidence"], limitations: [] }
    })).rejects.toThrow("capture_evidence_hash_mismatch");
    expect(publish).not.toHaveBeenCalled();
    expect(digest(path.join(source, "events.jsonl"))).toBe(originalHash);
    expect(digest(path.join(source, "session.json"))).toBe(originalMetadataHash);
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ sessionId, originalHash, originalMetadataHash, eventCount: metadata.eventCount,
      availability: metadata.availability, stoppedBytes: Buffer.byteLength(JSON.stringify(stopped)), preparedBytes: Buffer.byteLength(JSON.stringify(prepared)),
      scanOutput, originalUnchanged: true, copiedSourceTamperRejectedAtSave: true, authenticatedRoute: true,
      rawReadIndexes: [200, 201], modelGenerationTested: false, installed: false, workspace }, null, 2));
  } finally { await shutdownNativePlugins(); }
});
