#pragma once

#include <windows.h>
#include <oleauto.h>

#include <memory>
#include <string_view>
#include <type_traits>

namespace memmy::win {

struct HandleCloser {
  void operator()(HANDLE handle) const noexcept {
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};
using UniqueHandle = std::unique_ptr<std::remove_pointer_t<HANDLE>, HandleCloser>;

inline UniqueHandle Own(HANDLE handle) {
  return UniqueHandle(handle == INVALID_HANDLE_VALUE ? nullptr : handle);
}

// COM apartment scope for the current thread.
class ComScope {
 public:
  explicit ComScope(DWORD model) : hr_(CoInitializeEx(nullptr, model)) {}
  ~ComScope() {
    if (SUCCEEDED(hr_)) CoUninitialize();
  }
  ComScope(const ComScope&) = delete;
  ComScope& operator=(const ComScope&) = delete;
  bool Ok() const { return SUCCEEDED(hr_); }

 private:
  HRESULT hr_;
};

class Bstr {
 public:
  Bstr() = default;
  ~Bstr() { SysFreeString(value_); }
  Bstr(const Bstr&) = delete;
  Bstr& operator=(const Bstr&) = delete;
  BSTR* Put() {
    SysFreeString(value_);
    value_ = nullptr;
    return &value_;
  }
  std::wstring_view View() const { return value_ ? std::wstring_view(value_, SysStringLen(value_)) : std::wstring_view(); }

 private:
  BSTR value_ = nullptr;
};

class Variant {
 public:
  Variant() { VariantInit(&value_); }
  ~Variant() { VariantClear(&value_); }
  Variant(const Variant&) = delete;
  Variant& operator=(const Variant&) = delete;
  VARIANT* Put() {
    VariantClear(&value_);
    return &value_;
  }
  const VARIANT& Get() const { return value_; }

 private:
  VARIANT value_;
};

class SafeArray {
 public:
  SafeArray() = default;
  ~SafeArray() {
    if (value_) SafeArrayDestroy(value_);
  }
  SafeArray(const SafeArray&) = delete;
  SafeArray& operator=(const SafeArray&) = delete;
  SAFEARRAY** Put() {
    if (value_) SafeArrayDestroy(value_);
    value_ = nullptr;
    return &value_;
  }
  SAFEARRAY* Get() const { return value_; }

 private:
  SAFEARRAY* value_ = nullptr;
};

}  // namespace memmy::win
