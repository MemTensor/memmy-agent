import ctypes
import ctypes.util
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat/read_messages.py"
spec = importlib.util.spec_from_file_location("wechat_read_messages", SOURCE)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

TABLE = "Msg_" + "a" * 32
KEY = "b" * 64


class WeChatReadMessagesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "wxid_fixture_1234" / "db_storage"
        message_directory = self.root / "message"
        message_directory.mkdir(parents=True)
        self.database = message_directory / "message_0.db"
        self.keys = {"keys": {"message/message_0.db": KEY}}
        self.sqlcipher = reader.SqlCipher("builtin")
        # The fixture is a plain SQLite file. Only page decryption and its key
        # check are replaced; the real codec reads the file and merges its WAL.
        codec = reader.windows_page_codec()
        for patch in (
            mock.patch.object(codec, "decrypt_page", lambda key, page, number, decrypt: page),
            mock.patch.object(codec, "authenticated_page", lambda key, page: True),
            mock.patch.object(reader, "windows_page_codec", return_value=codec),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def write_messages(self, server_ids, table=TABLE, created_times=None):
        with sqlite3.connect(self.database) as database:
            database.execute("PRAGMA page_size=4096")
            database.execute("CREATE TABLE IF NOT EXISTS Name2Id (user_name TEXT)")
            database.execute("INSERT OR IGNORE INTO Name2Id (rowid, user_name) VALUES (1, 'wxid_fixture_friend')")
            # No affinity on server_id permits both the numeric Windows values
            # and already-string IDs to exercise the shared protocol boundary.
            database.execute(
                f'CREATE TABLE "{table}" ('
                'local_id INTEGER, server_id, local_type INTEGER, create_time INTEGER, '
                'real_sender_id INTEGER, message_content BLOB)'
            )
            for local_id, server_id in enumerate(server_ids, 1):
                created_at = created_times[local_id - 1] if created_times else 1_700_000_000 + local_id
                database.execute(
                    f'INSERT INTO "{table}" VALUES (?, ?, 1, ?, 1, ?)',
                    (local_id, server_id, created_at, b"fixture message"),
                )

    def test_builtin_integer_server_ids_remain_exact_strings_through_json(self):
        server_ids = [9_007_199_254_740_993, 9_223_372_036_854_775_807, 0, None]
        self.write_messages(server_ids)
        with self.sqlcipher.open(self.database, KEY) as database:
            rows = database.query(f'SELECT server_id FROM "{TABLE}" ORDER BY local_id')
            self.assertEqual([row["server_id"] for row in rows], server_ids)
            self.assertIsInstance(rows[0]["server_id"], int)

        batch = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, False)
        decoded = json.loads(json.dumps(batch, ensure_ascii=False, separators=(",", ":")))
        self.assertEqual(
            [message["serverId"] for message in decoded["messages"]],
            ["9007199254740993", "9223372036854775807", "0", None],
        )
        self.assertEqual(decoded["nextCursor"], {f"message_0.db:{TABLE}": 4})
        self.assertEqual(decoded["databaseCount"], 1)

    def test_unrelated_search_and_resource_databases_need_no_key(self):
        self.write_messages([1, 2])
        for name in ("message_fts.db", "message_resource.db", "message_1_backup.db"):
            (self.database.parent / name).write_bytes(b"unrelated encrypted index")
        batch = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, False)
        self.assertEqual([row["localId"] for row in batch["messages"]], [1, 2])
        self.assertEqual(batch["databaseCount"], 1)

    def test_missing_numbered_shard_key_fails_without_advancing_the_input_cursor(self):
        self.write_messages([1, 2])
        (self.database.parent / "message_1.db").write_bytes(self.database.read_bytes())
        cursor = {f"message_0.db:{TABLE}": 1}
        for baseline in (False, True):
            with self.assertRaisesRegex(RuntimeError, "database_key_missing"):
                reader.scan(self.root, self.keys, self.sqlcipher, cursor, 200, baseline)
            self.assertEqual(cursor, {f"message_0.db:{TABLE}": 1})

    def test_no_numbered_shards_cannot_establish_a_successful_empty_baseline(self):
        (self.database.parent / "message_fts.db").touch()
        with self.assertRaisesRegex(RuntimeError, "no_message_databases"):
            reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, True)

    def open_wal_writer(self):
        self.write_messages([1])
        writer = sqlite3.connect(self.database, isolation_level=None)
        self.addCleanup(writer.close)
        writer.execute("PRAGMA journal_mode=WAL")
        # Weixin checkpoints on its own schedule; keep new rows in the WAL.
        writer.execute("PRAGMA wal_autocheckpoint=0")
        return writer

    def insert_message(self, writer, local_id, body=b"fixture message"):
        writer.execute(f'INSERT INTO "{TABLE}" VALUES (?, ?, 1, ?, 1, ?)',
                       (local_id, local_id, 1_700_000_000 + local_id, body))

    def test_builtin_reads_committed_messages_that_are_still_in_the_wal(self):
        writer = self.open_wal_writer()
        baseline = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, True)
        self.assertEqual(baseline["nextCursor"], {f"message_0.db:{TABLE}": 1})
        self.insert_message(writer, 2)
        self.insert_message(writer, 3)
        self.assertGreater(Path(str(self.database) + "-wal").stat().st_size, 0)

        batch = reader.scan(self.root, self.keys, self.sqlcipher, baseline["nextCursor"], 200, False)
        self.assertEqual([message["localId"] for message in batch["messages"]], [2, 3])
        self.assertEqual(batch["nextCursor"], {f"message_0.db:{TABLE}": 3})

    def test_builtin_ignores_wal_pages_of_an_uncommitted_transaction(self):
        writer = self.open_wal_writer()
        self.insert_message(writer, 2)
        committed_size = Path(str(self.database) + "-wal").stat().st_size
        # A full one-page cache spills the open transaction into the WAL without a commit frame.
        writer.execute("PRAGMA cache_size=1")
        writer.execute("PRAGMA cache_spill=1")
        writer.execute("BEGIN")
        for local_id in range(3, 400):
            self.insert_message(writer, local_id, b"x" * 1000)
        self.assertGreater(Path(str(self.database) + "-wal").stat().st_size, committed_size)
        batch = reader.scan(self.root, self.keys, self.sqlcipher, {f"message_0.db:{TABLE}": 1}, 200, False)
        self.assertEqual([message["localId"] for message in batch["messages"]], [2])
        writer.execute("ROLLBACK")

    def test_baseline_since_consent_keeps_messages_sent_while_connecting(self):
        self.write_messages([1, 2, 3, 4], created_times=[100, 200, 300, 400])
        key = f"message_0.db:{TABLE}"
        self.assertEqual(reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, True)["nextCursor"], {key: 4})
        baseline = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, True, 300)
        self.assertEqual(baseline["nextCursor"], {key: 2})
        self.assertEqual(baseline["messages"], [])
        batch = reader.scan(self.root, self.keys, self.sqlcipher, baseline["nextCursor"], 200, False)
        self.assertEqual([message["localId"] for message in batch["messages"]], [3, 4])
        self.assertEqual(reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, True, 500)["nextCursor"], {key: 4})
        self.assertEqual(reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, True, 50)["nextCursor"], {key: 0})

    def test_scan_emits_fresh_display_names_for_chats_and_people(self):
        import hashlib
        self.write_messages([1, 2])
        batch = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, False)
        names = batch["names"]
        # Senders resolve by username; chats resolve by the table hash the
        # events store as conversationId, so a stale capture can self-heal.
        self.assertIn("wxid_fixture_friend", names["people"])
        friend_hash = hashlib.md5(b"wxid_fixture_friend").hexdigest()
        self.assertEqual(names["chats"][friend_hash]["kind"], "private")
        self.assertEqual(names["chats"][friend_hash]["display"], names["people"]["wxid_fixture_friend"])

    def test_existing_string_server_ids_and_null_survive_the_shared_scan(self):
        self.write_messages(["9007199254740993", "0", None])
        batch = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, False)
        self.assertEqual(
            [message["serverId"] for message in batch["messages"]],
            ["9007199254740993", "0", None],
        )

    def test_batch_limit_never_advances_past_an_omitted_earlier_local_id(self):
        other_table = "Msg_" + "c" * 32
        self.write_messages([101, 102], created_times=[200, 100])
        self.write_messages([103], table=other_table, created_times=[50])

        first = reader.scan(self.root, self.keys, self.sqlcipher, {}, 2, False)
        self.assertEqual(
            [(message["table"], message["localId"]) for message in first["messages"]],
            [(other_table, 1), (TABLE, 1)],
        )
        self.assertEqual(first["nextCursor"][f"message_0.db:{TABLE}"], 1)
        second = reader.scan(self.root, self.keys, self.sqlcipher, first["nextCursor"], 2, False)
        self.assertEqual(
            [(message["table"], message["localId"]) for message in second["messages"]],
            [(TABLE, 2)],
        )
        self.assertEqual(second["nextCursor"][f"message_0.db:{TABLE}"], 2)

    def test_bounded_batches_drain_multiple_tables_without_losing_rows(self):
        other_table = "Msg_" + "c" * 32
        self.write_messages(range(1, 202), created_times=[1000] + list(range(1, 201)))
        self.write_messages(range(301, 502), table=other_table, created_times=[500] * 201)
        cursor = {}
        received = []
        batch_sizes = []
        for _ in range(4):
            batch = reader.scan(self.root, self.keys, self.sqlcipher, cursor, 200, False)
            if not batch["messages"]:
                break
            batch_sizes.append(len(batch["messages"]))
            self.assertLessEqual(len(batch["messages"]), 200)
            for table in (TABLE, other_table):
                key = f"message_0.db:{table}"
                previous = cursor.get(key, 0)
                advanced = batch["nextCursor"].get(key, 0)
                included = sorted(message["localId"] for message in batch["messages"] if message["table"] == table)
                self.assertEqual(included, list(range(previous + 1, advanced + 1)))
            received.extend((message["table"], message["localId"]) for message in batch["messages"])
            cursor = batch["nextCursor"]

        self.assertEqual(batch_sizes, [200, 200, 2])
        self.assertEqual(len(received), 402)
        self.assertEqual(set(received), {(table, local_id) for table in (TABLE, other_table) for local_id in range(1, 202)})


class NativeSnapshotTests(unittest.TestCase):
    def setUp(self):
        library_path = ctypes.util.find_library("sqlite3")
        if not library_path or not hasattr(os, "O_NOFOLLOW"):
            self.skipTest("native SQLite snapshot fixture unavailable")
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "wxid_fixture_1234/db_storage"
        (self.root / "message").mkdir(parents=True)
        self.database = self.root / "message/message_0.db"
        self.keys = {"keys": {"message/message_0.db": KEY}}
        # Exercise the real native SQLite WAL/VFS code with a plain fixture.
        # Only SQLCipher's key setter is replaced; queries and file operations
        # run in the native library through production SqlCipher.open.
        library = ctypes.CDLL(library_path)
        library.sqlite3_key = mock.Mock(return_value=0)
        with mock.patch.object(reader.ctypes, "CDLL", return_value=library):
            self.sqlcipher = reader.SqlCipher(library_path)
        self.writer = sqlite3.connect(self.database)
        self.addCleanup(self.writer.close)
        self.writer.execute("PRAGMA journal_mode=WAL")
        self.writer.execute("PRAGMA wal_autocheckpoint=0")
        self.writer.execute("CREATE TABLE Name2Id (user_name TEXT)")
        self.writer.execute("INSERT INTO Name2Id VALUES ('wxid_fixture_friend')")
        self.writer.execute(
            f'CREATE TABLE "{TABLE}" (local_id INTEGER, server_id INTEGER, '
            'local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content BLOB)'
        )
        self.writer.execute(f'INSERT INTO "{TABLE}" VALUES (1, 101, 1, 1700000001, 1, ?)', (b"old message",))
        self.writer.commit()
        self.writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.writer.execute(f'INSERT INTO "{TABLE}" VALUES (2, 102, 1, 1700000002, 1, ?)', (b"new message in WAL",))
        self.writer.commit()

    def source_state(self):
        return {suffix: (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns,
                         path.stat().st_ctime_ns, path.stat().st_size, path.stat().st_ino)
                for suffix in ("", "-wal", "-shm")
                for path in (Path(str(self.database) + suffix),)}

    def test_native_poll_reads_committed_wal_without_touching_original_files(self):
        before = self.source_state()
        original_open = self.sqlcipher.lib.sqlite3_open_v2
        with mock.patch.object(self.sqlcipher.lib, "sqlite3_open_v2", wraps=original_open) as native_open:
            batch = reader.scan(self.root, self.keys, self.sqlcipher, {f"message_0.db:{TABLE}": 1}, 200, False)
        self.assertEqual([row["localId"] for row in batch["messages"]], [2])
        self.assertEqual(bytes.fromhex(batch["messages"][0]["bodyHex"]), b"new message in WAL")
        self.assertEqual(batch["nextCursor"], {f"message_0.db:{TABLE}": 2})
        self.assertEqual(self.source_state(), before)
        opened = [Path(os.fsdecode(call.args[0])) for call in native_open.call_args_list]
        self.assertEqual(len(opened), 1)
        self.assertNotEqual(opened[0], self.database)
        self.assertFalse(opened[0].parent.exists())

    def test_snapshot_omits_source_shm_and_has_private_modes_until_close(self):
        source_shm = Path(str(self.database) + "-shm").read_bytes()
        with mock.patch.object(reader.os, "open", wraps=os.open) as file_open:
            snapshot = reader.DatabaseSnapshot(self.database)
        self.addCleanup(snapshot.cleanup)
        directory = snapshot.path.parent
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual({path.name for path in directory.iterdir()}, {self.database.name, self.database.name + "-wal"})
        self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in directory.iterdir()))
        source_paths = {os.fspath(self.database), os.fspath(self.database) + "-wal", os.fspath(self.database) + "-shm"}
        source_calls = [call for call in file_open.call_args_list if os.fspath(call.args[0]) in source_paths]
        self.assertEqual(len(source_calls), 2)
        self.assertTrue(all(call.args[1] & os.O_ACCMODE == os.O_RDONLY for call in source_calls))
        self.assertEqual(Path(str(self.database) + "-shm").read_bytes(), source_shm)
        snapshot.cleanup()
        self.assertFalse(directory.exists())

    def test_native_snapshot_cannot_write_and_closes_after_query_error(self):
        before = self.source_state()
        with self.assertRaisesRegex(RuntimeError, "^readonly_query_failed$"):
            with self.sqlcipher.open(self.database, KEY) as database:
                directory = database.snapshot.path.parent
                database.query(f'DELETE FROM "{TABLE}"')
        self.assertFalse(directory.exists())
        self.assertEqual(self.source_state(), before)
        self.assertEqual(self.writer.execute(f'SELECT count(*) FROM "{TABLE}"').fetchone()[0], 2)

    def test_query_initialization_failure_cleans_snapshot(self):
        directories = []
        copy_bytes = reader.DatabaseSnapshot._copy_bytes

        def record_copy(descriptor, destination, size):
            directories.append(destination.parent)
            return copy_bytes(descriptor, destination, size)

        with mock.patch.object(reader.DatabaseSnapshot, "_copy_bytes", side_effect=record_copy):
            with mock.patch.object(reader.Connection, "query", side_effect=RuntimeError("database_key_rejected")):
                with self.assertRaisesRegex(RuntimeError, "^database_key_rejected$"):
                    self.sqlcipher.open(self.database, KEY)
        self.assertTrue(directories)
        self.assertTrue(all(not path.exists() for path in directories))

    def test_native_open_failure_closes_partial_handle_and_cleans_snapshot(self):
        directories = []
        original_open = self.sqlcipher.lib.sqlite3_open_v2
        original_close = self.sqlcipher.lib.sqlite3_close

        def fail_after_open(path, handle, flags, vfs):
            directories.append(Path(os.fsdecode(path)).parent)
            self.assertEqual(original_open(path, handle, flags, vfs), 0)
            return 14

        with mock.patch.object(self.sqlcipher.lib, "sqlite3_open_v2", side_effect=fail_after_open):
            with mock.patch.object(self.sqlcipher.lib, "sqlite3_close", wraps=original_close) as close:
                with self.assertRaisesRegex(RuntimeError, "^readonly_database_open_failed$"):
                    self.sqlcipher.open(self.database, KEY)
        close.assert_called_once()
        self.assertTrue(all(not path.exists() for path in directories))

    def test_uncommitted_wal_transaction_is_not_returned_or_acknowledged(self):
        self.writer.execute(f'INSERT INTO "{TABLE}" VALUES (3, 103, 1, 1700000003, 1, ?)', (b"uncommitted message",))
        before = self.source_state()
        cursor = {f"message_0.db:{TABLE}": 2}
        batch = reader.scan(self.root, self.keys, self.sqlcipher, cursor, 200, False)
        self.assertEqual(batch["messages"], [])
        self.assertEqual(batch["nextCursor"], cursor)
        self.assertEqual(self.source_state(), before)
        self.writer.rollback()

    def test_wal_append_during_copy_is_retried_without_missing_committed_message(self):
        original_copy = reader.DatabaseSnapshot._copy_bytes
        changed = False

        def append_once(descriptor, destination, size):
            nonlocal changed
            original_copy(descriptor, destination, size)
            if not changed and destination.name.endswith("-wal"):
                changed = True
                self.writer.execute(f'INSERT INTO "{TABLE}" VALUES (3, 103, 1, 1700000003, 1, ?)', (b"appended message",))
                self.writer.commit()

        with mock.patch.object(reader.DatabaseSnapshot, "_copy_bytes", side_effect=append_once):
            batch = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, False)
        self.assertTrue(changed)
        self.assertEqual([row["localId"] for row in batch["messages"]], [1, 2, 3])
        self.assertEqual(batch["nextCursor"], {f"message_0.db:{TABLE}": 3})

    def test_continuous_checkpoint_race_fails_without_advancing_input_cursor(self):
        original_copy = reader.DatabaseSnapshot._copy_bytes
        directories = []
        cursor = {f"message_0.db:{TABLE}": 1}

        def checkpoint(descriptor, destination, size):
            original_copy(descriptor, destination, size)
            if destination.name.endswith("-wal"):
                directories.append(destination.parent)
                self.writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                self.writer.execute(f'INSERT INTO "{TABLE}" VALUES (3, 103, 1, 1700000003, 1, ?)', (b"changing WAL",))
                self.writer.commit()

        with mock.patch.object(reader.DatabaseSnapshot, "_copy_bytes", side_effect=checkpoint):
            with self.assertRaisesRegex(RuntimeError, "^readonly_database_snapshot_busy$"):
                reader.scan(self.root, self.keys, self.sqlcipher, cursor, 200, False)
        self.assertEqual(len(directories), 3)
        self.assertEqual(cursor, {f"message_0.db:{TABLE}": 1})
        self.assertTrue(all(not path.exists() for path in directories))

    def test_source_replacement_is_detected_even_with_matching_length_and_timestamp(self):
        directories = []
        original_copy = reader.DatabaseSnapshot._copy_bytes

        def replace_source(descriptor, destination, size):
            original_copy(descriptor, destination, size)
            if destination.name == self.database.name:
                directories.append(destination.parent)
                previous = self.database.stat()
                replacement = self.database.with_suffix(".replacement")
                replacement.write_bytes(self.database.read_bytes())
                os.utime(replacement, ns=(previous.st_atime_ns, previous.st_mtime_ns))
                os.replace(replacement, self.database)

        with mock.patch.object(reader.DatabaseSnapshot, "_copy_bytes", side_effect=replace_source):
            with self.assertRaisesRegex(RuntimeError, "^readonly_database_snapshot_busy$"):
                self.sqlcipher.open(self.database, KEY)
        self.assertEqual(len(directories), 3)
        self.assertTrue(all(not path.exists() for path in directories))

    def test_wal_created_after_absent_observation_is_not_silently_omitted(self):
        self.writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.writer.close()
        # The macOS SQLite build may persist empty WAL/SHM on close. These are
        # our own checkpointed fixture files, with no live connection left.
        Path(str(self.database) + "-wal").unlink(missing_ok=True)
        Path(str(self.database) + "-shm").unlink(missing_ok=True)
        self.writer = sqlite3.connect(self.database)
        self.addCleanup(self.writer.close)
        self.assertFalse(Path(str(self.database) + "-wal").exists())
        original_copy = reader.DatabaseSnapshot._copy_bytes
        changed = False

        def create_wal(descriptor, destination, size):
            nonlocal changed
            original_copy(descriptor, destination, size)
            if not changed:
                changed = True
                self.writer.execute(f'INSERT INTO "{TABLE}" VALUES (3, 103, 1, 1700000003, 1, ?)', (b"new WAL",))
                self.writer.commit()

        with mock.patch.object(reader.DatabaseSnapshot, "_copy_bytes", side_effect=create_wal):
            batch = reader.scan(self.root, self.keys, self.sqlcipher, {}, 200, False)
        self.assertEqual([row["localId"] for row in batch["messages"]], [1, 2, 3])

    def test_apfs_clone_is_independent_without_bulk_file_reads(self):
        if sys.platform != "darwin":
            self.skipTest("APFS clone fixture requires macOS")
        with mock.patch.object(reader.os, "read", side_effect=AssertionError("unexpected bulk copy")):
            snapshot = reader.DatabaseSnapshot(self.database)
        self.addCleanup(snapshot.cleanup)
        self.assertNotEqual(snapshot.path.stat().st_ino, self.database.stat().st_ino)
        source_before = self.source_state()
        with snapshot.path.open("r+b") as output:
            output.write(b"private clone mutation")
        self.assertEqual(self.source_state(), source_before)

    def test_byte_copy_fallback_still_reads_wal_without_source_changes(self):
        before = self.source_state()
        with mock.patch.object(reader.DatabaseSnapshot, "_clone_bytes", return_value=False):
            batch = reader.scan(self.root, self.keys, self.sqlcipher, {f"message_0.db:{TABLE}": 1}, 200, False)
        self.assertEqual([row["localId"] for row in batch["messages"]], [2])
        self.assertEqual(self.source_state(), before)

    def test_sigterm_during_snapshot_copy_removes_private_files(self):
        script = '''
import importlib.util, signal, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("reader_fixture", sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
signal.signal(signal.SIGTERM, reader.terminate_on_signal)
copy = reader.DatabaseSnapshot._copy_bytes
def pause(descriptor, destination, size):
    copy(descriptor, destination, size)
    print(destination.parent, flush=True)
    time.sleep(30)
reader.DatabaseSnapshot._copy_bytes = staticmethod(pause)
reader.DatabaseSnapshot(Path(sys.argv[2]))
'''
        child = subprocess.Popen([sys.executable, "-c", script, str(SOURCE), str(self.database)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def stop_fixture():
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

        self.addCleanup(stop_fixture)
        self.assertTrue(select.select([child.stdout], [], [], 5)[0], "synthetic snapshot did not become ready")
        directory = Path(child.stdout.readline().strip())
        self.assertTrue(directory.is_dir())
        child.send_signal(signal.SIGTERM)
        _, errors = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 128 + signal.SIGTERM, errors)
        self.assertFalse(directory.exists())

    def test_sigterm_inside_native_callback_propagates_and_cleans_snapshot(self):
        before = self.source_state()
        script = '''
import ctypes, ctypes.util, importlib.util, linecache, os, signal, sys
spec = importlib.util.spec_from_file_location("reader_fixture", sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
signal.signal(signal.SIGTERM, reader.terminate_on_signal)
library_path = ctypes.util.find_library("sqlite3")
library = ctypes.CDLL(library_path)
library.sqlite3_key = lambda *args: 0
loader = reader.ctypes.CDLL
reader.ctypes.CDLL = lambda *args, **kwargs: library
cipher = reader.SqlCipher(library_path)
reader.ctypes.CDLL = loader
fired = False
def terminate_in_callback(frame, event, argument):
    global fired
    if (not fired and event == "line" and frame.f_code.co_name == "receive"
            and linecache.getline(reader.__file__, frame.f_lineno).strip().startswith("output.append(")):
        fired = True
        os.kill(os.getpid(), signal.SIGTERM)
    return terminate_in_callback
with cipher.open(sys.argv[2], "b" * 64) as database:
    print(database.snapshot.path.parent, flush=True)
    sys.settrace(terminate_in_callback)
    database.query("SELECT 1 AS fixture")
raise RuntimeError("termination was swallowed")
'''
        result = subprocess.run([sys.executable, "-c", script, str(SOURCE), str(self.database)],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 128 + signal.SIGTERM, result.stderr)
        self.assertNotIn("Exception ignored", result.stderr)
        directory = Path(result.stdout.strip())
        self.assertFalse(directory.exists())
        self.assertEqual(self.source_state(), before)


class BuiltinConnectionCleanupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="memmy-builtin-cleanup-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        fixture_path = self.root / "synthetic-fixture.db"
        fixture = sqlite3.connect(fixture_path)
        try:
            fixture.execute("CREATE TABLE fixture (body TEXT)")
            fixture.execute("INSERT INTO fixture VALUES ('synthetic only')")
            fixture.commit()
        finally:
            fixture.close()
        self.image = fixture_path.read_bytes()
        fixture_path.unlink()
        for patch in (
            mock.patch.object(reader.tempfile, "tempdir", self.directory.name),
            mock.patch.object(reader, "windows_page_codec", return_value=mock.Mock(
                database_image=mock.Mock(return_value=self.image))),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def open(self):
        return reader.BuiltinConnection(Path("synthetic-source.db"), KEY)

    def assert_clean(self):
        self.assertEqual(list(self.root.iterdir()), [])

    def test_normal_close_is_idempotent_and_keeps_file_reader_behavior(self):
        database = self.open()
        self.assertEqual(database.query("SELECT body FROM fixture"), [{"body": "synthetic only"}])
        directory = Path(database.temporary.name)
        if os.name != "nt":
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual(next(directory.iterdir()).stat().st_mode & 0o777, 0o600)
        database.close()
        database.close()
        self.assert_clean()

    def test_failed_directory_or_file_creation_leaves_no_plaintext_copy(self):
        for factory in ("TemporaryDirectory", "NamedTemporaryFile"):
            with self.subTest(factory=factory), mock.patch.object(
                    reader.tempfile, factory, side_effect=OSError("synthetic create failure")):
                with self.assertRaisesRegex(OSError, "synthetic create failure"):
                    self.open()
            self.assert_clean()

    def test_partial_write_and_file_close_failure_remove_plaintext_copy(self):
        original = tempfile.NamedTemporaryFile
        for phase, failure in (("write", OSError("synthetic write failure")),
                               ("close", OSError("synthetic close failure")),
                               ("write", SystemExit(143))):
            class FailingOutput:
                def __init__(self, **kwargs):
                    self.file = original(**kwargs)
                    self.name = self.file.name

                def __enter__(self):
                    return self

                def write(self, image):
                    if phase == "write":
                        self.file.write(image[:len(image) // 2])
                        self.file.flush()
                        raise failure
                    return self.file.write(image)

                def __exit__(self, *args):
                    self.file.__exit__(*args)
                    if phase == "close":
                        raise failure

            with self.subTest(phase=phase, failure=type(failure).__name__), mock.patch.object(
                    reader.tempfile, "NamedTemporaryFile", side_effect=FailingOutput):
                with self.assertRaises(type(failure)):
                    self.open()
            self.assert_clean()

    def test_sqlite_open_failure_or_interruption_removes_copy_and_sidecars(self):
        for failure in (sqlite3.OperationalError("synthetic SQLite open failure"), SystemExit(143)):
            def fail_open(database):
                path = Path(database)
                self.assertEqual(path.read_bytes(), self.image)
                Path(str(path) + "-journal").write_bytes(b"synthetic sidecar")
                raise failure

            with self.subTest(failure=type(failure).__name__), mock.patch.object(
                    reader.sqlite3, "connect", side_effect=fail_open):
                with self.assertRaises(type(failure)):
                    self.open()
            self.assert_clean()

    def test_close_failure_still_cleans_and_repeated_close_does_not_delete_reused_path(self):
        database = self.open()
        directory = Path(database.temporary.name)
        connection = database.connection

        def fail_close():
            connection.close()
            raise sqlite3.OperationalError("synthetic SQLite close failure")

        database.connection = mock.Mock(close=mock.Mock(side_effect=fail_close))
        with self.assertRaisesRegex(sqlite3.OperationalError, "synthetic SQLite close failure"):
            database.close()
        self.assert_clean()
        # A later reader may reuse a now-vacant name. A second close must not
        # retain the old path or invoke deletion on another reader's files.
        directory.mkdir()
        sentinel = directory / "other-reader.db"
        sentinel.write_bytes(b"another synthetic reader")
        database.close()
        self.assertEqual(sentinel.read_bytes(), b"another synthetic reader")


class EncryptedNativeSnapshotTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("MEMMY_SQLCIPHER_TEST_LIBRARY"), "SQLCipher encrypted fixture requires an explicit test library")
    def test_encrypted_committed_wal_poll_uses_private_snapshot(self):
        cipher = reader.SqlCipher(os.environ["MEMMY_SQLCIPHER_TEST_LIBRARY"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "wxid_fixture_1234/db_storage"
            (root / "message").mkdir(parents=True)
            source = root / "message/message_0.db"
            handle = ctypes.c_void_p()
            self.assertEqual(cipher.lib.sqlite3_open_v2(os.fsencode(source), ctypes.byref(handle), 6, None), 0)
            try:
                literal = ("x'" + KEY + "'").encode("ascii")
                self.assertEqual(cipher.lib.sqlite3_key(handle, literal, len(literal)), 0)

                def execute(sql):
                    self.assertEqual(cipher.lib.sqlite3_exec(handle, sql.encode("ascii"), None, None, None), 0)

                execute("PRAGMA cipher_compatibility=4")
                execute("PRAGMA journal_mode=WAL")
                execute("PRAGMA wal_autocheckpoint=0")
                execute("CREATE TABLE Name2Id (user_name TEXT)")
                execute("INSERT INTO Name2Id VALUES ('wxid_fixture_friend')")
                execute(f'CREATE TABLE "{TABLE}" (local_id INTEGER, server_id INTEGER, local_type INTEGER, '
                        'create_time INTEGER, real_sender_id INTEGER, message_content BLOB)')
                execute(f'INSERT INTO "{TABLE}" VALUES (1, 101, 1, 1700000001, 1, \'old message\')')
                execute("PRAGMA wal_checkpoint(TRUNCATE)")
                execute(f'INSERT INTO "{TABLE}" VALUES (2, 102, 1, 1700000002, 1, \'committed encrypted WAL\')')
                self.assertFalse(source.read_bytes().startswith(b"SQLite format 3\x00"))

                def state():
                    return {suffix: (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns,
                                     path.stat().st_ctime_ns, path.stat().st_size, path.stat().st_ino)
                            for suffix in ("", "-wal", "-shm") for path in (Path(str(source) + suffix),)}

                before = state()
                batch = reader.scan(root, {"keys": {"message/message_0.db": KEY}}, cipher,
                                    {f"message_0.db:{TABLE}": 1}, 200, False)
                self.assertEqual([row["localId"] for row in batch["messages"]], [2])
                self.assertEqual(bytes.fromhex(batch["messages"][0]["bodyHex"]), b"committed encrypted WAL")
                self.assertEqual(batch["nextCursor"], {f"message_0.db:{TABLE}": 2})
                # Exercise Windows' production codec and connection verification
                # against the same encrypted DB plus committed WAL, not a mock.
                windows_batch = reader.scan(root, {"keys": {"message/message_0.db": KEY}},
                                            reader.SqlCipher("builtin"), {f"message_0.db:{TABLE}": 1}, 200, False)
                self.assertEqual(windows_batch, batch)
                reader.windows_page_codec().verify_message_databases(root,
                    {"message/message_0.db": {"enc_key": KEY}})
                self.assertEqual(state(), before)
            finally:
                cipher.lib.sqlite3_close(handle)


class InterruptedScanTests(unittest.TestCase):
    def run_main(self, scan):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wxid_fixture_1234/db_storage"
            root.mkdir(parents=True)
            keys = Path(directory) / "keys.json"
            keys.write_text("{}")
            keys.chmod(0o600)
            arguments = ["read_messages.py", "poll", "--root", str(root), "--keys", str(keys), "--library", "builtin"]
            with mock.patch.object(sys, "argv", arguments), mock.patch.object(reader, "scan", scan), \
                    mock.patch("builtins.print") as printed:
                reader.main()
            return printed

    def test_interrupted_read_only_scan_is_repeated(self):
        result = {"messages": [], "nextCursor": {}, "databaseCount": 1, "names": {}}
        scan = mock.Mock(side_effect=[InterruptedError(4, "approval wait interrupted"), result])
        printed = self.run_main(scan)
        self.assertEqual(scan.call_count, 2)
        self.assertEqual(json.loads(printed.call_args.args[0]), result)

    def test_repeated_interruption_still_fails_the_poll(self):
        scan = mock.Mock(side_effect=InterruptedError(4, "approval wait interrupted"))
        with self.assertRaises(InterruptedError):
            self.run_main(scan)
        self.assertEqual(scan.call_count, 3)


if __name__ == "__main__":
    unittest.main()
