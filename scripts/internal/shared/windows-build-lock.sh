#!/usr/bin/env bash

memmy_windows_build_lock_is_held() {
  local expected_lock_path="$1"
  local expected_owner_prefix="${expected_lock_path//\\//}.owner-"
  local configured_owner_file="${MEMMY_WINDOWS_BUILD_LOCK_OWNER_FILE:-}"
  configured_owner_file="${configured_owner_file//\\//}"

  if [ "${MEMMY_WINDOWS_BUILD_LOCK_HELD:-}" != "1" ]; then
    return 1
  fi
  if [ -z "${MEMMY_WINDOWS_BUILD_LOCK_TOKEN:-}" ]; then
    return 1
  fi
  if [ -z "${MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID:-}" ]; then
    return 1
  fi
  local expected_owner_file="${expected_owner_prefix}${MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID}-${MEMMY_WINDOWS_BUILD_LOCK_TOKEN}"
  if [ "$configured_owner_file" != "$expected_owner_file" ]; then
    return 1
  fi
  if [ ! -f "$configured_owner_file" ]; then
    return 1
  fi

  local owner_pid
  local owner_token
  {
    IFS= read -r owner_pid || return 1
    IFS= read -r owner_token || return 1
  } < "$configured_owner_file"
  if [ "$owner_pid" != "$MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID" ] ||
    [ "$owner_token" != "$MEMMY_WINDOWS_BUILD_LOCK_TOKEN" ]; then
    return 1
  fi

  powershell.exe \
    -NoProfile \
    -ExecutionPolicy Bypass \
    -Command '& { param([int]$OwnerProcessId) $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerProcessId" -ErrorAction Stop; if (-not $owner -or $owner.Name -notlike "node*.exe" -or $owner.CommandLine -notlike "*run-with-file-lock.mjs*") { exit 1 } }' \
    "$MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID" >/dev/null 2>&1
}
