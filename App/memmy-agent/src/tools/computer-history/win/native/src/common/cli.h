#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace memmy::cli {

enum class CommandKind { Help, Version, Applications, Catalog, Windows, Snapshot, Observe, RecordTask, FinalizeTask, ExportTaskFrames, Worker };

// Fault-injection options. Accepted only by the separately built test-hooks executable.
struct TestOptions {
  std::uint32_t workerSleepMs = 0;  // worker sleeps after its first identity check
  std::wstring gate;                // Local\memmy-history-test-* event pair used once
  std::wstring commitGate;          // after serialization, immediately before final authorization
  bool flushFailure = false;
};

struct CommandLine {
  CommandKind kind = CommandKind::Help;
  std::uint32_t pid = 0;
  std::uint64_t hwnd = 0;
  std::wstring policyPath;
  std::wstring outputPath;
  std::wstring outputDirectory;
  std::wstring exportDirectory;
  std::uint32_t seconds = 30;
  std::uint32_t rotateSeconds = 600;
  std::uint32_t sampleMs = 1000;
  std::optional<std::uint32_t> parentPid;
  bool inputHooks = false;
  TestOptions test;
};

struct ParseResult {
  std::optional<CommandLine> command;
  std::string error;  // fixed code, never echoes the offending argument
};

// args excludes argv[0]. allowTestOptions is a compile-time constant in the recorder.
ParseResult Parse(const std::vector<std::wstring>& args, bool allowTestOptions);

const char* UsageText();

// Quotes one argument so CommandLineToArgvW / the MSVC CRT parse it back unchanged.
std::wstring QuoteArgument(std::wstring_view argument);

enum class ControlCommand { Pause, Resume, Stop, Unknown };
ControlCommand ParseControlCommand(std::string_view line);

// Splits a byte stream into '\n'-terminated lines (optional trailing '\r' removed). Lines
// longer than maxLine are discarded whole and counted, so control input stays bounded.
class LineSplitter {
 public:
  explicit LineSplitter(std::size_t maxLine) : maxLine_(maxLine) {}
  void Feed(const char* data, std::size_t size, std::vector<std::string>& lines);
  std::size_t Overlong() const { return overlong_; }

 private:
  std::size_t maxLine_;
  std::string current_;
  bool discarding_ = false;
  std::size_t overlong_ = 0;
};

}  // namespace memmy::cli
