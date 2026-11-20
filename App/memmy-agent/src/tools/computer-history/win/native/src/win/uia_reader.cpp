#include "win/uia_reader.h"

#include "common/classify.h"
#include "common/json.h"
#include "common/text.h"
#include "win/identity.h"
#include "win/browser_page.h"
#include "win/password.h"
#include "win/raii.h"
#include "win/system.h"

#include <UIAutomation.h>
#include <oleacc.h>
#include <set>
#include <wrl/client.h>

#include <algorithm>
#include <new>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace memmy::win {
namespace {

constexpr std::size_t kMaxAutomationIdChars = 256;
constexpr std::size_t kMaxTitleChars = 1024;

void RequestAccessibility(HWND window) {
  wchar_t name[128]{};
  if (!GetClassNameW(window, name, 128) || std::wstring_view(name).find(L"Chrome_") != 0) return;
  const auto request = [](HWND target) {
    DWORD_PTR result = 0;
    SendMessageTimeoutW(target, WM_GETOBJECT, 0, 1, SMTO_ABORTIFHUNG | SMTO_BLOCK, 20, &result);
    ComPtr<IAccessible> accessible;
    AccessibleObjectFromWindow(target, static_cast<DWORD>(OBJID_CLIENT), IID_PPV_ARGS(&accessible));
  };
  request(window);
  struct State { int visited = 0; decltype(request)* activate; } state{0, &request};
  EnumChildWindows(window, [](HWND child, LPARAM data) -> BOOL {
    auto& current = *reinterpret_cast<State*>(data);
    if (++current.visited > 16) return FALSE;
    wchar_t type[128]{};
    if (GetClassNameW(child, type, 128) && std::wstring_view(type) == L"Chrome_RenderWidgetHostHWND") (*current.activate)(child);
    return TRUE;
  }, reinterpret_cast<LPARAM>(&state));
}

class Traversal {
 public:
  Traversal(const policy::Policy& policy, const policy::AppRule& rule, std::uint32_t pid, double started,
            const protocol::BrowserContext* browser = nullptr)
      : policy_(policy), rule_(rule), pid_(pid), started_(started), browser_(browser) {}

  bool Init(IUIAutomation* automation, bool raw = false) {
    automation_ = automation;
    if (FAILED(automation->CreateCacheRequest(&cache_))) return false;
    // Metadata only. Name, Value and Text are never cached; they are read per node after the
    // node has been classified.
    for (const PROPERTYID property :
         {UIA_ControlTypePropertyId, UIA_IsPasswordPropertyId, UIA_AutomationIdPropertyId, UIA_ProcessIdPropertyId,
          UIA_HasKeyboardFocusPropertyId, UIA_IsOffscreenPropertyId, UIA_BoundingRectanglePropertyId,
          UIA_RuntimeIdPropertyId, UIA_IsTextPatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId,
          UIA_IsLegacyIAccessiblePatternAvailablePropertyId, UIA_ClassNamePropertyId}) {
      if (FAILED(cache_->AddProperty(property))) return false;
    }
    if (FAILED(raw ? automation->get_RawViewWalker(&walker_) : automation->get_ControlViewWalker(&walker_))) return false;
    // Reorder traversal toward the focused branch without moving focus or changing the UI.
    ComPtr<IUIAutomationElement> focused;
    if (SUCCEEDED(automation->GetFocusedElement(&focused))) {
      for (int i = 0; focused && i < 32 && !Expired(); ++i) {
        const auto id = RuntimeId(focused.Get());
        if (!id.empty()) focusPath_.insert(id);
        ComPtr<IUIAutomationElement> parent;
        if (FAILED(walker_->GetParentElement(focused.Get(), &parent))) break;
        focused = std::move(parent);
      }
    }
    return true;
  }

  IUIAutomationCacheRequest* Cache() const { return cache_.Get(); }
  void ReserveFallbackTime() { budgetRatio_ = 0.65; }

  void Run(IUIAutomationElement* root, protocol::WorkerResponse& response) {
    UIA_HWND handle = nullptr;
    if (SUCCEEDED(root->get_CurrentNativeWindowHandle(&handle))) rootHwnd_ = reinterpret_cast<HWND>(handle);
    struct Frame {
      ComPtr<IUIAutomationElement> element;
      int depth;
      int parent;
    };
    std::vector<Frame> stack;
    stack.push_back({root, 0, -1});
    while (!stack.empty()) {
      if (Expired()) {
        Truncate("budget_ms");
        break;
      }
      if (response.stats.visited >= static_cast<std::uint64_t>(policy_.limits.maxVisited)) {
        Truncate("max_visited");
        break;
      }
      Frame frame = std::move(stack.back());
      stack.pop_back();
      ++response.stats.visited;

      bool traverse = false;
      if (!Visit(frame.element.Get(), frame.depth, frame.parent, response, traverse)) break;
      if (!traverse) continue;

      const int self = static_cast<int>(response.nodes.size()) - 1;
      std::vector<ComPtr<IUIAutomationElement>> children;
      ComPtr<IUIAutomationElement> child;
      if (FAILED(walker_->GetFirstChildElementBuildCache(frame.element.Get(), cache_.Get(), &child))) {
        Truncate("traversal_error");
        continue;
      }
      if (child && frame.depth + 1 > policy_.limits.maxDepth) {
        Truncate("max_depth");
        continue;
      }
      const std::size_t used = static_cast<std::size_t>(response.stats.visited) + stack.size();
      const std::size_t limit = static_cast<std::size_t>(policy_.limits.maxVisited);
      const std::size_t room = used >= limit ? 0 : limit - used;
      while (child) {
        if (children.size() >= room) {
          Truncate("max_visited");
          break;
        }
        if (Expired()) {
          Truncate("budget_ms");
          break;
        }
        children.push_back(child);
        ComPtr<IUIAutomationElement> next;
        if (FAILED(walker_->GetNextSiblingElementBuildCache(child.Get(), cache_.Get(), &next))) {
          Truncate("traversal_error");
          break;
        }
        child = std::move(next);
      }
      if (rule_.captureText) std::stable_sort(children.begin(), children.end(), [&](const auto& a, const auto& b) {
        return Priority(a.Get()) > Priority(b.Get());
      });
      for (auto it = children.rbegin(); it != children.rend(); ++it) {
        stack.push_back({std::move(*it), frame.depth + 1, self});
      }
    }
    response.truncated = !truncation_.empty();
    response.truncation = truncation_;
  }

 private:
  std::optional<bool> NativePassword(IUIAutomationElement* element) const {
    UIA_HWND handle = nullptr;
    if (FAILED(element->get_CurrentNativeWindowHandle(&handle))) return std::nullopt;
    DWORD owner = 0;
    if (handle) GetWindowThreadProcessId(reinterpret_cast<HWND>(handle), &owner);
    return handle ? NativePasswordState(reinterpret_cast<HWND>(handle), owner) : std::optional<bool>(false);
  }

  bool Expired() const { return MonotonicMs() - started_ > policy_.limits.queryBudgetMs * budgetRatio_; }

  void Truncate(const char* code) {
    if (std::find(truncation_.begin(), truncation_.end(), code) == truncation_.end()) truncation_.push_back(code);
  }

  std::optional<bool> CachedBool(IUIAutomationElement* element, PROPERTYID property, bool ignoreDefault) {
    Variant value;
    if (FAILED(element->GetCachedPropertyValueEx(property, ignoreDefault ? TRUE : FALSE, value.Put()))) {
      return std::nullopt;
    }
    if (value.Get().vt == VT_BOOL) return value.Get().boolVal != VARIANT_FALSE;
    return std::nullopt;  // includes the reserved "not supported" value
  }

  // Remaining text budget for one field.
  std::size_t FieldBudget() const {
    const std::size_t used = static_cast<std::size_t>(textUsed_);
    const std::size_t total = static_cast<std::size_t>(policy_.limits.maxTextChars);
    const std::size_t remaining = used >= total ? 0 : total - used;
    return std::min(remaining, static_cast<std::size_t>(policy_.limits.maxNodeTextChars));
  }

  std::optional<std::string> Bounded(std::wstring_view value) {
    const std::size_t budget = FieldBudget();
    if (value.size() > budget) {
      Truncate("max_text");
      if (budget == 0) return std::nullopt;
    }
    const auto kept = text::TruncateUtf16(value, budget);
    textUsed_ += kept.size();
    return text::ToUtf8(kept);
  }

  std::optional<std::string> ReadName(IUIAutomationElement* element, protocol::NodeRecord& node) {
    if (FieldBudget() == 0) {
      Truncate("max_text");
      return std::nullopt;
    }
    Bstr name;
    if (FAILED(element->get_CurrentName(name.Put()))) {
      node.missing.push_back("name");
      return std::nullopt;
    }
    return Bounded(name.View());
  }

  bool LiveScopedDocumentAuthorized(IUIAutomationElement* element, bool word) {
    ComPtr<IUIAutomationElement> current = element;
    const std::array<long, 4> types = word
      ? std::array<long, 4>{classify::kDocument, classify::kPane, classify::kPane, classify::kWindow}
      : std::array<long, 4>{classify::kEdit, classify::kText, classify::kGroup, classify::kGroup};
    const std::array<std::wstring_view, 4> classes = {L"_WwG", L"_WwB", L"_WwF", L"OpusApp"};
    HWND childHandle = nullptr;
    for (std::size_t i = 0; i < types.size(); ++i) {
      int pid = 0;
      CONTROLTYPEID type = 0;
      Bstr id;
      Variant password;
      if (!current || FAILED(current->get_CurrentProcessId(&pid)) || static_cast<std::uint32_t>(pid) != pid_ ||
          FAILED(current->get_CurrentControlType(&type)) || type != types[i] ||
          FAILED(current->get_CurrentAutomationId(id.Put())) || id.View() != (!word && i == 3 ? L"workbench.parts.editor" : L"") ||
          policy::IsSensitiveAutomationId(policy_, rule_, id.View()) ||
          FAILED(current->GetCurrentPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, password.Put())) ||
          password.Get().vt != VT_BOOL || password.Get().boolVal != VARIANT_FALSE) return false;
      if (word) {
        Bstr className;
        UIA_HWND handle = nullptr;
        wchar_t nativeClass[256]{};
        if (FAILED(current->get_CurrentClassName(className.Put())) || className.View() != classes[i] ||
            FAILED(current->get_CurrentNativeWindowHandle(&handle)) || !handle) return false;
        const HWND hwnd = reinterpret_cast<HWND>(handle);
        DWORD owner = 0;
        GetWindowThreadProcessId(hwnd, &owner);
        if (owner != pid_ || !GetClassNameW(hwnd, nativeClass, 256) || std::wstring_view(nativeClass) != classes[i] ||
            (childHandle && GetParent(childHandle) != hwnd) || (i == 3 && hwnd != rootHwnd_)) return false;
        childHandle = hwnd;
      }
      if (i + 1 < types.size()) {
        ComPtr<IUIAutomationElement> parent;
        if (FAILED(walker_->GetParentElement(current.Get(), &parent))) return false;
        current = std::move(parent);
      }
    }
    return true;
  }

  void ReadDocument(IUIAutomationElement* element, protocol::NodeRecord& node) {
    ComPtr<IUIAutomationTextPattern> pattern;
    if (FAILED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern))) || !pattern) {
      node.missing.push_back("text");
      return;
    }
    // Visible ranges are provider-reported; they are not proof of on-screen pixels.
    ComPtr<IUIAutomationTextRangeArray> ranges;
    if (FAILED(pattern->GetVisibleRanges(&ranges)) || !ranges) {
      node.missing.push_back("visibleText");
    }
    int count = 0;
    if (ranges) ranges->get_Length(&count);
    std::wstring visible;
    for (int i = 0; i < count && i < 64; ++i) {
      const std::size_t room = FieldBudget();
      if (visible.size() >= room) break;
      ComPtr<IUIAutomationTextRange> item;
      Bstr part;
      if (FAILED(ranges->GetElement(i, &item)) || !item ||
          FAILED(item->GetText(static_cast<int>(room - visible.size()) + 1, part.Put()))) {
        node.missing.push_back("visibleText");
        break;
      }
      if (!visible.empty()) visible.push_back(L'\n');
      visible.append(part.View());
    }
    if (ranges) node.visibleText = Bounded(visible);
    if (Expired()) { Truncate("budget_ms"); return; }
    ComPtr<IUIAutomationTextRange> range;
    Bstr text;
    const int limit = static_cast<int>(FieldBudget()) + 1;
    if (limit > 1 && SUCCEEDED(pattern->get_DocumentRange(&range)) && range && SUCCEEDED(range->GetText(limit, text.Put()))) {
      node.text = Bounded(text.View());
    } else if (limit > 1) {
      node.missing.push_back("text");
    } else {
      Truncate("max_text");
    }

  }

  bool LiveGenericTextAuthorized(IUIAutomationElement* element, const protocol::NodeRecord& node) {
    int pid = 0;
    CONTROLTYPEID type = 0;
    Variant password;
    return rule_.captureText && !browser_ && SUCCEEDED(element->get_CurrentProcessId(&pid)) && static_cast<std::uint32_t>(pid) == pid_ &&
      SUCCEEDED(element->get_CurrentControlType(&type)) && type == node.controlType &&
      (type == classify::kEdit || type == classify::kDocument) &&
      SUCCEEDED(element->GetCurrentPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, password.Put())) &&
      password.Get().vt == VT_BOOL && password.Get().boolVal == VARIANT_FALSE && NativePassword(element) == false;
  }

  bool LiveSearchAuthorized(IUIAutomationElement* element, const protocol::NodeRecord& node) {
    if (LiveGenericTextAuthorized(element, node)) return node.controlType == classify::kEdit;
    BOOL focused = FALSE;
    int pid = 0;
    CONTROLTYPEID type = 0;
    Bstr id;
    Variant password;
    return SUCCEEDED(element->get_CurrentHasKeyboardFocus(&focused)) && focused &&
           SUCCEEDED(element->get_CurrentProcessId(&pid)) && static_cast<std::uint32_t>(pid) == pid_ &&
           SUCCEEDED(element->get_CurrentControlType(&type)) && type == classify::kEdit &&
           SUCCEEDED(element->get_CurrentAutomationId(id.Put())) && text::ToUtf8(id.View()) == node.automationId &&
           policy::MatchesSelector(rule_.searchFields, type, id.View()) &&
           SUCCEEDED(element->GetCurrentPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, password.Put())) &&
           password.Get().vt == VT_BOOL && password.Get().boolVal == VARIANT_FALSE && NativePassword(element) == false;
  }

  void ReadSearchValue(IUIAutomationElement* element, protocol::NodeRecord& node) {
    const auto redact = [&] {
      node.name.reset();
      node.value.reset();
      node.focused = false;
      node.redaction = classify::RedactionCode(classify::Redaction::EditControl);
    };
    // Recheck the exact selector, live focus and non-password status around content reads.
    if (!LiveSearchAuthorized(element, node)) {
      redact();
      return;
    }
    node.name = ReadName(element, node);
    ComPtr<IUIAutomationValuePattern> pattern;
    Bstr value;
    if (FAILED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&pattern))) || !pattern ||
        FAILED(pattern->get_CurrentValue(value.Put()))) {
      node.missing.push_back("value");
      return;
    }
    if (FieldBudget() == 0) {
      Truncate("max_text");
      return;
    }
    node.value = Bounded(value.View());
    if (!LiveSearchAuthorized(element, node)) redact();
  }

  std::string RuntimeId(IUIAutomationElement* element) const {
    SafeArray owned;
    if (FAILED(element->GetRuntimeId(owned.Put())) || !owned.Get()) return {};
    LONG low = 0, high = -1;
    if (FAILED(SafeArrayGetLBound(owned.Get(), 1, &low)) || FAILED(SafeArrayGetUBound(owned.Get(), 1, &high))) return {};
    std::string id;
    for (LONG i = low; i <= high && i - low < 16; ++i) {
      LONG value = 0;
      if (FAILED(SafeArrayGetElement(owned.Get(), &i, &value))) break;
      id += "." + std::to_string(value);
    }
    return id;
  }

  int Priority(IUIAutomationElement* element) {
    if (focusPath_.contains(RuntimeId(element))) return 100;
    if (CachedBool(element, UIA_IsOffscreenPropertyId, false).value_or(false)) return -1;
    CONTROLTYPEID type = 0;
    element->get_CachedControlType(&type);
    if (type == classify::kDocument) return 80;
    if (type == classify::kEdit) return 70;
    if (type == classify::kPane || type == classify::kGroup || type == classify::kCustom) return 40;
    return 10;
  }

  bool LiveContentAllowed(IUIAutomationElement* element) {
    Variant password;
    Bstr id;
    if (NativePassword(element) == true) return false;
    if (SUCCEEDED(element->GetCurrentPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, password.Put())) &&
        password.Get().vt == VT_BOOL && password.Get().boolVal == VARIANT_TRUE) return false;
    if (CachedBool(element, UIA_IsLegacyIAccessiblePatternAvailablePropertyId, false).value_or(false)) {
      ComPtr<IUIAutomationLegacyIAccessiblePattern> legacy;
      DWORD state = 0;
      if (SUCCEEDED(element->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, IID_PPV_ARGS(&legacy))) && legacy &&
          SUCCEEDED(legacy->get_CurrentState(&state)) && (state & STATE_SYSTEM_PROTECTED) != 0) return false;
    }
    return FAILED(element->get_CurrentAutomationId(id.Put())) || !policy::IsSensitiveAutomationId(policy_, rule_, id.View());
  }

  bool VisitGeneric(IUIAutomationElement* element, int depth, int parent, protocol::WorkerResponse& response, bool& traverse) {
    if (response.nodes.size() >= static_cast<std::size_t>(policy_.limits.maxNodes)) { Truncate("max_nodes"); return false; }
    protocol::NodeRecord node;
    node.depth = depth; node.parent = parent;
    CONTROLTYPEID type = classify::kCustom;
    element->get_CachedControlType(&type);
    node.controlType = classify::ControlTypeName(type) ? type : classify::kCustom;
    int owner = 0;
    if (SUCCEEDED(element->get_CachedProcessId(&owner)) &&
        std::find(policy_.deniedPids.begin(), policy_.deniedPids.end(), static_cast<std::uint32_t>(owner)) != policy_.deniedPids.end()) {
      ++response.stats.foreignSkipped; return true;
    }
    node.runtimeId = RuntimeId(element);
    if (node.runtimeId.empty()) node.missing.push_back("runtimeId");
    Bstr id;
    if (SUCCEEDED(element->get_CachedAutomationId(id.Put()))) node.automationId = text::ToUtf8(text::TruncateUtf16(id.View(), kMaxAutomationIdChars));
    else node.missing.push_back("automationId");
    const auto provider = CachedBool(element, UIA_IsPasswordPropertyId, true);
    node.password = provider == true || NativePassword(element) == true ? std::optional<bool>(true) : provider;
    node.focused = CachedBool(element, UIA_HasKeyboardFocusPropertyId, false).value_or(false);
    node.providerOffscreen = CachedBool(element, UIA_IsOffscreenPropertyId, false).value_or(false);
    RECT bounds{};
    if (SUCCEEDED(element->get_CachedBoundingRectangle(&bounds))) node.bounds = std::array<double,4>{static_cast<double>(bounds.left), static_cast<double>(bounds.top), static_cast<double>(bounds.right-bounds.left), static_cast<double>(bounds.bottom-bounds.top)};
    else node.missing.push_back("bounds");
    const bool sensitive = policy::IsSensitiveAutomationId(policy_, rule_, id.View());
    if (sensitive || node.password == true || !LiveContentAllowed(element)) {
      if (!sensitive) node.password = true;
      node.redaction = sensitive ? "sensitive_id" : "password";
      ++response.stats.redacted;
    } else if (!node.providerOffscreen || focusPath_.contains(node.runtimeId)) {
      // Read actual capabilities, including controls whose role is Custom or DataItem.
      if (CachedBool(element, UIA_IsTextPatternAvailablePropertyId, false).value_or(false) && !Expired()) {
        ReadDocument(element, node);
        node.documentStatus = node.text || node.visibleText ? "available" : "read_failed";
      }
      if ((!node.text || node.text->empty()) && !Expired()) {
        ComPtr<IUIAutomationValuePattern> value;
        Bstr content;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) && value && SUCCEEDED(value->get_CurrentValue(content.Put()))) {
          const auto sanitized = rule_.browser != browser::Kind::None && node.controlType == classify::kDocument ? browser::SanitizeUrl(content.View()) : std::wstring{};
          node.value = Bounded(sanitized.empty() ? content.View() : std::wstring_view(sanitized)); node.valueSource = "uia.value";
        }
        if ((!node.value || node.value->empty()) && !Expired()) {
          ComPtr<IUIAutomationLegacyIAccessiblePattern> legacy;
          Bstr legacyValue;
          if (SUCCEEDED(element->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, IID_PPV_ARGS(&legacy))) && legacy &&
              SUCCEEDED(legacy->get_CurrentValue(legacyValue.Put())) && !legacyValue.View().empty()) {
            node.value = Bounded(legacyValue.View()); node.valueSource = "uia.legacy_value";
          }
        }
      }
      if (!Expired()) node.name = ReadName(element, node);
      if (!LiveContentAllowed(element)) {
        node.name.reset(); node.text.reset(); node.visibleText.reset(); node.value.reset(); node.valueSource.clear(); node.documentStatus.clear();
        node.password = true; node.redaction = "password"; ++response.stats.redacted;
      }
    }
    // Nested wrappers sometimes expose the exact same document twice. Keep node
    // identity/focus/labels, but spend the content budget only once per ancestry.
    for (int ancestor = parent; ancestor >= 0; ancestor = response.nodes[static_cast<std::size_t>(ancestor)].parent) {
      const auto& preceding = response.nodes[static_cast<std::size_t>(ancestor)];
      if (node.controlType != preceding.controlType || node.name != preceding.name) continue;
      const auto dedupe = [&](std::optional<std::string>& field, const std::optional<std::string>& previous) {
        if (field && previous && *field == *previous) {
          textUsed_ -= std::min(textUsed_, text::Utf16Length(*field).value_or(0)); field.reset();
        }
      };
      dedupe(node.text, preceding.text); dedupe(node.visibleText, preceding.visibleText);
      if (node.valueSource == preceding.valueSource) dedupe(node.value, preceding.value);
    }
    if (!node.text && !node.visibleText && node.documentStatus == "available") node.documentStatus.clear();
    if (!node.value) node.valueSource.clear();
    traverse = node.redaction.empty() && (!node.providerOffscreen || focusPath_.contains(node.runtimeId));
    response.stats.missingProperties += node.missing.size();
    response.nodes.push_back(std::move(node)); ++response.stats.emitted;
    return true;
  }

  // Returns false to stop the traversal (node limit).
  bool Visit(IUIAutomationElement* element, int depth, int parent, protocol::WorkerResponse& response,
             bool& traverse) {
    if (rule_.captureText) return VisitGeneric(element, depth, parent, response, traverse);
    int processId = 0;
    if (FAILED(element->get_CachedProcessId(&processId)) || static_cast<std::uint32_t>(processId) != pid_) {
      // Content hosted by another process is outside this authorization.
      ++response.stats.foreignSkipped;
      return true;
    }
    CONTROLTYPEID controlType = 0;
    if (FAILED(element->get_CachedControlType(&controlType))) {
      ++response.stats.missingProperties;
      return true;  // unclassifiable: neither emitted nor traversed
    }
    if (classify::ControlTypeName(controlType) == nullptr) controlType = classify::kCustom;
    if (browser_ && controlType == UIA_DocumentControlTypeId && depth > 0) return true;

    if (response.nodes.size() >= static_cast<std::size_t>(policy_.limits.maxNodes)) {
      Truncate("max_nodes");
      return false;
    }

    protocol::NodeRecord node;
    node.controlType = controlType;
    node.depth = depth;
    node.parent = parent;

    Bstr automationId;
    if (FAILED(element->get_CachedAutomationId(automationId.Put()))) node.missing.push_back("automationId");
    const std::wstring fullId(automationId.View());
    node.automationId = text::ToUtf8(text::TruncateUtf16(fullId, kMaxAutomationIdChars));
    if (policy::HasWordDocumentScope(rule_)) {
      Bstr className;
      if (SUCCEEDED(element->get_CachedClassName(className.Put())) &&
          (className.View() == L"_WwG" || className.View() == L"_WwB" || className.View() == L"_WwF" || className.View() == L"OpusApp"))
        node.className = text::ToUtf8(className.View());
    }

    const auto password = EffectivePasswordState(CachedBool(element, UIA_IsPasswordPropertyId, true), NativePassword(element));
    node.password = password;
    BOOL focus = FALSE;
    BOOL offscreen = FALSE;
    element->get_CachedHasKeyboardFocus(&focus);
    element->get_CachedIsOffscreen(&offscreen);
    node.focused = focus != FALSE;
    node.providerOffscreen = offscreen != FALSE;

    Variant runtimeId;
    if (SUCCEEDED(element->GetCachedPropertyValue(UIA_RuntimeIdPropertyId, runtimeId.Put())) &&
        runtimeId.Get().vt == (VT_ARRAY | VT_I4) && runtimeId.Get().parray != nullptr) {
      SAFEARRAY* array = runtimeId.Get().parray;
      LONG lower = 0, upper = -1;
      SafeArrayGetLBound(array, 1, &lower);
      SafeArrayGetUBound(array, 1, &upper);
      for (LONG i = lower; i <= upper && i - lower < 16; ++i) {
        int part = 0;
        if (FAILED(SafeArrayGetElement(array, &i, &part))) break;
        if (!node.runtimeId.empty()) node.runtimeId.push_back('.');
        node.runtimeId += std::to_string(part);
      }
    }
    if (node.runtimeId.empty()) node.missing.push_back("runtimeId");

    RECT rect{};
    if (SUCCEEDED(element->get_CachedBoundingRectangle(&rect))) {
      node.bounds = std::array<double, 4>{static_cast<double>(rect.left), static_cast<double>(rect.top),
                                          static_cast<double>(rect.right - rect.left),
                                          static_cast<double>(rect.bottom - rect.top)};
    } else {
      node.missing.push_back("bounds");
    }

    classify::NodeFacts facts;
    facts.controlType = controlType;
    facts.password = !password ? classify::PasswordState::Unknown
                     : *password ? classify::PasswordState::True
                                 : classify::PasswordState::False;
    facts.automationId = fullId;
    facts.hasKeyboardFocus = node.focused;
    facts.textPatternAvailable = CachedBool(element, UIA_IsTextPatternAvailablePropertyId, false).value_or(false);
    facts.valuePatternAvailable = CachedBool(element, UIA_IsValuePatternAvailablePropertyId, false).value_or(false);
    const bool wordDocument = protocol::IsWordDocument(node, response.nodes, rule_);
    facts.scopedDocument = wordDocument || protocol::IsVsCodeEditorBody(node, response.nodes, rule_);
    // A long AutomationId that had to be truncated cannot match an exact selector.
    if (fullId.size() > kMaxAutomationIdChars) facts.automationId = {};
    const classify::NodeDecision decision = classify::Classify(facts, policy_, rule_);

    if (decision.redaction != classify::Redaction::None) {
      node.redaction = classify::RedactionCode(decision.redaction);
      ++response.stats.redacted;
    }
    const bool liveDocument = !facts.scopedDocument || LiveScopedDocumentAuthorized(element, wordDocument);
    const bool browserReadable = !browser_ || protocol::BrowserNodeContentAllowed(node, *browser_);
    if (decision.readName && (!decision.readSearchValue || decision.readDocumentText) && liveDocument && browserReadable) node.name = ReadName(element, node);
    const bool genericText = rule_.captureText && !browser_ &&
      (controlType == classify::kEdit || controlType == classify::kDocument);
    if (decision.readDocumentText && !Expired() && liveDocument && (!genericText || LiveGenericTextAuthorized(element, node))) ReadDocument(element, node);
    if (decision.readDocumentText && facts.scopedDocument) {
      if (!liveDocument || !LiveScopedDocumentAuthorized(element, wordDocument)) { node.name.reset(); node.text.reset(); }
      protocol::FinalizeScopedDocument(node);
      if (!node.redaction.empty()) ++response.stats.redacted;
    }
    if (genericText && decision.readDocumentText && !facts.scopedDocument) {
      if (!LiveGenericTextAuthorized(element, node)) { node.name.reset(); node.text.reset(); node.visibleText.reset(); }
      protocol::FinalizeScopedDocument(node);
      if (!node.redaction.empty()) ++response.stats.redacted;
    }
    if (decision.readSearchValue && !Expired() && !(genericText && decision.readDocumentText)) {
      ReadSearchValue(element, node);
      // Cover failed ValuePattern/Name reads too: cached authorization is never sufficient.
      if (!LiveSearchAuthorized(element, node)) {
        node.name.reset();
        node.value.reset();
        node.focused = false;
        node.redaction = classify::RedactionCode(classify::Redaction::EditControl);
      }
      if (!node.redaction.empty()) ++response.stats.redacted;
    }
    if (genericText && decision.redaction == classify::Redaction::None && !LiveGenericTextAuthorized(element, node)) {
      node.name.reset(); node.text.reset(); node.visibleText.reset(); node.value.reset();
      node.documentStatus.clear(); node.password.reset(); node.redaction = "unknown_password";
    }
    // A password style can change while the provider is answering. Discard all content,
    // including Name, and prune descendants if the final native check is unsafe.
    const auto finalNative = NativePassword(element);
    if (browser_ && node.name) {
      BOOL hidden = TRUE;
      RECT live{};
      Variant currentPassword;
      if (FAILED(element->get_CurrentIsOffscreen(&hidden)) || hidden || FAILED(element->get_CurrentBoundingRectangle(&live)) ||
          FAILED(element->GetCurrentPropertyValueEx(UIA_IsPasswordPropertyId, TRUE, currentPassword.Put())) ||
          currentPassword.Get().vt != VT_BOOL || currentPassword.Get().boolVal != VARIANT_FALSE ||
          !node.bounds || (*node.bounds)[0] != live.left || (*node.bounds)[1] != live.top ||
          (*node.bounds)[2] != live.right - live.left || (*node.bounds)[3] != live.bottom - live.top) node.name.reset();
    }
    if (finalNative != false) {
      node.name.reset(); node.value.reset(); node.text.reset(); node.visibleText.reset();
      node.documentStatus.clear();
      node.password = EffectivePasswordState(password, finalNative);
      if (node.redaction.empty()) ++response.stats.redacted;
      facts.password = node.password == true ? classify::PasswordState::True : classify::PasswordState::Unknown;
      node.redaction = classify::RedactionCode(classify::Classify(facts, policy_, rule_).redaction);
    }
    response.stats.missingProperties += node.missing.size();

    response.nodes.push_back(std::move(node));
    ++response.stats.emitted;
    traverse = decision.traverseChildren && finalNative == false && (!genericText || node.password == false);
    return true;
  }

  const policy::Policy& policy_;
  const policy::AppRule& rule_;
  const std::uint32_t pid_;
  const double started_;
  ComPtr<IUIAutomation> automation_;
  std::set<std::string> focusPath_;
  ComPtr<IUIAutomationCacheRequest> cache_;
  ComPtr<IUIAutomationTreeWalker> walker_;
  std::size_t textUsed_ = 0;
  double budgetRatio_ = 1.0;
  std::vector<std::string> truncation_;
  HWND rootHwnd_ = nullptr;
  const protocol::BrowserContext* browser_;
};

// MSAA is a window-scoped fallback for providers not represented by UIA's bridge.
// It uses the same record, budgets, positive password filtering and persistence pipeline.
protocol::WorkerResponse ReadLegacy(HWND window, const policy::Policy& policy, const policy::AppRule& rule, double started) {
  protocol::WorkerResponse result;
  ComPtr<IAccessible> root;
  if (FAILED(AccessibleObjectFromWindow(window, static_cast<DWORD>(OBJID_CLIENT), IID_PPV_ARGS(&root))) || !root) return result;
  struct Frame { ComPtr<IAccessible> object; LONG child; int depth; int parent; };
  std::vector<Frame> stack{{root, CHILDID_SELF, 0, -1}};
  std::size_t textUsed = 0;
  const auto truncate = [&](const char* reason) {
    if (std::find(result.truncation.begin(), result.truncation.end(), reason) == result.truncation.end()) result.truncation.push_back(reason);
  };
  const auto bounded = [&](std::wstring_view text) {
    const auto remaining = textUsed >= static_cast<std::size_t>(policy.limits.maxTextChars) ? 0 : static_cast<std::size_t>(policy.limits.maxTextChars) - textUsed;
    const auto kept = text::TruncateUtf16(text, std::min(remaining, static_cast<std::size_t>(policy.limits.maxNodeTextChars)));
    if (kept.size() < text.size()) truncate("max_text");
    textUsed += kept.size(); return text::ToUtf8(kept);
  };
  while (!stack.empty()) {
    if (MonotonicMs() - started >= policy.limits.queryBudgetMs) { result.truncation.push_back("budget_ms"); break; }
    if (result.nodes.size() >= static_cast<std::size_t>(policy.limits.maxNodes) || result.stats.visited >= static_cast<std::size_t>(policy.limits.maxVisited)) {
      result.truncation.push_back("max_nodes"); break;
    }
    auto frame = std::move(stack.back()); stack.pop_back(); ++result.stats.visited;
    HWND ownerWindow = nullptr;
    WindowFromAccessibleObject(frame.object.Get(), &ownerWindow);
    if (ownerWindow && ownerWindow != window && !IsChild(window, ownerWindow)) { ++result.stats.foreignSkipped; continue; }
    if (!ownerWindow) ownerWindow = window; // windowless descendants are scoped by the root traversal
    VARIANT child; VariantInit(&child); child.vt = VT_I4; child.lVal = frame.child;
    Variant state, role;
    frame.object->get_accState(child, state.Put()); frame.object->get_accRole(child, role.Put());
    const LONG flags = state.Get().vt == VT_I4 ? state.Get().lVal : 0;
    if ((flags & (STATE_SYSTEM_INVISIBLE | STATE_SYSTEM_OFFSCREEN)) != 0) continue;
    protocol::NodeRecord node;
    node.parent = frame.parent; node.depth = frame.depth;
    node.runtimeId = "msaa." + std::to_string(FromHwnd(ownerWindow)) + "." + std::to_string(result.stats.visited);
    const LONG kind = role.Get().vt == VT_I4 ? role.Get().lVal : 0;
    node.controlType = kind == ROLE_SYSTEM_DOCUMENT ? classify::kDocument : kind == ROLE_SYSTEM_TEXT ? classify::kEdit
      : kind == ROLE_SYSTEM_STATICTEXT ? classify::kText : classify::kCustom;
    node.automationId = std::to_string(GetDlgCtrlID(ownerWindow));
    node.focused = (flags & STATE_SYSTEM_FOCUSED) != 0;
    DWORD owner = 0; GetWindowThreadProcessId(ownerWindow, &owner);
    node.password = (flags & STATE_SYSTEM_PROTECTED) != 0 || NativePasswordState(ownerWindow, owner) == true;
    if (node.password == true || policy::IsSensitiveAutomationId(policy, rule, text::FromUtf8(node.automationId).value_or(L""))) {
      node.redaction = node.password == true ? "password" : "sensitive_id"; ++result.stats.redacted;
    } else {
      Bstr value, name;
      if (SUCCEEDED(frame.object->get_accValue(child, value.Put())) && !value.View().empty()) {
        node.value = bounded(value.View()); node.valueSource = "msaa.value";
      } else if (SUCCEEDED(frame.object->get_accName(child, name.Put())) && !name.View().empty()) {
        node.value = bounded(name.View()); node.valueSource = "msaa.name";
      }
      Variant after;
      frame.object->get_accState(child, after.Put());
      if ((after.Get().vt == VT_I4 && (after.Get().lVal & STATE_SYSTEM_PROTECTED) != 0) || NativePasswordState(ownerWindow, owner) == true) {
        node.value.reset(); node.valueSource.clear(); node.password = true; node.redaction = "password"; ++result.stats.redacted;
      }
    }
    const int self = static_cast<int>(result.nodes.size());
    const bool descend = node.redaction.empty() && frame.child == CHILDID_SELF;
    result.nodes.push_back(std::move(node)); ++result.stats.emitted;
    if (!descend) continue;
    LONG count = 0;
    if (FAILED(frame.object->get_accChildCount(&count)) || count <= 0) continue;
    if (frame.depth >= policy.limits.maxDepth) { truncate("max_depth"); continue; }
    const auto used = result.stats.visited + stack.size();
    const auto available = used >= static_cast<std::size_t>(policy.limits.maxVisited) ? 0 : static_cast<std::size_t>(policy.limits.maxVisited) - used;
    const LONG room = std::min(count, static_cast<LONG>(available));
    if (room < count) truncate("max_visited");
    if (room == 0) continue;
    std::vector<VARIANT> children(static_cast<std::size_t>(room));
    for (auto& item : children) VariantInit(&item);
    LONG fetched = 0;
    if (SUCCEEDED(AccessibleChildren(frame.object.Get(), 0, room, children.data(), &fetched))) {
      for (LONG i = fetched; i > 0; --i) {
        const auto& item = children[static_cast<std::size_t>(i-1)];
        if (item.vt == VT_DISPATCH && item.pdispVal) {
          ComPtr<IAccessible> object;
          if (SUCCEEDED(item.pdispVal->QueryInterface(IID_PPV_ARGS(&object)))) stack.push_back({object, CHILDID_SELF, frame.depth+1, self});
        } else if (item.vt == VT_I4 && item.lVal != CHILDID_SELF) stack.push_back({frame.object, item.lVal, frame.depth+1, self});
      }
    }
    for (auto& item : children) VariantClear(&item);
  }
  result.truncated = !result.truncation.empty();
  return result;
}

protocol::WorkerResponse Finish(protocol::WorkerResponse response, const char* status, const char* reason,
                                double started) {
  response.status = status;
  response.reason = reason;
  if (response.status != "ok") {
    response.nodes.clear();
    response.truncated = false;
    response.truncation.clear();
    if (response.context) { response.context->browser.reset(); response.context->title.reset(); }
  }
  response.elapsedMs = MonotonicMs() - started;
  return response;
}

#if MEMMY_HISTORY_TEST_HOOKS
// Test-only synchronization: lets the harness act between the worker's first identity check
// and its UIA read. Compiled out of the production executable.
const char* RunTestGate(const protocol::WorkerRequest& request) {
  if (!request.testGate.empty()) {
    const auto gate = text::FromUtf8(request.testGate).value_or(L"");
    if (gate.rfind(L"Local\\memmy-history-test-", 0) != 0) return "test_gate_failed";
    UniqueHandle ready = Own(OpenEventW(EVENT_MODIFY_STATE, FALSE, (gate + L".ready").c_str()));
    UniqueHandle resume = Own(OpenEventW(SYNCHRONIZE, FALSE, (gate + L".continue").c_str()));
    if (!ready || !resume) return "test_gate_failed";
    SetEvent(ready.get());
    if (WaitForSingleObject(resume.get(), 20000) != WAIT_OBJECT_0) return "test_gate_timeout";
  }
  if (request.testSleepMs > 0) Sleep(request.testSleepMs);
  return nullptr;
}
#endif

}  // namespace

protocol::WorkerResponse ReadSnapshot(const protocol::WorkerRequest& request, const policy::Policy& policy) {
  const double started = MonotonicMs();
  protocol::WorkerResponse response;
  std::string reason;
  const auto before = ReadWindowContext(request.hwnd, reason);
  if (!before) return Finish(std::move(response), "blocked", reason.c_str(), started);
  if (before->pid != request.pid || before->processStart != request.processStart ||
      before->executable != request.executable) {
    return Finish(std::move(response), "blocked", "context_changed", started);
  }
  const policy::Decision decision = policy::Evaluate(policy, ToTarget(*before), CanonicalizePath);
  if (decision.verdict != policy::Verdict::Allowed || decision.rule == nullptr) {
    return Finish(std::move(response), "blocked", decision.reason, started);
  }
  response.context = before;
  if (ForegroundWindow() != request.hwnd) return Finish(std::move(response), "blocked", "not_foreground", started);

#if MEMMY_HISTORY_TEST_HOOKS
  if (const char* gateFailure = RunTestGate(request)) {
    return Finish(std::move(response), "unavailable", gateFailure, started);
  }
#endif

  ComScope com(COINIT_MULTITHREADED);
  if (!com.Ok()) return Finish(std::move(response), "unavailable", "com_unavailable", started);
  ComPtr<IUIAutomation> automation;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation))) &&
      FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)))) {
    return Finish(std::move(response), "unavailable", "uia_unavailable", started);
  }
  // Per-call cross-process timeouts. A hung provider can still stall a call, which is why the
  // collector additionally kills this whole process at workerTimeoutMs.
  ComPtr<IUIAutomation2> automation2;
  if (SUCCEEDED(automation.As(&automation2))) {
    const DWORD budget = static_cast<DWORD>(policy.limits.queryBudgetMs);
    automation2->put_ConnectionTimeout(budget);
    automation2->put_TransactionTimeout(budget);
  }

  RequestAccessibility(ToHwnd(request.hwnd));
  Traversal traversal(policy, *decision.rule, before->pid, started);
  if (decision.rule->captureText) traversal.ReserveFallbackTime();
  if (!traversal.Init(automation.Get())) return Finish(std::move(response), "unavailable", "uia_error", started);
  ComPtr<IUIAutomationElement> root;
  if (FAILED(automation->ElementFromHandleBuildCache(reinterpret_cast<UIA_HWND>(ToHwnd(request.hwnd)),
                                                    traversal.Cache(), &root)) ||
      !root) {
    return Finish(std::move(response), "unavailable", "uia_root_unavailable", started);
  }
  int rootPid = 0;
  if (!decision.rule->captureText && (FAILED(root->get_CachedProcessId(&rootPid)) || static_cast<std::uint32_t>(rootPid) != before->pid)) {
    return Finish(std::move(response), "blocked", "foreign_root", started);
  }
  UIA_HWND providerWindow = nullptr;
  if (decision.rule->captureText && SUCCEEDED(root->get_CurrentNativeWindowHandle(&providerWindow)) && providerWindow &&
      reinterpret_cast<HWND>(providerWindow) != ToHwnd(request.hwnd) && !IsChild(ToHwnd(request.hwnd), reinterpret_cast<HWND>(providerWindow)))
    return Finish(std::move(response), "blocked", "foreign_root", started);
  const auto pageBefore = decision.rule->browser != browser::Kind::None
    ? ProbeBrowser(automation.Get(), root.Get(), before->pid, decision.rule->browser,
        std::min(started + policy.limits.queryBudgetMs, MonotonicMs() + 150.0), L"") : std::nullopt;
  ComPtr<IUIAutomationElement> contentRoot = root;
  if (pageBefore) {
    ComPtr<IUIAutomationElement> document;
    if (SUCCEEDED(pageBefore->document->BuildUpdatedCache(traversal.Cache(), &document)) && document) contentRoot = std::move(document);
  }
  traversal.Run(contentRoot.Get(), response);
  const auto rich = [](const protocol::WorkerResponse& sample) {
    return std::count_if(sample.nodes.begin(), sample.nodes.end(), [](const auto& node) {
      return node.text && !node.text->empty();
    });
  };
  // Fallback stays inside the same HWND subtree and the original worker deadline.
  if (decision.rule->captureText && rich(response) == 0 && MonotonicMs() - started < policy.limits.queryBudgetMs * 0.8) {
    Traversal raw(policy, *decision.rule, before->pid, started);
    if (raw.Init(automation.Get(), true)) {
      ComPtr<IUIAutomationElement> rawRoot;
      if (SUCCEEDED(contentRoot->BuildUpdatedCache(raw.Cache(), &rawRoot)) && rawRoot) {
        protocol::WorkerResponse fallback; fallback.context = before;
        raw.Run(rawRoot.Get(), fallback);
        if (rich(fallback) > rich(response)) response = std::move(fallback);
      }
    }
  }
  if (decision.rule->captureText && rich(response) == 0 && MonotonicMs() - started < policy.limits.queryBudgetMs * 0.9) {
    auto legacy = ReadLegacy(ToHwnd(request.hwnd), policy, *decision.rule, started);
    const bool hasContent = std::any_of(legacy.nodes.begin(), legacy.nodes.end(), [](const auto& node) {
      return node.value && !node.value->empty() && (node.valueSource == "msaa.value" ||
        node.controlType == classify::kText || node.controlType == classify::kEdit || node.controlType == classify::kDocument);
    });
    if (hasContent) { legacy.context = before; response = std::move(legacy); }
  }
  // URL is optional enrichment. A missing or ambiguous URL never discards text.
  if (decision.rule->browser != browser::Kind::None && MonotonicMs() - started < policy.limits.queryBudgetMs) {
    const auto page = ProbeBrowser(automation.Get(), root.Get(), before->pid, decision.rule->browser,
      started + policy.limits.queryBudgetMs, L"");
    if (page) {
      const bool capturedDocument = std::any_of(response.nodes.begin(), response.nodes.end(), [&](const auto& node) {
        return node.controlType == classify::kDocument && node.runtimeId == page->context.documentId;
      });
      // A cold accessibility tree can appear during the read. Bind optional metadata
      // to the document actually captured, rather than dropping the first sample.
      if (pageBefore ? SameBrowserPage(automation.Get(), *pageBefore, *page) : capturedDocument) response.context->browser = page->context;
    }
  }

  const auto after = ReadWindowContext(request.hwnd, reason);
  if (!after || !protocol::SameInstance(*before, *after) || ForegroundWindow() != request.hwnd) {
    return Finish(std::move(response), "blocked", "context_changed", started);
  }
  response.context->title = ReadWindowTitle(request.hwnd, kMaxTitleChars);
  return Finish(std::move(response), "ok", "", started);
}

int WorkerMain() {
  const double started = MonotonicMs();
  const auto respond = [&](const protocol::WorkerResponse& response) {
    return WriteStdout(DumpJson(protocol::WorkerResponseToJson(response)) + "\n") ? 0 : 1;
  };
  const auto fail = [&](const char* status, const char* reason) {
    return respond(Finish(protocol::WorkerResponse{}, status, reason, started));
  };
  try {
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    std::string bytes;
    char buffer[16 * 1024];
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(input, buffer, sizeof(buffer), &read, nullptr) || read == 0) break;
      bytes.append(buffer, read);
      if (bytes.size() > protocol::kMaxWorkerRequestBytes) return fail("blocked", "worker_invalid_request");
    }
    const auto json = ParseJsonStrict(bytes, 8);
    protocol::WorkerRequest request;
    if (!json || !protocol::WorkerRequestFromJson(*json, MEMMY_HISTORY_TEST_HOOKS != 0, request)) {
      return fail("blocked", "worker_invalid_request");
    }
    const auto parsed = policy::Parse(request.policyText);
    if (!parsed.policy) return fail("blocked", "policy_invalid");
    // Last-resort self limit in case the collector cannot kill us (it normally does first).
    const DWORD selfLimit = static_cast<DWORD>(parsed.policy->limits.workerTimeoutMs) + 5000;
    std::thread([selfLimit] {
      Sleep(selfLimit);
      TerminateProcess(GetCurrentProcess(), 0xDEAD);
    }).detach();
    return respond(ReadSnapshot(request, *parsed.policy));
  } catch (const std::bad_alloc&) {
    return fail("unavailable", "out_of_memory");
  } catch (...) {
    return fail("unavailable", "internal_error");
  }
}

}  // namespace memmy::win
