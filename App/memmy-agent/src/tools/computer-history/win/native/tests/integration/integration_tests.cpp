// Integration tests: drive the real recorder executables against the in-repo Win32 fixture.
//
// Every case runs as its own CTest entry (--case NAME). Cases that need the fixture in the
// Windows foreground activate it explicitly and verify GetForegroundWindow(); if the desktop
// is locked or foreground cannot be obtained they exit 77 (CTest SKIP), never pass. Policies
// only ever authorize the fixture's exact PID + executable (+ HWND where relevant), so no other
// application's content can be captured. Evidence (policies, stdout/stderr, JSONL files) is
// written under --artifacts/<case>/<timestamp-pid>/.

#include "common/cli.h"
#include "common/json.h"
#include "common/protocol.h"
#include "common/text.h"

#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <tlhelp32.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
using memmy::Json;
using Microsoft::WRL::ComPtr;

namespace {

struct TestFailure {
  std::string message;
};
struct TestSkip {
  std::string message;
};

[[noreturn]] void Fail(const std::string& message) { throw TestFailure{message}; }
[[noreturn]] void Skip(const std::string& message) { throw TestSkip{message}; }
void Expect(bool condition, const std::string& message) {
  if (!condition) Fail(message);
}
void Log(const std::string& message) { std::printf("  %s\n", message.c_str()); std::fflush(stdout); }

std::string U8(const std::wstring& value) { return memmy::text::ToUtf8(value); }
std::wstring W(const std::string& value) { return memmy::text::FromUtf8(value).value_or(L""); }

struct Paths {
  fs::path bin;
  fs::path artifacts;  // per case, per run
  fs::path Recorder() const { return bin / L"memmy-history-recorder.exe"; }
  fs::path TestHooks() const { return bin / L"memmy-history-recorder-testhooks.exe"; }
  fs::path Fixture() const { return bin / L"memmy-history-fixture.exe"; }
} g_paths;

HANDLE g_job = nullptr;  // kill-on-close: nothing the harness starts can outlive it

std::string Nonce() {
  LARGE_INTEGER counter{};
  QueryPerformanceCounter(&counter);
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "n%08llx", static_cast<unsigned long long>(counter.QuadPart & 0xFFFFFFFFull));
  return buffer;
}

void WriteFileBytes(const fs::path& path, const std::string& bytes) {
  fs::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  if (!out) Fail("could not write " + U8(path.wstring()));
}

std::string ReadFileBytes(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

std::vector<std::string> SplitLines(const std::string& bytes) {
  std::vector<std::string> lines;
  std::size_t start = 0;
  while (start < bytes.size()) {
    const auto end = bytes.find('\n', start);
    if (end == std::string::npos) {
      lines.push_back(bytes.substr(start));
      break;
    }
    lines.push_back(bytes.substr(start, end - start));
    start = end + 1;
  }
  return lines;
}

// ------------------------------------------------------------------------------- processes

class Process {
 public:
  struct Options {
    bool newProcessGroup = false;
    bool shareConsole = false;
  };

  ~Process() {
    Kill();
    CloseStdin();
    StopReaders();
  }

  void Start(const fs::path& exe, const std::vector<std::wstring>& args, Options options = {}) {
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE inRead, inWrite, outRead, outWrite, errRead, errWrite;
    if (!CreatePipe(&inRead, &inWrite, &sa, 0) || !CreatePipe(&outRead, &outWrite, &sa, 0) ||
        !CreatePipe(&errRead, &errWrite, &sa, 0)) {
      Fail("CreatePipe failed");
    }
    SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<unsigned char> buffer(size);
    auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buffer.data());
    InitializeProcThreadAttributeList(list, 1, 0, &size);
    HANDLE handles[3] = {inRead, outWrite, errWrite};
    UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr);
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inRead;
    startup.StartupInfo.hStdOutput = outWrite;
    startup.StartupInfo.hStdError = errWrite;
    startup.lpAttributeList = list;
    std::wstring commandLine = memmy::cli::QuoteArgument(exe.wstring());
    for (const auto& arg : args) commandLine += L" " + memmy::cli::QuoteArgument(arg);
    DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    if (!options.shareConsole) flags |= CREATE_NO_WINDOW;
    if (options.newProcessGroup) flags |= CREATE_NEW_PROCESS_GROUP;
    PROCESS_INFORMATION info{};
    const BOOL ok = CreateProcessW(exe.wstring().c_str(), commandLine.data(), nullptr, nullptr, TRUE, flags, nullptr,
                                   nullptr, &startup.StartupInfo, &info);
    DeleteProcThreadAttributeList(list);
    CloseHandle(inRead);
    CloseHandle(outWrite);
    CloseHandle(errWrite);
    if (!ok) Fail("CreateProcess failed for " + U8(exe.wstring()) + " error " + std::to_string(GetLastError()));
    AssignProcessToJobObject(g_job, info.hProcess);
    ResumeThread(info.hThread);
    CloseHandle(info.hThread);
    process_ = info.hProcess;
    pid_ = info.dwProcessId;
    stdin_ = inWrite;
    stdout_ = outRead;
    stderr_ = errRead;
    state_ = std::make_shared<State>();
    outReader_ = std::thread([state = state_, pipe = stdout_] { ReadLines(state, pipe, false); });
    errReader_ = std::thread([state = state_, pipe = stderr_] { ReadLines(state, pipe, true); });
  }

  DWORD Pid() const { return pid_; }
  HANDLE Handle() const { return process_; }

  bool WriteLine(const std::string& line) {
    if (!stdin_) return false;
    const std::string bytes = line + "\n";
    DWORD written = 0;
    return WriteFile(stdin_, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
  }

  void CloseStdin() {
    if (stdin_) CloseHandle(stdin_);
    stdin_ = nullptr;
  }

  // Simulates a consumer that stopped reading: our end of the child's stdout disappears.
  void CloseStdoutReader() {
    if (outReader_.joinable()) {
      CancelSynchronousIo(static_cast<HANDLE>(outReader_.native_handle()));
      if (stdout_) CloseHandle(stdout_);
      stdout_ = nullptr;
      outReader_.join();
    }
  }

  std::optional<DWORD> WaitExit(DWORD timeoutMs) {
    if (WaitForSingleObject(process_, timeoutMs) != WAIT_OBJECT_0) return std::nullopt;
    DWORD code = 0;
    GetExitCodeProcess(process_, &code);
    // Let readers collect the remaining output.
    if (outReader_.joinable()) outReader_.join();
    if (errReader_.joinable()) errReader_.join();
    return code;
  }

  void Kill() {
    if (process_ && WaitForSingleObject(process_, 0) != WAIT_OBJECT_0) {
      TerminateProcess(process_, 0xBAD);
      WaitForSingleObject(process_, 5000);
    }
  }

  std::vector<std::string> Lines() const {
    std::lock_guard lock(state_->mutex);
    return state_->lines;
  }
  std::string Stderr() const {
    std::lock_guard lock(state_->mutex);
    return state_->err;
  }
  std::string StdoutBytes() const {
    std::lock_guard lock(state_->mutex);
    return state_->raw;
  }

  // Waits for the next stdout line (from cursor) satisfying predicate; advances cursor past it.
  std::optional<std::string> WaitLine(std::size_t& cursor, const std::function<bool(const std::string&)>& predicate,
                                      DWORD timeoutMs) {
    std::unique_lock lock(state_->mutex);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
      while (cursor < state_->lines.size()) {
        const std::string& line = state_->lines[cursor++];
        if (predicate(line)) return line;
      }
      if (state_->closed) return std::nullopt;
      if (state_->cv.wait_until(lock, deadline) == std::cv_status::timeout && cursor >= state_->lines.size()) {
        return std::nullopt;
      }
    }
  }

  void Save(const std::string& name) const {
    WriteFileBytes(g_paths.artifacts / (name + ".stdout.jsonl"), StdoutBytes());
    WriteFileBytes(g_paths.artifacts / (name + ".stderr.txt"), Stderr());
  }

 private:
  struct State {
    std::mutex mutex;
    std::condition_variable cv;
    std::vector<std::string> lines;
    std::string raw;
    std::string pending;
    std::string err;
    bool closed = false;
  };

  static void ReadLines(std::shared_ptr<State> state, HANDLE pipe, bool isErr) {
    char buffer[8192];
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) || read == 0) break;
      std::lock_guard lock(state->mutex);
      if (isErr) {
        state->err.append(buffer, read);
        continue;
      }
      state->raw.append(buffer, read);
      state->pending.append(buffer, read);
      std::size_t newline;
      while ((newline = state->pending.find('\n')) != std::string::npos) {
        state->lines.push_back(state->pending.substr(0, newline));
        state->pending.erase(0, newline + 1);
      }
      state->cv.notify_all();
    }
    std::lock_guard lock(state->mutex);
    if (!isErr) {
      if (!state->pending.empty()) state->lines.push_back(state->pending);
      state->closed = true;
    }
    state->cv.notify_all();
  }

  void StopReaders() {
    for (std::thread* thread : {&outReader_, &errReader_}) {
      if (!thread->joinable()) continue;
      CancelSynchronousIo(static_cast<HANDLE>(thread->native_handle()));
      thread->join();
    }
    if (stdout_) CloseHandle(stdout_);
    if (stderr_) CloseHandle(stderr_);
    if (process_) CloseHandle(process_);
    stdout_ = stderr_ = process_ = nullptr;
  }

  HANDLE process_ = nullptr;
  HANDLE stdin_ = nullptr;
  HANDLE stdout_ = nullptr;
  HANDLE stderr_ = nullptr;
  DWORD pid_ = 0;
  std::shared_ptr<State> state_ = std::make_shared<State>();
  std::thread outReader_;
  std::thread errReader_;
};

struct RunResult {
  DWORD exitCode = 0;
  std::vector<std::string> lines;
  std::string err;
};

RunResult RunToEnd(const fs::path& exe, const std::vector<std::wstring>& args, const std::string& name,
                   const std::string& stdinText = "", DWORD timeoutMs = 30000) {
  Process process;
  process.Start(exe, args);
  if (!stdinText.empty()) process.WriteLine(stdinText);
  process.CloseStdin();
  const auto code = process.WaitExit(timeoutMs);
  process.Save(name);
  if (!code) Fail(name + ": process did not exit within " + std::to_string(timeoutMs) + " ms");
  return {*code, process.Lines(), process.Stderr()};
}

Json ParseLine(const std::string& line) {
  auto json = memmy::ParseJsonStrict(line, 64);
  if (!json) Fail("stdout line is not strict JSON: " + line.substr(0, 200));
  return *json;
}

std::optional<DWORD> ParentOf(DWORD pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W entry{sizeof(entry)};
  std::optional<DWORD> parent;
  for (BOOL ok = Process32FirstW(snapshot, &entry); ok; ok = Process32NextW(snapshot, &entry)) {
    if (entry.th32ProcessID == pid) parent = entry.th32ParentProcessID;
  }
  CloseHandle(snapshot);
  return parent;
}

std::vector<DWORD> ChildrenOf(DWORD parentPid, const std::wstring& exeName) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W entry{sizeof(entry)};
  std::vector<DWORD> children;
  for (BOOL ok = Process32FirstW(snapshot, &entry); ok; ok = Process32NextW(snapshot, &entry)) {
    if (entry.th32ParentProcessID == parentPid && _wcsicmp(entry.szExeFile, exeName.c_str()) == 0) {
      children.push_back(entry.th32ProcessID);
    }
  }
  CloseHandle(snapshot);
  return children;
}

// ------------------------------------------------------------------------------- fixture

class Fixture {
 public:
  explicit Fixture(fs::path exe = g_paths.Fixture()) : exe_(std::move(exe)) {}

  void Start() {
    nonce_ = Nonce();
    process_.Start(exe_, {L"--nonce", W(nonce_)});
    info_ = Command("info");
    if (!info_.value("ok", false)) Fail("fixture info failed");
  }

  Json Command(const std::string& line, DWORD timeoutMs = 10000) {
    if (!process_.WriteLine(line)) Fail("fixture command write failed: " + line);
    const auto reply = process_.WaitLine(cursor_, [](const std::string&) { return true; }, timeoutMs);
    if (!reply) Fail("fixture did not answer: " + line);
    return ParseLine(*reply);
  }

  std::string S(const char* kind) const { return std::string("FIXTURE-") + kind + "-" + nonce_; }
  std::uint32_t Pid() const { return info_["pid"].get<std::uint32_t>(); }
  std::string Exe() const { return info_["exe"].get<std::string>(); }
  std::string ProcessStart() const { return info_["processStart"].get<std::string>(); }
  std::string HwndA() const { return info_["hwndA"].get<std::string>(); }
  std::string HwndB() const { return info_["hwndB"].get<std::string>(); }
  HWND Hwnd(char which) const {
    return reinterpret_cast<HWND>(static_cast<std::uintptr_t>(std::stoull(which == 'b' ? HwndB() : HwndA())));
  }
  Process& Proc() { return process_; }

  bool TryActivate(char which) {
    for (int attempt = 0; attempt < 3; ++attempt) {
      Command(std::string("activate ") + which);
      if (GetForegroundWindow() == Hwnd(which)) return true;
      Sleep(200);
    }
    return false;
  }

  // Foreground is a precondition; without it the case is skipped, not passed.
  void RequireForeground(char which) {
    if (!TryActivate(which)) {
      Skip("interactive foreground unavailable: fixture window could not be made foreground (foreground=" +
           std::to_string(reinterpret_cast<std::uintptr_t>(GetForegroundWindow())) + ")");
    }
  }

  void ExpectForeground(char which, const std::string& when) {
    if (GetForegroundWindow() != Hwnd(which)) {
      Fail("foreground left the fixture " + when + " (condition invalid; external activity?)");
    }
  }

 private:
  fs::path exe_;
  Process process_;
  std::size_t cursor_ = 0;
  Json info_;
  std::string nonce_;
};

// Sentinels that must never appear in recorder output for the fixture.
std::vector<std::string> ForbiddenKinds() { return {"EDIT", "EDITCHILD", "PASSWORD", "PWCHILD", "SENSITIVE", "MISREPORTEDPASSWORD", "MISREPORTEDCHILD"}; }

void ExpectNoLeak(const std::string& output, const Fixture& fixture, std::vector<std::string> kinds,
                  const std::string& where) {
  for (const auto& kind : kinds) {
    if (output.find(fixture.S(kind.c_str())) != std::string::npos) {
      Fail("privacy leak in " + where + ": " + kind + " sentinel present");
    }
  }
}

std::string Join(const std::vector<std::string>& lines) {
  std::string out;
  for (const auto& line : lines) out += line + "\n";
  return out;
}

// The leak checks are meaningful only if the forbidden child text is reachable through UIA.
void VerifyFixtureExposesChildren(Fixture& fixture) {
  ComPtr<IUIAutomation> automation;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)))) {
    Fail("UIA unavailable in harness");
  }
  ComPtr<IUIAutomationTreeWalker> walker;
  automation->get_ControlViewWalker(&walker);
  const std::pair<int, const char*> checks[] = {{1004, "EDITCHILD"}, {1005, "PWCHILD"}, {1007, "SENSITIVE"}, {1009, "MISREPORTEDCHILD"}};
  for (const auto& [id, kind] : checks) {
    HWND control = GetDlgItem(fixture.Hwnd('a'), id);
    ComPtr<IUIAutomationElement> element, child;
    if (!control || FAILED(automation->ElementFromHandle(control, &element)) ||
        FAILED(walker->GetFirstChildElement(element.Get(), &child)) || !child) {
      Fail(std::string("fixture precondition: UIA child not reachable under control ") + std::to_string(id));
    }
    BSTR name = nullptr;
    child->get_CurrentName(&name);
    const std::string value = name ? U8(std::wstring(name, SysStringLen(name))) : "";
    SysFreeString(name);
    if (value != fixture.S(kind)) Fail(std::string("fixture precondition: unexpected UIA child text for ") + kind);
  }
  ComPtr<IUIAutomationElement> misreported;
  Expect(SUCCEEDED(automation->ElementFromHandle(GetDlgItem(fixture.Hwnd('a'), 1009), &misreported)), "misreported password provider");
  CONTROLTYPEID type = 0; BOOL password = TRUE; BSTR name = nullptr;
  misreported->get_CurrentControlType(&type); misreported->get_CurrentIsPassword(&password); misreported->get_CurrentName(&name);
  const std::string value = name ? U8(std::wstring(name, SysStringLen(name))) : "";
  SysFreeString(name);
  Expect(type == UIA_PaneControlTypeId && !password && value == fixture.S("MISREPORTEDPASSWORD"),
    "fixture must expose a non-password Pane containing the secret Name");
}

// ------------------------------------------------------------------------------- policies

Json AppRule(Fixture& fixture) {
  return {{"pid", fixture.Pid()}, {"executable", fixture.Exe()}};
}

Json FullRule(Fixture& fixture) {
  Json rule = AppRule(fixture);
  rule["searchFields"] = Json::array({{{"controlType", "Edit"}, {"automationId", "1003"}}});
  rule["documentRegions"] = Json::array({{{"controlType", "Document"}, {"automationId", "1006"}}});
  rule["sensitiveAutomationIds"] = Json::array({"1007"});
  return rule;
}

fs::path WritePolicy(const std::string& name, Json applications, Json extra = Json::object()) {
  Json policy = {{"version", 1}, {"applications", std::move(applications)}};
  for (auto& [key, value] : extra.items()) policy[key] = value;
  const fs::path path = g_paths.artifacts / (name + ".json");
  WriteFileBytes(path, memmy::DumpJson(policy));
  return path;
}

fs::path WriteRawPolicy(const std::string& name, const std::string& bytes) {
  const fs::path path = g_paths.artifacts / (name + ".json");
  WriteFileBytes(path, bytes);
  return path;
}

// ------------------------------------------------------------------------------- snapshot helpers

Json Snapshot(const fs::path& exe, const std::string& hwnd, const fs::path& policy, const std::string& name,
              std::vector<std::wstring> extra = {}, DWORD* exitCode = nullptr) {
  std::vector<std::wstring> args = {L"snapshot", L"--hwnd", W(hwnd), L"--policy", policy.wstring()};
  args.insert(args.end(), extra.begin(), extra.end());
  const RunResult result = RunToEnd(exe, args, name);
  if (result.lines.size() != 1) Fail(name + ": snapshot must print exactly one JSON line, got " + std::to_string(result.lines.size()));
  const Json event = ParseLine(result.lines[0]);
  const std::string status = event["snapshot"]["status"].get<std::string>();
  if ((status == "ok") != (result.exitCode == 0) || (status != "ok" && result.exitCode != 3)) {
    Fail(name + ": exit code " + std::to_string(result.exitCode) + " inconsistent with status " + status);
  }
  if (exitCode) *exitCode = result.exitCode;
  return event;
}

std::string Status(const Json& event) { return event["snapshot"]["status"].get<std::string>(); }
std::string Reason(const Json& event) {
  const auto& reason = event["snapshot"]["reason"];
  return reason.is_string() ? reason.get<std::string>() : "";
}

void ExpectBlocked(const Json& event, const std::string& reason, const std::string& what) {
  if (Status(event) == "ok" || Reason(event) != reason) {
    Fail(what + ": expected reason " + reason + ", got " + Status(event) + "/" + Reason(event));
  }
  if (event["snapshot"].contains("nodes") || event["snapshot"].contains("added")) Fail(what + ": refused snapshot carried nodes");
}

const Json* FindNode(const Json& event, const std::string& automationId) {
  const auto& nodes = event["snapshot"].contains("nodes") ? event["snapshot"]["nodes"] : event["snapshot"]["added"];
  for (const auto& node : nodes) {
    if (node["automationId"] == automationId) return &node;
  }
  return nullptr;
}

// ------------------------------------------------------------------------------- observe helpers

class Observe {
 public:
  Observe() = default;
  // Evidence is kept even when a case fails before Finish().
  ~Observe() {
    if (!saved_ && process_.Pid() != 0) {
      try {
        process_.Save("recorder-unfinished");
      } catch (...) {
      }
    }
  }
  void Start(const fs::path& exe, std::vector<std::wstring> args, Process::Options options = {}) {
    process_.Start(exe, args, options);
    started_ = Wait("session.started", 10000);
  }
  Json Wait(const std::string& kind, DWORD timeoutMs, const std::function<bool(const Json&)>& extra = nullptr) {
    const auto line = process_.WaitLine(
        cursor_,
        [&](const std::string& text) {
          const Json event = ParseLine(text);
          return event["kind"] == kind && (!extra || extra(event));
        },
        timeoutMs);
    if (!line) Fail("timed out waiting for " + kind + "; stderr: " + process_.Stderr().substr(0, 400));
    return ParseLine(*line);
  }
  std::optional<Json> TryWait(const std::string& kind, DWORD timeoutMs, const std::function<bool(const Json&)>& extra = nullptr) {
    const auto line = process_.WaitLine(
        cursor_,
        [&](const std::string& text) {
          const Json event = ParseLine(text);
          return event["kind"] == kind && (!extra || extra(event));
        },
        timeoutMs);
    if (!line) return std::nullopt;
    return ParseLine(*line);
  }
  void Send(const std::string& command) {
    if (!process_.WriteLine(command)) Fail("control write failed: " + command);
  }
  DWORD Finish(DWORD timeoutMs, const std::string& name) {
    const auto code = process_.WaitExit(timeoutMs);
    process_.Save(name);
    saved_ = true;
    if (!code) Fail(name + ": recorder did not exit within " + std::to_string(timeoutMs) + " ms");
    return *code;
  }
  std::size_t Cursor() const { return cursor_; }
  Process& Proc() { return process_; }
  const Json& Started() const { return started_; }

 private:
  Process process_;
  std::size_t cursor_ = 0;
  Json started_;
  bool saved_ = false;
};

// Validates a complete JSONL stream: strict JSON per line, one session, contiguous sequence.
std::vector<Json> ValidateStream(const std::vector<std::string>& lines, const std::string& what) {
  std::vector<Json> events;
  std::string session;
  std::uint64_t expected = 1;
  for (const auto& line : lines) {
    const Json event = ParseLine(line);
    if (event["protocol"] != "memmy.windows.computer-history" || event["version"] != 1 || event["platform"] != "windows") {
      Fail(what + ": envelope mismatch");
    }
    if (session.empty()) session = event["sessionId"].get<std::string>();
    if (event["sessionId"] != session) Fail(what + ": sessionId changed within a stream");
    if (event["sequence"].get<std::uint64_t>() != expected) {
      Fail(what + ": sequence gap at " + std::to_string(expected));
    }
    ++expected;
    events.push_back(event);
  }
  if (events.empty()) Fail(what + ": empty stream");
  return events;
}

bool IsSnapshot(const Json& event, const char* status) {
  return event["kind"] == "snapshot" && event["snapshot"]["status"] == status;
}

void ExpectProcessGone(DWORD pid, HANDLE handle, DWORD timeoutMs, const std::string& what) {
  if (WaitForSingleObject(handle, timeoutMs) != WAIT_OBJECT_0) {
    Fail(what + ": process " + std::to_string(pid) + " still running");
  }
}

// ======================================================================================
// Cases
// ======================================================================================

void CaseCliContract() {
  auto r = RunToEnd(g_paths.Recorder(), {L"--version"}, "version");
  Expect(r.exitCode == 0 && r.lines.size() == 1 && r.lines[0].find("protocol 1") != std::string::npos &&
             r.lines[0].find("test-hooks") == std::string::npos,
         "production --version");
  r = RunToEnd(g_paths.TestHooks(), {L"--version"}, "version-testhooks");
  Expect(r.exitCode == 0 && r.lines[0].find("test-hooks") != std::string::npos, "test-hooks --version");
  r = RunToEnd(g_paths.Recorder(), {L"help"}, "help");
  Expect(r.exitCode == 0 && Join(r.lines).find("observe --policy FILE") != std::string::npos, "help text");
  r = RunToEnd(g_paths.Recorder(), {L"bogus"}, "bogus");
  Expect(r.exitCode == 2 && r.lines.empty() && r.err.find("unknown_command") != std::string::npos, "unknown command");
  // Fault-injection options do not exist in the production executable.
  r = RunToEnd(g_paths.Recorder(), {L"snapshot", L"--hwnd", L"1", L"--policy", L"p.json", L"--test-worker-sleep-ms", L"5"},
               "prod-test-option");
  Expect(r.exitCode == 2 && r.err.find("unknown_option") != std::string::npos, "production rejects test options");
  r = RunToEnd(g_paths.Recorder(), {L"observe", L"--policy", L"p.json", L"--test-gate", L"Local\\memmy-history-test-x"},
               "prod-test-gate");
  Expect(r.exitCode == 2 && r.lines.empty(), "production rejects test gate");
  // observe never starts without a valid policy.
  const fs::path missing = g_paths.artifacts / "does-not-exist.json";
  r = RunToEnd(g_paths.Recorder(), {L"observe", L"--policy", missing.wstring()}, "observe-missing-policy");
  Expect(r.exitCode == 2 && r.lines.empty() && r.err.find("policy_unavailable") != std::string::npos,
         "observe refuses a missing policy");
  const fs::path invalid = WriteRawPolicy("invalid", R"({"version":1,"applications":[{"pid":1,"executable":"C:\\a.exe","extra":true}]})");
  r = RunToEnd(g_paths.Recorder(), {L"observe", L"--policy", invalid.wstring()}, "observe-invalid-policy");
  Expect(r.exitCode == 2 && r.lines.empty() && r.err.find("policy_invalid") != std::string::npos,
         "observe refuses an invalid policy");
  // Worker mode validates its request strictly; production rejects test fields.
  r = RunToEnd(g_paths.Recorder(), {L"__worker"}, "worker-garbage", "{not json");
  Expect(r.exitCode == 0 && r.lines.size() == 1 && ParseLine(r.lines[0])["reason"] == "worker_invalid_request",
         "worker rejects malformed request");
  const std::string request =
      R"({"protocol":"memmy.windows.history-worker/1","hwnd":"1","pid":1,"processStart":"1","executable":"C:\\a.exe","policyText":"{}","testSleepMs":5})";
  r = RunToEnd(g_paths.Recorder(), {L"__worker"}, "worker-test-field", request);
  Expect(ParseLine(r.lines.at(0))["reason"] == "worker_invalid_request", "production worker rejects test fields");
  r = RunToEnd(g_paths.Recorder(), {L"windows", L"--pid", std::to_wstring(GetCurrentProcessId())}, "windows");
  Expect(r.exitCode == 0 && ParseLine(r.lines.at(0))["kind"] == "windows", "windows command");
  r = RunToEnd(g_paths.Recorder(), {L"applications"}, "applications");
  Expect(r.exitCode == 0 && r.lines.size() == 1, "applications command");
  const Json apps = ParseLine(r.lines[0]);
  Expect(apps["kind"] == "applications" && apps["applications"].is_array() && apps["applications"].size() <= 512,
         "bounded application discovery");
  for (const auto& app : apps["applications"]) {
    Expect(app.size() == 3 && app["pid"].is_number_unsigned() && app["executable"].is_string() && app["processStart"].is_string(),
           "application discovery emits identity only, never window titles or UI content");
  }
  r = RunToEnd(g_paths.Recorder(), {L"catalog"}, "application-catalog");
  Expect(r.exitCode == 0 && r.lines.size() == 1, "catalog command");
  const Json catalog = ParseLine(r.lines[0]);
  Expect(catalog["kind"] == "application.catalog" && catalog["applications"].is_array() && catalog["applications"].size() <= 512,
    "bounded display catalog");
  for (const auto& app : catalog["applications"])
    Expect(app.size() == 2 && app["name"].is_string() && app["executable"].is_string(), "catalog emits display metadata only");
}

void CasePolicyStrict() {
  Fixture fixture;
  fixture.Start();
  const std::string exe = memmy::DumpJson(Json(fixture.Exe()));
  const std::string pid = std::to_string(fixture.Pid());
  const std::vector<std::pair<std::string, std::string>> cases = {
      {"unknown-key", R"({"version":1,"applications":[{"pid":)" + pid + R"(,"executable":)" + exe + R"(,"allowAll":true}]})"},
      {"number-identity", R"({"version":1,"applications":[{"pid":)" + pid + R"(,"executable":)" + exe +
                              R"(,"processStart":)" + fixture.ProcessStart() + R"(}]})"},
      {"duplicate-key", R"({"version":1,"applications":[{"pid":)" + pid + R"(,"pid":)" + pid + R"(,"executable":)" + exe + R"(}]})"},
      {"empty", ""},
      {"truncated", R"({"version":1,"applications":[{"pid":)" + pid},
      {"global-switch", R"({"version":1,"allowUnknownPrivate":true,"applications":[{"pid":)" + pid + R"(,"executable":)" + exe + R"(}]})"},
  };
  for (const auto& [name, bytes] : cases) {
    const fs::path policy = WriteRawPolicy("policy-" + name, bytes);
    const Json event = Snapshot(g_paths.Recorder(), fixture.HwndA(), policy, "snapshot-" + name);
    ExpectBlocked(event, "policy_invalid", name);
    Expect(event["context"].is_null(), name + ": context must be null for an invalid policy");
    Expect(memmy::DumpJson(event).find("FIXTURE-") == std::string::npos, name + ": fixture text leaked");
  }
  const fs::path big = WriteRawPolicy("policy-too-large", std::string(300 * 1024, ' '));
  ExpectBlocked(Snapshot(g_paths.Recorder(), fixture.HwndA(), big, "snapshot-too-large"), "policy_too_large", "too large");
  // A writer holding the file exclusively makes the read fail closed.
  const fs::path locked = WritePolicy("policy-locked", Json::array({AppRule(fixture)}));
  HANDLE lock = CreateFileW(locked.wstring().c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  Expect(lock != INVALID_HANDLE_VALUE, "could not lock policy");
  const Json event = Snapshot(g_paths.Recorder(), fixture.HwndA(), locked, "snapshot-locked");
  CloseHandle(lock);
  ExpectBlocked(event, "policy_unavailable", "locked policy");
}

void CaseIdentityMismatch() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const auto run = [&](const std::string& name, Json rule, Json extra = Json::object()) {
    const fs::path policy = WritePolicy("policy-" + name, Json::array({std::move(rule)}), std::move(extra));
    const Json event = Snapshot(g_paths.Recorder(), fixture.HwndA(), policy, "snapshot-" + name);
    fixture.ExpectForeground('a', name);
    return event;
  };
  Json event = run("exact", AppRule(fixture));
  Expect(Status(event) == "ok", "exact identity must be readable, got " + Reason(event));
  Expect(memmy::DumpJson(event).find(fixture.S("STATIC")) != std::string::npos, "static text missing");
  const Json& context = event["context"];
  Expect(context["pid"] == fixture.Pid() && context["processStart"] == fixture.ProcessStart() &&
             context["hwnd"] == fixture.HwndA() && context["dpi"].get<int>() > 0,
         "context identity fields");
  Expect(memmy::text::EqualsOrdinalIgnoreCase(W(context["executable"].get<std::string>()), W(fixture.Exe())),
         "canonical executable");

  // Canonicalization: other case and forward slashes name the same file.
  Json rule = AppRule(fixture);
  std::string upper = fixture.Exe();
  std::transform(upper.begin(), upper.end(), upper.begin(), [](char c) { return c == '\\' ? '/' : static_cast<char>(toupper(c)); });
  rule["executable"] = upper;
  Expect(Status(run("case-slash", rule)) == "ok", "path canonicalization");

  rule = AppRule(fixture);
  rule["pid"] = fixture.Pid() + 1;
  event = run("wrong-pid", rule);
  ExpectBlocked(event, "application_not_authorized", "wrong pid");
  Expect(event["context"].is_null(), "unauthorized target must stay anonymous");

  rule = AppRule(fixture);
  rule["executable"] = (fs::path(W(fixture.Exe())).parent_path() / L"memmy-history-recorder.exe").string();
  ExpectBlocked(run("wrong-exe", rule), "application_not_authorized", "wrong executable");

  rule = AppRule(fixture);
  rule["hwnd"] = fixture.HwndB();
  ExpectBlocked(run("wrong-hwnd", rule), "application_not_authorized", "wrong hwnd");

  rule = AppRule(fixture);
  rule["processStart"] = std::to_string(std::stoull(fixture.ProcessStart()) + 1);
  ExpectBlocked(run("wrong-start", rule), "application_not_authorized", "wrong process start");

  rule = AppRule(fixture);
  rule["processStart"] = fixture.ProcessStart();
  rule["hwnd"] = fixture.HwndA();
  Expect(Status(run("full-identity", rule)) == "ok", "full identity");

  ExpectBlocked(run("deny-exe", AppRule(fixture), {{"deny", {{"executables", Json::array({fixture.Exe()})}}}}),
                "application_denied", "deny executable wins");
  ExpectBlocked(run("deny-pid", AppRule(fixture), {{"deny", {{"pids", Json::array({fixture.Pid()})}}}}),
                "application_denied", "deny pid wins");
}

void CaseBrowserUnsupported() {
  // The fixture copied under a browser executable name: authorized exactly, still refused.
  const fs::path dir = g_paths.artifacts / L"browser bin";
  fs::create_directories(dir);
  const fs::path browser = dir / L"msedge.exe";
  fs::copy_file(g_paths.Fixture(), browser, fs::copy_options::overwrite_existing);
  Fixture fixture(browser);
  fixture.Start();
  fixture.TryActivate('a');  // refusal must not depend on foreground
  Json rule = FullRule(fixture);
  rule["hwnd"] = fixture.HwndA();
  rule["processStart"] = fixture.ProcessStart();
  const fs::path policy = WritePolicy("policy-browser", Json::array({rule}));
  const Json event = Snapshot(g_paths.Recorder(), fixture.HwndA(), policy, "snapshot-browser");
  ExpectBlocked(event, "browser_unsupported", "browser");
  Expect(!event["context"].is_null(), "named browser target keeps its identity");
  Expect(memmy::DumpJson(event).find("FIXTURE-") == std::string::npos, "browser content leaked");
}

void CaseSnapshotContent() {
  Fixture fixture;
  fixture.Start();
  VerifyFixtureExposesChildren(fixture);
  fixture.RequireForeground('a');
  const fs::path policy = WritePolicy("policy-full", Json::array({FullRule(fixture)}));

  Expect(fixture.Command("focus edit").value("ok", false), "focus edit");
  Json event = Snapshot(g_paths.Recorder(), fixture.HwndA(), policy, "snapshot-edit-focused");
  fixture.ExpectForeground('a', "after edit-focused snapshot");
  Expect(Status(event) == "ok", "content snapshot: " + Reason(event));
  std::string text = memmy::DumpJson(event);
  for (const char* kind : {"STATIC", "MESSAGE-1", "DOCUMENT"}) {
    Expect(text.find(fixture.S(kind)) != std::string::npos, std::string("missing permitted content ") + kind);
  }
  ExpectNoLeak(text, fixture, {"EDIT", "EDITCHILD", "PASSWORD", "PWCHILD", "SENSITIVE", "SEARCH", "SECOND"},
               "edit-focused snapshot");
  const Json* edit = FindNode(event, "1004");
  const Json* password = FindNode(event, "1005");
  const auto passwordRuntimeId = "42." + std::to_string(reinterpret_cast<std::uintptr_t>(GetDlgItem(fixture.Hwnd('a'), 1009)));
  const Json* misreported = nullptr;
  for (const auto& node : event["snapshot"]["nodes"])
    if (node.value("runtimeId", "") == passwordRuntimeId) misreported = &node;
  const Json* panel = FindNode(event, "1007");
  const Json* document = FindNode(event, "1006");
  Expect(edit && (*edit)["redaction"] == "edit_control" && !edit->contains("name"), "edit redaction");
  Expect(password && (*password)["redaction"] == "password" && (*password)["password"] == true, "password redaction");
  Expect(misreported && (*misreported)["redaction"] == "password" && (*misreported)["password"] == true &&
    !misreported->contains("name"), "native password style overrides non-password Pane provider");
  ExpectNoLeak(text, fixture, {"MISREPORTEDPASSWORD", "MISREPORTEDCHILD"}, "native password fallback");
  Expect(panel && (*panel)["redaction"] == "sensitive_id", "sensitive container redaction");
  Expect(document && (*document)["text"].get<std::string>().find(fixture.S("DOCUMENT")) != std::string::npos,
         "authorized document text");
  Expect(document->contains("visibleText"), "visible ranges reported for the document");

  // Search value only with exact selector and live focus.
  Expect(fixture.Command("focus search").value("ok", false), "focus search");
  event = Snapshot(g_paths.Recorder(), fixture.HwndA(), policy, "snapshot-search-focused");
  fixture.ExpectForeground('a', "after search snapshot");
  const Json* search = FindNode(event, "1003");
  Expect(Status(event) == "ok" && search && search->value("value", "") == fixture.S("SEARCH"),
         "focused authorized search value");
  ExpectNoLeak(memmy::DumpJson(event), fixture, ForbiddenKinds(), "search-focused snapshot");

  Expect(fixture.Command("focus password").value("ok", false), "focus password");
  event = Snapshot(g_paths.Recorder(), fixture.HwndA(), policy, "snapshot-password-focused");
  text = memmy::DumpJson(event);
  Expect(Status(event) == "ok", "password-focused snapshot");
  ExpectNoLeak(text, fixture, {"EDIT", "EDITCHILD", "PASSWORD", "PWCHILD", "SENSITIVE", "SEARCH"},
               "password-focused snapshot");
  Expect(event["snapshot"]["focusKey"].is_string(), "focus key reported");

  // Without a document selector the body is not read; without the sensitive id the panel's
  // static child is ordinary visible text again (proving the sensitive rule did the blocking).
  Json rule = AppRule(fixture);
  const fs::path plain = WritePolicy("policy-plain", Json::array({rule}));
  Expect(fixture.Command("focus search").value("ok", false), "focus search again");
  event = Snapshot(g_paths.Recorder(), fixture.HwndA(), plain, "snapshot-plain");
  text = memmy::DumpJson(event);
  Expect(Status(event) == "ok", "plain snapshot");
  Expect(text.find(fixture.S("DOCUMENT")) == std::string::npos, "document text read without selector");
  Expect(text.find(fixture.S("SEARCH")) == std::string::npos, "search value read without selector");
  Expect(text.find(fixture.S("SENSITIVE")) != std::string::npos, "panel child should be visible without sensitive rule");
  ExpectNoLeak(text, fixture, {"EDIT", "EDITCHILD", "PASSWORD", "PWCHILD"}, "plain snapshot");

  // Truncation is reported honestly.
  const fs::path tiny = WritePolicy("policy-tiny", Json::array({FullRule(fixture)}),
                                    {{"limits", {{"maxNodes", 3}, {"maxVisited", 3}}}});
  event = Snapshot(g_paths.Recorder(), fixture.HwndA(), tiny, "snapshot-tiny");
  Expect(Status(event) == "ok" && event["snapshot"]["truncated"] == true && event["snapshot"]["nodes"].size() <= 3,
         "node limit truncation");
  const fs::path shortText = WritePolicy("policy-short-text", Json::array({FullRule(fixture)}),
                                         {{"limits", {{"maxTextChars", 30}, {"maxNodeTextChars", 20}}}});
  event = Snapshot(g_paths.Recorder(), fixture.HwndA(), shortText, "snapshot-short-text");
  Expect(Status(event) == "ok" && event["snapshot"]["truncated"] == true, "text budget truncation");
  const auto truncation = event["snapshot"]["truncation"].dump();
  Expect(truncation.find("max_text") != std::string::npos, "max_text reported");
}

void CaseSnapshotNotForeground() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('b');
  const fs::path policy = WritePolicy("policy-a", Json::array({FullRule(fixture)}));
  Json event = Snapshot(g_paths.Recorder(), fixture.HwndA(), policy, "snapshot-background-a");
  ExpectBlocked(event, "not_foreground", "background window");
  Expect(memmy::DumpJson(event).find("FIXTURE-") == std::string::npos, "background content leaked");
  // Window B is foreground but only window A is authorized.
  Json rule = FullRule(fixture);
  rule["hwnd"] = fixture.HwndA();
  const fs::path onlyA = WritePolicy("policy-only-a", Json::array({rule}));
  event = Snapshot(g_paths.Recorder(), fixture.HwndB(), onlyA, "snapshot-unauthorized-b");
  ExpectBlocked(event, "application_not_authorized", "unauthorized foreground window");
  Expect(event["context"].is_null() && memmy::DumpJson(event).find(fixture.S("SECOND")) == std::string::npos,
         "unauthorized window leaked");
  // Child HWNDs are not valid targets.
  const HWND child = GetDlgItem(fixture.Hwnd('a'), 1001);
  event = Snapshot(g_paths.Recorder(), std::to_string(reinterpret_cast<std::uintptr_t>(child)), policy, "snapshot-child");
  ExpectBlocked(event, "not_top_level", "child hwnd");
  fixture.ExpectForeground('b', "at end");
}

struct Gate {
  std::wstring name;
  HANDLE ready = nullptr;
  HANDLE resume = nullptr;
  explicit Gate(const std::string& suffix) {
    name = L"Local\\memmy-history-test-" + W(suffix);
    ready = CreateEventW(nullptr, TRUE, FALSE, (name + L".ready").c_str());
    resume = CreateEventW(nullptr, TRUE, FALSE, (name + L".continue").c_str());
    if (!ready || !resume) Fail("gate events");
  }
  ~Gate() {
    CloseHandle(ready);
    CloseHandle(resume);
  }
  void AwaitReady(DWORD timeoutMs = 15000) {
    if (WaitForSingleObject(ready, timeoutMs) != WAIT_OBJECT_0) Fail("worker never reached the test gate");
  }
  void Release() { SetEvent(resume); }
};

Json GatedSnapshot(Fixture& fixture, const fs::path& policy, const std::string& name,
                   const std::function<void()>& atGate, bool atCommit = false) {
  Gate gate(Nonce() + "-" + name);
  Process process;
  process.Start(g_paths.TestHooks(), {L"snapshot", L"--hwnd", W(fixture.HwndA()), L"--policy", policy.wstring(),
                                      atCommit ? L"--test-commit-gate" : L"--test-gate", gate.name});
  process.CloseStdin();
  gate.AwaitReady();
  atGate();
  gate.Release();
  const auto code = process.WaitExit(20000);
  process.Save(name);
  if (!code) Fail(name + ": gated snapshot did not exit");
  const auto lines = process.Lines();
  if (lines.size() != 1) Fail(name + ": expected one line");
  return ParseLine(lines[0]);
}

void CaseRaceAba() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = WritePolicy("policy", Json::array({FullRule(fixture)}));
  // Control: the gate itself does not cause a rejection.
  Json event = GatedSnapshot(fixture, policy, "gate-control", [] {});
  Expect(Status(event) == "ok", "gated control snapshot must succeed, got " + Reason(event));
  for (int i = 0; i < 5; ++i) {
    event = GatedSnapshot(fixture, policy, "aba-" + std::to_string(i), [&] {
      if (!fixture.TryActivate('b')) Skip("could not switch foreground to window B");
      if (!fixture.TryActivate('a')) Skip("could not switch foreground back to window A");
    });
    fixture.ExpectForeground('a', "after A->B->A");
    ExpectBlocked(event, "context_changed", "A->B->A iteration " + std::to_string(i));
    Expect(memmy::DumpJson(event).find("FIXTURE-") == std::string::npos, "A->B->A content leaked");
  }
}

void CaseRacePolicy() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = WritePolicy("policy", Json::array({FullRule(fixture)}));
  const std::string original = ReadFileBytes(policy);
  Json event = GatedSnapshot(fixture, policy, "policy-whitespace", [&] { WriteFileBytes(policy, original + " "); });
  ExpectBlocked(event, "policy_changed", "policy rewritten during query");
  WriteFileBytes(policy, original);
  event = GatedSnapshot(fixture, policy, "policy-corrupt", [&] { WriteFileBytes(policy, "{corrupt"); });
  ExpectBlocked(event, "policy_changed", "policy corrupted during query");
  Expect(memmy::DumpJson(event).find("FIXTURE-") == std::string::npos, "policy race leaked content");
}

void CaseCommitRaces() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  fixture.Command("focus search");
  const fs::path policy = WritePolicy("policy", Json::array({FullRule(fixture)}),
                                      {{"limits", {{"queryBudgetMs", 2000}, {"workerTimeoutMs", 4000}}}});
  const std::string original = ReadFileBytes(policy);
  const Json control = GatedSnapshot(fixture, policy, "commit-control", [] {}, true);
  Expect(Status(control) == "ok" && memmy::DumpJson(control).find(fixture.S("SEARCH")) != std::string::npos,
         "commit gate control must have authorized search content");
  Json event = GatedSnapshot(fixture, policy, "commit-policy", [&] { WriteFileBytes(policy, original + " "); }, true);
  ExpectBlocked(event, "policy_changed", "policy changed after serialization");
  Expect(memmy::DumpJson(event).find("FIXTURE-") == std::string::npos, "commit policy content leaked");
  WriteFileBytes(policy, original);
  event = GatedSnapshot(fixture, policy, "commit-aba", [&] {
    if (!fixture.TryActivate('b') || !fixture.TryActivate('a')) Skip("foreground A->B->A unavailable");
  }, true);
  ExpectBlocked(event, "context_changed", "foreground changed after serialization");
  fixture.Command("focus search");
  event = GatedSnapshot(fixture, policy, "commit-password-focus", [&] { fixture.Command("focus password"); }, true);
  ExpectBlocked(event, "context_changed", "search-to-password focus change within window");
  Expect(memmy::DumpJson(event).find("FIXTURE-") == std::string::npos, "same-window focus race leaked content");
  fixture.Command("focus search");
  event = GatedSnapshot(fixture, policy, "commit-focus-aba", [&] {
    fixture.Command("focus password");
    fixture.Command("focus search");
  }, true);
  ExpectBlocked(event, "context_changed", "focus A->B->A after serialization");
}

void CaseCommitPause() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = WritePolicy("policy", Json::array({FullRule(fixture)}),
                                      {{"limits", {{"queryBudgetMs", 2000}, {"workerTimeoutMs", 4000}}}});
  Gate gate(Nonce() + "-commit-pause");
  Observe observe;
  observe.Start(g_paths.TestHooks(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60",
                                     L"--sample-ms", L"300", L"--test-commit-gate", gate.name});
  gate.AwaitReady();
  observe.Send("pause");
  observe.Wait("session.paused", 5000);
  gate.Release();
  Expect(!observe.TryWait("snapshot", 700), "no content serialized before pause may commit");
  Expect(Join(observe.Proc().Lines()).find("FIXTURE-") == std::string::npos, "pause race leaked content");
  observe.Send("resume");
  const Json next = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  Expect(next["snapshot"]["mode"] == "full", "resume rebuilds baseline after cancelled commit");
  observe.Send("stop");
  observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "commit-pause") == 0, "commit pause exit");
  ValidateStream(observe.Proc().Lines(), "commit pause");
}

void CaseCommitControlFlood() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = WritePolicy("policy", Json::array({FullRule(fixture)}),
                                      {{"limits", {{"queryBudgetMs", 2000}, {"workerTimeoutMs", 4000}}}});
  for (bool stop : {false, true}) {
    Gate gate(Nonce() + "-commit-flood");
    Observe observe;
    observe.Start(g_paths.TestHooks(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60",
                                       L"--test-commit-gate", gate.name});
    gate.AwaitReady();
    std::string flood;
    for (int i = 0; i < 4096; ++i) flood += "unknown\n";
    if (stop) flood += "stop";
    observe.Send(flood);
    if (!stop) observe.Proc().CloseStdin();
    const Json stopped = observe.Wait("session.stopped", 5000);
    Expect(stopped["reason"] == (stop ? "stop_command" : "stdin_eof"), "flood terminal reason");
    Expect(observe.Finish(5000, stop ? "commit-flood-stop" : "commit-flood-eof") == 0, "flood exit");
    Expect(Join(observe.Proc().Lines()).find("FIXTURE-") == std::string::npos, "control flood leaked pending content");
    ValidateStream(observe.Proc().Lines(), "commit control flood");
  }
}

void CasePartialBaseline() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const Json rule = FullRule(fixture);
  const fs::path policy = WritePolicy("policy", Json::array({rule}),
                                      {{"limits", {{"maxNodes", 3}, {"queryBudgetMs", 2000}, {"workerTimeoutMs", 4000}}}});
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60", L"--sample-ms", L"300"});
  for (int i = 0; i < 2; ++i) {
    const Json partial = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "ok"); });
    Expect(partial["snapshot"]["truncated"] == true && partial["snapshot"]["mode"] == "full" &&
               !partial["snapshot"].contains("removed"), "partial snapshot cannot emit deletion delta");
  }
  WritePolicy("policy", Json::array({rule}), {{"limits", {{"queryBudgetMs", 2000}, {"workerTimeoutMs", 4000}}}});
  const Json complete = observe.Wait("snapshot", 8000, [](const Json& e) {
    return IsSnapshot(e, "ok") && e["snapshot"]["truncated"] == false;
  });
  Expect(complete["snapshot"]["mode"] == "full", "complete recovery starts full baseline");
  fixture.Command("set-message complete-recovery-content");
  const Json delta = observe.Wait("snapshot", 8000, [](const Json& e) {
    return IsSnapshot(e, "ok") && memmy::DumpJson(e).find("complete-recovery-content") != std::string::npos;
  });
  Expect(delta["snapshot"]["mode"] == "delta", "complete baseline permits subsequent delta");
  observe.Send("stop");
  observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "partial-baseline") == 0, "partial baseline exit");
  ValidateStream(observe.Proc().Lines(), "partial baseline");
}

void CaseTimeoutReap() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = WritePolicy("policy", Json::array({FullRule(fixture)}),
                                      {{"limits", {{"queryBudgetMs", 300}, {"workerTimeoutMs", 800}}}});
  Process process;
  const auto started = std::chrono::steady_clock::now();
  process.Start(g_paths.TestHooks(), {L"snapshot", L"--hwnd", W(fixture.HwndA()), L"--policy", policy.wstring(),
                                      L"--test-worker-sleep-ms", L"20000"});
  process.CloseStdin();
  // Hold a handle to the worker so its PID cannot be reused while we check it.
  HANDLE worker = nullptr;
  DWORD workerPid = 0;
  for (int i = 0; i < 100 && !worker; ++i) {
    const auto children = ChildrenOf(process.Pid(), g_paths.TestHooks().filename().wstring());
    if (!children.empty()) {
      workerPid = children[0];
      worker = OpenProcess(SYNCHRONIZE, FALSE, workerPid);
    }
    if (!worker) Sleep(20);
  }
  const auto code = process.WaitExit(10000);
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  process.Save("snapshot-timeout");
  Expect(code.has_value(), "snapshot with hung worker did not return");
  Expect(worker != nullptr, "worker process was not observed");
  ExpectProcessGone(workerPid, worker, 0, "timed-out worker");
  CloseHandle(worker);
  const Json event = ParseLine(process.Lines().at(0));
  ExpectBlocked(event, "worker_timeout", "hung worker");
  Expect(elapsed < 5000, "timeout took " + std::to_string(elapsed) + " ms");
  Log("timeout returned after " + std::to_string(elapsed) + " ms");
  // A later query works normally.
  Expect(Status(Snapshot(g_paths.TestHooks(), fixture.HwndA(), policy, "snapshot-after-timeout")) == "ok",
         "recovery after timeout");
}

fs::path ObservePolicy(Fixture& fixture, const std::string& name, Json extra = Json::object()) {
  return WritePolicy(name, Json::array({FullRule(fixture)}), std::move(extra));
}

void CaseObserveCheckpoint() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = ObservePolicy(fixture, "checkpoint-policy",
    {{"limits", {{"queryBudgetMs", 2000}, {"workerTimeoutMs", 4000}}}});
  Gate gate(Nonce() + "-checkpoint");
  Observe observe;
  observe.Start(g_paths.TestHooks(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60",
    L"--sample-ms", L"300", L"--test-commit-gate", gate.name});
  gate.AwaitReady();
  const std::string id = "12345678-1234-1234-1234-123456789abc";
  observe.Send("checkpoint " + id);
  Sleep(200);
  for (const auto& line : observe.Proc().Lines()) {
    const auto event = ParseLine(line);
    Expect(event["kind"] != "session.checkpoint", "marker overtook the in-flight commit");
    Expect(event["kind"] != "capture.gap", "checkpoint cancelled the in-flight commit");
  }
  gate.Release();
  const auto before = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  const auto marker = observe.Wait("session.checkpoint", 8000);
  Expect(marker["id"] == id && marker["complete"] == true && marker["captureSequence"] > 0,
    "ordered checkpoint carries its identity and capture ordinal");
  Expect(marker["sequence"] > before["sequence"], "snapshot must precede its marker");
  const std::string nextId = "12345678-1234-1234-1234-123456789abd";
  fixture.Command("set-message " + fixture.S("AFTER-CHECKPOINT"));
  observe.Send("checkpoint " + nextId);
  const auto next = observe.Wait("session.checkpoint", 8000);
  Expect(next["id"] == nextId && next["captureSequence"] > marker["captureSequence"], "monotonic capture markers");
  observe.Send("pause"); observe.Wait("session.paused", 5000);
  observe.Send("checkpoint " + id);
  const auto paused = observe.Wait("session.checkpoint", 5000);
  Expect(paused["complete"] == false && paused["captureSequence"] == 0, "paused collector cannot confirm coverage");
  observe.Send("stop"); observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "observe-checkpoint") == 0, "checkpoint collector exit");
  ValidateStream(observe.Proc().Lines(), "observe checkpoint");
}

void CaseObserveCheckpointOrigin() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = ObservePolicy(fixture, "checkpoint-origin-policy",
    {{"limits", {{"queryBudgetMs", 500}, {"workerTimeoutMs", 1500}}}});
  Gate gate(Nonce() + "-checkpoint-origin");
  Observe observe;
  observe.Start(g_paths.TestHooks(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60",
    L"--sample-ms", L"300", L"--input-hooks", L"--test-commit-gate", gate.name});
  gate.AwaitReady();
  fixture.Command("input navigation");
  Sleep(200);  // Hook dispatch continues while the collector commit is blocked.
  FILETIME cutoffTime{}; GetSystemTimeAsFileTime(&cutoffTime);
  const auto cutoff = memmy::protocol::FormatUtcTimestamp(
    (static_cast<std::uint64_t>(cutoffTime.dwHighDateTime) << 32) | cutoffTime.dwLowDateTime);
  Sleep(200);
  fixture.Command("input navigation");
  fixture.Command("freeze 5000");
  Sleep(200);
  gate.Release();
  observe.Send("checkpoint 12345678-1234-1234-1234-123456789abc");
  const auto gap = observe.Wait("capture.gap", 8000, [](const Json& e) { return e["code"] == "query_unavailable"; });
  Expect(gap["from"].get<std::string>() <= cutoff,
    "queued observation loss must retain capture time before the cutoff, not dequeue time after it");
  const auto failed = observe.Wait("snapshot", 5000, [](const Json& e) { return IsSnapshot(e, "unavailable"); });
  const auto kinds = failed["trigger"]["kinds"].get<std::vector<std::string>>();
  Expect(std::find(kinds.begin(), kinds.end(), "input") != kinds.end(), "failure must cover queued real input");
  observe.Send("stop"); observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "observe-checkpoint-origin") == 0, "checkpoint origin exit");
  ValidateStream(observe.Proc().Lines(), "observe checkpoint origin");
}

void CaseObserveLifecycle() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  fixture.Command("focus edit");
  const fs::path policy = ObservePolicy(fixture, "policy");
  const fs::path output = g_paths.artifacts / L"observe.jsonl";
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--output", output.wstring(),
                                     L"--seconds", L"90", L"--sample-ms", L"300"});
  Json first = observe.Wait("snapshot", 10000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  Expect(first["snapshot"]["mode"] == "full", "first snapshot is a full baseline");
  Expect(memmy::DumpJson(first).find(fixture.S("STATIC")) != std::string::npos, "first snapshot content");

  fixture.Command("set-message " + fixture.S("MESSAGE-2"));
  Json delta = observe.Wait("snapshot", 8000, [&](const Json& e) {
    return IsSnapshot(e, "ok") && memmy::DumpJson(e).find(fixture.S("MESSAGE-2")) != std::string::npos;
  });
  Expect(delta["snapshot"]["mode"] == "delta", "content change reported as delta");
  Expect(!delta["snapshot"]["removed"].empty(), "replaced message reported as removed");
  for (const auto& key : delta["snapshot"]["removed"]) {
    Expect(key.is_string() && key.get<std::string>().size() == 16 &&
               key.get<std::string>().find_first_not_of("0123456789abcdef") == std::string::npos,
           "removed entries are keys only");
  }
  Expect(memmy::DumpJson(delta["snapshot"]["removed"]).find("FIXTURE-") == std::string::npos, "removed leaked text");

  for (int cycle = 0; cycle < 6; ++cycle) {
    observe.Send("pause");
    observe.Wait("session.paused", 5000);
    const std::size_t pausedAt = observe.Cursor();
    const std::string message = fixture.S(("MESSAGE-P" + std::to_string(cycle)).c_str());
    fixture.Command("set-message " + message);
    fixture.Command("focus search");
    Sleep(cycle == 0 ? 1500 : 400);
    observe.Send("resume");
    observe.Wait("session.resumed", 5000);
    // Nothing captured between the pause acknowledgement and the resume acknowledgement.
    const auto lines = observe.Proc().Lines();
    for (std::size_t i = pausedAt; i + 1 < observe.Cursor(); ++i) {
      const Json event = ParseLine(lines[i]);
      Expect(event["kind"] != "snapshot", "snapshot emitted while paused (cycle " + std::to_string(cycle) + ")");
    }
    const Json resumed = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "ok"); });
    Expect(resumed["snapshot"]["mode"] == "full", "resume starts a new full baseline");
    if (memmy::DumpJson(resumed).find(message) == std::string::npos) {
      // Only an explicitly degraded read (budget truncation or a failed Name read on the
      // message node) may omit current content; anything else is a stale-content failure.
      const Json* node = FindNode(resumed, "1002");
      const bool nameAbsent = !node || !node->contains("name");
      bool nameFailed = false;
      if (node && node->contains("missing")) {
        for (const auto& property : (*node)["missing"]) if (property == "name") nameFailed = true;
      }
      const bool degraded = nameAbsent && (resumed["snapshot"]["truncated"] == true || nameFailed);
      Log("resume baseline without current message: truncated=" + resumed["snapshot"]["truncation"].dump() +
          " messageNode=" + (node ? node->dump() : std::string("absent")) + " seq=" + resumed["sequence"].dump());
      Expect(degraded, "resume baseline has current content");
      observe.Wait("snapshot", 8000, [&](const Json& e) {
        return IsSnapshot(e, "ok") && memmy::DumpJson(e).find(message) != std::string::npos;
      });
    }
    fixture.Command("focus edit");
  }
  fixture.ExpectForeground('a', "during lifecycle");
  observe.Send("stop");
  const Json stopped = observe.Wait("session.stopped", 5000);
  Expect(stopped["reason"] == "stop_command" && stopped["hooksDetached"] == true, "stop reason and unhook");
  Expect(observe.Finish(5000, "observe") == 0, "observe exit code");

  const auto lines = observe.Proc().Lines();
  const auto events = ValidateStream(lines, "stdout");
  Expect(ReadFileBytes(output) == observe.Proc().StdoutBytes(), "file output differs from stdout");
  ExpectNoLeak(observe.Proc().StdoutBytes(), fixture, ForbiddenKinds(), "observe stream");
  Expect(observe.Proc().Stderr().find("FIXTURE-") == std::string::npos, "stderr carried content");
  const Json counters = events.back()["counters"];
  Expect(counters["control"]["pauses"] == 6 && counters["control"]["resumes"] == 6, "pause/resume counters");
}

void CaseObserveUnauthorizedForeground() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  fixture.Command("focus edit");
  Json rule = FullRule(fixture);
  rule["hwnd"] = fixture.HwndA();
  const fs::path policy = WritePolicy("policy-only-a", Json::array({rule}));
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60", L"--sample-ms", L"250"});
  observe.Wait("snapshot", 10000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  if (!fixture.TryActivate('b')) Skip("could not activate window B");
  const Json blocked = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "blocked"); });
  Expect(blocked["snapshot"]["reason"] == "application_not_authorized" && blocked["context"].is_null(),
         "unauthorized foreground is anonymous");
  const std::size_t afterBlocked = observe.Cursor();
  Sleep(2000);  // several samples while B stays foreground
  fixture.ExpectForeground('b', "while B foreground");
  const auto lines = observe.Proc().Lines();
  for (std::size_t i = afterBlocked; i < lines.size(); ++i) {
    Expect(ParseLine(lines[i])["kind"] != "snapshot", "repeated refusals must be counted, not re-emitted");
  }
  if (!fixture.TryActivate('a')) Skip("could not re-activate window A");
  const Json back = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  Expect(back["snapshot"]["mode"] == "full", "returning to A starts a full baseline");
  observe.Send("stop");
  observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
  const std::string all = observe.Proc().StdoutBytes();
  Expect(all.find(fixture.S("SECOND")) == std::string::npos, "unauthorized window content leaked");
  ExpectNoLeak(all, fixture, ForbiddenKinds(), "observe stream");
  Expect(ValidateStream(observe.Proc().Lines(), "stdout").back()["counters"]["queries"]["suppressedRepeats"].get<int>() > 0,
         "suppressed repeats counted");
}

void CaseObservePolicyCorrupt() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = ObservePolicy(fixture, "policy");
  const std::string original = ReadFileBytes(policy);
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60", L"--sample-ms", L"250"});
  observe.Wait("snapshot", 10000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  WriteFileBytes(policy, "{\"version\":1,\"applications\":[");
  observe.Wait("snapshot", 8000, [](const Json& e) {
    return IsSnapshot(e, "blocked") && (e["snapshot"]["reason"] == "policy_invalid" || e["snapshot"]["reason"] == "policy_changed");
  });
  const std::size_t corruptAt = observe.Cursor();
  Sleep(1200);
  for (std::size_t i = corruptAt; i < observe.Proc().Lines().size(); ++i) {
    Expect(!IsSnapshot(ParseLine(observe.Proc().Lines()[i]), "ok"), "content emitted under a corrupt policy");
  }
  WriteFileBytes(policy, original);
  const Json restored = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  Expect(restored["snapshot"]["mode"] == "full", "restored policy starts a full baseline");
  fixture.ExpectForeground('a', "during policy corruption");
  observe.Send("stop");
  observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
  ValidateStream(observe.Proc().Lines(), "stdout");
}

void CaseObservePolicyRace() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = ObservePolicy(fixture, "policy");
  const std::string original = ReadFileBytes(policy);
  Gate gate(Nonce() + "-observe");
  Observe observe;
  observe.Start(g_paths.TestHooks(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60", L"--sample-ms",
                                      L"300", L"--test-gate", gate.name});
  gate.AwaitReady();
  WriteFileBytes(policy, original + "\n");
  gate.Release();
  const Json first = observe.Wait("snapshot", 8000);
  ExpectBlocked(first, "policy_changed", "observe policy race");
  const Json next = observe.Wait("snapshot", 8000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  Expect(next["snapshot"]["mode"] == "full", "full baseline after policy change");
  observe.Send("stop");
  observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
}

void CaseObserveUiHangRecovery() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = ObservePolicy(fixture, "policy", {{"limits", {{"queryBudgetMs", 400}, {"workerTimeoutMs", 1200}}}});
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60", L"--sample-ms", L"300"});
  observe.Wait("snapshot", 10000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  // The fixture's UI thread stops pumping messages, so UIA calls into it hang.
  fixture.Command("freeze 3500");
  const Json failed = observe.Wait("snapshot", 8000, [](const Json& e) { return e["kind"] == "snapshot" && !IsSnapshot(e, "ok"); });
  Log("hung target produced " + failed["snapshot"]["status"].get<std::string>() + "/" + Reason(failed));
  Expect(failed["snapshot"]["status"] == "unavailable" || Reason(failed) == "context_changed",
         "hung target must not produce content");
  const Json recovered = observe.Wait("snapshot", 12000, [](const Json& e) { return IsSnapshot(e, "ok"); });
  Expect(recovered["snapshot"]["mode"] == "full", "recovery is a full baseline");
  observe.Send("stop");
  const Json stopped = observe.Wait("session.stopped", 5000);
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
  Log("timedOut=" + stopped["counters"]["queries"]["timedOut"].dump() +
      " unavailable=" + stopped["counters"]["queries"]["unavailable"].dump());
  Expect(ChildrenOf(observe.Proc().Pid(), g_paths.Recorder().filename().wstring()).empty(), "worker left behind");
}

void CaseObserveEof() {
  const fs::path policy = WritePolicy("policy", Json::array({{{"pid", GetCurrentProcessId()},
                                                             {"executable", U8(fs::path(g_paths.bin / L"memmy-history-integration-tests.exe").wstring())}}}));
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60"});
  const auto started = std::chrono::steady_clock::now();
  observe.Proc().CloseStdin();
  const Json stopped = observe.Wait("session.stopped", 5000);
  Expect(stopped["reason"] == "stdin_eof", "EOF stop reason");
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  Log("EOF to exit: " + std::to_string(ms) + " ms");
  Expect(ms < 3000, "EOF shutdown too slow");
}

fs::path NeutralPolicy() {
  // Authorizes only this harness process, which owns no windows: whatever is foreground is
  // refused anonymously, so lifecycle cases never read another application's content.
  return WritePolicy("policy-neutral",
                     Json::array({{{"pid", GetCurrentProcessId()},
                                   {"executable", U8((g_paths.bin / L"memmy-history-integration-tests.exe").wstring())}}}));
}

void RunParentCase(bool kill) {
  Process parent;
  parent.Start(g_paths.Fixture(), {L"--idle"});
  std::size_t cursor = 0;
  parent.WriteLine("info");
  Expect(parent.WaitLine(cursor, [](const std::string&) { return true; }, 5000).has_value(), "idle parent ready");
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--seconds", L"60",
                                     L"--parent-pid", std::to_wstring(parent.Pid())});
  Sleep(300);
  const auto started = std::chrono::steady_clock::now();
  if (kill) {
    TerminateProcess(parent.Handle(), 9);
  } else {
    parent.WriteLine("exit");
  }
  const Json stopped = observe.Wait("session.stopped", 5000);
  Expect(stopped["reason"] == "parent_exited", "parent exit stop reason");
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  Log(std::string(kill ? "parent kill" : "parent exit") + " to recorder exit: " + std::to_string(ms) + " ms");
  // stdin was still open, so the parent handle alone ended the session.
}

void CaseObserveParentExit() {
  RunParentCase(false);
  // A PID that is not a live process is rejected up front.
  const auto r = RunToEnd(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--parent-pid", L"4294967292"},
                          "bad-parent");
  Expect(r.exitCode == 2 && r.lines.empty() && r.err.find("parent_unavailable") != std::string::npos, "invalid parent pid");
}

void CaseObserveParentKill() { RunParentCase(true); }

void CaseObserveCollectorKillReapsWorker() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  const fs::path policy = ObservePolicy(fixture, "policy", {{"limits", {{"queryBudgetMs", 10000}, {"workerTimeoutMs", 30000}}}});
  // Repeated, and the collector is killed the moment a worker process appears, to probe the
  // window between worker creation and job membership.
  for (int iteration = 0; iteration < 10; ++iteration) {
    Observe observe;
    observe.Start(g_paths.TestHooks(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"120",
                                        L"--test-worker-sleep-ms", L"25000"});
    HANDLE worker = nullptr;
    DWORD workerPid = 0;
    for (int i = 0; i < 2500 && !worker; ++i) {
      const auto children = ChildrenOf(observe.Proc().Pid(), g_paths.TestHooks().filename().wstring());
      if (!children.empty()) {
        workerPid = children[0];
        worker = OpenProcess(SYNCHRONIZE, FALSE, workerPid);
      }
      if (!worker) Sleep(2);
    }
    Expect(worker != nullptr, "worker was not started");
    // Forced termination: no cleanup code runs in the collector.
    TerminateProcess(observe.Proc().Handle(), 9);
    observe.Finish(5000, "observe-" + std::to_string(iteration));
    const auto started = std::chrono::steady_clock::now();
    ExpectProcessGone(workerPid, worker, 3000, "worker after collector kill (iteration " + std::to_string(iteration) + ")");
    CloseHandle(worker);
    Log("iteration " + std::to_string(iteration) + ": worker gone " +
        std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count()) +
        " ms after collector kill");
    fixture.ExpectForeground('a', "between kill iterations");
  }
}

void CaseSingleInstance() {
  const fs::path policy = NeutralPolicy();
  const fs::path outputA = g_paths.artifacts / L"a.jsonl";
  Observe first;
  first.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--output", outputA.wstring(), L"--seconds", L"60"});
  const fs::path outputB = g_paths.artifacts / L"b.jsonl";
  const auto second = RunToEnd(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--output", outputB.wstring()},
                               "second", "", 10000);
  Expect(second.exitCode == 4 && second.lines.empty() && second.err.find("collector_already_running") != std::string::npos,
         "second collector refused");
  Expect(!fs::exists(outputB), "refused collector created output");
  first.Send("stop");
  first.Wait("session.stopped", 5000);
  Expect(first.Finish(5000, "first") == 0, "first exit");
  ValidateStream(SplitLines(ReadFileBytes(outputA)), "first output");
  // The lease is released on exit.
  Observe third;
  third.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60"});
  third.Send("stop");
  third.Wait("session.stopped", 5000);
  Expect(third.Finish(5000, "third") == 0, "lease released after exit");
}

void CaseRotationUnicodePath() {
  const fs::path dir = g_paths.artifacts / L"目录 with space ü";
  fs::create_directories(dir);
  const fs::path policy = dir / L"策略 policy.json";
  fs::copy_file(NeutralPolicy(), policy);
  const fs::path output = dir / L"out file.jsonl";
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--output", output.wstring(), L"--seconds",
                                     L"4", L"--rotate-seconds", L"1", L"--sample-ms", L"500"});
  const Json stopped = observe.Wait("session.stopped", 15000);
  Expect(stopped["reason"] == "duration_elapsed", "bounded duration");
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
  std::vector<std::string> fromFiles;
  int segments = 0;
  for (int index = 0;; ++index) {
    wchar_t name[64];
    if (index == 0) {
      std::swprintf(name, 64, L"out file.jsonl");
    } else {
      std::swprintf(name, 64, L"out file.%04d.jsonl", index);
    }
    const fs::path segment = dir / name;
    if (!fs::exists(segment)) break;
    ++segments;
    const auto lines = SplitLines(ReadFileBytes(segment));
    Expect(!lines.empty(), "empty segment");
    if (index > 0) {
      const Json head = ParseLine(lines[0]);
      Expect(head["kind"] == "segment.started" && head["segment"]["index"] == index, "segment header");
    }
    fromFiles.insert(fromFiles.end(), lines.begin(), lines.end());
  }
  Log("segments: " + std::to_string(segments));
  Expect(segments >= 3, "expected at least 3 segments in 4 s with 1 s rotation");
  Expect(fromFiles == observe.Proc().Lines(), "segments concatenate to the stdout stream");
  const auto events = ValidateStream(fromFiles, "segments");
  Expect(events.front()["segment"]["file"] == "out file.jsonl", "unicode/space file name reported");
}

void CaseOutputExists() {
  const fs::path output = g_paths.artifacts / L"existing.jsonl";
  WriteFileBytes(output, "PRE-EXISTING\n");
  const auto r = RunToEnd(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--output", output.wstring()},
                          "observe-existing");
  Expect(r.exitCode == 2 && r.lines.empty() && r.err.find("output_exists") != std::string::npos, "existing output refused");
  Expect(ReadFileBytes(output) == "PRE-EXISTING\n", "existing recording overwritten");
}

void CaseOutputSegmentFailure() {
  const fs::path output = g_paths.artifacts / L"seg.jsonl";
  const fs::path blocker = g_paths.artifacts / L"seg.0001.jsonl";
  WriteFileBytes(blocker, "PRE-EXISTING SEGMENT\n");
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--output", output.wstring(),
                                     L"--seconds", L"20", L"--rotate-seconds", L"1"});
  const Json error = observe.Wait("error", 6000);
  Expect(error["code"] == "output_segment_exists" && error["channel"] == "file" && error["fatal"] == true,
         "visible segment failure");
  const Json stopped = observe.Wait("session.stopped", 5000);
  Expect(stopped["reason"] == "output_failed", "stop reason");
  Expect(observe.Finish(5000, "observe") == 6, "output failure exit code");
  Expect(ReadFileBytes(blocker) == "PRE-EXISTING SEGMENT\n", "existing segment overwritten");
  ValidateStream(observe.Proc().Lines(), "stdout");
}

void CaseOutputFlushFailure() {
  const fs::path policy = WritePolicy("policy", Json::array({{{"pid", GetCurrentProcessId()},
                                                             {"executable", U8((g_paths.bin / L"memmy-history-integration-tests.exe").wstring())}}}));
  Observe observe;
  observe.Start(g_paths.TestHooks(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"60",
                                     L"--output", (g_paths.artifacts / "flush-failure.jsonl").wstring(),
                                     L"--test-flush-failure", L"true"});
  observe.Send("stop");
  const Json error = observe.Wait("error", 5000);
  Expect(error["code"] == "output_flush_failed" && error["fatal"] == true && error["channel"] == "file",
         "flush failure must be fatal and visible");
  const Json stopped = observe.Wait("session.stopped", 5000);
  Expect(stopped["reason"] == "output_failed", "flush failure cannot report clean completion");
  Expect(observe.Finish(5000, "flush-failure") == 6, "flush failure exit code");
  Expect(observe.Proc().Stderr().find("output_flush_failed") != std::string::npos, "flush failure diagnostic");
  ValidateStream(observe.Proc().Lines(), "flush failure");
}

void CaseStdoutBroken() {
  const fs::path output = g_paths.artifacts / L"broken.jsonl";
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--output", output.wstring(),
                                     L"--seconds", L"30", L"--rotate-seconds", L"1"});
  observe.Proc().CloseStdoutReader();
  const auto code = observe.Proc().WaitExit(8000);
  observe.Proc().Save("observe");
  Expect(code.has_value() && *code == 6, "broken stdout exit code");
  std::vector<std::string> lines;
  for (int index = 0;; ++index) {
    wchar_t name[64];
    std::swprintf(name, 64, index == 0 ? L"broken.jsonl" : L"broken.%04d.jsonl", index);
    if (!fs::exists(g_paths.artifacts / name)) break;
    const auto part = SplitLines(ReadFileBytes(g_paths.artifacts / name));
    lines.insert(lines.end(), part.begin(), part.end());
  }
  const auto events = ValidateStream(lines, "file");
  Expect(events[events.size() - 2]["kind"] == "error" && events[events.size() - 2]["channel"] == "stdout",
         "stdout failure recorded in file");
  Expect(events.back()["reason"] == "output_failed", "stop reason in file");
}

void CaseInputHooksLifecycle() {
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--seconds", L"2", L"--input-hooks"});
  Expect(observe.Started()["options"]["inputHooks"] == true, "input hooks enabled");
  const Json stopped = observe.Wait("session.stopped", 8000);
  Expect(stopped["reason"] == "duration_elapsed" && stopped["hooksDetached"] == true, "hooks detached");
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
  const std::string all = observe.Proc().StdoutBytes();
  for (const char* field : {"\"vk\"", "\"scan\"", "\"char\"", "\"x\"", "\"y\""}) {
    Expect(all.find(field) == std::string::npos, std::string("input detail recorded: ") + field);
  }
}

void CaseStopHotkey() {
  Fixture fixture;
  fixture.Start();
  fixture.RequireForeground('a');
  // The fixture is deliberately not authorized: the chord must stop capture
  // without inspecting that application's content, also while native-paused.
  for (const bool paused : {false, true}) {
    Observe observe;
    observe.Start(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--seconds", L"60", L"--input-hooks"});
    observe.Started();
    if (paused) {
      observe.Proc().WriteLine("pause");
      observe.Wait("session.paused", 5000);
    }
    fixture.ExpectForeground('a', "before synthetic stop chord");
    Expect(fixture.Command("input stop-hotkey").value("ok", false), "synthetic hotkey injection");
    const Json stopped = observe.Wait("session.stopped", 5000);
    Expect(stopped["reason"] == "stop_hotkey" && stopped["hooksDetached"] == true, "hotkey detached hooks");
    Expect(observe.Finish(5000, "hotkey") == 0, "hotkey exit code");
    Expect(observe.Proc().StdoutBytes().find("FIXTURE-") == std::string::npos, "unauthorized content absent");
  }
}

void CaseObserveCtrlBreak() {
  // Console control events need a shared console; create a hidden one if the harness has none.
  DWORD consoleProcess = 0;
  if (GetConsoleProcessList(&consoleProcess, 1) == 0) {
    if (!AllocConsole()) Skip("no console available for CTRL_BREAK delivery");
    ShowWindow(GetConsoleWindow(), SW_HIDE);
  }
  SetConsoleCtrlHandler(nullptr, TRUE);  // the harness itself ignores Ctrl+C
  Observe observe;
  observe.Start(g_paths.Recorder(), {L"observe", L"--policy", NeutralPolicy().wstring(), L"--seconds", L"60"},
                Process::Options{true, true});
  Expect(GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, observe.Proc().Pid()) != FALSE, "GenerateConsoleCtrlEvent");
  const Json stopped = observe.Wait("session.stopped", 5000);
  Expect(stopped["reason"] == "console_control" && stopped["hooksDetached"] == true, "console control stop");
  Expect(observe.Finish(5000, "observe") == 0, "exit code");
}

void CaseTaskVideoLifecycle() {
  Fixture fixture; fixture.Start(); fixture.RequireForeground('a');
  Json rule = FullRule(fixture); rule["processStart"] = fixture.ProcessStart();
  const auto policy = WritePolicy("task-video", Json::array({rule}));
  const auto directory = g_paths.artifacts / L"task-video"; fs::create_directory(directory);
  Observe recording;
  recording.Proc().Start(g_paths.Recorder(), {L"record-task", L"--policy", policy.wstring(), L"--output-dir", directory.wstring(),
    L"--seconds", L"20", L"--sample-ms", L"200", L"--input-hooks"});
  const auto started = recording.TryWait("session.started", 12000);
  if (!started) {
    recording.Proc().Save("task-start-failed");
    if (recording.Proc().Stderr().find("task_video_start_failed") != std::string::npos) Skip("Windows Graphics Capture / hardware D3D device unavailable");
    Fail("task recorder failed to acknowledge startup");
  }
  Expect(started->at("protocol") == "memmy.windows.task-recording" && started->contains("task"), "independent task protocol");
  const auto conflict = RunToEnd(g_paths.Recorder(), {L"observe", L"--policy", policy.wstring(), L"--seconds", L"1"}, "task-history-conflict");
  Expect(conflict.exitCode == 4, "task and background history share the native lease");
  for (int i = 0; i < 10; ++i) { fixture.Command("set-message task-before-" + std::to_string(i)); Sleep(200); }
  recording.Send("pause"); recording.Wait("session.paused", 5000); Sleep(400);
  recording.Send("resume"); recording.Wait("session.resumed", 5000);
  for (int i = 0; i < 50; ++i) { fixture.Command("set-message task-after-" + std::to_string(i)); Sleep(200); }
  recording.Send("stop"); recording.Wait("session.stopped", 5000);
  Expect(recording.Finish(5000, "task-recording") == 0, "task capture stopped within bound");
  Expect(RunToEnd(g_paths.Recorder(), {L"finalize-task", L"--output-dir", directory.wstring()}, "task-finalize").exitCode == 0, "task remux");
  const auto media = ParseLine(ReadFileBytes(directory / L"native-media.json"));
  Expect(media.at("complete") == true && media.at("parts").size() >= 2, "sealed video parts and merged media");
  Expect(fs::file_size(directory / L"recording.mp4") > 0, "merged video exists");
  bool pauseGap = false; for (const auto& gap : media.at("gaps")) if (gap.at("reason") == "paused") pauseGap = true;
  Expect(pauseGap, "pause interval is explicit");
  std::size_t captured = 0; double last = -1;
  const auto origin = std::stoull(media.at("qpcOrigin").get<std::string>()), frequency = std::stoull(media.at("qpcFrequency").get<std::string>());
  for (const auto& line : SplitLines(ReadFileBytes(directory / L"frames.jsonl"))) {
    if (line.empty()) continue; const auto frame = ParseLine(line);
    const auto tick = std::stoull(frame.at("qpc").get<std::string>()); const double time = frame.at("timeMs").get<double>();
    Expect(time > last && std::abs(time - static_cast<double>(tick - origin) * 1000.0 / static_cast<double>(frequency)) < 2, "QPC frame alignment"); last = time;
    if (!frame.at("blank").get<bool>()) {
      if (!frame.value("repeated", false)) ++captured;
      Expect(frame.at("window").at("pid") == fixture.Pid(), "authorized window only");
    }
  }
  Expect(captured > 10, "actual window pixels were sampled");
}

void CaseTaskVideoIdle() {
  Fixture fixture; fixture.Start(); fixture.RequireForeground('a');
  Json rule = FullRule(fixture); rule["processStart"] = fixture.ProcessStart(); rule["hwnd"] = fixture.HwndA();
  const auto policy = WritePolicy("task-idle", Json::array({rule}));
  const auto directory = g_paths.artifacts / L"task-video"; fs::create_directory(directory);
  WriteFileBytes(directory / L"recording-options.json", R"({"version":1,"idleTimeoutMs":10000})");
  Observe recording;
  recording.Proc().Start(g_paths.Recorder(), {L"record-task", L"--policy", policy.wstring(), L"--output-dir", directory.wstring(),
    L"--seconds", L"60", L"--sample-ms", L"200", L"--input-hooks"});
  if (!recording.TryWait("session.started", 12000)) {
    recording.Proc().Save("task-start-failed");
    if (recording.Proc().Stderr().find("task_video_start_failed") != std::string::npos) Skip("Windows Graphics Capture / hardware D3D device unavailable");
    Fail("task recorder failed to acknowledge startup");
  }
  const auto waitInForeground = [&](DWORD milliseconds, const std::string& phase) {
    for (DWORD elapsed = 0; elapsed < milliseconds; elapsed += 100) {
      fixture.ExpectForeground('a', phase); Sleep(100);
    }
    fixture.ExpectForeground('a', phase);
  };
  fixture.Command("set-message idle-first");
  // An all-blank recording can become idle without ever capturing the fixture.
  // Establish actual capture before attributing a later failure to idle recovery.
  bool capturedPrefix = false;
  for (unsigned attempt = 0; attempt < 50 && !capturedPrefix; ++attempt) {
    fixture.ExpectForeground('a', "before the first authorized idle-test frame");
    const auto bytes = ReadFileBytes(directory / L"frames.jsonl");
    const auto newline = bytes.find_last_of('\n');
    if (newline != std::string::npos) {
      for (const auto& line : SplitLines(bytes.substr(0, newline + 1))) {
        if (line.empty()) continue;
        const auto frame = ParseLine(line);
        if (!frame.at("blank").get<bool>() && !frame.value("repeated", false)
            && frame.at("window").at("hwnd") == fixture.HwndA()) { capturedPrefix = true; break; }
      }
    }
    if (!capturedPrefix) Sleep(100);
  }
  Expect(capturedPrefix, "idle test requires an actual authorized captured frame before waiting");
  waitInForeground(16000, "during the initial idle wait");
  const auto idle = ParseLine(ReadFileBytes(directory / L"idle-spans.json"));
  Expect(idle.at("activeStartMs").is_number(), "static image automatically suspends encoding after 10 seconds");
  Expect(fs::exists(directory / L"parts/000001.json"), "captured prefix is durably sealed during idle wait");
  const auto before = ReadFileBytes(directory / L"frames.jsonl"); waitInForeground(1000, "during idle file stability check");
  Expect(before == ReadFileBytes(directory / L"frames.jsonl"), "no frames written during idle wait");
  fixture.Command("set-message idle-image-changed"); waitInForeground(2200, "after the idle image changes");
  const auto resumed = ParseLine(ReadFileBytes(directory / L"idle-spans.json"));
  Expect(resumed.at("activeStartMs").is_null() && resumed.at("spans").size() == 1, "image change resumes capture automatically");
  Expect(ReadFileBytes(directory / L"frames.jsonl").size() > before.size(), "changed frame immediately reaches the video index");
  // Ending while idle must omit the final waiting period as well.
  waitInForeground(12500, "during the final idle wait");
  recording.Send("stop"); recording.Wait("session.stopped", 5000);
  Expect(recording.Finish(5000, "task-idle-recording") == 0, "idle capture stops within bound");
  Expect(RunToEnd(g_paths.Recorder(), {L"finalize-task", L"--output-dir", directory.wstring()}, "task-idle-finalize").exitCode == 0, "idle video remux");
  const auto media = ParseLine(ReadFileBytes(directory / L"native-media.json"));
  const auto source = media.at("durationMs").get<double>(), video = media.at("videoDurationMs").get<double>();
  double skipped = 0;
  for (const auto& span : media.at("idleSpans")) skipped += span.at("endMs").get<double>() - span.at("startMs").get<double>();
  Expect(media.at("complete").get<bool>() && media.at("idleSpans").size() == 2, "complete video with two idle intervals");
  Expect(skipped > 8500 && std::abs(source - skipped - video) < 2, "video duration omits waiting without changing source clock");
  double lastSource = -1, lastVideo = -1;
  for (const auto& line : SplitLines(ReadFileBytes(directory / L"frames.jsonl"))) {
    if (line.empty()) continue;
    const auto frame = ParseLine(line);
    const auto time = frame.at("timeMs").get<double>(), presentation = frame.value("videoTimeMs", time);
    Expect(time > lastSource && presentation > lastVideo, "source and presentation clocks remain strictly ordered");
    lastSource = time; lastVideo = presentation;
  }
}
void CaseTaskVideoStaticFrames() {
  Fixture fixture; fixture.Start(); fixture.RequireForeground('a');
  Json rule = FullRule(fixture); rule["processStart"] = fixture.ProcessStart(); rule["hwnd"] = fixture.HwndA();
  const Json allowed = {{"version", 1}, {"applications", Json::array({rule})}};
  const auto policy = WritePolicy("task-static", Json::array({rule}));
  const auto directory = g_paths.artifacts / L"task-video"; fs::create_directory(directory);
  Observe recording;
  recording.Proc().Start(g_paths.Recorder(), {L"record-task", L"--policy", policy.wstring(), L"--output-dir", directory.wstring(),
    L"--seconds", L"30", L"--sample-ms", L"200", L"--input-hooks"});
  if (!recording.TryWait("session.started", 12000)) {
    recording.Proc().Save("task-start-failed");
    if (recording.Proc().Stderr().find("task_video_start_failed") != std::string::npos) Skip("Windows Graphics Capture / hardware D3D device unavailable");
    Fail("task recorder failed to acknowledge startup");
  }
  const auto now = [] {
    LARGE_INTEGER counter{}; QueryPerformanceCounter(&counter); return static_cast<std::uint64_t>(counter.QuadPart);
  };
  Json phases = Json::array();
  const auto hold = [&](const char* name, bool blank, DWORD milliseconds, std::uint64_t freshAfter = 0) {
    // Settle the transition, then leave the window completely still.
    Sleep(600); const auto begin = now(); Sleep(milliseconds);
    phases.push_back({{"name", name}, {"blank", blank}, {"begin", std::to_string(begin)}, {"end", std::to_string(now())},
      {"freshAfter", std::to_string(freshAfter)}});
  };
  for (int i = 0; i < 10; ++i) { fixture.Command("set-message task-static-" + std::to_string(i)); Sleep(100); }
  hold("static", false, 2000); fixture.ExpectForeground('a', "during static recording");
  recording.Send("pause"); recording.Wait("session.paused", 5000); hold("paused", true, 800);
  recording.Send("resume"); recording.Wait("session.resumed", 5000); hold("resumed-static", false, 1500);
  fixture.RequireForeground('b'); hold("unauthorized", true, 800); fixture.ExpectForeground('b', "during unauthorized recording");
  const auto returnedAt = now(); fixture.RequireForeground('a'); hold("returned-static", false, 1500, returnedAt);
  WriteFileBytes(policy, memmy::DumpJson({{"version", 1}, {"applications", Json::array()}})); hold("revoked", true, 800);
  const auto restoredAt = now(); WriteFileBytes(policy, memmy::DumpJson(allowed)); hold("restored-static", false, 1500, restoredAt);
  recording.Send("stop"); recording.Wait("session.stopped", 5000);
  Expect(recording.Finish(5000, "task-static-recording") == 0, "static capture stopped within bound");
  Expect(RunToEnd(g_paths.Recorder(), {L"finalize-task", L"--output-dir", directory.wstring()}, "task-static-finalize").exitCode == 0, "static task remux");
  std::vector<Json> frames;
  for (const auto& line : SplitLines(ReadFileBytes(directory / L"frames.jsonl"))) if (!line.empty()) frames.push_back(ParseLine(line));
  Json summary = Json::array();
  for (const auto& phase : phases) {
    const auto begin = std::stoull(phase.at("begin").get<std::string>()), end = std::stoull(phase.at("end").get<std::string>());
    std::size_t count = 0, blank = 0, repeated = 0;
    for (const auto& frame : frames) {
      const auto tick = std::stoull(frame.at("qpc").get<std::string>()); if (tick < begin || tick > end) continue;
      ++count; if (frame.at("blank").get<bool>()) ++blank; if (frame.value("repeated", false)) ++repeated;
    }
    summary.push_back({{"phase", phase.at("name")}, {"frames", count}, {"blank", blank}, {"repeated", repeated}});
  }
  WriteFileBytes(g_paths.artifacts / L"static-frame-summary.json", memmy::DumpJson(summary));
  for (std::size_t i = 0; i < phases.size(); ++i) {
    const auto& phase = phases[i]; const auto& counts = summary[i]; const auto name = phase.at("name").get<std::string>();
    const auto count = counts.at("frames").get<std::size_t>(), blank = counts.at("blank").get<std::size_t>();
    Expect(count >= 5, name + ": enough video samples");
    if (phase.at("blank").get<bool>()) { Expect(blank == count, name + ": no cached pixels outside recording consent"); continue; }
    Expect(blank <= count / 10, name + ": static authorized window keeps its visible image instead of black frames");
    Expect(counts.at("repeated").get<std::size_t>() > 0, name + ": display repeats retain their provenance");
    const auto begin = std::stoull(phase.at("begin").get<std::string>()), end = std::stoull(phase.at("end").get<std::string>());
    const auto freshAfter = std::stoull(phase.at("freshAfter").get<std::string>());
    for (const auto& frame : frames) {
      const auto tick = std::stoull(frame.at("qpc").get<std::string>());
      if (tick < begin || tick > end || frame.at("blank").get<bool>()) continue;
      const auto source = std::stoull(frame.at("sourceTicks").get<std::string>());
      Expect(source <= tick && source >= freshAfter, name + ": source belongs to the current authorized interval");
      Expect(frame.at("window").at("hwnd") == fixture.HwndA(), name + ": only the selected window is visible");
    }
  }
}

const std::map<std::string, std::function<void()>>& Cases() {
  static const std::map<std::string, std::function<void()>> cases = {
      {"cli_contract", CaseCliContract},
      {"policy_strict", CasePolicyStrict},
      {"identity_mismatch", CaseIdentityMismatch},
      {"browser_unsupported", CaseBrowserUnsupported},
      {"snapshot_content", CaseSnapshotContent},
      {"snapshot_not_foreground", CaseSnapshotNotForeground},
      {"race_aba", CaseRaceAba},
      {"race_policy", CaseRacePolicy},
      {"commit_races", CaseCommitRaces},
      {"commit_pause", CaseCommitPause},
      {"commit_control_flood", CaseCommitControlFlood},
      {"partial_baseline", CasePartialBaseline},
      {"timeout_reap", CaseTimeoutReap},
      {"observe_lifecycle", CaseObserveLifecycle},
      {"observe_checkpoint", CaseObserveCheckpoint},
      {"observe_checkpoint_origin", CaseObserveCheckpointOrigin},
      {"observe_unauthorized_foreground", CaseObserveUnauthorizedForeground},
      {"observe_policy_corrupt", CaseObservePolicyCorrupt},
      {"observe_policy_race", CaseObservePolicyRace},
      {"observe_ui_hang_recovery", CaseObserveUiHangRecovery},
      {"observe_eof", CaseObserveEof},
      {"observe_parent_exit", CaseObserveParentExit},
      {"observe_parent_kill", CaseObserveParentKill},
      {"observe_collector_kill_reaps_worker", CaseObserveCollectorKillReapsWorker},
      {"observe_ctrl_break", CaseObserveCtrlBreak},
      {"single_instance", CaseSingleInstance},
      {"rotation_unicode_path", CaseRotationUnicodePath},
      {"output_exists", CaseOutputExists},
      {"output_segment_failure", CaseOutputSegmentFailure},
      {"output_flush_failure", CaseOutputFlushFailure},
      {"stdout_broken", CaseStdoutBroken},
      {"input_hooks_lifecycle", CaseInputHooksLifecycle},
      {"stop_hotkey", CaseStopHotkey},
      {"task_video_lifecycle", CaseTaskVideoLifecycle},
      {"task_video_static_frames", CaseTaskVideoStaticFrames},
      {"task_video_idle", CaseTaskVideoIdle},
  };
  return cases;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  std::string caseName;
  fs::path bin, artifacts;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::wstring key = argv[i];
    if (key == L"--case") caseName = U8(argv[i + 1]);
    if (key == L"--bin-dir") bin = argv[i + 1];
    if (key == L"--artifacts") artifacts = argv[i + 1];
  }
  if (caseName == "list") {
    for (const auto& [name, body] : Cases()) std::printf("%s\n", name.c_str());
    return 0;
  }
  const auto it = Cases().find(caseName);
  if (it == Cases().end() || bin.empty() || artifacts.empty()) {
    std::fprintf(stderr, "usage: --case NAME --bin-dir DIR --artifacts DIR\n");
    return 2;
  }
  SYSTEMTIME now{};
  GetSystemTime(&now);
  wchar_t stamp[64];
  std::swprintf(stamp, 64, L"%04d%02d%02dT%02d%02d%02dZ-%lu", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute,
                now.wSecond, GetCurrentProcessId());
  g_paths.bin = bin;
  g_paths.artifacts = artifacts / W(caseName) / stamp;
  fs::create_directories(g_paths.artifacts);

  g_job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  std::printf("CASE %s (artifacts: %s)\n", caseName.c_str(), U8(g_paths.artifacts.wstring()).c_str());
  int code = 0;
  try {
    // Foreground cases need an unlocked interactive desktop.
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    const bool interactive = desktop != nullptr;
    if (desktop) CloseDesktop(desktop);
    if (!interactive) Skip("input desktop unavailable (locked or non-interactive session)");
    it->second();
    std::printf("PASS %s\n", caseName.c_str());
  } catch (const TestSkip& skip) {
    std::printf("SKIP %s: %s\n", caseName.c_str(), skip.message.c_str());
    code = 77;
  } catch (const TestFailure& failure) {
    std::printf("FAIL %s: %s\n", caseName.c_str(), failure.message.c_str());
    code = 1;
  } catch (const std::exception& error) {
    std::printf("FAIL %s: exception %s\n", caseName.c_str(), error.what());
    code = 1;
  }
  WriteFileBytes(g_paths.artifacts / "result.txt", code == 0 ? "PASS\n" : code == 77 ? "SKIP\n" : "FAIL\n");
  std::fflush(stdout);
  return code;
}
