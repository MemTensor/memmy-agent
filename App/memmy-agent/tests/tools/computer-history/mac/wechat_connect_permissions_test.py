"""Connection preflight and cleanup behavior; never launches any application."""
import importlib.util
import errno
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat"
SPEC = importlib.util.spec_from_file_location("wechat_connect_permissions", SOURCE / "connect.py")
connect = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(connect)


class ConnectPermissionTests(unittest.TestCase):
    def test_source_change_metadata_is_forwarded_without_changing_error_category(self):
        error = RuntimeError("wechat_private_storage_source_changed")
        error.detail = {"kind": "file", "area": "cache", "attempts": 3, "elapsedMs": 12000}
        self.assertEqual(connect.connection_error_fields(error), {
            "category": "wechat_private_storage_source_changed", "detail": error.detail})

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.state = self.directory / "state"
        self.state.mkdir(mode=0o700)
        self.app = self.directory / "Original.app"
        self.original = self.app / "Contents/MacOS/WeChat"
        self.original.parent.mkdir(parents=True)
        self.original.write_bytes(b"unchanged-original")
        self.library = self.directory / "sqlcipher.dylib"
        self.library.write_bytes(b"fake-library")
        self.root = self.directory / "account/db_storage"
        self.root.mkdir(parents=True)
        self.shadow = self.state / "connection-helper/Memmy WeChat Reader.app"
        self.executable = self.shadow / "Contents/MacOS/WeChat"
        self.executable.parent.mkdir(parents=True)
        self.executable.write_bytes(b"fake-stable-copy")
        self.order = []
        self.consent = "explicit-consent"
        self.cursor_key = "message_0.db:Msg_" + "a" * 32
        self.baseline_cursor = {self.cursor_key: 11}
        self.preparation = {"ready": True, "appPath": str(self.shadow), "error": None}
        self.events = []
        self.child = mock.Mock()
        self.child.poll.return_value = 0
        self.child.wait.return_value = 0
        self.session = self.state / ("storage-session-" + "a" * 32)
        home = self.session / "home"
        container = "Library/Containers/com.tencent.xinWeChat"
        group = "Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"
        self.storage = {
            "sessionPath": str(self.session), "privateHome": str(home),
            "containerPath": str(home / container), "groupPath": str(home / group),
            "mappings": {str(self.directory / "home" / container): str(home / container),
                         str(self.directory / "home" / group): str(home / group)},
        }
        self.storage_module = types.SimpleNamespace(
            preflight_private_storage=mock.Mock(side_effect=lambda *args, **kwargs: self.order.append("storage_preflight")),
            create_private_storage=mock.Mock(side_effect=self.prepare_storage),
            cleanup=mock.Mock(side_effect=self.cleanup_storage),
        )
        original_resolve = Path.resolve

        def resolve(path, *arguments, **options):
            if path == Path("/Applications/WeChat.app"):
                return self.app
            return original_resolve(path, *arguments, **options)

        patches = [
            mock.patch.object(connect.platform, "system", return_value="Darwin"),
            mock.patch.object(connect.platform, "machine", return_value="arm64"),
            mock.patch.object(connect.os, "geteuid", return_value=501),
            mock.patch.object(connect.os, "umask"),
            mock.patch.object(Path, "resolve", resolve),
            mock.patch.object(connect, "wechat_application", return_value=self.app),
            mock.patch.object(connect, "consent_id", side_effect=lambda state: self.consent),
            mock.patch.object(connect, "current_database_root", return_value=self.root),
            mock.patch.object(connect, "prepare_permission_helper", side_effect=self.prepare),
            mock.patch.object(connect, "private_storage_module", return_value=self.storage_module),
            mock.patch.object(connect, "command", side_effect=self.command),
            mock.patch.object(connect, "running_wechat", return_value=False),
            mock.patch.object(connect, "temporary_copy_running", return_value=False),
            mock.patch.object(connect, "wait_for_capture", side_effect=self.complete_capture),
            mock.patch.object(connect.subprocess, "Popen", side_effect=self.spawn),
            mock.patch.object(connect.subprocess, "run", side_effect=self.run_subprocess),
            mock.patch.object(connect, "emit", side_effect=self.emit),
        ]
        self.patched = {}
        for patch in patches:
            value = patch.start()
            self.addCleanup(patch.stop)
            if isinstance(value, mock.Mock):
                self.patched[patch.attribute] = value

    def prepare(self, state, app):
        self.order.append("permission_checked")
        self.assertEqual(state, self.state)
        self.assertEqual(app, self.app)
        return dict(self.preparation)

    def emit(self, event, **fields):
        self.events.append((event, fields))
        self.order.append(event)

    def prepare_storage(self, state, *, consent_id):
        self.assertEqual(state, self.state)
        self.assertEqual(consent_id, "explicit-consent")
        self.order.append("storage_cloned")
        for path in (self.storage["containerPath"], self.storage["groupPath"]):
            Path(path).mkdir(parents=True, mode=0o700)
        return self.storage

    def cleanup_storage(self, path, state):
        self.assertEqual(Path(path), self.session)
        self.assertEqual(state, self.state)
        self.order.append("storage_cleaned")
        shutil.rmtree(self.session)
        return True

    def command(self, arguments, **options):
        if arguments[0] == "codesign":
            return "original-signature"
        if arguments[:2] == [sys.executable, str(SOURCE / "read_messages.py")]:
            return json.dumps({"databaseCount": 1, "messages": [], "nextCursor": self.baseline_cursor})
        raise AssertionError("unexpected command: " + repr(arguments))

    def spawn(self, arguments, **options):
        self.order.append("capture_spawned")
        self.assertEqual(arguments[:2], [sys.executable, str(SOURCE / "capture_keys.py")])
        self.assertEqual(arguments[arguments.index("--executable") + 1], str(self.executable))
        self.assertNotIn("PYTHONPATH", options["env"])
        self.assertFalse(any(key.startswith("DYLD_") for key in options["env"]))
        for kind, source in zip(("CONTAINER", "GROUP"), self.storage["mappings"]):
            self.assertEqual(options["env"]["MEMMY_WECHAT_" + kind + "_SOURCE"], source)
            self.assertEqual(options["env"]["MEMMY_WECHAT_" + kind + "_COPY"],
                             self.storage["mappings"][source])
        return self.child

    def run_subprocess(self, arguments, **options):
        if arguments[0] == "osascript":
            self.order.append("quit_requested")
        elif arguments == ["open", str(self.app)]:
            self.order.append("original_opened")
        else:
            raise AssertionError("unexpected subprocess: " + repr(arguments))
        return subprocess.CompletedProcess(arguments, 0, "", "")

    def complete_capture(self, child):
        self.assertIs(child, self.child)
        file = self.state / "keys.next.json"
        file.write_text("{}")
        file.chmod(0o600)
        return 0, None

    def invoke(self, *extra):
        arguments = ["connect.py", "--state", str(self.state), *extra]
        with mock.patch.object(sys, "argv", arguments):
            return connect.main()

    def assert_not_disturbed(self):
        self.patched["Popen"].assert_not_called()
        self.patched["run"].assert_not_called()
        self.storage_module.create_private_storage.assert_not_called()
        self.assertNotIn("quitting_original", self.order)
        self.assertEqual(self.original.read_bytes(), b"unchanged-original")

    def save_connection_checkpoint(self, cursor, *, root=None, consent="explicit-consent"):
        account = {"databaseRoot": str(root or self.root)}
        if consent is not None:
            account["consentId"] = consent
        connect.private_save(self.state / "account.json", account)
        connect.private_save(self.state / "cursor.json", cursor)

    def test_prepare_only_needs_no_consent_library_or_current_account(self):
        self.patched["consent_id"].side_effect = AssertionError("must not access consent")
        self.patched["current_database_root"].side_effect = AssertionError("must not choose an account")
        self.patched["prepare_permission_helper"].side_effect = lambda *args: dict(self.preparation)
        self.assertEqual(self.invoke("--prepare-only"), 0)
        self.assertEqual(self.events, [("permission_prepared", self.preparation)])
        self.patched["command"].assert_not_called()
        self.assert_not_disturbed()

    def test_prepare_only_preserves_permission_failure_without_starting_connection(self):
        self.preparation.update(ready=False, error="wechat_data_access_required")
        self.patched["prepare_permission_helper"].side_effect = lambda *args: dict(self.preparation)
        self.assertEqual(self.invoke("--prepare-only"), 0)
        self.assertEqual(self.events[-1], ("permission_prepared", self.preparation))
        self.assert_not_disturbed()

    def test_prepare_only_sanitizes_unstructured_helper_error(self):
        self.patched["prepare_permission_helper"].side_effect = RuntimeError("failure /private/sensitive")
        self.assertEqual(self.invoke("--prepare-only"), 0)
        self.assertEqual(self.events[-1], ("permission_prepared", {
            "ready": False, "appPath": None, "error": "wechat_permission_helper_unavailable"}))
        self.assert_not_disturbed()

    def test_prepare_only_passes_state_symlink_to_the_safety_check_without_resolving_it(self):
        alias = self.directory / "state-link"
        alias.symlink_to(self.state, target_is_directory=True)
        self.state = alias

        def refuse(state, app):
            self.assertEqual(state, alias)
            self.assertTrue(state.is_symlink())
            return {"ready": False, "appPath": None, "error": "wechat_permission_helper_unavailable"}

        self.patched["prepare_permission_helper"].side_effect = refuse
        self.assertEqual(self.invoke("--prepare-only"), 0)
        self.assertEqual(self.events[-1][1]["error"], "wechat_permission_helper_unavailable")
        self.assert_not_disturbed()

    def test_connect_preserves_state_symlink_for_helper_rejection_before_quit(self):
        alias = self.directory / "state-link"
        alias.symlink_to(self.state, target_is_directory=True)
        self.state = alias

        def refuse(state, app):
            self.assertEqual(state, alias)
            self.assertTrue(state.is_symlink())
            return {"ready": False, "appPath": None, "error": "wechat_permission_helper_unavailable"}

        self.patched["prepare_permission_helper"].side_effect = refuse
        with self.assertRaisesRegex(RuntimeError, "^wechat_permission_helper_unavailable$"):
            self.invoke("--library", str(self.library))
        self.assert_not_disturbed()

    def test_permission_denied_stops_before_quit_and_preserves_pending_files(self):
        self.preparation.update(ready=False, error="wechat_data_access_required")
        pending = self.state / "keys.next.json"
        pending.write_text("pending")
        with self.assertRaisesRegex(RuntimeError, "^wechat_data_access_required$"):
            self.invoke("--library", str(self.library))
        self.assertEqual(pending.read_text(), "pending")
        self.assert_not_disturbed()

    def test_probe_failure_category_survives_without_quit(self):
        self.preparation.update(ready=False, error="wechat_data_access_probe_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_data_access_probe_failed$"):
            self.invoke("--library", str(self.library))
        self.assert_not_disturbed()

    def test_revoked_consent_during_permission_check_stops_before_quit(self):
        def prepare(*arguments):
            self.consent = None
            return dict(self.preparation)
        self.patched["prepare_permission_helper"].side_effect = prepare
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.invoke("--library", str(self.library))
        self.assert_not_disturbed()

    def test_pending_connection_stops_before_quit_and_keeps_stable_copy(self):
        pending = self.state / "cursor.next.json"
        pending.write_text("pending")
        with self.assertRaisesRegex(RuntimeError, "^previous_connection_incomplete$"):
            self.invoke("--library", str(self.library))
        self.assertEqual(pending.read_text(), "pending")
        self.assertTrue(self.executable.is_file())
        self.assert_not_disturbed()

    def test_success_checks_permissions_before_quit_then_uses_stable_copy(self):
        states = iter([True, False, False, False])

        def process_check():
            running = next(states)
            if not running:
                self.order.append("original_exit_verified")
            return running

        self.patched["running_wechat"].side_effect = process_check
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        self.assertLess(self.order.index("permission_checked"), self.order.index("quitting_original"))
        self.assertLess(self.order.index("permission_checked"), self.order.index("quit_requested"))
        self.assertLess(self.order.index("storage_preflight"), self.order.index("quit_requested"))
        copied = [index for index, event in enumerate(self.order) if event == "storage_cloned"]
        cleaned = [index for index, event in enumerate(self.order) if event == "storage_cleaned"]
        self.assertEqual(len(copied), 1)
        self.assertEqual(len(cleaned), 1)
        self.assertLess(self.order.index("quit_requested"), self.order.index("original_exit_verified"))
        self.assertLess(self.order.index("original_exit_verified"), copied[0])
        self.assertLess(copied[0], self.order.index("capture_spawned"))
        self.assertLess(self.order.index("capture_spawned"), cleaned[0])
        self.assertLess(cleaned[0], self.order.index("original_opened"))
        self.storage_module.create_private_storage.assert_called_once_with(self.state, consent_id="explicit-consent")
        self.assertEqual(self.storage_module.cleanup.call_count, 1)
        self.storage_module.preflight_private_storage.assert_called_once_with(self.state, consent_id="explicit-consent")
        self.assertFalse(self.session.exists())
        self.assertTrue(self.executable.is_file())
        self.assertTrue((self.state / "keys.json").is_file())
        self.assertTrue((self.state / "cursor.json").is_file())
        self.assertFalse((self.state / "keys.next.json").exists())
        self.assertFalse((self.state / "cursor.next.json").exists())
        self.assertIn(("connected", {"verified_message_databases": 1}), self.events)
        self.assertEqual(self.original.read_bytes(), b"unchanged-original")

    def test_first_connection_baselines_messages_that_predate_connection(self):
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        self.assertEqual(json.loads((self.state / "cursor.json").read_text()), self.baseline_cursor)
        self.assertEqual(json.loads((self.state / "account.json").read_text())["consentId"], self.consent)

    def test_same_account_reconnect_retains_unacknowledged_message_range(self):
        self.save_connection_checkpoint({self.cursor_key: 8})
        before = (self.state / "cursor.json").read_bytes()
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        # Key validation sees a database ending at 11, but rows 9-11 still need
        # to be appended by the next poll rather than discarded by reconnect.
        self.assertEqual((self.state / "cursor.json").read_bytes(), before)
        self.assertIn(("connected", {"verified_message_databases": 1}), self.events)

    def test_legacy_same_account_reconnect_retains_checkpoint(self):
        self.save_connection_checkpoint({self.cursor_key: 8}, consent=None)
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        self.assertEqual(json.loads((self.state / "cursor.json").read_text()), {self.cursor_key: 8})

    def test_reconnect_does_not_overwrite_a_poll_ack_during_key_capture(self):
        self.save_connection_checkpoint({self.cursor_key: 8})

        def complete_capture(child):
            self.complete_capture(child)
            connect.private_save(self.state / "cursor.json", {self.cursor_key: 10})
            return 0, None

        self.patched["wait_for_capture"].side_effect = complete_capture
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        self.assertEqual(json.loads((self.state / "cursor.json").read_text()), {self.cursor_key: 10})

    def test_different_account_does_not_inherit_the_old_account_checkpoint(self):
        self.save_connection_checkpoint({self.cursor_key: 8}, root=self.directory / "other/db_storage")
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        self.assertEqual(json.loads((self.state / "cursor.json").read_text()), self.baseline_cursor)

    def test_new_consent_does_not_backfill_messages_from_disabled_period(self):
        self.save_connection_checkpoint({self.cursor_key: 8}, consent="previous-consent")
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        self.assertEqual(json.loads((self.state / "cursor.json").read_text()), self.baseline_cursor)

    def test_revoked_connection_metadata_does_not_resume_leftover_cursor(self):
        connect.private_save(self.state / "cursor.json", {self.cursor_key: 8})
        self.assertEqual(self.invoke("--library", str(self.library)), 0)
        self.assertEqual(json.loads((self.state / "cursor.json").read_text()), self.baseline_cursor)

    def test_corrupt_same_account_cursor_fails_before_disturbing_wechat(self):
        self.save_connection_checkpoint({self.cursor_key: 8})
        cursor_file = self.state / "cursor.json"
        cursor_file.write_text("invalid-json")
        with self.assertRaisesRegex(RuntimeError, "^invalid_cursor$"):
            self.invoke("--library", str(self.library))
        self.assertEqual(cursor_file.read_text(), "invalid-json")
        self.assert_not_disturbed()

    def test_invalid_account_metadata_never_rebaselines_an_existing_checkpoint(self):
        for account in ([], {}, {"databaseRoot": ""}, {"databaseRoot": " "},
                        *({"databaseRoot": str(self.root), "consentId": value}
                          for value in (None, "", " ", 1))):
            with self.subTest(account=account):
                connect.private_save(self.state / "account.json", account)
                connect.private_save(self.state / "cursor.json", {self.cursor_key: 8})
                cursor_before = (self.state / "cursor.json").read_bytes()
                with self.assertRaisesRegex(RuntimeError, "^invalid_account$"):
                    self.invoke("--library", str(self.library))
                self.assertEqual((self.state / "cursor.json").read_bytes(), cursor_before)
                self.assertEqual(json.loads((self.state / "account.json").read_text()), account)
                self.assert_not_disturbed()

    def test_malformed_same_account_cursor_does_not_silently_rebaseline(self):
        for cursor in ({self.cursor_key: True}, {self.cursor_key: -1},
                       {self.cursor_key: 2 ** 53}, {"invalid-table": 8}, [8]):
            with self.subTest(cursor=cursor):
                self.save_connection_checkpoint(cursor)
                with self.assertRaisesRegex(RuntimeError, "^invalid_cursor$"):
                    self.invoke("--library", str(self.library))
                self.assertEqual(json.loads((self.state / "cursor.json").read_text()), cursor)
                self.assert_not_disturbed()

    def test_capture_failure_restores_original_and_keeps_authorized_copy(self):
        self.patched["running_wechat"].side_effect = [True, False, False, False]
        self.patched["wait_for_capture"].side_effect = None
        self.patched["wait_for_capture"].return_value = (3, None)
        pending = (self.state / "keys.next.json").with_suffix(".pending")
        pending.write_bytes(b"synthetic interrupted key output")
        pending.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, "^key_capture_no_keys$"):
            self.invoke("--library", str(self.library))
        self.assertIn("original_opened", self.order)
        final_cleanup = max(index for index, event in enumerate(self.order) if event == "storage_cleaned")
        self.assertLess(self.order.index("connection_error"), final_cleanup)
        self.assertLess(final_cleanup, self.order.index("original_opened"))
        self.assertFalse(self.session.exists())
        self.assertTrue(self.executable.is_file())
        self.assertFalse((self.state / "keys.json").exists())
        self.assertFalse(pending.exists())
        self.assertEqual(self.original.read_bytes(), b"unchanged-original")

    def test_prequit_inert_clone_failure_does_not_quit_reopen_or_start_capture(self):
        self.storage_module.preflight_private_storage.side_effect = RuntimeError("wechat_private_storage_clone_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
            self.invoke("--library", str(self.library))
        self.assert_not_disturbed()
        self.storage_module.cleanup.assert_not_called()
        self.assertFalse(self.session.exists())
        self.assertNotIn("original_opened", self.order)
        self.assertNotIn("quitting_original", self.order)

    def test_data_access_interruption_before_quit_reports_where_without_disturbing_wechat(self):
        error = RuntimeError("wechat_data_access_interrupted")
        error.detail = {"path": "/synthetic/Containers/com.tencent.xinWeChat/Data", "operation": "listdir",
                        "errno": "EINTR"}
        self.storage_module.preflight_private_storage.side_effect = error
        with mock.patch.object(sys, "argv", ["connect.py", "--state", str(self.state),
                                             "--library", str(self.library)]):
            self.assertEqual(connect.run(), 2)
        self.assertEqual(self.events[-1], ("connection_error", {
            "category": "wechat_data_access_interrupted", "detail": error.detail}))
        self.assert_not_disturbed()
        self.storage_module.preflight_private_storage.assert_called_once()
        self.storage_module.cleanup.assert_not_called()
        self.assertEqual(self.order.count("connection_error"), 1)

    def test_snapshot_clone_failure_reports_where_cleans_session_and_restores_original_once(self):
        self.patched["running_wechat"].side_effect = [True, False, False, False]
        error = RuntimeError("wechat_private_storage_clone_failed")
        error.detail = {"path": "/synthetic/Containers/com.tencent.xinWeChat/Data/Documents/a.db",
                        "operation": "open", "errno": "EPERM"}

        def fail_snapshot(state, *, consent_id):
            self.prepare_storage(state, consent_id=consent_id)
            shutil.rmtree(self.session)
            raise error

        self.storage_module.create_private_storage.side_effect = fail_snapshot
        with mock.patch.object(sys, "argv", ["connect.py", "--state", str(self.state),
                                             "--library", str(self.library)]):
            self.assertEqual(connect.run(), 2)
        expected = {"category": "wechat_private_storage_clone_failed", "detail": error.detail}
        self.assertEqual(self.events[-1], ("connection_error", expected))
        self.assertTrue(all(fields == expected for event, fields in self.events if event == "connection_error"))
        self.assertEqual(self.order.count("quit_requested"), 1)
        self.assertEqual(self.order.count("original_opened"), 1)
        self.storage_module.create_private_storage.assert_called_once()
        self.patched["Popen"].assert_not_called()
        self.assertFalse(self.session.exists())
        self.assertEqual(self.original.read_bytes(), b"unchanged-original")

    def test_connection_error_fields_keep_string_detail_and_a_safe_category(self):
        error = RuntimeError("wechat_private_storage_unsafe_path")
        error.detail = {"path": "/synthetic/Data/link", "reason": "symlink"}
        self.assertEqual(connect.connection_error_fields(error), {
            "category": "wechat_private_storage_unsafe_path", "detail": error.detail})
        for detail in ({}, [], {"path": 1}, {"errno": errno.EINTR}, "path"):
            with self.subTest(detail=detail):
                error = RuntimeError("wechat_data_access_interrupted")
                error.detail = detail
                self.assertEqual(connect.connection_error_fields(error), {
                    "category": "wechat_data_access_interrupted"})
        self.assertEqual(connect.connection_error_fields(RuntimeError("free text: /private/chat.db")), {
            "category": "connection_process_failed"})
        self.assertEqual(connect.connection_error_fields(InterruptedError(errno.EINTR, "interrupted")), {
            "category": "InterruptedError"})

    def test_final_source_change_is_rejected_after_quit_and_restores_original(self):
        self.patched["running_wechat"].side_effect = [True, False, False, False]

        def fail_snapshot(state, *, consent_id):
            self.prepare_storage(state, consent_id=consent_id)
            # The snapshot API cleans partial sessions before propagating failure.
            shutil.rmtree(self.session)
            raise RuntimeError("wechat_private_storage_source_changed")

        self.storage_module.create_private_storage.side_effect = fail_snapshot
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_source_changed$"):
            self.invoke("--library", str(self.library))
        self.storage_module.create_private_storage.assert_called_once()
        self.assertLess(self.order.index("quit_requested"), self.order.index("storage_cloned"))
        self.assertEqual(self.order.count("original_opened"), 1)
        self.assertFalse(self.session.exists())
        self.patched["Popen"].assert_not_called()
        self.assertEqual(self.original.read_bytes(), b"unchanged-original")

    def test_structural_preflight_failure_does_not_copy_or_disturb_logged_in_wechat(self):
        self.storage_module.preflight_private_storage.side_effect = RuntimeError("wechat_private_storage_unsafe_path")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_unsafe_path$"):
            self.invoke("--library", str(self.library))
        self.assert_not_disturbed()

    def test_consent_revoked_during_last_process_check_stops_before_quit(self):
        def process_check():
            self.consent = None
            return True
        self.patched["running_wechat"].side_effect = process_check
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.invoke("--library", str(self.library))
        self.patched["run"].assert_not_called()
        self.patched["Popen"].assert_not_called()
        self.assertFalse(self.session.exists())
        self.assertNotIn("quitting_original", self.order)

    def test_original_was_not_running_is_not_automatically_opened_after_failure(self):
        self.patched["wait_for_capture"].side_effect = None
        self.patched["wait_for_capture"].return_value = (3, None)
        with self.assertRaisesRegex(RuntimeError, "^key_capture_no_keys$"):
            self.invoke("--library", str(self.library))
        self.patched["run"].assert_not_called()
        self.assertNotIn("original_opened", self.order)
        self.assertNotIn("quitting_original", self.order)
        self.assertFalse(self.session.exists())

    def test_static_source_copy_failure_after_our_quit_restores_original_once(self):
        self.patched["running_wechat"].side_effect = [True, False, False, False]
        self.storage_module.create_private_storage.side_effect = RuntimeError("wechat_private_storage_clone_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
            self.invoke("--library", str(self.library))
        self.assertEqual(self.order.count("quit_requested"), 1)
        self.assertEqual(self.order.count("original_opened"), 1)
        self.storage_module.create_private_storage.assert_called_once()
        self.patched["Popen"].assert_not_called()
        self.assertFalse(self.session.exists())

    def test_cleanup_failure_still_reopens_original_before_reporting_failure(self):
        def fail_cleanup(path, state):
            self.order.append("cleanup_failed")
            raise OSError("synthetic cleanup failure")

        self.patched["running_wechat"].side_effect = [True, False, False, False]
        self.storage_module.cleanup.side_effect = fail_cleanup
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_cleanup_failed$"):
            self.invoke("--library", str(self.library))
        self.assertLess(self.order.index("cleanup_failed"), self.order.index("original_opened"))
        self.assertTrue(self.session.exists())
        self.assertEqual(self.original.read_bytes(), b"unchanged-original")

    def test_consent_revoked_during_inert_preflight_does_not_quit_original(self):
        def revoke(state, *, consent_id):
            self.consent = None
            raise RuntimeError("wechat_consent_revoked")

        self.storage_module.preflight_private_storage.side_effect = revoke
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.invoke("--library", str(self.library))
        self.assert_not_disturbed()
        self.assertFalse(self.session.exists())

    def test_live_connection_copy_retains_private_storage_and_requires_manual_restore(self):
        self.patched["temporary_copy_running"].return_value = True
        with self.assertRaisesRegex(RuntimeError, "^temporary_wechat_still_running$"):
            self.invoke("--library", str(self.library))
        self.assertEqual(self.storage_module.cleanup.call_count, 0)
        self.assertTrue(self.session.exists())
        self.assertNotIn("original_opened", self.order)
        self.assertIn(("manual_restore_required", {"reason": "temporary_wechat_still_running"}), self.events)

    def test_capture_python_receives_mappings_but_never_inherits_dyld_injection(self):
        with mock.patch.dict(connect.os.environ, {
            "DYLD_INSERT_LIBRARIES": "/unexpected/injection.dylib",
            "DYLD_LIBRARY_PATH": "/unexpected",
            "MEMMY_WECHAT_PERMISSION_PROBE": "/unexpected/result.json",
        }):
            self.assertEqual(self.invoke("--library", str(self.library)), 0)
        environment = self.patched["Popen"].call_args.kwargs["env"]
        self.assertNotIn("MEMMY_WECHAT_PERMISSION_PROBE", environment)
        self.assertIn("MEMMY_WECHAT_GROUP_SOURCE", environment)
        self.assertIn("MEMMY_WECHAT_GROUP_COPY", environment)

    def test_ambiguous_account_fails_without_quit_or_permission_helper(self):
        self.patched["current_database_root"].side_effect = RuntimeError("current_account_ambiguous")
        with self.assertRaisesRegex(RuntimeError, "^current_account_ambiguous$"):
            self.invoke("--library", str(self.library))
        self.patched["prepare_permission_helper"].assert_called_once()
        self.assert_not_disturbed()


class ReaderErrorPropagationTests(unittest.TestCase):
    def test_preserves_reader_structured_error_instead_of_generic_python_failure(self):
        failure = subprocess.CompletedProcess([], 2, "", '{"error":"readonly_query_failed"}\n')
        with mock.patch.object(connect.subprocess, "run", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "^readonly_query_failed$"):
                connect.command([sys.executable, "read_messages.py", "baseline"])

    def test_does_not_expose_unstructured_reader_stderr(self):
        for stderr in ('private account: /Users/example/account', '{"error":"private /Users/example/account"}'):
            with self.subTest(stderr=stderr), mock.patch.object(connect.subprocess, "run", return_value=
                    subprocess.CompletedProcess([], 2, "", stderr)):
                with self.assertRaisesRegex(RuntimeError, "^command_failed:python3$"):
                    connect.command([sys.executable, "read_messages.py", "baseline"])


class WeChatApplicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.app = Path(temporary.name).resolve() / "Custom Place/WeChat.app"
        (self.app / "Contents/MacOS").mkdir(parents=True)

    def test_resolves_a_non_default_install_through_launch_services(self):
        with mock.patch.object(connect.subprocess, "run",
                               return_value=subprocess.CompletedProcess([], 0, str(self.app) + "/\n", "")) as run:
            self.assertEqual(connect.wechat_application(), self.app)
        self.assertEqual(run.call_args.args[0][0], "osascript")

    def test_missing_registration_and_default_location_reports_missing(self):
        with mock.patch.object(connect.subprocess, "run",
                               return_value=subprocess.CompletedProcess([], 1, "", "not found")), \
                mock.patch.object(Path, "is_dir", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "^wechat_application_missing$"):
                connect.wechat_application()


class ActiveDatabaseRootTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        base = self.home / "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
        self.roots = [base / account / "db_storage" for account in ("account-one", "account-two")]
        for root in self.roots:
            (root / "message").mkdir(parents=True)
            (root / "message/message_0.db").write_bytes(b"synthetic-encrypted-file")
        self.original = self.home / "Applications/WeChat.app/Contents/MacOS/WeChat"
        self.original.parent.mkdir(parents=True)
        self.original.write_bytes(b"original-executable")
        self.shadow = self.home / "connection-helper/Memmy WeChat Reader.app/Contents/MacOS/WeChat"
        self.shadow.parent.mkdir(parents=True)
        self.shadow.write_bytes(b"temporary-copy")
        self.processes = f"100 {self.original}\n200 {self.shadow}\n"
        self.opened = f"p100\nn{self.roots[1]}/message/message_0.db\n"
        self.commands = []

    def run_process(self, argv, **options):
        self.commands.append(argv)
        self.assertEqual(options.get("timeout"), 5)
        if argv[0] == "pgrep":
            return subprocess.CompletedProcess(argv, 0, "100\n200\n", "")
        if argv[0] == "ps":
            return subprocess.CompletedProcess(argv, 0, self.processes, "")
        if argv[0] == "/usr/sbin/lsof":
            self.assertEqual(argv[-1], "100")
            return subprocess.CompletedProcess(argv, 0, self.opened, "")
        raise AssertionError(argv)

    def select(self):
        with mock.patch.object(Path, "home", return_value=self.home), \
                mock.patch.object(connect.subprocess, "run", side_effect=self.run_process):
            return connect.current_database_root(self.original)

    def test_selects_only_database_opened_by_original_not_temporary_copy(self):
        self.opened += f"p200\nn{self.roots[0]}/message/message_0.db\n"
        self.assertEqual(self.select(), self.roots[1])

    @unittest.skipUnless(sys.platform == "darwin", "APFS firmlink alias is macOS-specific")
    def test_data_volume_firmlink_alias_matches_original_directory_identity(self):
        alias = Path("/System/Volumes/Data" + str(self.roots[1] / "message/message_0.db"))
        if not alias.exists():
            self.skipTest("temporary directory is not on the firmlinked data volume")
        self.assertNotEqual(str(alias.resolve()), str(self.roots[1] / "message/message_0.db"))
        self.opened = f"p100\nn{alias}\n"
        self.assertEqual(self.select(), self.roots[1])

    def test_open_wal_file_is_account_evidence(self):
        wal = self.roots[0] / "message/message_0.db-wal"
        wal.write_bytes(b"synthetic-wal")
        self.opened = f"p100\nn{wal}\n"
        self.assertEqual(self.select(), self.roots[0])

    def test_two_open_accounts_remain_ambiguous(self):
        self.opened += f"n{self.roots[0]}/message/message_0.db\n"
        with self.assertRaisesRegex(RuntimeError, "^current_account_ambiguous$"):
            self.select()

    def test_non_database_files_do_not_select_an_account(self):
        note = self.roots[1] / "note.txt"
        note.write_text("synthetic-metadata")
        self.opened = f"p100\nn{note}\n"
        with self.assertRaisesRegex(RuntimeError, "^current_account_ambiguous$"):
            self.select()

    def test_temporary_copy_alone_does_not_select_an_account(self):
        self.processes = f"200 {self.shadow}\n"
        with self.assertRaisesRegex(RuntimeError, "^current_account_ambiguous$"):
            self.select()
        self.assertFalse(any(command[0] == "/usr/sbin/lsof" for command in self.commands))

    def test_lsof_timeout_does_not_guess_from_directory_times(self):
        def timeout(argv, **options):
            if argv[0] == "/usr/sbin/lsof":
                raise subprocess.TimeoutExpired(argv, 5)
            return self.run_process(argv, **options)
        with mock.patch.object(Path, "home", return_value=self.home), \
                mock.patch.object(connect.subprocess, "run", side_effect=timeout):
            with self.assertRaisesRegex(RuntimeError, "^current_account_ambiguous$"):
                connect.current_database_root(self.original)


class DatabaseRootInterruptionTests(unittest.TestCase):
    def test_interrupted_account_listing_is_repeated(self):
        root = Path("/synthetic/xwechat_files/account/db_storage")
        interrupted = InterruptedError(errno.EINTR, "approval wait interrupted")
        with mock.patch.object(connect, "_current_database_root", side_effect=[interrupted, root]) as listing:
            self.assertEqual(connect.current_database_root(), root)
        self.assertEqual(listing.call_count, 2)

    def test_repeated_interruption_is_reported_as_unapproved_data_access(self):
        interrupted = InterruptedError(errno.EINTR, "approval wait interrupted")
        with mock.patch.object(connect, "_current_database_root", side_effect=interrupted) as listing:
            with self.assertRaisesRegex(RuntimeError, "^wechat_data_access_interrupted$"):
                connect.current_database_root()
        self.assertEqual(listing.call_count, 3)

    def test_other_account_errors_are_not_repeated(self):
        with mock.patch.object(connect, "_current_database_root",
                               side_effect=RuntimeError("wechat_login_required")) as listing:
            with self.assertRaisesRegex(RuntimeError, "^wechat_login_required$"):
                connect.current_database_root()
        listing.assert_called_once()


if __name__ == "__main__":
    unittest.main()
