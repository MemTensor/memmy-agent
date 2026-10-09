#!/usr/bin/env bash
# May also be sourced by the installer tests; only package installation needs root.
set -euo pipefail

computer_use_dependencies_available() {
  # Match the python3 selected by the native backend, including its PATH.
  python3 -c 'import gi; gi.require_version("Atspi", "2.0"); gi.require_version("Gdk", "3.0"); from gi.repository import Atspi, Gdk' >/dev/null 2>&1 \
    && [ -r /usr/share/dbus-1/services/org.a11y.Bus.service ]
}

computer_use_dependency_error() {
  printf 'Computer Use dependencies: %s\n' "$*" >&2
  printf '%s\n' 'Fix the error and rerun the installer. For headless CLI use only, set MEMMY_INSTALL_COMPUTER_USE_DEPS=0 to skip desktop dependencies.' >&2
  return 1
}

install_computer_use_dependencies() {
  case "${MEMMY_INSTALL_COMPUTER_USE_DEPS:-1}" in
    0)
      printf '%s\n' 'Skipping Computer Use system dependencies as requested; desktop automation may be unavailable.'
      return 0
      ;;
    1) ;;
    *) computer_use_dependency_error 'MEMMY_INSTALL_COMPUTER_USE_DEPS must be 0 or 1'; return 1 ;;
  esac
  if computer_use_dependencies_available; then
    printf '%s\n' 'Computer Use system dependencies are already available.'
    return 0
  fi

  local manager
  local -a packages elevate
  if command -v apt-get >/dev/null 2>&1; then
    manager=apt-get
    packages=(python3 python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core)
  elif command -v dnf >/dev/null 2>&1; then
    manager=dnf
    packages=(python3 python3-gobject gtk3 at-spi2-core)
  elif command -v pacman >/dev/null 2>&1; then
    manager=pacman
    packages=(python python-gobject gtk3 at-spi2-core)
  else
    computer_use_dependency_error 'Automatic installation supports apt-get, dnf and pacman. Install Python 3, PyGObject, AT-SPI2 and GDK 3 using your distribution package manager.'
    return 1
  fi

  elevate=("$manager")
  printf 'Installing Computer Use system packages with %s: %s\n' "$manager" "${packages[*]}"
  if [ "$(id -u)" != 0 ]; then
    if ! command -v sudo >/dev/null 2>&1; then
      computer_use_dependency_error 'Administrator access is required, but sudo is unavailable. Ask an administrator to install the packages listed above; run Memmy as your normal user.'
      return 1
    fi
    printf '%s\n' 'sudo may ask for your password to install these system packages.'
    elevate=(sudo "$manager")
  fi
  case "$manager" in
    apt-get)
      if ! "${elevate[@]}" update \
        || ! "${elevate[@]}" install -y --no-install-recommends "${packages[@]}"; then
        computer_use_dependency_error 'apt-get failed (check permissions, network and package repositories).'
        return 1
      fi
      ;;
    dnf)
      "${elevate[@]}" install -y "${packages[@]}" \
        || { computer_use_dependency_error 'dnf failed (check permissions, network and package repositories).'; return 1; }
      ;;
    pacman)
      # Do not refresh only the package database or perform a whole-system upgrade.
      "${elevate[@]}" -S --needed --noconfirm "${packages[@]}" \
        || { computer_use_dependency_error 'pacman failed; check permissions and network, or update the system normally before retrying.'; return 1; }
      ;;
  esac
  if ! computer_use_dependencies_available; then
    computer_use_dependency_error 'Packages were installed, but python3 cannot load Atspi/Gdk or the AT-SPI D-Bus service is missing. Check whether a virtualenv or custom Python shadows the system python3 in PATH.'
    return 1
  fi
  printf '%s\n' 'Computer Use system dependencies are ready. Desktop automation requires a logged-in graphical session.'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_computer_use_dependencies
fi
