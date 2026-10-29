/** CI-only derived converter: keep production source and runtime unchanged. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildThreadProbe(repo, program, evidence, { sourceOnly = false } = {}) {
  let source = await readFile(join(repo, "plugins/office/native/windows-convert.cpp"), "utf8");
  const replace = (from, to) => {
    if (!source.includes(from)) throw new Error(`Probe source anchor missing: ${from.slice(0, 80)}`);
    source = source.replace(from, to);
  };
  replace('#include <tlhelp32.h>', `#include <tlhelp32.h>
#include <wct.h>
#pragma comment(lib, "advapi32.lib")
static void diagnosticWaitChain(DWORD id) {
    HWCT session = OpenThreadWaitChainSession(0, NULL);
    if (!session) { fprintf(stderr, "WCT unavailable: %lu\\n", GetLastError()); return; }
    WAITCHAIN_NODE_INFO nodes[WCT_MAX_NODE_COUNT] = {};
    DWORD count = WCT_MAX_NODE_COUNT; BOOL cycle = FALSE;
    if (GetThreadWaitChain(session, 0, WCTP_GETINFO_ALL_FLAGS, id, &count, nodes, &cycle)) {
        fprintf(stderr, "WCT thread=%lu cycle=%d nodes=%lu\\n", id, cycle, count);
        for (DWORD i = 0; i < count; ++i) {
            fprintf(stderr, "  WCT node=%lu type=%d status=%d", i, (int)nodes[i].ObjectType, (int)nodes[i].ObjectStatus);
            if (nodes[i].ObjectType == WctThreadType)
                fprintf(stderr, " pid=%lu tid=%lu waitMs=%lu", nodes[i].ThreadObject.ProcessId, nodes[i].ThreadObject.ThreadId, nodes[i].ThreadObject.WaitTime);
            fputc('\\n', stderr);
        }
    } else fprintf(stderr, "WCT thread=%lu error=%lu\\n", id, GetLastError());
    CloseThreadWaitChainSession(session); fflush(stderr);
}
static BOOL CALLBACK diagnosticWindow(HWND window, LPARAM unused) {
    (void)unused; DWORD pid = 0; DWORD owner = GetWindowThreadProcessId(window, &pid);
    if (pid == GetCurrentProcessId()) {
        wchar_t kind[128] = {}; GetClassNameW(window, kind, 128);
        fwprintf(stderr, L"WINDOW hwnd=%p ownerTid=%lu class=%ls\\n", window, owner, kind);
    }
    return TRUE;
}`);
  replace('    // CI-only diagnostics for a headless engine stuck in native startup.', `    diagnosticWaitChain(id);
    EnumThreadWindows(id, diagnosticWindow, 0);
    // CI-only diagnostics for a headless engine stuck in native startup.`);
  replace('    setEnvironment(L"SAL_LOK_OPTIONS", L"unipoll");', `    wchar_t mode[32] = {};
    GetEnvironmentVariableW(L"MEMMY_PPTX_THREAD_MODEL", mode, 32);
    if (wcscmp(mode, L"baseline")) setEnvironment(L"SAL_LOK_OPTIONS", L"unipoll");
    fprintf(stderr, "INITIALIZE thread=%lu mode=%ls\\n", GetCurrentThreadId(), mode); fflush(stderr);`);
  replace('    conversionJob = {kit, source, input, outdir, format};', `    if (!wcscmp(mode, L"baseline")) return convertDocument(kit, source, input, outdir, format);
    conversionJob = {kit, source, input, outdir, format};`);
  replace('    trace("loading document");', `    fprintf(stderr, "LOADSAVE thread=%lu\\n", GetCurrentThreadId()); fflush(stderr);
    trace("loading document");`);
  const probe = join(evidence, "thread-probe.cpp");
  await writeFile(probe, source);
  let builder = await readFile(join(repo, "plugins/office/scripts/build-windows-converter.mjs"), "utf8");
  builder = builder.replace('const source = fileURLToPath(new URL("../native/windows-convert.cpp", import.meta.url));', `const source = ${JSON.stringify(probe)};`)
    .replace('const manifest = fileURLToPath(new URL("../native/windows-convert.manifest", import.meta.url));', `const manifest = ${JSON.stringify(join(repo, "plugins/office/native/windows-convert.manifest"))};`);
  const buildFile = join(evidence, "build-thread-probe.mjs");
  await writeFile(buildFile, builder);
  if (sourceOnly) return { probe, buildFile };
  const { buildWindowsConverter } = await import(pathToFileURL(buildFile).href);
  await buildWindowsConverter(program);
}
