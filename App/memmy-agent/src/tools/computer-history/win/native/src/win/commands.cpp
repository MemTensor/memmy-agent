#include "win/commands.h"
#include "win/application_catalog.h"

#include "common/baseline.h"
#include "common/json.h"
#include "common/policy.h"
#include "common/protocol.h"
#include "common/text.h"
#include "win/control_input.h"
#include "win/event_output.h"
#include "win/hook_thread.h"
#include "win/identity.h"
#include "win/system.h"
#include "win/worker_host.h"
#include "win/task_video.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <memory>
#include <set>
#include <stdexcept>

namespace memmy::win {
namespace {

#if MEMMY_HISTORY_TEST_HOOKS
constexpr bool kTestHooks = true;
constexpr const wchar_t* kLeasePrefix = L"MemmyHistoryRecorder.TestHooks.Collector";
#else
constexpr bool kTestHooks = false;
constexpr const wchar_t* kLeasePrefix = L"MemmyHistoryRecorder.Collector";
#endif

constexpr int kExitOk = 0;
constexpr int kExitInternal = 1;
constexpr int kExitUsage = 2;
constexpr int kExitSnapshotNotOk = 3;
constexpr int kExitAlreadyRunning = 4;
constexpr int kExitInfrastructure = 5;
constexpr int kExitOutput = 6;

constexpr std::uint64_t kDebounceMs = 100;
constexpr std::uint64_t kMaxDelayMs = 1000;
constexpr std::uint64_t kMinIntervalMs = 200;

std::wstring AbsolutePath(const std::wstring& path) {
  std::error_code ec;
  const auto absolute = std::filesystem::absolute(std::filesystem::path(path), ec);
  return ec ? path : absolute.wstring();
}

class Session {
 public:
  Session() : id_(RandomHex(16)), origin_(MonotonicMs()), qpcOrigin_(QpcTicks()) {}
  std::uint64_t QpcOrigin() const { return qpcOrigin_; }
  const std::string& Id() const { return id_; }
  bool Valid() const { return id_.size() == 32; }
  void DiscardEnvelope() { --sequence_; }

  Json Envelope(const char* kind) {
    Json event;
    event["protocol"] = protocol::kProtocolName;
    event["version"] = protocol::kProtocolVersion;
    event["platform"] = protocol::kPlatform;
    event["sessionId"] = id_;
    event["sequence"] = ++sequence_;
    event["kind"] = kind;
    event["timestamp"] = protocol::FormatUtcTimestamp(NowFileTime());
    event["monotonicMs"] = std::round((MonotonicMs() - origin_) * 1000.0) / 1000.0;
    return event;
  }

 private:
  std::string id_;
  double origin_;
  std::uint64_t qpcOrigin_;
  std::uint64_t sequence_ = 0;
};

struct QueryOutcome {
  std::string status;  // ok | blocked | unavailable | cancelled
  std::string reason;
  std::optional<protocol::ContextRecord> context;  // only for targets named by the policy
  protocol::WorkerResponse response;
  std::string policySha;
  std::string policyBytes;
  std::optional<std::uint64_t> focusHwnd;
  UniqueHandle policyLease;
  std::uint64_t generation = 0;
  double elapsedMs = 0;
};

std::optional<std::uint64_t> FocusHwnd(std::uint64_t hwnd) {
  GUITHREADINFO info{sizeof(info)};
  const DWORD thread = GetWindowThreadProcessId(ToHwnd(hwnd), nullptr);
  if (thread == 0 || !GetGUIThreadInfo(thread, &info)) return std::nullopt;
  return FromHwnd(info.hwndFocus);
}

// Collector side of one query: policy snapshot, identity and authorization, isolated worker,
// then post-read verification of generation, foreground, instance identity and policy bytes.
class Collector {
 public:
  Collector(std::wstring policyPath, HookThread& hooks, WorkerHost& host, cli::TestOptions test)
      : policyPath_(std::move(policyPath)), hooks_(hooks), host_(host), test_(std::move(test)) {}

  QueryOutcome Query(std::uint64_t hwnd, const HANDLE* cancel, DWORD cancelCount) {
    const double started = MonotonicMs();
    QueryOutcome out;
    const auto done = [&](const char* status, std::string reason) {
      out.status = status;
      out.reason = std::move(reason);
      out.elapsedMs = MonotonicMs() - started;
      if (out.status != "ok") out.response = {};
      return std::move(out);
    };
    out.generation = hooks_.Generation();
    const PolicyFile file = ReadPolicyFile(policyPath_);
    if (!file.ok) return done("blocked", file.error);
    const auto parsed = policy::Parse(file.bytes);
    if (!parsed.policy) return done("blocked", "policy_invalid");
    out.policySha = file.sha256;
    out.policyBytes = file.bytes;
    out.focusHwnd = FocusHwnd(hwnd);
    const policy::Policy& policy = *parsed.policy;

    std::string reason;
    const auto context = ReadWindowContext(hwnd, reason);
    if (!context) return done("blocked", reason);
    const policy::Decision decision = policy::Evaluate(policy, ToTarget(*context), CanonicalizePath);
    // Identity is reported only for targets the policy names; others stay anonymous.
    if (decision.rule != nullptr) out.context = context;
    if (decision.verdict != policy::Verdict::Allowed) return done("blocked", decision.reason);
    if (ForegroundWindow() != hwnd) return done("blocked", "not_foreground");

    protocol::WorkerRequest request;
    request.hwnd = context->hwnd;
    request.pid = context->pid;
    request.processStart = context->processStart;
    request.executable = context->executable;
    request.policyText = file.bytes;
    if constexpr (kTestHooks) {
      request.testSleepMs = test_.workerSleepMs;
      if (!test_.gate.empty() && !gateUsed_) {
        request.testGate = text::ToUtf8(test_.gate);
        gateUsed_ = true;
      }
    }
    const WorkerOutcome worker = host_.Run(DumpJson(protocol::WorkerRequestToJson(request)),
                                           static_cast<DWORD>(policy.limits.workerTimeoutMs), cancel, cancelCount);
    lastWorker_ = worker;
    switch (worker.kind) {
      case WorkerOutcome::Kind::Completed: break;
      case WorkerOutcome::Kind::Cancelled: return done("cancelled", "");
      case WorkerOutcome::Kind::TimedOut: return done("unavailable", "worker_timeout");
      case WorkerOutcome::Kind::JobFailed: return done("unavailable", "worker_job_failed");
      case WorkerOutcome::Kind::LaunchFailed: return done("unavailable", "worker_launch_failed");
      case WorkerOutcome::Kind::OutputTooLarge: return done("unavailable", "worker_output_too_large");
      case WorkerOutcome::Kind::Failed: return done("unavailable", "worker_failed");
    }

    // Nothing is emitted unless the same window instance stayed foreground for the whole query
    // (the generation catches A->B->A even when both ends are equal) under the same policy bytes.
    if (!hooks_.Barrier(1000)) return done("unavailable", "hook_barrier_failed");
    if (hooks_.Generation() != out.generation || ForegroundWindow() != hwnd) return done("blocked", "context_changed");
    const auto after = ReadWindowContext(hwnd, reason);
    if (!after || !protocol::SameInstance(*context, *after)) return done("blocked", "context_changed");
    const PolicyFile again = ReadPolicyFile(policyPath_);
    if (!again.ok || again.bytes != file.bytes) return done("blocked", "policy_changed");

    const auto json = ParseJsonStrict(worker.output, 16);
    std::string error;
    if (!json || !protocol::WorkerResponseFromJson(*json, policy, *decision.rule, out.response, error)) {
      return done("unavailable", error.empty() ? "worker_invalid_output" : error);
    }
    if (out.response.context && !protocol::SameInstance(*context, *out.response.context)) {
      return done("unavailable", "worker_invalid_output");
    }
    if (out.response.status != "ok") {
      return done(out.response.status == "blocked" ? "blocked" : "unavailable", out.response.reason);
    }
    out.context = out.response.context;
    return done("ok", "");
  }

  // Called with the content line already serialized. No UIA runs in this process.
  // A failed commit clears content and never advances the caller's baseline.
  bool Commit(QueryOutcome& out, const HANDLE* cancel, DWORD cancelCount) {
    const auto refuse = [&](const char* status, const char* reason) {
      out.status = status;
      out.reason = reason;
      out.response = {};
      if (out.context) { out.context->title.reset(); out.context->browser.reset(); }
      return false;
    };
#if MEMMY_HISTORY_TEST_HOOKS
    if (!test_.commitGate.empty() && !commitGateUsed_) {
      commitGateUsed_ = true;
      UniqueHandle ready = Own(OpenEventW(EVENT_MODIFY_STATE, FALSE, (test_.commitGate + L".ready").c_str()));
      UniqueHandle resume = Own(OpenEventW(SYNCHRONIZE, FALSE, (test_.commitGate + L".continue").c_str()));
      if (!ready || !resume) return refuse("unavailable", "test_gate_failed");
      SetEvent(ready.get());
      std::vector<HANDLE> waits;
      if (cancelCount) waits.assign(cancel, cancel + cancelCount);
      waits.push_back(resume.get());
      const DWORD wait = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, 10000);
      if (wait < WAIT_OBJECT_0 + cancelCount) return refuse("cancelled", "");
      if (wait != WAIT_OBJECT_0 + cancelCount) return refuse("unavailable", "test_gate_failed");
    }
#endif
    const auto cancelled = [&] {
      return cancelCount && WaitForMultipleObjects(cancelCount, cancel, FALSE, 0) != WAIT_TIMEOUT;
    };
    if (cancelled()) return refuse("cancelled", "");
    PolicyFile latest = ReadPolicyFile(policyPath_, true);
    if (!latest.ok || latest.bytes != out.policyBytes) return refuse("blocked", "policy_changed");
    if (!hooks_.Barrier(1000)) return refuse("unavailable", "hook_barrier_failed");
    std::string reason;
    const auto context = out.context ? ReadWindowContext(out.context->hwnd, reason) : std::nullopt;
    if (!context || !protocol::SameInstance(*out.context, *context) ||
        ForegroundWindow() != out.context->hwnd || hooks_.Generation() != out.generation) {
      return refuse("blocked", "context_changed");
    }
    // GUI-thread focus adds an endpoint check for native controls. Virtual UIA elements are
    // additionally protected by the focus WinEvent generation and worker-side live checks.
    const bool hasSearchValue = std::any_of(out.response.nodes.begin(), out.response.nodes.end(),
                                           [](const auto& node) { return node.value.has_value(); });
    if (hasSearchValue && (!out.focusHwnd || FocusHwnd(context->hwnd) != out.focusHwnd)) {
      return refuse("blocked", "context_changed");
    }
    if (cancelled()) return refuse("cancelled", "");
    out.policyLease = std::move(latest.revisionLease);
    return true;
  }

  const WorkerOutcome& LastWorker() const { return lastWorker_; }

 private:
  std::wstring policyPath_;
  HookThread& hooks_;
  WorkerHost& host_;
  cli::TestOptions test_;
  bool gateUsed_ = false;
  bool commitGateUsed_ = false;
  WorkerOutcome lastWorker_;
};

// Keys every node and links it to its parent's key.
Json KeyedNodes(const std::vector<protocol::NodeRecord>& nodes, std::vector<std::string>& keys,
                const std::vector<std::size_t>* only) {
  keys = protocol::NodeKeys(nodes);
  Json out = Json::array();
  const auto add = [&](std::size_t i) {
    const auto& node = nodes[i];
    const std::string* parent = node.parent >= 0 ? &keys[static_cast<std::size_t>(node.parent)] : nullptr;
    out.push_back(protocol::NodeToJson(node, &keys[i], parent));
  };
  if (only) {
    for (const std::size_t i : *only) add(i);
  } else {
    for (std::size_t i = 0; i < nodes.size(); ++i) add(i);
  }
  return out;
}

std::optional<std::string> FocusKey(const std::vector<protocol::NodeRecord>& nodes,
                                    const std::vector<std::string>& keys) {
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    if (nodes[i].focused) return keys[i];
  }
  return std::nullopt;
}

Json StatsJson(const QueryOutcome& query) {
  const auto& stats = query.response.stats;
  return {{"visited", stats.visited},
          {"emitted", stats.emitted},
          {"redacted", stats.redacted},
          {"foreignSkipped", stats.foreignSkipped},
          {"missingProperties", stats.missingProperties},
          {"workerElapsedMs", std::round(query.response.elapsedMs * 1000.0) / 1000.0}};
}

Json NotOkBody(const QueryOutcome& query) {
  return {{"status", query.status},
          {"reason", query.reason},
          {"elapsedMs", std::round(query.elapsedMs * 1000.0) / 1000.0}};
}

Json OkBody(const QueryOutcome& query, const char* mode, const std::optional<std::string>& focusKey) {
  Json body;
  body["status"] = "ok";
  body["reason"] = nullptr;
  body["mode"] = mode;
  body["focusKey"] = focusKey ? Json(*focusKey) : Json(nullptr);
  body["truncated"] = query.response.truncated;
  body["truncation"] = query.response.truncation;
  body["stats"] = StatsJson(query);
  body["elapsedMs"] = std::round(query.elapsedMs * 1000.0) / 1000.0;
  return body;
}

Json ContextJson(const QueryOutcome& query) {
  return query.context ? protocol::ContextToJson(*query.context, query.generation) : Json(nullptr);
}

std::atomic<HANDLE> g_consoleStop{nullptr};
std::atomic<HANDLE> g_consoleDone{nullptr};

BOOL WINAPI OnConsoleControl(DWORD type) {
  const HANDLE stop = g_consoleStop.load();
  if (stop == nullptr) return FALSE;
  SetEvent(stop);
  if (type == CTRL_CLOSE_EVENT || type == CTRL_LOGOFF_EVENT || type == CTRL_SHUTDOWN_EVENT) {
    // The process is terminated when this returns; give the collector time to unhook.
    if (const HANDLE done = g_consoleDone.load()) WaitForSingleObject(done, 4000);
  }
  return TRUE;
}

class Observer {
 public:
  explicit Observer(const cli::CommandLine& command)
      : command_(command), policyPath_(AbsolutePath(command.policyPath)), hooks_(256, command.kind == cli::CommandKind::RecordTask) {}

  int Run() {
    SessionLease lease(kLeasePrefix);
    if (!lease.Acquired()) {
      Diagnostic("collector_already_running");
      return kExitAlreadyRunning;
    }
    // Recording starts only with a valid policy; later corruption fails closed per query.
    const PolicyFile file = ReadPolicyFile(policyPath_);
    if (!file.ok) {
      Diagnostic(file.error);
      return kExitUsage;
    }
    const auto parsed = policy::Parse(file.bytes);
    if (!parsed.policy) {
      Diagnostic("policy_invalid", parsed.error.code + (parsed.error.path.empty() ? "" : " at " + parsed.error.path));
      return kExitUsage;
    }
    if (command_.parentPid) {
      std::string error;
      parent_ = OpenParentProcess(*command_.parentPid, error);
      if (!parent_) {
        Diagnostic(error);
        return kExitUsage;
      }
    }
    if (!session_.Valid()) {
      Diagnostic("random_unavailable");
      return kExitInternal;
    }
    std::string error;
    if (!host_.Init(error)) {
      Diagnostic("worker_job_unavailable", error);  // fail closed: no unconfined workers
      return kExitInfrastructure;
    }
    stop_ = Own(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    done_ = Own(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!stop_ || !done_) return kExitInternal;
    if (!hooks_.Start(false, command_.inputHooks)) {
      Diagnostic("hook_install_failed");
      return kExitInfrastructure;
    }
    if (command_.kind == cli::CommandKind::RecordTask) {
      video_ = std::make_unique<TaskVideo>(command_.outputDirectory, policyPath_, hooks_, session_.QpcOrigin(), command_.seconds);
      if (!video_->Start()) { hooks_.Stop(2000); Diagnostic("task_video_start_failed"); return kExitInfrastructure; }
    }
    if (!command_.outputPath.empty() &&
        !output_.Open(command_.outputPath, command_.rotateSeconds * 1000.0, MonotonicMs(), error)) {
      hooks_.Stop(2000);
      Diagnostic(error);
      return error == "output_exists" ? kExitUsage : kExitOutput;
    }
    if (!control_.Start()) {
      hooks_.Stop(2000);
      Diagnostic("control_input_unavailable");
      return kExitInternal;
    }
#if MEMMY_HISTORY_TEST_HOOKS
    if (command_.test.flushFailure) output_.TestFailFlush();
#endif
    g_consoleStop.store(stop_.get());
    g_consoleDone.store(done_.get());
    SetConsoleCtrlHandler(&OnConsoleControl, TRUE);
    collector_ = std::make_unique<Collector>(policyPath_, hooks_, host_, command_.test);

    Json started = session_.Envelope("session.started");
    started["collector"] = {{"version", MEMMY_HISTORY_RECORDER_VERSION},
                            {"pid", GetCurrentProcessId()},
                            {"testHooks", kTestHooks}};
    started["policyRevision"] = file.sha256;
    started["options"] = {{"seconds", command_.seconds},
                          {"rotateSeconds", command_.rotateSeconds},
                          {"sampleMs", command_.sampleMs},
                          {"inputHooks", command_.inputHooks},
                          {"parentPid", command_.parentPid ? Json(*command_.parentPid) : Json(nullptr)}};
    started["segment"] = SegmentJson();
    Emit(std::move(started));

    Loop();
    return Shutdown();
  }

 private:
  struct Counters {
    std::uint64_t started = 0, ok = 0, blocked = 0, unavailable = 0, timedOut = 0, cancelled = 0,
                  truncated = 0, contextChanged = 0, policyChanged = 0, unchanged = 0, suppressed = 0,
                  events = 0, controlRejected = 0, pauses = 0, resumes = 0;
  };

  Json SegmentJson() const {
    if (!output_.HasFile()) return nullptr;
    const std::filesystem::path path(output_.SegmentPath(output_.SegmentIndex()));
    return {{"index", output_.SegmentIndex()}, {"file", text::ToUtf8(path.filename().wstring())}};
  }

  Json CountersJson() const {
    const auto queue = hooks_.Queue().Counters();
    const auto hooks = hooks_.Counters();
    return {
        {"triggers",
         {{"accepted", queue.accepted},
          {"coalesced", queue.coalesced},
          {"dropped", queue.dropped},
          {"discarded", queue.discarded},
          {"ignoredBackground", hooks.ignoredBackground},
          {"ignoredPaused", hooks.ignoredPaused}}},
        {"queries",
         {{"started", counters_.started},
          {"ok", counters_.ok},
          {"blocked", counters_.blocked},
          {"unavailable", counters_.unavailable},
          {"timedOut", counters_.timedOut},
          {"cancelled", counters_.cancelled},
          {"truncated", counters_.truncated},
          {"contextChanged", counters_.contextChanged},
          {"policyChanged", counters_.policyChanged},
          {"unchanged", counters_.unchanged},
          {"suppressedRepeats", counters_.suppressed}}},
        {"control", {{"pauses", counters_.pauses}, {"resumes", counters_.resumes}, {"rejected", counters_.controlRejected}}},
        {"hooks", {{"callbacks", hooks.callbacks}, {"callbackMaxMs", std::round(hooks.callbackMaxMs * 1000.0) / 1000.0}}},
        {"events", counters_.events},
    };
  }

  void Emit(Json event) {
    WriteLine(DumpJson(event) + "\n");
  }

  void WriteLine(const std::string& line) {
    std::string encoded = line;
    if (video_) {
      auto value = ParseJsonStrict(line, 32);
      if (!value) throw std::runtime_error("task_event_invalid");
      const auto tick = QpcTicks();
      (*value)["protocol"] = "memmy.windows.task-recording";
      (*value)["monotonicMs"] = static_cast<double>(tick - session_.QpcOrigin()) * 1000.0 / static_cast<double>(QpcFrequency());
      Json actionTimes = Json::array();
      if (value->at("kind") == "snapshot" && (*value)["snapshot"].contains("actions")) {
        for (auto& action : (*value)["snapshot"]["actions"]) { actionTimes.push_back(action.at("taskQpc")); action.erase("taskQpc"); }
      }
      (*value)["task"] = {{"qpcOrigin", std::to_string(session_.QpcOrigin())}, {"qpcFrequency", std::to_string(QpcFrequency())},
        {"qpc", std::to_string(tick)}, {"actionQpc", actionTimes}, {"unsupportedActions", unsupportedActions_}};
      encoded = DumpJson(*value) + "\n";
    }
    const auto failure = output_.Write(encoded);
    ++counters_.events;
    if (failure != EventOutput::Failure::None && !outputFailed_) {
      outputFailed_ = true;
      failedChannel_ = failure == EventOutput::Failure::Stdout ? "stdout" : "file";
      failureCode_ = "output_write_failed";
    }
  }

  void MaybeRotate() {
    if (!output_.RotationDue(MonotonicMs())) return;
    std::string error;
    if (!output_.Rotate(MonotonicMs(), error)) {
      if (!outputFailed_) {
        outputFailed_ = true;
        failedChannel_ = "file";
        failureCode_ = error;
      }
      return;
    }
    Json event = session_.Envelope("segment.started");
    event["segment"] = SegmentJson();
    event["counters"] = CountersJson();
    Emit(std::move(event));
  }

  std::uint64_t RunAt() const {
    const std::uint64_t settled = std::min(lastTriggerTick_ + kDebounceMs, pendingSince_ + kMaxDelayMs);
    return std::max(settled, lastQueryEnd_ + kMinIntervalMs);
  }

  void MarkPending(const char* kind) {
    const std::uint64_t now = TickMs();
    if (!pending_) pendingSince_ = now;
    pending_ = true;
    lastTriggerTick_ = now;
    pendingKinds_.insert(kind);
    ++pendingCount_;
  }

  void ClearPending() {
    pending_ = false;
    pendingKinds_.clear();
    pendingCount_ = 0;
    pendingActions_.clear();
    pendingActionOverflow_ = false;
  }

  void ResetCaptureState() {
    baseline_.Reset();
    lastFocusKey_.reset();
    lastBlockedKey_.clear();
  }

  // Returns false when the session must stop.
  bool HandleControl() {
    for (const ControlItem item : control_.Drain()) {
      switch (item) {
        case ControlItem::Pause: {
          const bool already = paused_;
          if (!paused_) {
            // Invalidate everything before acknowledging: hooks stop enqueuing, the generation
            // moves (any result in flight is rejected), queued triggers and baseline are dropped.
            paused_ = true;
            if (video_) video_->Pause(true);
            hooks_.SetPaused(true);
            hooks_.BumpGeneration();
            hooks_.Queue().Clear();
            ClearPending();
            ResetCaptureState();
            ++counters_.pauses;
          }
          Json event = session_.Envelope("session.paused");
          event["alreadyPaused"] = already;
          Emit(std::move(event));
          break;
        }
        case ControlItem::Resume: {
          const bool already = !paused_;
          if (paused_) {
            paused_ = false;
            if (video_) video_->Pause(false);
            hooks_.SetPaused(false);
            hooks_.BumpGeneration();
            ++epoch_;
            ResetCaptureState();
            ++counters_.resumes;
          }
          Json event = session_.Envelope("session.resumed");
          event["alreadyRunning"] = already;
          Emit(std::move(event));
          if (!already) {
            MarkPending("resume");
            nextSample_ = TickMs() + command_.sampleMs;
          }
          break;
        }
        case ControlItem::Stop:
          stopReason_ = "stop_command";
          return false;
        case ControlItem::Eof:
          stopReason_ = "stdin_eof";
          return false;
        case ControlItem::Overflow: {
          stopReason_ = "control_queue_overflow";
          Json event = session_.Envelope("error");
          event["code"] = stopReason_;
          event["fatal"] = true;
          Emit(std::move(event));
          Diagnostic(stopReason_);
          return false;
        }
        case ControlItem::Unknown:
        case ControlItem::Overlong: {
          ++counters_.controlRejected;
          Json event = session_.Envelope("error");
          event["code"] = item == ControlItem::Unknown ? "control_command_unknown" : "control_command_too_long";
          event["fatal"] = false;
          Emit(std::move(event));
          break;
        }
      }
    }
    return true;
  }

  void RunQuery() {
    Json trigger = {{"kinds", Json(std::vector<std::string>(pendingKinds_.begin(), pendingKinds_.end()))},
                    {"count", pendingCount_}};
    const auto actions = std::move(pendingActions_);
    bool actionOverflow = pendingActionOverflow_;
    ClearPending();
    const std::uint64_t hwnd = ForegroundWindow();
    std::vector<HANDLE> cancel = {stop_.get(), control_.Event()};
    if (parent_) cancel.push_back(parent_.get());
    ++counters_.started;
    QueryOutcome query = collector_->Query(hwnd, cancel.data(), static_cast<DWORD>(cancel.size()));
    lastQueryEnd_ = TickMs();
    MaybeRotate();
    if (outputFailed_) return;

    if (query.status == "cancelled") {
      if (video_) unsupportedActions_ += actions.size();
      // A control command or stop arrived mid-query; its handler decides what happens next.
      ++counters_.cancelled;
      ResetCaptureState();
      if (!paused_) MarkPending("retry");
      return;
    }
    if (query.status != "ok") {
      if (video_) unsupportedActions_ += actions.size();
      // Any refusal or failure ends the delta chain; the next success is a full baseline.
      baseline_.Reset();
      lastFocusKey_.reset();
      if (query.status == "blocked") ++counters_.blocked;
      else ++counters_.unavailable;
      if (query.reason == "worker_timeout") ++counters_.timedOut;
      if (query.reason == "context_changed") ++counters_.contextChanged;
      if (query.reason == "policy_changed") ++counters_.policyChanged;
      // Repeated identical refusals (e.g. an unauthorized app staying foreground) are counted,
      // not re-emitted. Failures that may indicate a stuck target are always emitted.
      const std::string key = query.status + "|" + query.reason + "|" +
                              (query.context ? std::to_string(query.context->hwnd) : std::string("-"));
      const bool alwaysEmit = query.status == "unavailable";
      if (!alwaysEmit && key == lastBlockedKey_) {
        ++counters_.suppressed;
        return;
      }
      lastBlockedKey_ = key;
      Json event = session_.Envelope("snapshot");
      event["trigger"] = std::move(trigger);
      event["context"] = ContextJson(query);
      event["snapshot"] = NotOkBody(query);
      Emit(std::move(event));
      return;
    }

    lastBlockedKey_.clear();
    std::vector<std::string> keys;
    KeyedNodes(query.response.nodes, keys, nullptr);
    const std::string identity = std::to_string(query.context->hwnd) + "|" + std::to_string(query.context->pid) + "|" +
                                 std::to_string(query.context->processStart) + "|" + query.policySha + "|" +
                                 std::to_string(query.generation) + "|" + std::to_string(epoch_) + "|" +
                                 (query.context->browser ? query.context->browser->url + "|" + query.context->browser->documentId : "");
    Baseline candidate = baseline_;
    const Baseline::Diff diff = candidate.Apply(identity, keys, !query.response.truncated);
    const auto focusKey = FocusKey(query.response.nodes, keys);
    Json approvedActions = Json::array();
    const auto focus = std::find_if(query.response.nodes.begin(), query.response.nodes.end(),
                                    [](const auto& node) { return node.focused; });
    const bool keyboardAllowed = focus != query.response.nodes.end() && focus->password == std::optional<bool>(false) &&
                                 (focus->redaction.empty() || focus->redaction == "edit_control");
    for (const auto& item : actions) {
      if (item.hwnd != query.context->hwnd || item.generation != query.generation) continue;
      const auto& action = item.action;
      Json detail = {{"timestamp", protocol::FormatUtcTimestamp(action.timestamp)}, {"injected", action.injected}};
      if (action.kind == ActionKind::MouseClick) {
        detail["type"] = "mouse_click";
        detail["button"] = action.button == 2 ? "right" : "left";
        detail["x"] = action.x; detail["y"] = action.y;
      } else if (action.kind == ActionKind::Scroll && action.wheel != 0) {
        detail["type"] = "scroll";
        detail["direction"] = action.horizontal ? (action.wheel > 0 ? "right" : "left") : (action.wheel > 0 ? "up" : "down");
        detail["delta"] = action.wheel;
      } else if (action.kind == ActionKind::KeyPress && keyboardAllowed) {
        detail["type"] = "key_press";
        detail["key"] = SemanticKey(action);
      } else if (action.kind == ActionKind::TextKey && keyboardAllowed) {
        detail["type"] = "text_input";
        detail["pressCount"] = 1; detail["redacted"] = true; detail["unit"] = "key_press";
      } else {
        if (video_ && (action.kind == ActionKind::KeyPress || action.kind == ActionKind::TextKey)) { ++unsupportedActions_; actionOverflow = true; }
        continue;
      }
      if (video_) detail["taskQpc"] = std::to_string(action.qpc);
      approvedActions.push_back(std::move(detail));
    }
    if (!diff.full && diff.added.empty() && diff.removed.empty() && focusKey == lastFocusKey_ && approvedActions.empty() && !actionOverflow) {
      ++counters_.ok;
      ++counters_.unchanged;
      return;
    }
    Json body = OkBody(query, diff.full ? "full" : "delta", focusKey);
    if (command_.inputHooks) { body["actions"] = std::move(approvedActions); body["actionOverflow"] = actionOverflow; }
    if (diff.full) {
      body["nodes"] = KeyedNodes(query.response.nodes, keys, nullptr);
    } else {
      body["added"] = KeyedNodes(query.response.nodes, keys, &diff.added);
      body["removed"] = diff.removed;
      body["unchangedCount"] = diff.unchanged;
    }
    Json event = session_.Envelope("snapshot");
    event["trigger"] = std::move(trigger);
    event["context"] = ContextJson(query);
    event["snapshot"] = std::move(body);
    const std::string line = DumpJson(event) + "\n";
    if (!collector_->Commit(query, cancel.data(), static_cast<DWORD>(cancel.size()))) {
      session_.DiscardEnvelope();
      ResetCaptureState();
      if (query.status == "cancelled") {
        ++counters_.cancelled;
      } else {
        if (query.status == "blocked") ++counters_.blocked;
        else ++counters_.unavailable;
        if (query.reason == "context_changed") ++counters_.contextChanged;
        if (query.reason == "policy_changed") ++counters_.policyChanged;
        Json refused = session_.Envelope("snapshot");
        refused["context"] = ContextJson(query);
        refused["snapshot"] = NotOkBody(query);
        refused["trigger"] = event["trigger"];
        Emit(std::move(refused));
      }
      if (!paused_) MarkPending("retry");
      return;
    }
    WriteLine(line);
    if (!outputFailed_) {
      ++counters_.ok;
      if (query.response.truncated) ++counters_.truncated;
      baseline_ = std::move(candidate);
      lastFocusKey_ = focusKey;
    }
  }

  void Loop() {
    const std::uint64_t start = TickMs();
    const std::uint64_t deadline = start + static_cast<std::uint64_t>(command_.seconds) * 1000;
    nextSample_ = start + command_.sampleMs;
    MarkPending("session_start");
    for (;;) {
      if (video_ && video_->Failed()) { stopReason_ = "video_capture_failed"; return; }
      if (video_ && video_->Done()) { stopReason_ = "duration_elapsed"; return; }
      if (hooks_.StopRequested()) {
        stopReason_ = "stop_hotkey";
        return;
      }
      if (outputFailed_) {
        stopReason_ = "output_failed";
        return;
      }
      std::uint64_t now = TickMs();
      if (now >= deadline) {
        stopReason_ = "duration_elapsed";
        return;
      }
      std::uint64_t wake = deadline;
      if (!paused_) {
        wake = std::min(wake, nextSample_);
        if (pending_) wake = std::min(wake, RunAt());
      }
      if (output_.HasFile()) wake = std::min(wake, now + 250);
      const DWORD timeout = wake > now ? static_cast<DWORD>(std::min<std::uint64_t>(wake - now, 1000)) : 0;
      std::vector<HANDLE> waits = {stop_.get(), control_.Event(), hooks_.QueueEvent()};
      if (parent_) waits.push_back(parent_.get());
      const DWORD wait = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, timeout);
      if (wait == WAIT_OBJECT_0) {
        stopReason_ = "console_control";
        return;
      }
      if (parent_ && wait == WAIT_OBJECT_0 + 3) {
        stopReason_ = "parent_exited";
        return;
      }
      if (wait == WAIT_FAILED) {
        stopReason_ = "internal_error";
        return;
      }
      if (!HandleControl()) return;
      if (hooks_.StopRequested()) {
        stopReason_ = "stop_hotkey";
        return;
      }

      bool overflowed = false;
      const auto triggers = hooks_.Queue().Drain(overflowed);
      if (!paused_) {
        for (const auto& trigger : triggers) {
          MarkPending(TriggerKindName(trigger.kind));
          if (trigger.action.kind != ActionKind::None) {
            if (video_ && trigger.action.kind == ActionKind::Unsupported) { ++unsupportedActions_; pendingActionOverflow_ = true; }
            if (pendingActions_.size() < 64) pendingActions_.push_back(trigger);
            else pendingActionOverflow_ = true;
          }
        }
        if (overflowed && command_.inputHooks) pendingActionOverflow_ = true;
        if (overflowed) MarkPending("queue_overflow");
      }
      MaybeRotate();
      if (outputFailed_) continue;

      now = TickMs();
      if (!paused_ && now >= nextSample_) {
        MarkPending("sample");
        nextSample_ = now + command_.sampleMs;
      }
      if (!paused_ && pending_ && TickMs() >= RunAt()) RunQuery();
    }
  }

  int Shutdown() {
    if (video_) video_->Stop();
    hooks_.SetPaused(true);
    hooks_.BumpGeneration();
    const bool hooksStopped = hooks_.Stop(2000);
    control_.Shutdown(300);
    std::string flushError;
    if (!output_.FlushPending(flushError) && !outputFailed_) {
      outputFailed_ = true;
      stopReason_ = "output_failed";
      failedChannel_ = "file";
      failureCode_ = flushError;
    }
    if (outputFailed_) {
      Json error = session_.Envelope("error");
      error["code"] = failureCode_;
      error["channel"] = failedChannel_;
      error["fatal"] = true;
      Emit(std::move(error));
      Diagnostic(failureCode_, failedChannel_);
    }
    Json stopped = session_.Envelope("session.stopped");
    stopped["reason"] = stopReason_;
    stopped["hooksDetached"] = hooksStopped;
    stopped["counters"] = CountersJson();
    Emit(std::move(stopped));
    std::string closeError;
    if (!output_.Close(closeError)) {
      if (!outputFailed_) Diagnostic(closeError.empty() ? "output_write_failed" : closeError, "file");
      outputFailed_ = true;
    }
    SetConsoleCtrlHandler(&OnConsoleControl, FALSE);
    g_consoleStop.store(nullptr);
    SetEvent(done_.get());
    if (stopReason_ == "output_failed" || outputFailed_) return kExitOutput;
    if (!hooksStopped || stopReason_ == "internal_error" || stopReason_ == "control_queue_overflow" || stopReason_ == "video_capture_failed") return kExitInternal;
    return kExitOk;
  }

  const cli::CommandLine& command_;
  std::wstring policyPath_;
  Session session_;
  HookThread hooks_;
  WorkerHost host_;
  std::unique_ptr<TaskVideo> video_;
  EventOutput output_;
  ControlInput control_;
  std::unique_ptr<Collector> collector_;
  UniqueHandle stop_;
  UniqueHandle done_;
  UniqueHandle parent_;
  Baseline baseline_;
  Counters counters_;
  std::optional<std::string> lastFocusKey_;
  std::string lastBlockedKey_;
  std::uint64_t epoch_ = 0;
  bool paused_ = false;
  bool pending_ = false;
  std::uint64_t pendingSince_ = 0;
  std::uint64_t lastTriggerTick_ = 0;
  std::uint64_t lastQueryEnd_ = 0;
  std::uint64_t nextSample_ = 0;
  std::set<std::string> pendingKinds_;
  std::uint64_t pendingCount_ = 0;
  std::vector<Trigger> pendingActions_;
  bool pendingActionOverflow_ = false;
  std::uint64_t unsupportedActions_ = 0;
  std::string stopReason_ = "unknown";
  bool outputFailed_ = false;
  std::string failedChannel_;
  std::string failureCode_;
};

}  // namespace

int RunWindows(const cli::CommandLine& command) {
  const std::uint64_t foreground = ForegroundWindow();
  Json windows = Json::array();
  for (const std::uint64_t hwnd : VisibleTopLevelWindows(command.pid)) {
    std::string reason;
    const auto context = ReadWindowContext(hwnd, reason);
    Json entry;
    entry["hwnd"] = std::to_string(hwnd);
    entry["context"] = context ? protocol::ContextToJson(*context, std::nullopt) : Json(nullptr);
    if (!context) entry["reason"] = reason;
    entry["title"] = ReadWindowTitle(hwnd, 256);
    entry["foreground"] = hwnd == foreground;
    windows.push_back(std::move(entry));
  }
  Json out;
  out["protocol"] = protocol::kProtocolName;
  out["version"] = protocol::kProtocolVersion;
  out["platform"] = protocol::kPlatform;
  out["kind"] = "windows";
  out["pid"] = command.pid;
  out["windows"] = std::move(windows);
  return WriteStdout(DumpJson(out) + "\n") ? kExitOk : kExitOutput;
}

int RunApplications() {
  // Consent picker metadata only: no window titles, UIA calls or captured text.
  Json applications = Json::array();
  std::set<std::uint32_t> seen;
  for (const auto hwnd : VisibleTopLevelWindows(0)) {
    std::string reason;
    const auto context = ReadWindowContext(hwnd, reason);
    if (!context || !seen.insert(context->pid).second) continue;
    applications.push_back({{"pid", context->pid}, {"executable", context->executable},
                            {"processStart", std::to_string(context->processStart)}});
  }
  const Json out = {{"protocol", protocol::kProtocolName}, {"version", protocol::kProtocolVersion},
                    {"platform", protocol::kPlatform}, {"kind", "applications"},
                    {"applications", std::move(applications)}};
  return WriteStdout(DumpJson(out) + "\n") ? kExitOk : kExitOutput;
}

int RunCatalog() {
  Json applications = Json::array();
  for (const auto& entry : ApplicationCatalog())
    applications.push_back({{"executable", entry.executable}, {"name", entry.name}});
  const Json out = {{"protocol", protocol::kProtocolName}, {"version", protocol::kProtocolVersion},
                    {"platform", protocol::kPlatform}, {"kind", "application.catalog"},
                    {"applications", std::move(applications)}};
  return WriteStdout(DumpJson(out) + "\n") ? kExitOk : kExitOutput;
}

int RunSnapshot(const cli::CommandLine& command) {
  Session session;
  // Even a one-shot read watches foreground changes so A->B->A during the query is rejected.
  HookThread hooks(16);
  if (!hooks.Start(true, false)) {
    Diagnostic("hook_install_failed");
    return kExitInfrastructure;
  }
  WorkerHost host;
  std::string error;
  if (!host.Init(error)) {
    Diagnostic("worker_job_unavailable", error);
    return kExitInfrastructure;
  }
  Collector collector(AbsolutePath(command.policyPath), hooks, host, command.test);
  QueryOutcome query = collector.Query(command.hwnd, nullptr, 0);
  Json event = session.Envelope("snapshot");
  event["trigger"] = {{"kinds", Json::array({"explicit"})}, {"count", 1}};
  event["context"] = ContextJson(query);
  if (query.status == "ok") {
    std::vector<std::string> keys;
    Json nodes = KeyedNodes(query.response.nodes, keys, nullptr);
    Json body = OkBody(query, "full", FocusKey(query.response.nodes, keys));
    body["nodes"] = std::move(nodes);
    event["snapshot"] = std::move(body);
  } else {
    event["snapshot"] = NotOkBody(query);
  }
  std::string line = DumpJson(event) + "\n";
  if (query.status == "ok" && !collector.Commit(query, nullptr, 0)) {
    event["context"] = ContextJson(query);
    event["snapshot"] = NotOkBody(query);
    line = DumpJson(event) + "\n";
  }
  const bool written = WriteStdout(line);
  const bool stopped = hooks.Stop(2000);
  if (!written) return kExitOutput;
  if (!stopped) return kExitInternal;
  return query.status == "ok" ? kExitOk : kExitSnapshotNotOk;
}

int RunObserve(const cli::CommandLine& command) {
  Observer observer(command);
  return observer.Run();
}

}  // namespace memmy::win
