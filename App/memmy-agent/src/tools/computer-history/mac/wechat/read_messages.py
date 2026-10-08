#!/usr/bin/env python3
"""Read personal WeChat SQLCipher message rows without modifying its databases.

This program only reads an already provisioned, private key manifest. Provisioning
and user consent are separate steps. Its stdout is a local protocol to Memmy and
may contain message bodies; callers must never forward it to application logs.
"""

import argparse
import ctypes
import ctypes.util
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile


TABLE_NAME = re.compile(r"Msg_[0-9a-f]{32}\Z")


class SqlCipher:
    def __init__(self, library_path):
        if library_path == "builtin":
            self.builtin = True
            return
        self.builtin = False
        selected = library_path or os.environ.get("MEMMY_SQLCIPHER_LIBRARY")
        if not selected:
            selected = ctypes.util.find_library("sqlcipher")
        if not selected:
            raise RuntimeError("sqlcipher_library_unavailable")
        self.lib = ctypes.CDLL(selected)
        self.lib.sqlite3_open_v2.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_char_p]
        self.lib.sqlite3_open_v2.restype = ctypes.c_int
        self.lib.sqlite3_key.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
        self.lib.sqlite3_key.restype = ctypes.c_int
        self.lib.sqlite3_exec.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        self.lib.sqlite3_exec.restype = ctypes.c_int
        self.lib.sqlite3_close.argtypes = [ctypes.c_void_p]

    def open(self, db_path, key):
        if not re.fullmatch(r"[0-9a-fA-F]{64}", key):
            raise RuntimeError("invalid_database_key")
        if self.builtin:
            return BuiltinConnection(db_path, key)
        handle = ctypes.c_void_p()
        if self.lib.sqlite3_open_v2(os.fsencode(db_path), ctypes.byref(handle), 1, None):
            raise RuntimeError("readonly_database_open_failed")
        connection = Connection(self.lib, handle)
        try:
            literal = ("x'" + key + "'").encode("ascii")
            if self.lib.sqlite3_key(handle, literal, len(literal)):
                raise RuntimeError("database_key_rejected")
            connection.query("PRAGMA cipher_compatibility=4")
            connection.query("PRAGMA query_only=ON")
            connection.query("SELECT count(*) FROM sqlite_master")
            return connection
        except BaseException:
            connection.close()
            raise


def windows_page_codec():
    path = Path(__file__).resolve().parents[2] / "win" / "weixin_keys.py"
    spec = importlib.util.spec_from_file_location("weixin_keys", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BuiltinConnection:
    """Read a SQLCipher 4 page file with the same AES check used on Windows."""

    def __init__(self, db_path, key):
        codec = windows_page_codec()
        raw = Path(db_path).read_bytes()
        enc_key = bytes.fromhex(key)
        pages = []
        for index in range(0, len(raw) - 4096 + 1, 4096):
            pages.append(codec.decrypt_page(enc_key, raw[index:index + 4096], len(pages) + 1, codec.aes_cbc_decrypt))
        if not pages or not pages[0].startswith(b"SQLite format 3\x00"):
            raise RuntimeError("database_key_rejected")
        self.temporary = tempfile.NamedTemporaryFile(prefix="wechat-read-", suffix=".db", delete=False)
        self.temporary.write(b"".join(pages))
        self.temporary.close()
        self.connection = sqlite3.connect(self.temporary.name)

    def query(self, sql):
        try:
            cursor = self.connection.execute(sql)
        except sqlite3.DatabaseError as error:
            raise RuntimeError("readonly_query_failed") from error
        if cursor.description is None:
            return []
        names = [item[0] for item in cursor.description]
        return [{name: row[index] for index, name in enumerate(names)} for row in cursor.fetchall()]

    def close(self):
        self.connection.close()
        os.remove(self.temporary.name)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Connection:
    def __init__(self, lib, handle):
        self.lib, self.handle = lib, handle

    def query(self, sql):
        output = []
        callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_int,
                                         ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(ctypes.c_char_p))

        def receive(_, count, values, names):
            output.append({names[i].decode("utf8"): values[i].decode("utf8", "replace")
                           if values[i] else None for i in range(count)})
            return 0

        callback = callback_type(receive)
        if self.lib.sqlite3_exec(self.handle, sql.encode("utf8"), callback, None, None):
            # SQLCipher's native error can include SQL or content; never log it.
            raise RuntimeError("readonly_query_failed")
        return output

    def close(self):
        if self.handle:
            self.lib.sqlite3_close(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def private_json(path):
    p = Path(path)
    if not p.is_file() or p.is_symlink() or p.stat().st_mode & 0o077:
        raise RuntimeError("private_file_required")
    return json.loads(p.read_text())


def key_for(keys, root, db_path):
    relative = db_path.relative_to(root).as_posix()
    value = keys.get("keys", {}).get(relative)
    if isinstance(value, dict):
        value = value.get("enc_key")
    if not isinstance(value, str):
        raise RuntimeError("database_key_missing")
    return value


def tables(db):
    rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'Msg_[0-9a-f]*'")
    return [row["name"] for row in rows if row["name"] and TABLE_NAME.fullmatch(row["name"])]


def identity_module():
    path = Path(__file__).resolve().parents[2] / "wechat_identity.py"
    spec = importlib.util.spec_from_file_location("wechat_identity", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def remember_profile(profiles, username, remark="", nick=""):
    if not isinstance(username, str) or not username:
        return
    current = profiles.setdefault(username, {"remark": "", "nick": ""})
    if isinstance(remark, str) and remark.strip():
        current["remark"] = remark.strip()
    if isinstance(nick, str) and nick.strip():
        current["nick"] = nick.strip()


def absorb_profiles(db, profiles):
    tables_in_db = db.query("SELECT name FROM sqlite_master WHERE type='table'")
    for table in tables_in_db:
        name = table.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_]+", name):
            continue
        columns = {row["name"].lower(): row["name"] for row in db.query(f'PRAGMA table_info("{name}")') if row.get("name")}
        username = columns.get("username") or columns.get("user_name")
        if not username:
            continue
        remark = columns.get("remark")
        nick = columns.get("nick_name") or columns.get("nickname")
        selected = [username] + [column for column in (remark, nick) if column]
        quoted = ", ".join(f'"{column}"' for column in selected)
        for row in db.query(f'SELECT {quoted} FROM "{name}"'):
            remember_profile(profiles, row.get(username), row.get(remark) if remark else "", row.get(nick) if nick else "")


def open_profiles(root, keys, sqlcipher, profiles):
    for relative in ("contact/contact.db", "session/session.db"):
        try:
            with sqlcipher.open(root / relative, key_for(keys, root, root / relative)) as db:
                absorb_profiles(db, profiles)
        except (OSError, RuntimeError):
            continue


def scan(root, keys, sqlcipher, cursor, limit, baseline):
    identity = identity_module()
    profiles = {}
    open_profiles(root, keys, sqlcipher, profiles)
    self_id = identity.self_username(root.parent.name)
    messages = []
    next_cursor = dict(cursor)
    database_count = 0
    for db_path in sorted((root / "message").glob("message_*.db")):
        with sqlcipher.open(db_path, key_for(keys, root, db_path)) as db:
            database_count += 1
            try:
                for row in db.query("SELECT user_name FROM Name2Id"):
                    remember_profile(profiles, row.get("user_name"))
            except RuntimeError:
                pass
            usernames = list(profiles)
            for table in tables(db):
                identity_key = db_path.name + ":" + table
                previous = int(cursor.get(identity_key, 0))
                if previous < 0:
                    raise RuntimeError("invalid_cursor")
                if baseline:
                    row = db.query(f'SELECT coalesce(max(local_id),0) AS n FROM "{table}"')[0]
                    next_cursor[identity_key] = int(row["n"])
                    continue
                rows = db.query(
                    f'SELECT local_id,server_id,local_type,create_time,real_sender_id,'
                    f'hex(message_content) AS body FROM "{table}" '
                    f'WHERE local_id>{previous} ORDER BY local_id LIMIT {limit}')
                for row in rows:
                    sender = (db.query("SELECT user_name FROM Name2Id WHERE rowid=" + str(int(row["real_sender_id"])))
                              if row["real_sender_id"] is not None else [])
                    sender_id = sender[0]["user_name"] if len(sender) == 1 else None
                    described = identity.describe_message(table, sender_id, self_id, profiles, usernames)
                    messages.append({
                        "database": db_path.name, "table": table,
                        "localId": int(row["local_id"]),
                        "serverId": row["server_id"],
                        "messageType": int(row["local_type"]),
                        "createdAtSeconds": int(row["create_time"]),
                        "senderId": sender_id,
                        "bodyHex": row["body"] or "",
                        "chatKind": described["chatKind"],
                        "chatName": described["chatName"],
                        "senderName": described["senderName"],
                        "fromSelf": described["fromSelf"],
                    })
    messages.sort(key=lambda row: (row["createdAtSeconds"], row["database"], row["localId"]))
    messages = messages[:limit]
    for row in messages:
        identity_key = row["database"] + ":" + row["table"]
        next_cursor[identity_key] = max(next_cursor.get(identity_key, 0), row["localId"])
    return {"messages": messages, "nextCursor": next_cursor, "databaseCount": database_count}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("baseline", "poll"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--keys", required=True, type=Path)
    parser.add_argument("--cursor", type=Path)
    parser.add_argument("--library")
    parser.add_argument("--limit", type=int, default=200)
    args = parser.parse_args()
    if not 1 <= args.limit <= 500:
        raise RuntimeError("invalid_limit")
    root = args.root.resolve(strict=True)
    if not root.is_dir() or root.name != "db_storage":
        raise RuntimeError("invalid_database_root")
    keys = private_json(args.keys)
    cursor = private_json(args.cursor) if args.cursor else {}
    if not isinstance(cursor, dict) or any(not isinstance(value, int) for value in cursor.values()):
        raise RuntimeError("invalid_cursor")
    result = scan(root, keys, SqlCipher(args.library), cursor, args.limit, args.mode == "baseline")
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # A stable category is enough for the UI; no paths, keys or chat text.
        print(json.dumps({"error": str(error) if isinstance(error, RuntimeError) else type(error).__name__}), file=sys.stderr)
        sys.exit(2)
