import importlib.util
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


storage = load("wechat_private_files", SOURCE / "win/private_files.py")
keys = load("weixin_keys", SOURCE / "win/weixin_keys.py")
reader = load("wechat_read_messages", SOURCE / "mac/wechat/read_messages.py")
USER = "S-1-5-21-100-200-300-1001"
ENTRIES = [(0, 0, storage.FILE_ALL_ACCESS, USER),
           (0, 0, storage.FILE_ALL_ACCESS, "S-1-5-18"),
           (0, 0, storage.FILE_ALL_ACCESS, "S-1-5-32-544")]


class DescriptorPolicyTests(unittest.TestCase):
    def test_accepts_only_current_owner_user_system_and_administrators(self):
        self.assertTrue(storage.descriptor_is_private(USER, USER, True, ENTRIES, True))
        # A new Node cursor inherits the already protected parent ACL.
        self.assertTrue(storage.descriptor_is_private(USER, USER, False, ENTRIES))

    def test_rejects_public_acl_foreign_owner_unknown_ace_and_null_acl(self):
        cases = [
            ("S-1-5-21-other", USER, True, ENTRIES),
            (USER, USER, True, ENTRIES + [(0, 0, 1, "S-1-1-0")]),
            (USER, USER, True, [(9, 0, storage.FILE_ALL_ACCESS, USER)]),
            (USER, USER, True, []),
            (USER, USER, True, [(0, 0, 0x120089, USER)]),
            (USER, USER, True, [(0, 0x08, storage.FILE_ALL_ACCESS, USER)]),
        ]
        for value in cases:
            with self.subTest(value=value):
                self.assertFalse(storage.descriptor_is_private(*value))
        self.assertFalse(storage.descriptor_is_private(USER, USER, False, ENTRIES, True))


class PrivateStateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="wechat-private-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_windows_validation_uses_real_owner_and_dacl_instead_of_synthetic_posix_mode(self):
        file = self.root / "keys.json"
        file.write_text("{}", encoding="utf8")
        api = mock.Mock()
        api._policy_inputs.side_effect = [
            (USER, USER, True, ENTRIES), (USER, USER, False, ENTRIES)]
        with mock.patch.object(storage, "WINDOWS", True), mock.patch.object(storage, "_windows_security", return_value=api):
            storage.validate_private_file(file)
        self.assertEqual(api._policy_inputs.call_args_list, [mock.call(file.parent), mock.call(file)])

    def test_windows_reader_rejects_public_parent_even_when_file_is_restricted(self):
        file = self.root / "keys.json"
        file.write_text("{}", encoding="utf8")
        api = mock.Mock()
        api._policy_inputs.return_value = (USER, USER, False, ENTRIES)
        with mock.patch.object(storage, "WINDOWS", True), mock.patch.object(storage, "_windows_security", return_value=api):
            with self.assertRaisesRegex(RuntimeError, "private_file_required"):
                storage.validate_private_file(file)

    def test_atomic_utf8_write_protects_parent_and_file_before_any_key_bytes(self):
        file = self.root / "中文账号 空格" / "keys.json"
        api = mock.Mock()
        operations = []

        def protect(path, directory):
            if not directory:
                self.assertEqual(Path(path).read_bytes(), b"")
            operations.append((Path(path), directory))

        api.protect.side_effect = protect
        with mock.patch.object(storage, "WINDOWS", True), mock.patch.object(storage, "_windows_security", return_value=api):
            storage.write_private_json(file, {"keys": {"中文": "密钥"}})
        self.assertEqual(json.loads(file.read_bytes().decode("utf8")), {"keys": {"中文": "密钥"}})
        self.assertEqual(len(operations), 2)
        self.assertEqual(operations[0], (file.parent, True))
        self.assertFalse(operations[1][1])
        self.assertEqual(list(file.parent.glob("*.pending")), [])

    def test_failed_acl_protection_never_replaces_prior_state(self):
        file = self.root / "keys.json"
        file.write_text('{"old":true}', encoding="utf8")
        api = mock.Mock()
        api.descriptor.return_value = (USER, True, ENTRIES)
        api.current_sid.return_value = USER
        api.protect.side_effect = [None, RuntimeError("private_state_acl_unavailable")]
        with mock.patch.object(storage, "WINDOWS", True), mock.patch.object(storage, "_windows_security", return_value=api):
            with self.assertRaisesRegex(RuntimeError, "private_state_acl_unavailable"):
                storage.write_private_json(file, {"keys": {"private": "secret"}})
        self.assertEqual(json.loads(file.read_text(encoding="utf8")), {"old": True})
        self.assertEqual(list(self.root.glob("*.pending")), [])

    def test_reconnection_preserves_cursor_and_upgrades_old_state_permissions(self):
        file = self.root / "keys.json"
        keys.save_private(file, {"message/message_0.db": {"enc_key": "a" * 64}})
        database_root = Path("D:/中文账号/db_storage")
        consent_file = self.root / "consent.json"
        identifier = keys.grant_consent(consent_file)
        baseline_since = int(datetime.fromisoformat(
            reader.private_json(consent_file)["consentedAt"].replace("Z", "+00:00")).timestamp()) + 5
        storage.write_private_json(self.root / "account.json", {
            "databaseRoot": str(database_root), "consentId": identifier,
            "baselineSince": baseline_since})
        cursor = self.root / "cursor.json"
        cursor.write_text('{"message_0.db:Msg_abc":17}', encoding="utf8")
        original = cursor.read_bytes()
        keys.write_connection_files(file, database_root, consent_file, identifier)
        self.assertEqual(cursor.read_bytes(), original)
        self.assertEqual(json.loads(cursor.read_text(encoding="utf8")), {"message_0.db:Msg_abc": 17})
        self.assertEqual(reader.private_json(file)["keys"]["message/message_0.db"]["enc_key"], "a" * 64)
        self.assertEqual(reader.private_json(self.root / "account.json")["baselineSince"], baseline_since)
        if os.name != "nt":
            self.assertEqual(cursor.stat().st_mode & 0o777, 0o600)

    def test_first_connection_leaves_cursor_absent_for_initial_baseline(self):
        file = self.root / "keys.json"
        database_root = Path("D:/中文账号/db_storage")
        consent_file = self.root / "consent.json"
        identifier = keys.grant_consent(consent_file)
        consented_at = int(datetime.fromisoformat(
            reader.private_json(consent_file)["consentedAt"].replace("Z", "+00:00")).timestamp())
        keys.write_connection_files(file, database_root, consent_file, identifier)
        self.assertFalse((self.root / "cursor.json").exists())
        self.assertEqual(reader.private_json(self.root / "account.json"), {
            "databaseRoot": str(database_root), "consentId": identifier,
            "baselineSince": consented_at})

    def test_failed_first_read_keeps_account_baseline_on_reconnect(self):
        file = self.root / "keys.json"
        database_root = Path("D:/中文账号/db_storage")
        consent_file = self.root / "consent.json"
        identifier = keys.grant_consent(consent_file)
        keys.write_connection_files(file, database_root, consent_file, identifier)
        original = reader.private_json(self.root / "account.json")["baselineSince"]
        self.assertFalse((self.root / "cursor.json").exists())
        keys.write_connection_files(file, database_root, consent_file, identifier, original + 3_600)
        self.assertEqual(reader.private_json(self.root / "account.json")["baselineSince"], original)

    def test_legacy_same_account_with_active_consent_retains_cursor(self):
        file = self.root / "keys.json"
        database_root = Path("D:/中文账号/db_storage")
        consent_file = self.root / "consent.json"
        identifier = keys.grant_consent(consent_file)
        storage.write_private_json(self.root / "account.json", {"databaseRoot": str(database_root)})
        storage.write_private_json(self.root / "cursor.json", {"message_0.db:Msg_abc": 8})
        keys.write_connection_files(file, database_root, consent_file, identifier)
        self.assertEqual(reader.private_json(self.root / "cursor.json"), {"message_0.db:Msg_abc": 8})
        self.assertEqual(reader.private_json(self.root / "account.json")["consentId"], identifier)

    def test_new_account_or_new_consent_discards_stale_checkpoint(self):
        for previous_account in (None, {"databaseRoot": "D:/other_account/db_storage"},
                                 {"databaseRoot": "D:/中文账号/db_storage", "consentId": "prior-consent"}):
            with self.subTest(previous_account=previous_account):
                file = self.root / "keys.json"
                database_root = Path("D:/中文账号/db_storage")
                consent_file = self.root / "consent.json"
                identifier = keys.grant_consent(consent_file)
                consented_at = int(datetime.fromisoformat(
                    reader.private_json(consent_file)["consentedAt"].replace("Z", "+00:00")).timestamp())
                account = self.root / "account.json"
                account.unlink(missing_ok=True)
                if previous_account is not None:
                    storage.write_private_json(account, previous_account)
                storage.write_private_json(self.root / "cursor.json", {"message_0.db:Msg_abc": 11})
                keys.write_connection_files(file, database_root, consent_file, identifier, consented_at + 30)
                self.assertFalse((self.root / "cursor.json").exists())
                self.assertEqual(reader.private_json(account), {
                    "databaseRoot": str(database_root), "consentId": identifier,
                    "baselineSince": consented_at + 30 if previous_account is not None
                    and previous_account["databaseRoot"] != str(database_root) else consented_at})

    def test_revoked_consent_does_not_mutate_connection_checkpoint(self):
        file = self.root / "keys.json"
        database_root = Path("D:/中文账号/db_storage")
        consent_file = self.root / "consent.json"
        identifier = keys.grant_consent(consent_file)
        account_payload = {"databaseRoot": str(database_root), "consentId": identifier}
        cursor_payload = {"message_0.db:Msg_abc": 8}
        storage.write_private_json(self.root / "account.json", account_payload)
        storage.write_private_json(self.root / "cursor.json", cursor_payload)
        state = reader.private_json(consent_file)
        state["enabled"] = False
        storage.write_private_json(consent_file, state)
        with self.assertRaisesRegex(RuntimeError, "wechat_consent_revoked"):
            keys.write_connection_files(file, database_root, consent_file, identifier)
        self.assertEqual(reader.private_json(self.root / "account.json"), account_payload)
        self.assertEqual(reader.private_json(self.root / "cursor.json"), cursor_payload)

    def test_malformed_account_preserves_existing_checkpoint(self):
        file = self.root / "keys.json"
        database_root = Path("D:/中文账号/db_storage")
        consent_file = self.root / "consent.json"
        identifier = keys.grant_consent(consent_file)
        account = self.root / "account.json"
        cursor = self.root / "cursor.json"
        cursor_payload = {"message_0.db:Msg_abc": 8}
        storage.write_private_json(cursor, cursor_payload)
        for malformed in ('[]', '{}', '{"databaseRoot":""}', '{"databaseRoot":31}',
                          '{"databaseRoot":"D:/中文账号/db_storage","consentId":null}', '{broken'):
            with self.subTest(malformed=malformed):
                account.write_text(malformed, encoding="utf8")
                with self.assertRaisesRegex(RuntimeError, "invalid_account"):
                    keys.write_connection_files(file, database_root, consent_file, identifier)
                self.assertEqual(account.read_text(encoding="utf8"), malformed)
                self.assertEqual(reader.private_json(cursor), cursor_payload)

    def test_revocation_during_acl_upgrade_preserves_existing_checkpoint(self):
        file = self.root / "keys.json"
        database_root = Path("D:/中文账号/db_storage")
        consent_file = self.root / "consent.json"
        identifier = keys.grant_consent(consent_file)
        account_payload = {"databaseRoot": "D:/other_account/db_storage", "consentId": "prior-consent"}
        cursor = self.root / "cursor.json"
        cursor_payload = {"message_0.db:Msg_abc": 8}
        storage.write_private_json(self.root / "account.json", account_payload)
        storage.write_private_json(cursor, cursor_payload)
        original_protect = storage.protect_file

        def revoke_after_acl(path):
            original_protect(path)
            if path == cursor:
                state = json.loads(consent_file.read_text(encoding="utf8"))
                state["enabled"] = False
                storage.write_private_json(consent_file, state)

        with mock.patch.object(keys, "private_files", return_value=storage), \
                mock.patch.object(storage, "protect_file", side_effect=revoke_after_acl):
            with self.assertRaisesRegex(RuntimeError, "wechat_consent_revoked"):
                keys.write_connection_files(file, database_root, consent_file, identifier)
        self.assertEqual(reader.private_json(self.root / "account.json"), account_payload)
        self.assertEqual(reader.private_json(cursor), cursor_payload)

    def test_posix_reader_retains_private_mode_and_symlink_rejection(self):
        if os.name == "nt":
            self.skipTest("POSIX mode semantics")
        file = self.root / "keys.json"
        storage.write_private_json(file, {"中文": "正文"})
        self.assertEqual(reader.private_json(file), {"中文": "正文"})
        file.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "private_file_required"):
            reader.private_json(file)
        alias = self.root / "alias.json"
        alias.symlink_to(file)
        with self.assertRaisesRegex(RuntimeError, "private_file_required"):
            reader.private_json(alias)

    def test_shared_reader_delegates_windows_permissions_and_reads_utf8(self):
        file = self.root / "keys.json"
        file.write_text('{"中文":"聊天"}', encoding="utf8")
        validation = mock.Mock()
        module = types.SimpleNamespace(validate_private_file=validation)
        spec = mock.Mock()
        spec.loader.exec_module.return_value = None
        with mock.patch.object(reader, "os", types.SimpleNamespace(name="nt")), \
                mock.patch.object(reader.importlib.util, "spec_from_file_location", return_value=spec), \
                mock.patch.object(reader.importlib.util, "module_from_spec", return_value=module):
            self.assertEqual(reader.private_json(file), {"中文": "聊天"})
        validation.assert_called_once_with(file)

    def test_isolated_utf8_protocol_handles_chinese_paths_without_environment_help(self):
        file = self.root / "中文账号 空格.json"
        file.write_text('{"消息":"今天的聊天"}', encoding="utf8")
        code = "import json,sys,pathlib; print(json.dumps(json.loads(pathlib.Path(sys.argv[1]).read_text()), ensure_ascii=False))"
        environment = dict(os.environ, PYTHONIOENCODING="ascii", PYTHONUTF8="0")
        output = subprocess.check_output([sys.executable, "-I", "-B", "-X", "utf8", "-c", code, str(file)], env=environment)
        self.assertEqual(json.loads(output.decode("utf8")), {"消息": "今天的聊天"})

    @unittest.skipUnless(os.name == "nt", "Real NTFS ACL acceptance requires a native Windows host")
    def test_native_windows_user_acl_utf8_and_inherited_cursor(self):
        file = self.root / "普通用户 私密目录" / "keys.json"
        storage.write_private_json(file, {"keys": {"中文": "密钥"}})
        storage.validate_private_file(file)
        api = storage._windows_security()
        self.assertTrue(storage.descriptor_is_private(*api._policy_inputs(file), require_protected=True))
        self.assertEqual(reader.private_json(file), {"keys": {"中文": "密钥"}})
        cursor = file.with_name("cursor.json")
        cursor.write_text("{}", encoding="utf8")
        storage.validate_private_file(cursor)


if __name__ == "__main__":
    unittest.main()
