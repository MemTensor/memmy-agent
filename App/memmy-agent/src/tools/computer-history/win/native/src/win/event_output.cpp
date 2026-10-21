#include "win/event_output.h"

#include "win/system.h"

#include <cwchar>
#include <filesystem>
#include <system_error>

namespace memmy::win {

std::wstring EventOutput::SegmentPath(int index) const {
  if (index == 0) return base_;
  const std::filesystem::path base(base_);
  wchar_t suffix[16];
  std::swprintf(suffix, 16, L".%04d", index);
  std::filesystem::path name = base.stem();
  name += suffix;
  name += base.extension();
  return (base.parent_path() / name).wstring();
}

bool EventOutput::Open(const std::wstring& basePath, double rotateMs, double nowMs, std::string& error) {
  std::error_code ec;
  const std::filesystem::path absolute = std::filesystem::absolute(std::filesystem::path(basePath), ec);
  if (ec || !absolute.has_filename()) {
    error = "output_path_invalid";
    return false;
  }
  base_ = absolute.wstring();
  if (absolute.has_parent_path()) {
    std::filesystem::create_directories(absolute.parent_path(), ec);
    if (ec) {
      error = "output_directory_unavailable";
      return false;
    }
  }
  rotateMs_ = rotateMs;
  segmentStartMs_ = nowMs;
  return OpenSegment(0, error);
}

bool EventOutput::OpenSegment(int index, std::string& error) {
  const std::wstring path = SegmentPath(index);
  UniqueHandle file = Own(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
                                      FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file) {
    const DWORD code = GetLastError();
    error = code == ERROR_FILE_EXISTS || code == ERROR_ALREADY_EXISTS
                ? (index == 0 ? "output_exists" : "output_segment_exists")
                : "output_open_failed";
    fileHealthy_ = false;
    return false;
  }
  file_ = std::move(file);
  segment_ = index;
  fileHealthy_ = true;
  return true;
}

bool EventOutput::RotationDue(double nowMs) const {
  return file_ && fileHealthy_ && nowMs - segmentStartMs_ >= rotateMs_;
}

bool EventOutput::Flush() {
#if MEMMY_HISTORY_TEST_HOOKS
  if (testFailFlush_) return false;
#endif
  return FlushFileBuffers(file_.get()) != FALSE;
}

bool EventOutput::Rotate(double nowMs, std::string& error) {
  if (!file_) return true;
  if (!Flush()) {
    fileHealthy_ = false;
    error = "output_flush_failed";
    file_.reset();
    return false;
  }
  file_.reset();
  segmentStartMs_ = nowMs;
  return OpenSegment(segment_ + 1, error);
}

EventOutput::Failure EventOutput::Write(std::string_view line) {
  Failure failure = Failure::None;
  if (file_ && fileHealthy_) {
    std::size_t total = 0;
    while (total < line.size()) {
      DWORD written = 0;
      if (!WriteFile(file_.get(), line.data() + total, static_cast<DWORD>(line.size() - total), &written, nullptr) ||
          written == 0) {
        fileHealthy_ = false;
        failure = Failure::File;
        break;
      }
      total += written;
    }
  }
  if (stdoutHealthy_ && !WriteStdout(line)) {
    stdoutHealthy_ = false;
    if (failure == Failure::None) failure = Failure::Stdout;
  }
  return failure;
}

bool EventOutput::FlushPending(std::string& error) {
  if (!fileHealthy_) return false;
  if (file_ && !Flush()) {
    fileHealthy_ = false;
    error = "output_flush_failed";
    return false;
  }
  return true;
}

bool EventOutput::Close(std::string& error) {
  const bool ok = FlushPending(error);
  file_.reset();
  return ok;
}

}  // namespace memmy::win
