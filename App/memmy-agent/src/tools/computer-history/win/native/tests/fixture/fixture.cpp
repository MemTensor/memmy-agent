// Controlled Win32 fixture for the recorder integration tests.
//
// Window A exposes known static text, an updatable message, a search edit, an ordinary edit
// with a child static, a password edit with a child static, a read-only RichEdit document and a
// container whose AutomationId the tests mark sensitive (with a child static). Window B holds a
// separate static. All sentinel strings embed a per-run nonce. A custom window class with an
// EDIT prefix and ES_PASSWORD deliberately exposes a non-password Pane through the system proxy.
//
// Commands arrive as lines on stdin and each produces one JSON line on stdout. stdin EOF exits.
// --idle runs without windows (used as a stand-in parent process).

#include <nlohmann/json.hpp>

#include <windows.h>
#include <richedit.h>

#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

namespace {

using Json = nlohmann::ordered_json;

constexpr UINT kCommandMessage = WM_APP + 7;
constexpr int kStatic = 1001, kMessage = 1002, kSearch = 1003, kEdit = 1004, kPassword = 1005, kDocument = 1006,
              kPanel = 1007, kButton = 1008, kEditChild = 1104, kPasswordChild = 1105, kPanelChild = 1107,
              kMisreportedPassword = 1009, kMisreportedChild = 1109, kSecondStatic = 2001;

HWND g_windowA = nullptr;
HWND g_windowB = nullptr;
std::wstring g_nonce;
std::mutex g_outputMutex;

std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::wstring Wide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring out(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size);
  return out;
}

void Reply(Json json) {
  const std::string line = json.dump() + "\n";
  std::lock_guard lock(g_outputMutex);
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
}

std::string Hwnd(HWND hwnd) { return std::to_string(reinterpret_cast<std::uintptr_t>(hwnd)); }

Json Identity() {
  wchar_t path[MAX_PATH * 4] = {};
  DWORD size = static_cast<DWORD>(std::size(path));
  QueryFullProcessImageNameW(GetCurrentProcess(), 0, path, &size);
  FILETIME creation{}, exit{}, kernel{}, user{};
  GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user);
  const unsigned long long start = (static_cast<unsigned long long>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  Json json;
  json["ok"] = true;
  json["pid"] = GetCurrentProcessId();
  json["exe"] = Utf8(path);
  json["processStart"] = std::to_string(start);
  json["hwndA"] = Hwnd(g_windowA);
  json["hwndB"] = Hwnd(g_windowB);
  json["foreground"] = Hwnd(GetForegroundWindow());
  return json;
}

std::wstring Sentinel(const wchar_t* kind) { return std::wstring(L"FIXTURE-") + kind + L"-" + g_nonce; }

HWND Child(HWND parent, const wchar_t* cls, const std::wstring& text, DWORD style, int id, int x, int y, int w, int h) {
  return CreateWindowExW(0, cls, text.c_str(), WS_CHILD | WS_VISIBLE | style, x, y, w, h, parent,
                         reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr);
}

bool Activate(HWND target) {
  if (target == nullptr) return false;
  if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
  SetForegroundWindow(target);
  for (int i = 0; i < 20 && GetForegroundWindow() != target; ++i) Sleep(25);
  return GetForegroundWindow() == target;
}

void Execute(const std::string& line) {
  const auto space = line.find(' ');
  const std::string op = line.substr(0, space);
  const std::string arg = space == std::string::npos ? "" : line.substr(space + 1);
  Json reply;
  reply["op"] = op;
  bool ok = true;
  if (op == "info") {
    Reply(Identity());
    return;
  } else if (op == "activate") {
    ok = Activate(arg == "b" ? g_windowB : g_windowA);
  } else if (op == "focus") {
    const int id = arg == "search" ? kSearch : arg == "edit" ? kEdit : arg == "password" ? kPassword
                 : arg == "document" ? kDocument : arg == "button" ? kButton : 0;
    HWND control = id ? GetDlgItem(g_windowA, id) : nullptr;
    ok = control != nullptr && SetFocus(control) != nullptr;
    ok = control != nullptr && GetFocus() == control;
  } else if (op == "set-message") {
    ok = SetWindowTextW(GetDlgItem(g_windowA, kMessage), Wide(arg).c_str()) != FALSE;
  } else if (op == "input") {
    // Fixed controlled keys only, and only into this fixture's foreground window.
    if (arg == "stop-hotkey" && GetForegroundWindow() == g_windowA) {
      INPUT inputs[8]{};
      const WORD keys[] = {VK_CONTROL, VK_MENU, VK_SHIFT, 'R', 'R', VK_SHIFT, VK_MENU, VK_CONTROL};
      for (int i = 0; i < 8; ++i) {
        inputs[i].type = INPUT_KEYBOARD;
        inputs[i].ki.wVk = keys[i];
        if (i >= 4) inputs[i].ki.dwFlags = KEYEVENTF_KEYUP;
      }
      reply["ok"] = SendInput(8, inputs, sizeof(INPUT)) == 8;
      Reply(reply);
      return;
    }
    const WORD key = arg == "text-key" ? 'Q' : arg == "navigation" ? VK_F6 : 0;
    ok = key != 0 && GetForegroundWindow() == g_windowA;
    if (ok) {
      INPUT inputs[2]{};
      inputs[0].type = inputs[1].type = INPUT_KEYBOARD;
      inputs[0].ki.wVk = inputs[1].ki.wVk = key;
      inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
      ok = SendInput(2, inputs, sizeof(INPUT)) == 2;
    }
  } else if (op == "freeze") {
    reply["ok"] = true;
    Reply(reply);
    Sleep(static_cast<DWORD>(std::stoul(arg.empty() ? "1000" : arg)));
    return;
  } else if (op == "close-b") {
    if (g_windowB) DestroyWindow(g_windowB);
    g_windowB = nullptr;
  } else if (op == "exit") {
    reply["ok"] = true;
    Reply(reply);
    PostQuitMessage(0);
    return;
  } else {
    ok = false;
  }
  reply["ok"] = ok;
  reply["foreground"] = Hwnd(GetForegroundWindow());
  Reply(reply);
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case kCommandMessage: {
      std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(lParam));
      Execute(*line);
      return 0;
    }
    case WM_COMMAND:
      if (LOWORD(wParam) == kButton) {
        SetWindowTextW(GetDlgItem(g_windowA, kMessage), Sentinel(L"MESSAGE-CLICKED").c_str());
      }
      return 0;
    case WM_CLOSE:
      if (hwnd == g_windowA) PostQuitMessage(0);
      DestroyWindow(hwnd);
      if (hwnd == g_windowB) g_windowB = nullptr;
      return 0;
    default:
      return DefWindowProcW(hwnd, message, wParam, lParam);
  }
}

void ReadCommands(bool idle) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::string pending;
  char buffer[1024];
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(input, buffer, sizeof(buffer), &read, nullptr) || read == 0) break;
    pending.append(buffer, read);
    std::size_t newline;
    while ((newline = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, newline);
      pending.erase(0, newline + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (idle) {
        if (line == "exit") ExitProcess(0);
        Reply(Identity());
        continue;
      }
      PostMessageW(g_windowA, kCommandMessage, 0, reinterpret_cast<LPARAM>(new std::string(line)));
    }
  }
  // The harness is gone: never outlive it.
  ExitProcess(0);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const int argc = __argc;
  wchar_t** argv = __wargv;  // populated by the CRT for wWinMain
  bool idle = false;
  g_nonce = L"default";
  for (int i = 1; i < argc; ++i) {
    const std::wstring arg = argv[i];
    if (arg == L"--idle") idle = true;
    if (arg == L"--nonce" && i + 1 < argc) g_nonce = argv[++i];
  }

  if (idle) {
    ReadCommands(true);
    return 0;
  }

  LoadLibraryW(L"Msftedit.dll");
  WNDCLASSEXW windowClass{sizeof(windowClass)};
  windowClass.lpfnWndProc = WindowProc;
  windowClass.hInstance = instance;
  windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  windowClass.lpszClassName = L"MemmyHistoryFixtureWindow";
  RegisterClassExW(&windowClass);
  WNDCLASSEXW panelClass = windowClass;
  panelClass.lpfnWndProc = DefWindowProcW;
  panelClass.lpszClassName = L"MemmyHistoryFixturePanel";
  RegisterClassExW(&panelClass);
  WNDCLASSEXW passwordClass = panelClass;
  passwordClass.lpfnWndProc = DefWindowProcW;
  passwordClass.lpszClassName = L"WindowsForms10.EDIT.MemmyPassword";
  RegisterClassExW(&passwordClass);

  g_windowA = CreateWindowExW(0, windowClass.lpszClassName, L"Memmy History Fixture A", WS_OVERLAPPEDWINDOW,
                              80, 60, 720, 560, nullptr, nullptr, instance, nullptr);
  Child(g_windowA, L"STATIC", Sentinel(L"STATIC"), 0, kStatic, 16, 12, 660, 24);
  Child(g_windowA, L"STATIC", Sentinel(L"MESSAGE-1"), 0, kMessage, 16, 40, 660, 24);
  Child(g_windowA, L"EDIT", Sentinel(L"SEARCH"), WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL, kSearch, 16, 72, 660, 28);
  HWND edit = Child(g_windowA, L"EDIT", Sentinel(L"EDIT"), WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL, kEdit, 16, 108, 660, 56);
  Child(edit, L"STATIC", Sentinel(L"EDITCHILD"), 0, kEditChild, 4, 30, 400, 20);
  HWND password = Child(g_windowA, L"EDIT", Sentinel(L"PASSWORD"), WS_BORDER | WS_TABSTOP | ES_PASSWORD | ES_AUTOHSCROLL,
                        kPassword, 16, 172, 660, 56);
  Child(password, L"STATIC", Sentinel(L"PWCHILD"), 0, kPasswordChild, 4, 30, 400, 20);
  Child(g_windowA, MSFTEDIT_CLASS, Sentinel(L"DOCUMENT"), WS_BORDER | ES_MULTILINE | ES_READONLY | WS_VSCROLL,
        kDocument, 16, 236, 660, 90);
  HWND panel = Child(g_windowA, L"MemmyHistoryFixturePanel", L"Sensitive panel", WS_BORDER, kPanel, 16, 334, 660, 60);
  Child(panel, L"STATIC", Sentinel(L"SENSITIVE"), 0, kPanelChild, 8, 8, 500, 24);
  Child(g_windowA, L"BUTTON", L"Update message", BS_PUSHBUTTON | WS_TABSTOP, kButton, 16, 402, 200, 32);
  HWND misreported = Child(g_windowA, passwordClass.lpszClassName, Sentinel(L"MISREPORTEDPASSWORD"),
    WS_BORDER | ES_PASSWORD, kMisreportedPassword, 240, 402, 420, 56);
  Child(misreported, L"STATIC", Sentinel(L"MISREPORTEDCHILD"), 0, kMisreportedChild, 4, 30, 400, 20);

  g_windowB = CreateWindowExW(0, windowClass.lpszClassName, L"Memmy History Fixture B", WS_OVERLAPPEDWINDOW,
                              820, 60, 420, 220, nullptr, nullptr, instance, nullptr);
  Child(g_windowB, L"STATIC", Sentinel(L"SECOND"), 0, kSecondStatic, 16, 16, 380, 24);

  ShowWindow(g_windowB, SW_SHOWNOACTIVATE);
  ShowWindow(g_windowA, SW_SHOW);
  UpdateWindow(g_windowA);

  std::thread(ReadCommands, false).detach();

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  return 0;
}
