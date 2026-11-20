#include "win/control_input.h"
#include "win/event_output.h"
#include "win/hook_thread.h"
#include "win/system.h"

#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>

using namespace memmy::win;

void Check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void ControlFlood(bool explicitStop) {
  HANDLE rawRead = nullptr, rawWrite = nullptr;
  Check(CreatePipe(&rawRead, &rawWrite, nullptr, 0) != FALSE, "control pipe");
  UniqueHandle read = Own(rawRead), write = Own(rawWrite);
  const HANDLE original = GetStdHandle(STD_INPUT_HANDLE);
  Check(SetStdHandle(STD_INPUT_HANDLE, read.get()) != FALSE, "redirect stdin");
  ControlInput control;
  Check(control.Start(), "start control reader");
  std::string commands;
  for (int i = 0; i < 4096; ++i) commands += "unknown\n";
  if (explicitStop) commands += "stop\n";
  DWORD written = 0;
  Check(WriteFile(write.get(), commands.data(), static_cast<DWORD>(commands.size()), &written, nullptr) &&
            written == commands.size(), "write control flood");
  write.reset();
  // Wait for the reader to process the whole pipe, without ever draining the bounded queue.
  Check(control.TestWaitReader(2000), "reader reached EOF after flood");
  control.Shutdown(2000);
  const auto items = control.Drain();
  Check(items.size() == 1 && items[0] == (explicitStop ? ControlItem::Stop : ControlItem::Eof),
        "terminal control survived full queue");
  SetStdHandle(STD_INPUT_HANDLE, original);
}

void PrivacyControlOverflow() {
  HANDLE rawRead = nullptr, rawWrite = nullptr;
  Check(CreatePipe(&rawRead, &rawWrite, nullptr, 0) != FALSE, "overflow control pipe");
  UniqueHandle read = Own(rawRead), write = Own(rawWrite);
  const HANDLE original = GetStdHandle(STD_INPUT_HANDLE);
  Check(SetStdHandle(STD_INPUT_HANDLE, read.get()) != FALSE, "overflow stdin");
  ControlInput control;
  Check(control.Start(), "overflow reader");
  std::string commands;
  for (int i = 0; i < 4096; ++i) commands += "pause\n";
  DWORD written = 0;
  Check(WriteFile(write.get(), commands.data(), static_cast<DWORD>(commands.size()), &written, nullptr) &&
            written == commands.size(), "privacy control flood");
  const auto deadline = TickMs() + 2000;
  while (!control.TestTerminal() && TickMs() < deadline) Sleep(1);
  Check(control.TestTerminal() == ControlItem::Overflow, "privacy command overflow fails closed");
  const auto items = control.Drain();
  Check(items.size() == 1 && items[0] == ControlItem::Overflow, "overflow outranks queued commands");
  write.reset();
  Check(control.TestWaitReader(2000), "overflow reader cleanup");
  control.Shutdown(2000);
  SetStdHandle(STD_INPUT_HANDLE, original);
}

int main() {
  try {
    ControlFlood(false);
    ControlFlood(true);
    PrivacyControlOverflow();
    UniqueHandle delayedThread;
    {
      HookThread hooks(4);
      Check(hooks.Start(true, false), "start hooks");
      hooks.TestDelayExit(300);
      delayedThread = hooks.TestThreadHandle();
      Check(static_cast<bool>(delayedThread), "retain thread handle");
      Check(!hooks.Stop(0), "exercise timed-out detach");
    }  // owner is destroyed while the thread still owns shared state
    Check(WaitForSingleObject(delayedThread.get(), 2000) == WAIT_OBJECT_0, "delayed hook cleanup completed");
    wchar_t temp[MAX_PATH];
    Check(GetTempPathW(MAX_PATH, temp) != 0, "temp path");
    const std::wstring prefix = std::wstring(temp) + L"memmy-native-flush-" +
                                std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(TickMs());
    const std::wstring policyPath = prefix + L"-policy.json";
    {
      UniqueHandle file = Own(CreateFileW(policyPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                          FILE_ATTRIBUTE_NORMAL, nullptr));
      Check(static_cast<bool>(file), "create policy lease fixture");
    }
    {
      const PolicyFile revision = ReadPolicyFile(policyPath, true);
      Check(revision.ok && revision.revisionLease, "retain policy revision lease");
      UniqueHandle writer = Own(CreateFileW(policyPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      Check(!writer && GetLastError() == ERROR_SHARING_VIOLATION, "lease blocks policy write during emission");
      Check(!DeleteFileW(policyPath.c_str()) && GetLastError() == ERROR_SHARING_VIOLATION,
            "lease blocks policy replacement during emission");
    }
    {
      UniqueHandle writer = Own(CreateFileW(policyPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      Check(static_cast<bool>(writer), "policy becomes writable after emission lease ends");
    }
    for (bool rotate : {false, true}) {
      EventOutput output;
      std::string error;
      Check(output.Open(prefix + (rotate ? L"-rotate.jsonl" : L"-close.jsonl"), 1000, 0, error), "open output");
      output.TestFailFlush();
      const bool ok = rotate ? output.Rotate(1001, error) : output.Close(error);
      Check(!ok && error == "output_flush_failed" && !output.FileHealthy(), "flush failure is observable");
    }
    std::puts("PASS win boundaries: full control queue + EOF/stop, delayed hook destruction, policy revision lease, flush failures");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "FAIL: %s\n", error.what());
    return 1;
  }
}
