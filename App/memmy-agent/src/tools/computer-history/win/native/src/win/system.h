#pragma once

#include "win/raii.h"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace memmy::win {

struct PolicyFile {
  bool ok = false;
  std::string error;  // policy_unavailable | policy_too_large
  std::string bytes;
  std::string sha256;
  UniqueHandle revisionLease;  // optional read handle denying writes/replacement until content is emitted
};

// Reads the whole policy file while denying concurrent writers (FILE_SHARE_READ only), so the
// bytes are one consistent revision. A writer holding the file makes the read fail closed.
PolicyFile ReadPolicyFile(const std::wstring& path, bool retainRevisionLease = false);

std::string Sha256Hex(std::string_view data);
std::string RandomHex(std::size_t bytes);

std::uint64_t NowFileTime();
double MonotonicMs();  // milliseconds since an arbitrary process-wide origin
std::uint64_t TickMs();

std::wstring SelfExecutablePath();

// Writes one diagnostic JSON object line to stderr (codes only, no captured content).
void Diagnostic(std::string_view code, std::string_view detail = {});
// Writes raw bytes to stdout. Returns false when the pipe/file is closed or broken.
bool WriteStdout(std::string_view bytes);

// Per-interactive-session single collector lease (Local\ named mutex).
class SessionLease {
 public:
  explicit SessionLease(const wchar_t* prefix);
  ~SessionLease();
  SessionLease(const SessionLease&) = delete;
  SessionLease& operator=(const SessionLease&) = delete;
  bool Acquired() const { return owned_; }

 private:
  UniqueHandle mutex_;
  bool owned_ = false;
};

// Opens and validates the parent process. Holding the handle prevents PID reuse; a process
// created after this collector cannot be its parent and is rejected.
UniqueHandle OpenParentProcess(std::uint32_t pid, std::string& error);

}  // namespace memmy::win
