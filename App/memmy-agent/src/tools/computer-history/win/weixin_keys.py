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
from functools import lru_cache
import hashlib
import hmac
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import sqlite3
import struct
import sys
import tempfile
import time
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
# The reader requires every numbered chat shard. Partial capture must not report
# success and then fail the first poll as "keys outdated".
MESSAGE_DATABASE = re.compile(r"(?:^|/)message_\d+\.db$", re.IGNORECASE)


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def usable_capture(pages, found):
    """Every numbered message shard is required by the shared batch reader."""
    required = {name for name in pages if MESSAGE_DATABASE.search(name)}
    return bool(required) and required.issubset(found)


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
    required = message_databases(root)
    if not required:
        raise RuntimeError("wechat_login_required")
    # Contacts/sessions improve names, but unrelated indexes/media must never
    # prevent a connection to the required message shards.
    optional = [root / "contact/contact.db", root / "session/session.db"]
    for db in required + optional:
        try:
            if db.is_symlink() or not db.is_file():
                raise RuntimeError("database_unreadable")
            page = read_shared(db, limit=PAGE_SIZE)
        except (OSError, RuntimeError):
            if db in required:
                raise
            continue
        if len(page) == PAGE_SIZE and not page.startswith(b"SQLite format 3\x00"):
            pages[db.relative_to(root).as_posix()] = page
        elif db in required:
            raise RuntimeError("invalid_database_page")
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


class WindowsAes:
    """AES-256-CBC from Windows CNG; the pure-Python cipher needs ~40 s for a 500 KB database."""

    def __init__(self):
        handle = ctypes.c_void_p
        status = ctypes.c_long
        bcrypt = ctypes.WinDLL("bcrypt")
        bcrypt.BCryptOpenAlgorithmProvider.argtypes = [ctypes.POINTER(handle), ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_ulong]
        bcrypt.BCryptOpenAlgorithmProvider.restype = status
        bcrypt.BCryptSetProperty.argtypes = [handle, ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
        bcrypt.BCryptSetProperty.restype = status
        bcrypt.BCryptGenerateSymmetricKey.argtypes = [
            handle, ctypes.POINTER(handle), ctypes.c_void_p, ctypes.c_ulong, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_ulong]
        bcrypt.BCryptGenerateSymmetricKey.restype = status
        bcrypt.BCryptDecrypt.argtypes = [
            handle, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong,
            ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.c_ulong]
        bcrypt.BCryptDecrypt.restype = status
        self.bcrypt = bcrypt
        self.algorithm = handle()
        if bcrypt.BCryptOpenAlgorithmProvider(ctypes.byref(self.algorithm), "AES", None, 0):
            raise OSError("aes_unavailable")
        mode = ctypes.create_unicode_buffer("ChainingModeCBC")
        if bcrypt.BCryptSetProperty(self.algorithm, "ChainingMode", mode, ctypes.sizeof(mode), 0):
            raise OSError("aes_unavailable")
        self.keys = {}

    def decrypt(self, key, iv, data):
        handle = self.keys.get(key)
        if handle is None:
            handle = ctypes.c_void_p()
            if self.bcrypt.BCryptGenerateSymmetricKey(self.algorithm, ctypes.byref(handle), None, 0, key, len(key), 0):
                raise RuntimeError("decrypt_failed")
            self.keys[key] = handle
        # CNG advances the IV buffer in place; each page has its own IV.
        chained = ctypes.create_string_buffer(iv, len(iv))
        output = ctypes.create_string_buffer(len(data))
        written = ctypes.c_ulong()
        if (self.bcrypt.BCryptDecrypt(handle, data, len(data), None, chained, len(iv), output, len(data),
                                      ctypes.byref(written), 0) or written.value != len(data)):
            raise RuntimeError("decrypt_failed")
        return output.raw


@lru_cache(maxsize=1)
def windows_aes():
    if sys.platform != "win32":
        return None
    try:
        return WindowsAes()
    except (OSError, AttributeError):
        return None


def aes_cbc_decrypt(key, iv, data):
    if len(key) != 32 or len(iv) != 16 or len(data) % 16:
        raise RuntimeError("decrypt_failed")
    native = windows_aes()
    if native is not None:
        return native.decrypt(bytes(key), bytes(iv), bytes(data))
    return python_aes_cbc_decrypt(key, iv, data)


def python_aes_cbc_decrypt(key, iv, data):
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


def read_shared(path, allow_empty=False, limit=None):
    if sys.platform != "win32":
        with path.open("rb") as source:
            return source.read(-1 if limit is None else limit)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                   ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.GetFileSizeEx.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint64)]
    kernel32.GetFileSizeEx.restype = ctypes.c_int
    kernel32.ReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
                                 ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    kernel32.ReadFile.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    handle = kernel32.CreateFileW(str(path), 0x80000000, 0x7, None, 3, 0x80, None)
    invalid = ctypes.c_void_p(-1).value
    if not handle or handle == invalid:
        if ctypes.get_last_error() in (2, 3):
            raise FileNotFoundError(str(path))
        raise RuntimeError("database_unreadable")
    try:
        size = ctypes.c_uint64()
        if kernel32.GetFileSizeEx(handle, ctypes.byref(size)) == 0:
            raise RuntimeError("database_unreadable")
        if size.value == 0:
            if allow_empty:
                return b""
            raise RuntimeError("database_unreadable")
        requested = min(size.value, limit) if limit is not None else size.value
        if requested > 0xFFFFFFFF:
            raise RuntimeError("database_unreadable")
        buffer = ctypes.create_string_buffer(requested)
        read = ctypes.c_uint32()
        if kernel32.ReadFile(handle, buffer, requested, ctypes.byref(read), None) == 0 or read.value != requested:
            raise RuntimeError("database_unreadable")
        return buffer.raw[:read.value]
    finally:
        kernel32.CloseHandle(handle)


WAL_HEADER_SIZE = 32
WAL_FRAME_HEADER_SIZE = 24
WAL_MAGIC = (0x377F0682, 0x377F0683)


def _wal_checksum(data, big_endian, first=0, second=0):
    words = struct.unpack((">" if big_endian else "<") + f"{len(data) // 4}I", data)
    for index in range(0, len(words), 2):
        first = (first + words[index] + second) & 0xFFFFFFFF
        second = (second + words[index + 1] + first) & 0xFFFFFFFF
    return first, second


def committed_wal_frames(wal, page_size=PAGE_SIZE):
    """SQLite's recovery rule: frames count only through the last valid commit frame."""
    if len(wal) < WAL_HEADER_SIZE:
        return {}, None
    magic, version, size, _sequence, salt1, salt2, check1, check2 = struct.unpack(">8I", wal[:WAL_HEADER_SIZE])
    if magic not in WAL_MAGIC or version != 3007000:
        return {}, None
    big_endian = magic & 1
    checksum = _wal_checksum(wal[:24], big_endian)
    if checksum != (check1, check2):
        return {}, None
    if size != page_size:
        raise RuntimeError("invalid_database_page")
    committed, pending, database_pages = {}, {}, None
    offset = WAL_HEADER_SIZE
    while offset + WAL_FRAME_HEADER_SIZE + page_size <= len(wal):
        number, commit, frame_salt1, frame_salt2, frame_check1, frame_check2 = struct.unpack_from(">6I", wal, offset)
        page = wal[offset + WAL_FRAME_HEADER_SIZE:offset + WAL_FRAME_HEADER_SIZE + page_size]
        # Frames left over from an earlier WAL generation carry the old salts.
        if number == 0 or (frame_salt1, frame_salt2) != (salt1, salt2):
            break
        checksum = _wal_checksum(page, big_endian, *_wal_checksum(wal[offset:offset + 8], big_endian, *checksum))
        if checksum != (frame_check1, frame_check2):
            break
        pending[number] = page
        if commit:
            committed.update(pending)
            pending = {}
            database_pages = commit
        offset += WAL_FRAME_HEADER_SIZE + page_size
    return committed, database_pages


def committed_pages(raw, wal=b"", page_size=PAGE_SIZE):
    """Encrypted pages of the committed database: the main file overlaid with its WAL."""
    pages = [raw[index:index + page_size] for index in range(0, len(raw) - page_size + 1, page_size)]
    frames, database_pages = committed_wal_frames(wal, page_size)
    if database_pages is None:
        return pages
    pages = pages[:database_pages] + [None] * (database_pages - len(pages))
    for number, page in frames.items():
        if number <= database_pages:
            pages[number - 1] = page
    if any(page is None for page in pages):
        raise RuntimeError("readonly_database_snapshot_busy")
    return pages


def _read_optional(path):
    try:
        return read_shared(path, allow_empty=True)
    except FileNotFoundError:
        return b""


def read_with_wal(path, attempts=3):
    """Read a live database and its WAL as one state.

    Weixin keeps recent messages in the WAL until it checkpoints. A WAL restart
    between the two reads would pair the main file with a newer generation, so
    the WAL header must be the same before and after the main file is read.
    """
    path = Path(path)
    wal = path.with_name(path.name + "-wal")
    for attempt in range(attempts):
        before = _read_optional(wal)[:WAL_HEADER_SIZE]
        raw = read_shared(path)
        log = _read_optional(wal)
        if log[:WAL_HEADER_SIZE] == before:
            return raw, log
        if attempt + 1 < attempts:
            time.sleep(0.05)
    raise RuntimeError("readonly_database_snapshot_busy")


def database_image(path, enc_key, decrypt=None):
    """Plain SQLite bytes of a committed SQLCipher database, including its WAL."""
    raw, wal = read_with_wal(path)
    pages = committed_pages(raw, wal)
    # Decrypting page 1 always restores the header, so only its HMAC proves the key.
    if not pages or not authenticated_page(enc_key, pages[0]):
        raise RuntimeError("database_key_rejected")
    decrypt = decrypt or aes_cbc_decrypt
    return b"".join(decrypt_page(enc_key, page, number, decrypt) for number, page in enumerate(pages, 1))


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


def decrypted_database(path, enc_key, decrypt):
    image = database_image(path, enc_key, decrypt)
    temporary = tempfile.NamedTemporaryFile(prefix="weixin-peek-", suffix=".db", delete=False)
    temporary.write(image)
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
                extra_path = decrypted_database(root / extra, bytes.fromhex(extra_key), decrypt)
            except (OSError, RuntimeError):
                continue
            temporary_files.append(extra_path)
            connection = sqlite3.connect(extra_path)
            try:
                absorb_sqlite_profiles(connection, profiles)
            finally:
                connection.close()
        temporary = decrypted_database(root / relative, bytes.fromhex(key_hex), decrypt)
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
    private_files().write_private_json(path, {"keys": entries})


def private_files():
    # Embedded Python intentionally excludes script directories from sys.path.
    spec = importlib.util.spec_from_file_location("wechat_private_files", Path(__file__).with_name("private_files.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def consent_enabled(file, identifier):
    if file.is_symlink() or not file.is_file():
        return False
    try:
        if os.name == "nt":
            private_files().protect_file(file)
        state = json.loads(file.read_text(encoding="utf8"))
        return (state.get("version") == 1 and state.get("enabled") is True
                and bool(state.get("consentedAt")) and state.get("consentId") == identifier)
    except (OSError, ValueError, AttributeError):
        return False


def grant_consent(file):
    file.parent.mkdir(parents=True, exist_ok=True)
    identifier = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    payload = {"version": 1, "enabled": True, "consentId": identifier, "consentedAt": now, "updatedAt": now}
    private_files().write_private_json(file, payload)
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
            self.handle, ctypes.c_void_p(address), buffer, size, ctypes.byref(read))
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
            if kernel32.VirtualQueryEx(self.handle, ctypes.c_void_p(address), ctypes.byref(info), ctypes.sizeof(info)) == 0:
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
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # ctypes defaults to 32-bit ints; addresses and process handles are 64-bit
    # in the bundled interpreter, including x64 emulation on Windows ARM.
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                         ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    kernel32.ReadProcessMemory.restype = ctypes.c_int
    kernel32.VirtualQueryEx.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    kernel32.VirtualQueryEx.restype = ctypes.c_size_t
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
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


def message_databases(root):
    return sorted(file for file in (root / "message").glob("message_*.db")
                  if re.fullmatch(r"message_[0-9]+\.db", file.name))


def windows_documents_directory():
    """Follow the user's actual Documents folder, including OneDrive/redirects."""
    fallback = Path.home() / "Documents"
    if sys.platform != "win32":
        return fallback
    output = ctypes.c_void_p()
    try:
        shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        ole32 = ctypes.WinDLL("ole32", use_last_error=True)
        shell32.SHGetKnownFolderPath.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                               ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        shell32.SHGetKnownFolderPath.restype = ctypes.c_long
        ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole32.CoTaskMemFree.restype = None
        folder = ctypes.create_string_buffer(uuid.UUID("fdd39ad0-238f-46af-adb4-6c85480369c7").bytes_le, 16)
        if shell32.SHGetKnownFolderPath(folder, 0, None, ctypes.byref(output)) == 0 and output.value:
            return Path(ctypes.wstring_at(output.value))
    except (OSError, AttributeError):
        pass
    finally:
        if output.value:
            ole32.CoTaskMemFree(output)
    return fallback


def config_storage_paths(text):
    paths = []
    for match in re.finditer(r'(?:[A-Za-z]:[\\/]|\\\\[^\\\r\n]+\\)[^"\r\n\0<>|?*]*', text):
        value = match.group(0).strip().rstrip("'")
        # JSON-style escaped backslashes may occur in older config files.
        prefix = "\\\\" if value.startswith("\\\\") else ""
        value = prefix + value[len(prefix):].replace("\\\\", "\\")
        paths.append(Path(ntpath.normpath(value)))
    return paths


def configured_storage_roots(appdata):
    directory = appdata / "Tencent/xwechat/config"
    roots = []
    try:
        files = sorted(directory.iterdir())
    except OSError:
        return roots
    for file in files:
        if file.suffix.lower() != ".ini" or file.is_symlink() or not file.is_file():
            continue
        try:
            with file.open("rb") as source:
                raw = source.read(64 * 1024)
            encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
            roots.extend(config_storage_paths(raw.decode(encoding)))
        except (OSError, UnicodeError):
            continue
    return roots


def discover_database_roots():
    home = Path.home()
    appdata = Path(os.environ.get("APPDATA", str(home / "AppData/Roaming")))
    roots = configured_storage_roots(appdata) + [windows_documents_directory(),
             home / "Documents", appdata / "Tencent/xwechat_files"]
    accounts = {}
    for root in roots:
        for container in (root, root / "xwechat_files"):
            try:
                if container.is_symlink():
                    continue
                children = list(container.iterdir())
            except OSError:
                continue
            # Config may name the account itself. Structure, not a wxid_ prefix,
            # identifies a store: older accounts can use custom account names.
            for child in [container] + children:
                database = child / "db_storage"
                if child.is_symlink() or database.is_symlink() or not database.is_dir():
                    continue
                if message_databases(database):
                    resolved = database.resolve(strict=True)
                    accounts[os.path.normcase(str(resolved))] = resolved
    if not accounts:
        raise RuntimeError("wechat_login_required")
    return list(accounts.values())


def discover_database_root():
    roots = discover_database_roots()
    if len(roots) != 1:
        raise RuntimeError("current_account_ambiguous")
    return roots[0]


def account_pages_for_capture(roots, explicit=False):
    """A broken historical store must not hide a readable current account.

    Only discovery candidates may be skipped. The selected account still needs
    every message key and a successful production-reader baseline afterwards.
    """
    accounts = []
    first_error = None
    for root in roots:
        try:
            accounts.append((root, encrypted_pages(root)))
        except (OSError, RuntimeError) as error:
            if explicit:
                raise
            if first_error is None:
                first_error = error
    if not accounts:
        if first_error is not None:
            raise first_error
        raise RuntimeError("wechat_login_required")
    return accounts


def select_captured_account(accounts, found):
    """Choose by cryptographic proof from running Weixin, never directory age."""
    matching = []
    for index, (root, pages) in enumerate(accounts):
        prefix = str(index) + "/"
        verified = {name[len(prefix):]: key for name, key in found.items() if name.startswith(prefix)}
        if any(MESSAGE_DATABASE.search(name) for name in verified):
            matching.append((root, pages, verified))
    if len(matching) > 1:
        raise RuntimeError("current_account_ambiguous")
    if not matching or not usable_capture(matching[0][1], matching[0][2]):
        raise RuntimeError("weixin_keys_not_found")
    return matching[0][0], matching[0][2]


def verify_message_databases(root, entries):
    """Use the production reader before publishing keys/account as connected.

    The computed cursor is deliberately discarded. The first Windows poll must
    still start at consent time, or retain the already acknowledged cursor.
    """
    path = Path(__file__).resolve().parents[1] / "mac/wechat/read_messages.py"
    spec = importlib.util.spec_from_file_location("wechat_message_reader", path)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    result = reader.scan(root, {"keys": entries}, reader.SqlCipher("builtin"), {}, 200, True)
    if result.get("databaseCount") != len(message_databases(root)) or result.get("messages"):
        raise RuntimeError("database_baseline_failed")


def write_connection_files(output, root, consent_file, identifier, started_at=None):
    if not isinstance(identifier, str) or not identifier or not consent_enabled(consent_file, identifier):
        raise RuntimeError("wechat_consent_revoked")
    try:
        consented_at = int(datetime.fromisoformat(
            json.loads(consent_file.read_text(encoding="utf8"))["consentedAt"].replace("Z", "+00:00")
        ).timestamp())
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise RuntimeError("invalid_wechat_consent") from error
    directory = output.parent
    directory.mkdir(parents=True, exist_ok=True)
    account = directory / "account.json"
    cursor = directory / "cursor.json"
    storage = private_files()
    previous = None
    if account.exists() or account.is_symlink():
        storage.protect_file(account)
        try:
            previous = json.loads(account.read_text(encoding="utf8"))
        except ValueError as error:
            raise RuntimeError("invalid_account") from error
        if (not isinstance(previous, dict)
                or not isinstance(previous.get("databaseRoot"), str)
                or not previous["databaseRoot"].strip()
                or ("consentId" in previous and
                    (not isinstance(previous["consentId"], str) or not previous["consentId"].strip()))
                or ("baselineSince" in previous and
                    (type(previous["baselineSince"]) is not int or previous["baselineSince"] < 0))):
            raise RuntimeError("invalid_account")
    # Legacy accounts had no consentId. An existing account still proves the
    # checkpoint was not left behind by revocation, which removes account.json.
    retain_cursor = (previous is not None
                     and os.path.normcase(os.path.normpath(previous["databaseRoot"]))
                         == os.path.normcase(os.path.normpath(str(root)))
                     and ("consentId" not in previous or previous["consentId"] == identifier))
    same_root = (previous is not None and os.path.normcase(os.path.normpath(previous["databaseRoot"]))
                 == os.path.normcase(os.path.normpath(str(root))))
    if retain_cursor and "baselineSince" in previous:
        baseline_since = previous["baselineSince"]
    elif previous is not None and not same_root:
        baseline_since = max(consented_at, started_at if started_at is not None else int(time.time()))
    else:
        baseline_since = consented_at
    # Keep the acknowledged position only for this account and consent. A new
    # connection leaves no checkpoint so its first read can establish a baseline.
    cursor_exists = cursor.exists() or cursor.is_symlink()
    if cursor_exists:
        storage.protect_file(cursor)
    # ACL upgrades can take time. Never replace connection state with consent
    # that was revoked while those checks were in progress.
    if not consent_enabled(consent_file, identifier):
        raise RuntimeError("wechat_consent_revoked")
    if cursor_exists and not retain_cursor:
        cursor.unlink()
    storage.write_private_json(account, {"databaseRoot": str(root), "consentId": identifier,
                                         "baselineSince": baseline_since})


def main():
    started_at = int(time.time())
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--keys", type=Path)
    parser.add_argument("--consent-file", type=Path)
    parser.add_argument("--grant", action="store_true")
    parser.add_argument("--peek", action="store_true")
    parser.add_argument("--days", type=int, default=10)
    args = parser.parse_args()
    if args.peek:
        root = args.root.resolve(strict=True) if args.root else discover_database_root()
        if root.name != "db_storage":
            raise RuntimeError("invalid_database_root")
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
    roots = [args.root.resolve(strict=True)] if args.root else discover_database_roots()
    if any(root.name != "db_storage" for root in roots):
        raise RuntimeError("invalid_database_root")
    accounts = account_pages_for_capture(roots, explicit=args.root is not None)
    pages = {str(index) + "/" + name: page
             for index, (_root, account_pages) in enumerate(accounts)
             for name, page in account_pages.items()}
    emit("scan_started", database_count=len(pages))
    found, stats = capture_from_running_weixin(pages)
    if not consent_enabled(consent_file, identifier):
        raise RuntimeError("wechat_consent_revoked")
    emit("capture_finished", verified_databases=len(found), expected_databases=len(pages), **stats)
    root, verified = select_captured_account(accounts, found)
    entries = {name: {"enc_key": key} for name, key in sorted(verified.items())}
    emit("verifying_databases")
    verify_message_databases(root, entries)
    if not consent_enabled(consent_file, identifier):
        raise RuntimeError("wechat_consent_revoked")
    save_private(args.output, entries)
    write_connection_files(args.output, root, consent_file, identifier, started_at)
    emit("connected", verified_message_databases=len(message_databases(root)))
    return 0


def capture_error_category(error):
    category = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    if category in {"invalid_database_page", "database_unreadable", "readonly_query_failed",
                    "readonly_database_snapshot_busy", "database_baseline_failed"} or isinstance(error, OSError):
        return "wechat_reader_unavailable"
    if category in {"database_key_rejected", "database_key_missing", "invalid_database_key"}:
        return "wechat_keys_outdated"
    return category


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        detail = str(error).splitlines()[0][:180]
        category = capture_error_category(error)
        emit("capture_error", category=category, detail=detail)
        raise SystemExit(2)
