/* Headless LibreOfficeKit converter. Keeps the desktop single-instance pipe
 * out of AppContainer; conversion still runs with the plugin's restricted token.
 * Uses the stable public LibreOfficeKit C ABI, loaded from the verified runtime. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <exception>
#include <atomic>
#include <dbghelp.h>
#include <tlhelp32.h>
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "dbghelp.lib")

static std::atomic<const char *> stage{"startup"};
static LONG exceptionCount = 0;
static LONG CALLBACK diagnosticException(EXCEPTION_POINTERS *exception) {
    if (exception->ExceptionRecord->ExceptionCode != 0xe06d7363 || InterlockedIncrement(&exceptionCount) > 128) return EXCEPTION_CONTINUE_SEARCH;
    // MSVC x64/ARM64 exception metadata uses image-relative type descriptors.
    // Diagnostics only: never consume or alter the engine's exception handling.
    __try {
        const ULONG_PTR *args = exception->ExceptionRecord->ExceptionInformation;
        if (exception->ExceptionRecord->NumberParameters >= 4 && args[2] && args[3]) {
            const unsigned char *image = (const unsigned char *)args[3];
            const DWORD *info = (const DWORD *)args[2];
            const DWORD *types = (const DWORD *)(image + info[3]);
            if (types[0] && types[0] < 128) {
                const DWORD *type = (const DWORD *)(image + types[1]);
                const char *name = (const char *)(image + type[1] + 2 * sizeof(void *));
                fprintf(stderr, "LibreOfficeKit C++ exception at %s: %.500s", stage.load(), name);
                if (strstr(name, "@sun@com@@") && args[1]) {
                    // UNO exception classes are non-polymorphic: Message is
                    // the first member, with no preceding vtable pointer.
                    const unsigned char *text = *(const unsigned char **)args[1];
                    int length = *(const int *)(text + 4);
                    if (length > 0 && length < 1000) {
                        char message[4096];
                        int bytes = WideCharToMultiByte(CP_UTF8, 0, (const wchar_t *)(text + 8), length, message, 4095, NULL, NULL);
                        if (bytes > 0) { message[bytes] = 0; fprintf(stderr, ": %s", message); }
                    }
                }
                fputc('\n', stderr); fflush(stderr);
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { /* Some native exceptions have different metadata. */ }
    return EXCEPTION_CONTINUE_SEARCH;
}
static void trace(const char *value) {
    wchar_t enabled[2]; stage = value;
    if (GetEnvironmentVariableW(L"MEMMY_OFFICE_TRACE", enabled, 2) == 1 && enabled[0] == L'1') { fprintf(stderr, "LibreOfficeKit: %s\n", value); fflush(stderr); }
}
static void invalidParameter(const wchar_t *expression, const wchar_t *function, const wchar_t *file, unsigned line, uintptr_t reserved) {
    (void)reserved;
    fwprintf(stderr, L"LibreOfficeKit CRT parameter failure at %hs: %ls %ls %ls:%u\n", stage.load(),
        function ? function : L"?", expression ? expression : L"?", file ? file : L"?", line);
    fflush(stderr); TerminateProcess(GetCurrentProcess(), 2);
}

static void printDialogText(HWND window) {
    wchar_t text[2048] = {}; DWORD_PTR length = 0;
    if (!SendMessageTimeoutW(window, WM_GETTEXT, 2048, (LPARAM)text, SMTO_ABORTIFHUNG | SMTO_BLOCK, 200, &length) || !length) return;
    char message[8192];
    int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, message, sizeof(message), NULL, NULL);
    if (size > 0) fprintf(stderr, "LibreOfficeKit dialog: %s\n", message);
}
static BOOL CALLBACK printDialogChild(HWND window, LPARAM count) {
    if (++*(int *)count > 16) return FALSE;
    printDialogText(window); return TRUE;
}
static BOOL CALLBACK diagnoseDialog(HWND window, LPARAM unused) {
    (void)unused; DWORD owner = 0; wchar_t kind[64] = {};
    GetWindowThreadProcessId(window, &owner);
    if (owner != GetCurrentProcessId()) return TRUE;
    GetClassNameW(window, kind, 64);
    if (wcscmp(kind, L"#32770")) return TRUE;
    // Only inspect this headless worker's own error dialog. Never acknowledge
    // it or enumerate content belonging to the user's applications.
    printDialogText(window); int count = 0;
    EnumChildWindows(window, printDialogChild, (LPARAM)&count);
    fflush(stderr); TerminateProcess(GetCurrentProcess(), 2);
    return FALSE;
}

static void dumpThread(HANDLE thread, DWORD id) {
    // CI-only diagnostics for a headless engine stuck in native startup. Resume
    // immediately after copying context so symbol lookup never holds its locks.
    CONTEXT context = {}; context.ContextFlags = CONTEXT_FULL;
    if (SuspendThread(thread) == (DWORD)-1) return;
    BOOL captured = GetThreadContext(thread, &context);
    ResumeThread(thread);
    if (!captured) return;
    fprintf(stderr, "LibreOfficeKit thread %lu stack at %s:\n", id, stage.load());
    STACKFRAME64 frame = {};
#if defined(_M_ARM64)
    DWORD machine = IMAGE_FILE_MACHINE_ARM64;
    frame.AddrPC.Offset = context.Pc; frame.AddrStack.Offset = context.Sp; frame.AddrFrame.Offset = context.Fp;
#else
    DWORD machine = IMAGE_FILE_MACHINE_AMD64;
    frame.AddrPC.Offset = context.Rip; frame.AddrStack.Offset = context.Rsp; frame.AddrFrame.Offset = context.Rbp;
#endif
    frame.AddrPC.Mode = frame.AddrStack.Mode = frame.AddrFrame.Mode = AddrModeFlat;
    HANDLE process = GetCurrentProcess();
    for (int i = 0; i < 40 && frame.AddrPC.Offset; ++i) {
        char storage[sizeof(SYMBOL_INFO) + MAX_SYM_NAME] = {};
        SYMBOL_INFO *symbol = (SYMBOL_INFO *)storage;
        symbol->SizeOfStruct = sizeof(SYMBOL_INFO); symbol->MaxNameLen = MAX_SYM_NAME;
        DWORD64 displacement = 0;
        if (SymFromAddr(process, frame.AddrPC.Offset, &displacement, symbol))
            fprintf(stderr, "  %s+0x%llx\n", symbol->Name, displacement);
        else fprintf(stderr, "  0x%llx\n", frame.AddrPC.Offset);
        if (!StackWalk64(machine, process, thread, &frame, &context, NULL, SymFunctionTableAccess64, SymGetModuleBase64, NULL)) break;
    }
    fflush(stderr);
}
static DWORD WINAPI diagnoseStartup(void *thread) {
    Sleep(15000);
    EnumWindows(diagnoseDialog, 0);
    SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_FAIL_CRITICAL_ERRORS | SYMOPT_NO_PROMPTS);
    SymInitialize(GetCurrentProcess(), "", TRUE); // No symbol servers or external services.
    DWORD main = GetThreadId((HANDLE)thread), own = GetCurrentThreadId();
    EnumThreadWindows(main, diagnoseDialog, 0);
    dumpThread((HANDLE)thread, main); CloseHandle((HANDLE)thread);
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snapshot != INVALID_HANDLE_VALUE) {
        THREADENTRY32 entry = {}; entry.dwSize = sizeof(entry);
        int count = 0;
        if (Thread32First(snapshot, &entry)) do {
            if (entry.th32OwnerProcessID != GetCurrentProcessId() || entry.th32ThreadID == own || entry.th32ThreadID == main) continue;
            EnumThreadWindows(entry.th32ThreadID, diagnoseDialog, 0);
            HANDLE worker = OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID);
            if (worker) { dumpThread(worker, entry.th32ThreadID); CloseHandle(worker); }
            if (++count >= 16) break;
        } while (Thread32Next(snapshot, &entry));
        CloseHandle(snapshot);
    }
    SymCleanup(GetCurrentProcess());
    return 0;
}

typedef struct Kit Kit;
typedef struct Document Document;
typedef struct {
    size_t size;
    void (*destroy)(Kit *);
    Document *(*load)(Kit *, const char *);
    char *(*error)(Kit *);
    Document *(*loadOptions)(Kit *, const char *, const char *);
    void (*freeError)(char *);
    // Public LibreOfficeKit C ABI, through runLoop (verified with LO 26.2.6).
    void (*registerCallback)(Kit *, void (*)(int, const char *, void *), void *);
    char *(*getFilterTypes)(Kit *);
    void (*setOptionalFeatures)(Kit *, unsigned long long);
    void (*setDocumentPassword)(Kit *, const char *, const char *);
    char *(*getVersionInfo)(Kit *);
    int (*runMacro)(Kit *, const char *);
    bool (*signDocument)(Kit *, const char *, const unsigned char *, int, const unsigned char *, int);
    void (*runLoop)(Kit *, int (*)(void *, long long), void (*)(void *), void *);
} KitMethods;
typedef struct {
    size_t size;
    void (*destroy)(Document *);
    int (*save)(Document *, const char *, const char *, const char *);
} DocumentMethods;
struct Kit { KitMethods *methods; };
struct Document { DocumentMethods *methods; };
typedef Kit *(__cdecl *Initialize)(const char *, const char *);

static char *utf8(const wchar_t *value) {
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, NULL, 0, NULL, NULL);
    char *result = (char *)calloc((size_t)size, 1);
    if (!size || !result || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result, size, NULL, NULL)) return NULL;
    return result;
}
static void setEnvironment(const wchar_t *name, const wchar_t *value) {
    // SetEnvironmentVariable does not update an already initialized CRT's
    // getenv snapshot. Our /MT wrapper and LibreOffice's shared UCRT each own
    // a copy; configure both before engine initialization.
    if (_wputenv_s(name, value) != 0) TerminateProcess(GetCurrentProcess(), 2);
    HMODULE crt = GetModuleHandleW(L"ucrtbase.dll");
    if (crt) {
        typedef int (__cdecl *PutEnvironment)(const wchar_t *, const wchar_t *);
        PutEnvironment put = (PutEnvironment)(void *)GetProcAddress(crt, "_wputenv_s");
        if (!put || put(name, value) != 0) {
            fwprintf(stderr, L"Cannot configure LibreOffice runtime environment: %ls\n", name);
            fflush(stderr); TerminateProcess(GetCurrentProcess(), 2);
        }
    }
}
static char *fileUrl(const wchar_t *value) {
    char *bytes = utf8(value), *result, *out;
    const unsigned char *p;
    const char hex[] = "0123456789ABCDEF";
    if (!bytes) return NULL;
    result = (char *)calloc(strlen(bytes) * 3 + 16, 1);
    if (!result) { free(bytes); return NULL; }
    strcpy_s(result, strlen(bytes) * 3 + 16, "file:///"); out = result + 8;
    for (p = (unsigned char *)bytes; *p; ++p) {
        if (*p == '\\') *out++ = '/';
        else if ((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || strchr("-._~/:", *p)) *out++ = (char)*p;
        else { *out++ = '%'; *out++ = hex[*p >> 4]; *out++ = hex[*p & 15]; }
    }
    free(bytes); return result;
}
static int error(Kit *kit, const char *stage) {
    char *message = kit && kit->methods->error ? kit->methods->error(kit) : NULL;
    fprintf(stderr, "LibreOfficeKit %s failed: %s (Windows %lu)\n", stage, message ? message : "no engine diagnostic", GetLastError());
    if (message && kit->methods->size >= offsetof(KitMethods, freeError) + sizeof(kit->methods->freeError)) kit->methods->freeError(message);
    return 1;
}

static int convertDocument(Kit *kit, char *source, const wchar_t *input, const wchar_t *outdir, const wchar_t *format) {
    Document *document; const wchar_t *base, *dot; const char *extension;
    wchar_t output[32768]; char *target; int saved;
    trace("loading document");
    // The profile disables macros and external-link refresh before loading.
    document = kit->methods->loadOptions(kit, source, "Batch=true,EnableMacrosExecution=false,MacroSecurityLevel=3");
    free(source);
    if (!document) return error(kit, "document load");
    base = wcsrchr(input, L'\\'); if (!base) base = wcsrchr(input, L'/'); base = base ? base + 1 : input;
    dot = wcsrchr(base, L'.'); if (!dot) dot = base + wcslen(base);
    extension = !wcscmp(format, L"pdf") ? "pdf" : "xlsx";
    swprintf_s(output, 32768, L"%ls\\%.*ls.%ls", outdir, (int)(dot - base), base, !strcmp(extension, "pdf") ? L"pdf" : L"xlsx");
    target = fileUrl(output); if (!target) return 2;
    trace("saving document");
    saved = document->methods->save(document, target, extension, NULL);
    free(target);
    if (!saved) return error(kit, "save");
    trace("closing document");
    document->methods->destroy(document);
    kit->methods->destroy(kit);
    return 0;
}
struct ConversionJob { Kit *kit; char *source; const wchar_t *input, *outdir, *format; };
static ConversionJob conversionJob;
static void CALLBACK convertOnEventThread(HWND, UINT, UINT_PTR timer, DWORD) {
    KillTimer(NULL, timer);
    int code = 2;
    try {
        code = convertDocument(conversionJob.kit, conversionJob.source,
            conversionJob.input, conversionJob.outdir, conversionJob.format);
    }
    catch (const std::exception &failure) { fprintf(stderr, "LibreOfficeKit exception at %s: %s\n", stage.load(), failure.what()); }
    catch (...) { fprintf(stderr, "LibreOfficeKit native exception at %s\n", stage.load()); }
    // save() and document/Kit disposal finish before success. This one-document
    // worker must not return into soffice_main after destroying its Kit, nor
    // enter Windows DLL-detach cleanup while its event loop is still active.
    fflush(NULL); TerminateProcess(GetCurrentProcess(), code);
}

static int convert(int argc, wchar_t **argv) {
    wchar_t directory[32768], library[32768], working[32768], local[32768], roaming[32768];
    const wchar_t *profile = NULL, *input = NULL, *outdir = NULL, *format = NULL, *base;
    HMODULE module; Initialize initialize; Kit *kit;
    char *install, *user, *source;
    int i;
    for (i = 1; i < argc; ++i) {
        if (!wcsncmp(argv[i], L"-env:UserInstallation=", 22)) profile = argv[i] + 22;
        else if (!wcscmp(argv[i], L"--convert-to") && i + 1 < argc) format = argv[++i];
        else if (!wcscmp(argv[i], L"--outdir") && i + 1 < argc) outdir = argv[++i];
        else if (argv[i][0] != L'-') input = argv[i];
    }
    if (!profile || !input || !outdir || !format || (wcscmp(format, L"pdf") && wcscmp(format, L"xlsx:Calc MS Excel 2007 XML"))) {
        fprintf(stderr, "Expected an isolated profile, input, output directory and PDF/XLSX conversion\n"); return 2;
    }
    if (!GetModuleFileNameW(NULL, directory, 32768)) return error(NULL, "module path");
    base = wcsrchr(directory, L'\\'); if (!base) return 2;
    directory[base - directory] = 0;
    if (!GetCurrentDirectoryW(32768, working)) return error(NULL, "working directory");
    swprintf_s(local, 32768, L"%ls\\local", working);
    swprintf_s(roaming, 32768, L"%ls\\roaming", working);
    if (!CreateDirectoryW(local, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return error(NULL, "local profile directory");
    if (!CreateDirectoryW(roaming, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return error(NULL, "roaming profile directory");
    // Windows libraries expect these variables even with UserInstallation set.
    // Initialize them before loading the engine/its CRT, using only task storage.
    setEnvironment(L"USERPROFILE", working);
    setEnvironment(L"LOCALAPPDATA", local);
    setEnvironment(L"APPDATA", roaming);
    // These bootstrap overrides precede Windows Known Folder lookups. The
    // container must not depend on access to the user's Documents/AppData.
    setEnvironment(L"SYSUSERHOME", profile);
    setEnvironment(L"SYSUSERCONFIG", profile);
    if (working[1] == L':') {
        wchar_t drive[3] = { working[0], L':', 0 };
        setEnvironment(L"HOMEDRIVE", drive);
        setEnvironment(L"HOMEPATH", working + 2);
    }
    // The Windows VCL backend uses Skia even in headless mode. Select CPU
    // rasterization before loading its CRT/engine, avoiding GPU enumeration
    // and graphics-driver initialization inside the restricted container.
    setEnvironment(L"SAL_SKIA", L"raster");
    setEnvironment(L"SAL_USE_VCLPLUGIN", L"svp");
    setEnvironment(L"SAL_DISABLE_OPENCL", L"1");
    // Windows views send synchronous window messages. Loading from a caller
    // thread while the VCL event thread owns the frames can block in SetWindowPos
    // under SolarMutex. Complete startup and conversion on the same event thread.
    setEnvironment(L"SAL_LOK_OPTIONS", L"unipoll");
    trace("checking private desktop");
    WNDCLASSW probe = {};
    probe.lpfnWndProc = DefWindowProcW; probe.hInstance = GetModuleHandleW(NULL); probe.lpszClassName = L"MemmyOfficeHeadlessProbe";
    if (!RegisterClassW(&probe)) return error(NULL, "desktop window class");
    HWND window = CreateWindowExW(0, probe.lpszClassName, L"", WS_POPUP, 0, 0, 0, 0, NULL, NULL, probe.hInstance, NULL);
    if (!window) return error(NULL, "private desktop window");
    DestroyWindow(window); UnregisterClassW(probe.lpszClassName, probe.hInstance);
    trace("private desktop ready");
    trace("loading engine");
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    if (!AddDllDirectory(directory)) return error(NULL, "DLL directory");
    HMODULE crt = LoadLibraryExW(L"ucrtbase.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (crt) {
        typedef _invalid_parameter_handler (__cdecl *SetHandler)(_invalid_parameter_handler);
        SetHandler handler = (SetHandler)(void *)GetProcAddress(crt, "_set_invalid_parameter_handler");
        if (handler) handler(invalidParameter);
    }
    swprintf_s(library, 32768, L"%ls\\mergedlo.dll", directory);
    module = LoadLibraryExW(library, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    if (!module) {
        swprintf_s(library, 32768, L"%ls\\sofficeapp.dll", directory);
        module = LoadLibraryExW(library, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    }
    if (!module) return error(NULL, "library load");
    trace("engine loaded");
    initialize = (Initialize)(void *)GetProcAddress(module, "libreofficekit_hook_2");
    if (!initialize) return error(NULL, "entrypoint");
    install = utf8(directory); user = utf8(profile); source = fileUrl(input);
    if (!install || !user || !source) return 2;
    trace("initializing engine");
    kit = initialize(install, user);
    free(install); free(user);
    if (!kit) { free(source); return error(NULL, "initialization"); }
    if (kit->methods->size < offsetof(KitMethods, runLoop) + sizeof(kit->methods->runLoop) || !kit->methods->runLoop)
        return error(kit, "runLoop ABI");
    conversionJob = {kit, source, input, outdir, format};
    if (!SetTimer(NULL, 0, 500, convertOnEventThread)) return error(kit, "conversion timer");
    trace("entering event loop");
    kit->methods->runLoop(kit, NULL, NULL, NULL);
    return error(NULL, "event loop returned before conversion");
}

int wmain(int argc, wchar_t **argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    _set_invalid_parameter_handler(invalidParameter);
    if (GetEnvironmentVariableW(L"MEMMY_OFFICE_TRACE", NULL, 0)) {
        setEnvironment(L"SAL_LOG", L"+WARN");
        AddVectoredExceptionHandler(1, diagnosticException);
        HANDLE current = NULL;
        if (DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &current, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            HANDLE monitor = CreateThread(NULL, 0, diagnoseStartup, current, 0, NULL);
            if (monitor) CloseHandle(monitor); else CloseHandle(current);
        }
    }
    try { return convert(argc, argv); }
    catch (const std::exception &failure) { fprintf(stderr, "LibreOfficeKit exception at %s: %s\n", stage.load(), failure.what()); }
    catch (...) { fprintf(stderr, "LibreOfficeKit native exception at %s\n", stage.load()); }
    // Engine initialization may leave a worker holding a DLL lock. A failed
    // short-lived conversion must not hang in CRT/DLL process-detach cleanup.
    fflush(stderr); TerminateProcess(GetCurrentProcess(), 1);
    return 1;
}
