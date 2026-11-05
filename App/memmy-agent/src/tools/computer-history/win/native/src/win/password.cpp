#include "win/password.h"

#include <cwctype>
#include <string>

namespace memmy::win {

std::optional<bool> NativePasswordState(HWND hwnd, std::uint32_t expectedPid) {
  DWORD owner = 0;
  if (!hwnd || !IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &owner) || owner != expectedPid) return std::nullopt;
  wchar_t buffer[256]{};
  const int length = GetClassNameW(hwnd, buffer, 256);
  if (length <= 0 || length >= 255) return std::nullopt;
  std::wstring name(buffer, static_cast<std::size_t>(length));
  for (auto& c : name) c = static_cast<wchar_t>(std::towlower(c));
  const bool edit = name == L"edit" || name == L"richedit" || name == L"richedit20a" ||
                    name == L"richedit20w" || name == L"richedit50w" || name.rfind(L"windowsforms10.edit.", 0) == 0;
  SetLastError(ERROR_SUCCESS);
  const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  if (style == 0 && GetLastError() != ERROR_SUCCESS) return std::nullopt;
  DWORD after = 0;
  if (!IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &after) || after != owner) return std::nullopt;
  return edit && (style & ES_PASSWORD) != 0;
}

std::optional<bool> EffectivePasswordState(std::optional<bool> provider, std::optional<bool> native) {
  if (provider == true || native == true) return true;
  if (!native) return std::nullopt;
  return provider;
}

}  // namespace memmy::win
