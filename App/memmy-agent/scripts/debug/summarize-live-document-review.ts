// Export only visible answers and tool evidence, excluding credentials and reasoning streams.
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
const expected = JSON.parse(await fs.readFile(path.join(root, "expected.json"), "utf8"));
const summaries = [];
for (const scenario of expected.scenarios) {
  const folder = path.join(root, scenario);
  let run;
  try { run = JSON.parse(await fs.readFile(path.join(folder, "run-result.json"), "utf8")); }
  catch { continue; }
  const webui = path.join(folder, "data", "webui");
  const events: any[] = [];
  for (const file of await fs.readdir(webui)) {
    if (!file.endsWith(".jsonl")) continue;
    const lines = (await fs.readFile(path.join(webui, file), "utf8")).trim().split("\n");
    for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* partial write */ } }
  }
  const tools = events.flatMap((event) => event.tool_events ?? []).filter((event) => event.phase === "end" || event.phase === "error");
  const final = events.filter((event) => event.event === "message" && !["tool_hint", "progress"].includes(event.kind)).at(-1)?.text ?? "";
  summaries.push({
    scenario, exitCode: run.exitCode, timedOut: run.timedOut, elapsedMs: run.elapsedMs,
    finalAnswer: final,
    expectedValuesPresent: Object.fromEntries(expected.facts.map((fact: string) => [fact, final.replace(/,/g, "").includes(fact.split("=")[1])])),
    tools: tools.map((tool) => {
      const result = typeof tool.result === "string" ? tool.result : "";
      return {
        name: tool.name, phase: tool.phase,
        arguments: Object.fromEntries(Object.entries(tool.arguments ?? {}).filter(([key]) => ["path", "offset", "limit", "char_offset", "char_limit", "pages", "command", "pattern", "query"].includes(key))),
        resultChars: result.length,
        documentRange: /\[Document read: chars[^\]]+\]/.exec(result)?.[0],
        truncated: /truncated/i.test(result), error: tool.error,
      };
    }),
  });
}
await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(summaries, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summaries, null, 2));
