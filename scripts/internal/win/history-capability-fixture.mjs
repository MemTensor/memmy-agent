// Repeatable positive/negative controls for the four-layer diagnostic harness.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { runCapabilityCase } from "./history-capability.mjs";
const [binDir, reportRoot] = process.argv.slice(2).map((value) => path.resolve(value));
fs.mkdirSync(reportRoot, { recursive: false });
const nonce = "capability-controls";
const fixture = spawn(path.join(binDir, "memmy-history-fixture.exe"), ["--nonce", nonce], { stdio: ["pipe", "pipe", "pipe"] });
fixture.stderr.resume();
const reader = readline.createInterface({ input: fixture.stdout });
const iterator = reader[Symbol.asyncIterator]();
const closed = new Promise((resolve) => fixture.once("close", resolve));
async function command(text) {
  fixture.stdin.write(`${text}\n`);
  let timeout;
  try {
    const response = await Promise.race([iterator.next(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("fixture_timeout")), 5000); })]);
    if (response.done) throw new Error("fixture_closed");
    return JSON.parse(response.value);
  } finally { clearTimeout(timeout); }
}
const results = [];
try {
  const info = await command("info");
  const base = { syntheticOnly: true, hwnd: info.hwndA, executable: info.exe, title: "Memmy History Fixture A",
    marker: `FIXTURE-DOCUMENT-${nonce}`, bodyIds: ["1006"], uiAutomationTextInspectionBeforeCase: false,
    forbiddenMarkers: ["FIXTURE-PASSWORD-", "FIXTURE-PWCHILD-", "FIXTURE-EDIT-", "FIXTURE-EDITCHILD-", "FIXTURE-SENSITIVE-"] };
  const documentRegions = [{ controlType: "Document", automationId: "1006" }, { controlType: "Edit", automationId: "1006" }];
  for (const [name, changes] of [
    ["positive", { rule: { documentRegions, sensitiveAutomationIds: ["1007"] }, expected: "four_layers_present" }],
    ["no-body-selector", { rule: { sensitiveAutomationIds: ["1007"] }, expected: "native_policy_exclusion_confirmed" }],
    ["wrong-body-selector", { rule: { documentRegions: [{ controlType: "Document", automationId: "not-the-body" }], sensitiveAutomationIds: ["1007"] }, expected: "native_policy_exclusion_confirmed" }],
    ["wrong-probe-selector", { bodyIds: ["not-the-body"], rule: { documentRegions, sensitiveAutomationIds: ["1007"] }, expected: "product_present_probe_inconclusive" }],
  ]) {
    const activation = await command("activate a");
    fs.writeFileSync(path.join(reportRoot, `${name}-activation.json`), JSON.stringify(activation, null, 2));
    const result = await runCapabilityCase({ manifest: { ...base, ...changes },
      nativeBin: path.join(binDir, "memmy-history-recorder.exe"), probeBin: path.join(binDir, "memmy-history-capability-probe.exe"),
      reportDir: path.join(reportRoot, name) });
    results.push({ name, conclusion: result.conclusion, expectationMet: result.expectationMet, layers: result.layers });
  }
  await command("activate b");
  const negative = await runCapabilityCase({ manifest: base, nativeBin: path.join(binDir, "memmy-history-recorder.exe"),
    probeBin: path.join(binDir, "memmy-history-capability-probe.exe"), reportDir: path.join(reportRoot, "not-foreground") });
  results.push({ name: "not-foreground", conclusion: negative.conclusion, expectationMet: negative.conclusion === "precondition_invalid" });
} finally {
  fixture.stdin.end(); const timer = setTimeout(() => fixture.kill(), 3000); await closed; clearTimeout(timer); reader.close();
  fs.writeFileSync(path.join(reportRoot, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
if (results.length !== 5 || results.some((result) => !result.expectationMet)) process.exitCode = 1;
