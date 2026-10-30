#include "common/text.h"

#include <windows.h>

#include <limits>

namespace memmy::text {
namespace {

void AppendUtf8(std::string& out, char32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

bool IsHighSurrogate(wchar_t c) { return c >= 0xD800 && c <= 0xDBFF; }
bool IsLowSurrogate(wchar_t c) { return c >= 0xDC00 && c <= 0xDFFF; }

// Decodes one code point at value[i]. Returns 0 on invalid input, otherwise the byte length.
std::size_t DecodeUtf8(std::string_view value, std::size_t i, char32_t& cp) {
  const auto byte = [&](std::size_t at) { return static_cast<unsigned char>(value[at]); };
  const unsigned char b0 = byte(i);
  std::size_t length = 0;
  unsigned char low = 0x80;
  unsigned char high = 0xBF;
  if (b0 < 0x80) {
    cp = b0;
    return 1;
  } else if (b0 >= 0xC2 && b0 <= 0xDF) {
    length = 2;
    cp = b0 & 0x1F;
  } else if (b0 >= 0xE0 && b0 <= 0xEF) {
    length = 3;
    cp = b0 & 0x0F;
    if (b0 == 0xE0) low = 0xA0;   // overlong
    if (b0 == 0xED) high = 0x9F;  // UTF-16 surrogate range
  } else if (b0 >= 0xF0 && b0 <= 0xF4) {
    length = 4;
    cp = b0 & 0x07;
    if (b0 == 0xF0) low = 0x90;   // overlong
    if (b0 == 0xF4) high = 0x8F;  // above U+10FFFF
  } else {
    return 0;
  }
  if (i + length > value.size()) return 0;
  for (std::size_t k = 1; k < length; ++k) {
    const unsigned char b = byte(i + k);
    const unsigned char min = k == 1 ? low : 0x80;
    const unsigned char max = k == 1 ? high : 0xBF;
    if (b < min || b > max) return 0;
    cp = (cp << 6) | (b & 0x3F);
  }
  return length;
}

template <typename Char>
std::optional<std::uint64_t> ParseDecimal(std::basic_string_view<Char> value) {
  if (value.empty() || value.size() > 20) return std::nullopt;
  if (value.size() > 1 && value[0] == Char('0')) return std::nullopt;
  std::uint64_t result = 0;
  for (const Char c : value) {
    if (c < Char('0') || c > Char('9')) return std::nullopt;
    const std::uint64_t digit = static_cast<std::uint64_t>(c - Char('0'));
    if (result > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) return std::nullopt;
    result = result * 10 + digit;
  }
  return result;
}

}  // namespace

std::string ToUtf8(std::wstring_view value) {
  std::string out;
  out.reserve(value.size());
  for (std::size_t i = 0; i < value.size(); ++i) {
    char32_t cp = value[i];
    if (IsHighSurrogate(value[i])) {
      if (i + 1 < value.size() && IsLowSurrogate(value[i + 1])) {
        cp = 0x10000 + ((static_cast<char32_t>(value[i]) - 0xD800) << 10) +
             (static_cast<char32_t>(value[i + 1]) - 0xDC00);
        ++i;
      } else {
        cp = 0xFFFD;
      }
    } else if (IsLowSurrogate(value[i])) {
      cp = 0xFFFD;
    }
    AppendUtf8(out, cp);
  }
  return out;
}

std::optional<std::wstring> FromUtf8(std::string_view value) {
  std::wstring out;
  out.reserve(value.size());
  for (std::size_t i = 0; i < value.size();) {
    char32_t cp = 0;
    const std::size_t length = DecodeUtf8(value, i, cp);
    if (length == 0) return std::nullopt;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<wchar_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<wchar_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<wchar_t>(cp));
    }
    i += length;
  }
  return out;
}

std::optional<std::size_t> Utf16Length(std::string_view utf8) {
  std::size_t units = 0;
  for (std::size_t i = 0; i < utf8.size();) {
    char32_t cp = 0;
    const std::size_t length = DecodeUtf8(utf8, i, cp);
    if (length == 0) return std::nullopt;
    units += cp >= 0x10000 ? 2 : 1;
    i += length;
  }
  return units;
}

std::wstring_view TruncateUtf16(std::wstring_view value, std::size_t maxUnits) {
  if (value.size() <= maxUnits) return value;
  std::size_t end = maxUnits;
  if (end > 0 && IsHighSurrogate(value[end - 1]) && IsLowSurrogate(value[end])) --end;
  return value.substr(0, end);
}

std::optional<std::uint64_t> ParseUnsignedDecimal(std::string_view value) {
  return ParseDecimal<char>(value);
}

std::optional<std::uint64_t> ParseUnsignedDecimal(std::wstring_view value) {
  return ParseDecimal<wchar_t>(value);
}

bool EqualsOrdinalIgnoreCase(std::wstring_view left, std::wstring_view right) {
  if (left.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()) ||
      right.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return false;
  }
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                              static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

std::string ToLowerHex(const unsigned char* data, std::size_t size) {
  static constexpr char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (std::size_t i = 0; i < size; ++i) {
    out.push_back(kDigits[data[i] >> 4]);
    out.push_back(kDigits[data[i] & 0x0F]);
  }
  return out;
}

}  // namespace memmy::text
