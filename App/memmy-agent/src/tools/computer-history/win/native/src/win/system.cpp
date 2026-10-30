#include "win/system.h"

#include "common/json.h"
#include "common/policy.h"
#include "common/text.h"
#include "win/identity.h"

#include <bcrypt.h>

#include <vector>

namespace memmy::win {

PolicyFile ReadPolicyFile(const std::wstring& path, bool retainRevisionLease) {
  PolicyFile result;
  result.error = "policy_unavailable";
  UniqueHandle file = Own(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!file) return result;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.get(), &size) || size.QuadPart < 0) return result;
  if (static_cast<std::uint64_t>(size.QuadPart) > policy::kMaxPolicyBytes) {
    result.error = "policy_too_large";
    return result;
  }
  std::string bytes(static_cast<std::size_t>(size.QuadPart), '\0');
  DWORD total = 0;
  while (total < bytes.size()) {
    DWORD read = 0;
    if (!ReadFile(file.get(), bytes.data() + total, static_cast<DWORD>(bytes.size() - total), &read, nullptr)) {
      return result;
    }
    if (read == 0) break;
    total += read;
  }
  // A size change between GetFileSizeEx and EOF means the bytes are not one revision.
  char extra = 0;
  DWORD extraRead = 0;
  if (total != bytes.size() || !ReadFile(file.get(), &extra, 1, &extraRead, nullptr) || extraRead != 0) {
    return result;
  }
  result.ok = true;
  result.error.clear();
  result.sha256 = Sha256Hex(bytes);
  result.bytes = std::move(bytes);
  if (retainRevisionLease) result.revisionLease = std::move(file);
  return result;
}

std::string Sha256Hex(std::string_view data) {
  unsigned char digest[32] = {};
  if (!BCRYPT_SUCCESS(BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0,
                                 reinterpret_cast<PUCHAR>(const_cast<char*>(data.data())),
                                 static_cast<ULONG>(data.size()), digest, sizeof(digest)))) {
    return {};
  }
  return text::ToLowerHex(digest, sizeof(digest));
}

std::string RandomHex(std::size_t bytes) {
  std::vector<unsigned char> buffer(bytes);
  if (!BCRYPT_SUCCESS(BCryptGenRandom(nullptr, buffer.data(), static_cast<ULONG>(buffer.size()),
                                      BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
    return {};
  }
  return text::ToLowerHex(buffer.data(), buffer.size());
}

std::uint64_t NowFileTime() {
  FILETIME now{};
  GetSystemTimePreciseAsFileTime(&now);
  return (static_cast<std::uint64_t>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
}

double MonotonicMs() {
  static const LARGE_INTEGER frequency = [] {
    LARGE_INTEGER value{};
    QueryPerformanceFrequency(&value);
    return value;
  }();
  static const LARGE_INTEGER origin = [] {
    LARGE_INTEGER value{};
    QueryPerformanceCounter(&value);
    return value;
  }();
  LARGE_INTEGER now{};
  QueryPerformanceCounter(&now);
  return static_cast<double>(now.QuadPart - origin.QuadPart) * 1000.0 / static_cast<double>(frequency.QuadPart);
}

std::uint64_t TickMs() { return GetTickCount64(); }

std::wstring SelfExecutablePath() {
  std::wstring path(32768, L'\0');
  const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (size == 0 || size >= path.size()) return {};
  path.resize(size);
  return path;
}

void Diagnostic(std::string_view code, std::string_view detail) {
  Json line = {{"diagnostic", std::string(code)}};
  if (!detail.empty()) line["detail"] = std::string(detail);
  const std::string bytes = DumpJson(line) + "\n";
  const HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
  if (error == nullptr || error == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(error, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
}

bool WriteStdout(std::string_view bytes) {
  const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (out == nullptr || out == INVALID_HANDLE_VALUE) return false;
  std::size_t total = 0;
  while (total < bytes.size()) {
    DWORD written = 0;
    if (!WriteFile(out, bytes.data() + total, static_cast<DWORD>(bytes.size() - total), &written, nullptr) ||
        written == 0) {
      return false;
    }
    total += written;
  }
  return true;
}

SessionLease::SessionLease(const wchar_t* prefix) {
  DWORD session = 0;
  ProcessIdToSessionId(GetCurrentProcessId(), &session);
  const std::wstring name = std::wstring(L"Local\\") + prefix + L"." + std::to_wstring(session);
  mutex_ = Own(CreateMutexW(nullptr, FALSE, name.c_str()));
  if (!mutex_) return;
  const DWORD wait = WaitForSingleObject(mutex_.get(), 0);
  // An abandoned mutex means the previous collector died; ownership passes to us.
  owned_ = wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
}

SessionLease::~SessionLease() {
  if (owned_) ReleaseMutex(mutex_.get());
}

UniqueHandle OpenParentProcess(std::uint32_t pid, std::string& error) {
  UniqueHandle parent = Own(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!parent) {
    error = "parent_unavailable";
    return nullptr;
  }
  const auto parentStart = ProcessCreationTime(parent.get());
  const auto selfStart = ProcessCreationTime(GetCurrentProcess());
  if (!parentStart || !selfStart || *parentStart > *selfStart) {
    error = "parent_identity_invalid";
    return nullptr;
  }
  if (WaitForSingleObject(parent.get(), 0) == WAIT_OBJECT_0) {
    error = "parent_exited";
    return nullptr;
  }
  return parent;
}

}  // namespace memmy::win
