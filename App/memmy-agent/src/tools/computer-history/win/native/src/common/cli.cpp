#include "common/cli.h"

#include "common/text.h"

#include <algorithm>
#include <set>

namespace memmy::cli {
namespace {

constexpr std::wstring_view kTestGatePrefix = L"Local\\memmy-history-test-";

bool ParseRange(const std::wstring& value, std::uint64_t min, std::uint64_t max, std::uint64_t& out) {
  const auto parsed = text::ParseUnsignedDecimal(std::wstring_view(value));
  if (!parsed || *parsed < min || *parsed > max) return false;
  out = *parsed;
  return true;
}

}  // namespace

const char* UsageText() {
  return "memmy-history-recorder " MEMMY_HISTORY_RECORDER_VERSION
         " - Memmy Windows Computer History native recorder\n"
         "\n"
         "Usage:\n"
         "  memmy-history-recorder help | --help\n"
         "  memmy-history-recorder version | --version\n"
         "  memmy-history-recorder windows --pid N\n"
         "  memmy-history-recorder applications\n"
         "  memmy-history-recorder catalog\n"
         "  memmy-history-recorder snapshot --hwnd N --policy FILE\n"
         "  memmy-history-recorder observe --policy FILE [--output FILE] [--seconds N]\n"
         "                                 [--rotate-seconds N] [--sample-ms N]\n"
         "                                 [--parent-pid N] [--input-hooks]\n"
         "  memmy-history-recorder record-task --policy FILE --output-dir DIR\n"
         "                                    [--seconds N] [--parent-pid N] --input-hooks\n"
         "  memmy-history-recorder finalize-task --output-dir DIR\n"
         "  memmy-history-recorder export-task-frames --output-dir DIR --export-dir DIR\n"
         "\n"
         "Machine modes write UTF-8 JSONL to stdout; diagnostics go to stderr.\n"
         "observe reads 'pause', 'resume' and 'stop' lines from stdin; stdin EOF stops.\n"
         "Defaults: --seconds 30 (1..86400), --rotate-seconds 600 (1..86400),\n"
         "          --sample-ms 1000 (200..60000).\n"
         "Exit codes: 0 ok, 1 internal error, 2 usage/configuration error, 3 snapshot not ok,\n"
         "            4 collector already running, 5 capture infrastructure unavailable,\n"
         "            6 output write failure.\n";
}

ParseResult Parse(const std::vector<std::wstring>& args, bool allowTestOptions) {
  ParseResult result;
  CommandLine command;
  if (args.empty()) {
    command.kind = CommandKind::Help;
    result.command = command;
    return result;
  }
  const std::wstring& verb = args[0];
  if (verb == L"help" || verb == L"--help" || verb == L"-h") {
    command.kind = CommandKind::Help;
  } else if (verb == L"version" || verb == L"--version") {
    command.kind = CommandKind::Version;
  } else if (verb == L"windows") {
    command.kind = CommandKind::Windows;
  } else if (verb == L"applications") {
    command.kind = CommandKind::Applications;
  } else if (verb == L"catalog") {
    command.kind = CommandKind::Catalog;
  } else if (verb == L"snapshot") {
    command.kind = CommandKind::Snapshot;
  } else if (verb == L"observe") {
    command.kind = CommandKind::Observe;
  } else if (verb == L"record-task") {
    command.kind = CommandKind::RecordTask;
    command.seconds = 1200;
  } else if (verb == L"finalize-task") {
    command.kind = CommandKind::FinalizeTask;
  } else if (verb == L"export-task-frames") {
    command.kind = CommandKind::ExportTaskFrames;
  } else if (verb == L"__worker") {
    command.kind = CommandKind::Worker;
  } else {
    result.error = "unknown_command";
    return result;
  }

  if ((command.kind == CommandKind::Help || command.kind == CommandKind::Version || command.kind == CommandKind::Worker || command.kind == CommandKind::Applications || command.kind == CommandKind::Catalog) &&
      args.size() > 1) {
    result.error = "unknown_option";
    return result;
  }
  std::set<std::wstring> seen;
  for (std::size_t i = 1; i < args.size(); ++i) {
    const std::wstring& option = args[i];
    if (!seen.insert(option).second) {
      result.error = "duplicate_option";
      return result;
    }
    const auto flagAllowed = [&](std::initializer_list<CommandKind> kinds) {
      return std::find(kinds.begin(), kinds.end(), command.kind) != kinds.end();
    };
    // Options without a value.
    if (option == L"--input-hooks") {
      if (!flagAllowed({CommandKind::Observe, CommandKind::RecordTask})) {
        result.error = "unknown_option";
        return result;
      }
      command.inputHooks = true;
      continue;
    }
    if (i + 1 >= args.size()) {
      result.error = "missing_option_value";
      return result;
    }
    const std::wstring& value = args[++i];
    std::uint64_t number = 0;
    if (option == L"--pid" && flagAllowed({CommandKind::Windows})) {
      if (!ParseRange(value, 1, 0xFFFFFFFFull, number)) {
        result.error = "invalid_pid";
        return result;
      }
      command.pid = static_cast<std::uint32_t>(number);
    } else if (option == L"--hwnd" && flagAllowed({CommandKind::Snapshot})) {
      if (!ParseRange(value, 1, UINT64_MAX, number)) {
        result.error = "invalid_hwnd";
        return result;
      }
      command.hwnd = number;
    } else if (option == L"--policy" && flagAllowed({CommandKind::Snapshot, CommandKind::Observe, CommandKind::RecordTask})) {
      if (value.empty()) {
        result.error = "invalid_policy_path";
        return result;
      }
      command.policyPath = value;
    } else if (option == L"--output" && flagAllowed({CommandKind::Observe})) {
      if (value.empty()) {
        result.error = "invalid_output_path";
        return result;
      }
      command.outputPath = value;
    } else if (option == L"--output-dir" && flagAllowed({CommandKind::RecordTask, CommandKind::FinalizeTask, CommandKind::ExportTaskFrames})) {
      if (value.empty()) { result.error = "invalid_output_path"; return result; }
      command.outputDirectory = value;
    } else if (option == L"--export-dir" && flagAllowed({CommandKind::ExportTaskFrames})) {
      if (value.empty()) { result.error = "invalid_output_path"; return result; }
      command.exportDirectory = value;
    } else if (option == L"--seconds" && flagAllowed({CommandKind::Observe, CommandKind::RecordTask})) {
      if (!ParseRange(value, 1, command.kind == CommandKind::RecordTask ? 1200 : 86400, number)) {
        result.error = "invalid_seconds";
        return result;
      }
      command.seconds = static_cast<std::uint32_t>(number);
    } else if (option == L"--rotate-seconds" && flagAllowed({CommandKind::Observe})) {
      if (!ParseRange(value, 1, 86400, number)) {
        result.error = "invalid_rotate_seconds";
        return result;
      }
      command.rotateSeconds = static_cast<std::uint32_t>(number);
    } else if (option == L"--sample-ms" && flagAllowed({CommandKind::Observe, CommandKind::RecordTask})) {
      if (!ParseRange(value, 200, 60000, number)) {
        result.error = "invalid_sample_ms";
        return result;
      }
      command.sampleMs = static_cast<std::uint32_t>(number);
    } else if (option == L"--parent-pid" && flagAllowed({CommandKind::Observe, CommandKind::RecordTask})) {
      if (!ParseRange(value, 1, 0xFFFFFFFFull, number)) {
        result.error = "invalid_parent_pid";
        return result;
      }
      command.parentPid = static_cast<std::uint32_t>(number);
    } else if (allowTestOptions && option == L"--test-worker-sleep-ms" &&
               flagAllowed({CommandKind::Snapshot, CommandKind::Observe})) {
      if (!ParseRange(value, 1, 60000, number)) {
        result.error = "invalid_test_option";
        return result;
      }
      command.test.workerSleepMs = static_cast<std::uint32_t>(number);
    } else if (allowTestOptions && option == L"--test-flush-failure" && flagAllowed({CommandKind::Observe})) {
      if (value != L"true") {
        result.error = "invalid_test_option";
        return result;
      }
      command.test.flushFailure = true;
    } else if (allowTestOptions && (option == L"--test-gate" || option == L"--test-commit-gate") &&
               flagAllowed({CommandKind::Snapshot, CommandKind::Observe})) {
      if (value.size() <= kTestGatePrefix.size() || value.size() > 200 ||
          value.compare(0, kTestGatePrefix.size(), kTestGatePrefix) != 0 ||
          value.find_first_of(L"\\", kTestGatePrefix.size()) != std::wstring::npos) {
        result.error = "invalid_test_option";
        return result;
      }
      if (option == L"--test-gate") command.test.gate = value;
      else command.test.commitGate = value;
    } else {
      result.error = "unknown_option";
      return result;
    }
  }

  if (command.kind == CommandKind::Windows && command.pid == 0) result.error = "missing_pid";
  if (command.kind == CommandKind::Snapshot && (command.hwnd == 0 || command.policyPath.empty())) {
    result.error = command.hwnd == 0 ? "missing_hwnd" : "missing_policy";
  }
  if (command.kind == CommandKind::Observe && command.policyPath.empty()) result.error = "missing_policy";
  if (command.kind == CommandKind::RecordTask && command.policyPath.empty()) result.error = "missing_policy";
  if ((command.kind == CommandKind::RecordTask || command.kind == CommandKind::FinalizeTask || command.kind == CommandKind::ExportTaskFrames)
      && command.outputDirectory.empty()) result.error = "missing_output_directory";
  if (command.kind == CommandKind::ExportTaskFrames && command.exportDirectory.empty()) result.error = "missing_export_directory";
  if (result.error.empty()) result.command = command;
  return result;
}

std::wstring QuoteArgument(std::wstring_view argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring_view::npos) {
    return std::wstring(argument);
  }
  std::wstring quoted = L"\"";
  for (std::size_t i = 0;; ++i) {
    std::size_t backslashes = 0;
    while (i < argument.size() && argument[i] == L'\\') {
      ++backslashes;
      ++i;
    }
    if (i == argument.size()) {
      quoted.append(backslashes * 2, L'\\');
      break;
    }
    if (argument[i] == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
    } else {
      quoted.append(backslashes, L'\\');
      quoted.push_back(argument[i]);
    }
  }
  quoted.push_back(L'"');
  return quoted;
}

ControlCommand ParseControlCommand(std::string_view line) {
  while (!line.empty() && (line.back() == ' ' || line.back() == '\t')) line.remove_suffix(1);
  while (!line.empty() && (line.front() == ' ' || line.front() == '\t')) line.remove_prefix(1);
  if (line == "pause") return ControlCommand::Pause;
  if (line == "resume") return ControlCommand::Resume;
  if (line == "stop") return ControlCommand::Stop;
  return ControlCommand::Unknown;
}

std::optional<std::string> ParseCheckpointId(std::string_view line) {
  constexpr std::string_view prefix = "checkpoint ";
  if (!line.starts_with(prefix)) return std::nullopt;
  line.remove_prefix(prefix.size());
  if (line.size() != 36) return std::nullopt;
  for (std::size_t i = 0; i < line.size(); ++i) {
    const bool dash = i == 8 || i == 13 || i == 18 || i == 23;
    const char c = line[i];
    if (dash ? c != '-' : !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return std::nullopt;
  }
  return std::string(line);
}

void LineSplitter::Feed(const char* data, std::size_t size, std::vector<std::string>& lines) {
  for (std::size_t i = 0; i < size; ++i) {
    const char c = data[i];
    if (c == '\n') {
      if (!discarding_) {
        if (!current_.empty() && current_.back() == '\r') current_.pop_back();
        lines.push_back(std::move(current_));
      }
      current_.clear();
      discarding_ = false;
      continue;
    }
    if (discarding_) continue;
    if (current_.size() >= maxLine_) {
      discarding_ = true;
      ++overlong_;
      current_.clear();
      continue;
    }
    current_.push_back(c);
  }
}

}  // namespace memmy::cli
