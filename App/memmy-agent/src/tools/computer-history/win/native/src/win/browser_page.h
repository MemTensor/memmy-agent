#pragma once
#include "common/protocol.h"
#include <windows.h>
#include <objbase.h>
#include <UIAutomation.h>
#include <wrl/client.h>

namespace memmy::win {
struct BrowserPage {
  Microsoft::WRL::ComPtr<IUIAutomationElement> document;
  std::wstring committed;  // ephemeral, never serialized; detects query/fragment navigation too
  protocol::BrowserContext context;
};
// No page Name/Text or Document descendants are read by this probe.
std::optional<BrowserPage> ProbeBrowser(IUIAutomation* automation, IUIAutomationElement* root,
  std::uint32_t pid, browser::Kind kind, double deadline, std::wstring_view windowTitle);
bool SameBrowserPage(IUIAutomation* automation, const BrowserPage& a, const BrowserPage& b);
}  // namespace memmy::win
