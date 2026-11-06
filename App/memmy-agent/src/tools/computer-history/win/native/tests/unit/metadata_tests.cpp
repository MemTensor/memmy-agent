#include "win/application_catalog.h"
#include "win/password.h"
#include "win/raii.h"
#include "common/text.h"

#include <shobjidl.h>
#include <wrl/client.h>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>

using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;
using namespace memmy::win;
namespace {
void Check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

void PasswordTests() {
  HWND parent = CreateWindowExW(0, L"STATIC", L"fixture", WS_OVERLAPPED, 0, 0, 100, 100, nullptr, nullptr, nullptr, nullptr);
  Check(parent != nullptr, "hidden fixture parent");
  HWND edit = CreateWindowExW(0, L"EDIT", L"synthetic-secret", WS_CHILD | ES_PASSWORD, 0, 0, 80, 20, parent, nullptr, nullptr, nullptr);
  Check(NativePasswordState(edit, GetCurrentProcessId()) == true, "native password edit");
  Check(!NativePasswordState(edit, GetCurrentProcessId() + 1).has_value(), "foreign HWND denied");
  Check(EffectivePasswordState(false, true) == true, "native password wins provider false");
  Check(EffectivePasswordState(true, false) == true, "provider password wins native false");
  Check(EffectivePasswordState(true, std::nullopt) == true, "unknown native cannot weaken a known password");
  Check(!EffectivePasswordState(std::nullopt, false).has_value(), "unknown provider remains unknown");
  Check(!EffectivePasswordState(false, std::nullopt).has_value(), "unknown native remains unknown");
  SetWindowLongPtrW(edit, GWL_STYLE, GetWindowLongPtrW(edit, GWL_STYLE) & ~ES_PASSWORD);
  Check(NativePasswordState(edit, GetCurrentProcessId()) == false, "style change observed");
  HWND panel = CreateWindowExW(0, L"STATIC", L"ordinary label", WS_CHILD | ES_PASSWORD, 0, 0, 80, 20, parent, nullptr, nullptr, nullptr);
  Check(panel && NativePasswordState(panel, GetCurrentProcessId()) == false, "unrelated class style bit is not a password");
  DestroyWindow(parent);
  Check(!NativePasswordState(edit, GetCurrentProcessId()).has_value(), "destroyed HWND unknown");
}

void Shortcut(const fs::path& menu, const fs::path& exe, const wchar_t* arguments = L"") {
  ComPtr<IShellLinkW> link;
  ComPtr<IPersistFile> persist;
  Check(SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))), "create shortcut");
  Check(SUCCEEDED(link->SetPath(exe.c_str())) && SUCCEEDED(link->SetArguments(arguments)) &&
    SUCCEEDED(link.As(&persist)) && SUCCEEDED(persist->Save(menu.c_str(), TRUE)), "save shortcut");
}

void CatalogTests() {
  ComScope com(COINIT_APARTMENTTHREADED);
  Check(com.Ok(), "catalog COM");
  wchar_t temp[MAX_PATH]{};
  Check(GetTempPathW(MAX_PATH, temp) != 0, "temp directory");
  const fs::path root = fs::path(temp) / (L"memmy-history-metadata-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
  struct Cleanup { fs::path path; ~Cleanup() { std::error_code error; fs::remove_all(path, error); } } cleanup{root};
  const fs::path menu = root / L"开始菜单", bin = root / L"one", other = root / L"two";
  fs::create_directories(menu / L"nested"); fs::create_directories(bin); fs::create_directories(other);
  const auto touch = [](const fs::path& file) { std::ofstream(file, std::ios::binary) << "synthetic fixture, never executed"; };
  for (const auto& file : {bin / L"app.exe", other / L"app.exe", bin / L"Update.exe", bin / L"Chat.exe", bin / L"apphelper.exe", bin / L"running.exe"}) touch(file);
  Shortcut(menu / L"中文应用.lnk", bin / L"app.exe");
  Shortcut(menu / L"nested" / L"Other Application.lnk", other / L"app.exe");
  Shortcut(menu / L"聊天应用.lnk", bin / L"Update.exe", L"--processStart Chat.exe");
  Shortcut(menu / L"Missing.lnk", bin / L"Update.exe", L"--processStart Missing.exe");
  Shortcut(menu / L"Helper.lnk", bin / L"apphelper.exe");
  Shortcut(menu / L"Remote.lnk", fs::path(L"\\\\invalid.example\\share\\remote.exe"));
  const auto entries = ReadApplicationCatalog({menu.wstring()}, {(bin / L"app.exe").wstring(), (bin / L"running.exe").wstring()});
  Check(entries.size() == 4, "catalog deduplicates full paths, excludes missing/helper/network targets");
  bool chinese = false, chat = false, fallback = false;
  for (const auto& entry : entries) {
    chinese |= entry.name == memmy::text::ToUtf8(L"中文应用");
    chat |= entry.name == memmy::text::ToUtf8(L"聊天应用");
    fallback |= entry.name == "running.exe";
  }
  Check(chinese && chat && fallback, "shortcut names, launcher target and running fallback");
}
}

int main() {
  try { PasswordTests(); CatalogTests(); std::puts("Windows metadata tests passed"); return 0; }
  catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
