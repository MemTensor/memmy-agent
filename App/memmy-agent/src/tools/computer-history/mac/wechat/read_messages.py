#!/usr/bin/env python3
"""Read personal WeChat SQLCipher message rows without modifying its databases.

This program only reads an already provisioned, private key manifest. Provisioning
and user consent are separate steps. Its stdout is a local protocol to Memmy and
may contain message bodies; callers must never forward it to application logs.
"""

import argparse
import ctypes
import ctypes.util
import errno
import heapq
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import stat
import sys
import tempfile
import time


TABLE_NAME = re.compile(r"Msg_[0-9a-f]{32}\Z")
MESSAGE_DATABASE = re.compile(r"message_[0-9]+\.db\Z")


class SnapshotChanged(Exception):
    pass


class DatabaseSnapshot:
    """Copy encrypted DB/WAL bytes without joining WeChat's SQLite connections.

    SQLITE_OPEN_READONLY and query_only still allow SQLite to update a WAL's
    shared-memory index. Native SQLite must therefore only see our own files.
    Never copy the source -shm: the private connection rebuilds its own index.
    """

    def __init__(self, source):
        self.temporary = None
        source = Path(source)
        for attempt in range(3):
            try:
                self._copy(source)
                return
            except (SnapshotChanged, FileNotFoundError):
                self.cleanup()
                if attempt < 2:
                    time.sleep(0.01)
            except BaseException:
                self.cleanup()
                raise
        raise RuntimeError("readonly_database_snapshot_busy")

    @staticmethod
    def _state(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                info.st_mtime_ns, info.st_ctime_ns)

    @staticmethod
    def _open_source(path, optional=False):
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            if optional:
                return None, None
            raise
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError("readonly_database_snapshot_failed")
            return descriptor, DatabaseSnapshot._state(info)
        except BaseException:
            os.close(descriptor)
            raise

    @staticmethod
    def _clone_bytes(descriptor, destination, size):
        if sys.platform != "darwin":
            return False
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        try:
            clone = library.fclonefileat
        except AttributeError:
            return False
        clone.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        clone.restype = ctypes.c_int
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            # Independent APFS copy-on-write files avoid copying gigabytes every
            # poll. No hardlinks, owner/ACL copying or source writes are used.
            if clone(descriptor, directory, os.fsencode(destination.name), 0x0002 | 0x0008):
                error = ctypes.get_errno()
                if error in (errno.EXDEV, errno.ENOTSUP, errno.ENOSYS):
                    return False
                raise OSError(error, "private database clone failed")
        finally:
            os.close(directory)
        copied = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            original, info = os.fstat(descriptor), os.fstat(copied)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or (info.st_dev, info.st_ino) == (original.st_dev, original.st_ino)):
                raise RuntimeError("readonly_database_snapshot_failed")
            if info.st_size != size:
                raise SnapshotChanged()
            os.fchmod(copied, 0o600)
        finally:
            os.close(copied)
        return True

    @staticmethod
    def _copy_bytes(descriptor, destination, size):
        if DatabaseSnapshot._clone_bytes(descriptor, destination, size):
            return
        target = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(target, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            remaining = size
            while remaining:
                value = os.read(descriptor, min(remaining, 1024 * 1024))
                if not value:
                    raise SnapshotChanged()
                output.write(value)
                remaining -= len(value)

    @staticmethod
    def _unchanged(path, descriptor, before):
        try:
            current = DatabaseSnapshot._state(os.stat(path, follow_symlinks=False))
        except FileNotFoundError:
            current = None
        if descriptor is None:
            return current is None
        return before == current == DatabaseSnapshot._state(os.fstat(descriptor))

    def _copy(self, source):
        sources = []
        try:
            for path, optional in ((source, False), (Path(str(source) + "-wal"), True)):
                descriptor, before = self._open_source(path, optional)
                sources.append((path, descriptor, before))
            # A rollback journal requires SQLite recovery; do not expose an
            # uncommitted main-file image or let SQLite recover the original.
            if os.path.lexists(str(source) + "-journal"):
                raise SnapshotChanged()
            self.temporary = tempfile.TemporaryDirectory(prefix="memmy-wechat-read-")
            directory = Path(self.temporary.name)
            os.chmod(directory, 0o700)
            self.path = directory / source.name
            for path, descriptor, before in sources:
                if descriptor is not None:
                    self._copy_bytes(descriptor, directory / path.name, before[3])
            # Appends, truncations, replacements and checkpoint writes invalidate
            # the pair. Fail after bounded retries instead of acknowledging rows
            # from an inconsistent image. No original SQLite locks are acquired.
            if (os.path.lexists(str(source) + "-journal")
                    or any(not self._unchanged(*item) for item in sources)):
                raise SnapshotChanged()
        except OSError as error:
            if isinstance(error, FileNotFoundError):
                raise
            raise RuntimeError("readonly_database_snapshot_failed") from None
        finally:
            for _, descriptor, _ in sources:
                if descriptor is not None:
                    os.close(descriptor)

    def cleanup(self):
        if self.temporary is not None:
            self.temporary.cleanup()
            self.temporary = None


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
        snapshot = DatabaseSnapshot(db_path)
        handle = ctypes.c_void_p()
        connection = Connection(self.lib, handle, snapshot)
        try:
            if self.lib.sqlite3_open_v2(os.fsencode(snapshot.path), ctypes.byref(handle), 1, None):
                raise RuntimeError("readonly_database_open_failed")
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
    """Read a SQLCipher 4 database and its committed WAL with the Windows page codec."""

    def __init__(self, db_path, key):
        self.temporary = None
        self.connection = None
        try:
            image = windows_page_codec().database_image(Path(db_path), bytes.fromhex(key))
            # Own the whole private directory so failed opens and SQLite sidecars
            # are cleaned along with the decrypted copy, before __enter__ runs.
            self.temporary = tempfile.TemporaryDirectory(prefix="wechat-read-")
            with tempfile.NamedTemporaryFile(suffix=".db", dir=self.temporary.name, delete=False) as output:
                output.write(image)
                database = output.name
            self.connection = sqlite3.connect(database)
        except BaseException:
            self.close()
            raise

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
        try:
            connection, self.connection = self.connection, None
            if connection is not None:
                connection.close()
        finally:
            temporary, self.temporary = self.temporary, None
            if temporary is not None:
                temporary.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Connection:
    def __init__(self, lib, handle, snapshot):
        self.lib, self.handle = lib, handle
        self.snapshot = snapshot

    def query(self, sql):
        output = []
        callback_error = None
        callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_int,
                                         ctypes.POINTER(ctypes.c_char_p), ctypes.POINTER(ctypes.c_char_p))

        def receive(_, count, values, names):
            nonlocal callback_error
            try:
                output.append({names[i].decode("utf8"): values[i].decode("utf8", "replace")
                               if values[i] else None for i in range(count)})
                return 0
            except BaseException as error:
                # ctypes otherwise prints and swallows exceptions raised inside
                # native callbacks, including SIGTERM's SystemExit. Abort SQLite
                # and rethrow in Python so termination still unwinds cleanup.
                callback_error = error
                return 1

        callback = callback_type(receive)
        status = self.lib.sqlite3_exec(self.handle, sql.encode("utf8"), callback, None, None)
        if callback_error is not None:
            raise callback_error
        if status:
            # SQLCipher's native error can include SQL or content; never log it.
            raise RuntimeError("readonly_query_failed")
        return output

    def close(self):
        try:
            if self.handle:
                self.lib.sqlite3_close(self.handle)
                self.handle = None
        finally:
            self.snapshot.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def private_json(path):
    p = Path(path)
    if os.name == "nt":
        helper = Path(__file__).resolve().parents[2] / "win" / "private_files.py"
        spec = importlib.util.spec_from_file_location("wechat_private_files", helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.validate_private_file(p)
    elif not p.is_file() or p.is_symlink() or p.stat().st_mode & 0o077:
        raise RuntimeError("private_file_required")
    return json.loads(p.read_text(encoding="utf8"))


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


def resolve_names(identity, profiles, self_id):
    """Freshest display names, keyed the way events store them: chats by the
    message-table hash (the event's conversationId), people by username. A chat
    or sender captured before WeChat finished syncing its contact metadata was
    frozen with a raw id; this lets the summary self-heal it to the real name."""
    chats = {}
    for table_hash, username in identity.username_by_message_table(list(profiles)).items():
        chats[table_hash] = {
            "display": identity.display_name(username, profiles, self_id),
            "kind": identity.chat_kind(username),
        }
    people = {username: identity.display_name(username, profiles, self_id) for username in profiles}
    return {"chats": chats, "people": people}


def baseline_query(table, since):
    if since is None:
        return f'SELECT coalesce(max(local_id),0) AS n FROM "{table}"'
    # Start just before the first row created at or after `since`, so messages
    # that arrived while the connection was being set up are still read.
    return (f'SELECT coalesce((SELECT min(local_id) - 1 FROM "{table}" WHERE create_time >= {int(since)}), '
            f'(SELECT max(local_id) FROM "{table}"), 0) AS n')


def scan(root, keys, sqlcipher, cursor, limit, baseline, since=None):
    identity = identity_module()
    profiles = {}
    open_profiles(root, keys, sqlcipher, profiles)
    self_id = identity.self_username(root.parent.name)
    messages = []
    message_streams = []
    next_cursor = dict(cursor)
    database_count = 0
    # Search/resource indexes are not chat shards and need no key to read text.
    databases = sorted(path for path in (root / "message").glob("message_*.db")
                       if MESSAGE_DATABASE.fullmatch(path.name))
    if not databases:
        raise RuntimeError("no_message_databases")
    for db_path in databases:
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
                    row = db.query(baseline_query(table, since))[0]
                    next_cursor[identity_key] = int(row["n"])
                    continue
                rows = db.query(
                    f'SELECT local_id,server_id,local_type,create_time,real_sender_id,'
                    f'hex(message_content) AS body FROM "{table}" '
                    f'WHERE local_id>{previous} ORDER BY local_id LIMIT {limit}')
                table_messages = []
                for row in rows:
                    sender = (db.query("SELECT user_name FROM Name2Id WHERE rowid=" + str(int(row["real_sender_id"])))
                              if row["real_sender_id"] is not None else [])
                    sender_id = sender[0]["user_name"] if len(sender) == 1 else None
                    described = identity.describe_message(table, sender_id, self_id, profiles, usernames)
                    table_messages.append({
                        "database": db_path.name, "table": table,
                        "localId": int(row["local_id"]),
                        # sqlite3 returns integers on Windows; sqlite3_exec returns
                        # strings on macOS. Keep 64-bit IDs exact in the JSON protocol.
                        "serverId": str(row["server_id"]) if row["server_id"] is not None else None,
                        "messageType": int(row["local_type"]),
                        "createdAtSeconds": int(row["create_time"]),
                        "senderId": sender_id,
                        "bodyHex": row["body"] or "",
                        "chatKind": described["chatKind"],
                        "chatName": described["chatName"],
                        "senderName": described["senderName"],
                        "fromSelf": described["fromSelf"],
                    })
                if table_messages:
                    message_streams.append(table_messages)
    # Timestamps can move backwards within a table. Select only local_id
    # prefixes so advancing a cursor never skips an omitted lower local_id.
    pending = [(stream[0]["createdAtSeconds"], stream[0]["database"], stream[0]["localId"], index, 0)
               for index, stream in enumerate(message_streams)]
    heapq.heapify(pending)
    while pending and len(messages) < limit:
        _, _, _, stream_index, row_index = heapq.heappop(pending)
        stream = message_streams[stream_index]
        messages.append(stream[row_index])
        row_index += 1
        if row_index < len(stream):
            row = stream[row_index]
            heapq.heappush(pending, (row["createdAtSeconds"], row["database"], row["localId"], stream_index, row_index))
    messages.sort(key=lambda row: (row["createdAtSeconds"], row["database"], row["localId"]))
    for row in messages:
        identity_key = row["database"] + ":" + row["table"]
        next_cursor[identity_key] = max(next_cursor.get(identity_key, 0), row["localId"])
    return {"messages": messages, "nextCursor": next_cursor, "databaseCount": database_count,
            "names": resolve_names(identity, profiles, self_id)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("baseline", "poll"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--keys", required=True, type=Path)
    parser.add_argument("--cursor", type=Path)
    parser.add_argument("--library")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--since", type=int)
    args = parser.parse_args()
    if not 1 <= args.limit <= 500:
        raise RuntimeError("invalid_limit")
    if args.since is not None and (args.mode != "baseline" or args.since < 0):
        raise RuntimeError("invalid_since")
    root = args.root.resolve(strict=True)
    if not root.is_dir() or root.name != "db_storage":
        raise RuntimeError("invalid_database_root")
    keys = private_json(args.keys)
    cursor = private_json(args.cursor) if args.cursor else {}
    if not isinstance(cursor, dict) or any(not isinstance(value, int) for value in cursor.values()):
        raise RuntimeError("invalid_cursor")
    sqlcipher = SqlCipher(args.library)
    for attempt in range(3):
        try:
            result = scan(root, keys, sqlcipher, cursor, args.limit, args.mode == "baseline", args.since)
            break
        except InterruptedError:
            # Each poll is a new process whose first access to WeChat's container
            # waits for macOS approval. A lost approval interrupts the read; a
            # repeated read-only scan requests approval again.
            if attempt == 2:
                raise
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


def terminate_on_signal(signum, _frame):
    # execFile's timeout sends SIGTERM. Unwind snapshot/connection cleanup rather
    # than leaving private encrypted database copies behind after termination.
    raise SystemExit(128 + signum)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate_on_signal)
    try:
        main()
    except Exception as error:
        # A stable category is enough for the UI; no paths, keys or chat text.
        print(json.dumps({"error": str(error) if isinstance(error, RuntimeError) else type(error).__name__}), file=sys.stderr)
        sys.exit(2)
