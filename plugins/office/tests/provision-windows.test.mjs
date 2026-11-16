import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { downloadPinnedInput } from "../scripts/office-build-inputs.mjs";
import { provisionWindowsBuildInputs } from "../scripts/provision-windows.mjs";

function executable(file, machine = 0x8664) {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 60);
  bytes.write("PE\0\0", 128); bytes.writeUInt16LE(machine, 132);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
}

async function fixture(t, { installerStatus = 0, missingLibreoffice = false, machine, missingPoppler, extractionStatus = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "office-windows-provision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const githubEnv = join(root, "github-env"); await writeFile(githubEnv, "");
  const programFiles = join(root, "Program Files $literal");
  const calls = [], downloads = [], events = [];
  const libreofficeArchive = join(root, "verified-libreoffice.msi"), popplerArchive = join(root, "verified-poppler.zip");
  const options = {
    platform: "win32", arch: "x64", runnerTemp: root, githubEnv, programFiles,
    env: { RUNNER_TEMP: root, GITHUB_ENV: githubEnv, ProgramFiles: programFiles },
    async downloadInput(spec) {
      downloads.push(spec); events.push(`verified:${spec.filename}`);
      return spec.filename.endsWith(".msi") ? libreofficeArchive : popplerArchive;
    },
    runNative(command, args, nativeOptions) {
      calls.push({ command, args, options: nativeOptions }); events.push(command);
      if (command === "msiexec.exe") {
        if (!missingLibreoffice) executable(join(programFiles, "LibreOffice", "program", "soffice.exe"), machine);
        return { status: installerStatus, signal: null };
      }
      assert.equal(command, "powershell.exe");
      const output = nativeOptions.env.MEMMY_OFFICE_POPPLER_DESTINATION;
      for (const name of ["pdfinfo", "pdftoppm", "pdftotext"]) {
        if (name !== missingPoppler) executable(join(output, "poppler-26.09.0", "Library", "bin", `${name}.exe`));
      }
      return { status: extractionStatus, signal: null };
    },
  };
  return { root, githubEnv, programFiles, libreofficeArchive, popplerArchive, options, calls, downloads, events };
}

for (const [platform, arch] of [["darwin", "arm64"], ["win32", "arm64"], ["win32", "ia32"]]) {
  test(`rejects unsupported worker ${platform}/${arch} before download or installation`, async t => {
    const f = await fixture(t);
    await assert.rejects(provisionWindowsBuildInputs({ ...f.options, platform, arch }), /native win32\/x64/u);
    assert.deepEqual(f.downloads, []); assert.deepEqual(f.calls, []);
  });
}

for (const installerStatus of [0, 3010]) {
  test(`accepts MSI exit ${installerStatus} only after both verified inputs and real x64 executable validation`, async t => {
    const f = await fixture(t, { installerStatus });
    const paths = await provisionWindowsBuildInputs(f.options);
    assert.equal(f.downloads.length, 2);
    assert.equal(f.downloads[0].version, "26.2.7"); assert.equal(f.downloads[1].version, "26.09.0-0");
    assert.deepEqual(f.events.slice(2), ["msiexec.exe", "powershell.exe"]);
    assert.deepEqual(f.calls[0].args, ["/i", f.libreofficeArchive, "/qn", "/norestart", "/L*v", join(f.root, "office-build-inputs", "libreoffice-msi.log")]);
    for (const call of f.calls) { assert.equal(call.options.timeout, 180_000); assert.equal(call.options.windowsHide, true); }
    const extraction = f.calls[1];
    assert.equal(extraction.options.env.MEMMY_OFFICE_POPPLER_ARCHIVE, f.popplerArchive);
    assert.equal(extraction.args.at(-1).includes(f.root), false); // Paths are environment data, never PowerShell source.
    assert.match(extraction.args.at(-1), /Expand-Archive -LiteralPath \$env:MEMMY_OFFICE_POPPLER_ARCHIVE/u);
    assert.equal(await readFile(f.githubEnv, "utf8"), `OFFICE_BUILD_LIBREOFFICE=${paths.libreoffice}\nOFFICE_BUILD_POPPLER=${paths.poppler}\n`);
  });
}

test("real pinned-input SHA verification rejects bad bytes before any native installation", async t => {
  const f = await fixture(t);
  let fetched = 0;
  await assert.rejects(provisionWindowsBuildInputs({
    ...f.options,
    downloadInput: (spec, cache) => downloadPinnedInput(spec, cache, {
      async fetchFile(_url, destination) { fetched += 1; await writeFile(destination, "unverified renderer bytes"); },
      warn() {},
    }),
  }));
  assert.ok(fetched > 0); assert.deepEqual(f.calls, []);
  assert.equal(await readFile(f.githubEnv, "utf8"), "");
});

test("waits for Poppler verification before starting the LibreOffice installer", async t => {
  const f = await fixture(t);
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const original = f.options.downloadInput;
  const provisioning = provisionWindowsBuildInputs({ ...f.options, async downloadInput(spec, cache) {
    if (!spec.filename.endsWith(".msi")) { started(); await held; }
    return original(spec, cache);
  } });
  await entered;
  try {
    assert.deepEqual(f.calls, []);
  } finally {
    release(); await provisioning;
  }
});

test("installer failure preserves the diagnostic log path and never extracts or publishes", async t => {
  const f = await fixture(t, { installerStatus: 1603 });
  await assert.rejects(provisionWindowsBuildInputs(f.options), error => error.message.includes("exit 1603")
    && error.message.includes(join(f.root, "office-build-inputs", "libreoffice-msi.log")));
  assert.equal(f.downloads.length, 2); assert.equal(f.calls.length, 1);
  assert.equal(await readFile(f.githubEnv, "utf8"), "");
});

test("native installer timeout fails closed without extraction or environment publication", async t => {
  const f = await fixture(t);
  await assert.rejects(provisionWindowsBuildInputs({ ...f.options, runNative(command, _args, options) {
    assert.equal(command, "msiexec.exe"); assert.equal(options.timeout, 180_000);
    return { status: null, signal: "SIGTERM", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  } }), /ETIMEDOUT.*installer log/u);
  assert.equal(await readFile(f.githubEnv, "utf8"), "");
});

test("MSI reboot-success code does not excuse a missing installed executable", async t => {
  const f = await fixture(t, { installerStatus: 3010, missingLibreoffice: true });
  await assert.rejects(provisionWindowsBuildInputs(f.options), /Invalid Windows renderer executable.*installer log/u);
  assert.equal(f.calls.length, 1); assert.equal(await readFile(f.githubEnv, "utf8"), "");
});

test("rejects an installed executable with the wrong architecture", async t => {
  const f = await fixture(t, { machine: 0x14c });
  await assert.rejects(provisionWindowsBuildInputs(f.options), /Expected an AMD64 PE executable/u);
  assert.equal(f.calls.length, 1); assert.equal(await readFile(f.githubEnv, "utf8"), "");
});

test("requires every Poppler executable before publishing either runtime path", async t => {
  const f = await fixture(t, { missingPoppler: "pdftotext" });
  await assert.rejects(provisionWindowsBuildInputs(f.options), /Invalid Windows renderer executable.*pdftotext/u);
  assert.equal(f.calls.length, 2); assert.equal(await readFile(f.githubEnv, "utf8"), "");
});

test("extraction failure leaves both runtime paths unpublished", async t => {
  const f = await fixture(t, { extractionStatus: 17 });
  await assert.rejects(provisionWindowsBuildInputs(f.options), /Poppler extraction failed \(exit 17\)/u);
  assert.equal(await readFile(f.githubEnv, "utf8"), "");
});

test("refuses stale installation outputs before downloads or native commands", async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, "office-build-inputs"));
  await assert.rejects(provisionWindowsBuildInputs(f.options), { code: "EEXIST" });
  assert.deepEqual(f.downloads, []); assert.deepEqual(f.calls, []);
});
