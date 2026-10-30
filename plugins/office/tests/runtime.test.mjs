import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import JSZip from "jszip";
import { parseDelimited } from "../src/delimited.mjs";
import { writeMetadataFont } from "./helpers/cjk-font-fixture.mjs";

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

test("generated Han documents require a Host font before creating DOCX or PDF", async t => {
  const { data } = await environment(t);
  for (const format of ["docx", "pdf"]) {
    const result = await call(data, "office_create", {
      format, name: `missing-font.${format}`, paragraphs: ["中文内容：文档生成、预览与交付。"]
    });
    assert.equal(result.type, "error", JSON.stringify(result));
    assert.equal(result.code, "office_cjk_font_missing");
  }
});

test("generated Han DOCX declares the covering Host face without changing Latin fonts", async t => {
  const { data, root } = await environment(t);
  const latin = await writeMetadataFont(join(root, "latin.ttf"), "CJK In Name Only", "Latin");
  const covering = await writeMetadataFont(join(root, "han.ttf"), "Owned Han Coverage", "中文内容");
  const result = await call(data, "office_create", { format: "docx", name: "han.docx", title: "中文", paragraphs: ["Latin 内容"] }, {
    MEMMY_OFFICE_CJK_FONTS: JSON.stringify([latin, covering])
  });
  assert.equal(result.type, "result", JSON.stringify(result));
  const zip = await JSZip.loadAsync(await readFile(join(data, "tasks", result.output.taskId, result.output.file)));
  const styles = await zip.file("word/styles.xml").async("string");
  assert.match(styles, /w:eastAsia="Owned Han Coverage"/);
  for (const name of ["ascii", "hAnsi", "cs"]) assert.match(styles, new RegExp(`w:${name}="Arial"`));
  const document = await zip.file("word/document.xml").async("string");
  assert.match(document, /中文/); assert.match(document, /Latin 内容/);
});

test("generated Han PDF uses the covered source font and still requires a real renderer", async t => {
  const { data, root } = await environment(t);
  const covering = await writeMetadataFont(join(root, "han.ttf"), "Owned PDF Han", "中文");
  const result = await call(data, "office_create", { format: "pdf", name: "han.pdf", paragraphs: ["中文"] }, {
    MEMMY_OFFICE_CJK_FONTS: JSON.stringify([covering])
  });
  assert.equal(result.type, "error"); assert.equal(result.code, "office_dependency_missing");
  const tasks = await readdir(join(data, "tasks")); assert.equal(tasks.length, 1);
  const zip = await JSZip.loadAsync(await readFile(join(data, "tasks", tasks[0], "source.docx")));
  assert.match(await zip.file("word/styles.xml").async("string"), /w:eastAsia="Owned PDF Han"/);
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

test("execution copies inherit calculation state only from byte-identical clean inputs", async t => {
  const { data } = await environment(t);
  const generated = await call(data, "office_execute", { code: `
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Budget");
    sheet.addRows([["Amount", "Total"], [20, {formula:"SUM(A2:A3)", result:50}], [30]]);
    await fs.writeFile(path.join(workspace,"budget.xlsx"), await book.xlsx.writeBuffer());
    return {files:["budget.xlsx"]};
  ` });
  assert.equal(generated.type, "result", JSON.stringify(generated));
  const copy = async sourceTaskId => call(data, "office_execute", { sourceTaskId, inputFiles:["budget.xlsx"], code: `
    await fs.copyFile(path.join(workspace,"budget.xlsx"),path.join(workspace,"renamed.xlsx"));
    return {files:["renamed.xlsx"]};
  ` });
  const dirtyCopy = (await copy(generated.output.taskId)).output;
  const dirtyState = JSON.parse(await readFile(join(data,"tasks",dirtyCopy.taskId,"state.json"),"utf8"));
  assert.deepEqual(dirtyState.dirtyFormulaFiles,["renamed.xlsx"]);
  // Imported cached workbooks are clean under the existing import/delivery policy.
  const imported = (await call(data,"office_import", {path:join(data,"tasks",generated.output.taskId,"budget.xlsx")})).output;
  const cleanCopy = (await copy(imported.taskId)).output;
  const cleanState = JSON.parse(await readFile(join(data,"tasks",cleanCopy.taskId,"state.json"),"utf8"));
  assert.deepEqual(cleanState.dirtyFormulaFiles,[]);
  assert.deepEqual(cleanState.reviews,{});
  const changed = await call(data,"office_execute", {sourceTaskId:imported.taskId,inputFiles:["budget.xlsx"],code:`
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path.join(workspace,"budget.xlsx"));
    book.worksheets[0].getCell("A2").value = 99;
    await fs.writeFile(path.join(workspace,"budget.xlsx"),await book.xlsx.writeBuffer());
    return {files:["budget.xlsx"]};
  `});
  assert.equal(changed.type,"result",JSON.stringify(changed));
  const changedState = JSON.parse(await readFile(join(data,"tasks",changed.output.taskId,"state.json"),"utf8"));
  assert.deepEqual(changedState.dirtyFormulaFiles,["budget.xlsx"]);
});

test("normalization cannot report successful recalculation when the renderer only copies stale caches", { skip: process.platform === "win32" }, async t => {
  const { data, root } = await environment(t);
  const created = (await call(data,"office_execute", {code:`
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Budget");
    sheet.addRows([[20, {formula:"A1+30",result:0}], ["KEEP"]]);
    await fs.writeFile(path.join(workspace,"stale.xlsx"),await book.xlsx.writeBuffer());
    return {files:["stale.xlsx"]};
  `})).output;
  const source = join(data,"tasks",created.taskId,"stale.xlsx");
  const original = await readFile(source);
  const tools = join(root,"LibreOffice.app/Contents");
  await mkdir(join(tools,"MacOS"),{recursive:true});
  await mkdir(join(tools,"Resources/services"),{recursive:true});
  await writeFile(join(tools,"Resources/services/services.rdb"),'<components xmlns="http://openoffice.org/2010/uno-components"/>');
  const executable = join(tools,"MacOS/soffice");
  const captured = join(root,"captured.xlsx");
  await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const src=process.argv.at(-1);fs.copyFileSync(src,${JSON.stringify(captured)});fs.copyFileSync(src,path.join(process.argv[process.argv.indexOf('--outdir')+1],path.basename(src)));`,{mode:0o755});
  const result = await call(data,"office_convert",{taskId:created.taskId,file:"stale.xlsx",format:"xlsx",allowLossy:true},{MEMMY_OFFICE_TOOLS:JSON.stringify({soffice:executable})});
  assert.equal(result.code,"recalculation_failed",JSON.stringify(result));
  assert.deepEqual(await readFile(source),original);
  const zip = await JSZip.loadAsync(await readFile(captured));
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sheet,/<f>A1\+30<\/f>/);
  assert.doesNotMatch(sheet.match(/<c[^>]*r="B1"[^>]*>([\s\S]*?)<\/c>/)[1],/<v\b/);
  assert.match(await zip.file("xl/sharedStrings.xml").async("string"),/KEEP/);
  assert.match(await zip.file("xl/workbook.xml").async("string"),/fullCalcOnLoad="1"/);
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
