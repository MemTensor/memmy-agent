import ctypes
import hashlib
import hmac
import importlib.util
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[4] / "src/tools/computer-history/win/weixin_keys.py"
spec = importlib.util.spec_from_file_location("weixin_keys", MODULE_PATH)
keys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keys)


def page_for(raw_key, salt=None):
    salt = salt or bytes(range(16))
    body = bytes((index * 3) % 256 for index in range(4016))
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", raw_key, mac_salt, 2, 32)
    digest = hmac.new(mac_key, body + b"\x01\x00\x00\x00", hashlib.sha512).digest()
    return salt + body + digest


class UsableCaptureTests(unittest.TestCase):
    def test_requires_a_message_database_key_when_message_stores_exist(self):
        pages = {"message/message_0.db": b"", "contact/contact.db": b"", "message/message_fts.db": b""}
        self.assertFalse(keys.usable_capture(pages, {}))
        self.assertFalse(keys.usable_capture(pages, {"contact/contact.db": "ab"}))
        # message_fts.db is a search index, not a numbered chat database.
        self.assertFalse(keys.usable_capture(pages, {"message/message_fts.db": "ab"}))
        self.assertTrue(keys.usable_capture(pages, {"message/message_0.db": "ab"}))

    def test_contacts_alone_are_not_a_usable_message_connection(self):
        self.assertFalse(keys.usable_capture({"contact/contact.db": b""}, {"contact/contact.db": "ab"}))
        self.assertFalse(keys.usable_capture({"contact/contact.db": b""}, {}))

    def test_every_numbered_message_shard_must_have_a_verified_key(self):
        pages = {"message/message_0.db": b"", "message/message_1.db": b"", "contact/contact.db": b""}
        self.assertFalse(keys.usable_capture(pages, {"message/message_0.db": "ab"}))
        self.assertTrue(keys.usable_capture(pages, {
            "message/message_0.db": "ab", "message/message_1.db": "cd"}))


class DatabaseDiscoveryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name).resolve()
        self.documents = self.home / "OneDrive/Documents"
        for patch in (mock.patch.object(keys.Path, "home", return_value=self.home),
                      mock.patch.object(keys, "windows_documents_directory", return_value=self.documents),
                      mock.patch.object(keys, "configured_storage_roots", return_value=[]),
                      mock.patch.dict(os.environ, {"APPDATA": str(self.home / "AppData/Roaming")})):
            patch.start()
            self.addCleanup(patch.stop)

    def account(self, parent, name="wxid_fixture_1234"):
        root = parent / "xwechat_files" / name / "db_storage"
        (root / "message").mkdir(parents=True)
        (root / "message/message_0.db").write_bytes(page_for(bytes(range(32))))
        return root

    def test_original_default_single_account_still_discovers(self):
        root = self.account(self.home / "Documents")
        self.assertEqual(keys.discover_database_root(), root)

    def test_known_folder_supports_redirected_documents_and_custom_account_name(self):
        root = self.account(self.documents, "custom_account_1234")
        self.assertEqual(keys.discover_database_root(), root)

    def test_configured_other_drive_and_roaming_layout_are_both_discovered(self):
        moved = self.home / "other-drive/chat"
        first = self.account(moved)
        second = self.account(self.home / "AppData/Roaming/Tencent", "wxid_second_5678")
        with mock.patch.object(keys, "configured_storage_roots", return_value=[moved]):
            self.assertEqual(set(keys.discover_database_roots()), {first, second})
            with self.assertRaisesRegex(RuntimeError, "current_account_ambiguous"):
                keys.discover_database_root()

    def test_default_old_account_does_not_hide_the_configured_account(self):
        old = self.account(self.home / "Documents", "wxid_old_1234")
        moved = self.home / "other-drive/chat"
        current = self.account(moved)
        with mock.patch.object(keys, "configured_storage_roots", return_value=[moved, moved / "xwechat_files"]):
            self.assertEqual(set(keys.discover_database_roots()), {old, current})

    def test_indexes_without_numbered_messages_do_not_create_an_account(self):
        root = self.account(self.documents)
        (root / "message/message_0.db").rename(root / "message/message_fts.db")
        (root / "message/message_1_backup.db").touch()
        with self.assertRaisesRegex(RuntimeError, "wechat_login_required"):
            keys.discover_database_roots()


class ConfigPathTests(unittest.TestCase):
    def test_windows_config_paths_accept_spaces_non_ascii_and_unc(self):
        for text, expected in (
            ('file_path="D:\\\\微信资料\\\\xwechat_files"', "D:\\微信资料\\xwechat_files"),
            ("D:\\Chat Data", "D:\\Chat Data"),
            ("\\\\server\\chat\\xwechat_files", "\\\\server\\chat\\xwechat_files"),
        ):
            self.assertEqual([str(path) for path in keys.config_storage_paths(text)], [expected])

    def test_config_reads_utf8_and_utf16_without_scanning_non_config_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "Tencent/xwechat/config"
            config.mkdir(parents=True)
            (config / "utf8.ini").write_text("D:\\Chat Data", encoding="utf8")
            (config / "utf16.ini").write_text("E:\\微信资料", encoding="utf16")
            (config / "private.db").write_text("F:\\Ignore", encoding="utf8")
            self.assertEqual({str(path) for path in keys.configured_storage_roots(root)},
                             {"D:\\Chat Data", "E:\\微信资料"})

    def test_known_folder_uses_windows_api_and_releases_its_allocation(self):
        allocation = ctypes.create_unicode_buffer("C:\\Users\\Fixture\\OneDrive\\Documents")
        shell32, ole32 = mock.Mock(), mock.Mock()

        def resolve(folder, _flags, _token, output):
            self.assertEqual(bytes(folder), keys.uuid.UUID("fdd39ad0-238f-46af-adb4-6c85480369c7").bytes_le)
            ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(allocation)
            return 0

        shell32.SHGetKnownFolderPath.side_effect = resolve
        with mock.patch.object(keys, "sys", mock.Mock(platform="win32")), \
                mock.patch.object(keys.ctypes, "WinDLL", side_effect=[shell32, ole32], create=True):
            self.assertEqual(str(keys.windows_documents_directory()), allocation.value)
        self.assertEqual(ole32.CoTaskMemFree.call_args.args[0].value, ctypes.addressof(allocation))


class VerifiedAccountTests(unittest.TestCase):
    def test_only_the_current_accounts_verified_keys_can_select_it(self):
        pages = {"message/message_0.db": b"", "message/message_1.db": b""}
        accounts = [(Path("old/db_storage"), pages), (Path("current/db_storage"), pages)]
        found = {"1/message/message_0.db": "ab", "1/message/message_1.db": "cd"}
        self.assertEqual(keys.select_captured_account(accounts, found),
                         (Path("current/db_storage"), {"message/message_0.db": "ab", "message/message_1.db": "cd"}))
        with self.assertRaisesRegex(RuntimeError, "weixin_keys_not_found"):
            keys.select_captured_account(accounts, {"1/message/message_0.db": "ab"})
        with self.assertRaisesRegex(RuntimeError, "current_account_ambiguous"):
            keys.select_captured_account(accounts, {**found, "0/message/message_0.db": "ef"})

    def test_optional_media_and_search_indexes_are_never_opened_for_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "message").mkdir()
            expected = page_for(bytes(range(32)))
            (root / "message/message_0.db").write_bytes(expected + b"not read")
            (root / "message/message_fts.db").mkdir()
            (root / "message/message_resource.db").write_bytes(b"not an encrypted database")
            self.assertEqual(keys.encrypted_pages(root), {"message/message_0.db": expected})

    def assert_connection_retains_cursor(self, historical_error=None):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            state.mkdir(mode=0o700)
            root = Path(directory) / "Documents/xwechat_files/wxid_fixture_1234/db_storage"
            (root / "message").mkdir(parents=True)
            raw_key = bytes(range(32))
            (root / "message/message_0.db").write_bytes(page_for(raw_key))
            consent = state / "consent.json"
            consent.write_text(json.dumps({"version": 1, "enabled": True, "consentId": "fixture",
                                          "consentedAt": "2026-10-15T00:00:00Z"}))
            account = state / "account.json"
            account.write_text(json.dumps({"databaseRoot": str(root), "consentId": "fixture",
                                          "baselineSince": 123}))
            cursor = state / "cursor.json"
            cursor.write_text('{"message_0.db:Msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":8}')
            output = state / "keys.json"
            original_cursor = cursor.read_bytes()
            checks = []
            roots = [root]
            original_pages = keys.encrypted_pages
            historical = state / "old/db_storage"
            if historical_error:
                (historical / "message").mkdir(parents=True)
                (historical / "message/message_0.db").touch()
                roots.insert(0, historical)

            def read_pages(candidate):
                if candidate == historical and historical_error == "permission":
                    raise PermissionError("fixture old account cannot be read")
                return original_pages(candidate)

            def verify(actual_root, entries):
                self.assertEqual(actual_root, root)
                self.assertEqual(entries, {"message/message_0.db": {"enc_key": raw_key.hex()}})
                self.assertFalse(output.exists())
                checks.append("reader verified")

            with mock.patch.object(keys.sys, "argv", ["weixin_keys.py", "--output", str(output)]), \
                    mock.patch.object(keys, "discover_database_roots", return_value=roots), \
                    mock.patch.object(keys, "encrypted_pages", side_effect=read_pages), \
                    mock.patch.object(keys, "capture_from_running_weixin", return_value=(
                        {"0/message/message_0.db": raw_key.hex()}, {})), \
                    mock.patch.object(keys, "verify_message_databases", side_effect=verify), \
                    mock.patch.object(keys, "emit"):
                self.assertEqual(keys.main(), 0)
            self.assertEqual(checks, ["reader verified"])
            self.assertEqual(cursor.read_bytes(), original_cursor)
            self.assertEqual(json.loads(account.read_text())["baselineSince"], 123)
            self.assertEqual(json.loads(output.read_text())["keys"]["message/message_0.db"]["enc_key"], raw_key.hex())

    def test_connection_verifies_reader_before_publishing_and_keeps_existing_cursor(self):
        self.assert_connection_retains_cursor()

    def test_damaged_or_unreadable_old_account_does_not_block_verified_current_account(self):
        for error in ("empty", "permission"):
            with self.subTest(error=error):
                self.assert_connection_retains_cursor(error)

    def test_only_damaged_default_account_still_fails_without_capture_or_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            root = state / "db_storage"
            (root / "message").mkdir(parents=True)
            (root / "message/message_0.db").touch()
            (state / "consent.json").write_text(json.dumps({"version": 1, "enabled": True,
                "consentId": "fixture", "consentedAt": "2026-10-15T00:00:00Z"}))
            output = state / "keys.json"
            with mock.patch.object(keys.sys, "argv", ["weixin_keys.py", "--output", str(output)]), \
                    mock.patch.object(keys, "discover_database_roots", return_value=[root]), \
                    mock.patch.object(keys, "capture_from_running_weixin") as capture:
                with self.assertRaisesRegex(RuntimeError, "invalid_database_page"):
                    keys.main()
            capture.assert_not_called()
            self.assertFalse(output.exists())
            self.assertFalse((state / "account.json").exists())

    def test_explicit_root_error_is_not_replaced_by_another_candidate(self):
        with mock.patch.object(keys, "encrypted_pages", side_effect=PermissionError("fixture")) as pages:
            with self.assertRaises(PermissionError):
                keys.account_pages_for_capture([Path("chosen/db_storage"), Path("other/db_storage")], explicit=True)
        self.assertEqual(pages.call_args_list, [mock.call(Path("chosen/db_storage"))])

    def test_storage_and_key_failures_use_existing_safe_ui_categories(self):
        for error in (RuntimeError("invalid_database_page"), RuntimeError("database_unreadable"),
                      RuntimeError("readonly_query_failed"), PermissionError("fixture private path")):
            self.assertEqual(keys.capture_error_category(error), "wechat_reader_unavailable")
        self.assertEqual(keys.capture_error_category(RuntimeError("database_key_missing")), "wechat_keys_outdated")
        self.assertEqual(keys.capture_error_category(RuntimeError("current_account_ambiguous")), "current_account_ambiguous")

    def test_verification_failure_publishes_no_connection_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            root = state / "db_storage"
            (root / "message").mkdir(parents=True)
            raw_key = bytes(range(32))
            (root / "message/message_0.db").write_bytes(page_for(raw_key))
            (state / "consent.json").write_text(json.dumps({"version": 1, "enabled": True,
                "consentId": "fixture", "consentedAt": "2026-10-15T00:00:00Z"}))
            output = state / "keys.json"
            with mock.patch.object(keys.sys, "argv", ["weixin_keys.py", "--root", str(root), "--output", str(output)]), \
                    mock.patch.object(keys, "capture_from_running_weixin", return_value=(
                        {"0/message/message_0.db": raw_key.hex()}, {})), \
                    mock.patch.object(keys, "verify_message_databases", side_effect=RuntimeError("readonly_query_failed")), \
                    mock.patch.object(keys, "emit"):
                with self.assertRaisesRegex(RuntimeError, "readonly_query_failed"):
                    keys.main()
            self.assertFalse(output.exists())
            self.assertFalse((state / "account.json").exists())
            self.assertFalse((state / "cursor.json").exists())


class MapMemory(keys.ProcessMemory):
    def __init__(self, base, data):
        self.base = base
        self.data = data

    def regions(self):
        return [(self.base, len(self.data))]

    def read(self, address, size):
        start = address - self.base
        if start < 0 or start + size > len(self.data):
            return b""
        return self.data[start:start + size]


def cipher_image(raw_key, salt):
    literal = b"x'" + (raw_key.hex() + salt.hex()).encode() + b"'"
    blob = keys.xor_repeat(literal, keys.CIPHER_MASK)
    assert len(blob) == 99
    base = 0x200000
    size = 0x1000
    data = bytearray(size)
    needle = 0x100
    data[needle:needle + len(keys.CIPHER_NAME)] = keys.CIPHER_NAME
    pair = 0x220
    node = pair - 0x10
    struct.pack_into("<Q", data, node + 0x10, base + needle)
    struct.pack_into("<Q", data, node + 0x18, len(keys.CIPHER_NAME))
    config_ptr = base + 0x400
    struct.pack_into("<Q", data, node + 0x28, config_ptr)
    data_ptr = base + 0x800
    struct.pack_into("<Q", data, 0x400 + 0x88 + 0x8, data_ptr)
    struct.pack_into("<Q", data, 0x400 + 0x88 + 0x10, 99)
    data[0x800:0x800 + 99] = blob
    return MapMemory(base, bytes(data))


class WeixinKeyCheck(unittest.TestCase):
    def test_process_scan_preserves_64_bit_handles_and_addresses(self):
        handle = 0x100001234
        address = 0x200005678
        closed = []
        reads = []
        kernel = mock.Mock()
        kernel.OpenProcess = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                             ctypes.c_uint32)(lambda *_args: handle)

        def read(actual_handle, actual_address, output, size, count):
            reads.append((actual_handle, actual_address, size))
            ctypes.memmove(output, b"test", 4)
            count[0] = 4
            return 1

        kernel.ReadProcessMemory = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t))(read)
        kernel.CloseHandle = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)(
            lambda actual: closed.append(actual) or 1)

        def scan(memory, _pages):
            self.assertEqual(memory.read(address, 4), b"test")
            return {}, {"cipher_string_hits": 0, "cipher_nodes": 0, "candidates": 0}

        with mock.patch.object(keys, "sys", mock.Mock(platform="win32")), \
                mock.patch.object(keys.ctypes, "WinDLL", return_value=kernel, create=True), \
                mock.patch.object(keys, "weixin_pids", return_value=[123]), \
                mock.patch.object(keys, "scan_config_cipher", side_effect=scan), \
                mock.patch.object(keys, "scan_raw_literals", return_value={}):
            found, stats = keys.capture_from_running_weixin({"message/message_0.db": b""})
        self.assertEqual(found, {})
        self.assertEqual(stats["processes_opened"], 1)
        self.assertEqual(reads, [(handle, address, 4)])
        self.assertEqual(closed, [handle])

    def test_page_check_accepts_only_the_real_key(self):
        raw_key = bytes(range(32))
        page = page_for(raw_key)
        self.assertTrue(keys.authenticated_page(raw_key, page))
        self.assertFalse(keys.authenticated_page(bytes(range(1, 33)), page))

    def test_config_cipher_scan_keeps_a_key_only_after_the_page_matches(self):
        raw_key = bytes((index * 7 + 3) % 256 for index in range(32))
        salt = bytes(range(16, 32))
        page = page_for(raw_key, salt)
        found, stats = keys.scan_config_cipher(
            cipher_image(raw_key, salt),
            {"message/message_0.db": page},
        )
        self.assertEqual(found, {"message/message_0.db": raw_key.hex()})
        self.assertEqual(stats["cipher_string_hits"], 1)
        self.assertGreaterEqual(stats["candidates"], 1)

        wrong = bytes((index * 7 + 4) % 256 for index in range(32))
        found, _stats = keys.scan_config_cipher(
            cipher_image(wrong, salt),
            {"message/message_0.db": page},
        )
        self.assertEqual(found, {})

    def test_raw_literal_scan_matches_salt_and_page(self):
        raw_key = bytes((index * 5 + 1) % 256 for index in range(32))
        salt = bytes(range(8, 24))
        page = page_for(raw_key, salt)
        literal = b"x'" + (raw_key.hex() + salt.hex()).encode() + b"'"
        memory = MapMemory(0x300000, literal + b"\x00" * 16)
        self.assertEqual(
            keys.scan_raw_literals(memory, {"message/message_0.db": page}),
            {"message/message_0.db": raw_key.hex()},
        )

    def test_decrypt_page_restores_the_sqlite_header(self):
        def identity(_key, _iv, data):
            return data

        page = b"\x22" * 4096
        restored = keys.decrypt_page(b"k" * 32, page, 1, identity)
        self.assertEqual(len(restored), 4096)
        self.assertTrue(restored.startswith(b"SQLite format 3\x00"))
        self.assertEqual(
            keys.aes_cbc_decrypt(
                bytes.fromhex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4"),
                bytes.fromhex("000102030405060708090a0b0c0d0e0f"),
                bytes.fromhex("f58c4c04d6e5f1ba779eabfb5f7bfbd6"),
            ),
            bytes.fromhex("6bc1bee22e409f96e93d7e117393172a"),
        )
        self.assertEqual(keys.decode_text(1, "你好".encode()), "你好")
        self.assertIsNone(keys.decode_text(3, b"image"))
        self.assertEqual(keys.message_kind(25769803825), 49)
        self.assertEqual(keys.labeled_name("wxid_friend", {"wxid_friend": {"remark": "小王", "nick": "王先生"}}), "小王(备注)")
        self.assertEqual(keys.labeled_name("wxid_friend", {"wxid_friend": {"remark": "", "nick": "王先生"}}), "王先生(昵称)")
        self.assertEqual(keys.labeled_name("wxid_friend", {}), "wxid_friend(无备注无昵称)")
        self.assertEqual(keys.labeled_name("wxid_me", {}, "wxid_me"), "自己")
        self.assertEqual(
            keys.message_preview(25769803825, "<msg><appmsg><title><![CDATA[note.txt]]></title></appmsg></msg>".encode()),
            "file=note.txt",
        )

    def test_selected_cipher_matches_the_reference_implementation_across_blocks(self):
        key = bytes((index * 11 + 5) % 256 for index in range(32))
        iv = bytes(range(16))
        data = bytes((index * 7) % 256 for index in range(4016))
        self.assertEqual(keys.aes_cbc_decrypt(key, iv, data), keys.python_aes_cbc_decrypt(key, iv, data))
        # Reusing a cached native key must not carry the previous IV forward.
        self.assertEqual(keys.aes_cbc_decrypt(key, iv, data[:32]), keys.python_aes_cbc_decrypt(key, iv, data[:32]))

    def test_database_image_rejects_a_key_that_does_not_authenticate_page_one(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "message_0.db"
            database.write_bytes(page_for(bytes(range(32))))
            self.assertTrue(keys.database_image(database, bytes(range(32)), lambda _k, _iv, data: data))
            with self.assertRaisesRegex(RuntimeError, "database_key_rejected"):
                keys.database_image(database, bytes(range(1, 33)), lambda _k, _iv, data: data)


def wal_bytes(frames, salt=(7, 9), big_endian=False):
    magic = 0x377F0683 if big_endian else 0x377F0682
    header = struct.pack(">6I", magic, 3007000, keys.PAGE_SIZE, 0, *salt)
    checksum = keys._wal_checksum(header, big_endian)
    output = bytearray(header + struct.pack(">2I", *checksum))
    for number, commit, page in frames:
        start = struct.pack(">2I", number, commit)
        checksum = keys._wal_checksum(page, big_endian, *keys._wal_checksum(start, big_endian, *checksum))
        output += start + struct.pack(">2I", *salt) + struct.pack(">2I", *checksum) + page
    return bytes(output)


class WalMerge(unittest.TestCase):
    def page(self, value):
        return bytes([value]) * keys.PAGE_SIZE

    def test_committed_frames_replace_and_extend_main_file_pages(self):
        main = self.page(1) + self.page(2)
        wal = wal_bytes([(2, 0, self.page(20)), (3, 3, self.page(30))])
        self.assertEqual(keys.committed_pages(main, wal), [self.page(1), self.page(20), self.page(30)])

    def test_frames_after_the_last_commit_are_ignored(self):
        main = self.page(1) + self.page(2)
        wal = wal_bytes([(2, 2, self.page(20)), (1, 0, self.page(10))])
        self.assertEqual(keys.committed_pages(main, wal), [self.page(1), self.page(20)])

    def test_a_broken_checksum_ends_the_wal_at_the_previous_commit(self):
        main = self.page(1) + self.page(2)
        wal = bytearray(wal_bytes([(2, 2, self.page(20)), (1, 2, self.page(10))], big_endian=True))
        wal[-1] ^= 0xFF
        self.assertEqual(keys.committed_pages(main, bytes(wal)), [self.page(1), self.page(20)])

    def test_frames_from_an_earlier_wal_generation_are_ignored(self):
        main = self.page(1) + self.page(2)
        old = wal_bytes([(2, 2, self.page(20))], salt=(1, 1))
        restarted = wal_bytes([], salt=(2, 2))
        self.assertEqual(keys.committed_pages(main, restarted + old[32:]), [self.page(1), self.page(2)])

    def test_a_damaged_or_missing_wal_header_leaves_the_main_file(self):
        main = self.page(1) + self.page(2)
        wal = bytearray(wal_bytes([(2, 2, self.page(20))]))
        wal[16] ^= 0x01
        self.assertEqual(keys.committed_pages(main, bytes(wal)), [self.page(1), self.page(2)])
        self.assertEqual(keys.committed_pages(main, b""), [self.page(1), self.page(2)])

    def test_windows_reader_accepts_empty_optional_wal_but_not_empty_database(self):
        database = Path("message_0.db")
        wal = Path("message_0.db-wal")
        files = {str(database): self.page(1), str(wal): b""}
        handles = {}
        next_handle = iter(range(100, 110))

        def create_file(path, *_args):
            handle = next(next_handle)
            handles[handle] = files[path]
            return handle

        def get_file_size(handle, output):
            ctypes.cast(output, ctypes.POINTER(ctypes.c_uint64))[0] = len(handles[handle])
            return 1

        def read_file(handle, buffer, requested, output, _overlapped):
            data = handles[handle]
            self.assertEqual(requested, len(data))
            ctypes.memmove(buffer, data, len(data))
            ctypes.cast(output, ctypes.POINTER(ctypes.c_uint32))[0] = len(data)
            return 1

        kernel32 = mock.Mock()
        kernel32.CreateFileW.side_effect = create_file
        kernel32.GetFileSizeEx.side_effect = get_file_size
        kernel32.ReadFile.side_effect = read_file
        with mock.patch.object(keys, "sys", mock.Mock(platform="win32")), \
                mock.patch.object(keys.ctypes, "WinDLL", return_value=kernel32, create=True):
            self.assertEqual(keys.read_with_wal(database), (self.page(1), b""))
            self.assertEqual(kernel32.ReadFile.call_count, 1)
            files[str(database)] = b""
            with self.assertRaisesRegex(RuntimeError, "database_unreadable"):
                keys.read_shared(database)
            self.assertEqual(kernel32.ReadFile.call_count, 1)

    def test_a_reader_never_pairs_the_main_file_with_a_restarted_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "message_0.db"
            database.write_bytes(self.page(1))
            wal = Path(str(database) + "-wal")
            generations = iter([wal_bytes([(1, 1, self.page(10))], salt=(1, 1)),
                                wal_bytes([(1, 1, self.page(11))], salt=(2, 2))] * 3)

            def read(path, allow_empty=False):
                return next(generations) if path == wal else Path(path).read_bytes()

            with mock.patch.object(keys, "read_shared", side_effect=read), mock.patch.object(keys.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, "readonly_database_snapshot_busy"):
                    keys.read_with_wal(database)


if __name__ == "__main__":
    unittest.main()
