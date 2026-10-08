#!/usr/bin/env python3
"""Read Weixin 4.1 database keys from the running client and check them.

The user must opt in first. This program only reads Weixin.exe. A candidate is
kept only when it authenticates a database page. It does not print keys or
message text, and it does not write a decrypted database.
"""

from __future__ import annotations

import argparse
import ctypes
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import struct
import sys
import tempfile
import uuid


PAGE_SIZE = 4096
KEY_SIZE = 32
CIPHER_NAME = b"com.Tencent.WCDB.Config.Cipher"
CIPHER_MASK = bytes.fromhex(
    "d2c7442458020000004889442450488b"
    "450048844c2448488944254048584c24"
)
LITERAL = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")
RAW_KEY_LITERAL = re.compile(rb"x'([0-9a-fA-F]{96,192})'")
MAX_USER_ADDRESS = 0x0000800000000000
MAX_BLOB = 1024


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def authenticated_page(raw_key, page):
    """Same SQLCipher 4 page check the macOS reader uses."""
    if len(raw_key) != KEY_SIZE or len(page) != PAGE_SIZE:
        return False
    mac_salt = bytes(byte ^ 0x3A for byte in page[:16])
    mac_key = hashlib.pbkdf2_hmac("sha512", raw_key, mac_salt, 2, 32)
    signed = page[16:4032] + b"\x01\x00\x00\x00"
    return hmac.compare_digest(hmac.new(mac_key, signed, hashlib.sha512).digest(), page[4032:])


def xor_repeat(data, mask):
    return bytes(value ^ mask[index % len(mask)] for index, value in enumerate(data))


def probable_key(data):
    return len(data) == KEY_SIZE and len(set(data)) >= 15 and data not in {b"\x00" * KEY_SIZE, b"\xff" * KEY_SIZE}


def config_key_candidates(blob):
    """Decode one Config.Cipher blob into raw-key candidates. HMAC still decides."""
    if not blob or len(blob) > MAX_BLOB:
        return []
    decoded = xor_repeat(blob, CIPHER_MASK)
    found = []
    seen = set()
    for match in LITERAL.finditer(decoded):
        run = match.group(1).decode("ascii").lower()
        starts = [0]
        if len(run) > 96:
            starts.extend(range(0, len(run) - 63, 32))
            starts.append(len(run) - 64)
        for start in dict.fromkeys(starts):
            if start < 0 or start + 64 > len(run):
                continue
            key_hex = run[start:start + 64]
            try:
                key = bytes.fromhex(key_hex)
            except ValueError:
                continue
            if not probable_key(key):
                continue
            salt_hex = run[start + 64:start + 96] if start + 96 <= len(run) else None
            item = (key_hex, salt_hex)
            if item not in seen:
                seen.add(item)
                found.append(item)
    return found


def encrypted_pages(root):
    pages = {}
    for db in sorted(root.rglob("*.db")):
        if not db.is_file() or db.is_symlink():
            continue
        with db.open("rb") as source:
            page = source.read(PAGE_SIZE)
        if len(page) == PAGE_SIZE and not page.startswith(b"SQLite format 3\x00"):
            pages[db.relative_to(root).as_posix()] = page
    return pages


def assign_verified(pages, key, salt=None):
    matched = {}
    for name, page in pages.items():
        if salt is not None and page[:16] != salt:
            continue
        if authenticated_page(key, page):
            matched[name] = key.hex()
    return matched


def _u64(data, offset):
    if offset < 0 or offset + 8 > len(data):
        return 0
    return struct.unpack_from("<Q", data, offset)[0]


class ProcessMemory:
    def regions(self):
        raise NotImplementedError

    def read(self, address, size):
        raise NotImplementedError


def _regions(memory):
    overlap = 32
    for base, size in memory.regions():
        offset = 0
        tail = b""
        tail_base = base
        while offset < size:
            current = min(2 * 1024 * 1024, size - offset)
            chunk = memory.read(base + offset, current) or b""
            data_base = tail_base if tail else base + offset
            data = tail + chunk
            if data:
                yield data_base, data
                tail = data[-overlap:]
                tail_base = data_base + len(data) - overlap
            else:
                tail = b""
                tail_base = base + offset + current
            offset += current


def _find(memory, needle):
    addresses = set()
    for data_base, data in _regions(memory):
        pos = data.find(needle)
        while pos >= 0:
            addresses.add(data_base + pos)
            pos = data.find(needle, pos + 1)
    return addresses


def scan_config_cipher(memory, pages):
    """Walk Weixin 4.1 Config.Cipher objects. Only HMAC-verified keys are returned."""
    stats = {"cipher_string_hits": 0, "cipher_nodes": 0, "candidates": 0}
    found = {}
    needles = _find(memory, CIPHER_NAME)
    stats["cipher_string_hits"] = len(needles)
    if not needles:
        return found, stats
    remaining = {page[:16] for page in pages.values()}
    patterns = [struct.pack("<Q", address) + struct.pack("<Q", len(CIPHER_NAME)) for address in needles]
    seen = set()
    for data_base, data in _regions(memory):
        if not remaining:
            break
        for pattern in patterns:
            pos = data.find(pattern)
            while pos >= 0:
                node = memory.read(data_base + pos - 0x10, 0x50)
                pos = data.find(pattern, pos + 1)
                if not node or len(node) < 0x40:
                    continue
                if _u64(node, 0x10) not in needles or _u64(node, 0x18) != len(CIPHER_NAME):
                    continue
                config_ptr = _u64(node, 0x28)
                if not 0x10000 <= config_ptr < MAX_USER_ADDRESS:
                    continue
                stats["cipher_nodes"] += 1
                obj = memory.read(config_ptr + 0x88, 0x28)
                if not obj or len(obj) < 0x18:
                    continue
                data_ptr = _u64(obj, 0x8)
                data_len = _u64(obj, 0x10)
                if not (0 < data_len <= MAX_BLOB and 0x10000 <= data_ptr < MAX_USER_ADDRESS):
                    continue
                blob = memory.read(data_ptr, int(data_len))
                if not blob or len(blob) != data_len or data_len != 99:
                    continue
                for key_hex, salt_hex in config_key_candidates(blob):
                    if (key_hex, salt_hex) in seen:
                        continue
                    seen.add((key_hex, salt_hex))
                    stats["candidates"] += 1
                    try:
                        key = bytes.fromhex(key_hex)
                        salt = bytes.fromhex(salt_hex) if salt_hex else None
                    except ValueError:
                        continue
                    matched = assign_verified(pages, key, salt if salt in remaining else None)
                    if not matched and salt not in remaining:
                        matched = assign_verified(pages, key)
                    for name, hex_key in matched.items():
                        found[name] = hex_key
                        remaining.discard(pages[name][:16])
    return found, stats


def scan_raw_literals(memory, pages):
    """Older Weixin builds keep a raw key next to its salt. HMAC still decides."""
    by_salt = {}
    for name, page in pages.items():
        by_salt.setdefault(page[:16], []).append(name)
    found = {}
    for base, size in memory.regions():
        data = memory.read(base, size) or b""
        for match in RAW_KEY_LITERAL.finditer(data):
            run = match.group(1).decode("ascii").lower()
            salt = bytes.fromhex(run[64:96])
            if salt not in by_salt:
                continue
            key = bytes.fromhex(run[:64])
            if not probable_key(key):
                continue
            for name in by_salt[salt]:
                if authenticated_page(key, pages[name]):
                    found[name] = key.hex()
    return found


SQLITE_HEADER = b"SQLite format 3\x00"
ZSTD_MAGIC = bytes.fromhex("28b52ffd")
RESERVE = 80


def decrypt_page(enc_key, page, page_number, decrypt):
    """Turn one SQLCipher 4 page into a normal SQLite page."""
    if len(page) != PAGE_SIZE:
        raise RuntimeError("invalid_database_page")
    iv = page[PAGE_SIZE - RESERVE:PAGE_SIZE - RESERVE + 16]
    if page_number == 1:
        encrypted = page[16:PAGE_SIZE - RESERVE]
        decrypted = decrypt(enc_key, iv, encrypted)
        return SQLITE_HEADER + decrypted + b"\x00" * RESERVE
    encrypted = page[:PAGE_SIZE - RESERVE]
    decrypted = decrypt(enc_key, iv, encrypted)
    return decrypted + b"\x00" * RESERVE


_SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16"
)
_INV_SBOX = bytearray(256)
for _index, _value in enumerate(_SBOX):
    _INV_SBOX[_value] = _index
_INV_SBOX = bytes(_INV_SBOX)
_RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36)


def _xtime(value):
    return ((value << 1) & 0xff) ^ (0x1b if value & 0x80 else 0)


def _expand_key(key):
    words = [bytearray(key[index:index + 4]) for index in range(0, 32, 4)]
    index = 8
    while len(words) < 60:
        word = bytearray(words[-1])
        if index % 8 == 0:
            word = bytearray(word[1:] + word[:1])
            for byte_index, byte in enumerate(word):
                word[byte_index] = _SBOX[byte]
            word[0] ^= _RCON[index // 8 - 1]
        elif index % 8 == 4:
            for byte_index, byte in enumerate(word):
                word[byte_index] = _SBOX[byte]
        previous = words[-8]
        words.append(bytearray(left ^ right for left, right in zip(previous, word)))
        index += 1
    return words


def _decrypt_block(words, block):
    state = [[block[row + 4 * column] for column in range(4)] for row in range(4)]

    def add_round(round_index):
        for column in range(4):
            word = words[round_index * 4 + column]
            for row in range(4):
                state[row][column] ^= word[row]

    def inverse_shift_rows():
        state[1][:] = state[1][3:] + state[1][:3]
        state[2][:] = state[2][2:] + state[2][:2]
        state[3][:] = state[3][1:] + state[3][:1]

    def inverse_sub_bytes():
        for row in range(4):
            state[row][:] = [_INV_SBOX[byte] for byte in state[row]]

    def inverse_mix_columns():
        for column in range(4):
            a, b, c, d = (state[row][column] for row in range(4))
            state[0][column] = _mul(a, 14) ^ _mul(b, 11) ^ _mul(c, 13) ^ _mul(d, 9)
            state[1][column] = _mul(a, 9) ^ _mul(b, 14) ^ _mul(c, 11) ^ _mul(d, 13)
            state[2][column] = _mul(a, 13) ^ _mul(b, 9) ^ _mul(c, 14) ^ _mul(d, 11)
            state[3][column] = _mul(a, 11) ^ _mul(b, 13) ^ _mul(c, 9) ^ _mul(d, 14)

    add_round(14)
    for round_index in range(13, 0, -1):
        inverse_shift_rows()
        inverse_sub_bytes()
        add_round(round_index)
        inverse_mix_columns()
    inverse_shift_rows()
    inverse_sub_bytes()
    add_round(0)
    return bytes(state[row][column] for column in range(4) for row in range(4))


def _mul(value, factor):
    result = 0
    while factor:
        if factor & 1:
            result ^= value
        value = _xtime(value)
        factor >>= 1
    return result


def aes_cbc_decrypt(key, iv, data):
    if len(key) != 32 or len(iv) != 16 or len(data) % 16:
        raise RuntimeError("decrypt_failed")
    words = _expand_key(key)
    output = bytearray()
    previous = iv
    for offset in range(0, len(data), 16):
        block = data[offset:offset + 16]
        plain = _decrypt_block(words, block)
        output.extend(left ^ right for left, right in zip(plain, previous))
        previous = block
    return bytes(output)


def read_shared(path):
    if sys.platform != "win32":
        return path.read_bytes()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.GetFileSizeEx.restype = ctypes.c_int
    kernel32.ReadFile.restype = ctypes.c_int
    kernel32.CloseHandle.restype = ctypes.c_int
    handle = kernel32.CreateFileW(str(path), 0x80000000, 0x7, None, 3, 0x80, None)
    invalid = ctypes.c_void_p(-1).value
    if not handle or handle == invalid:
        raise RuntimeError("database_unreadable")
    try:
        size = ctypes.c_uint64()
        if kernel32.GetFileSizeEx(handle, ctypes.byref(size)) == 0 or size.value == 0:
            raise RuntimeError("database_unreadable")
        buffer = ctypes.create_string_buffer(size.value)
        read = ctypes.c_uint32()
        if kernel32.ReadFile(handle, buffer, size.value, ctypes.byref(read), None) == 0:
            raise RuntimeError("database_unreadable")
        return buffer.raw[:read.value]
    finally:
        kernel32.CloseHandle(handle)


def message_kind(local_type):
    """Weixin 4 stores the message type in the low 32 bits and flags above it."""
    return int(local_type) & 0xFFFFFFFF


def message_bytes(body):
    if not body:
        return b""
    data = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    if data.startswith(ZSTD_MAGIC):
        try:
            import zstandard
        except ImportError as error:
            raise RuntimeError("zstd_unavailable") from error
        data = zstandard.ZstdDecompressor().decompress(data)
    return data


def decode_text(message_type, body):
    if message_kind(message_type) != 1 or not body:
        return None
    return message_bytes(body).decode("utf-8")


def message_preview(local_type, body):
    kind = message_kind(local_type)
    if kind == 1:
        text = decode_text(local_type, body)
        return f"text={text}" if text else None
    if kind == 3:
        return "image"
    if kind == 49:
        xml = message_bytes(body).decode("utf-8", "replace")
        title = re.search(r"<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", xml, re.DOTALL)
        return f"file={title.group(1).strip() if title else 'unknown'}"
    return None


def self_username(account_directory_name):
    match = re.fullmatch(r"(wxid_[0-9A-Za-z]+)_[0-9a-fA-F]{4}", account_directory_name or "")
    if match:
        return match.group(1)
    if (account_directory_name or "").startswith("wxid_"):
        return account_directory_name
    return None


def chat_kind(username):
    if not username:
        return "unknown"
    if username.endswith("@chatroom"):
        return "group"
    if username == "filehelper":
        return "file_transfer"
    return "private"


def display_name(username, profiles, self_id=None):
    if not username:
        return None
    if self_id and username == self_id:
        return "自己"
    profile = profiles.get(username) or {}
    remark = (profile.get("remark") or "").strip()
    nick = (profile.get("nick") or "").strip()
    if remark:
        return remark
    if nick:
        return nick
    if username == "filehelper":
        return "文件传输助手"
    return username


def labeled_name(username, profiles, self_id=None):
    """Remark first, then nickname. An id is only used when both are missing."""
    if not username:
        return "unknown"
    if self_id and username == self_id:
        return "自己"
    profile = profiles.get(username) or {}
    remark = (profile.get("remark") or "").strip()
    nick = (profile.get("nick") or "").strip()
    if remark:
        return f"{remark}(备注)"
    if nick:
        return f"{nick}(昵称)"
    if username == "filehelper":
        return "文件传输助手"
    return f"{username}(无备注无昵称)"


def describe_message(table, sender_id, self_id, profiles, usernames):
    by_table = {hashlib.md5(name.encode("utf-8")).hexdigest(): name for name in usernames if name}
    chat_username = by_table.get(table[4:] if table.startswith("Msg_") else "")
    return {
        "chatKind": chat_kind(chat_username),
        "chatName": display_name(chat_username, profiles),
        "senderName": display_name(sender_id, profiles, self_id),
        "fromSelf": sender_id == self_id if sender_id and self_id else None,
    }


def remember_profile(profiles, username, remark="", nick=""):
    if not isinstance(username, str) or not username:
        return
    current = profiles.setdefault(username, {"remark": "", "nick": ""})
    if isinstance(remark, str) and remark.strip():
        current["remark"] = remark.strip()
    if isinstance(nick, str) and nick.strip():
        current["nick"] = nick.strip()


def absorb_sqlite_profiles(connection, profiles):
    for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        if not re.fullmatch(r"[A-Za-z0-9_]+", name):
            continue
        columns = {row[1].lower(): row[1] for row in connection.execute(f'PRAGMA table_info("{name}")')}
        username = columns.get("username") or columns.get("user_name")
        if not username:
            continue
        remark = columns.get("remark")
        nick = columns.get("nick_name") or columns.get("nickname")
        selected = [username] + [column for column in (remark, nick) if column]
        quoted = ", ".join(f'"{column}"' for column in selected)
        for row in connection.execute(f'SELECT {quoted} FROM "{name}"'):
            values = dict(zip(selected, row))
            remember_profile(profiles, values.get(username), values.get(remark) if remark else "", values.get(nick) if nick else "")


def decrypted_database(raw, enc_key, decrypt):
    pages = []
    for index in range(0, len(raw) - PAGE_SIZE + 1, PAGE_SIZE):
        pages.append(decrypt_page(enc_key, raw[index:index + PAGE_SIZE], len(pages) + 1, decrypt))
    if not pages or not pages[0].startswith(SQLITE_HEADER):
        raise RuntimeError("decrypt_failed")
    temporary = tempfile.NamedTemporaryFile(prefix="weixin-peek-", suffix=".db", delete=False)
    temporary.write(b"".join(pages))
    temporary.close()
    return temporary.name


def key_hex_for(stored, relative):
    value = stored.get("keys", {}).get(relative, {})
    key_hex = value.get("enc_key") if isinstance(value, dict) else None
    if not isinstance(key_hex, str):
        return None
    return key_hex


def peek_message_lines(database_root, key_file, decrypt=aes_cbc_decrypt, days=10, limit=500):
    """Read a few messages with the chat and the person a user would recognize."""
    stored = json.loads(Path(key_file).read_text(encoding="utf8"))
    root = Path(database_root)
    relative = "message/message_0.db"
    key_hex = key_hex_for(stored, relative)
    if not key_hex:
        raise RuntimeError("message_key_missing")
    profiles = {}
    temporary_files = []
    try:
        for extra in ("contact/contact.db", "session/session.db"):
            extra_key = key_hex_for(stored, extra)
            if not extra_key:
                continue
            try:
                extra_path = decrypted_database(read_shared(root / extra), bytes.fromhex(extra_key), decrypt)
            except (OSError, RuntimeError):
                continue
            temporary_files.append(extra_path)
            connection = sqlite3.connect(extra_path)
            try:
                absorb_sqlite_profiles(connection, profiles)
            finally:
                connection.close()
        temporary = decrypted_database(read_shared(root / relative), bytes.fromhex(key_hex), decrypt)
        temporary_files.append(temporary)
        connection = sqlite3.connect(temporary)
        try:
            try:
                for (username,) in connection.execute("SELECT user_name FROM Name2Id"):
                    remember_profile(profiles, username)
            except sqlite3.OperationalError:
                pass
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'Msg_*' ORDER BY name")]
            rows = []
            for table in tables:
                if not re.fullmatch(r"Msg_[0-9a-f]{32}", table):
                    continue
                query = (f'SELECT local_id, create_time, local_type, real_sender_id, message_content '
                         f'FROM "{table}" ORDER BY local_id DESC')
                for local_id, created, message_type, sender_row, content in connection.execute(query):
                    sender = None
                    if sender_row is not None:
                        try:
                            match = connection.execute(
                                "SELECT user_name FROM Name2Id WHERE rowid=?", (int(sender_row),)).fetchone()
                            sender = match[0] if match else None
                        except sqlite3.OperationalError:
                            sender = None
                    rows.append((int(created or 0), int(local_id), int(message_type), sender, table, content))
        except sqlite3.DatabaseError as error:
            raise RuntimeError("decrypt_failed") from error
        finally:
            connection.close()
    finally:
        for temporary in temporary_files:
            os.remove(temporary)
    self_id = self_username(root.parent.name)
    usernames = list(profiles)
    by_table = {hashlib.md5(name.encode("utf-8")).hexdigest(): name for name in usernames if name}
    cutoff = int(datetime.now(timezone.utc).timestamp()) - days * 24 * 60 * 60
    conversations = {}
    order = []
    for created, local_id, message_type, sender, table, content in sorted(rows):
        if created < cutoff:
            continue
        preview = message_preview(message_type, content)
        if not preview:
            continue
        described = describe_message(table, sender, self_id, profiles, usernames)
        chat_username = by_table.get(table[4:] if table.startswith("Msg_") else "")
        heading = {
            "group": "微信群聊",
            "private": "微信私聊",
            "file_transfer": "微信文件传输助手",
        }.get(described["chatKind"], "微信")
        chat = labeled_name(chat_username, profiles)
        if described["chatKind"] != "file_transfer" and chat != "unknown":
            heading = f"{heading}「{chat.split('(', 1)[0]}」"
        who = labeled_name(sender, profiles, self_id).split("(", 1)[0]
        when = datetime.fromtimestamp(created).strftime("%H:%M")
        body = preview.removeprefix("text=")
        if preview.startswith("file="):
            body = f"发了文件 {preview.removeprefix('file=')}"
        elif preview == "image":
            body = "发了一张图片"
        bucket = conversations.setdefault(heading, [])
        if heading not in order:
            order.append(heading)
        bucket.append(f"{when} {who}：{body}")
        if sum(len(items) for items in conversations.values()) >= limit:
            break
    lines = [f"最近{days}天"]
    for heading in order:
        lines.append("")
        lines.append(heading)
        lines.extend(conversations[heading])
    return lines


def save_private(path, entries):
    temporary = path.with_suffix(".pending")
    if temporary.exists():
        raise RuntimeError("key_output_already_exists")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump({"keys": entries}, output, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def consent_enabled(file, identifier):
    if file.is_symlink() or not file.is_file():
        return False
    try:
        state = json.loads(file.read_text())
        return (state.get("version") == 1 and state.get("enabled") is True
                and bool(state.get("consentedAt")) and state.get("consentId") == identifier)
    except (OSError, ValueError, AttributeError):
        return False


def grant_consent(file):
    file.parent.mkdir(parents=True, exist_ok=True)
    identifier = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    payload = {"version": 1, "enabled": True, "consentId": identifier, "consentedAt": now, "updatedAt": now}
    temporary = file.with_suffix(".pending")
    temporary.write_text(json.dumps(payload), encoding="utf8")
    os.replace(temporary, file)
    return identifier


class WindowsProcessMemory(ProcessMemory):
    def __init__(self, handle, kernel32):
        self.handle = handle
        self.kernel32 = kernel32

    def read(self, address, size):
        if size <= 0 or size > 256 * 1024 * 1024:
            return b""
        buffer = ctypes.create_string_buffer(size)
        read = ctypes.c_size_t(0)
        ok = self.kernel32.ReadProcessMemory(
            self.handle, ctypes.c_uint64(address), buffer, size, ctypes.byref(read))
        if not ok:
            return b""
        return buffer.raw[:read.value]

    def regions(self):
        kernel32 = self.kernel32
        mem_commit = 0x1000
        readable = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}

        class MemoryBasicInformation(ctypes.Structure):
            _fields_ = [
                ("BaseAddress", ctypes.c_uint64), ("AllocationBase", ctypes.c_uint64),
                ("AllocationProtect", ctypes.c_uint32), ("_pad1", ctypes.c_uint32),
                ("RegionSize", ctypes.c_uint64), ("State", ctypes.c_uint32),
                ("Protect", ctypes.c_uint32), ("Type", ctypes.c_uint32), ("_pad2", ctypes.c_uint32),
            ]

        found = []
        address = 0
        info = MemoryBasicInformation()
        while address < 0x7FFFFFFFFFFF:
            if kernel32.VirtualQueryEx(self.handle, ctypes.c_uint64(address), ctypes.byref(info), ctypes.sizeof(info)) == 0:
                break
            if info.State == mem_commit and info.Protect in readable and 0 < info.RegionSize <= 256 * 1024 * 1024:
                found.append((info.BaseAddress, info.RegionSize))
            nxt = info.BaseAddress + info.RegionSize
            if nxt <= address:
                break
            address = nxt
        return found


def weixin_pids():
    import subprocess
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    pids = []
    for line in result.stdout.splitlines():
        if "Weixin.exe" not in line:
            continue
        parts = line.strip().strip('"').split('","')
        if len(parts) >= 2 and parts[1].isdigit():
            pids.append(int(parts[1]))
    return pids


def capture_from_running_weixin(pages):
    if sys.platform != "win32":
        raise RuntimeError("windows_required")
    import ctypes
    kernel32 = ctypes.windll.kernel32
    pids = weixin_pids()
    if not pids:
        raise RuntimeError("weixin_not_running")
    found = {}
    stats = {"cipher_string_hits": 0, "cipher_nodes": 0, "candidates": 0, "processes_opened": 0}
    access = 0x0010 | 0x0400 | 0x1000
    for pid in pids:
        handle = kernel32.OpenProcess(access, False, pid)
        if not handle:
            continue
        stats["processes_opened"] += 1
        try:
            memory = WindowsProcessMemory(handle, kernel32)
            verified, cipher_stats = scan_config_cipher(memory, pages)
            found.update(verified)
            for key, value in cipher_stats.items():
                stats[key] += value
            if len(found) < len(pages):
                found.update(scan_raw_literals(memory, pages))
        finally:
            kernel32.CloseHandle(handle)
    if stats["processes_opened"] == 0:
        raise RuntimeError("process_unreadable")
    return found, stats


def discover_database_root():
    home = Path.home() / "Documents" / "xwechat_files"
    if not home.is_dir():
        raise RuntimeError("wechat_login_required")
    accounts = []
    for child in home.iterdir():
        if not child.is_dir() or child.is_symlink() or not re.fullmatch(r"wxid_[0-9A-Za-z_]+", child.name):
            continue
        message = child / "db_storage" / "message"
        if message.is_dir() and any(message.glob("message_[0-9]*.db")):
            accounts.append(child / "db_storage")
    if len(accounts) == 1:
        return accounts[0]
    raise RuntimeError("wechat_login_required" if not accounts else "current_account_ambiguous")


def write_connection_files(output, root):
    directory = output.parent
    directory.mkdir(parents=True, exist_ok=True)
    account = directory / "account.json"
    cursor = directory / "cursor.json"
    account.write_text(json.dumps({"databaseRoot": str(root)}), encoding="utf8")
    if not cursor.exists():
        cursor.write_text("{}\n", encoding="utf8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--keys", type=Path)
    parser.add_argument("--consent-file", type=Path)
    parser.add_argument("--grant", action="store_true")
    parser.add_argument("--peek", action="store_true")
    parser.add_argument("--days", type=int, default=10)
    args = parser.parse_args()
    root = args.root.resolve(strict=True) if args.root else discover_database_root()
    if root.name != "db_storage":
        raise RuntimeError("invalid_database_root")
    if args.peek:
        memmy_home = Path(os.environ.get("MEMMY_HOME", "")).expanduser() if os.environ.get("MEMMY_HOME") else Path.home() / ".memmy"
        key_file = args.keys or (memmy_home / "computer-history" / "wechat" / "keys.json")
        consent_file = args.consent_file or (key_file.parent / "consent.json")
        state = json.loads(consent_file.read_text(encoding="utf8"))
        if not consent_enabled(consent_file, state.get("consentId")):
            raise RuntimeError("wechat_consent_required")
        if args.days < 1:
            raise RuntimeError("invalid_days")
        for line in peek_message_lines(root, key_file, days=args.days):
            print(line, flush=True)
        return 0
    if args.output is None:
        raise RuntimeError("output_required")
    consent_file = args.consent_file or (args.output.parent / "consent.json")
    if args.grant:
        identifier = grant_consent(consent_file)
    else:
        state = json.loads(consent_file.read_text(encoding="utf8"))
        identifier = state.get("consentId")
    if not consent_enabled(consent_file, identifier):
        raise RuntimeError("wechat_consent_required")
    pages = encrypted_pages(root)
    if not pages:
        raise RuntimeError("no_encrypted_databases")
    emit("scan_started", database_count=len(pages))
    found, stats = capture_from_running_weixin(pages)
    if not consent_enabled(consent_file, identifier):
        raise RuntimeError("wechat_consent_revoked")
    if found:
        entries = {name: {"enc_key": key} for name, key in sorted(found.items())}
        save_private(args.output, entries)
        write_connection_files(args.output, root)
    emit("capture_finished", verified_databases=len(found), expected_databases=len(pages), **stats)
    return 0 if found else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        detail = str(error).splitlines()[0][:180]
        category = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        emit("capture_error", category=category, detail=detail)
        raise SystemExit(2)
