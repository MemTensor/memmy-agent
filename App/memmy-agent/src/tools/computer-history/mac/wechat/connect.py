#!/usr/bin/env python3
"""One-time, user-initiated connection of the current personal WeChat account.

The UI must explain that WeChat will quit normally, a temporary copy may ask
for login, and the original app will reopen. This helper never runs merely
because the chat-reading permission was toggled on.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import signal
import shutil
import subprocess
import sys
import time
import uuid


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def command(arguments, *, env=None):
    result = subprocess.run(arguments, capture_output=True, text=True, env=env)
    if result.returncode:
        raise RuntimeError("command_failed:" + Path(arguments[0]).name)
    return result.stdout or result.stderr


def running_wechat():
    result = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True)
    return bool(result.stdout.strip())


def temporary_copy_running(shadow):
    result = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True)
    for pid in result.stdout.split():
        process = subprocess.run(["ps", "-p", pid, "-o", "comm="], capture_output=True, text=True)
        if str(shadow) in process.stdout:
            return True
    return False


def current_database_root():
    home = Path.home() / "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
    roots = []
    for candidate in home.glob("*/db_storage"):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        files = list(candidate.rglob("*.db"))
        if not files:
            continue
        roots.append(candidate.resolve(strict=True))
    if not roots:
        raise RuntimeError("wechat_login_required")
    if len(roots) == 1:
        return roots[0]

    # Modification time can select the wrong account when two accounts have
    # recently synced. Identify the database opened by the running original.
    pids = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True).stdout.split()
    if pids:
        opened = subprocess.run(["/usr/sbin/lsof", "-Fn", "-p", ",".join(pids)],
                                capture_output=True, text=True)
        active = set()
        for line in opened.stdout.splitlines():
            if not line.startswith("n"):
                continue
            name = line[1:]
            for candidate in roots:
                if name.startswith(str(candidate) + os.sep):
                    active.add(candidate)
        if len(active) == 1:
            return next(iter(active))
    raise RuntimeError("current_account_ambiguous")


def private_save(path, value):
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def consent_id(state):
    file = state / "consent.json"
    if not file.is_file() or file.is_symlink() or file.stat().st_mode & 0o077:
        return None
    try:
        value = json.loads(file.read_text())
        if value.get("version") == 1 and value.get("enabled") is True and value.get("consentedAt"):
            identifier = value.get("consentId")
            return identifier if isinstance(identifier, str) and identifier else None
        return None
    except (OSError, ValueError, AttributeError):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=240)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("mac_arm64_required")
    if os.geteuid() == 0:
        raise RuntimeError("root_execution_refused")
    state = args.state.resolve()
    active_consent_id = consent_id(state)
    if not active_consent_id:
        raise RuntimeError("wechat_consent_required")
    library = args.library.resolve(strict=True)
    app = Path("/Applications/WeChat.app").resolve(strict=True)
    original = app / "Contents/MacOS/WeChat"
    if not original.is_file():
        raise RuntimeError("wechat_application_missing")
    root = current_database_root()
    signature = command(["codesign", "-dvv", str(app)])
    command(["codesign", "--verify", "--deep", "--strict", str(app)])
    os.umask(0o077)
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(state, 0o700)
    work = state / ("temporary-" + uuid.uuid4().hex)
    work.mkdir(mode=0o700)
    shadow = work / "WeChat-trial.app"
    next_keys = state / "keys.next.json"
    next_cursor = state / "cursor.next.json"
    if next_keys.exists() or next_cursor.exists():
        raise RuntimeError("previous_connection_incomplete")

    try:
        emit("quitting_original")
        if running_wechat():
            subprocess.run(["osascript", "-e", 'tell application id "com.tencent.xinWeChat" to quit'],
                           capture_output=True, text=True)
            until = time.monotonic() + 20
            while running_wechat() and time.monotonic() < until:
                time.sleep(0.5)
            if running_wechat():
                raise RuntimeError("quit_wechat_manually")
        emit("preparing_temporary_copy")
        command(["ditto", str(app), str(shadow)])
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        command(["codesign", "--force", "--deep", "--sign", "-", str(shadow)])
        command(["codesign", "--verify", "--deep", "--strict", str(shadow)])
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        lldb_path = command(["/usr/bin/lldb", "-P"]).strip()
        environment = dict(os.environ, PYTHONPATH=lldb_path)
        capture = Path(__file__).with_name("capture_keys.py")
        emit("awaiting_wechat_login")
        process = subprocess.Popen([
            "/usr/bin/python3", str(capture), "--executable", str(shadow / "Contents/MacOS/WeChat"),
            "--root", str(root), "--output", str(next_keys),
            "--consent-file", str(state / "consent.json"),
            "--consent-id", active_consent_id, "--seconds", str(args.seconds),
        ], env=environment)
        code = process.wait()
        if code != 0 or not next_keys.exists():
            raise RuntimeError("key_capture_failed")
        reader = Path(__file__).with_name("read_messages.py")
        baseline = command([
            "/usr/bin/python3", str(reader), "baseline", "--root", str(root),
            "--keys", str(next_keys), "--library", str(library),
        ])
        result = json.loads(baseline)
        if not result.get("databaseCount") or result.get("messages"):
            raise RuntimeError("database_baseline_failed")
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        private_save(next_cursor, result["nextCursor"])
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        os.replace(next_keys, state / "keys.json")
        os.replace(next_cursor, state / "cursor.json")
        private_save(state / "account.json", {"databaseRoot": str(root),
                                              "connectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        emit("connected", verified_message_databases=result["databaseCount"])
        return 0
    finally:
        if "process" in locals() and process.poll() is None:
            try:
                process.send_signal(signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        signature_ok = False
        try:
            signature_ok = command(["codesign", "-dvv", str(app)]) == signature
        except RuntimeError:
            pass
        temporary_running = temporary_copy_running(shadow)
        if temporary_running:
            emit("manual_restore_required", reason="temporary_wechat_still_running")
        else:
            if shadow.exists():
                registrar = ("/System/Library/Frameworks/CoreServices.framework/Frameworks/"
                             "LaunchServices.framework/Support/lsregister")
                subprocess.run([registrar, "-u", str(shadow)], capture_output=True)
            shutil.rmtree(work, ignore_errors=True)
            if not running_wechat():
                reopened = subprocess.run(["open", "-a", "/Applications/WeChat.app"], capture_output=True)
                emit("original_reopened", success=reopened.returncode == 0)
        next_keys.unlink(missing_ok=True)
        next_cursor.unlink(missing_ok=True)
        if consent_id(state) != active_consent_id:
            (state / "keys.json").unlink(missing_ok=True)
            (state / "account.json").unlink(missing_ok=True)
        if not signature_ok:
            raise RuntimeError("original_signature_check_failed")
        if temporary_running:
            raise RuntimeError("temporary_wechat_still_running")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("connection_error", category=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        raise SystemExit(2)
