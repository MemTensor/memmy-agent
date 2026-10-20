import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputLocationPolicy } from "../../../../src/core/agent-runtime/tools/output-location.js";
import { EditFileTool, WriteFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";
let root: string, workspace: string, policy: OutputLocationPolicy;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-delivery-manifest-"));
  workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  policy = new OutputLocationPolicy(workspace, {}, []);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("complete delivery manifest", () => {
  it("checks a missing Excel even when the reply links only the existing PDF", async () => {
    const pdf = path.join(workspace, "report.pdf"), excel = path.join(workspace, "summary.xlsx");
    policy.recordFile(pdf, true); policy.recordFile(excel, true); await fs.writeFile(pdf, "pdf");
    expect(await policy.checkDelivery(`[report](${pdf})`)).toEqual([excel]);
  });
  it("checks literal parentheses without parsing Markdown", async () => {
    const target = path.join(workspace, "report(终版).pdf"), existing = path.join(workspace, "summary.csv");
    policy.recordFile(target, true); policy.recordFile(existing, true); await fs.writeFile(existing, "summary");
    expect(await policy.checkDelivery(`[report](${target}) [summary](${existing})`)).toEqual([target]);
    await fs.writeFile(target, "pdf"); expect(await policy.checkDelivery("done")).toEqual([]);
  });
  it("registers file-tool declarations before generating one of two promised files", async () => {
    const pdf = path.join(workspace, "report.md"), excel = path.join(workspace, "summary.csv");
    await new WriteFileTool({ workspace, postWriteValidation: false }).execute({ path: pdf, content: "report", output_paths: [pdf, excel] } as any, { outputLocation: policy });
    expect(await policy.checkDelivery(`[report](${pdf})`)).toEqual([excel]);
  });
  it("permits disposable working files without making them delivery obligations", async () => {
    const scratch = path.join(workspace, "README.md");
    await new WriteFileTool({ workspace, postWriteValidation: false }).execute({ path: scratch, content: "internal" }, { outputLocation: policy });
    await fs.rm(scratch); expect(await policy.checkDelivery(`[internal](${scratch})`)).toEqual([]);
  });
  it("keeps the complete manifest when a validated edit selects one occurrence", async () => {
    const report = path.join(workspace, "report.md"), summary = path.join(workspace, "summary.csv");
    await fs.writeFile(report, "draft draft");
    await new EditFileTool({ workspace, postWriteValidation: false }).execute({
      path: report, old_text: "draft", new_text: "final", occurrence: 2, expected_replacements: 1,
      output_paths: [report, summary],
    }, { outputLocation: policy });
    expect(await fs.readFile(report, "utf8")).toBe("draft final");
    expect(await policy.checkDelivery(`[report](${report})`)).toEqual([summary]);
  });
  it("rejects incompatible edit selectors before registering outputs or changing files", async () => {
    const report = path.join(workspace, "report.md"), summary = path.join(workspace, "summary.csv");
    await fs.writeFile(report, "draft");
    const result = await new EditFileTool({ workspace, postWriteValidation: false }).execute({
      path: report, old_text: "draft", new_text: "final", occurrence: 1, replace_all: true,
      output_paths: [report, summary],
    }, { outputLocation: policy });
    expect(result).toContain("occurrence cannot be used with replace_all=true");
    expect(await fs.readFile(report, "utf8")).toBe("draft");
    expect(policy.hasOutputs).toBe(false);
  });
  it("merges child obligations into the parent while children check their own subset", async () => {
    const parentFile = path.join(workspace, "report.pdf"), childFile = path.join(workspace, "summary.xlsx");
    policy.recordFile(parentFile, true); const child = policy.fork(); child.recordFile(childFile, true);
    await fs.writeFile(childFile, "excel"); expect(await child.checkDelivery("done")).toEqual([]);
    expect(await policy.checkDelivery("done")).toEqual([parentFile]);
    await fs.rm(childFile); expect(await policy.checkDelivery("done")).toEqual([parentFile, childFile]);
  });
  it("moves pending obligations by relative path when the destination changes", async () => {
    const old = path.join(workspace, "nested", "report.pdf"); policy.recordFile(old, true);
    await fs.mkdir(path.dirname(old)); await fs.writeFile(old, "pdf");
    const destination = path.join(root, "delivery"), request = `保存到 ${destination}`;
    policy.addUserRequest(request); await policy.selectDirectory(destination, request);
    expect(await policy.checkDelivery("done")).toEqual([path.join(destination, "nested", "report.pdf")]);
    await fs.mkdir(path.join(destination, "nested"), { recursive: true });
    await fs.writeFile(path.join(destination, "nested", "report.pdf"), "pdf"); expect(await policy.checkDelivery("done")).toEqual([]);
  });
});

describe("declaration lifetime", () => {
  it("keeps accepted obligations when a file write fails and merges later partial declarations", async () => {
    const directory = path.join(workspace, "report.md"), missing = path.join(workspace, "summary.csv");
    await fs.mkdir(directory);
    await expect(new WriteFileTool({ workspace, postWriteValidation: false }).execute({ path: directory,
      content: "report", output_paths: [directory, missing] }, { outputLocation: policy })).rejects.toThrow();
    await policy.declareOutputs([missing]); await policy.declareOutputs([]);
    expect(await policy.checkDelivery()).toEqual([directory, missing]);
  });
  it("rejects the whole declaration before recording any invalid destination", async () => {
    const allowed = path.join(workspace, "report.md"), wrong = path.join(root, "source", "summary.csv");
    expect(await policy.declareOutputs([allowed, wrong])).toContain("outside allowed directory");
    expect(policy.hasOutputs).toBe(false);
  });
  it("does not downgrade an already-declared final file when an optional declaration is omitted", async () => {
    const target = path.join(workspace, "report.md"), outside = path.join(root, "outside");
    await policy.declareOutputs([target]); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "report.md"), "old"); await fs.symlink(path.join(outside, "report.md"), target);
    expect(await new WriteFileTool({ workspace, postWriteValidation: false }).execute({ path: target, content: "new" }, { outputLocation: policy })).toContain("outside allowed directory");
  });
  it("cannot reactivate a retired task from an old child", async () => {
    const child = policy.fork(), target = path.join(workspace, "report.md"); policy.retire();
    child.recordFile(target, true); child.addUserRequest(`保存到 ${root}`);
    expect(await child.selectDirectory(root, `保存到 ${root}`)).toContain("task has ended");
    expect(await child.checkWrite(target)).toContain("task has ended"); expect(policy.hasOutputs).toBe(false);
  });
  it("requires redeclaration when an unfinished task loses its in-memory manifest", async () => {
    const metadata = {};
    const original = new OutputLocationPolicy(workspace, metadata, []);
    await original.declareOutputs(["report.md"]);
    const recovered = new OutputLocationPolicy(workspace, metadata, []);
    expect(recovered.pendingProducers()).toHaveLength(1);
    await recovered.declareOutputs([]); expect(recovered.pendingProducers()).toHaveLength(1);
    await recovered.declareOutputs(["report.md"]); expect(recovered.pendingProducers()).toEqual([]);
    expect(await recovered.checkDelivery()).toEqual([path.join(workspace, "report.md")]);
    recovered.retire(); expect(new OutputLocationPolicy(workspace, metadata, []).hasWork).toBe(false);
  });
});
