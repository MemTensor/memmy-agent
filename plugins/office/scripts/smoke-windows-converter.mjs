/** Build-time test with a trusted generated document; never used for user files. */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { runProcess } from "../src/process.mjs";

export async function smokeWindowsConverter(executable) {
  const root = await mkdtemp(join(tmpdir(), "office-converter-smoke-"));
  try {
    const input = join(root, "smoke.docx"), output = join(root, "output"), profile = join(root, "profile");
    await mkdir(output); await mkdir(join(profile, "user"), { recursive: true });
    const initialConfiguration = '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>';
    await writeFile(join(profile, "user/registrymodifications.xcu"), initialConfiguration);
    const doc = new JSZip();
    doc.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    doc.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    doc.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office renderer smoke test</w:t></w:r></w:p></w:body></w:document>');
    await writeFile(input, await doc.generateAsync({ type: "nodebuffer" }));
    const env = {};
    for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
    env.MEMMY_OFFICE_TRACE = "1";
    const result = await runProcess(executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--convert-to", "pdf", "--outdir", output, input], { cwd: root, env, timeout: 60_000, maxOutput: 1024 * 1024 });
    console.log(result.stderr);
    if (result.code !== 0) throw new Error(`Windows renderer build smoke failed (${result.code}): ${result.stderr}`);
    if (!(await readFile(join(output, "smoke.pdf"))).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Windows renderer smoke did not produce a PDF");
    console.log("Windows renderer build smoke passed");
    // Fail before publishing if the same engine cannot start under the actual
    // Host's AppContainer launcher. Only this trusted fixture runs in CI here.
    await rm(join(output, "smoke.pdf"));
    const isolatedWork = join(root, "isolated");
    const isolatedOutput = join(isolatedWork, "output");
    await mkdir(isolatedOutput, { recursive: true });
    const isolatedProfile = join(isolatedWork, "profile");
    await mkdir(join(isolatedProfile, "user"), { recursive: true });
    await writeFile(join(isolatedProfile, "user/registrymodifications.xcu"), initialConfiguration);
    const launcher = fileURLToPath(new URL("../../../App/backend/src/adapters/outbound/plugin-runtime/windows/launch.ps1", import.meta.url));
    const args = [`-env:UserInstallation=${pathToFileURL(isolatedProfile).href}`, "--headless", "--convert-to", "pdf", "--outdir", isolatedOutput, input];
    // Match the Host grant for the verified portable archive. LibreOffice's
    // base-installation checks also query metadata above its program folder.
    const plan = Buffer.from(JSON.stringify({ profile: `memmy.plugin.office.smoke-${randomUUID()}`, command: executable, args, cwd: isolatedWork,
      readRoots: [resolve(dirname(executable), "../..")], writeRoots: [root] })).toString("base64");
    const childEnv = { ...env, TEMP: isolatedWork, TMP: isolatedWork, TMPDIR: isolatedWork, HOME: isolatedWork };
    const hostEnv = { ...env, MEMMY_SANDBOX_TRACE: "1", MEMMY_SANDBOX_CHILD_ENV: Buffer.from(JSON.stringify(childEnv)).toString("base64") };
    const isolated = await runProcess(join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, "-Plan", plan],
      { cwd: root, env: hostEnv, timeout: 120_000, maxOutput: 1024 * 1024 });
    console.log(isolated.stderr);
    if (isolated.code !== 0) throw new Error(`Windows renderer AppContainer smoke failed (${isolated.code}): ${isolated.stderr}`);
    if (!(await readFile(join(isolatedOutput, "smoke.pdf"))).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Isolated Windows renderer smoke did not produce a PDF");
    console.log("Windows renderer AppContainer smoke passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}
