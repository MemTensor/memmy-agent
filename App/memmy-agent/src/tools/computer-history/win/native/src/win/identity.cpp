#include "win/identity.h"

#include "common/text.h"
#include "win/raii.h"

namespace memmy::win {
namespace {

std::wstring FullPath(const std::wstring& path) {
  DWORD size = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
  if (size == 0) return path;
  std::wstring out(size, L'\0');
  size = GetFullPathNameW(path.c_str(), size, out.data(), nullptr);
  if (size == 0 || size >= out.size()) return path;
  out.resize(size);
  return out;
}

std::wstring StripVerbatimPrefix(std::wstring path) {
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) return L"\\\\" + path.substr(8);
  if (path.rfind(L"\\\\?\\", 0) == 0) return path.substr(4);
  return path;
}

}  // namespace

std::wstring CanonicalizePath(const std::wstring& path) {
  std::wstring full = FullPath(path);
  UniqueHandle file = Own(CreateFileW(full.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!file) return full;
  DWORD size = GetFinalPathNameByHandleW(file.get(), nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (size == 0) return full;
  std::wstring out(size, L'\0');
  size = GetFinalPathNameByHandleW(file.get(), out.data(), size, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (size == 0 || size >= out.size()) return full;
  out.resize(size);
  return StripVerbatimPrefix(std::move(out));
}

std::optional<std::uint64_t> ProcessCreationTime(HANDLE process) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) return std::nullopt;
  return (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
}

std::optional<protocol::ContextRecord> ReadWindowContext(std::uint64_t hwndValue, std::string& reason) {
  const HWND hwnd = ToHwnd(hwndValue);
  if (hwndValue == 0 || !IsWindow(hwnd)) {
    reason = "window_unavailable";
    return std::nullopt;
  }
  if (GetAncestor(hwnd, GA_ROOT) != hwnd) {
    reason = "not_top_level";
    return std::nullopt;
  }
  DWORD pid = 0;
  if (GetWindowThreadProcessId(hwnd, &pid) == 0 || pid == 0) {
    reason = "window_unavailable";
    return std::nullopt;
  }
  UniqueHandle process = Own(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process) {
    reason = "process_unavailable";
    return std::nullopt;
  }
  // The window still belonging to pid after the handle is open proves the handle refers to the
  // window's process rather than a later process that reused the PID.
  DWORD pidAfter = 0;
  if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, &pidAfter) == 0 || pidAfter != pid) {
    reason = "window_unavailable";
    return std::nullopt;
  }
  const auto created = ProcessCreationTime(process.get());
  std::wstring image(32768, L'\0');
  DWORD size = static_cast<DWORD>(image.size());
  if (!created || !QueryFullProcessImageNameW(process.get(), 0, image.data(), &size) || size == 0) {
    reason = "identity_unavailable";
    return std::nullopt;
  }
  image.resize(size);
  protocol::ContextRecord context;
  context.hwnd = hwndValue;
  context.pid = pid;
  context.processStart = *created;
  context.executable = text::ToUtf8(CanonicalizePath(image));
  context.dpi = GetDpiForWindow(hwnd);
  RECT rect{};
  if (GetWindowRect(hwnd, &rect)) context.bounds = {rect.left, rect.top, rect.right, rect.bottom};
  context.minimized = IsIconic(hwnd) != FALSE;
  return context;
}

std::uint64_t ForegroundWindow() { return FromHwnd(GetForegroundWindow()); }

std::string ReadWindowTitle(std::uint64_t hwnd, std::size_t maxUnits) {
  std::wstring buffer(maxUnits + 1, L'\0');
  const int length = InternalGetWindowText(ToHwnd(hwnd), buffer.data(), static_cast<int>(buffer.size()));
  if (length <= 0) return {};
  buffer.resize(static_cast<std::size_t>(length));
  return text::ToUtf8(text::TruncateUtf16(buffer, maxUnits));
}

std::vector<std::uint64_t> VisibleTopLevelWindows(std::uint32_t pid) {
  struct State {
    std::uint32_t pid;
    std::vector<std::uint64_t> windows;
  } state{pid, {}};
  EnumWindows(
      [](HWND hwnd, LPARAM param) -> BOOL {
        auto* s = reinterpret_cast<State*>(param);
        DWORD owner = 0;
        GetWindowThreadProcessId(hwnd, &owner);
        if ((!s->pid || owner == s->pid) && IsWindowVisible(hwnd) && s->windows.size() < 512) s->windows.push_back(FromHwnd(hwnd));
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&state));
  return state.windows;
}

policy::Target ToTarget(const protocol::ContextRecord& context) {
  policy::Target target;
  target.pid = context.pid;
  target.processStart = context.processStart;
  target.hwnd = context.hwnd;
  target.executable = text::FromUtf8(context.executable).value_or(L"");
  return target;
}

}  // namespace memmy::win
