#include "win/control_input.h"

#include "common/cli.h"

#include <atomic>
#include <deque>
#include <mutex>
#include <optional>
#include <string>

namespace memmy::win {

struct ControlInput::State {
  UniqueHandle event = Own(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  std::mutex mutex;
  std::deque<ControlItem> items;
  std::optional<ControlItem> terminal;
  std::atomic<bool> stopping{false};

  void Push(ControlItem item) {
    {
      std::lock_guard lock(mutex);
      if (item == ControlItem::Stop || item == ControlItem::Eof) {
        // Terminal commands never compete with the bounded ordinary-command queue.
        if (!terminal || *terminal == ControlItem::Overflow) terminal = item;
      } else if (!terminal && items.size() < 1024) {
        items.push_back(item);
      } else if (!terminal && (item == ControlItem::Pause || item == ControlItem::Resume)) {
        // Never silently lose a privacy control. Exhaustion ends the session fail-closed.
        terminal = ControlItem::Overflow;
      }
    }
    SetEvent(event.get());
  }
};

ControlInput::ControlInput() : state_(std::make_shared<State>()) {}

ControlInput::~ControlInput() { Shutdown(500); }

bool ControlInput::Start() {
  if (!state_->event) return false;
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  thread_ = std::thread([state = state_, input] {
    if (input == nullptr || input == INVALID_HANDLE_VALUE) {
      state->Push(ControlItem::Eof);
      return;
    }
    cli::LineSplitter splitter(256);
    char buffer[512];
    std::vector<std::string> lines;
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(input, buffer, sizeof(buffer), &read, nullptr) || read == 0) break;
      const std::size_t overlongBefore = splitter.Overlong();
      lines.clear();
      splitter.Feed(buffer, read, lines);
      for (std::size_t i = overlongBefore; i < splitter.Overlong(); ++i) state->Push(ControlItem::Overlong);
      for (const auto& line : lines) {
        if (line.empty()) continue;
        switch (cli::ParseControlCommand(line)) {
          case cli::ControlCommand::Pause: state->Push(ControlItem::Pause); break;
          case cli::ControlCommand::Resume: state->Push(ControlItem::Resume); break;
          case cli::ControlCommand::Stop: state->Push(ControlItem::Stop); break;
          case cli::ControlCommand::Unknown: state->Push(ControlItem::Unknown); break;
        }
      }
      if (state->stopping.load()) return;
    }
    // EOF, broken pipe or cancelled read: the parent can no longer control us.
    state->Push(ControlItem::Eof);
  });
  return true;
}

HANDLE ControlInput::Event() const { return state_->event.get(); }

std::vector<ControlItem> ControlInput::Drain() {
  std::lock_guard lock(state_->mutex);
  ResetEvent(state_->event.get());
  if (state_->terminal) {
    state_->items.clear();
    return {*state_->terminal};
  }
  std::vector<ControlItem> out(state_->items.begin(), state_->items.end());
  state_->items.clear();
  return out;
}

void ControlInput::Shutdown(DWORD timeoutMs) {
  if (!thread_.joinable()) return;
  state_->stopping.store(true);
  const HANDLE native = static_cast<HANDLE>(thread_.native_handle());
  if (WaitForSingleObject(native, 0) != WAIT_OBJECT_0) {
    CancelSynchronousIo(native);
  }
  if (WaitForSingleObject(native, timeoutMs) == WAIT_OBJECT_0) {
    thread_.join();
  } else {
    // A console read may not be cancellable; the thread holds only shared state.
    thread_.detach();
  }
}

#if MEMMY_HISTORY_TEST_HOOKS
bool ControlInput::TestWaitReader(DWORD timeoutMs) {
  return thread_.joinable() &&
         WaitForSingleObject(static_cast<HANDLE>(thread_.native_handle()), timeoutMs) == WAIT_OBJECT_0;
}
std::optional<ControlItem> ControlInput::TestTerminal() {
  std::lock_guard lock(state_->mutex);
  return state_->terminal;
}
#endif

}  // namespace memmy::win
