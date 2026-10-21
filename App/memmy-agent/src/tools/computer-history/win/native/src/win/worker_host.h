#pragma once

#include "win/raii.h"

#include <cstddef>
#include <string>

namespace memmy::win {

struct WorkerOutcome {
  enum class Kind { Completed, TimedOut, Cancelled, LaunchFailed, JobFailed, OutputTooLarge, Failed };
  Kind kind = Kind::Failed;
  std::string output;
  std::size_t stderrBytes = 0;
  DWORD exitCode = 0;
  DWORD pid = 0;
  bool reaped = true;
  double elapsedMs = 0;
};

// Runs one UIA query in a fresh copy of this executable ("__worker" mode). The worker is
// created suspended *inside* a kill-on-close Job Object (PROC_THREAD_ATTRIBUTE_JOB_LIST,
// verified with IsProcessInJob) and only then resumed, so a dead collector cannot strand it.
// Only its three private pipe ends are inherited. stdout/stderr
// are drained concurrently with bounded buffers so a chatty worker cannot deadlock the wait.
class WorkerHost {
 public:
  bool Init(std::string& error);
  WorkerOutcome Run(const std::string& request, DWORD timeoutMs, const HANDLE* cancelHandles,
                    DWORD cancelCount);
  static constexpr std::size_t kMaxStdout = 8 * 1024 * 1024;
  static constexpr std::size_t kMaxStderr = 64 * 1024;

 private:
  UniqueHandle job_;
  std::wstring self_;
};

}  // namespace memmy::win
