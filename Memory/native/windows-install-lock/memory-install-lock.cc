#include <node_api.h>
#include <windows.h>

#include <atomic>
#include <cstdio>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Token {
  HANDLE handle = INVALID_HANDLE_VALUE;
  std::atomic<bool> released{false};
};

void CloseToken(Token* token) {
  if (token == nullptr || token->released.exchange(true)) return;
  if (token->handle != INVALID_HANDLE_VALUE) {
    // Mark this exact file for deletion before closing its exclusive handle.
    // Never delete by path after close: an older installer may already own it.
    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    SetFileInformationByHandle(token->handle, FileDispositionInfo, &disposition, sizeof(disposition));
    CloseHandle(token->handle);
    token->handle = INVALID_HANDLE_VALUE;
  }
}

void FinalizeToken(napi_env, void* data, void*) {
  Token* token = static_cast<Token*>(data);
  CloseToken(token);
  delete token;
}

std::wstring ToWide(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    throw std::runtime_error("unable to read install lock path");
  }
  std::vector<char> utf8(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, utf8.data(), utf8.size(), &length) != napi_ok) {
    throw std::runtime_error("unable to read install lock path");
  }
  if (length == 0) throw std::runtime_error("install lock path must not be empty");
  int wideLength = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
                                       static_cast<int>(length), nullptr, 0);
  if (wideLength <= 0) throw std::runtime_error("install lock path is not valid UTF-8");
  std::wstring result(static_cast<size_t>(wideLength), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(length),
                      result.data(), wideLength);
  return result;
}

bool IsBusyError(DWORD error) {
  return error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION ||
         error == ERROR_ACCESS_DENIED;
}

void ThrowWin32(napi_env env, const char* operation, DWORD error = GetLastError()) {
  char message[256];
  snprintf(message, sizeof(message), "%s failed (Win32 error %lu)", operation,
           static_cast<unsigned long>(error));
  napi_throw_error(env, nullptr, message);
}

bool ReadMarker(HANDLE handle, std::string* marker, napi_env env) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size) || size.QuadPart < 0 || size.QuadPart > 4096) {
    ThrowWin32(env, "GetFileSizeEx");
    return false;
  }
  marker->assign(static_cast<size_t>(size.QuadPart), '\0');
  if (size.QuadPart == 0) return true;
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN)) {
    ThrowWin32(env, "SetFilePointerEx");
    return false;
  }
  DWORD read = 0;
  if (!ReadFile(handle, marker->data(), static_cast<DWORD>(marker->size()), &read, nullptr) ||
      read != marker->size()) {
    ThrowWin32(env, "ReadFile");
    return false;
  }
  return true;
}

enum class MarkerState { Empty, Dead, Live, Invalid };
MarkerState CheckMarker(const std::string& marker, napi_env env) {
  if (marker.empty()) return MarkerState::Empty;
  size_t end = marker.size();
  while (end > 0 && (marker[end - 1] == '\n' || marker[end - 1] == '\r' || marker[end - 1] == ' ' || marker[end - 1] == '\t')) --end;
  size_t begin = 0;
  while (begin < end && (marker[begin] == ' ' || marker[begin] == '\t')) ++begin;
  if (begin == end || end - begin > 10) return MarkerState::Invalid;
  uint64_t pid = 0;
  for (size_t i = begin; i < end; ++i) {
    if (marker[i] < '0' || marker[i] > '9') return MarkerState::Invalid;
    pid = pid * 10 + static_cast<unsigned>(marker[i] - '0');
    if (pid > 0xFFFFFFFFu) return MarkerState::Invalid;
  }
  if (pid == 0) return MarkerState::Invalid;
  HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                               static_cast<DWORD>(pid));
  if (process == nullptr) {
    DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER) return MarkerState::Dead;
    // Access to the PID cannot be established safely; fail closed as busy.
    return MarkerState::Live;
  }
  DWORD wait = WaitForSingleObject(process, 0);
  CloseHandle(process);
  if (wait == WAIT_OBJECT_0) return MarkerState::Dead;
  if (wait == WAIT_TIMEOUT) return MarkerState::Live;
  return MarkerState::Live;
}

napi_value TryAcquire(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1) { napi_throw_type_error(env, nullptr, "tryAcquire requires a path"); return nullptr; }
  napi_valuetype type;
  napi_typeof(env, argv[0], &type);
  if (type != napi_string) { napi_throw_type_error(env, nullptr, "lock path must be a string"); return nullptr; }
  std::wstring path;
  try { path = ToWide(env, argv[0]); } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

  HANDLE handle = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE, 0, nullptr,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    if (IsBusyError(error)) { napi_value nullValue; napi_get_null(env, &nullValue); return nullValue; }
    ThrowWin32(env, "CreateFileW", error);
    return nullptr;
  }
  std::string marker;
  if (!ReadMarker(handle, &marker, env)) { CloseHandle(handle); return nullptr; }
  MarkerState state = CheckMarker(marker, env);
  if (state == MarkerState::Invalid) { CloseHandle(handle); napi_throw_error(env, nullptr, "install lock contains an invalid PID marker"); return nullptr; }
  if (state == MarkerState::Live) { CloseHandle(handle); napi_value nullValue; napi_get_null(env, &nullValue); return nullValue; }


  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) || !SetEndOfFile(handle)) {
    DWORD error = GetLastError(); CloseHandle(handle); ThrowWin32(env, "truncate install lock", error); return nullptr;
  }
  std::string pid = std::to_string(GetCurrentProcessId()) + "\n";
  DWORD written = 0;
  if (!WriteFile(handle, pid.data(), static_cast<DWORD>(pid.size()), &written, nullptr) || written != pid.size()) {
    DWORD error = GetLastError(); CloseHandle(handle); ThrowWin32(env, "WriteFile install lock", error); return nullptr;
  }
  FlushFileBuffers(handle);

  Token* token = new Token{handle};
  napi_value object;
  napi_create_object(env, &object);
  napi_wrap(env, object, token, FinalizeToken, nullptr, nullptr);
  return object;
}

napi_value Release(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1) { napi_throw_type_error(env, nullptr, "release requires a token"); return nullptr; }
  Token* token = nullptr;
  napi_status status = napi_unwrap(env, argv[0], reinterpret_cast<void**>(&token));
  if (status != napi_ok || token == nullptr) { napi_throw_type_error(env, nullptr, "invalid install lock token"); return nullptr; }
  CloseToken(token);
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"tryAcquire", nullptr, TryAcquire, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 2, methods);
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
