#include "common/browser.h"
#include "common/text.h"
#include <algorithm>
#include <cwctype>
#include <windows.h>
#include <winhttp.h>

namespace memmy::browser {
namespace {
std::wstring Lower(std::wstring_view value) {
  std::wstring result(value);
  std::transform(result.begin(), result.end(), result.begin(), [](wchar_t c) { return static_cast<wchar_t>(towlower(c)); });
  return result;
}
bool OneOf(std::wstring_view value, std::initializer_list<std::wstring_view> choices) {
  return std::any_of(choices.begin(), choices.end(), [&](auto item) { return text::EqualsOrdinalIgnoreCase(value, item); });
}
}
const char* Name(Kind kind) {
  switch (kind) { case Kind::Chrome: return "chrome"; case Kind::Edge: return "edge"; default: return ""; }
}
Kind FromName(std::string_view name) {
  if (name == "chrome") return Kind::Chrome;
  if (name == "edge") return Kind::Edge;
  return Kind::None;
}
bool MatchesExecutable(Kind kind, std::wstring_view path) {
  const auto slash = path.find_last_of(L"/\\");
  const auto name = path.substr(slash == std::wstring::npos ? 0 : slash + 1);
  return (kind == Kind::Chrome && text::EqualsOrdinalIgnoreCase(name, L"chrome.exe")) ||
    (kind == Kind::Edge && text::EqualsOrdinalIgnoreCase(name, L"msedge.exe"));
}
bool NormalProfile(std::wstring_view name, std::wstring_view id, std::wstring_view className, Kind kind) {
  if (PrivateSignal(name)) return false;
  if (kind == Kind::Edge) {
    // Edge's signed-out profile control carries an explicit normal-profile label.
    // InPrivate/guest controls (including CDP-created private windows) do not.
    const auto lower = Lower(name);
    return className == L"EdgeAvatarToolbarButton" &&
      ((name.size() > 9 && name.ends_with(L" 个人资料，请登录")) ||
       (lower.size() > 17 && lower.ends_with(L" profile, sign in")));
  }
  if (kind != Kind::Chrome) return false;
  return OneOf(name, {L"You", L"您"}) &&
    (OneOf(id, {L"avatar_button", L"avatarButton", L"profile_button", L"profileButton", L"browser-profile-button"}) ||
     OneOf(className, {L"AvatarToolbarButton", L"ProfileMenuButton", L"BrowserProfileButton"}));
}
bool PrivateSignal(std::wstring_view value) {
  const auto lower = Lower(value);
  for (auto marker : {L"incognito", L"inprivate", L"private browsing", L"guest", L"无痕", L"無痕", L"隐身", L"隱身",
       L"访客", L"訪客", L"来宾", L"來賓", L"隐私浏览", L"隱私瀏覽", L"シークレット", L"ゲスト", L"게스트"}) {
    if (lower.find(marker) != std::wstring::npos) return true;
  }
  return false;
}
bool AddressControl(std::wstring_view name, std::wstring_view id) {
  return OneOf(id, {L"addressEditBox", L"omnibox"}) || OneOf(name, {
    L"Address and search bar", L"Address bar", L"地址和搜索栏", L"地址及搜尋列", L"地址與搜尋列", L"网址和搜索栏"});
}
std::wstring SanitizeUrl(std::wstring_view raw) {
  if (raw.empty() || raw.size() > 16384 || raw.find_first_of(L"\r\n\t \\") != std::wstring::npos || raw.find(L'\0') != std::wstring::npos) return {};
  std::wstring value(raw);
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof(parts);
  parts.dwSchemeLength = parts.dwHostNameLength = parts.dwUserNameLength = parts.dwPasswordLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(value.c_str(), static_cast<DWORD>(value.size()), 0, &parts) ||
      (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS) || !parts.dwHostNameLength) return {};
  auto host = Lower(std::wstring_view(parts.lpszHostName, parts.dwHostNameLength));
  if (host.find(L':') != std::wstring::npos && host.front() != L'[') host = L"[" + host + L"]";
  std::wstring result = (parts.nScheme == INTERNET_SCHEME_HTTPS ? L"https://" : L"http://") + host;
  if (parts.nPort != (parts.nScheme == INTERNET_SCHEME_HTTPS ? 443 : 80)) result += L":" + std::to_wstring(parts.nPort);
  result += parts.dwUrlPathLength ? std::wstring(parts.lpszUrlPath, parts.dwUrlPathLength) : L"/";
  return result;
}
bool AddressMatches(std::wstring_view address, std::wstring_view committed) {
  auto raw = std::wstring(address);
  const auto url = SanitizeUrl(committed);
  if (url.empty()) return false;
  if (raw.find(L"://") == std::wstring::npos) raw = url.substr(0, url.find(L"://") + 3) + raw;
  auto candidate = SanitizeUrl(raw);
  const auto withoutWww = [](std::wstring value) {
    const auto start = value.find(L"://");
    if (start != std::wstring::npos && value.substr(start + 3, 4) == L"www.") value.erase(start + 3, 4);
    return value;
  };
  return !candidate.empty() && withoutWww(candidate) == withoutWww(url);
}
}  // namespace memmy::browser
