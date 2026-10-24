import ctypes
import errno
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat/private_storage.py"


class PrivateStorageTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("wechat_private_storage", SOURCE)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.container = self.home / self.helper._CONTAINER
        self.container.mkdir(parents=True, mode=0o700)
        self.data = self.container / "Data/Documents"
        self.data.mkdir(parents=True, mode=0o700)
        self.file = self.data / "fixture.db"
        self.file.write_bytes(b"only synthetic fixture bytes")
        self.file.chmod(0o600)
        self.group = self.home / self.helper._GROUP
        self.native_clone = self.helper._clone_file
        self.write_consent()
        patches = [
            mock.patch.object(self.helper.time, "sleep"),
            mock.patch.object(self.helper, "_real_home", return_value=self.home),
            mock.patch.object(self.helper, "_clone_file", side_effect=self.copy_fixture),
        ]
        self.clone = None
        for patch in patches:
            value = patch.start()
            self.addCleanup(patch.stop)
            if patch.attribute == "_clone_file":
                self.clone = value

    def write_consent(self, enabled=True, identifier="authorized", mode=0o600):
        consent = self.state / "consent.json"
        consent.write_text(json.dumps({"version": 1, "enabled": enabled,
                                       "consentedAt": "fixture-time", "consentId": identifier}))
        consent.chmod(mode)

    def copy_fixture(self, source, destination, root=None):
        if source.is_relative_to(self.state):
            self.assertEqual(source.parent.parent, self.state)
            self.assertTrue(source.parent.name.startswith("clone-preflight-"))
            self.assertEqual(source.read_bytes(), b"Memmy private storage clone preflight\n")
        else:
            source.relative_to(self.home)
        shutil.copyfile(source, destination)

    def create(self, **options):
        return self.helper.create_private_storage(self.state, consent_id="authorized", **options)

    def sessions(self):
        return list(self.state.glob("storage-session-*"))

    def test_clones_fixed_container_into_private_layout_and_maps_original(self):
        original = self.file.read_bytes()
        result = self.create()
        session = Path(result["sessionPath"])
        copied = Path(result["containerPath"])
        self.assertEqual(copied, Path(result["privateHome"]) / self.helper._CONTAINER)
        self.assertEqual(result["mappings"], {str(self.container): str(copied), str(self.group): result["groupPath"]})
        private_group = Path(result["groupPath"])
        self.assertEqual(private_group, Path(result["privateHome"]) / self.helper._GROUP)
        self.assertTrue(private_group.is_dir())
        self.assertEqual(list(private_group.iterdir()), [])
        self.assertFalse(self.group.exists())
        self.assertEqual((copied / "Data/Documents/fixture.db").read_bytes(), original)
        for item in (session, *session.rglob("*")):
            if item.is_dir():
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o700, item)
            elif item.is_file():
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600, item)
        (copied / "Data/Documents/fixture.db").write_bytes(b"private modification")
        self.assertEqual(self.file.read_bytes(), original)
        self.assertTrue(self.helper.cleanup(session, self.state))
        self.assertFalse(session.exists())
        self.assertFalse(self.helper.cleanup(session, self.state))

    def test_optional_fixed_group_is_cloned_when_present(self):
        self.group.mkdir(parents=True, mode=0o700)
        (self.group / "fixture.plist").write_text("synthetic group")
        result = self.create(optional_group=self.group)
        self.assertEqual(result["mappings"][str(self.group)], result["groupPath"])
        self.assertEqual((Path(result["groupPath"]) / "fixture.plist").read_text(), "synthetic group")

    def test_standard_group_application_scripts_alias_becomes_empty_private_directory(self):
        self.group.mkdir(parents=True, mode=0o700)
        alias = self.group / self.helper._GROUP_SCRIPT_ALIAS
        alias.parent.mkdir(parents=True)
        external = self.home / self.helper._GROUP_SCRIPT_ALIAS
        alias.symlink_to(os.path.relpath(external, alias.parent))
        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        result = self.create()
        placeholder = Path(result["groupPath"]) / self.helper._GROUP_SCRIPT_ALIAS
        self.assertTrue(placeholder.is_dir())
        self.assertFalse(placeholder.is_symlink())
        self.assertEqual(list(placeholder.iterdir()), [])
        self.assertEqual(stat.S_IMODE(placeholder.stat().st_mode), 0o700)
        self.assertFalse(external.exists())

    def test_group_scripts_alias_with_another_destination_is_rejected_before_copy(self):
        self.group.mkdir(parents=True, mode=0o700)
        alias = self.group / self.helper._GROUP_SCRIPT_ALIAS
        alias.parent.mkdir(parents=True)
        alias.symlink_to(os.path.relpath(self.home / "Desktop", alias.parent))
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])

    def test_source_paths_cannot_be_changed_to_other_personal_data(self):
        for argument in ("original_container", "optional_group"):
            with self.subTest(argument=argument), self.assertRaisesRegex(RuntimeError, "source_refused"):
                self.create(**{argument: self.home})
        self.assertEqual(self.sessions(), [])
        self.clone.assert_not_called()

    def test_initial_consent_must_be_enabled_private_and_have_exact_id(self):
        for enabled, identifier, mode in ((False, "authorized", 0o600), (True, "other", 0o600),
                                          (True, "authorized", 0o644)):
            with self.subTest(enabled=enabled, identifier=identifier, mode=mode):
                self.write_consent(enabled, identifier, mode)
                with self.assertRaisesRegex(RuntimeError, "^wechat_consent_required$"):
                    self.create()
                self.assertEqual(self.sessions(), [])
        self.clone.assert_not_called()

    def test_revocation_during_clone_cleans_partial_session(self):
        def revoke(source, destination, root=None):
            self.copy_fixture(source, destination)
            self.write_consent(enabled=False)
        self.clone.side_effect = revoke
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.create()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_consent_id_change_during_clone_cleans_partial_session(self):
        def replace_consent(source, destination, root=None):
            self.copy_fixture(source, destination)
            self.write_consent(identifier="new-authorization")
        self.clone.side_effect = replace_consent
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.create()
        self.assertEqual(self.sessions(), [])

    def test_clone_failure_has_no_copy_fallback_and_cleans_partial_session(self):
        self.clone.side_effect = RuntimeError("wechat_private_storage_clone_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
            self.create()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_keyboard_interrupt_cleans_partial_session(self):
        self.clone.side_effect = KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.create()
        self.assertEqual(self.sessions(), [])

    def test_internal_relative_symlink_is_retained_inside_private_container(self):
        (self.data / "internal-link").symlink_to("fixture.db")
        result = self.create()
        link = Path(result["containerPath"]) / "Data/Documents/internal-link"
        self.assertEqual(os.readlink(link), "fixture.db")
        self.assertEqual(link.read_bytes(), b"only synthetic fixture bytes")

    def test_unknown_external_or_absolute_symlink_is_rejected(self):
        link = self.data / "unexpected"
        for target in (str(self.file), "../../../../../../outside", str(self.home / "Desktop")):
            with self.subTest(target=target):
                link.symlink_to(target)
                with self.assertRaisesRegex(RuntimeError, "unsafe_path") as failure:
                    self.create()
                self.assertEqual(failure.exception.detail, {"path": str(link), "reason": "symlink"})
                link.unlink()
                self.assertEqual(self.sessions(), [])

    def test_regular_hardlinks_are_cloned_as_independent_private_files(self):
        os.link(self.file, self.data / "hardlink")
        result = self.create()
        copied = Path(result["containerPath"]) / "Data/Documents"
        for name in ("fixture.db", "hardlink"):
            item = copied / name
            self.assertNotEqual(item.stat().st_ino, self.file.stat().st_ino)
            self.assertEqual(item.stat().st_nlink, 1)
            self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600)
        (copied / "hardlink").write_bytes(b"private change")
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")
        self.assertEqual((copied / "fixture.db").read_bytes(), b"only synthetic fixture bytes")

    def test_wechat_shared_file_and_cache_modes_stay_private_in_the_copy(self):
        self.file.chmod(0o664)
        self.data.chmod(0o777)
        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        result = self.create()
        copied = Path(result["containerPath"]) / "Data/Documents"
        self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((copied / "fixture.db").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o664)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o777)

    def test_fifo_is_rejected_without_opening_it(self):
        os.mkfifo(self.data / "pipe", 0o600)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path") as failure:
            self.create()
        self.assertEqual(failure.exception.detail, {"path": str(self.data / "pipe"), "reason": "file_type"})
        self.assertEqual(self.sessions(), [])

    def test_container_manager_metadata_is_neither_opened_nor_copied(self):
        self.group.mkdir(parents=True, mode=0o700)
        nested = self.data / ".com.apple.containermanagerd.metadata.plist"
        nested.write_bytes(b"synthetic WeChat file with a similar name")
        for root in (self.container, self.group):
            for name in (".com.apple.containermanagerd.metadata.plist",
                         ".com.apple.mobile_container_manager.metadata.plist"):
                # macOS can refuse to open this record even for its owner.
                (root / name).write_bytes(b"synthetic container record")
                (root / name).chmod(0o000)
        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        result = self.create()
        for private in (Path(result["containerPath"]), Path(result["groupPath"])):
            self.assertFalse([item for item in private.iterdir() if item.name.startswith(".com.apple.")])
        self.assertEqual((Path(result["containerPath"]) / "Data/Documents" / nested.name).read_bytes(),
                         nested.read_bytes())
        cloned = [call.args[0] for call in self.clone.call_args_list]
        self.assertIn(nested, cloned)
        self.assertFalse([path for path in cloned if path.parent in (self.container, self.group)])

    def test_interrupted_listing_is_repeated_in_preflight_and_snapshot(self):
        original = os.listdir
        listed = []

        def interrupt_first_listing(path):
            listed.append(Path(path))
            if Path(path) == self.data and listed.count(self.data) % 2:
                raise InterruptedError(errno.EINTR, "approval wait interrupted")
            return original(path)

        with mock.patch.object(self.helper.os, "listdir", side_effect=interrupt_first_listing):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
            result = self.create()
        self.assertEqual(listed.count(self.data), 4)
        self.assertEqual((Path(result["containerPath"]) / "Data/Documents/fixture.db").read_bytes(),
                         b"only synthetic fixture bytes")

    def test_repeated_interruption_reports_where_and_removes_partial_snapshot(self):
        original = os.listdir

        def always_interrupted(path):
            if Path(path) == self.data:
                raise InterruptedError(errno.EINTR, "approval wait interrupted")
            return original(path)

        with mock.patch.object(self.helper.os, "listdir", side_effect=always_interrupted) as listing:
            with self.assertRaisesRegex(RuntimeError, "^wechat_data_access_interrupted$") as failure:
                self.create()
        self.assertEqual(failure.exception.detail, {"path": str(self.data), "operation": "listdir", "errno": "EINTR"})
        self.assertEqual([Path(call.args[0]) for call in listing.call_args_list].count(self.data),
                         self.helper._INTERRUPTED_ATTEMPTS)
        self.assertEqual(self.sessions(), [])

    def test_interrupted_lstat_and_readlink_are_repeated(self):
        link = self.data / "internal-link"
        link.symlink_to("fixture.db")
        originals = {"lstat": os.lstat, "readlink": os.readlink}
        interrupted = set()

        def once(name, paths):
            def call(path, *arguments, **options):
                if Path(path) in paths and (name, Path(path)) not in interrupted:
                    interrupted.add((name, Path(path)))
                    raise InterruptedError(errno.EINTR, "approval wait interrupted")
                return originals[name](path, *arguments, **options)
            return call

        with mock.patch.object(self.helper.os, "lstat", side_effect=once("lstat", (self.file, link))), \
                mock.patch.object(self.helper.os, "readlink", side_effect=once("readlink", (link,))):
            result = self.create()
        self.assertEqual(interrupted, {("lstat", self.file), ("lstat", link), ("readlink", link)})
        self.assertEqual(os.readlink(Path(result["containerPath"]) / "Data/Documents/internal-link"), "fixture.db")

    def test_other_source_errors_are_not_repeated(self):
        original = os.listdir

        def denied(path):
            if Path(path) == self.data:
                raise PermissionError(errno.EPERM, "denied")
            return original(path)

        with mock.patch.object(self.helper.os, "listdir", side_effect=denied) as listing:
            with self.assertRaises(PermissionError):
                self.create()
        self.assertEqual([Path(call.args[0]) for call in listing.call_args_list].count(self.data), 1)
        self.assertEqual(self.sessions(), [])

    def test_unsafe_state_symlink_or_permissions_are_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.helper.create_private_storage(alias, consent_id="authorized")
        self.state.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.create()
        self.clone.assert_not_called()

    def test_source_directory_symlink_is_rejected(self):
        moved = self.container.with_name("other-container")
        self.container.rename(moved)
        self.container.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.create()
        self.clone.assert_not_called()

    def test_foreign_owned_source_is_rejected(self):
        with mock.patch.object(self.helper.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
                self.create()
        self.assertEqual(self.sessions(), [])

    def test_standard_sandbox_aliases_become_empty_private_placeholders(self):
        aliases = {Path("Data") / name: self.home / name for name in self.helper._HOME_ALIASES}
        aliases.update({Path("Data/Library") / name: self.home / "Library" / name
                        for name in self.helper._LIBRARY_ALIASES})
        file_aliases = {Path("Data/Library") / name for name in self.helper._LIBRARY_FILE_ALIASES}
        aliases.update({relative: self.home / "Library" / relative.relative_to("Data/Library")
                        for relative in file_aliases})
        for relative, target in aliases.items():
            link = self.container / relative
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(os.path.relpath(target, link.parent))
        result = self.create()
        private = Path(result["containerPath"])
        for relative in aliases:
            item = private / relative
            self.assertFalse(item.is_symlink(), relative)
            if relative.name == ".CFUserTextEncoding" or relative in file_aliases:
                self.assertEqual(item.read_bytes(), b"")
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600)
            else:
                self.assertTrue(item.is_dir(), relative)
                self.assertEqual(list(item.iterdir()), [])
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o700)

    def test_standard_alias_with_wrong_destination_is_not_whitelisted(self):
        (self.container / "Data/Desktop").symlink_to("../../../../Documents")
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.create()
        self.assertEqual(self.sessions(), [])

    def test_preflight_checks_metadata_and_clones_only_inert_private_bytes(self):
        link = self.container / "Data/Library/Application Support/AddressBook"
        link.parent.mkdir(parents=True)
        link.symlink_to(os.path.relpath(self.home / "Library/Application Support/AddressBook", link.parent))
        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_called_once()
        source, destination = self.clone.call_args.args
        self.assertEqual(source.parent.parent, self.state)
        self.assertEqual(source.parent, destination.parent)
        self.assertFalse(source.parent.exists())
        self.assertEqual(self.sessions(), [])
        self.assertFalse((self.home / "Library/Application Support/AddressBook").exists())
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_preflight_skips_live_child_that_disappears_after_enumeration(self):
        disappearing = self.data / "live-cache"
        disappearing.mkdir(mode=0o700)
        original_item = self.helper._source_item

        def remove_cache(path, root, home):
            if path == disappearing:
                path.rmdir()
            return original_item(path, root, home)

        with mock.patch.object(self.helper, "_source_item", side_effect=remove_cache):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_called_once()
        self.assertEqual(self.sessions(), [])

    def test_preflight_missing_fixed_root_is_not_skipped(self):
        shutil.rmtree(self.container)
        with self.assertRaises(FileNotFoundError):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()

    def test_preflight_does_not_swallow_permission_errors_on_live_children(self):
        original_item = self.helper._source_item

        def deny(path, root, home):
            if path == self.file:
                raise PermissionError("synthetic permission denial")
            return original_item(path, root, home)

        with mock.patch.object(self.helper, "_source_item", side_effect=deny), self.assertRaises(PermissionError):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()

    def test_preflight_requires_each_fixed_source_on_the_state_volume(self):
        self.group.mkdir(parents=True, mode=0o700)
        original_directory = self.helper._directory
        for other_volume in (self.container, self.group):
            with self.subTest(source=other_volume):
                def directory(path, private=False):
                    info = original_directory(path, private=private)
                    return mock.Mock(st_dev=info.st_dev + 1) if path == other_volume else info

                with mock.patch.object(self.helper, "_directory", side_effect=directory):
                    with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
                        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()
        self.assertEqual(list(self.state.glob("clone-preflight-*")), [])

    def test_failed_inert_preflight_clone_cleans_private_fixture(self):
        self.clone.side_effect = RuntimeError("wechat_private_storage_clone_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(list(self.state.glob("clone-preflight-*")), [])
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_revocation_during_inert_preflight_clone_cleans_private_fixture(self):
        def revoke(source, destination, root=None):
            self.copy_fixture(source, destination)
            self.write_consent(enabled=False)

        self.clone.side_effect = revoke
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(list(self.state.glob("clone-preflight-*")), [])
        self.assertEqual(self.sessions(), [])

    def test_final_snapshot_source_change_is_rejected_and_partial_session_removed(self):
        writes = 0
        def change(source, destination, root=None):
            nonlocal writes
            self.copy_fixture(source, destination)
            # This synthetic new entry exercises the strict directory check.
            writes += 1
            (source.parent / ("later-cache-entry-" + str(writes))).write_bytes(b"synthetic cache write")

        self.clone.side_effect = change
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_source_changed$"):
            self.create()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_transient_change_retries_with_a_fresh_session(self):
        attempts = []
        def change_once(source, destination, root=None):
            self.copy_fixture(source, destination)
            if source == self.file:
                attempts.append(destination)
                if len(attempts) == 1:
                    (source.parent / "later-cache-entry").write_bytes(b"synthetic cache write")
        self.clone.side_effect = change_once
        storage = self.create()
        self.assertEqual(len(attempts), 2)
        self.assertFalse(attempts[0].exists())
        self.assertEqual(len(self.sessions()), 1)
        self.assertEqual((Path(storage["containerPath"]) / "Data/Documents/fixture.db").read_bytes(),
                         b"only synthetic fixture bytes")

    def test_continuous_changes_stop_after_three_attempts_with_private_diagnostics(self):
        def change(source, destination, root=None):
            self.copy_fixture(source, destination)
            raise self.helper.SourceChangedError(source, "file", ("mtime_ns",))
        self.clone.side_effect = change
        with self.assertRaises(self.helper.SourceChangedError) as caught:
            self.create()
        self.assertEqual(self.clone.call_count, 3)
        self.assertEqual(self.sessions(), [])
        self.assertEqual(caught.exception.detail["attempts"], 3)
        self.assertEqual(caught.exception.detail["fields"], "mtime_ns")
        self.assertNotIn(str(self.file), json.dumps(caught.exception.detail))
        self.assertGreaterEqual(caught.exception.detail["elapsedMs"], 0)

    def test_revocation_during_retry_wait_stops_before_another_clone(self):
        def change(source, destination, root=None):
            self.copy_fixture(source, destination)
            raise self.helper.SourceChangedError(source, "file", ("mtime_ns",))
        self.clone.side_effect = change
        def revoke_during_retry(seconds):
            if self.clone.call_count:
                self.write_consent(enabled=False)
        self.helper.time.sleep.side_effect = revoke_during_retry
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.create()
        self.assertEqual(self.clone.call_count, 1)
        self.assertEqual(self.sessions(), [])

    def test_clone_failure_is_not_retried(self):
        self.clone.side_effect = RuntimeError("wechat_private_storage_clone_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
            self.create()
        self.assertEqual(self.clone.call_count, 1)
        self.assertEqual(self.sessions(), [])

    def test_permission_failure_is_not_retried(self):
        self.clone.side_effect = PermissionError("synthetic permission denial")
        with self.assertRaises(PermissionError):
            self.create()
        self.assertEqual(self.clone.call_count, 1)
        self.assertEqual(self.sessions(), [])

    def test_cache_removed_after_enumeration_retries_instead_of_failing_permanently(self):
        cache = self.data / "Caches"
        cache.mkdir()
        entry = cache / "temporary"
        entry.write_bytes(b"synthetic cache")
        original_item = self.helper._source_item
        removed = False
        def remove_once(path, root, home):
            nonlocal removed
            if path == entry and not removed:
                removed = True
                entry.unlink()
            return original_item(path, root, home)
        with mock.patch.object(self.helper, "_source_item", side_effect=remove_once):
            storage = self.create()
        self.assertTrue(removed)
        self.assertEqual(len(self.sessions()), 1)
        self.assertFalse((Path(storage["containerPath"]) / "Data/Documents/Caches/temporary").exists())

    def test_failed_cleanup_prevents_retry(self):
        self.clone.side_effect = self.helper.SourceChangedError(self.file, "file", ("mtime_ns",))
        with mock.patch.object(self.helper.shutil, "rmtree", side_effect=OSError("fixture cleanup failed")):
            with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_cleanup_failed$"):
                self.create()
        self.assertEqual(self.clone.call_count, 1)

    def test_preflight_rejects_unknown_external_symlink_without_creating_a_session(self):
        (self.data / "external").symlink_to(self.home / "Desktop")
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])

    def test_cleanup_rejects_other_paths_symlinks_and_unmarked_sessions(self):
        unmarked = self.state / ("storage-session-" + "a" * 32)
        unmarked.mkdir(mode=0o700)
        alias = self.state / ("storage-session-" + "b" * 32)
        alias.symlink_to(self.container, target_is_directory=True)
        for candidate in (self.state, self.container, self.root, unmarked, alias):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(RuntimeError, "unsafe_path"):
                self.helper.cleanup(candidate, self.state)
        self.assertTrue(self.file.exists())

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_preflight_clone_uses_only_its_own_synthetic_fixture(self):
        with mock.patch.object(self.helper, "_clone_file", side_effect=self.native_clone) as clone:
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        source, destination = clone.call_args.args
        self.assertEqual(source.parent.parent, self.state)
        self.assertEqual(source.parent, destination.parent)
        self.assertFalse(source.parent.exists())
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clone_rejects_source_metadata_change(self):
        destination = self.state / "clone-fixture.db"
        original_fstat = self.helper.os.fstat
        observations = 0

        def changed_metadata(descriptor):
            nonlocal observations
            info = original_fstat(descriptor)
            observations += 1
            if observations == 2:
                return mock.Mock(st_size=info.st_size, st_mtime_ns=info.st_mtime_ns + 1,
                                 st_ctime_ns=info.st_ctime_ns)
            return info

        with mock.patch.object(self.helper.os, "fstat", side_effect=changed_metadata):
            with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_source_changed$"):
                self.native_clone(self.file, destination)
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clonefile_uses_copy_on_write_only_on_small_synthetic_fixture(self):
        destination = self.state / "clone-fixture.db"
        self.native_clone(self.file, destination)
        self.assertEqual(destination.read_bytes(), self.file.read_bytes())
        self.assertNotEqual(destination.stat().st_ino, self.file.stat().st_ino)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        destination.write_bytes(b"private fixture change")
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clone_accepts_owned_source_hardlinks_and_shared_modes_without_sharing_inode(self):
        self.file.chmod(0o664)
        os.link(self.file, self.data / "fixture-linked.db")
        destination = self.state / "cloned-hardlink.db"
        self.native_clone(self.file, destination)
        self.assertNotEqual(destination.stat().st_ino, self.file.stat().st_ino)
        self.assertEqual(destination.stat().st_nlink, 1)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        destination.write_bytes(b"private copy write")
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clone_reports_an_unreadable_source_with_its_path_and_errno(self):
        self.file.chmod(0o000)
        destination = self.state / "clone-fixture.db"
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$") as failure:
            self.native_clone(self.file, destination)
        self.assertEqual(failure.exception.detail, {"path": str(self.file), "operation": "open", "errno": "EACCES"})
        self.assertFalse(destination.exists())

    def interrupted_clonefile(self, failures):
        function = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).fclonefileat
        function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        function.restype = ctypes.c_int
        calls = []

        class Interrupted:
            argtypes = restype = None

            def __call__(self, *arguments):
                calls.append(arguments)
                if len(calls) <= failures:
                    ctypes.set_errno(errno.EINTR)
                    return -1
                return function(*arguments)

        return mock.Mock(fclonefileat=Interrupted()), calls

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clonefile_interruption_is_repeated(self):
        library, calls = self.interrupted_clonefile(failures=1)
        destination = self.state / "clone-fixture.db"
        with mock.patch.object(self.helper.ctypes, "CDLL", return_value=library):
            self.native_clone(self.file, destination, self.container)
        self.assertEqual(len(calls), 2)
        self.assertEqual(destination.read_bytes(), self.file.read_bytes())

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clonefile_repeated_interruption_reports_where(self):
        library, calls = self.interrupted_clonefile(failures=self.helper._INTERRUPTED_ATTEMPTS)
        destination = self.state / "clone-fixture.db"
        with mock.patch.object(self.helper.ctypes, "CDLL", return_value=library):
            with self.assertRaisesRegex(RuntimeError, "^wechat_data_access_interrupted$") as failure:
                self.native_clone(self.file, destination, self.container)
        self.assertEqual(failure.exception.detail, {"path": str(self.file), "operation": "clone", "errno": "EINTR"})
        self.assertEqual(len(calls), self.helper._INTERRUPTED_ATTEMPTS)
        self.assertFalse(destination.exists())

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clone_accepts_another_hardlink_name_only_inside_the_same_root(self):
        linked = self.data / "fixture-linked.db"
        os.link(self.file, linked)
        original = self.helper.fcntl.fcntl
        reported = [linked]

        def getpath(descriptor, command, argument):
            if command == 50:
                return os.fsencode(str(reported[0])) + b"\0"
            return original(descriptor, command, argument)

        with mock.patch.object(self.helper.fcntl, "fcntl", side_effect=getpath):
            self.native_clone(self.file, self.state / "inside.db", self.container)
            reported[0] = self.home / "elsewhere.db"
            with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_unsafe_path$") as failure:
                self.native_clone(self.file, self.state / "outside.db", self.container)
        self.assertEqual((self.state / "inside.db").read_bytes(), self.file.read_bytes())
        self.assertEqual(failure.exception.detail, {"path": str(self.file), "reason": "path"})
        self.assertFalse((self.state / "outside.db").exists())


if __name__ == "__main__":
    unittest.main()
