#include "win/application_catalog.h"

#include "common/text.h"
#include "win/identity.h"
#include "win/raii.h"

#include <shlobj.h>
#include <shobjidl.h>
#include <wrl/client.h>

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <map>
#include <regex>

using Microsoft::WRL::ComPtr;

namespace memmy::win {
namespace {
std::wstring Lower(std::wstring value) {
  for (auto& c : value) c = static_cast<wchar_t>(std::towlower(c));
  return value;
}

bool LocalPath(const std::wstring& path) {
  if (path.size() < 3 || !std::iswalpha(path[0]) || path[1] != L':' || path[2] != L'\\') return false;
  const std::wstring drive = path.substr(0, 3);
  const UINT type = GetDriveTypeW(drive.c_str());
  if (type != DRIVE_FIXED && type != DRIVE_REMOVABLE && type != DRIVE_RAMDISK) return false;
  // Check each ancestor before entering it, including the menu root itself.
  std::filesystem::path current = drive;
  for (const auto& part : std::filesystem::path(path).relative_path()) {
    current /= part;
    const DWORD attrs = GetFileAttributesW(current.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  }
  return true;
}

bool LocalExe(const std::wstring& path) {
  // Do not follow a Start Menu link to a network location during discovery.
  if (Lower(std::filesystem::path(path).extension().wstring()) != L".exe" || !LocalPath(path)) return false;
  return !(GetFileAttributesW(path.c_str()) & FILE_ATTRIBUTE_DIRECTORY);
}

bool Helper(const std::wstring& path) {
  const std::wstring stem = Lower(std::filesystem::path(path).stem().wstring());
  static const std::wregex pattern(LR"((.*(helper|crashpad|crashhandler|updater|renderer|gpu-process)|update|uninstall|unins[0-9]+))");
  return std::regex_match(stem, pattern);
}

std::wstring Description(const std::wstring& executable) {
  DWORD ignored = 0;
  const DWORD size = GetFileVersionInfoSizeW(executable.c_str(), &ignored);
  if (!size || size > 256 * 1024) return {};
  std::vector<unsigned char> bytes(size);
  if (!GetFileVersionInfoW(executable.c_str(), 0, size, bytes.data())) return {};
  struct Translation { WORD language; WORD codepage; };
  Translation* translations = nullptr;
  UINT count = 0;
  if (!VerQueryValueW(bytes.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translations), &count)) return {};
  for (UINT i = 0; i < std::min<UINT>(count / static_cast<UINT>(sizeof(Translation)), 16); ++i) {
    wchar_t query[80]{};
    swprintf_s(query, L"\\StringFileInfo\\%04x%04x\\FileDescription", translations[i].language, translations[i].codepage);
    wchar_t* value = nullptr;
    UINT length = 0;
    if (VerQueryValueW(bytes.data(), query, reinterpret_cast<void**>(&value), &length) && value && length > 1 && length <= 257)
      return std::wstring(value, length - 1);
  }
  return {};
}

std::wstring ShortcutTarget(const std::filesystem::path& file) {
  ComPtr<IShellLinkW> link;
  ComPtr<IPersistFile> persist;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) ||
      FAILED(link.As(&persist)) || FAILED(persist->Load(file.c_str(), STGM_READ))) return {};
  wchar_t raw[32768]{};
  if (FAILED(link->GetPath(raw, 32768, nullptr, SLGP_RAWPATH))) return {};
  wchar_t expanded[32768]{};
  const DWORD size = ExpandEnvironmentStringsW(raw, expanded, 32768);
  if (!size || size > 32768) return {};
  std::wstring target(expanded);
  // Squirrel launchers point to Update.exe; accept a local sibling only when it exists.
  if (Lower(std::filesystem::path(target).filename().wstring()) == L"update.exe") {
    wchar_t args[4096]{};
    if (FAILED(link->GetArguments(args, 4096))) return {};
    static const std::wregex processStart(LR"re(--processStart\s+(?:"([^"\\/]+\.exe)"|([^\s"\\/]+\.exe))(?:\s|$))re", std::regex::icase);
    std::wcmatch match;
    if (!std::regex_search(args, match, processStart)) return {};
    target = (std::filesystem::path(target).parent_path() / (match[1].matched ? match[1].str() : match[2].str())).wstring();
  }
  return target;
}
}  // namespace

std::vector<CatalogApplication> ReadApplicationCatalog(const std::vector<std::wstring>& menus,
                                                     const std::vector<std::wstring>& running) {
  ComScope com(COINIT_APARTMENTTHREADED);
  std::map<std::wstring, CatalogApplication> entries;
  const auto remember = [&](const std::wstring& path, std::wstring name) {
    if (entries.size() >= 512 || !LocalExe(path) || Helper(path)) return;
    const auto canonical = CanonicalizePath(path);
    if (!LocalExe(canonical)) return;
    if (name.empty()) name = std::filesystem::path(canonical).filename().wstring();
    const auto key = Lower(canonical);
    entries.try_emplace(key, CatalogApplication{text::ToUtf8(canonical), text::ToUtf8(text::TruncateUtf16(name, 256))});
  };
  std::size_t visited = 0;
  if (com.Ok()) for (const auto& menu : menus) {
    // Directory metadata/links only. Never recurse into junctions or network menus.
    if (!LocalPath(menu)) continue;
    std::error_code error;
    std::filesystem::recursive_directory_iterator it(menu, std::filesystem::directory_options::skip_permission_denied, error), end;
    while (!error && it != end && visited++ < 4096 && entries.size() < 512) {
      const DWORD attrs = GetFileAttributesW(it->path().c_str());
      if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) it.disable_recursion_pending();
      else if (it->is_regular_file(error) && Lower(it->path().extension().wstring()) == L".lnk")
        remember(ShortcutTarget(it->path()), it->path().stem().wstring());
      it.increment(error);
    }
  }
  for (const auto& executable : running) {
    if (LocalExe(executable)) remember(executable, Description(executable));
  }
  std::vector<CatalogApplication> result;
  for (auto& [key, entry] : entries) { (void)key; result.push_back(std::move(entry)); }
  return result;
}

std::vector<CatalogApplication> ApplicationCatalog() {
  std::vector<std::wstring> menus, running;
  for (const auto& id : {FOLDERID_StartMenu, FOLDERID_CommonStartMenu}) {
    PWSTR value = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, nullptr, &value)) && value) menus.emplace_back(value);
    CoTaskMemFree(value);
  }
  for (const auto hwnd : VisibleTopLevelWindows(0)) {
    std::string reason;
    const auto context = ReadWindowContext(hwnd, reason);
    if (context) running.push_back(text::FromUtf8(context->executable).value_or(L""));
  }
  return ReadApplicationCatalog(menus, running);
}
}  // namespace memmy::win
