#include "win/uia_reader.h"

#include "common/classify.h"
#include "common/json.h"
#include "common/text.h"
#include "win/identity.h"
#include "win/password.h"
#include "win/raii.h"
#include "win/system.h"

#include <UIAutomation.h>
#include <wrl/client.h>

#include <algorithm>
#include <new>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace memmy::win {
namespace {

constexpr std::size_t kMaxAutomationIdChars = 256;
constexpr std::size_t kMaxTitleChars = 1024;

class Traversal {
 public:
  Traversal(const policy::Policy& policy, const policy::AppRule& rule, std::uint32_t pid, double started)
      : policy_(policy), rule_(rule), pid_(pid), started_(started),
        classDocumentScope_(policy::HasWordDocumentScope(rule) || policy::HasNotepadDocumentScope(rule)) {}

  bool Init(IUIAutomation* automation) {
    if (FAILED(automation->CreateCacheRequest(&cache_))) return false;
    // Metadata only. Name, Value and Text are never cached; they are read per node after the
    // node has been classified.
    for (const PROPERTYID property :
         {UIA_ControlTypePropertyId, UIA_IsPasswordPropertyId, UIA_AutomationIdPropertyId, UIA_ProcessIdPropertyId,
          UIA_HasKeyboardFocusPropertyId, UIA_IsOffscreenPropertyId, UIA_BoundingRectanglePropertyId,
          UIA_RuntimeIdPropertyId, UIA_IsTextPatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId,
          UIA_ClassNamePropertyId, UIA_NativeWindowHandlePropertyId}) {
      if (FAILED(cache_->AddProperty(property))) return false;
    }
    // Fetch one control-view child collection per traversable parent, rather than
    // one provider round trip for every sibling. Never cache Name, Value or Text.
    return SUCCEEDED(cache_->Clone(&childrenCache_)) &&
      SUCCEEDED(childrenCache_->put_TreeScope(TreeScope_Children)) &&
      SUCCEEDED(automation->get_ControlViewWalker(&walker_));
  }

  IUIAutomationCacheRequest* Cache() const { return cache_.Get(); }

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
      ComPtr<IUIAutomationElement> cachedParent;
      ComPtr<IUIAutomationElementArray> cachedChildren;
      int count = 0;
      if (FAILED(frame.element->BuildUpdatedCache(childrenCache_.Get(), &cachedParent)) || !cachedParent ||
          FAILED(cachedParent->GetCachedChildren(&cachedChildren)) ||
          (cachedChildren && FAILED(cachedChildren->get_Length(&count)))) {
        Truncate("traversal_error");
        continue;
      }
      if (count > 0 && frame.depth + 1 > policy_.limits.maxDepth) {
        Truncate("max_depth");
        continue;
      }
      const std::size_t used = static_cast<std::size_t>(response.stats.visited) + stack.size();
      const std::size_t limit = static_cast<std::size_t>(policy_.limits.maxVisited);
      const std::size_t room = used >= limit ? 0 : limit - used;
      for (int index = 0; index < count; ++index) {
        if (children.size() >= room) {
          Truncate("max_visited");
          break;
        }
        if (Expired()) {
          Truncate("budget_ms");
          break;
        }
        ComPtr<IUIAutomationElement> child;
        if (FAILED(cachedChildren->GetElement(index, &child)) || !child) {
          Truncate("traversal_error");
          break;
        }
        children.push_back(std::move(child));
      }
      for (auto it = children.rbegin(); it != children.rend(); ++it) {
        stack.push_back({std::move(*it), frame.depth + 1, self});
      }
    }
    // A provider call on the final leaf can consume the remaining budget even
    // when there is no next frame to enter the loop's deadline check.
    if (Expired()) Truncate("budget_ms");
    response.truncated = !truncation_.empty();
    response.truncation = truncation_;
  }

 private:
  std::optional<bool> NativePassword(IUIAutomationElement* element) const {
    UIA_HWND handle = nullptr;
    if (FAILED(element->get_CurrentNativeWindowHandle(&handle))) return std::nullopt;
    // Windowless UIA elements continue to rely on the provider password property.
    return handle ? NativePasswordState(reinterpret_cast<HWND>(handle), pid_) : std::optional<bool>(false);
  }

  bool Expired() const { return MonotonicMs() - started_ > policy_.limits.queryBudgetMs; }

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

  bool LiveScopedDocumentAuthorized(IUIAutomationElement* element, bool word, bool notepad) {
    ComPtr<IUIAutomationElement> current = element;
    const std::array<long, 4> types = notepad
      ? std::array<long, 4>{classify::kDocument, classify::kPane, classify::kWindow, 0}
      : word
      ? std::array<long, 4>{classify::kDocument, classify::kPane, classify::kPane, classify::kWindow}
      : std::array<long, 4>{classify::kEdit, classify::kText, classify::kGroup, classify::kGroup};
    const std::array<std::wstring_view, 4> classes = notepad
      ? std::array<std::wstring_view, 4>{L"RichEditD2DPT", L"NotepadTextBox", L"Notepad", L""}
      : std::array<std::wstring_view, 4>{L"_WwG", L"_WwB", L"_WwF", L"OpusApp"};
    const std::size_t count = notepad ? 3 : 4;
    HWND childHandle = nullptr;
    for (std::size_t i = 0; i < count; ++i) {
      // A fresh metadata-only cache is one provider call, instead of separate live
      // calls for every property. Refresh again after the body read to detect races.
      ComPtr<IUIAutomationElement> fresh;
      if (!current || FAILED(current->BuildUpdatedCache(cache_.Get(), &fresh)) || !fresh) return false;
      int pid = 0;
      CONTROLTYPEID type = 0;
      Bstr id;
      if (FAILED(fresh->get_CachedProcessId(&pid)) || static_cast<std::uint32_t>(pid) != pid_ ||
          FAILED(fresh->get_CachedControlType(&type)) || type != types[i] ||
          FAILED(fresh->get_CachedAutomationId(id.Put())) || id.View() != (!word && !notepad && i == 3 ? L"workbench.parts.editor" : L"") ||
          policy::IsSensitiveAutomationId(policy_, rule_, id.View()) ||
          CachedBool(fresh.Get(), UIA_IsPasswordPropertyId, true) != false) return false;
      if (word || notepad) {
        Bstr className;
        UIA_HWND handle = nullptr;
        wchar_t nativeClass[256]{};
        if (FAILED(fresh->get_CachedClassName(className.Put())) || className.View() != classes[i] ||
            FAILED(fresh->get_CachedNativeWindowHandle(&handle)) || !handle) return false;
        const HWND hwnd = reinterpret_cast<HWND>(handle);
        DWORD owner = 0;
        GetWindowThreadProcessId(hwnd, &owner);
        if (owner != pid_ || !GetClassNameW(hwnd, nativeClass, 256) || std::wstring_view(nativeClass) != classes[i] ||
            (childHandle && GetParent(childHandle) != hwnd) || (i + 1 == count && hwnd != rootHwnd_)) return false;
        childHandle = hwnd;
      }
      if (i + 1 < count) {
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
    if (Expired()) {
      Truncate("budget_ms");
      return;
    }
    // Visible ranges are provider-reported; they are not proof of on-screen pixels.
    ComPtr<IUIAutomationTextRangeArray> ranges;
    if (FAILED(pattern->GetVisibleRanges(&ranges)) || !ranges) {
      node.missing.push_back("visibleText");
      return;
    }
    int count = 0;
    ranges->get_Length(&count);
    std::wstring visible;
    for (int i = 0; i < count && i < 64; ++i) {
      const std::size_t room = FieldBudget();
      if (visible.size() >= room) break;
      ComPtr<IUIAutomationTextRange> item;
      Bstr part;
      if (FAILED(ranges->GetElement(i, &item)) || !item ||
          FAILED(item->GetText(static_cast<int>(room - visible.size()) + 1, part.Put()))) {
        node.missing.push_back("visibleText");
        return;
      }
      if (!visible.empty()) visible.push_back(L'\n');
      visible.append(part.View());
    }
    node.visibleText = Bounded(visible);
  }

  bool LiveSearchAuthorized(IUIAutomationElement* element, const protocol::NodeRecord& node) {
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

  // Returns false to stop the traversal (node limit).
  bool Visit(IUIAutomationElement* element, int depth, int parent, protocol::WorkerResponse& response,
             bool& traverse) {
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
    if (classDocumentScope_) {
      Bstr className;
      if (SUCCEEDED(element->get_CachedClassName(className.Put())) &&
          (className.View() == L"_WwG" || className.View() == L"_WwB" || className.View() == L"_WwF" || className.View() == L"OpusApp" ||
           className.View() == L"RichEditD2DPT" || className.View() == L"NotepadTextBox" || className.View() == L"Notepad"))
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
    const bool notepadDocument = protocol::IsNotepadDocument(node, response.nodes, rule_);
    facts.scopedDocument = wordDocument || notepadDocument || protocol::IsVsCodeEditorBody(node, response.nodes, rule_);
    // A long AutomationId that had to be truncated cannot match an exact selector.
    if (fullId.size() > kMaxAutomationIdChars) facts.automationId = {};
    const classify::NodeDecision decision = classify::Classify(facts, policy_, rule_);

    if (decision.redaction != classify::Redaction::None) {
      node.redaction = classify::RedactionCode(decision.redaction);
      ++response.stats.redacted;
    }
    const bool liveDocument = !facts.scopedDocument || LiveScopedDocumentAuthorized(element, wordDocument, notepadDocument);
    if (decision.readName && !decision.readSearchValue && liveDocument) node.name = ReadName(element, node);
    if (decision.readDocumentText && !Expired() && liveDocument) ReadDocument(element, node);
    if (decision.readDocumentText && facts.scopedDocument) {
      if (!liveDocument || !LiveScopedDocumentAuthorized(element, wordDocument, notepadDocument)) {
        node.name.reset(); node.text.reset(); node.visibleText.reset();
      }
      protocol::FinalizeScopedDocument(node);
      if (!node.redaction.empty()) ++response.stats.redacted;
    }
    if (decision.readSearchValue && !Expired()) {
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
    // A password style can change while the provider is answering. Discard all content,
    // including Name, and prune descendants if the final native check is unsafe.
    const auto finalNative = NativePassword(element);
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
    traverse = decision.traverseChildren && finalNative == false;
    return true;
  }

  const policy::Policy& policy_;
  const policy::AppRule& rule_;
  const std::uint32_t pid_;
  const double started_;
  const bool classDocumentScope_;
  ComPtr<IUIAutomationCacheRequest> cache_;
  ComPtr<IUIAutomationCacheRequest> childrenCache_;
  ComPtr<IUIAutomationTreeWalker> walker_;
  std::size_t textUsed_ = 0;
  std::vector<std::string> truncation_;
  HWND rootHwnd_ = nullptr;
};

protocol::WorkerResponse Finish(protocol::WorkerResponse response, const char* status, const char* reason,
                                double started) {
  response.status = status;
  response.reason = reason;
  if (response.status != "ok") {
    response.nodes.clear();
    response.truncated = false;
    response.truncation.clear();
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

  Traversal traversal(policy, *decision.rule, before->pid, started);
  if (!traversal.Init(automation.Get())) return Finish(std::move(response), "unavailable", "uia_error", started);
  ComPtr<IUIAutomationElement> root;
  if (FAILED(automation->ElementFromHandleBuildCache(reinterpret_cast<UIA_HWND>(ToHwnd(request.hwnd)),
                                                    traversal.Cache(), &root)) ||
      !root) {
    return Finish(std::move(response), "unavailable", "uia_root_unavailable", started);
  }
  int rootPid = 0;
  if (FAILED(root->get_CachedProcessId(&rootPid)) || static_cast<std::uint32_t>(rootPid) != before->pid) {
    return Finish(std::move(response), "blocked", "foreign_root", started);
  }
  traversal.Run(root.Get(), response);

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
