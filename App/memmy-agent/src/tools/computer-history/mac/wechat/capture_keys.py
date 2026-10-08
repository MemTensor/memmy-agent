#!/usr/bin/env python3
"""Capture keys from the one temporary WeChat process launched by this helper.

The caller must have obtained explicit chat-reading consent. Nothing attaches
to an existing process, changes the original app, or disables SIP.
"""

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import time


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def authenticated_page(raw_key, page):
    if len(raw_key) != 32 or len(page) != 4096:
        return False
    salt = bytes(byte ^ 0x3A for byte in page[:16])
    mac_key = hashlib.pbkdf2_hmac("sha512", raw_key, salt, 2, 32)
    signed = page[16:4032] + b"\x01\x00\x00\x00"
    return hmac.compare_digest(hmac.new(mac_key, signed, hashlib.sha512).digest(), page[4032:])


def save_private(path, entries):
    temporary = path.with_suffix(".pending")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump({"keys": entries}, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def encrypted_pages(root):
    pages = {}
    for db in sorted(root.rglob("*.db")):
        with db.open("rb") as source:
            page = source.read(4096)
        if len(page) == 4096 and not page.startswith(b"SQLite format 3\x00"):
            pages[db.relative_to(root).as_posix()] = page
    return pages


def consent_enabled(file, identifier):
    if file.is_symlink() or not file.is_file() or file.stat().st_mode & 0o077:
        return False
    try:
        state = json.loads(file.read_text())
        return (state.get("version") == 1 and state.get("enabled") is True
                and bool(state.get("consentedAt")) and state.get("consentId") == identifier)
    except (OSError, ValueError, AttributeError):
        return False


def main():
    import lldb

    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--consent-file", type=Path, required=True)
    parser.add_argument("--consent-id", required=True)
    parser.add_argument("--seconds", type=int, default=240)
    args = parser.parse_args()
    executable = args.executable.resolve(strict=True)
    root = args.root.resolve(strict=True)
    output = args.output
    if not consent_enabled(args.consent_file, args.consent_id):
        raise RuntimeError("wechat_consent_required")
    if output.exists() or output.with_suffix(".pending").exists():
        raise RuntimeError("key_output_already_exists")
    pages = encrypted_pages(root)
    if not pages:
        raise RuntimeError("no_encrypted_databases")
    by_salt = {}
    for name, page in pages.items():
        by_salt.setdefault(page[:16], []).append((name, page))
    mac_salts = {bytes(byte ^ 0x3A for byte in salt): salt for salt in by_salt}
    found = {}
    calls = 0

    debugger = lldb.SBDebugger.Create()
    debugger.SkipLLDBInitFiles(True)
    debugger.SetAsync(True)
    listener = debugger.GetListener()
    target = debugger.CreateTarget(str(executable))
    if not target.IsValid() or not target.GetTriple().startswith("arm64"):
        raise RuntimeError("unsupported_debug_target")
    breakpoint = target.BreakpointCreateByName("CCKeyDerivationPBKDF")
    if not breakpoint.IsValid():
        raise RuntimeError("key_derivation_breakpoint_unavailable")
    launch = lldb.SBLaunchInfo([])
    launch.SetListener(listener)
    launch.SetWorkingDirectory(str(executable.parent))
    launch.AddSuppressFileAction(0, True, False)
    launch.AddSuppressFileAction(1, False, True)
    launch.AddSuppressFileAction(2, False, True)
    error = lldb.SBError()
    process = None

    def memory(address, size):
        read_error = lldb.SBError()
        value = bytes(process.ReadMemory(address, size, read_error))
        return value if read_error.Success() and len(value) == size else b""

    try:
        process = target.Launch(launch, error)
        if error.Fail() or not process.IsValid():
            raise RuntimeError("temporary_wechat_launch_failed")
        emit("temporary_app_started", expected_databases=len(pages))
        deadline = time.monotonic() + max(30, min(args.seconds, 300))
        last_status = time.monotonic()
        while time.monotonic() < deadline and len(found) < len(pages):
            if not consent_enabled(args.consent_file, args.consent_id):
                raise RuntimeError("wechat_consent_revoked")
            event = lldb.SBEvent()
            if not listener.WaitForEvent(1, event):
                if time.monotonic() - last_status >= 15:
                    emit("waiting_for_login", verified_databases=len(found))
                    last_status = time.monotonic()
                continue
            if not lldb.SBProcess.EventIsProcessEvent(event):
                continue
            state = lldb.SBProcess.GetStateFromEvent(event)
            if state in (lldb.eStateExited, lldb.eStateCrashed, lldb.eStateDetached):
                break
            if state != lldb.eStateStopped:
                continue
            for thread in process:
                if thread.GetStopReason() != lldb.eStopReasonBreakpoint:
                    continue
                if thread.GetStopReasonDataCount() < 2 or thread.GetStopReasonDataAtIndex(0) != breakpoint.GetID():
                    continue
                calls += 1
                frame = thread.GetFrameAtIndex(0)
                argument = lambda index: frame.FindRegister("x" + str(index)).GetValueAsUnsigned()
                password_ptr, password_len, salt_ptr, salt_len, algorithm, rounds = [argument(i) for i in range(1, 7)]
                if salt_len != 16 or not 0 < password_len <= 256 or algorithm != 5 or rounds not in (2, 256000):
                    continue
                observed_salt = memory(salt_ptr, 16)
                salt = observed_salt if rounds == 256000 else mac_salts.get(observed_salt)
                if salt not in by_salt:
                    continue
                password = memory(password_ptr, password_len)
                if len(password) != password_len:
                    continue
                key = (hashlib.pbkdf2_hmac("sha512", password, salt, 256000, 32)
                       if rounds == 256000 else password)
                before = len(found)
                for name, page in by_salt[salt]:
                    if name not in found and authenticated_page(key, page):
                        found[name] = {"enc_key": key.hex()}
                if len(found) > before:
                    if not consent_enabled(args.consent_file, args.consent_id):
                        raise RuntimeError("wechat_consent_revoked")
                    save_private(output, found)
                    emit("verified_progress", verified_databases=len(found), expected_databases=len(pages))
            resume_error = process.Continue()
            if resume_error.Fail():
                raise RuntimeError("temporary_wechat_resume_failed")
        emit("capture_finished", verified_databases=len(found), expected_databases=len(pages), breakpoint_calls=calls)
        return 0 if found else 3
    finally:
        if process and process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid):
            process.Kill()
        lldb.SBDebugger.Destroy(debugger)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("capture_error", category=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        raise SystemExit(2)
