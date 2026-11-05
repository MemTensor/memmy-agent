#pragma once

#include "win/raii.h"

#include <memory>
#include <optional>
#include <thread>
#include <vector>

namespace memmy::win {

enum class ControlItem { Pause, Resume, Stop, Eof, Overflow, Unknown, Overlong };

// Reads observe control lines from stdin on a dedicated thread. The thread's state is shared,
// so if a blocking read cannot be cancelled at shutdown the thread is detached safely and
// process exit is never held up by stdin.
class ControlInput {
 public:
  ControlInput();
  ~ControlInput();
  ControlInput(const ControlInput&) = delete;
  ControlInput& operator=(const ControlInput&) = delete;

  bool Start();
  // Manual-reset event, signalled while commands are pending.
  HANDLE Event() const;
  // Terminal controls have sticky priority; otherwise returns pending items in arrival order.
  std::vector<ControlItem> Drain();
  void Shutdown(DWORD timeoutMs);
#if MEMMY_HISTORY_TEST_HOOKS
  bool TestWaitReader(DWORD timeoutMs);
  std::optional<ControlItem> TestTerminal();
#endif

 private:
  struct State;
  std::shared_ptr<State> state_;
  std::thread thread_;
};

}  // namespace memmy::win
