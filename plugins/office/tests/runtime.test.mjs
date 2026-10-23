import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import JSZip from "jszip";
import { parseDelimited } from "../src/delimited.mjs";

const executable = resolve(import.meta.dirname, "../dist/runtime/main.cjs");
async function environment(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "office-unit-")));
  await mkdir(join(root, "data"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data: join(root, "data") };
}
function call(data, capabilityId, input, extraEnv = {}) {
  return new Promise((ok, reject) => {
    const child = spawn(process.execPath, [executable], { env: { PATH: "/usr/bin:/bin", MEMMY_PLUGIN_DATA_DIR: data, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", b => output += b); child.stderr.on("data", b => errors += b);
    child.once("error", reject);
    child.once("close", code => {
      if (code) { reject(new Error(errors)); return; }
      const events = output.trim().split("\n").map(line => JSON.parse(line));
      ok(events.at(-1));
    });
    child.stdin.end(JSON.stringify({ capabilityId, input, callId: "unit", pluginId: "office", conversationId: "unit" }) + "\n");
  });
}

test("missing runtime is explicit and does not pass rendering", async t => {
  const { data } = await environment(t);
  const status = await call(data, "office_status", {});
  assert.equal(status.output.ready, false);
  assert.deepEqual(status.output.missing, ["soffice", "pdfinfo", "pdftoppm", "pdftotext"]);
  const doc = (await call(data, "office_create", { format: "docx", name: "report.docx", paragraphs: ["Runtime missing"] })).output;
  assert.equal((await call(data, "office_render", { taskId: doc.taskId, file: doc.file })).code, "office_dependency_missing");
  assert.equal((await call(data, "office_deliver", { taskId: doc.taskId, file: doc.file, revision: "fake", reviewedPages: [1], reviewNotes: "fake" })).code, "stale_review");
});

test("exact replacement across Word formatting runs preserves unrelated parts", async t => {
  const { data } = await environment(t);
  const created = (await call(data, "office_create", { format: "docx", name: "source.docx", paragraphs: ["Split phrase"] })).output;
  const file = join(data, "tasks", created.taskId, created.file);
  const zip = await JSZip.loadAsync(await readFile(file));
  const source = await zip.file("word/document.xml").async("string");
  zip.file("word/document.xml", source.replace("Split phrase", "Split ") .replace(/(<w:t[^>]*>Split <\/w:t>)/, '$1</w:r><w:r><w:rPr><w:b/></w:rPr><w:t>phrase</w:t>'));
  zip.file("customXml/preserved.bin", Buffer.from([1, 2, 3, 4]));
  await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  const edited = await call(data, "office_edit", { taskId: created.taskId, file: created.file, name: "edited.docx", replacements: [{ from: "Split phrase", to: "Updated phrase" }] });
  assert.equal(edited.type, "result", JSON.stringify(edited));
  const result = await call(data, "office_inspect", { taskId: created.taskId, file: "edited.docx" });
  assert.match(result.output.text, /Updated phrase/);
  const finalZip = await JSZip.loadAsync(await readFile(join(data, "tasks", created.taskId, "edited.docx")));
  assert.deepEqual(await finalZip.file("customXml/preserved.bin").async("nodebuffer"), Buffer.from([1, 2, 3, 4]));
});

test("unsafe names, macro packages and formula-to-constant edits fail closed", async t => {
  const { data } = await environment(t);
  assert.equal((await call(data, "office_create", { format: "docx", name: "../source.docx", paragraphs: ["x"] })).code, "invalid_path");
  const created = (await call(data, "office_create", { format: "xlsx", name: "book.xlsx", sheets: [{ name: "Data", rows: [[{ formula: "SUM(1,2)" }]] }] })).output;
  assert.equal((await call(data, "office_edit", { taskId: created.taskId, file: created.file, name: "edit.xlsx", cells: [{ sheet: "Data", address: "A1", value: 3 }] })).code, "formula_preservation_required");
  const file = join(data, "tasks", created.taskId, created.file);
  const zip = await JSZip.loadAsync(await readFile(file)); zip.file("xl/vbaProject.bin", "macro");
  await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal((await call(data, "office_inspect", { taskId: created.taskId, file: created.file })).code, "unsupported_document");
});

test("advanced code creates real tables and cannot read outside its workspace or spawn subprocesses", async t => {
  const { data, root } = await environment(t);
  const executed = await call(data, "office_execute", { code: `
    const { Document, Packer, Paragraph, Table, TableRow, TableCell } = docx;
    const document = new Document({sections:[{children:[new Table({rows:[new TableRow({children:[new TableCell({children:[new Paragraph("Advanced table")]})]})]})]}]});
    await fs.writeFile(path.join(workspace, "table.docx"), await Packer.toBuffer(document));
    return {files:["table.docx"]};
  ` });
  assert.equal(executed.type, "result", JSON.stringify(executed));
  const inspected = await call(data, "office_inspect", { taskId: executed.output.taskId, file: "table.docx" });
  assert.match(inspected.output.text, /Advanced table/);
  const secret = join(root, "outside.txt"); await writeFile(secret, "not readable");
  const denied = await call(data, "office_execute", { code: `await fs.readFile(${JSON.stringify(secret)}); return {files:[]};` });
  assert.equal(denied.code, "office_execution_failed"); assert.match(denied.message, /Access|permission/i);
  const noSpawn = await call(data, "office_execute", { code: `const cp = await import("node:child_process"); cp.execFileSync(process.execPath, ["-e", "process.exit(0)"]); return {files:[]};` });
  assert.equal(noSpawn.code, "office_execution_failed"); assert.match(noSpawn.message, /Access|permission/i);
});

test("advanced code cannot forge review state in the parent task directory", async t => {
  const { data } = await environment(t);
  const denied = await call(data, "office_execute", { code: `await fs.writeFile(path.join(workspace, "../state.json"), "{}"); return {files:[]};` });
  assert.equal(denied.code, "office_execution_failed"); assert.match(denied.message, /Access|permission/i);
});

test("parallel edits retain all formula invalidations in shared task state", async t => {
  const { data } = await environment(t);
  const created = (await call(data, "office_create", { format: "xlsx", name: "book.xlsx", sheets: [{ name: "Data", rows: [["Input", "Total"], [1, { formula: "SUM(A2:A4)" }], [2], [3]] }] })).output;
  const outputs = await Promise.all([1, 2, 3, 4].map(index => call(data, "office_edit", { taskId: created.taskId, file: created.file, name: `edit-${index}.xlsx`, cells: [{ sheet: "Data", address: "A2", value: index * 10 }] })));
  for (const result of outputs) assert.equal(result.type, "result", JSON.stringify(result));
  const s = JSON.parse(await readFile(join(data, "tasks", created.taskId, "state.json"), "utf8"));
  for (let index = 1; index <= 4; index++) assert.ok(s.dirtyFormulaFiles.includes(`edit-${index}.xlsx`));
});

test("CSV policy rejects malformed data and preserves quoted/newline/text fields", async t => {
  const policy = { encoding: "UTF-8", bom: "absent", delimiter: ",", quote: '"', newline: "lf", malformedRows: "reject" };
  assert.deepEqual(parseDelimited(Buffer.from('Name,Value\n"line\nbreak","a""b"\n'), policy), [["Name", "Value"], ["line\nbreak", 'a"b']]);
  assert.throws(() => parseDelimited(Buffer.from("a,b\n1\n"), policy), /malformed/);
  assert.throws(() => parseDelimited(Buffer.from('a,"unclosed'), policy), /Unclosed/);
  assert.throws(() => parseDelimited(Buffer.from([255]), policy));
  assert.throws(() => parseDelimited(Buffer.from("a,b\r\n1,2\r\n"), policy), /newline/);
  assert.throws(() => parseDelimited(Buffer.from("\ufeffa,b\n1,2"), policy), /BOM/);
  const { data, root } = await environment(t);
  const source = join(root, "input.csv"); await writeFile(source, "Code,Value\n001,=1+2\n");
  const imported = (await call(data, "office_import", { path: source })).output;
  const converted = await call(data, "office_convert", { taskId: imported.taskId, file: imported.file, format: "xlsx", csv: policy });
  assert.equal(converted.type, "result", JSON.stringify(converted));
  const inspected = await call(data, "office_inspect", { taskId: imported.taskId, file: converted.output.file });
  assert.deepEqual(inspected.output.sheets[0].rows[1], ["001", "=1+2"]);
  assert.deepEqual(inspected.output.formulas, []);
});

test("oversized ZIP metadata is refused before CRC decompression", async t => {
  const { data } = await environment(t);
  const created = (await call(data, "office_create", { format: "docx", name: "input.docx", paragraphs: ["Input"] })).output;
  const zip = new JSZip(); zip.file("payload.bin", "x");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(101 * 1024 * 1024, 22);
  bytes.writeUInt32LE(101 * 1024 * 1024, central + 24);
  await writeFile(join(data, "tasks", created.taskId, created.file), bytes);
  const inspected = await call(data, "office_inspect", { taskId: created.taskId, file: created.file });
  assert.equal(inspected.code, "unsafe_document"); assert.match(inspected.message, /100 MiB/);
});
