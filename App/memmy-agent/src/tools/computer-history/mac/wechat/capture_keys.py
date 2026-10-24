#!/usr/bin/env python3
"""Capture keys from the one temporary WeChat process launched by this helper.

The caller must have obtained explicit chat-reading consent. Nothing attaches
to an existing process, changes the original app, or disables SIP. The bundled
native helper finds SQLCipher key material inside that temporary process and
authenticates it against the selected account's encrypted pages. No debugger,
Xcode or Command Line Tools are required on the user's Mac.
"""

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import stat
import struct
import subprocess
import tempfile
import time


_SINK_MAGIC = b"MKC1"
_SINK_HEADER = len(_SINK_MAGIC) + 12  # magic + rounds + saltLen + pwLen (3 x uint32)
_MAX_SALT = 16
_MAX_PASSWORD = 256
_MESSAGE_DATABASE = re.compile(r"message/message_\d+\.db\Z")
_MAX_PAGES = 1024


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
    # Text reading needs numbered message shards. Search indexes, resources and
    # unrelated account databases must not turn a usable connection into a
    # failure. Names are optional, just as they are in read_messages.py.
    pages = {}
    required = [db for db in sorted((root / "message").glob("message_*.db"))
                if _MESSAGE_DATABASE.fullmatch(db.relative_to(root).as_posix())]
    for db in required + [root / "contact/contact.db", root / "session/session.db"]:
        try:
            if db.is_symlink():
                raise RuntimeError("wechat_private_storage_unsafe")
            with db.open("rb") as source:
                page = source.read(4096)
        except (OSError, RuntimeError):
            if db in required:
                raise
            continue
        if len(page) == 4096 and not page.startswith(b"SQLite format 3\x00"):
            pages[db.relative_to(root).as_posix()] = page
        elif db in required:
            raise RuntimeError("wechat_message_database_invalid")
    if len(pages) > _MAX_PAGES:
        raise RuntimeError("wechat_message_database_limit")
    return pages


def required_databases(pages):
    return {name for name in pages if _MESSAGE_DATABASE.fullmatch(name)}


def write_capture_pages(directory, pages):
    path = directory / "pages.bin"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(b"MKP1" + struct.pack("<I", len(pages)))
        for page in pages.values():
            output.write(page)
    return path


def verify_record(record, by_salt, mac_salts, found, expanded_passwords, can_continue):
    rounds, observed_salt, password = record
    if rounds not in (2, 256000) or len(observed_salt) != 16 or not 0 < len(password) <= _MAX_PASSWORD:
        return
    salt = observed_salt if rounds == 256000 else mac_salts.get(observed_salt)
    if salt not in by_salt or not can_continue():
        return
    key = (hashlib.pbkdf2_hmac("sha512", password, salt, 256000, 32)
           if rounds == 256000 else password)

    def accept(candidate_salt, candidate_key):
        verified = False
        for name, page in by_salt[candidate_salt]:
            if authenticated_page(candidate_key, page):
                found[name] = {"enc_key": candidate_key.hex()}
                verified = True
        return verified

    verified = accept(salt, key)
    if rounds != 256000 or not verified or password in expanded_passwords:
        return
    # A verified account password can unlock a shard WeChat has not opened yet.
    # Derive each salt separately, and authenticate every result before keeping
    # it. A raw derived key is never mistaken for an account password.
    expanded_passwords.add(password)
    for other_salt, entries in by_salt.items():
        if all(name in found for name, _ in entries):
            continue
        if not can_continue():
            break
        accept(other_salt, hashlib.pbkdf2_hmac("sha512", password, other_salt, 256000, 32))


def consent_enabled(file, identifier):
    if file.is_symlink() or not file.is_file() or file.stat().st_mode & 0o077:
        return False
    try:
        state = json.loads(file.read_text())
        return (state.get("version") == 1 and state.get("enabled") is True
                and bool(state.get("consentedAt")) and state.get("consentId") == identifier)
    except (OSError, ValueError, AttributeError):
        return False


def _validated_injection(app, name):
    library = app / "Contents/Frameworks" / name
    info = library.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or library.resolve(strict=True) != library):
        raise RuntimeError("wechat_private_storage_unsafe")
    return library


def private_storage_launch_environment(executable, sink):
    # Only the launched connection copy receives the interposers. Memmy's Python
    # host keeps its existing source access and authenticates original DB pages.
    app = executable.parent.parent.parent
    if (app.name != "Memmy WeChat Reader.app" or app.parent.name != "connection-helper"
            or executable != app / "Contents/MacOS/WeChat"):
        raise RuntimeError("wechat_private_storage_unsafe")
    bridge = _validated_injection(app, "MemmyWeChatPrivateStorage.dylib")
    capture = _validated_injection(app, "MemmyWeChatKeyCapture.dylib")
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("DYLD_", "MEMMY_WECHAT_"))}
    environment["DYLD_INSERT_LIBRARIES"] = str(bridge) + ":" + str(capture)
    environment["MEMMY_WECHAT_KEY_SINK"] = str(sink)
    for kind in ("CONTAINER", "GROUP"):
        for part in ("SOURCE", "COPY"):
            key = "MEMMY_WECHAT_" + kind + "_" + part
            value = os.environ.get(key)
            if not value:
                raise RuntimeError("wechat_private_storage_unsafe")
            environment[key] = value
    return environment


def _create_sink(parent):
    descriptor = os.open(parent / "keys.sink", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(descriptor)
    return parent / "keys.sink"


def _parse_sink(buffer):
    """Split complete capture records, returning them with any trailing partial."""
    records = []
    offset = 0
    while len(buffer) - offset >= _SINK_HEADER:
        if buffer[offset:offset + len(_SINK_MAGIC)] != _SINK_MAGIC:
            raise RuntimeError("key_sink_corrupt")
        rounds, salt_length, password_length = struct.unpack_from("<III", buffer, offset + len(_SINK_MAGIC))
        if salt_length > _MAX_SALT or password_length > _MAX_PASSWORD:
            raise RuntimeError("key_sink_corrupt")
        total = _SINK_HEADER + salt_length + password_length
        if len(buffer) - offset < total:
            break
        salt = bytes(buffer[offset + _SINK_HEADER:offset + _SINK_HEADER + salt_length])
        password = bytes(buffer[offset + _SINK_HEADER + salt_length:offset + total])
        records.append((rounds, salt, password))
        offset += total
    return records, buffer[offset:]


def main():
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
    required = required_databases(pages)
    if not required:
        raise RuntimeError("no_encrypted_databases")
    by_salt = {}
    for name, page in pages.items():
        by_salt.setdefault(page[:16], []).append((name, page))
    # SQLCipher derives the HMAC key with the page salt XORed by 0x3a. The 2-round
    # call therefore reveals the derived key under that transformed salt.
    mac_salts = {bytes(byte ^ 0x3A for byte in salt): salt for salt in by_salt}
    found = {}
    expanded_passwords = set()

    sink_directory = Path(tempfile.mkdtemp(prefix="key-capture-", dir=output.parent))
    os.chmod(sink_directory, 0o700)
    sink = sink_directory / "keys.sink"
    capture_pages = sink_directory / "pages.bin"
    process = None
    reader = None
    try:
        _create_sink(sink_directory)
        capture_pages = write_capture_pages(sink_directory, pages)
        seconds = max(30, min(args.seconds, 300))
        launch_environment = private_storage_launch_environment(executable, sink)
        launch_environment["MEMMY_WECHAT_CAPTURE_PAGES"] = str(capture_pages)
        launch_environment["MEMMY_WECHAT_CAPTURE_SECONDS"] = str(seconds)
        process = subprocess.Popen([str(executable)], cwd=str(executable.parent), env=launch_environment,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        emit("temporary_app_started", expected_databases=len(required))
        reader = open(sink, "rb")
        buffer = b""
        deadline = time.monotonic() + seconds
        last_status = time.monotonic()

        def can_continue():
            if not consent_enabled(args.consent_file, args.consent_id):
                raise RuntimeError("wechat_consent_revoked")
            return time.monotonic() < deadline

        while time.monotonic() < deadline and not required.issubset(found):
            if not consent_enabled(args.consent_file, args.consent_id):
                raise RuntimeError("wechat_consent_revoked")
            buffer += reader.read(1024 * 1024)
            records, buffer = _parse_sink(buffer)
            before = len(found)
            for record in records:
                verify_record(record, by_salt, mac_salts, found, expanded_passwords, can_continue)
            if len(found) > before:
                if not consent_enabled(args.consent_file, args.consent_id):
                    raise RuntimeError("wechat_consent_revoked")
                save_private(output, found)
                emit("verified_progress", verified_databases=len(required.intersection(found)),
                     expected_databases=len(required))
                last_status = time.monotonic()
            elif time.monotonic() - last_status >= 15:
                emit("waiting_for_login", verified_databases=len(required.intersection(found)))
                last_status = time.monotonic()
            if process.poll() is not None and not records:
                break
            time.sleep(0.25)
        emit("capture_finished", verified_databases=len(required.intersection(found)),
             expected_databases=len(required))
        if not required.issubset(found):
            if found:
                emit("capture_error", category="key_capture_incomplete")
            return 3
        if not consent_enabled(args.consent_file, args.consent_id):
            raise RuntimeError("wechat_consent_revoked")
        return 0
    finally:
        if reader is not None:
            reader.close()
        if process is not None and process.poll() is None:
            try:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            except ProcessLookupError:
                pass
        try:
            sink.unlink(missing_ok=True)
            capture_pages.unlink(missing_ok=True)
            sink_directory.rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("capture_error", category=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        raise SystemExit(2)
