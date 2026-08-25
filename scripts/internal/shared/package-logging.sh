#!/usr/bin/env bash

if [ "${MEMMY_PACKAGE_LOGGING_SH_LOADED:-}" = "1" ]; then
  return 0
fi
MEMMY_PACKAGE_LOGGING_SH_LOADED=1

package_log_now() {
  date '+%Y-%m-%d %H:%M:%S'
}

package_log_seconds() {
  date '+%s'
}

package_log_safe_label() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'
}

package_log_format_duration() {
  local seconds="$1"
  local hours=$((seconds / 3600))
  local minutes=$(((seconds % 3600) / 60))
  local rest=$((seconds % 60))

  if [ "$hours" -gt 0 ]; then
    printf '%dh%02dm%02ds' "$hours" "$minutes" "$rest"
  elif [ "$minutes" -gt 0 ]; then
    printf '%dm%02ds' "$minutes" "$rest"
  else
    printf '%ds' "$rest"
  fi
}

package_log_init() {
  local label="$1"
  local default_log_dir="$2"
  local log_dir="${MEMMY_PACKAGE_LOG_DIR:-$default_log_dir}"
  local safe_label

  mkdir -p "$log_dir"
  if [ -z "${MEMMY_PACKAGE_LOG_FILE:-}" ]; then
    safe_label="$(package_log_safe_label "$label")"
    MEMMY_PACKAGE_LOG_FILE="$log_dir/$safe_label-$(date '+%Y%m%d-%H%M%S').log"
    export MEMMY_PACKAGE_LOG_FILE
  fi

  touch "$MEMMY_PACKAGE_LOG_FILE"
  if [ "${MEMMY_PACKAGE_LOG_CAPTURE_ACTIVE:-}" != "1" ]; then
    MEMMY_PACKAGE_LOG_CAPTURE_ACTIVE=1
    export MEMMY_PACKAGE_LOG_CAPTURE_ACTIVE
    exec > >(tee -a "$MEMMY_PACKAGE_LOG_FILE") 2> >(tee -a "$MEMMY_PACKAGE_LOG_FILE" >&2)
  fi
  if [ -z "${MEMMY_PACKAGE_TOTAL_STARTED_AT:-}" ]; then
    MEMMY_PACKAGE_TOTAL_STARTED_AT="$(package_log_seconds)"
    export MEMMY_PACKAGE_TOTAL_STARTED_AT
  fi

  package_log "Package log file: $MEMMY_PACKAGE_LOG_FILE"
}

package_log() {
  local line
  line="[$(package_log_now)] $*"
  printf '\n%s\n' "$line"
  if [ -n "${MEMMY_PACKAGE_LOG_FILE:-}" ] && [ "${MEMMY_PACKAGE_LOG_CAPTURE_ACTIVE:-}" != "1" ]; then
    printf '%s\n' "$line" >> "$MEMMY_PACKAGE_LOG_FILE"
  fi
}

package_step_finish_current() {
  local status="${1:-0}"
  local now
  local elapsed
  local state="DONE"

  if [ -z "${MEMMY_PACKAGE_ACTIVE_STEP:-}" ]; then
    return 0
  fi

  now="$(package_log_seconds)"
  elapsed=$((now - ${MEMMY_PACKAGE_ACTIVE_STEP_STARTED_AT:-$now}))
  if [ "$status" -ne 0 ]; then
    state="FAILED"
  fi
  package_log "$state: $MEMMY_PACKAGE_ACTIVE_STEP ($(package_log_format_duration "$elapsed"))"
  MEMMY_PACKAGE_ACTIVE_STEP=""
  MEMMY_PACKAGE_ACTIVE_STEP_STARTED_AT=""
}

package_step_start() {
  package_step_finish_current 0
  MEMMY_PACKAGE_ACTIVE_STEP="$*"
  MEMMY_PACKAGE_ACTIVE_STEP_STARTED_AT="$(package_log_seconds)"
  package_log "START: $MEMMY_PACKAGE_ACTIVE_STEP"
}

package_run_step() {
  local label="$1"
  shift

  package_step_start "$label"
  if "$@"; then
    package_step_finish_current 0
    return 0
  else
    local status=$?
    package_step_finish_current "$status"
    return "$status"
  fi
}

package_log_error_trap() {
  local status="$1"
  local line="$2"
  local command="$3"

  trap - ERR
  package_step_finish_current "$status"
  package_log "FAILED at line $line with exit code $status: $command"
  package_log_finish "$status"
  exit "$status"
}

package_install_error_trap() {
  set -o errtrace
  trap 'package_log_error_trap "$?" "$LINENO" "$BASH_COMMAND"' ERR
}

package_log_finish() {
  local status="${1:-0}"
  local now
  local elapsed
  local state="FINISHED"

  package_step_finish_current "$status"
  now="$(package_log_seconds)"
  elapsed=$((now - ${MEMMY_PACKAGE_TOTAL_STARTED_AT:-$now}))
  if [ "$status" -ne 0 ]; then
    state="FAILED"
  fi
  package_log "$state: total packaging time $(package_log_format_duration "$elapsed")"
  package_log "Package log file: $MEMMY_PACKAGE_LOG_FILE"
}
