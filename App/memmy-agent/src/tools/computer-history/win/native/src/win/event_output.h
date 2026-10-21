#pragma once

#include "win/raii.h"

#include <string>
#include <string_view>

namespace memmy::win {

// Mirrors every protocol line to stdout and, optionally, to time-segmented JSONL files.
// Segment 0 is the requested path; later segments insert ".NNNN" before the extension.
// Files are created with CREATE_NEW, so an existing recording is never overwritten.
class EventOutput {
 public:
  enum class Failure { None, Stdout, File };

  bool Open(const std::wstring& basePath, double rotateMs, double nowMs, std::string& error);
  bool HasFile() const { return static_cast<bool>(file_); }
  bool RotationDue(double nowMs) const;
  bool Rotate(double nowMs, std::string& error);
  // Writes to every healthy channel; reports the first channel that failed on this call.
  Failure Write(std::string_view line);
  bool FlushPending(std::string& error);
  bool Close(std::string& error);

  int SegmentIndex() const { return segment_; }
  std::wstring SegmentPath(int index) const;
  bool StdoutHealthy() const { return stdoutHealthy_; }
  bool FileHealthy() const { return fileHealthy_; }
#if MEMMY_HISTORY_TEST_HOOKS
  void TestFailFlush() { testFailFlush_ = true; }
#endif

 private:
  bool OpenSegment(int index, std::string& error);
  bool Flush();

  std::wstring base_;
  UniqueHandle file_;
  int segment_ = 0;
  double rotateMs_ = 0;
  double segmentStartMs_ = 0;
  bool stdoutHealthy_ = true;
  bool fileHealthy_ = true;
#if MEMMY_HISTORY_TEST_HOOKS
  bool testFailFlush_ = false;
#endif
};

}  // namespace memmy::win
