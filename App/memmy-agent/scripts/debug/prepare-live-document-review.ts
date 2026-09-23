// Prepare isolated, private CLI fixtures; never copy account credentials into the repository.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { reportText, REPORT_FACTS, writeDocx, writePdf } from "../../tests/helpers/long-document-fixtures.js";

const source = process.argv[2] ?? path.join(os.homedir(), ".memmy", "config.yaml");
const config = YAML.parse(await fs.readFile(source, "utf8"));
const presetId = config.agents?.defaults?.modelPreset;
const preset = config.modelPresets?.[presetId];
if (!preset || preset.provider !== "memmy_account" || !config.providers?.memmy_account?.apiKey) {
  throw new Error("Expected a configured memmy_account agent preset");
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-live-document-review-"));
await fs.chmod(root, 0o700);
for (const scenario of ["docx", "pdf", "exec"]) {
  const folder = path.join(root, scenario);
  const workspace = path.join(folder, "workspace");
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const isolated = {
    providers: { memmy_account: config.providers.memmy_account },
    modelPresets: { [presetId]: preset },
    modelAssignments: { account: { ownerAccountId: preset.ownerAccountId, agent: { candidates: [presetId], default: presetId } } },
    app: { userId: config.app?.userId, userMode: config.app?.userMode },
    agents: { defaults: { ...config.agents.defaults, workspace, maxToolIterations: 40, fallbackModels: [], dream: { enabled: false } } },
    tools: {
      restrictToWorkspace: true, mcpServers: {}, web: { enabled: false },
      browser: { enabled: false }, imageGeneration: { enabled: false },
      // Workspace path checks alone do not sandbox package installers or shell side effects.
      exec: { enabled: scenario === "exec", allowPatterns: ["^cat source\\.txt(?:\\s*>\\s*extracted\\.txt)?$"] },
    },
    memmyMemory: { enabled: false }, fileMemory: { enabled: false },
    sessionDag: { enabled: false }, contextCompaction: { summaryMode: "text" }, heartbeat: { enabled: false },
  };
  await fs.writeFile(path.join(folder, "config.yaml"), YAML.stringify(isolated), { mode: 0o600 });
  let prompt: string;
  if (scenario === "docx") {
    await writeDocx(workspace, reportText());
    prompt = "请完整阅读工作区 synthetic-report.docx，并汇总所有 VERIFIED 标记对应的字段和值。不要遗漏后半部分。说明你是否读到了文档末尾；仅根据文档作答，不联网。";
  } else if (scenario === "pdf") {
    await writePdf(workspace, 20);
    prompt = "请核实工作区 synthetic-report.pdf 第20页的全部 VERIFIED 字段和值，给出页码和准确数值。仅根据文档作答，不联网。";
  } else {
    await fs.writeFile(path.join(workspace, "source.txt"), reportText());
    prompt = "请先用 exec 执行 cat source.txt，核实该命令输出中的全部 VERIFIED 字段和值。如果初次输出不完整，请自行获取缺失部分后再作答。只操作当前工作区，不联网。";
  }
  await fs.writeFile(path.join(folder, "prompt.txt"), prompt);
}
await fs.writeFile(path.join(root, "expected.json"), JSON.stringify({ facts: REPORT_FACTS, scenarios: ["docx", "pdf", "exec"] }, null, 2));
console.log(root);
