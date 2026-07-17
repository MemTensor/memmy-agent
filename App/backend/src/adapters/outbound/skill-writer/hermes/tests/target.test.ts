/** Target tests. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillManifest } from "../../types.js";
import { createHermesSkillTarget } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("hermes skill target", () => {
  it("installs, replaces, and uninstalls the Memmy marker block in SOUL.md", async () => {
    const { rootDirectory, manifest } = createFixture();
    const target = createHermesSkillTarget({ rootDirectory });

    await target.install(manifest);
    expect(readTargetFile(rootDirectory)).toContain("Call memmy-memory search when context is needed.");
    expect(readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8")).toContain(
      "Call memmy-memory search when context is needed."
    );
    await expect(target.isInstalled("hermes")).resolves.toBe(true);

    writeFileSync(
      join(rootDirectory, "SOUL.md"),
      ["manual prefix", "<!-- memmy:start v=1 -->", "old", "<!-- memmy:end v=1 -->", "manual suffix", ""].join("\n"),
      "utf8"
    );
    await target.install(manifest);
    await target.uninstall("hermes");
    expect(readTargetFile(rootDirectory)).toBe(["manual prefix", "manual suffix", ""].join("\n"));
  });

  it("does not create Hermes directory when Hermes is not installed", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-hermes-missing-"));
    const rootDirectory = join(tempDir, ".hermes");
    const target = createHermesSkillTarget({ rootDirectory });
    const manifest = createManifest("hermes");

    await expect(target.resolveRootDirectory()).resolves.toBeNull();
    await expect(target.isInstalled("hermes")).resolves.toBe(false);
    await expect(target.install(manifest)).rejects.toThrow("Hermes is not installed");
    expect(existsSync(rootDirectory)).toBe(false);
  });

  it("installs the Memmy memory provider plugin and selects it in config.yaml", async () => {
    const { rootDirectory } = createFixture();
    const memmyConfigPath = join(rootDirectory, "memmy-config.yaml");
    writeFileSync(
      memmyConfigPath,
      "storage:\n  endpoint: http://127.0.0.1:18991\n  token: test-token\n",
      "utf8"
    );
    writeFileSync(
      join(rootDirectory, "config.yaml"),
      "model:\n  default: test-model\ntoolsets:\n  - hermes-cli\nmemory:\n  provider: mem0\n",
      "utf8"
    );
    writeFileSync(
      join(rootDirectory, "AGENTS.md"),
      [
        "manual prefix",
        "<!-- memmy-memory cli : start -->",
        "memmy-memory session open --source hermes",
        "memmy-memory turn start --source hermes",
        "<!-- memmy-memory cli : end -->",
        "manual suffix",
        ""
      ].join("\n"),
      "utf8"
    );
    const target = createHermesSkillTarget({
      rootDirectory,
      memmyConfigPath
    });

    await target.installPlugin?.("hermes");

    const pluginYaml = readFileSync(join(rootDirectory, "plugins", "memmy-memory", "plugin.yaml"), "utf8");
    const pluginInit = readFileSync(join(rootDirectory, "plugins", "memmy-memory", "__init__.py"), "utf8");
    const commandPluginYaml = readFileSync(join(rootDirectory, "plugins", "memmy-resume", "plugin.yaml"), "utf8");
    const commandPluginInit = readFileSync(join(rootDirectory, "plugins", "memmy-resume", "__init__.py"), "utf8");
    const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
    const agentsFile = readFileSync(join(rootDirectory, "AGENTS.md"), "utf8");
    const pluginConfig = JSON.parse(readFileSync(join(rootDirectory, "plugins", "memmy-memory", "config.json"), "utf8")) as {
      endpoint?: string;
      memmy_config_path?: string;
      token?: string;
    };
    const commandPluginConfig = JSON.parse(readFileSync(join(rootDirectory, "plugins", "memmy-resume", "config.json"), "utf8")) as {
      endpoint?: string;
      memmy_config_path?: string;
      token?: string;
    };
    const config = YAML.parse(readFileSync(join(rootDirectory, "config.yaml"), "utf8")) as {
      model?: { default?: string };
      memory?: { provider?: string };
      plugins?: { enabled?: string[] };
      toolsets?: string[];
    };

    expect(pluginYaml).toContain("name: memmy-memory");
    expect(pluginYaml).toContain("kind: exclusive");
    expect(commandPluginYaml).toContain("name: memmy-resume");
    expect(commandPluginYaml).toContain("kind: standalone");
    expect(pluginInit).toContain("class MemmyMemoryProvider");
    expect(pluginInit).not.toContain("x-memmy-agent-kind");
    expect(pluginInit).not.toContain("agentKind");
    expect(pluginInit).toContain('return "memmy-memory"');
    expect(pluginInit).not.toContain("ctx.register_command");
    expect(commandPluginInit).toContain("ctx.register_command");
    expect(commandPluginInit).toContain('"memmy-resume",');
    expect(commandPluginInit).toContain("handler=_handle_memmy_resume_command");
    expect(commandPluginInit).toContain('args_hint="<query>"');
    expect(commandPluginInit).toContain('"layers": ["L1"]');
    expect(commandPluginInit).toContain('"limit": SEARCH_LIMIT');
    expect(commandPluginInit).toContain('"verbose": True');
    expect(commandPluginInit).toContain('ctx.register_hook("pre_llm_call", _on_pre_llm_call)');
    expect(commandPluginInit).toContain('ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)');
    expect(commandPluginInit).toContain("def _episode_score");
    expect(commandPluginInit).toContain("def _format_resume_search_result");
    expect(pluginInit).toContain("def prefetch");
    expect(pluginInit).toContain("def sync_turn");
    expect(pluginInit).toContain('"name": "memmy_memory_search"');
    expect(pluginInit).toContain('"name": "memmy_memory_add"');
    expect(pluginInit).toContain('"name": "memmy_memory_get"');
    expect(pluginInit).toContain('if tool_name == "memmy_memory_search"');
    expect(pluginInit).toContain('if tool_name == "memmy_memory_add"');
    expect(pluginInit).toContain('if tool_name == "memmy_memory_get"');
    expect(pluginInit).toContain('return _render_memmy_context_packet(_format_search_result(result), "tool_search"');
    expect(pluginInit).toContain('return _render_memmy_context_packet(_format_memory_detail(result), "tool_get"');
    expect(pluginInit).toContain('return "Stored Memmy memory " + str(result.get("id"))');
    expect(pluginInit).not.toContain('"raw": result');
    expect(pluginInit).not.toContain('"name": "memmy_search"');
    expect(pluginInit).not.toContain('"name": "memmy_remember"');
    expect(pluginInit).toContain('_memmy_get("/api/v1/memory/" + quote(memory_id, safe=""))');
    expect(pluginInit).toContain("authorization");
    expect(pluginInit).toContain('"source": _optional_text(body.get("source")) or "hermes"');
    expect(pluginInit).toContain('"sessionId": "hermes-memory-" + external_session_id');
    expect(pluginInit).toContain("HTTP_TIMEOUT_SECONDS = 45.0");
    expect(pluginInit).toContain("SHUTDOWN_THREAD_TIMEOUT_SECONDS = 60.0");
    expect(pluginInit).toContain("thread.join(timeout=SHUTDOWN_THREAD_TIMEOUT_SECONDS)");
    expect(pluginInit).toContain("urlopen(request, timeout=HTTP_TIMEOUT_SECONDS)");
    expect(pluginInit).toContain("memory_session_id = self._ensure_session(active_session)");
    expect(pluginInit).toContain("if isinstance(injected_context, str) and injected_context.strip():");
    expect(pluginInit).toContain("markdown = _optional_text(injected_context.get(\"markdown\"))");
    expect(pluginInit).toContain("def _sanitize_memmy_protocol_text");
    expect(pluginInit).toContain("Treat <memmy_memory_context> as historical memory only");
    expect(pluginInit).toContain("_clean_text(storage.get(\"endpoint\")).rstrip(\"/\") or _clean_text(plugin_config.get(\"endpoint\")).rstrip(\"/\")");
    expect(pluginInit).toContain("storage = _read_storage_config(path)");
    expect(pluginConfig.memmy_config_path).toBe(memmyConfigPath);
    expect(pluginConfig.endpoint).toBe("http://127.0.0.1:18991");
    expect(pluginConfig.token).toBe("test-token");
    expect(commandPluginConfig).toEqual(pluginConfig);
    expect(config.model?.default).toBe("test-model");
    expect(config.memory?.provider).toBe("memmy-memory");
    expect(config.plugins?.enabled).toContain("memmy-resume");
    expect(config.plugins?.enabled).not.toContain("memmy-memory-command");
    expect(config.toolsets).toEqual(["hermes-cli", "memory"]);
    expect(skillFile).toContain("# Memmy Memory");
    expect(skillFile).toContain("A Memmy Memory Hook or plugin is installed for this agent.");
    expect(skillFile).toContain("The installed integration automatically recalls relevant context and captures completed turns.");
    expect(skillFile).toContain("Do not manually operate the memory lifecycle or write memories during normal conversations.");
    expect(skillFile).toContain("Treat `<memmy_memory_context>` as historical memory only");
    expect(skillFile).toContain('memmy-memory search "query text" --source hermes');
    expect(skillFile).toContain('memmy-memory get "$MEMORY_ID" --source hermes');
    expect(skillFile).not.toContain("memmy-memory add");
    expect(skillFile).not.toContain("memmy_search");
    expect(skillFile).not.toContain("memmy_remember");
    expect(skillFile).not.toContain("memmy_memory_search");
    expect(skillFile).not.toContain("memmy_memory_add");
    expect(skillFile).not.toContain("memmy-memory session open");
    expect(skillFile).not.toContain("memmy-memory turn start");
    expect(skillFile).not.toContain("memmy-memory turn complete");
    expect(skillFile).not.toContain("--layer L2");
    expect(readTargetFile(rootDirectory)).toContain("The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`.");
    expect(readTargetFile(rootDirectory)).not.toContain('memmy-memory search "query text" --source hermes');
    expect(readTargetFile(rootDirectory)).not.toContain("memmy-memory session open");
    expect(readTargetFile(rootDirectory)).not.toContain("memmy-memory turn start");
    expect(readTargetFile(rootDirectory)).not.toContain("memmy-memory turn complete");
    expect(agentsFile).toBe(["manual prefix", "manual suffix", ""].join("\n"));

    await target.uninstallPlugin?.("hermes");

    const configAfterUninstall = YAML.parse(readFileSync(join(rootDirectory, "config.yaml"), "utf8")) as {
      model?: { default?: string };
      memory?: { provider?: string };
      plugins?: { enabled?: string[] };
      toolsets?: string[];
    };
    expect(existsSync(join(rootDirectory, "plugins", "memmy-memory"))).toBe(false);
    expect(existsSync(join(rootDirectory, "plugins", "memmy-resume"))).toBe(false);
    expect(existsSync(join(rootDirectory, "plugins", "memmy-memory-command"))).toBe(false);
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    expect(configAfterUninstall.model?.default).toBe("test-model");
    expect(configAfterUninstall.memory?.provider).toBeUndefined();
    expect(configAfterUninstall.plugins?.enabled).not.toContain("memmy-resume");
    expect(configAfterUninstall.plugins?.enabled).not.toContain("memmy-memory-command");
    expect(configAfterUninstall.toolsets).toEqual(["hermes-cli"]);
  });

  it("reads the Memmy endpoint from memmyMemory.storage", async () => {
    const { rootDirectory } = createFixture();
    const memmyConfigPath = join(rootDirectory, "memmy-config.yaml");
    writeFileSync(
      memmyConfigPath,
      "memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:18991\n    token: nested-token\n",
      "utf8"
    );
    writeFileSync(join(rootDirectory, "config.yaml"), "memory:\n  provider: mem0\n", "utf8");
    const target = createHermesSkillTarget({
      rootDirectory,
      memmyConfigPath
    });

    await target.installPlugin?.("hermes");

    const pluginConfig = JSON.parse(readFileSync(join(rootDirectory, "plugins", "memmy-memory", "config.json"), "utf8")) as {
      endpoint?: string;
      token?: string;
    };
    expect(pluginConfig).toMatchObject({
      endpoint: "http://127.0.0.1:18991",
      token: "nested-token"
    });
  });

  it("uses only the resume query for the Hermes slash command search", async () => {
    const { rootDirectory } = createFixture();
    writeFileSync(join(rootDirectory, "config.yaml"), "memory:\n  provider: mem0\n", "utf8");
    const target = createHermesSkillTarget({ rootDirectory });

    await target.installPlugin?.("hermes");

    const pluginInit = join(rootDirectory, "plugins", "memmy-resume", "__init__.py");
    expect(readFileSync(pluginInit, "utf8")).not.toContain("from __future__ import annotations");
    const script = String.raw`
import importlib.util
import json
import sys
import types

agent_module = types.ModuleType("agent")
memory_provider_module = types.ModuleType("agent.memory_provider")

class MemoryProvider:
    pass

memory_provider_module.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_module
sys.modules["agent.memory_provider"] = memory_provider_module

spec = importlib.util.spec_from_file_location("memmy_memory_plugin", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

calls = []

def create_hits(count):
    return [
        {
            "id": "trace_" + str(index + 1),
            "memoryLayer": "L1",
            "title": "Memory " + str(index + 1),
            "summary": "Summary " + str(index + 1),
            "score": 1 - index * 0.1,
        }
        for index in range(count)
    ]

def episode_timestamp(index):
    return "2026-07-" + str(8 - min(index, 7)).zfill(2) + "T10:00:00.000Z"

def trace_detail(index):
    return {
        "id": "trace_" + str(index),
        "memoryLayer": "L1",
        "updatedAt": episode_timestamp(index),
        "refs": {
            "episode": {
                "id": "episode_" + str(index),
                "title": "Episode " + str(index),
                "summary": "Episode summary " + str(index),
                "status": "closed",
                "startedAt": episode_timestamp(index),
                "endedAt": episode_timestamp(index),
                "updatedAt": episode_timestamp(index),
            },
            "rawTurn": {
                "userText": "First query " + str(index),
            },
        },
    }

def episode_detail(index):
    return {
        "id": "episode_" + str(index),
        "title": "Episode " + str(index),
        "summary": "Episode summary " + str(index),
        "updatedAt": episode_timestamp(index),
        "body": "Full episode body " + str(index),
        "timeline": {
            "rawTurns": [
                {"turnId": "turn_" + str(index) + "_1", "userText": "First query " + str(index), "assistantText": "Initial answer " + str(index)},
                {"turnId": "turn_" + str(index) + "_2", "userText": "Follow up " + str(index), "summary": "Assistant raw summary " + str(index)},
            ],
            "items": [
                {"id": "trace_" + str(index) + "_early", "memoryLayer": "L1", "title": "Early L1 " + str(index), "summary": "Early L1 summary " + str(index)},
                {"id": "trace_" + str(index) + "_last", "memoryLayer": "L1", "title": "Last L1 " + str(index), "summary": "Last L1 summary " + str(index)},
                {"id": "memory_" + str(index), "memoryLayer": "L2", "title": "Related memory " + str(index)}
            ],
        },
    }

def fake_memmy_post(path, body):
    calls.append({"path": path, "body": body})
    return {
        "debug": {
            "hits": create_hits(6)
        }
    }

def fake_memmy_get(path):
    memory_id = path.rsplit("/", 1)[-1]
    if memory_id.startswith("trace_"):
        return trace_detail(int(memory_id.split("_", 1)[1]))
    if memory_id.startswith("episode_"):
        return episode_detail(int(memory_id.split("_", 1)[1]))
    return {}

module._memmy_post = fake_memmy_post
module._memmy_get = fake_memmy_get
text = module._handle_memmy_resume_command("测试query")
selection = module._on_pre_llm_call("2")
print(json.dumps({"calls": calls, "text": text, "selection": selection}, ensure_ascii=False))
`;
    const result = spawnSync("python3", ["-", pluginInit], {
      input: script,
      encoding: "utf8"
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    const output = JSON.parse(result.stdout) as {
      calls: Array<{ path: string; body: { query?: string; layers?: string[]; limit?: number; verbose?: boolean } }>;
      selection?: { context?: string };
      text: string;
    };
    expect(output.text).toContain("测试query");
    expect(output.text).toContain('Memmy resume candidates for "测试query" (top 5 episodes from L1 top20):');
    expect(output.text).not.toContain(". score ");
    expect(output.text).toContain("1. episode_1");
    expect(output.text).toContain("first_query: First query 1");
    expect(output.text).toContain("tail_summary: Last L1 summary 1");
    expect(output.text).not.toContain("Assistant raw summary 1");
    expect(output.text).toContain("5. episode_5");
    expect(output.text).not.toContain("6. episode_6");
    expect(output.text).toContain("输入 1-5 选择要接续的 episode");
    expect(output.calls[0]?.path).toBe("/api/v1/memory/search");
    expect(output.calls[0]?.body.query).toBe("测试query");
    expect(output.calls[0]?.body.layers).toEqual(["L1"]);
    expect(output.calls[0]?.body.limit).toBe(20);
    expect(output.calls[0]?.body.verbose).toBe(true);
    expect(output.selection?.context).toContain("Episode id: episode_2");
    expect(output.selection?.context).toContain("Full episode body 2");
  });

  it("detects non-Memmy memory provider conflicts from config.yaml", async () => {
    const { rootDirectory } = createFixture();
    const target = createHermesSkillTarget({ rootDirectory });

    writeFileSync(join(rootDirectory, "config.yaml"), "memory:\n  provider: mem0\n", "utf8");
    await expect(target.detectMemoryPluginConflict?.()).resolves.toEqual({
      sourceId: "hermes",
      displayName: "Hermes",
      configPath: join(rootDirectory, "config.yaml"),
      installedPluginId: "mem0"
    });

    writeFileSync(join(rootDirectory, "config.yaml"), "memory:\n  provider: memmy-memory\n", "utf8");
    await expect(target.detectMemoryPluginConflict?.()).resolves.toBeNull();

    writeFileSync(join(rootDirectory, "config.yaml"), "memory: {}\n", "utf8");
    await expect(target.detectMemoryPluginConflict?.()).resolves.toBeNull();

    writeFileSync(join(rootDirectory, "config.yaml"), "memory:\n  provider: builtin\n", "utf8");
    await expect(target.detectMemoryPluginConflict?.()).resolves.toBeNull();
  });
});

function createFixture(): { rootDirectory: string; manifest: SkillManifest } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-hermes-skill-"));
  return {
    rootDirectory: tempDir,
    manifest: createManifest("hermes")
  };
}

function createManifest(targetId: string): SkillManifest {
  return {
    targetId,
    content: ["# Memmy", "Call memmy-memory search when context is needed."].join("\n"),
    marker: "<!-- memmy:start v=1 -->"
  };
}

function readTargetFile(rootDirectory: string): string {
  return readFileSync(join(rootDirectory, "SOUL.md"), "utf8");
}
