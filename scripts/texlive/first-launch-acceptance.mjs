/** Native acceptance: real backend boot, real MPP and runtime archive, no system TeX.
 * node scripts/texlive/first-launch-acceptance.mjs PLUGIN_ROOT MANIFEST ARCHIVE EMPTY_OUTPUT_DIR
 * Uses a synthetic signed-in account and a loopback registry; no account credentials.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalBackend } from "../../App/backend/dist/src/index.js";
import { createAppStateStore } from "../../App/backend/dist/src/infrastructure/app-state-store/index.js";

const [pluginArg, manifestArg, archiveArg, outputArg] = process.argv.slice(2);
const desktop = process.argv.includes("--desktop");
const repoRoot = resolve(import.meta.dirname, "../..");
assert(outputArg, "Required: PLUGIN_ROOT MANIFEST ARCHIVE EMPTY_OUTPUT_DIR");
const pluginRoot = resolve(pluginArg), output = resolve(outputArg);
assert(!existsSync(output), "Output must not exist: acceptance requires a fresh profile/cache");
await mkdir(output, { recursive: true });
const published = JSON.parse(await readFile(manifestArg, "utf8"));
assert.equal(published.target, `${process.platform}-${process.arch}`);
const manifest = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
const descriptor = JSON.parse(await readFile(join(pluginRoot, "release", `literature-review-${manifest.version}.release.json`), "utf8"));
const started = performance.now(), timeline = [];
const mark = (stage, details = {}) => {
  const item = { stage, elapsedMs: Math.round(performance.now() - started), ...details };
  timeline.push(item); console.log(JSON.stringify(item)); return item;
};
let releaseArchive;
const gate = new Promise(done => { releaseArchive = done; });
let archiveRequests = 0, archiveReleased = false;
const registry = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const json = value => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (path === "/api/agentUser/info") return json({ code: 0, data: {
      id: "tex-first-launch-acceptance", userName: "TeX Acceptance", phoneNumber: "13800000000",
      hasFinishedGuide: true, improvementProgramGranted: true, entitlements: ["plugin:literature-review"]
    } });
    if (path === "/api/v1/plugins") return json([descriptor.manifest]);
    if (path === "/api/v1/plugins/literature-review") return json({ manifest: descriptor.manifest, artifact: { url: "/plugin.zip", sha256: descriptor.artifact.sha256 } });
    if (path === "/plugin.zip") return createReadStream(join(pluginRoot, "release", descriptor.artifact.file)).pipe(res);
    if (path.includes("/runtimes/")) return json({ ...published, archive: { ...published.archive, url: "/texlive.zip" } });
    if (path === "/texlive.zip") {
      archiveRequests++; mark("runtime-download-requested");
      await gate;
      archiveReleased = true; mark("runtime-download-released");
      res.setHeader("content-length", published.archive.bytes);
      return createReadStream(resolve(archiveArg)).pipe(res);
    }
    if (path.includes("reload")) return json({ ok: true });
    if (desktop && (path === "/index.html" || path.startsWith("/assets/"))) {
      const file = resolve(repoRoot, "App/frontend/desktop/dist", `.${path}`);
      assert(file.startsWith(join(repoRoot, "App/frontend/desktop/dist") + "/"));
      const mime = { js: "text/javascript", css: "text/css", html: "text/html", svg: "image/svg+xml", png: "image/png" };
      res.setHeader("content-type", mime[path.split(".").at(-1)] ?? "application/octet-stream");
      return createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end("acceptance registry: no upstream service");
  } catch (error) { res.destroy(error); }
});
await new Promise(done => registry.listen(0, "127.0.0.1", done));
const registryUrl = `http://127.0.0.1:${registry.address().port}`;
const data = desktop ? join(output, "app-data", "Memmy") : join(output, "profile"), cache = join(output, "tex-cache");
await mkdir(data, { recursive: true });
Object.assign(process.env, {
  MEMMY_CLOUD_SERVICE: registryUrl, MEMMY_PLUGIN_REGISTRY_URL: registryUrl,
  MEMMY_MEMORY_LAYER_URL: registryUrl,
  MEMMY_TEXLIVE_RUNTIME_PREFER_MANAGED: "1", MEMMY_TEXLIVE_RUNTIME_CACHE: cache,
  MEMMY_TEXLIVE_RUNTIME_CATALOG_URL: `${registryUrl}/api/v1/plugins/literature-review/runtimes/{target}`,
  MEMMY_AGENT_WORKSPACE: join(data, "workspace"), MEMMY_HOME: data,
  MEMMY_CONFIG: join(data, "config.yaml"),
  MEMMY_COMMAND_PLUGIN_NETWORK_ALLOWLIST: manifest.permissions.filter(p => p.type === "network").flatMap(p => p.hosts).join(",")
});
const store = createAppStateStore({ databasePath: join(data, "app.sqlite") });
store.repositories.accountSession.upsert({ uuid: randomUUID(), cloudUuid: "native-acceptance-not-a-real-credential", authChannel: "phone", profile: {
  userId: "tex-first-launch-acceptance", nickname: "TeX Acceptance", email: null, phoneNumber: null,
  avatarUrl: null, planType: null, hasFinishedGuide: true, region: null, registeredAt: null,
  rawProfile: { entitlements: ["plugin:literature-review"] }
} });
store.repositories.bootstrap.updateAppSettings({ userMode: "account", language: "zh-CN" });
store.close();
let backend;
let desktopProcess;
try {
  mark("backend-start", { cacheInitiallyAbsent: !existsSync(cache), ignoreSystemTex: true });
  if (desktop) {
    const wrapper = join(output, "desktop-wrapper.mjs");
    await writeFile(wrapper, `
      import { createRequire } from 'node:module';
      import { mkdirSync, writeFileSync } from 'node:fs';
      const require = createRequire(${JSON.stringify(join(repoRoot, "App/shell/desktop/package.json"))});
      const { app, ipcMain, BrowserWindow } = require('electron');
      app.setName('Memmy TeX Acceptance');
      app.setPath('appData', ${JSON.stringify(join(output, "app-data"))});
      app.setPath('userData', ${JSON.stringify(data)});
      ipcMain.on('memmy:renderer-ready', async event => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.getBounds().width < 600) return;
        // The handshake can precede the last startup-screen paint. Require the
        // actual visible content to leave that screen before releasing TeX.
        for (let attempt = 0; attempt < 180; attempt++) {
          const body = await event.sender.executeJavaScript('document.body.innerText');
          if (body.trim() && !/Memmy Starting|Memmy 正在启动/.test(body)) break;
          if (attempt === 179) throw new Error('Desktop stayed on startup screen');
          await new Promise(done => setTimeout(done, 500));
        }
        writeFileSync(${JSON.stringify(join(output, "renderer-ready.json"))}, JSON.stringify({ ready: true, at: Date.now() }));
        const image = await event.sender.capturePage();
        writeFileSync(${JSON.stringify(join(output, "desktop-ready.png"))}, image.toPNG());
        setTimeout(async () => {
          if (event.sender.isDestroyed()) return;
          writeFileSync(${JSON.stringify(join(output, "desktop-settled.png"))}, (await event.sender.capturePage()).toPNG());
        }, 5000).unref();
      });
      await import(${JSON.stringify(pathToFileURL(join(repoRoot, "App/shell/desktop/dist/main/main.js")).href)});
    `);
    desktopProcess = spawn(join(repoRoot, "App/shell/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [wrapper], {
      cwd: repoRoot, env: { ...process.env, MEMMY_RENDERER_URL: `${registryUrl}/index.html`, MEMMY_BOOTSTRAP_SCENARIO: "completed",
        MEMMY_MEMORY_URL: "http://127.0.0.1:48561", MEMMY_CLI_ANALYTICS_SKIP: "1" }, stdio: ["ignore", "pipe", "pipe"]
    });
    const logs = [];
    desktopProcess.stdout.on("data", chunk => logs.push(chunk)); desktopProcess.stderr.on("data", chunk => logs.push(chunk));
    const deadline = Date.now() + 120000;
    while (!existsSync(join(output, "renderer-ready.json"))) {
      if (desktopProcess.exitCode !== null || Date.now() > deadline) {
        await writeFile(join(output, "desktop.log"), Buffer.concat(logs));
        throw new Error("Desktop did not reach renderer-ready; see desktop.log");
      }
      await delay(500);
    }
    await writeFile(join(output, "desktop.log"), Buffer.concat(logs));
    backend = { runtimeConfig: JSON.parse(await readFile(join(data, "runtime.json"), "utf8")), close: async () => {} };
    mark("desktop-renderer-ready");
  } else backend = await Promise.race([
    createLocalBackend({ databasePath: join(data, "app.sqlite"), memmyConfigPath: join(data, "config.yaml"),
      runtimeConfigPath: join(data, "runtime.json"), localToken: "isolated-acceptance-token", skipAgentMcpReload: true,
      // Memory/LLM services are outside this TeX acceptance; they do not participate in startup.
      memoryReady: new Promise(() => {}) }),
    delay(20000, null, { ref: false }).then(() => { throw new Error("Backend startup waited for the withheld TeX archive"); })
  ]);
  const api = async (path, body) => {
    const response = await fetch(backend.runtimeConfig.baseUrl + path, { method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(240000),
      headers: { "x-memmy-local-token": backend.runtimeConfig.localToken, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const ready = mark("backend-ready", { archiveReleased });
  assert.equal(archiveReleased, false);
  const plugins = await api("/api/v1/plugins");
  assert.equal(plugins.find(p => p.id === "literature-review")?.state, "active");
  const invoke = async (capability, input) => {
    const value = await api(`/api/v1/plugins/literature-review/capabilities/${capability}/invoke`, { conversationId: "native-acceptance", input });
    assert.equal(value.event.type, "result", JSON.stringify(value));
    assert.equal(value.event.output.ok, true, JSON.stringify(value)); return value.event.output;
  };
  const task = await invoke("review_create_task", { title: "首次启动与后台排版验收", topic: "后台 TeX 准备" });
  mark("ordinary-plugin-call-complete", { archiveReleased, taskId: task.taskId });
  assert.equal(archiveReleased, false);
  // Keep the actual archive unavailable while repeatedly checking app bootstrap responsiveness.
  for (let i = 0; i < 5; i++) {
    const before = performance.now(); await api("/api/app/bootstrap");
    mark("bootstrap-responsive-during-install", { requestMs: Math.round(performance.now() - before) });
    await delay(1000);
  }
  releaseArchive();
  const preflight = await invoke("review_check_render_environment", { taskId: task.taskId });
  mark("native-runtime-ready", { environment: preflight.data?.environment });
  const { TaskRepository } = await import(pathToFileURL(join(pluginRoot, "dist/src/task/index.js")).href);
  const repository = new TaskRepository(join(data, "plugin-data", "literature-review"));
  const saved = await repository.load(task.taskId);
  saved.spec.outputLanguage = "zh-CN"; saved.spec.renderMode = "memmy"; saved.spec.outputFormats = ["pdf", "tex"];
  saved.values.outline = [{ id: "background", title: "后台准备与首次启动", guidance: "", order: 1, children: [], evidenceIds: [] }];
  saved.values.sections = [{ id: "section-1", outlineNodeId: "background", status: "drafted", paragraphs: [],
    markdown: "首次启动时，文献综述插件可以立即使用。排版运行时在后台下载并完成校验，检索与写作无需等待。运行时安装完成后，导出调用会使用独立缓存中的 XeLaTeX 编译器生成正式的 Memmy 品牌 PDF。", evidenceIds: [], citeKeys: [] }];
  const body = await repository.putArtifact(saved, "sections", "acceptance-fixture", saved.values.sections);
  saved.values.abstract = { text: "本报告验证 Memmy 在没有可用 TeX 运行时的情况下完成首次加载，并在后台安装完成后正常导出中文 PDF。",
    language: "zh-CN", wordCount: 55, characterCount: 55, sourceSectionIds: ["background"], sourceEvidenceIds: [],
    sourceBodyArtifactId: body.id, sourceBodyHash: body.contentHash, generatedAt: new Date().toISOString(),
    generation: { mode: "host-model", model: { provider: "acceptance-fixture", model: "fixture" }, usage: {} } };
  saved.values.audit = { passed: true }; await repository.save(saved);
  // Fixture prose/audit avoids unrelated model calls; rendering itself is the installed plugin's real capability.
  const rendered = await invoke("review_render", { taskId: task.taskId, formats: ["pdf", "tex"] });
  await writeFile(join(output, "render-result.json"), JSON.stringify(rendered, null, 2));
  const loaded = await repository.load(task.taskId);
  const pdf = loaded.values.outputs.find(item => item.format === "pdf");
  assert.equal(pdf.generation.renderer, "xelatex"); assert.equal(pdf.generation.fallback, false);
  const log = await readFile(join(repository.taskDir(task.taskId), "outputs", "review.log"), "utf8");
  assert(log.includes(cache), "Compilation must load packages/fonts from the fresh managed cache");
  assert(!log.includes("/usr/local/texlive/"), "Compilation must not use the system TeX tree");
  const bytes = await readFile(pdf.path); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  await cp(pdf.path, join(output, "first-launch-export.pdf"));
  mark("pdf-exported", { bytes: bytes.length, renderer: pdf.generation.renderer, fallback: false });
  assert.equal(archiveRequests, 1);
  await writeFile(join(output, "acceptance-report.json"), JSON.stringify({
    target: published.target, runtimeVersion: published.version, backendReadyMs: ready.elapsedMs,
    archiveRequests, archiveBytes: published.archive.bytes, simulatedNoSystemTex: true,
    realBackend: true, realPlugin: true, realRuntimeInstall: true, fixtureReviewContent: true,
    syntheticAccount: true, runtimeDelivery: "loopback-registry-with-published-archive",
    desktopWindowTested: desktop, timeline, pdfGeneration: pdf.generation
  }, null, 2));
  console.log(`Acceptance passed: ${output}`);
} finally {
  releaseArchive(); await backend?.close(); registry.closeAllConnections(); await new Promise(done => registry.close(done));
  if (desktopProcess && desktopProcess.exitCode === null) {
    desktopProcess.kill("SIGTERM");
    await Promise.race([new Promise(done => desktopProcess.once("exit", done)), delay(20000, null, { ref: false })]);
    if (desktopProcess.exitCode === null) desktopProcess.kill("SIGKILL");
  }
}
