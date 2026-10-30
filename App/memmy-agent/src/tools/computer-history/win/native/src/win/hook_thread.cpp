#include "win/hook_thread.h"

#include "win/identity.h"

#include <vector>
#include <cstdlib>

namespace memmy::win {
namespace {

constexpr UINT kBarrierMessage = WM_APP + 1;


LARGE_INTEGER Now() {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return value;
}

}  // namespace

struct HookThread::State {
  explicit State(std::size_t capacity, bool taskInput)
      : taskInput_(taskInput), queue_(capacity), queueEvent_(Own(CreateEventW(nullptr, FALSE, FALSE, nullptr))),
        readyEvent_(Own(CreateEventW(nullptr, TRUE, FALSE, nullptr))) {}
  std::uint64_t Generation() const { return generation_.load(std::memory_order_acquire); }
  void BumpGeneration() { generationQpc_.store(static_cast<std::uint64_t>(Now().QuadPart), std::memory_order_release); generation_.fetch_add(1, std::memory_order_acq_rel); }
  void Push(TriggerKind kind, HWND hwnd, const InputAction& action = {});
  void RecordCallback(LARGE_INTEGER started);
  const bool taskInput_;
  POINT pointerDown_{};
  std::uint8_t downButton_ = 0;
  bool dragged_ = false;
  TriggerQueue queue_;
  UniqueHandle queueEvent_, readyEvent_;
  std::atomic<DWORD> threadId_{0};
  std::atomic<bool> installed_{false}, enabled_{true}, paused_{false};
  std::atomic<bool> stopRequested_{false};
  std::atomic<std::uint64_t> generation_{1}, ignoredBackground_{0}, ignoredPaused_{0}, callbacks_{0},
      callbackMaxTicks_{0};
  std::atomic<std::uint64_t> generationQpc_{0};
#if MEMMY_HISTORY_TEST_HOOKS
  std::atomic<DWORD> exitDelay_{0};
#endif
};

std::atomic<HookThread::State*> HookThread::active_{nullptr};
thread_local HookThread::State* HookThread::callbackState_ = nullptr;

HookThread::HookThread(std::size_t queueCapacity, bool taskInput) : state_(std::make_shared<State>(queueCapacity, taskInput)) {}
std::uint64_t HookThread::Generation() const { return state_->Generation(); }
std::uint64_t HookThread::GenerationQpc() const { return state_->generationQpc_.load(std::memory_order_acquire); }
void HookThread::BumpGeneration() { state_->BumpGeneration(); }
void HookThread::SetPaused(bool paused) { state_->paused_.store(paused, std::memory_order_release); }
bool HookThread::StopRequested() const { return state_->stopRequested_.load(std::memory_order_acquire); }
HANDLE HookThread::QueueEvent() const { return state_->queueEvent_.get(); }
TriggerQueue& HookThread::Queue() { return state_->queue_; }
const TriggerQueue& HookThread::Queue() const { return state_->queue_; }
#if MEMMY_HISTORY_TEST_HOOKS
void HookThread::TestDelayExit(DWORD milliseconds) { state_->exitDelay_.store(milliseconds); }
UniqueHandle HookThread::TestThreadHandle() {
  HANDLE copy = nullptr;
  if (thread_.joinable()) DuplicateHandle(GetCurrentProcess(), static_cast<HANDLE>(thread_.native_handle()),
                                         GetCurrentProcess(), &copy, SYNCHRONIZE, FALSE, 0);
  return Own(copy);
}
#endif
HookThread::~HookThread() { Stop(2000); }

bool HookThread::Start(bool foregroundOnly, bool inputHooks) {
  if (!state_->queueEvent_ || !state_->readyEvent_) return false;
  State* expected = nullptr;
  // Win32 hook callbacks carry no user pointer, so one active instance per process.
  if (!active_.compare_exchange_strong(expected, state_.get())) return false;
  thread_ = std::thread([state = state_, foregroundOnly, inputHooks] { Run(std::move(state), foregroundOnly, inputHooks); });
  if (WaitForSingleObject(state_->readyEvent_.get(), 5000) != WAIT_OBJECT_0 || !state_->installed_.load()) {
    Stop(2000);
    return false;
  }
  return true;
}

bool HookThread::Stop(DWORD timeoutMs) {
  state_->enabled_.store(false, std::memory_order_release);
  bool stopped = true;
  if (thread_.joinable()) {
    const DWORD id = state_->threadId_.load();
    if (id != 0) PostThreadMessageW(id, WM_QUIT, 0, 0);
    const HANDLE native = static_cast<HANDLE>(thread_.native_handle());
    if (WaitForSingleObject(native, timeoutMs) != WAIT_OBJECT_0) {
      // Callbacks are disabled; Run owns shared state, so a delayed thread cannot access
      // a destroyed HookThread. OS process exit remains the final cleanup bound.
      thread_.detach();
      stopped = false;
    } else {
      thread_.join();
    }
  }
  State* self = state_.get();
  active_.compare_exchange_strong(self, nullptr);
  return stopped;
}

bool HookThread::Barrier(DWORD timeoutMs) {
  const DWORD id = state_->threadId_.load();
  if (id == 0) return false;
  UniqueHandle done = Own(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!done) return false;
  // The duplicate keeps the event alive even if this call times out before the thread runs.
  HANDLE copy = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), done.get(), GetCurrentProcess(), &copy, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) {
    return false;
  }
  if (!PostThreadMessageW(id, kBarrierMessage, 0, reinterpret_cast<LPARAM>(copy))) {
    CloseHandle(copy);
    return false;
  }
  return WaitForSingleObject(done.get(), timeoutMs) == WAIT_OBJECT_0;
}

HookCounters HookThread::Counters() const {
  HookCounters counters;
  counters.ignoredBackground = state_->ignoredBackground_.load();
  counters.ignoredPaused = state_->ignoredPaused_.load();
  counters.callbacks = state_->callbacks_.load();
  LARGE_INTEGER frequency{};
  QueryPerformanceFrequency(&frequency);
  counters.callbackMaxMs =
      static_cast<double>(state_->callbackMaxTicks_.load()) * 1000.0 / static_cast<double>(frequency.QuadPart);
  return counters;
}

void HookThread::State::RecordCallback(LARGE_INTEGER started) {
  const auto elapsed = static_cast<std::uint64_t>(Now().QuadPart - started.QuadPart);
  callbacks_.fetch_add(1, std::memory_order_relaxed);
  auto previous = callbackMaxTicks_.load(std::memory_order_relaxed);
  while (elapsed > previous && !callbackMaxTicks_.compare_exchange_weak(previous, elapsed)) {
  }
}

void HookThread::State::Push(TriggerKind kind, HWND hwnd, const InputAction& action) {
  if (paused_.load(std::memory_order_acquire)) {
    ignoredPaused_.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  Trigger trigger;
  trigger.kind = kind;
  trigger.hwnd = FromHwnd(hwnd);
  trigger.generation = Generation();
  trigger.tickMs = GetTickCount64();
  trigger.action = action;
  if (action.kind != ActionKind::None) {
    FILETIME now{};
    GetSystemTimeAsFileTime(&now);
    trigger.action.timestamp = (static_cast<std::uint64_t>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
    trigger.action.qpc = static_cast<std::uint64_t>(Now().QuadPart);
  }
  queue_.Push(trigger);
  SetEvent(queueEvent_.get());
}

void CALLBACK HookThread::OnWinEvent(HWINEVENTHOOK, DWORD event, HWND hwnd, LONG, LONG, DWORD, DWORD) {
  State* self = callbackState_;
  if (self == nullptr || !self->enabled_.load(std::memory_order_acquire)) return;
  const LARGE_INTEGER started = Now();
  switch (event) {
    case EVENT_SYSTEM_FOREGROUND:
    case EVENT_SYSTEM_MINIMIZESTART:
    case EVENT_SYSTEM_MINIMIZEEND:
    case EVENT_SYSTEM_DESKTOPSWITCH:
      self->BumpGeneration();
      self->Push(TriggerKind::Foreground, GetForegroundWindow());
      break;
    default: {
      if (hwnd == nullptr) break;
      const HWND root = GetAncestor(hwnd, GA_ROOT);
      if (root == nullptr || root != GetForegroundWindow()) {
        self->ignoredBackground_.fetch_add(1, std::memory_order_relaxed);
        break;
      }
      const TriggerKind kind = event == EVENT_OBJECT_FOCUS         ? TriggerKind::Focus
                               : event == EVENT_OBJECT_NAMECHANGE  ? TriggerKind::NameChange
                               : event == EVENT_OBJECT_VALUECHANGE ? TriggerKind::ValueChange
                                                                   : TriggerKind::Show;
      if (event == EVENT_OBJECT_FOCUS) self->BumpGeneration();
      self->Push(kind, root);
      break;
    }
  }
  self->RecordCallback(started);
}

LRESULT CALLBACK HookThread::OnKeyboard(int code, WPARAM wParam, LPARAM lParam) {
  State* self = callbackState_;
  if (self != nullptr && self->enabled_.load(std::memory_order_acquire) && code == HC_ACTION && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
    const LARGE_INTEGER started = Now();
    const auto* data = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
    std::uint8_t modifiers = 0;
    if (GetAsyncKeyState(VK_CONTROL) & 0x8000) modifiers |= 1;
    if (GetAsyncKeyState(VK_MENU) & 0x8000) modifiers |= 2;
    if (GetAsyncKeyState(VK_SHIFT) & 0x8000) modifiers |= 4;
    if ((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) modifiers |= 8;
    // The stop chord is session control, including while paused or outside the
    // allowlist. Retain no key identity and never enqueue it as captured input.
    if (data->vkCode == 'R' && modifiers == 7) {
      self->BumpGeneration();
      self->stopRequested_.store(true, std::memory_order_release);
      SetEvent(self->queueEvent_.get());
    } else {
      const auto action = ClassifyKeyboard(data->vkCode, modifiers, (data->flags & LLKHF_INJECTED) != 0);
      if (action.kind != ActionKind::None) self->Push(TriggerKind::Input, GetForegroundWindow(), action);
    }
    self->RecordCallback(started);
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

LRESULT CALLBACK HookThread::OnMouse(int code, WPARAM wParam, LPARAM lParam) {
  State* self = callbackState_;
  if (self != nullptr && self->enabled_.load(std::memory_order_acquire) && code == HC_ACTION &&
      (wParam == WM_LBUTTONUP || wParam == WM_RBUTTONUP || wParam == WM_MOUSEWHEEL || wParam == WM_MOUSEHWHEEL
        || (self->taskInput_ && (wParam == WM_LBUTTONDOWN || wParam == WM_RBUTTONDOWN || wParam == WM_MOUSEMOVE)))) {
    const LARGE_INTEGER started = Now();
    const auto* data = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
    if (self->taskInput_) {
      if (wParam == WM_LBUTTONDOWN || wParam == WM_RBUTTONDOWN) {
        self->pointerDown_ = data->pt; self->downButton_ = wParam == WM_LBUTTONDOWN ? 1 : 2; self->dragged_ = false;
        return CallNextHookEx(nullptr, code, wParam, lParam);
      }
      if (wParam == WM_MOUSEMOVE) {
        if (self->downButton_ && (std::abs(data->pt.x - self->pointerDown_.x) > 4 || std::abs(data->pt.y - self->pointerDown_.y) > 4)) self->dragged_ = true;
        return CallNextHookEx(nullptr, code, wParam, lParam);
      }
    }
    InputAction action;
    action.kind = (wParam == WM_MOUSEWHEEL || wParam == WM_MOUSEHWHEEL) ? ActionKind::Scroll : ActionKind::MouseClick;
    action.button = wParam == WM_RBUTTONUP ? 2 : 1;
    if (self->taskInput_ && action.kind == ActionKind::MouseClick) {
      if (self->dragged_ || self->downButton_ != action.button) action.kind = ActionKind::Unsupported;
      self->downButton_ = 0; self->dragged_ = false;
    }
    action.x = data->pt.x; action.y = data->pt.y;
    action.wheel = static_cast<short>(HIWORD(data->mouseData));
    action.horizontal = wParam == WM_MOUSEHWHEEL;
    action.injected = (data->flags & LLMHF_INJECTED) != 0;
    const HWND foreground = GetForegroundWindow();
    const HWND underPointer = GetAncestor(WindowFromPoint(data->pt), GA_ROOT);
    if (underPointer == foreground) self->Push(TriggerKind::Pointer, foreground, action);
    self->RecordCallback(started);
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

void HookThread::Run(std::shared_ptr<State> state, bool foregroundOnly, bool inputHooks) {
  callbackState_ = state.get();
  HHOOK keyboardHook_ = nullptr, mouseHook_ = nullptr;
  MSG message{};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);  // create the message queue
  state->threadId_.store(GetCurrentThreadId());

  const DWORD flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
  std::vector<HWINEVENTHOOK> hooks;
  bool ok = true;
  const auto add = [&](DWORD event) {
    HWINEVENTHOOK hook = SetWinEventHook(event, event, nullptr, &HookThread::OnWinEvent, 0, 0, flags);
    if (hook == nullptr) ok = false;
    else hooks.push_back(hook);
  };
  add(EVENT_SYSTEM_FOREGROUND);
  add(EVENT_SYSTEM_MINIMIZESTART);
  add(EVENT_SYSTEM_MINIMIZEEND);
  add(EVENT_SYSTEM_DESKTOPSWITCH);
  add(EVENT_OBJECT_FOCUS);
  if (!foregroundOnly) {
    add(EVENT_OBJECT_NAMECHANGE);
    add(EVENT_OBJECT_VALUECHANGE);
    add(EVENT_OBJECT_SHOW);
  }
  if (ok && inputHooks) {
    const HINSTANCE module = GetModuleHandleW(nullptr);
    keyboardHook_ = SetWindowsHookExW(WH_KEYBOARD_LL, &HookThread::OnKeyboard, module, 0);
    mouseHook_ = SetWindowsHookExW(WH_MOUSE_LL, &HookThread::OnMouse, module, 0);
    ok = keyboardHook_ != nullptr && mouseHook_ != nullptr;
  }
  state->installed_.store(ok);
  SetEvent(state->readyEvent_.get());

  if (ok) {
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      if (message.hwnd == nullptr && message.message == kBarrierMessage) {
        const HANDLE done = reinterpret_cast<HANDLE>(message.lParam);
        SetEvent(done);
        CloseHandle(done);
        continue;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
#if MEMMY_HISTORY_TEST_HOOKS
  Sleep(state->exitDelay_.load());
#endif
  for (HWINEVENTHOOK hook : hooks) UnhookWinEvent(hook);
  if (keyboardHook_) UnhookWindowsHookEx(keyboardHook_);
  if (mouseHook_) UnhookWindowsHookEx(mouseHook_);
  keyboardHook_ = nullptr;
  mouseHook_ = nullptr;
  // Drain barrier handles posted after WM_QUIT so their duplicates are not leaked.
  while (PeekMessageW(&message, nullptr, kBarrierMessage, kBarrierMessage, PM_REMOVE)) {
    CloseHandle(reinterpret_cast<HANDLE>(message.lParam));
  }
  state->threadId_.store(0);
  callbackState_ = nullptr;
}

}  // namespace memmy::win
