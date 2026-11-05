// Test-only differential probe. It reads only explicitly named synthetic body regions,
// never values/passwords. It is intentionally separate from the production collector:
// success here is API evidence, not evidence that the product captured the document.
#include "common/classify.h"
#include "common/json.h"
#include "common/policy.h"
#include "common/text.h"
#include "win/identity.h"
#include "win/raii.h"

#include <UIAutomation.h>
#include <wrl/client.h>
#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>

using memmy::Json;
using Microsoft::WRL::ComPtr;
namespace {
using Clock = std::chrono::steady_clock;
std::atomic<unsigned> foregroundChanges{0};
std::atomic<bool> foregroundMismatch{false};
std::uint64_t expectedForeground = 0;
void CALLBACK ForegroundCallback(HWINEVENTHOOK, DWORD, HWND hwnd, LONG, LONG, DWORD, DWORD) {
  ++foregroundChanges;
  if (memmy::win::FromHwnd(hwnd) != expectedForeground) foregroundMismatch = true;
}
class ForegroundGuard {
 public:
  explicit ForegroundGuard(std::uint64_t hwnd) {
    expectedForeground = hwnd;
    foregroundChanges = 0;
    foregroundMismatch = memmy::win::ForegroundWindow() != hwnd;
    thread_ = std::thread([this] {
      const auto hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr,
        ForegroundCallback, 0, 0, WINEVENT_OUTOFCONTEXT);
      hooked_ = hook != nullptr;
      ready_ = true;
      while (!stop_) {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
        if (memmy::win::ForegroundWindow() != expectedForeground) foregroundMismatch = true;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      if (hook) UnhookWinEvent(hook);
    });
    while (!ready_) std::this_thread::yield();
  }
  ~ForegroundGuard() { stop_ = true; thread_.join(); }
  Json Evidence() const {
    return {{"hookInstalled", hooked_.load()}, {"changes", foregroundChanges.load()},
      {"mismatch", foregroundMismatch.load() || memmy::win::ForegroundWindow() != expectedForeground},
      {"foreground", std::to_string(memmy::win::ForegroundWindow())}};
  }
 private:
  std::atomic<bool> ready_{false}, stop_{false}, hooked_{false};
  std::thread thread_;
};
class ProbeError : public std::runtime_error { public: using std::runtime_error::runtime_error; };
void Check(bool value, const char* error) { if (!value) throw ProbeError(error); }
std::string ReadRequest() {
  std::string line;
  while (true) {
    const int ch = std::cin.get();
    if (ch == '\n' || ch == EOF) break;
    Check(line.size() < memmy::policy::kMaxPolicyBytes, "request_too_large");
    line.push_back(static_cast<char>(ch));
  }
  return line;
}
std::optional<bool> BoolProperty(IUIAutomationElement* element, PROPERTYID id) {
  memmy::win::Variant value;
  if (FAILED(element->GetCurrentPropertyValueEx(id, TRUE, value.Put())) || value.Get().vt != VT_BOOL) return {};
  return value.Get().boolVal != VARIANT_FALSE;
}
bool Contains(const Json& values, const std::string& value) {
  for (const auto& candidate : values) if (candidate == value) return true;
  return false;
}
Json Rectangles(IUIAutomationTextRange* range) {
  memmy::win::SafeArray array;
  const HRESULT hr = range->GetBoundingRectangles(array.Put());
  Json result = {{"hr", hr}, {"values", Json::array()}};
  if (FAILED(hr) || !array.Get() || SafeArrayGetDim(array.Get()) != 1) return result;
  LONG lower = 0, upper = -1;
  if (FAILED(SafeArrayGetLBound(array.Get(), 1, &lower)) || FAILED(SafeArrayGetUBound(array.Get(), 1, &upper))) return result;
  for (LONG i = lower; i <= upper && i - lower < 256; ++i) {
    double value = 0;
    if (FAILED(SafeArrayGetElement(array.Get(), &i, &value))) break;
    result["values"].push_back(value);
  }
  return result;
}
Json Probe(const Json& request, const memmy::protocol::ContextRecord& context,
           const memmy::policy::Policy& policy, const memmy::policy::AppRule& rule) {
  const auto started = Clock::now();
  const int budgetMs = request.value("queryBudgetMs", 4000);
  Check(budgetMs >= 50 && budgetMs <= 10000, "diagnostic_budget_invalid");
  const auto expired = [&] { return Clock::now() - started > std::chrono::milliseconds(budgetMs); };
  const auto names = request.value("bodyNames", Json::array());
  const auto ids = request.value("bodyIds", Json::array());
  Check(names.is_array() && ids.is_array() && names.size() + ids.size() > 0 && names.size() + ids.size() <= 8,
    "synthetic_body_selector_required");
  for (const auto& values : {names, ids}) for (const auto& v : values)
    Check(v.is_string() && !v.get<std::string>().empty() && v.get<std::string>().size() <= 256, "body_selector_invalid");
  memmy::win::ComScope com(COINIT_MULTITHREADED);
  Check(com.Ok(), "com_init_failed");
  ComPtr<IUIAutomation> automation;
  Check(SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation))), "uia_init_failed");
  ComPtr<IUIAutomationElement> root;
  Check(SUCCEEDED(automation->ElementFromHandle(memmy::win::ToHwnd(context.hwnd), &root)) && root, "root_unavailable");
  ComPtr<IUIAutomationTreeWalker> walker;
  Check(SUCCEEDED(automation->get_ControlViewWalker(&walker)), "walker_unavailable");
  struct Frame { ComPtr<IUIAutomationElement> element; int parent; int depth; };
  std::vector<Frame> stack{{root, -1, 0}};
  Json nodes = Json::array();
  std::vector<memmy::protocol::NodeRecord> preceding;
  Json errors = Json::array();
  bool truncated = false;
  while (!stack.empty()) {
    if (expired() || nodes.size() >= 2000 || foregroundMismatch) { truncated = true; break; }
    auto frame = std::move(stack.back()); stack.pop_back();
    auto* element = frame.element.Get();
    int pid = 0;
    CONTROLTYPEID type = 0;
    const HRESULT pidHr = element->get_CurrentProcessId(&pid);
    const HRESULT typeHr = element->get_CurrentControlType(&type);
    if (FAILED(pidHr) || FAILED(typeHr)) { errors.push_back({{"property", "pid_or_type"}, {"pidHr", pidHr}, {"typeHr", typeHr}}); continue; }
    memmy::win::Bstr id;
    const HRESULT idHr = element->get_CurrentAutomationId(id.Put());
    const auto password = BoolProperty(element, UIA_IsPasswordPropertyId);
    const auto textPattern = BoolProperty(element, UIA_IsTextPatternAvailablePropertyId);
    const auto valuePattern = BoolProperty(element, UIA_IsValuePatternAvailablePropertyId);
    const auto focused = BoolProperty(element, UIA_HasKeyboardFocusPropertyId);
    memmy::protocol::NodeRecord metadata;
    metadata.controlType = type; metadata.automationId = memmy::text::ToUtf8(id.View());
    metadata.password = password; metadata.parent = frame.parent; metadata.depth = frame.depth;
    if (FAILED(idHr)) metadata.missing.push_back("automationId");
    memmy::win::Bstr className;
    if (SUCCEEDED(element->get_CurrentClassName(className.Put()))) metadata.className = memmy::text::ToUtf8(className.View().substr(0, 256));
    const bool scopedDocument = memmy::protocol::IsVsCodeEditorBody(metadata, preceding, rule)
      || memmy::protocol::IsWordDocument(metadata, preceding, rule);
    const auto decision = memmy::classify::Classify({type,
      !password ? memmy::classify::PasswordState::Unknown : *password ? memmy::classify::PasswordState::True : memmy::classify::PasswordState::False,
      id.View(), focused.value_or(false), textPattern.value_or(false), valuePattern.value_or(false), scopedDocument}, policy, rule);
    const auto typeName = memmy::classify::ControlTypeName(type);
    const auto redaction = memmy::classify::RedactionCode(decision.redaction);
    metadata.redaction = redaction ? redaction : "";
    preceding.push_back(std::move(metadata));
    std::string runtimeId;
    memmy::win::SafeArray runtime;
    if (SUCCEEDED(element->GetRuntimeId(runtime.Put())) && runtime.Get()) {
      LONG lower = 0, upper = -1;
      SafeArrayGetLBound(runtime.Get(), 1, &lower);
      SafeArrayGetUBound(runtime.Get(), 1, &upper);
      for (LONG i = lower; i <= upper && i - lower < 16; ++i) {
        int part = 0;
        if (FAILED(SafeArrayGetElement(runtime.Get(), &i, &part))) break;
        if (!runtimeId.empty()) runtimeId.push_back('.');
        runtimeId += std::to_string(part);
      }
    }
    Json node = {{"parent", frame.parent}, {"depth", frame.depth}, {"pid", pid},
      {"runtimeId", runtimeId},
      {"controlType", typeName ? typeName : "unknown"}, {"automationId", memmy::text::ToUtf8(id.View())}, {"automationIdHr", idHr},
      {"password", password ? Json(*password) : Json(nullptr)}, {"textPattern", textPattern ? Json(*textPattern) : Json(nullptr)},
      {"providerOffscreen", [&]() -> Json { const auto value = BoolProperty(element, UIA_IsOffscreenPropertyId); return value ? Json(*value) : Json(nullptr); }()},
      {"valuePattern", valuePattern ? Json(*valuePattern) : Json(nullptr)},
      {"production", {{"redaction", redaction ? Json(redaction) : Json(nullptr)},
        {"readDocumentText", decision.readDocumentText}, {"traverseChildren", decision.traverseChildren}}}};
    node["className"] = memmy::text::ToUtf8(className.View().substr(0, 256));
    UIA_HWND nativeHandle = nullptr;
    if (SUCCEEDED(element->get_CurrentNativeWindowHandle(&nativeHandle))) {
      wchar_t nativeClass[256]{};
      if (nativeHandle && GetClassNameW(reinterpret_cast<HWND>(nativeHandle), nativeClass, 256)) node["nativeClassName"] = memmy::text::ToUtf8(nativeClass);
      node["nativeHandle"] = std::to_string(reinterpret_cast<std::uintptr_t>(nativeHandle));
    }
    const bool foreign = static_cast<std::uint32_t>(pid) != context.pid;
    const bool sensitive = memmy::policy::IsSensitiveAutomationId(policy, rule, id.View());
    const bool bodyType = type == memmy::classify::kDocument || type == memmy::classify::kEdit;
    bool matched = false;
    if (!foreign && !sensitive && password == false && bodyType) {
      // Names only on potential body controls in the explicitly authorized synthetic window.
      memmy::win::Bstr name;
      const HRESULT nameHr = element->get_CurrentName(name.Put());
      node["nameHr"] = nameHr;
      if (SUCCEEDED(nameHr)) node["name"] = memmy::text::ToUtf8(name.View().substr(0, 256));
      matched = Contains(ids, memmy::text::ToUtf8(id.View())) || (SUCCEEDED(nameHr) && Contains(names, memmy::text::ToUtf8(name.View())));
      node["matchedSyntheticBody"] = matched;
      if (matched && !expired() && !foregroundMismatch) {
        ComPtr<IUIAutomationTextPattern> pattern;
        HRESULT hr = element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern));
        node["patternHr"] = hr;
        if (SUCCEEDED(hr) && pattern) {
          ComPtr<IUIAutomationTextRange> range;
          hr = pattern->get_DocumentRange(&range);
          node["rangeHr"] = hr;
          if (SUCCEEDED(hr) && range) {
            memmy::win::Bstr value;
            hr = range->GetText(2048, value.Put());
            node["textHr"] = hr;
            if (SUCCEEDED(hr)) node["text"] = memmy::text::ToUtf8(value.View());
            if (request.value("rangeGeometry", false) && !expired()) {
              node["documentRectangles"] = Rectangles(range.Get());
              ComPtr<IUIAutomationTextRange> line;
              if (SUCCEEDED(range->Clone(&line)) && line &&
                  SUCCEEDED(line->MoveEndpointByRange(TextPatternRangeEndpoint_End, line.Get(), TextPatternRangeEndpoint_Start)) &&
                  SUCCEEDED(line->ExpandToEnclosingUnit(TextUnit_Line))) {
                node["lineGeometry"] = Json::array();
                for (int i = 0; i < 8 && !expired() && !foregroundMismatch; ++i) {
                  int start = -1, end = 1;
                  // Some providers allow Move() to escape into adjacent controls.
                  // Never read a range outside this explicitly selected document.
                  if (FAILED(line->CompareEndpoints(TextPatternRangeEndpoint_Start, range.Get(), TextPatternRangeEndpoint_Start, &start)) ||
                      FAILED(line->CompareEndpoints(TextPatternRangeEndpoint_End, range.Get(), TextPatternRangeEndpoint_End, &end)) ||
                      start < 0 || end > 0) break;
                  memmy::win::Bstr lineText;
                  Json item = {{"textHr", line->GetText(256, lineText.Put())}, {"rectangles", Rectangles(line.Get())}};
                  item["text"] = memmy::text::ToUtf8(lineText.View());
                  node["lineGeometry"].push_back(std::move(item));
                  int moved = 0;
                  if (FAILED(line->Move(TextUnit_Line, 1, &moved)) || moved != 1) break;
                }
              }
            }
          }
          // Independently expose provider ranges so complete DocumentRange text is
          // never mistaken for the evidence the production summarizer receives.
          ComPtr<IUIAutomationTextRangeArray> visible;
          hr = pattern->GetVisibleRanges(&visible);
          node["visibleRangesHr"] = hr;
          if (SUCCEEDED(hr) && visible) {
            int count = 0;
            hr = visible->get_Length(&count);
            node["visibleCountHr"] = hr;
            if (SUCCEEDED(hr)) {
              node["visibleCount"] = count;
              node["visibleRanges"] = Json::array();
              std::size_t remaining = 2048;
              int visited = 0;
              for (; visited < count && visited < 64 && remaining && !expired() && !foregroundMismatch; ++visited) {
                ComPtr<IUIAutomationTextRange> item;
                hr = visible->GetElement(visited, &item);
                Json part = {{"index", visited}, {"rangeHr", hr}};
                if (SUCCEEDED(hr) && item) {
                  memmy::win::Bstr value;
                  hr = item->GetText(static_cast<int>(remaining), value.Put());
                  part["textHr"] = hr;
                  if (SUCCEEDED(hr)) {
                    const auto bounded = value.View().substr(0, remaining);
                    part["text"] = memmy::text::ToUtf8(bounded);
                    remaining -= bounded.size();
                  }
                }
                node["visibleRanges"].push_back(std::move(part));
              }
              node["visibleRangesLimited"] = visited < count || remaining == 0;
            }
          }
        }
      }
    }
    const int self = static_cast<int>(nodes.size());
    nodes.push_back(std::move(node));
    // Diagnostic body selection differs from production, all privacy vetoes still win.
    if (foreign || sensitive || password == true || matched ||
        (type == memmy::classify::kEdit) || (!password && !memmy::classify::IsStructural(type))) continue;
    if (frame.depth >= 40) { truncated = true; continue; }
    ComPtr<IUIAutomationElement> child;
    HRESULT hr = walker->GetFirstChildElement(element, &child);
    if (FAILED(hr)) { errors.push_back({{"parent", self}, {"traversalHr", hr}}); continue; }
    std::vector<ComPtr<IUIAutomationElement>> children;
    while (child) {
      if (expired() || children.size() + stack.size() + nodes.size() >= 2000) { truncated = true; break; }
      children.push_back(child);
      ComPtr<IUIAutomationElement> next;
      hr = walker->GetNextSiblingElement(child.Get(), &next);
      if (FAILED(hr)) { errors.push_back({{"parent", self}, {"traversalHr", hr}}); break; }
      child = std::move(next);
    }
    for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back({std::move(*it), self, frame.depth + 1});
  }
  return {{"nodes", nodes}, {"errors", errors}, {"truncated", truncated}, {"queryBudgetMs", budgetMs},
    {"elapsedMs", std::chrono::duration<double, std::milli>(Clock::now() - started).count()}};
}
}  // namespace
int main() {
  try {
    const auto parsed = memmy::ParseJsonStrict(ReadRequest(), 32);
    Check(parsed.has_value(), "request_invalid");
    const auto& request = *parsed;
    Check(request.value("syntheticOnly", false), "synthetic_only_required");
    const auto hwnd = memmy::text::ParseUnsignedDecimal(request.at("hwnd").get<std::string>());
    Check(hwnd && *hwnd != 0, "hwnd_invalid");
    std::string reason;
    const auto context = memmy::win::ReadWindowContext(*hwnd, reason);
    Check(context.has_value(), "identity_unavailable");
    const auto expectedExe = memmy::text::FromUtf8(request.at("executable").get<std::string>());
    Check(expectedExe && memmy::text::EqualsOrdinalIgnoreCase(memmy::win::CanonicalizePath(*expectedExe),
      *memmy::text::FromUtf8(context->executable)), "executable_mismatch");
    const auto title = request.at("title").get<std::string>();
    Check(!title.empty() && memmy::win::ReadWindowTitle(*hwnd, 1024) == title, "title_mismatch");
    Json result = {{"schema", "memmy.history.capability-probe/1"}, {"context", memmy::protocol::ContextToJson(*context, {})}};
    ForegroundGuard guard(*hwnd);
    const auto mode = request.at("mode").get<std::string>();
    if (mode == "describe") {
      result["foreground"] = guard.Evidence();
    } else {
      Check(request.at("processStart") == std::to_string(context->processStart) && request.at("pid") == context->pid, "instance_mismatch");
      if (mode == "watch") {
        std::cout << memmy::DumpJson(Json{{"ready", true}, {"foreground", guard.Evidence()}}) << std::endl;
        ReadRequest();
      } else {
        Check(mode == "probe", "mode_invalid");
        Check(!guard.Evidence().at("mismatch").get<bool>(), "not_foreground");
        const auto policy = memmy::policy::Parse(memmy::DumpJson(request.at("policy")));
        Check(policy.policy.has_value(), "policy_invalid");
        const auto decision = memmy::policy::Evaluate(*policy.policy, memmy::win::ToTarget(*context), memmy::win::CanonicalizePath);
        Check(decision.verdict == memmy::policy::Verdict::Allowed && decision.rule, "policy_not_authorized");
        result["probe"] = Probe(request, *context, *policy.policy, *decision.rule);
      }
      const auto after = memmy::win::ReadWindowContext(*hwnd, reason);
      result["identityStable"] = after && memmy::protocol::SameInstance(*context, *after) && memmy::win::ReadWindowTitle(*hwnd, 1024) == title;
      result["foreground"] = guard.Evidence();
    }
    std::cout << memmy::DumpJson(result) << std::endl;
    return 0;
  } catch (const ProbeError& error) {
    std::cout << memmy::DumpJson(Json{{"error", error.what()}}) << std::endl;
    return 2;
  } catch (const std::exception&) {
    // No request text or arbitrary provider content in errors.
    std::cout << "{\"error\":\"probe_precondition_or_api_failed\"}" << std::endl;
    return 2;
  }
}
