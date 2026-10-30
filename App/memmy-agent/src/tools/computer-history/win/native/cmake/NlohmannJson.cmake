# Pinned, hash-verified single-header nlohmann/json.
#
# The header is fetched once into the build tree. Offline builds can pass
# -DMEMMY_NLOHMANN_JSON_HPP=<path to json.hpp>; the local copy is verified
# against the same SHA-256 before use. There is no unverified fallback.
#
# Provenance (checked 2026-10-01): the release asset below carries an upstream
# detached signature (json.hpp.asc) from Niels Lohmann, key fingerprint
# 7971 67AE 41C0 A6D9 232E 4845 7F3C EA63 AE25 1B69.

set(MEMMY_NLOHMANN_JSON_VERSION "3.12.0")
set(MEMMY_NLOHMANN_JSON_URL
    "https://github.com/nlohmann/json/releases/download/v3.12.0/json.hpp")
set(MEMMY_NLOHMANN_JSON_SHA256
    "aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63")
set(MEMMY_NLOHMANN_JSON_HPP "" CACHE FILEPATH
    "Optional local copy of nlohmann/json ${MEMMY_NLOHMANN_JSON_VERSION} json.hpp (SHA-256 verified)")

set(_memmy_json_root "${CMAKE_BINARY_DIR}/_deps/nlohmann-json-${MEMMY_NLOHMANN_JSON_VERSION}")
set(_memmy_json_header "${_memmy_json_root}/include/nlohmann/json.hpp")

function(_memmy_json_hash_ok path out_var)
  if(EXISTS "${path}")
    file(SHA256 "${path}" _hash)
    if(_hash STREQUAL MEMMY_NLOHMANN_JSON_SHA256)
      set(${out_var} TRUE PARENT_SCOPE)
      return()
    endif()
  endif()
  set(${out_var} FALSE PARENT_SCOPE)
endfunction()

_memmy_json_hash_ok("${_memmy_json_header}" _memmy_json_ready)
if(NOT _memmy_json_ready)
  file(REMOVE "${_memmy_json_header}")
  if(MEMMY_NLOHMANN_JSON_HPP)
    _memmy_json_hash_ok("${MEMMY_NLOHMANN_JSON_HPP}" _memmy_local_ok)
    if(NOT _memmy_local_ok)
      message(FATAL_ERROR
        "MEMMY_NLOHMANN_JSON_HPP=${MEMMY_NLOHMANN_JSON_HPP} does not match pinned SHA-256 "
        "${MEMMY_NLOHMANN_JSON_SHA256} (nlohmann/json ${MEMMY_NLOHMANN_JSON_VERSION}).")
    endif()
    file(MAKE_DIRECTORY "${_memmy_json_root}/include/nlohmann")
    file(COPY_FILE "${MEMMY_NLOHMANN_JSON_HPP}" "${_memmy_json_header}")
  else()
    message(STATUS "Downloading nlohmann/json ${MEMMY_NLOHMANN_JSON_VERSION} from ${MEMMY_NLOHMANN_JSON_URL}")
    file(DOWNLOAD "${MEMMY_NLOHMANN_JSON_URL}" "${_memmy_json_header}"
      EXPECTED_HASH SHA256=${MEMMY_NLOHMANN_JSON_SHA256}
      TLS_VERIFY ON
      STATUS _memmy_status)
    list(GET _memmy_status 0 _memmy_code)
    if(NOT _memmy_code EQUAL 0)
      file(REMOVE "${_memmy_json_header}")
      message(FATAL_ERROR
        "Could not download nlohmann/json (${_memmy_status}). For offline builds pass "
        "-DMEMMY_NLOHMANN_JSON_HPP=<path to json.hpp v${MEMMY_NLOHMANN_JSON_VERSION}>.")
    endif()
  endif()
  _memmy_json_hash_ok("${_memmy_json_header}" _memmy_json_ready)
  if(NOT _memmy_json_ready)
    message(FATAL_ERROR "nlohmann/json header failed SHA-256 verification.")
  endif()
endif()

add_library(memmy_nlohmann_json INTERFACE)
target_include_directories(memmy_nlohmann_json SYSTEM INTERFACE "${_memmy_json_root}/include")
target_compile_definitions(memmy_nlohmann_json INTERFACE JSON_USE_IMPLICIT_CONVERSIONS=0)
