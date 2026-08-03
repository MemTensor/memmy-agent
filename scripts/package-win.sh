#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ARCH="x64"
VERSION=""
EDITION="cn"
SIGN="unsigned"
PASSTHROUGH_ARGS=()

usage() {
  cat <<'USAGE'
Usage: package-win.sh --version <version> --arch <x64> --edition <cn|intl> --sign <signed|unsigned> [electron-builder args...]

Examples:
  bash scripts/package-win.sh --version 0.0.1 --arch x64 --edition cn --sign signed
  bash scripts/package-win.sh --version 0.0.1 --arch x64 --edition intl --sign unsigned
  bash scripts/package-win.sh --version 0.0.1 --edition cn --sign signed

Defaults:
  --arch     x64
  --edition  cn
  --sign     unsigned

Required:
  --version  package version, for example 0.0.1
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ "$#" -lt 2 ]; then
        echo "--version requires a version value" >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --arch)
      if [ "$#" -lt 2 ]; then
        echo "--arch requires x64" >&2
        exit 1
      fi
      ARCH="$2"
      shift 2
      ;;
    --arch=*)
      ARCH="${1#--arch=}"
      shift
      ;;
    --x64|x64)
      ARCH="x64"
      shift
      ;;
    --edition)
      if [ "$#" -lt 2 ]; then
        echo "--edition requires cn or intl" >&2
        exit 1
      fi
      EDITION="$2"
      shift 2
      ;;
    --edition=*)
      EDITION="${1#--edition=}"
      shift
      ;;
    --cn|cn)
      EDITION="cn"
      shift
      ;;
    --intl|intl)
      EDITION="intl"
      shift
      ;;
    --sign|--signing)
      if [ "$#" -lt 2 ]; then
        echo "--sign requires signed or unsigned" >&2
        exit 1
      fi
      SIGN="$2"
      shift 2
      ;;
    --sign=*|--signing=*)
      SIGN="${1#*=}"
      shift
      ;;
    --signed|signed)
      SIGN="signed"
      shift
      ;;
    --unsigned|unsigned)
      SIGN="unsigned"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      PASSTHROUGH_ARGS+=("$@")
      break
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "--version is required. Example: --version 0.0.1" >&2
  usage >&2
  exit 1
fi

case "$ARCH" in
  x64)
    ;;
  *)
    echo "Unsupported Windows package arch: $ARCH" >&2
    exit 1
    ;;
esac

case "$EDITION" in
  cn)
    export MEMMY_ACCOUNT_CHANNEL=phone
    export MEMMY_APP_EDITION=cn
    ;;
  intl)
    export MEMMY_ACCOUNT_CHANNEL=email
    export MEMMY_APP_EDITION=intl
    ;;
  *)
    echo "Unsupported Windows package edition: $EDITION" >&2
    exit 1
    ;;
esac

case "$SIGN" in
  signed)
    unset MEMMY_SKIP_CODESIGN
    ;;
  unsigned)
    export MEMMY_SKIP_CODESIGN=1
    ;;
  *)
    echo "Unsupported Windows signing mode: $SIGN" >&2
    exit 1
    ;;
esac

export MEMMY_DESKTOP_VERSION="$VERSION"
if [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
  bash "$ROOT_DIR/scripts/internal/package-win-x64.sh" "${PASSTHROUGH_ARGS[@]}"
else
  bash "$ROOT_DIR/scripts/internal/package-win-x64.sh"
fi
