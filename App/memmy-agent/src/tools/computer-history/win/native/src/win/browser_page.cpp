#include "win/browser_page.h"
#include "common/browser.h"
#include "common/text.h"
#include "win/raii.h"
#include "win/system.h"
#include <deque>

using Microsoft::WRL::ComPtr;
namespace memmy::win {
std::optional<BrowserPage> ProbeBrowser(IUIAutomation* automation, IUIAutomationElement* root,
  std::uint32_t pid, browser::Kind kind, double deadline, std::wstring_view windowTitle) {
  (void)pid; (void)windowTitle;
  ComPtr<IUIAutomationTreeWalker> walker;
  if (FAILED(automation->get_ControlViewWalker(&walker))) return std::nullopt;
  struct Entry { ComPtr<IUIAutomationElement> node; int depth; bool browserView; };
  std::deque<Entry> queue;
  Variant typeCondition;
  auto* property = typeCondition.Put(); property->vt = VT_I4; property->lVal = UIA_DocumentControlTypeId;
  ComPtr<IUIAutomationCondition> condition;
  ComPtr<IUIAutomationElementArray> documents;
  if (FAILED(automation->CreatePropertyCondition(UIA_ControlTypePropertyId, typeCondition.Get(), &condition)) ||
      FAILED(root->FindAll(TreeScope_Descendants, condition.Get(), &documents)) || !documents) return std::nullopt;
  int count = 0; documents->get_Length(&count);
  for (int i = 0; i < count && i < 32 && MonotonicMs() < deadline; ++i) {
    ComPtr<IUIAutomationElement> document;
    if (FAILED(documents->GetElement(i, &document)) || !document) continue;
    bool browserView = count == 1;
    ComPtr<IUIAutomationElement> current = document;
    for (int level = 0; count > 1 && current && level < 12 && MonotonicMs() < deadline; ++level) {
      Bstr name;
      if (SUCCEEDED(current->get_CurrentClassName(name.Put())) && name.View() == L"BrowserView") { browserView = true; break; }
      ComPtr<IUIAutomationElement> parent;
      if (FAILED(walker->GetParentElement(current.Get(), &parent))) break;
      current = std::move(parent);
    }
    queue.push_back({document, 0, browserView});
  }
  std::optional<BrowserPage> page;
  bool inBrowserView = false, ambiguous = false;
  int visited = 0;
  while (!queue.empty() && ++visited <= 240 && MonotonicMs() < deadline) {
    auto entry = std::move(queue.front()); queue.pop_front();
    if (entry.depth > 32) continue;
    BOOL hidden = FALSE;
    if (SUCCEEDED(entry.node->get_CurrentIsOffscreen(&hidden)) && hidden) continue;
    CONTROLTYPEID type = 0;
    if (FAILED(entry.node->get_CurrentControlType(&type))) continue;
    Bstr cls;
    if (SUCCEEDED(entry.node->get_CurrentClassName(cls.Put())) && cls.View() == L"BrowserView") entry.browserView = true;
    if (type == UIA_DocumentControlTypeId) {
      Variant password;
      if (SUCCEEDED(entry.node->GetCurrentPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, password.Put())) &&
          password.Get().vt == VT_BOOL && password.Get().boolVal == VARIANT_TRUE) continue;
      ComPtr<IUIAutomationValuePattern> pattern;
      Bstr value;
      RECT rect{};
      if (FAILED(entry.node->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&pattern))) || !pattern || FAILED(pattern->get_CurrentValue(value.Put()))) {
        ComPtr<IUIAutomationLegacyIAccessiblePattern> legacy;
        if (FAILED(entry.node->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, IID_PPV_ARGS(&legacy))) || !legacy || FAILED(legacy->get_CurrentValue(value.Put()))) continue;
      }
      if (FAILED(entry.node->get_CurrentBoundingRectangle(&rect))) continue;
      const auto url = browser::SanitizeUrl(value.View());
      if (url.empty() || rect.right <= rect.left || rect.bottom <= rect.top) continue;
      // BrowserView excludes stale tab HWNDs. Ambiguity affects URL only.
      if (page && inBrowserView && !entry.browserView) continue;
      if (!page || (!inBrowserView && entry.browserView)) {
        BrowserPage next;
        next.document = entry.node; next.committed = value.View();
        next.context.url = text::ToUtf8(url); next.context.kind = kind;
        next.context.mode = "unknown";
        next.context.viewport = {static_cast<double>(rect.left), static_cast<double>(rect.top), static_cast<double>(rect.right-rect.left), static_cast<double>(rect.bottom-rect.top)};
        SafeArray runtime;
        if (SUCCEEDED(entry.node->GetRuntimeId(runtime.Put())) && runtime.Get()) {
          LONG low = 0, high = -1;
          SafeArrayGetLBound(runtime.Get(), 1, &low); SafeArrayGetUBound(runtime.Get(), 1, &high);
          for (LONG i = low; i <= high && i-low < 16; ++i) {
            LONG part = 0; if (FAILED(SafeArrayGetElement(runtime.Get(), &i, &part))) break;
            next.context.documentId += "." + std::to_string(part);
          }
        }
        if (next.context.documentId.empty()) continue;
        page = std::move(next); inBrowserView = entry.browserView; ambiguous = false;
      } else if (page->context.url != text::ToUtf8(url)) ambiguous = true;
      continue;
    }
    ComPtr<IUIAutomationElement> child;
    if (FAILED(walker->GetFirstChildElement(entry.node.Get(), &child))) continue;
    while (child && queue.size() < 240 && MonotonicMs() < deadline) {
      queue.push_back({child, entry.depth + 1, entry.browserView});
      ComPtr<IUIAutomationElement> next;
      if (FAILED(walker->GetNextSiblingElement(child.Get(), &next))) break;
      child = std::move(next);
    }
  }
  return ambiguous ? std::nullopt : page;
}
bool SameBrowserPage(IUIAutomation* automation, const BrowserPage& a, const BrowserPage& b) {
  BOOL same = FALSE;
  return a.context.kind == b.context.kind && a.committed == b.committed && a.context.documentId == b.context.documentId &&
    SUCCEEDED(automation->CompareElements(a.document.Get(), b.document.Get(), &same)) && same;
}
} // namespace memmy::win
