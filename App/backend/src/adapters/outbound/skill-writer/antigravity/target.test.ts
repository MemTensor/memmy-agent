import { execFile } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAntigravitySourceAdapter } from "@memmy/agent-source-readers/adapters/antigravity/index";
import { expect, it } from "vitest";
import { createAntigravityInsightSampler } from "../../agent-source/onboarding-insight-samplers.js";
import { createAntigravitySkillTarget } from "./target.js";

it("installs a local plugin and shares native turn identity across live capture and scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "memmy-antigravity-"));
  const app = join(root, "antigravity");
  const config = join(root, "config");
  const memmyConfigPath = join(root, "memmy.yaml");
  const conversationId = "9c700000-3a17-406b-b3f3-eecb4434ae95";
  const transcriptPath = join(app, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  const steps: { path: string; body: Record<string, unknown> }[] = [];
  const responses = new Map<string, object>([
    ["/api/v1/sessions/open", { sessionId: "test-session" }],
    ["/api/v1/turns/start", { injectedContext: { markdown: "A relevant old decision." } }],
    ["/api/v1/source-turns/complete", { status: "stored" }],
    ["/api/v1/memory/search", { hits: [{ id: "l1-test", score: 0.95 }] }],
    ["/api/v1/memory/l1-test", { refs: { episode: { id: "episode-test" } } }],
    ["/api/v1/memory/episode-test", { id: "episode-test", body: "Resume the synthetic build." }],
    ["/api/knowledge/recall", { enabled: true, evidence: [{ id: "doc", title: "Project", content: "Synthetic project knowledge." }] }]
  ]);
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const path = request.url ?? "";
    steps.push({ path, body: raw ? JSON.parse(raw) : {} });
    if (path === "/api/v1/turns/start") await delay(1_750);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(responses.get(path) ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
    await writeFile(memmyConfigPath, `storage:\n  endpoint: http://127.0.0.1:${address.port}\n`);
    const target = createAntigravitySkillTarget({ appDirectory: app, rootDirectory: config, memmyConfigPath });
    expect(await target.resolveRootDirectory()).toBeNull();
    await mkdir(dirname(transcriptPath), { recursive: true });
    await mkdir(join(config, "plugins", "other-plugin"), { recursive: true });
    await target.installPlugin!("antigravity");
    expect(await target.isInstalled!("antigravity")).toBe(true);
    expect(await target.isInstalledHookCurrent!()).toBe(true);
    const plugin = join(config, "plugins", "memmy-memory");
    const manifest = JSON.parse(await readFile(join(plugin, "plugin.json"), "utf8"));
    const hooks = JSON.parse(await readFile(join(plugin, "hooks.json"), "utf8"))["memmy-memory"];
    expect(manifest.name).toBe("memmy-memory");
    expect(manifest.logo).toBe("assets/memmy-app-icon.png");
    const logoPath = join(plugin, manifest.logo);
    expect(await readFile(logoPath)).toEqual(await readFile(new URL("./memmy-app-icon.png", import.meta.url)));
    await writeFile(logoPath, "stale icon");
    expect(await target.isInstalledHookCurrent!()).toBe(false);
    await target.installPlugin!("antigravity");
    expect(await target.isInstalledHookCurrent!()).toBe(true);
    expect(await readFile(join(plugin, "skills", "memmy-resume", "SKILL.md"), "utf8")).toContain("disable-model-invocation: true");
    expect(hooks.PreInvocation[0]).toMatchObject({ command: expect.stringContaining("pre-invocation"), timeout: 60 });
    expect(hooks.Stop[0].command).toContain("stop");

    const prompt = "Use the prior build decision.";
    const answer = "Build with the pinned toolchain.";
    const user = {
      step_index: 5, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE",
      created_at: "2026-11-25T11:06:20Z",
      content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nGenerated metadata.\n</ADDITIONAL_METADATA>`
    };
    await writeFile(transcriptPath, JSON.stringify(user) + "\n");
    const fullTranscript = join(dirname(transcriptPath), "transcript_full.jsonl");
    await writeFile(fullTranscript, JSON.stringify(user) + "\n");
    const payload = { conversationId, transcriptPath: fullTranscript, lastUserInput: prompt, workspacePaths: [root] };
    const hook = join(plugin, "memmy-antigravity-hook.mjs");
    const injected = await runHook(hook, "pre-invocation", payload);
    expect(injected.injectSteps[0].systemMessage.systemMessage).toContain("A relevant old decision.");
    await appendFile(fullTranscript, JSON.stringify({
      step_index: 6, type: "SYSTEM_MESSAGE", source: "SYSTEM", status: "DONE",
      created_at: "2026-11-25T11:06:21Z", content: injected.injectSteps[0].systemMessage.systemMessage
    }) + "\n");
    expect(await runHook(hook, "pre-invocation", payload)).toEqual({});
    expect(steps.filter(step => step.path === "/api/v1/turns/start")).toHaveLength(1);

    await appendFile(fullTranscript, [
      { ...user, step_index: 7, type: "PLANNER_RESPONSE", source: "MODEL", content: "Working…", tool_calls: [{ name: "run_command" }] },
      { ...user, step_index: 8, type: "PLANNER_RESPONSE", source: "MODEL", created_at: "2026-11-25T11:06:22Z", content: answer }
    ].map(row => JSON.stringify(row) + "\n").join(""));
    expect(await runHook(hook, "stop", { ...payload, fullyIdle: false, terminationReason: "model_stop" })).toEqual({});
    expect(steps.filter(step => step.path === "/api/v1/source-turns/complete")).toHaveLength(0);
    expect(await runHook(hook, "stop", { ...payload, fullyIdle: true, terminationReason: "NO_TOOL_CALL" })).toEqual({});
    const capture = steps.find(step => step.path === "/api/v1/source-turns/complete")?.body;
    expect(capture).toMatchObject({ query: prompt, answer, channel: "hook" });

    const messages = [];
    for await (const message of createAntigravitySourceAdapter(app).scan({ fullHistory: true })) messages.push(message);
    expect(messages.map(message => message.content)).toEqual([prompt, answer]);
    expect(messages[1]?.rawMeta.sourceTurn).toMatchObject(capture?.sourceTurn as object);
    expect(steps.find(step => step.path === "/api/v1/turns/start")?.body.turnId).toBe(messages[1]?.rawMeta.sourceTurnId);

    const onboarding = await createAntigravityInsightSampler({ root: join(app, "brain") }).sampleRecentUserQueries({
      maxSessionFiles: 2, maxQueries: 2, maxQueryChars: 200, maxBytesPerFile: 64_000, deadlineMs: 1000
    });
    expect(onboarding.queries.map(query => query.text)).toEqual([prompt]);

    const addPrompt = async (text: string, step_index: number) => {
      await appendFile(fullTranscript, JSON.stringify({
        ...user, step_index, content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`
      }) + "\n");
    };
    await addPrompt("/memmy-resume build", 9);
    const candidates = await runHook(hook, "pre-invocation", { ...payload, lastUserInput: "/memmy-resume build" });
    expect(candidates.injectSteps[0].systemMessage.systemMessage).toContain("1. episode-test");
    expect(steps.find(step => step.path === "/api/v1/memory/search")?.body).toMatchObject({
      query: "build", source: "antigravity", layers: ["L1"], limit: 20
    });
    await addPrompt("1", 10);
    const selection = await runHook(hook, "pre-invocation", { ...payload, lastUserInput: "1" });
    expect(selection.injectSteps[0].systemMessage.systemMessage).toContain("Resume the synthetic build.");
    await appendFile(fullTranscript, [
      { ...user, step_index: 11, type: "SYSTEM_MESSAGE", source: "SYSTEM_SDK", content: selection.injectSteps[0].systemMessage.systemMessage },
      { ...user, step_index: 12, type: "PLANNER_RESPONSE", source: "MODEL", content: "Resumed." }
    ].map(row => JSON.stringify(row) + "\n").join(""));
    await runHook(hook, "stop", { ...payload, lastUserInput: "1", fullyIdle: true, terminationReason: "NO_TOOL_CALL" });
    expect(steps.filter(step => step.path === "/api/v1/source-turns/complete")).toHaveLength(1);

    await target.installProjectHook!();
    await target.writeProjectSkillBootstrap!();
    expect(await target.isProjectHookCurrent!()).toBe(true);
    expect(await target.isProjectSkillBootstrapCurrent!()).toBe(true);
    const projectHook = join(config, "plugins", "memmy-project-context", "memmy-project-hook.mjs");
    const updatedAt = "2026-11-25T11:06:20Z";
    await writeFile(join(root, "runtime.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, localToken: "local-test" }));
    await writeFile(join(root, "project-instructions.json"), JSON.stringify({
      version: 1, projects: { [root]: { text: "Synthetic local instructions.", origin: "local", cloudProjectId: null, updatedAt } }
    }));
    await writeFile(join(root, "collab-project-instructions.json"), JSON.stringify({
      version: 1, projects: { test: { scopes: [{ sourceId: "antigravity", groupId: conversationId }],
        name: "Synthetic project", text: "Synthetic shared instructions.", updatedAt } }
    }));
    const access = join(root, "collab-agent-access.json");
    await writeFile(access, JSON.stringify({ granted: true, disabledAgents: [] }));
    const project = await runHook(projectHook, "pre-invocation", { ...payload, invocationNum: 0 });
    expect(project.injectSteps[0].systemMessage.systemMessage).toContain("Synthetic local instructions.");
    expect(project.injectSteps[0].systemMessage.systemMessage).toContain("Synthetic shared instructions.");
    expect(project.injectSteps[0].systemMessage.systemMessage).toContain("Synthetic project knowledge.");
    expect(await runHook(projectHook, "pre-invocation", { ...payload, invocationNum: 1 })).toEqual({});
    await writeFile(access, JSON.stringify({ granted: true, disabledAgents: ["antigravity"] }));
    const disabled = await runHook(projectHook, "pre-invocation", payload);
    expect(disabled.injectSteps[0].systemMessage.systemMessage).toContain("Synthetic local instructions.");
    expect(disabled.injectSteps[0].systemMessage.systemMessage).not.toContain("Synthetic shared instructions.");
    await writeFile(access, JSON.stringify({ granted: false, disabledAgents: [] }));
    const revoked = await runHook(projectHook, "pre-invocation", payload);
    expect(revoked.injectSteps[0].systemMessage.systemMessage).not.toContain("Synthetic shared instructions.");
    expect(steps.filter(step => step.path === "/api/knowledge/recall")).toHaveLength(1);
    await target.removeProjectSkillBootstrap!();
    await target.uninstallProjectHook!();
    expect(await target.isProjectSkillBootstrapCurrent!()).toBe(false);
    expect(await target.isProjectHookInstalled!()).toBe(false);
    expect(await target.isPluginInstalled!()).toBe(true);

    await target.uninstallPlugin!("antigravity");
    expect(await target.isPluginInstalled!()).toBe(false);
    expect((await stat(join(config, "plugins", "other-plugin"))).isDirectory()).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

function runHook(path: string, event: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path, event], { timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else {
        try { resolve(JSON.parse(stdout)); }
        catch (parseError) { reject(parseError); }
      }
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}
