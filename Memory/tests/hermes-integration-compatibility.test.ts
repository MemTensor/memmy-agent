import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHermesSkillTarget } from "../src/agent-source/integration/hermes/target.js";

let rootDirectory: string | undefined;

afterEach(() => {
  if (rootDirectory) rmSync(rootDirectory, { recursive: true, force: true });
  rootDirectory = undefined;
});

describe("Hermes plugin database compatibility", () => {
  it.each([
    { name: "missing cwd column", includeCwd: false, cwd: null },
    { name: "null cwd", includeCwd: true, cwd: null },
    { name: "empty cwd", includeCwd: true, cwd: "" },
    { name: "workspace cwd", includeCwd: true, cwd: "/workspace/hermes" }
  ])("reads turns with $name and preserves source data", async ({ includeCwd, cwd }) => {
    rootDirectory = mkdtempSync(join(tmpdir(), "memmy-hermes-compatibility-"));
    const target = createHermesSkillTarget({ rootDirectory, memmyConfigPath: join(rootDirectory, "memmy-config.yaml") });
    await target.installPlugin?.("hermes");
    const script = `
import importlib.util, json, sqlite3, sys, types
from pathlib import Path
memory_provider_module = types.ModuleType("agent.memory_provider")
memory_provider_module.MemoryProvider = type("MemoryProvider", (), {})
sys.modules["agent"] = types.ModuleType("agent")
sys.modules["agent.memory_provider"] = memory_provider_module
spec = importlib.util.spec_from_file_location("memmy_memory", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
options = json.loads(sys.argv[3])
path = Path(sys.argv[2]) / "state.db"
conn = sqlite3.connect(path)
conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY" + (", cwd TEXT" if options["includeCwd"] else "") + ")")
if options["includeCwd"]:
    conn.execute("INSERT INTO sessions VALUES (?, ?)", ("legacy-session", options["cwd"]))
else:
    conn.execute("INSERT INTO sessions VALUES (?)", ("legacy-session",))
conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, finish_reason TEXT)")
conn.executemany("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)", [
    (1, "legacy-session", "user", "Inspect the configuration.", 4070944800, None),
    (2, "legacy-session", "assistant", "The configuration is documented.", 4070944801, "stop")
])
conn.commit()
conn.close()
before = path.read_bytes()
turn = module._read_hermes_source_turn("legacy-session", "Inspect the configuration.")
again = module._read_hermes_source_turn("legacy-session", "Inspect the configuration.")
missing = module._read_hermes_source_turn("missing-session", "Inspect the configuration.")
print(json.dumps({"turn": turn, "repeatMatches": again == turn, "missing": missing, "databaseUnchanged": path.read_bytes() == before}))
`;
    const result = spawnSync("python3", [
      "-", join(rootDirectory, "plugins", "memmy-memory", "__init__.py"), rootDirectory, JSON.stringify({ includeCwd, cwd })
    ], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HERMES_HOME: rootDirectory, HERMES_PROFILE: "", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.turn).toMatchObject({
      source: "hermes", conversationId: "legacy-session", turnId: "legacy-session:1", status: "succeeded",
      query: "Inspect the configuration.", answer: "The configuration is documented."
    });
    if (cwd) expect(parsed.turn.workspacePath).toBe(cwd);
    else expect(parsed.turn).not.toHaveProperty("workspacePath");
    expect(parsed).toMatchObject({ repeatMatches: true, missing: null, databaseUnchanged: true });
  }, 15_000);
});
