#!/usr/bin/env python3
"""Prepare and check the user's explicitly authorized WeChat connection copy.

This module never grants permissions or changes the installed application. A probe
runs inside the copy's real executable and exits before its application entry point.
"""

import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


_SCHEMA = 4
_LOCK_NAME = "permission-helper.lock"
_APP_NAME = "Memmy WeChat Reader.app"
_PROBE_NAME = "MemmyWeChatPermissionProbe.dylib"
_PROBE_SOURCE = Path(__file__).with_name("permission_probe.m")
_BRIDGE_NAME = "MemmyWeChatPrivateStorage.dylib"
_BRIDGE_SOURCE = Path(__file__).with_name("private_storage_bridge.c")
_KEYCAPTURE_NAME = "MemmyWeChatKeyCapture.dylib"
_KEYCAPTURE_SOURCE = Path(__file__).with_name("key_capture_bridge.c")
_NATIVE_DIRECTORY = Path(__file__).with_name("native") / "arm64"


def _developer_clang():
    # A missing/stale developer selection must not trigger xcrun's install UI.
    directories = [Path(sys.executable).parent,
                   Path("/Library/Developer/CommandLineTools/usr/bin")]
    directories.extend(path / "Contents/Developer/usr/bin"
                       for path in sorted(Path("/Applications").glob("Xcode*.app")))
    for directory in directories:
        compiler = directory / "clang"
        if compiler.is_file() and os.access(compiler, os.X_OK) and compiler.resolve() != Path("/usr/bin/clang"):
            return str(compiler)
    # Only reached in a source checkout with no prebuilt dylibs; packaged builds
    # ship them. The reader's native helpers cannot be prepared without a compiler.
    raise RuntimeError("wechat_native_helpers_unavailable")


def _install_library(name, destination, compiler_arguments):
    precompiled = _NATIVE_DIRECTORY / name
    if precompiled.is_file() and not precompiled.is_symlink():
        shutil.copy2(precompiled, destination)
        return
    # Source checkouts can still build with installed tools. Packaged builds
    # carry signed libraries and never require a compiler on the user's Mac.
    _run([_developer_clang(), *compiler_arguments, "-o", str(destination)])


def _check_host_data_access():
    """The non-GUI Memmy child checks Memmy's existing access, never the copy's FDA."""
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    documents = home / "Library/Containers/com.tencent.xinWeChat/Data/Documents"
    # The first access waits for macOS to approve this process; a lost approval
    # interrupts the call, and checking again requests approval again.
    for attempt in range(3):
        try:
            descriptor = os.open(documents, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            os.close(descriptor)
            for config in documents.glob("app_data/net*/config.ini"):
                descriptor = os.open(config, os.O_RDONLY | os.O_NOFOLLOW)
                os.close(descriptor)
            return
        except InterruptedError:
            if attempt == 2:
                raise RuntimeError("wechat_data_access_interrupted") from None
        except PermissionError:
            raise RuntimeError("wechat_data_access_required") from None
        except OSError:
            raise RuntimeError("wechat_data_access_unavailable") from None


def _private(path, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("permission_helper_unsafe_path")
    return info


def _no_symlink_ancestors(path):
    for item in (path, *path.parents):
        try:
            if stat.S_ISLNK(item.lstat().st_mode):
                raise RuntimeError("permission_helper_unsafe_path")
        except FileNotFoundError:
            continue


def _private_directory(path):
    _no_symlink_ancestors(path)
    if not path.exists():
        missing = []
        parent = path
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for item in reversed(missing):
            item.mkdir(mode=0o700)
    _private(path, directory=True)


def _safe_bundle(app):
    root = app.lstat()
    if not stat.S_ISDIR(root.st_mode) or root.st_uid != os.getuid():
        raise RuntimeError("permission_helper_unsafe_path")
    resolved = app.resolve(strict=True)
    # Framework bundles contain conventional internal symlinks. Those must stay
    # inside this private copy; the cache, app root, and executable cannot be links.
    for item in app.rglob("*"):
        info = item.lstat()
        if info.st_uid != os.getuid():
            raise RuntimeError("permission_helper_unsafe_path")
        if stat.S_ISLNK(info.st_mode):
            if Path(os.readlink(item)).is_absolute():
                raise RuntimeError("permission_helper_unsafe_path")
            try:
                item.resolve(strict=True).relative_to(resolved)
            except (ValueError, FileNotFoundError, RuntimeError):
                raise RuntimeError("permission_helper_unsafe_path") from None
        elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise RuntimeError("permission_helper_unsafe_path")
    executable = app / "Contents/MacOS/WeChat"
    if not stat.S_ISREG(executable.lstat().st_mode):
        raise RuntimeError("permission_helper_unsafe_path")


def _run(arguments, timeout=120):
    result = subprocess.run(arguments, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("permission_helper_prepare_failed")
    return result.stdout + result.stderr


def _source_fingerprint(app):
    if not app.is_dir() or app.is_symlink():
        raise RuntimeError("wechat_application_missing")
    _run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])
    signature = _run(["/usr/bin/codesign", "-d", "--verbose=4", str(app)])
    return hashlib.sha256(signature).hexdigest()


def _copy_fingerprint(app):
    digest = hashlib.sha256()
    for item in sorted(app.rglob("*")):
        info = item.lstat()
        digest.update(os.fsencode(str(item.relative_to(app))))
        digest.update(str(stat.S_IMODE(info.st_mode)).encode())
        if stat.S_ISLNK(info.st_mode):
            digest.update(b"L" + os.fsencode(os.readlink(item)))
        elif stat.S_ISREG(info.st_mode):
            digest.update(b"F")
            with item.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        else:
            digest.update(b"D")
    return digest.hexdigest()


def _build_copy(app, destination, probe_source):
    import plistlib

    _run(["/usr/bin/ditto", str(app), str(destination)])
    _safe_bundle(destination)
    info_path = destination / "Contents/Info.plist"
    if not stat.S_ISREG(info_path.lstat().st_mode):
        raise RuntimeError("permission_helper_unsafe_path")
    with info_path.open("rb") as stream:
        info = plistlib.load(stream)
    for key in ("CFBundleURLTypes", "CFBundleDocumentTypes", "UTExportedTypeDeclarations", "UTImportedTypeDeclarations"):
        info.pop(key, None)
    with info_path.open("wb") as stream:
        plistlib.dump(info, stream, fmt=plistlib.FMT_BINARY)
    library = destination / "Contents/Frameworks" / _PROBE_NAME
    if library.exists() or library.is_symlink():
        raise RuntimeError("permission_helper_unsafe_path")
    library.parent.mkdir(parents=True, exist_ok=True)
    _install_library(_PROBE_NAME, library, ["-arch", "arm64", "-dynamiclib", "-fobjc-arc",
                     "-framework", "AppKit", "-framework", "Security", str(probe_source)])
    bridge = library.with_name(_BRIDGE_NAME)
    _install_library(_BRIDGE_NAME, bridge, ["-arch", "arm64", "-dynamiclib", "-Wall", "-Wextra", "-Werror",
                     str(_BRIDGE_SOURCE)])
    capture = library.with_name(_KEYCAPTURE_NAME)
    _install_library(_KEYCAPTURE_NAME, capture, ["-arch", "arm64", "-dynamiclib", "-O2", "-Wall", "-Wextra", "-Werror",
                     str(_KEYCAPTURE_SOURCE)])
    _run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(destination)])
    _run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(destination)])
    _safe_bundle(destination)


def _read_json(path, optional=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        if optional:
            return None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("permission_helper_unsafe_path")
        raw = os.read(fd, 8193)
        if len(raw) > 8192:
            raise ValueError("oversized permission helper result")
        return json.loads(raw)
    finally:
        os.close(fd)


def _atomic_json(path, value):
    if path.exists() or path.is_symlink():
        _private(path)
    temporary = path.with_name(path.name + "." + secrets.token_hex(12))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _exact_probe_pid(pid, executable):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return False
    try:
        library = ctypes.CDLL("/usr/lib/libproc.dylib")
        function = library.proc_pidpath
        function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        function.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(4096)
        return function(pid, buffer, len(buffer)) > 0 and os.fsdecode(buffer.value) == str(executable)
    except (OSError, AttributeError):
        return False


def _valid_probe_result(value, challenge, executable, expected_pid=None):
    if (not isinstance(value, dict) or "error" not in value or value.get("challenge") != challenge
            or value.get("phase") != "finished" or value.get("executable") != str(executable)
            or type(value.get("probePid")) is not int or value["probePid"] <= 1
            or (expected_pid is not None and value["probePid"] != expected_pid)
            or type(value.get("ready")) is not bool):
        return False
    error = value.get("error")
    allowed = {None, "wechat_private_storage_probe_failed",
               "wechat_copy_permission_probe_unavailable", "wechat_copy_permission_probe_failed"}
    return (error is None or isinstance(error, str)) and error in allowed and value["ready"] == (error is None)


def _probe_copy(shadow, state):
    if shadow != state / "connection-helper" / _APP_NAME:
        raise RuntimeError("permission_helper_unsafe_path")
    directory = Path(tempfile.mkdtemp(prefix="permission-probe-", dir=state / "connection-helper"))
    os.chmod(directory, 0o700)
    result_path = directory / "result.json"
    challenge = secrets.token_hex(32)
    _atomic_json(result_path, {})
    executable = shadow / "Contents/MacOS/WeChat"
    environment = dict(os.environ)
    for key in tuple(environment):
        if key.startswith("DYLD_") or key.startswith("MEMMY_WECHAT_"):
            del environment[key]
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    # An empty private fixture proves the copy reads through the storage bridge.
    # No source data or chat contents are copied while merely checking setup.
    storage = state / ("storage-session-" + secrets.token_hex(16))
    container = storage / "home/Library/Containers/com.tencent.xinWeChat"
    group = storage / "home/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"
    documents = container / "Data/Documents"
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    environment["MEMMY_WECHAT_CONTAINER_SOURCE"] = str(home / "Library/Containers/com.tencent.xinWeChat")
    environment["MEMMY_WECHAT_CONTAINER_COPY"] = str(container)
    environment["MEMMY_WECHAT_GROUP_SOURCE"] = str(home / "Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat")
    environment["MEMMY_WECHAT_GROUP_COPY"] = str(group)
    child = None
    try:
        _private_directory(documents)
        _private_directory(group)
        sentinel = documents / ".memmy-permission-probe"
        descriptor = os.open(sentinel, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        child = subprocess.Popen([
            sys.executable, "-B", str(Path(__file__).resolve()), "--probe-process",
            str(shadow), str(result_path), challenge,
        ], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            child.wait(timeout=25)
        except subprocess.TimeoutExpired:
            try:
                value = _read_json(result_path)
            except (OSError, ValueError):
                value = {}
            pid = value.get("probePid") if isinstance(value, dict) and value.get("challenge") == challenge else None
            if _exact_probe_pid(pid, executable):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child.kill()
            child.wait(timeout=3)
            return {"ready": False, "error": "wechat_copy_permission_probe_timeout"}
        value = _read_json(result_path)
        if not _valid_probe_result(value, challenge, executable):
            return {"ready": False, "error": "wechat_copy_permission_probe_failed"}
        error = value.get("error")
        return {"ready": value["ready"], "error": error, "probePid": value["probePid"]}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"ready": False, "error": "wechat_copy_permission_probe_failed"}
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        shutil.rmtree(directory)
        if storage.exists():
            shutil.rmtree(storage)


def _public_result(result):
    error = result["error"]
    if error in ("wechat_data_access_required", "wechat_data_access_unavailable", "wechat_data_access_interrupted"):
        pass
    elif error in ("wechat_private_storage_probe_failed", "wechat_copy_permission_probe_failed", "wechat_copy_permission_probe_timeout",
                   "wechat_copy_permission_probe_unavailable"):
        error = "wechat_data_access_probe_failed"
    elif error is not None:
        error = "wechat_permission_helper_unavailable"
    return {"ready": bool(result["ready"]), "appPath": result["appPath"], "error": error}


def prepare_permission_helper(state, app=Path("/Applications/WeChat.app")):
    state = Path(os.path.abspath(state))
    app = Path(app)
    cache = state / "connection-helper"
    shadow = cache / _APP_NAME
    result = {"ready": False, "appPath": None, "error": None}
    lock = None
    try:
        if os.getuid() == 0 or os.getuid() != os.geteuid():
            raise RuntimeError("root_execution_refused")
        _private_directory(state)
        _private_directory(cache)
        _check_host_data_access()
        for path in (cache / "manifest.json", cache / _LOCK_NAME):
            if path.exists() or path.is_symlink():
                _private(path)
        lock = os.open(cache / _LOCK_NAME, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("permission_helper_unsafe_path")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("permission_helper_busy") from None
        if shadow.exists() or shadow.is_symlink():
            _safe_bundle(shadow)
            result["appPath"] = str(shadow)
        fingerprint = _source_fingerprint(app)
        expected = {"schema": _SCHEMA, "source": fingerprint,
                    "probeSource": hashlib.sha256(_PROBE_SOURCE.read_bytes()).hexdigest(),
                    "bridgeSource": hashlib.sha256(_BRIDGE_SOURCE.read_bytes()).hexdigest(),
                    "keyCaptureSource": hashlib.sha256(_KEYCAPTURE_SOURCE.read_bytes()).hexdigest(),
                    "probeEnvironment": {"macOS": platform.mac_ver()[0], "machine": platform.machine()}}
        for name in (_PROBE_NAME, _BRIDGE_NAME, _KEYCAPTURE_NAME):
            binary = _NATIVE_DIRECTORY / name
            if binary.is_file() and not binary.is_symlink():
                expected[name] = hashlib.sha256(binary.read_bytes()).hexdigest()
        manifest_path = cache / "manifest.json"
        try:
            manifest = _read_json(manifest_path, optional=True)
        except (ValueError, UnicodeError):
            manifest = None
        reusable = (isinstance(manifest, dict) and shadow.exists()
                    and all(manifest.get(key) == value for key, value in expected.items())
                    and manifest.get("copyFingerprint") == _copy_fingerprint(shadow))
        if not reusable:
            staging = Path(tempfile.mkdtemp(prefix="build-", dir=cache))
            os.chmod(staging, 0o700)
            built = staging / _APP_NAME
            backup = staging / "previous.app"
            installed = False
            try:
                _build_copy(app, built, _PROBE_SOURCE)
                _safe_bundle(built)
                prepared = dict(expected, copyFingerprint=_copy_fingerprint(built))
                # A source update while copying must not publish a mismatched cache.
                if _source_fingerprint(app) != fingerprint:
                    raise RuntimeError("wechat_application_changed")
                if shadow.exists():
                    os.replace(shadow, backup)
                try:
                    os.replace(built, shadow)
                    installed = True
                    _atomic_json(manifest_path, prepared)
                    manifest = prepared
                    result["appPath"] = str(shadow)
                except Exception:
                    if installed:
                        shutil.rmtree(shadow)
                    if backup.exists():
                        os.replace(backup, shadow)
                    raise
            finally:
                shutil.rmtree(staging)
        # This proves the unchanged copy's storage bridge, not a saved disk
        # permission. _check_host_data_access still runs on every invocation.
        # Rechecking the same verified executable at dialog-open, confirmation
        # and connect would otherwise start three short-lived WeChat copies.
        if reusable and manifest.get("probeVerified") is True:
            result.update(ready=True, error=None)
            return _public_result(result)
        probe = _probe_copy(shadow, state)
        if probe.get("ready") is True and probe.get("error") is None:
            if _copy_fingerprint(shadow) != manifest.get("copyFingerprint"):
                raise RuntimeError("permission_helper_prepare_failed")
            _atomic_json(manifest_path, dict(manifest, probeVerified=True))
        result.update(probe)
        result["appPath"] = str(shadow)
        return _public_result(result)
    except RuntimeError as error:
        result["error"] = str(error)
    except (OSError, subprocess.SubprocessError, ValueError):
        result["error"] = "permission_helper_prepare_failed"
    finally:
        if lock is not None:
            os.close(lock)
    return _public_result(result)


def _run_probe(shadow, result_path, challenge):
    if shadow.name != _APP_NAME or shadow.parent.name != "connection-helper":
        return 2
    _safe_bundle(shadow)
    _private(result_path)
    _private(result_path.parent, directory=True)
    executable = shadow / "Contents/MacOS/WeChat"
    probe = shadow / "Contents/Frameworks" / _PROBE_NAME
    bridge = probe.with_name(_BRIDGE_NAME)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("DYLD_")}
    environment["DYLD_INSERT_LIBRARIES"] = str(bridge) + ":" + str(probe)
    environment["MEMMY_WECHAT_PERMISSION_PROBE"] = str(result_path)
    environment["MEMMY_WECHAT_PERMISSION_CHALLENGE"] = challenge
    for key in ("MEMMY_WECHAT_CONTAINER_SOURCE", "MEMMY_WECHAT_CONTAINER_COPY",
                "MEMMY_WECHAT_GROUP_SOURCE", "MEMMY_WECHAT_GROUP_COPY"):
        environment[key] = os.environ[key]
    child = None
    try:
        child = subprocess.Popen([str(executable)], cwd=str(executable.parent), env=environment,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            # The probe constructor writes its authenticated result and _exits
            # before WeChat's entry point, so the result file is definitive.
            try:
                value = _read_json(result_path)
            except (OSError, ValueError, UnicodeError):
                value = None
            if _valid_probe_result(value, challenge, executable, child.pid):
                return 0
            if child.poll() is not None:
                try:
                    value = _read_json(result_path)
                except (OSError, ValueError, UnicodeError):
                    value = None
                return 0 if _valid_probe_result(value, challenge, executable, child.pid) else 2
            time.sleep(0.025)
        return 2
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe-process", nargs=3, metavar=("APP", "RESULT", "CHALLENGE"))
    arguments = parser.parse_args()
    if not arguments.probe_process:
        raise SystemExit(2)
    try:
        app_path, output_path, token = arguments.probe_process
        raise SystemExit(_run_probe(Path(app_path), Path(output_path), token))
    except Exception:
        raise SystemExit(2)
