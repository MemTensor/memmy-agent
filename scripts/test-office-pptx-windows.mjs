/** Trusted CI fixtures only. No user documents, no production runtime changes. */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildThreadProbe } from "./office-pptx-thread-probe.mjs";
import { buildWindowsConverter } from "../plugins/office/scripts/build-windows-converter.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ExcelJS = createRequire(join(repo, "plugins/office/package.json"))("exceljs");
const { PDFDocument } = createRequire(join(repo, "plugins/office/package.json"))("pdf-lib");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Persist file-backed stdio without excerpting or deleting diagnostics. The
// AppContainer launcher assigns descendants to its kill-on-close Job object.
async function capture(command, args, cwd, env, prefix, timeout, input = "") {
  const handles = [];
  let timer;
  const started = Date.now();
  let timedOut = false;
  try {
    await writeFile(`${prefix}.stdin`, input);
    for (const [file, mode] of [[`${prefix}.stdin`, "r"], [`${prefix}.stdout`, "w"], [`${prefix}.stderr`, "w"]]) handles.push(await open(file, mode));
    await writeFile(`${prefix}.command.json`, JSON.stringify({ command, args, cwd, timeout }, null, 2));
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: handles.map(h => h.fd) });
    const result = await new Promise((ok, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => ok({ code, signal }));
      timer = setTimeout(() => {
        timedOut = true;
        // Kill only this owned diagnostic process tree, including a converter
        // running outside the sandbox. Never leave a timed-out renderer alive.
        try { execFileSync(join(process.env.SystemRoot, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 15000 }); }
        catch { child.kill("SIGKILL"); }
      }, timeout);
    });
    return { ...result, timedOut, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    await Promise.all(handles.map(h => h.close()));
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("Remote Windows CI only; do not run rendering locally");
  const root = await mkdtemp(join(process.env.RUNNER_TEMP, "pptx-"));
  const evidence = resolve(process.env.OFFICE_PPTX_DIAGNOSTICS);
  await mkdir(evidence, { recursive: true });
  const report = { commit: process.env.GITHUB_SHA, root, node: process.version, platform: process.platform, cases: [] };
  const save = () => writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  await save();
  try {
    const runtime = join(root, "rt");
    const program = join(runtime, "LibreOffice/program");
    await cp(join(process.env.ProgramFiles, "LibreOffice"), join(runtime, "LibreOffice"), { recursive: true, dereference: true });
    const threadProbe = process.env.OFFICE_PPTX_THREAD_PROBE === "1";
    const formats = (process.env.OFFICE_MINIMAL_FORMATS ?? "pptx").split(",");
    if (formats.some(format => !["docx", "pptx", "xlsx"].includes(format)) || new Set(formats).size !== formats.length)
      throw new Error("Expected unique supported OFFICE_MINIMAL_FORMATS");
    if (threadProbe && formats.join(",") !== "pptx") throw new Error("Thread probe requires PPTX only");
    report.formats = formats; report.threadProbe = threadProbe;
    if (threadProbe) await buildThreadProbe(repo, program, evidence);
    else await buildWindowsConverter(program);
    for (const dll of ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll"]) {
      await copyFile(join(process.env.SystemRoot, "System32", dll), join(program, dll));
    }
    const executable = join(program, "memmy-office-convert.exe");
    report.converterSha256 = hash(await readFile(executable));
    const data = join(root, "data"); await mkdir(data);
    const fixtureEnv = { ...process.env, MEMMY_PLUGIN_DATA_DIR: data };
    let fixtureCall = 0;
    async function plugin(id, input) {
      const prefix = join(evidence, `fixture-${++fixtureCall}-${id}`);
      const result = await capture(process.execPath, [join(repo, "plugins/office/src/main.mjs")], repo, fixtureEnv, prefix, 60000, JSON.stringify({ capabilityId: id, input }) + "\n");
      const events = (await readFile(`${prefix}.stdout`, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const output = events.find(event => event.type === "result")?.output;
      if (result.code !== 0 || !output) throw new Error(`Fixture ${id} failed; see full logs`);
      return output;
    }
    const fixtures = [];
    for (const format of formats) {
      const content = format === "pptx" ? { slides: [{ title: "Office integration", body: ["Independent plugin", "Actual page rendering"], notes: "Preserved speaker notes" }] }
        : format === "docx" ? { title: "Office integration", paragraphs: ["Windows event-thread regression.", "中文文档：生成、编辑、预览。"] }
        : { sheets: [{ name: "Budget", rows: [["Item", "Amount"], ["Research", 20], ["Writing", 30]] }] };
      const original = await plugin("office_create", { format, name: `sample.${format}`, ...content });
      const edited = await plugin("office_edit", { taskId: original.taskId, file: original.file, name: `edited.${format}`,
        ...(format === "xlsx" ? { cells: [{ sheet: "Budget", address: "B4", formula: "SUM(B2:B3)" }] }
          : { replacements: [{ from: "Office integration", to: "Office delivery verified" }] }) });
      const variants = threadProbe ? [["baseline", original], ["runloop", original]]
        : [["original", original], [format === "xlsx" ? "formula" : "edited", edited]];
      for (const [variant, document] of variants) fixtures.push({ variant, document, format });
    }
    for (const { variant, document, format } of fixtures) {
      const bytes = await readFile(join(data, "tasks", document.taskId, document.file));
      const fixtureId = format === "pptx" ? variant : `${format}-${variant}`;
      await writeFile(join(evidence, `${fixtureId}.${format}`), bytes);
      for (const mode of ["native", "appcontainer"]) {
        const id = `${fixtureId}-${mode}`;
        const work = join(root, id); await mkdir(work);
        const source = join(work, `source.${format}`), out = join(work, "out"), profile = join(work, "profile");
        await writeFile(source, bytes); await mkdir(out); await mkdir(join(profile, "user"), { recursive: true });
        await writeFile(join(profile, "user/registrymodifications.xcu"), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>');
        const env = {};
        for (const key of ["SystemRoot", "WINDIR", "PATH", "LOCALAPPDATA", "APPDATA", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
        Object.assign(env, { MEMMY_OFFICE_TRACE: "1", ...(threadProbe ? { MEMMY_PPTX_THREAD_MODEL: variant } : {}), TEMP: work, TMP: work, TMPDIR: work, HOME: work, XDG_CONFIG_HOME: join(work, "config"), XDG_CACHE_HOME: join(work, "cache") });
        const args = [`-env:UserInstallation=${pathToFileURL(profile).href}`, "-env:OSL_SOCKET_PATH=.", "--headless", "--norestore", "--nodefault", "--nolockcheck", "--convert-to", "pdf", "--outdir", out, source];
        const item = { id, format, mode, sourceSha256: hash(bytes), state: "running" };
        report.cases.push(item); await save();
        console.log(`Office minimal regression ${id} started`);
        try {
          const invoke = async (args, suffix = "") => {
            let command = executable, argv = args, hostEnv = env;
            if (mode === "appcontainer") {
              const plan = { profile: `memmy.plugin.office.pptx-${randomUUID()}`, command: executable, args, cwd: work, readRoots: [runtime], writeRoots: [work] };
              await writeFile(join(evidence, `${id}${suffix}.plan.json`), JSON.stringify(plan, null, 2));
              command = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
              argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(repo, "App/backend/src/adapters/outbound/plugin-runtime/windows/launch.ps1"), "-Plan", Buffer.from(JSON.stringify(plan)).toString("base64")];
              hostEnv = { ...env, MEMMY_SANDBOX_TRACE: "1", MEMMY_SANDBOX_CHILD_ENV: Buffer.from(JSON.stringify(env)).toString("base64") };
            }
            // Allow identical engine time plus a separate launcher allowance.
            return await capture(command, argv, work, hostEnv, join(evidence, `${id}${suffix}`), threadProbe ? (mode === "native" ? 60000 : 90000) : (mode === "native" ? 120000 : 150000));
          };
          if (format === "xlsx" && variant === "formula") {
            const recalcArgs = [...args];
            recalcArgs[recalcArgs.indexOf("--convert-to") + 1] = "xlsx:Calc MS Excel 2007 XML";
            item.recalculation = await invoke(recalcArgs, "-recalc");
            if (item.recalculation.code !== 0 || item.recalculation.timedOut) throw new Error("XLSX recalculation process failed");
            const calculatedPath = join(out, "source.xlsx");
            const calculated = await readFile(calculatedPath);
            await writeFile(join(evidence, `${id}-recalculated.xlsx`), calculated);
            const book = new ExcelJS.Workbook(); await book.xlsx.load(calculated);
            const cell = book.getWorksheet("Budget").getCell("B4");
            item.recalculation.formula = cell.formula;
            item.recalculation.cachedValue = cell.result;
            if (cell.formula !== "SUM(B2:B3)" || cell.result !== 50) throw new Error("Expected preserved SUM(B2:B3) formula and cached value 50");
            args[args.length - 1] = calculatedPath;
          }
          Object.assign(item, await invoke(args));
          try {
            const pdf = await readFile(join(out, "source.pdf"));
            item.pages = (await PDFDocument.load(pdf)).getPageCount();
            item.validPdf = pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) && item.pages > 0;
            await writeFile(join(evidence, `${id}.pdf`), pdf);
          } catch { item.validPdf = false; }
          item.sourceUnchanged = hash(await readFile(source)) === hash(bytes);
          item.state = item.code === 0 && !item.timedOut && item.validPdf && item.sourceUnchanged ? "passed" : "failed";
        } catch (error) { item.state = "failed"; item.error = String(error.stack ?? error); }
        await save(); console.log(`Office minimal regression ${id}: ${JSON.stringify(item)}`);
      }
    }
    if (report.cases.some(item => item.state !== "passed")) process.exitCode = 1;
  } catch (error) { report.setupError = String(error.stack ?? error); process.exitCode = 1; }
  finally { await save(); console.log(`Full diagnostic evidence: ${evidence}`); }
}
await main();
