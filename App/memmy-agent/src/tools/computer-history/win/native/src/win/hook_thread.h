#pragma once

#include "common/trigger_queue.h"
#include "win/raii.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <thread>

namespace memmy::win {

struct HookCounters {
  std::uint64_t ignoredBackground = 0;
  std::uint64_t ignoredPaused = 0;
  std::uint64_t callbacks = 0;
  double callbackMaxMs = 0;
};

// Owns a dedicated Win32 message-loop thread with SetWinEventHook (out-of-context) and the
// optional WH_KEYBOARD_LL / WH_MOUSE_LL hooks. Callbacks only bump the foreground/focus generation,
// push bounded metadata into the trigger queue and signal an event: no UIA, JSON, file I/O or
// waits. Key codes, characters and pointer coordinates are never retained.
class HookThread {
 public:
  explicit HookThread(std::size_t queueCapacity, bool taskInput = false);
  ~HookThread();
  HookThread(const HookThread&) = delete;
  HookThread& operator=(const HookThread&) = delete;

  // foregroundOnly omits content-change triggers, but always watches foreground and focus.
  bool Start(bool foregroundOnly, bool inputHooks);
  // Unhooks and joins within timeoutMs. Returns false if the thread did not stop in time.
  bool Stop(DWORD timeoutMs);

  std::uint64_t Generation() const;
  std::uint64_t GenerationQpc() const;
  void BumpGeneration();
  void SetPaused(bool paused);
  bool StopRequested() const;

  // Round-trips a message through the hook thread so WinEvents already queued for it have been
  // dispatched before the caller compares generations. Fails closed on timeout.
  bool Barrier(DWORD timeoutMs);
  // Inserts a numbered marker from the hook message loop into the observation FIFO.
  bool RequestCheckpoint(const std::string& id);

  HANDLE QueueEvent() const;
  TriggerQueue& Queue();
  const TriggerQueue& Queue() const;
  HookCounters Counters() const;
#if MEMMY_HISTORY_TEST_HOOKS
  void TestDelayExit(DWORD milliseconds);
  UniqueHandle TestThreadHandle();
#endif

 private:
  static void CALLBACK OnWinEvent(HWINEVENTHOOK hook, DWORD event, HWND hwnd, LONG idObject, LONG idChild,
                                  DWORD thread, DWORD time);
  static LRESULT CALLBACK OnKeyboard(int code, WPARAM wParam, LPARAM lParam);
  static LRESULT CALLBACK OnMouse(int code, WPARAM wParam, LPARAM lParam);
  struct State;
  static void Run(std::shared_ptr<State> state, bool foregroundOnly, bool inputHooks);
  static std::atomic<State*> active_;
  static thread_local State* callbackState_;
  std::shared_ptr<State> state_;
  std::thread thread_;
};

}  // namespace memmy::win
