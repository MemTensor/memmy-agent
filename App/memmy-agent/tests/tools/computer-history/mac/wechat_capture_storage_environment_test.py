"""Private storage launch isolation; mocks the launch and never starts WeChat."""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat"


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SOURCE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture = load_module("wechat_capture_storage_environment", "capture_keys.py")
connect = load_module("wechat_connect_storage_environment", "connect.py")


def authenticating_page(key, salt):
    """Build a 4096-byte SQLCipher page the given key authenticates."""
    body = bytes(4096 - 16 - 64)
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", key, mac_salt, 2, 32)
    signature = hmac.new(mac_key, body + b"\x01\x00\x00\x00", hashlib.sha512).digest()
    return salt + body + signature


class CaptureStorageEnvironmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.app = self.directory / "state/connection-helper/Memmy WeChat Reader.app"
        self.executable = self.app / "Contents/MacOS/WeChat"
        self.executable.parent.mkdir(parents=True)
        self.executable.write_bytes(b"fake-executable")
        frameworks = self.app / "Contents/Frameworks"
        frameworks.mkdir(parents=True)
        self.bridge = frameworks / "MemmyWeChatPrivateStorage.dylib"
        self.bridge.write_bytes(b"fake-interposer")
        self.capture = frameworks / "MemmyWeChatKeyCapture.dylib"
        self.capture.write_bytes(b"fake-key-capture")
        self.sink = self.directory / "keys.sink"
        self.sink.write_bytes(b"")
        self.mapping_environment = {
            "MEMMY_WECHAT_CONTAINER_SOURCE": str(self.directory / "original/Library/Containers/com.tencent.xinWeChat"),
            "MEMMY_WECHAT_CONTAINER_COPY": str(self.directory / "private/Library/Containers/com.tencent.xinWeChat"),
            "MEMMY_WECHAT_GROUP_SOURCE": str(self.directory / "original/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"),
            "MEMMY_WECHAT_GROUP_COPY": str(self.directory / "private/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"),
        }

    def test_verified_account_password_unlocks_a_second_unopened_shard(self):
        password = b"synthetic-account-password"
        salts = [bytes(range(16)), bytes(range(16, 32))]
        derived = [hashlib.pbkdf2_hmac("sha512", password, salt, 256000, 32) for salt in salts]
        pages = {salt: [(f"message/message_{index}.db", authenticating_page(key, salt))]
                 for index, (salt, key) in enumerate(zip(salts, derived))}
        found, expanded = {}, set()
        capture.verify_record((256000, salts[0], password), pages, {}, found, expanded, lambda: True)
        self.assertEqual(found, {f"message/message_{index}.db": {"enc_key": key.hex()}
                                 for index, key in enumerate(derived)})
        self.assertEqual(expanded, {password})

    def test_unverified_password_is_not_expanded_and_cancellation_is_observed(self):
        salt = bytes(range(16))
        pages = {salt: [("message/message_0.db", authenticating_page(bytes(range(32)), salt))]}
        found, expanded = {}, set()
        capture.verify_record((256000, salt, b"wrong"), pages, {}, found, expanded, lambda: True)
        self.assertEqual(found, {})
        self.assertEqual(expanded, set())
        with mock.patch.object(capture.hashlib, "pbkdf2_hmac", side_effect=AssertionError("must not derive")):
            capture.verify_record((256000, salt, b"cancelled"), pages, {}, found, expanded, lambda: False)

    def test_adds_both_injections_the_sink_and_only_four_mappings(self):
        environment = {"PATH": "/usr/bin", "LANG": "en_US.UTF-8",
                       "DYLD_LIBRARY_PATH": "/ambient", **self.mapping_environment}
        with mock.patch.dict(os.environ, environment, clear=True):
            before = dict(os.environ)
            result = capture.private_storage_launch_environment(self.executable, self.sink)
            self.assertEqual(result["DYLD_INSERT_LIBRARIES"], f"{self.bridge}:{self.capture}")
            self.assertEqual(result["MEMMY_WECHAT_KEY_SINK"], str(self.sink))
            for key, value in self.mapping_environment.items():
                self.assertEqual(result[key], value)
            self.assertEqual(result["PATH"], "/usr/bin")
            self.assertEqual([key for key in result if key.startswith("DYLD_")], ["DYLD_INSERT_LIBRARIES"])
            self.assertEqual(dict(os.environ), before)

    def test_rejects_executables_outside_the_managed_app_layout(self):
        candidates = [
            self.directory / "state/connection-helper/WeChat.app/Contents/MacOS/WeChat",
            self.directory / "state/other/Memmy WeChat Reader.app/Contents/MacOS/WeChat",
            self.app / "Contents/MacOS/Other",
            self.app / "Contents/Resources/WeChat",
        ]
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True):
            for executable in candidates:
                with self.subTest(executable=str(executable)):
                    with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                        capture.private_storage_launch_environment(executable, self.sink)

    def test_rejects_symbolic_link_injection(self):
        for library in (self.bridge, self.capture):
            with self.subTest(library=library.name):
                outside = self.directory / "outside.dylib"
                outside.write_bytes(b"outside")
                library.unlink()
                library.symlink_to(outside)
                with mock.patch.dict(os.environ, self.mapping_environment, clear=True):
                    with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                        capture.private_storage_launch_environment(self.executable, self.sink)
                library.unlink()
                library.write_bytes(b"restored")

    def test_rejects_injection_behind_symbolic_link_directory(self):
        frameworks = self.bridge.parent
        actual = self.app / "Contents/ActualFrameworks"
        frameworks.rename(actual)
        frameworks.symlink_to(actual, target_is_directory=True)
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                capture.private_storage_launch_environment(self.executable, self.sink)

    def test_rejects_injection_owned_by_another_user(self):
        owner = self.bridge.stat().st_uid
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True), \
                mock.patch.object(capture.os, "getuid", return_value=owner + 1):
            with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                capture.private_storage_launch_environment(self.executable, self.sink)

    def test_requires_every_non_empty_container_and_group_mapping(self):
        for key in self.mapping_environment:
            for absent in (None, ""):
                environment = dict(self.mapping_environment)
                if absent is None:
                    del environment[key]
                else:
                    environment[key] = absent
                with self.subTest(key=key, value=absent), \
                        mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                        capture.private_storage_launch_environment(self.executable, self.sink)

    def test_main_verifies_a_captured_key_against_real_pages_and_writes_output(self):
        salt = bytes(range(16))
        password = b"secret-pass"
        key = hashlib.pbkdf2_hmac("sha512", password, salt, 256000, 32)
        page = authenticating_page(key, salt)
        (self.directory / "databases").mkdir()
        output = self.directory / "keys.json"
        record = capture._SINK_MAGIC + struct.pack("<III", 256000, len(salt), len(password)) + salt + password

        def fake_popen(argv, cwd, env, **options):
            self.assertEqual(argv, [str(self.executable)])
            self.assertEqual(env["DYLD_INSERT_LIBRARIES"], f"{self.bridge}:{self.capture}")
            targets = Path(env["MEMMY_WECHAT_CAPTURE_PAGES"])
            self.assertEqual(targets.read_bytes(), b"MKP1" + struct.pack("<I", 1) + page)
            self.assertEqual(targets.stat().st_mode & 0o777, 0o600)
            self.assertEqual(env["MEMMY_WECHAT_CAPTURE_SECONDS"], "240")
            with open(env["MEMMY_WECHAT_KEY_SINK"], "ab") as sink:
                sink.write(record)
            process = mock.Mock()
            process.poll.return_value = None
            return process

        arguments = [
            "capture_keys.py", "--executable", str(self.executable), "--root", str(self.directory / "databases"),
            "--output", str(output), "--consent-file", str(self.directory / "consent.json"),
            "--consent-id", "explicit-consent",
        ]
        environment = {"PATH": "/usr/bin", **self.mapping_environment}
        with mock.patch.dict(os.environ, environment, clear=True), \
                mock.patch.object(sys, "argv", arguments), \
                mock.patch.object(capture.subprocess, "Popen", side_effect=fake_popen), \
                mock.patch.object(capture, "consent_enabled", return_value=True), \
                mock.patch.object(capture, "encrypted_pages", return_value={"message/message_0.db": page}), \
                mock.patch.object(capture, "emit"):
            self.assertEqual(capture.main(), 0)
        self.assertEqual(json.loads(output.read_text()), {"keys": {"message/message_0.db": {"enc_key": key.hex()}}})
        self.assertEqual(list(output.parent.glob("key-capture-*")), [])

    def test_only_numbered_shards_and_optional_identity_pages_are_requested(self):
        root = self.directory / "databases"
        for relative in ("message/message_0.db", "message/message_17.db", "message/message_fts.db",
                         "message/message_resource.db", "contact/contact.db", "head_image/head_image.db"):
            db = root / relative
            db.parent.mkdir(parents=True, exist_ok=True)
            db.write_bytes(authenticating_page(bytes(range(32)), bytes(range(16))))
        pages = capture.encrypted_pages(root)
        self.assertEqual(set(pages), {"message/message_0.db", "message/message_17.db", "contact/contact.db"})
        self.assertEqual(capture.required_databases(pages), {"message/message_0.db", "message/message_17.db"})

    def test_partial_numbered_shards_cannot_complete_connection(self):
        root = self.directory / "databases"
        root.mkdir()
        output = self.directory / "keys.json"
        keys = [bytes(range(32)), bytes(range(32, 64))]
        salts = [bytes(range(16)), bytes(range(16, 32))]
        pages = {f"message/message_{i}.db": authenticating_page(key, salt)
                 for i, (key, salt) in enumerate(zip(keys, salts))}
        raw_salt = bytes(byte ^ 0x3a for byte in salts[0])
        record = b"MKC1" + struct.pack("<III", 2, 16, 32) + raw_salt + keys[0]

        def fake_popen(argv, cwd, env, **options):
            Path(env["MEMMY_WECHAT_KEY_SINK"]).write_bytes(record)
            process = mock.Mock()
            process.poll.return_value = 0
            return process

        arguments = ["capture_keys.py", "--executable", str(self.executable), "--root", str(root),
                     "--output", str(output), "--consent-file", str(self.directory / "consent.json"),
                     "--consent-id", "explicit-consent"]
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True), \
                mock.patch.object(sys, "argv", arguments), \
                mock.patch.object(capture, "encrypted_pages", return_value=pages), \
                mock.patch.object(capture, "consent_enabled", return_value=True), \
                mock.patch.object(capture.subprocess, "Popen", side_effect=fake_popen), \
                mock.patch.object(capture.time, "sleep"), mock.patch.object(capture, "emit") as emit:
            self.assertEqual(capture.main(), 3)
            emit.assert_any_call("capture_error", category="key_capture_incomplete")
        self.assertEqual(list(output.parent.glob("key-capture-*")), [])

    def test_invalid_required_shard_is_not_silently_omitted(self):
        root = self.directory / "databases"
        (root / "message").mkdir(parents=True)
        (root / "message/message_0.db").write_bytes(b"truncated")
        with self.assertRaisesRegex(RuntimeError, "wechat_message_database_invalid"):
            capture.encrypted_pages(root)

    def test_failed_launch_removes_private_pages_and_sink(self):
        root = self.directory / "databases"
        root.mkdir()
        arguments = ["capture_keys.py", "--executable", str(self.executable), "--root", str(root),
                     "--output", str(self.directory / "keys.json"),
                     "--consent-file", str(self.directory / "consent.json"), "--consent-id", "consent"]
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True), \
                mock.patch.object(sys, "argv", arguments), \
                mock.patch.object(capture, "encrypted_pages", return_value={"message/message_0.db": bytes(4096)}), \
                mock.patch.object(capture, "consent_enabled", return_value=True), \
                mock.patch.object(capture.subprocess, "Popen", side_effect=OSError("launch failed")):
            with self.assertRaises(OSError):
                capture.main()
        self.assertEqual(list(self.directory.glob("key-capture-*")), [])


class ConnectStorageEnvironmentTests(unittest.TestCase):
    def test_cleans_ambient_injection_and_regenerates_exact_four_mapping_variables(self):
        container = "/Users/test/Library/Containers/com.tencent.xinWeChat"
        group = "/Users/test/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"
        mappings = {container: "/private/session/container", group: "/private/session/group"}
        normal = {"PATH": "/usr/bin", "HOME": "/Users/test", "LANG": "zh_CN.UTF-8", "MEMMY_OTHER": "keep"}
        ambient = {
            **normal,
            "PYTHONPATH": "/ambient/python", "PYTHONDONTWRITEBYTECODE": "0",
            "DYLD_INSERT_LIBRARIES": "/ambient/inject.dylib", "DYLD_LIBRARY_PATH": "/ambient/libs",
            "DYLD_FRAMEWORK_PATH": "/ambient/frameworks", "DYLD_UNKNOWN": "remove",
            "MEMMY_WECHAT_CONTAINER_SOURCE": "/ambient/source",
            "MEMMY_WECHAT_GROUP_COPY": "/ambient/copy", "MEMMY_WECHAT_OTHER": "remove",
        }
        with mock.patch.dict(os.environ, ambient, clear=True):
            before = dict(os.environ)
            environment = connect.storage_environment({"mappings": mappings})
            self.assertEqual(dict(os.environ), before)
        self.assertEqual(environment, {
            **normal, "PYTHONDONTWRITEBYTECODE": "1",
            "MEMMY_WECHAT_CONTAINER_SOURCE": container,
            "MEMMY_WECHAT_CONTAINER_COPY": mappings[container],
            "MEMMY_WECHAT_GROUP_SOURCE": group,
            "MEMMY_WECHAT_GROUP_COPY": mappings[group],
        })
        self.assertNotIn("PYTHONPATH", environment)
        self.assertFalse(any(key.startswith("DYLD_") for key in environment))
        self.assertEqual(sum(key.startswith("MEMMY_WECHAT_") for key in environment), 4)


if __name__ == "__main__":
    unittest.main()
