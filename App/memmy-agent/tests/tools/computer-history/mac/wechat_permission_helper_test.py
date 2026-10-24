import errno
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat"
HELPER_DIRECTORY = "connection-helper"
APP_NAME = "Memmy WeChat Reader.app"


def load_helper():
    spec = importlib.util.spec_from_file_location(
        "wechat_permission_helper", SOURCE / "permission_helper.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PermissionHelperTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.actual_probe = self.helper._probe_copy
        self.temporary = tempfile.TemporaryDirectory(prefix="wechat-permission-test-")
        self.addCleanup(self.temporary.cleanup)
        # macOS's standard /var temporary path is an OS symlink to /private/var.
        # Use its canonical spelling so path-safety cases exercise our fixtures.
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.app = self.root / "WeChat.app"
        executable = self.app / "Contents" / "MacOS" / "WeChat"
        executable.parent.mkdir(parents=True, mode=0o700)
        for directory in (self.app, self.app / "Contents", executable.parent):
            directory.chmod(0o700)
        executable.write_bytes(b"fake-original-wechat-v1")
        executable.chmod(0o700)
        self.original_executable = executable
        self.probe_source = self.root / "permission_probe.m"
        self.probe_source.write_bytes(b"fake-permission-probe-v1")
        self.probe_source.chmod(0o600)
        self.bridge_source = self.root / "private_storage_bridge.c"
        self.bridge_source.write_bytes(b"fake-private-storage-bridge-v1")
        self.bridge_source.chmod(0o600)
        self.cache = self.state / HELPER_DIRECTORY
        self.shadow = self.cache / APP_NAME
        self.source_fingerprint = mock.Mock(return_value="original-version-one")
        self.build = mock.Mock(side_effect=self.build_fake_copy)
        self.probe = mock.Mock(return_value={"ready": True, "error": None, "probePid": 1234})
        self.host_access = mock.Mock(return_value=None)
        self.patches = [
            mock.patch.object(self.helper, "_PROBE_SOURCE", self.probe_source),
            mock.patch.object(self.helper, "_BRIDGE_SOURCE", self.bridge_source),
            mock.patch.object(self.helper, "_check_host_data_access", self.host_access),
            mock.patch.object(self.helper, "_source_fingerprint", self.source_fingerprint),
            mock.patch.object(self.helper, "_build_copy", self.build),
            mock.patch.object(self.helper, "_probe_copy", self.probe),
            # These tests must never launch an application or invoke codesign.
            mock.patch.object(
                self.helper.subprocess, "run", side_effect=AssertionError("unexpected subprocess.run")
            ),
            mock.patch.object(
                self.helper.subprocess, "Popen", side_effect=AssertionError("unexpected subprocess.Popen")
            ),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    @staticmethod
    def build_fake_copy(app, destination, probe_source):
        shutil.copytree(app, destination)
        Path(destination).chmod(0o700)

    def prepare(self):
        result = self.helper.prepare_permission_helper(self.state, app=self.app)
        self.assertEqual(set(result), {"ready", "appPath", "error"})
        return result

    def assert_ready(self, result):
        self.assertTrue(result["ready"], result)
        self.assertEqual(Path(result["appPath"]), self.shadow)

    def assert_rejected_without_probe(self, result, existing_copy=False):
        self.assertFalse(result["ready"], result)
        self.assertEqual(result["error"], "wechat_permission_helper_unavailable")
        if not existing_copy:
            self.assertIsNone(result["appPath"])
        self.build.assert_not_called()
        self.probe.assert_not_called()

    def test_reuses_only_verified_unchanged_copy_but_rechecks_host_access_each_attempt(self):
        first = self.prepare()
        second = self.prepare()
        self.assert_ready(first)
        self.assert_ready(second)
        self.build.assert_called_once()
        self.assertEqual(self.probe.call_count, 1)
        self.assertEqual(self.host_access.call_count, 2)
        for call in self.probe.call_args_list:
            self.assertEqual(Path(call.args[0]), self.shadow)
            self.assertEqual(Path(call.args[1]), self.state)
        self.assertEqual(self.cache.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.original_executable.read_bytes(), b"fake-original-wechat-v1")

    def test_failed_probe_is_never_cached_and_the_next_explicit_check_can_retry(self):
        self.probe.return_value = {"ready": False, "error": "wechat_copy_permission_probe_failed"}
        self.assertFalse(self.prepare()["ready"])
        manifest = json.loads((self.cache / "manifest.json").read_text())
        self.assertIsNot(manifest.get("probeVerified"), True)
        self.probe.return_value = {"ready": True, "error": None, "probePid": 1234}
        self.assert_ready(self.prepare())
        self.assert_ready(self.prepare())
        self.assertEqual(self.probe.call_count, 2)
        self.assertEqual(self.host_access.call_count, 3)

    def test_revoked_host_access_overrides_previously_verified_copy_without_restarting_probe(self):
        self.assert_ready(self.prepare())
        self.host_access.side_effect = RuntimeError("wechat_data_access_required")
        result = self.prepare()
        self.assertFalse(result["ready"])
        self.assertEqual(result["error"], "wechat_data_access_required")
        self.assertEqual(self.probe.call_count, 1)
        self.assertEqual(self.build.call_count, 1)

    def test_changed_system_environment_invalidates_cached_probe(self):
        self.assert_ready(self.prepare())
        with mock.patch.object(self.helper.platform, "mac_ver", return_value=("999.0", ("", "", ""), "arm64")):
            self.assert_ready(self.prepare())
        self.assertEqual(self.probe.call_count, 2)
        self.assertEqual(self.build.call_count, 2)

    def test_copy_change_during_probe_is_not_marked_verified(self):
        def changed_during_probe(*arguments):
            (self.shadow / "Contents/MacOS/WeChat").write_bytes(b"unexpected-change")
            return {"ready": True, "error": None, "probePid": 1234}
        self.probe.side_effect = changed_during_probe
        self.assertFalse(self.prepare()["ready"])
        manifest = json.loads((self.cache / "manifest.json").read_text())
        self.assertIsNot(manifest.get("probeVerified"), True)

    def test_source_update_rebuilds_and_probes_same_application_path(self):
        self.assert_ready(self.prepare())
        self.source_fingerprint.return_value = "original-version-two"
        self.original_executable.write_bytes(b"fake-original-wechat-v2")
        self.assert_ready(self.prepare())
        self.assertEqual(self.build.call_count, 2)
        self.assertEqual(self.probe.call_count, 2)
        self.assertEqual(
            (self.shadow / "Contents" / "MacOS" / "WeChat").read_bytes(),
            b"fake-original-wechat-v2",
        )

    def test_probe_source_update_rebuilds_the_helper_before_probe(self):
        self.assert_ready(self.prepare())
        self.probe_source.write_bytes(b"fake-permission-probe-v2")
        self.assert_ready(self.prepare())
        self.assertEqual(self.build.call_count, 2)
        self.assertEqual(self.probe.call_count, 2)

    def test_copy_content_change_rebuilds_before_probe(self):
        self.assert_ready(self.prepare())
        (self.shadow / "Contents" / "MacOS" / "WeChat").write_bytes(b"unexpected-copy-change")
        self.assert_ready(self.prepare())
        self.assertEqual(self.build.call_count, 2)
        self.assertEqual(self.probe.call_count, 2)
        self.assertEqual(
            (self.shadow / "Contents" / "MacOS" / "WeChat").read_bytes(),
            b"fake-original-wechat-v1",
        )

    def test_missing_host_access_stops_before_copy_or_private_storage_probe(self):
        self.host_access.side_effect = RuntimeError("wechat_data_access_required")
        result = self.prepare()
        self.assertFalse(result["ready"])
        self.assertEqual(result["error"], "wechat_data_access_required")
        self.assertIsNone(result["appPath"])
        self.build.assert_not_called()
        self.probe.assert_not_called()
        self.assertEqual(self.original_executable.read_bytes(), b"fake-original-wechat-v1")

    def test_missing_host_data_is_distinct_from_permission_denial(self):
        self.host_access.side_effect = RuntimeError("wechat_data_access_unavailable")
        result = self.prepare()
        self.assertFalse(result["ready"])
        self.assertEqual(result["error"], "wechat_data_access_unavailable")
        self.assertIsNone(result["appPath"])
        self.build.assert_not_called()
        self.probe.assert_not_called()

    def test_unapproved_host_access_keeps_its_own_category(self):
        self.host_access.side_effect = RuntimeError("wechat_data_access_interrupted")
        result = self.prepare()
        self.assertFalse(result["ready"])
        self.assertEqual(result["error"], "wechat_data_access_interrupted")
        self.build.assert_not_called()
        self.probe.assert_not_called()

    def test_state_symlink_is_rejected_before_build_or_probe(self):
        actual_state = self.root / "actual-state"
        self.state.rename(actual_state)
        self.state.symlink_to(actual_state, target_is_directory=True)
        self.assert_rejected_without_probe(self.prepare())

    def test_nonprivate_state_directory_is_rejected(self):
        self.state.chmod(0o755)
        self.assert_rejected_without_probe(self.prepare())

    def test_foreign_owned_state_directory_is_rejected(self):
        foreign_uid = os.getuid() + 1
        with mock.patch.object(self.helper.os, "getuid", return_value=foreign_uid):
            with mock.patch.object(self.helper.os, "geteuid", return_value=foreign_uid):
                self.assert_rejected_without_probe(self.prepare())

    def test_cache_symlink_is_rejected_before_build_or_probe(self):
        external = self.root / "external-cache"
        external.mkdir(mode=0o700)
        self.cache.symlink_to(external, target_is_directory=True)
        self.assert_rejected_without_probe(self.prepare())

    def test_nonprivate_cache_directory_is_rejected(self):
        self.cache.mkdir(mode=0o755)
        self.assert_rejected_without_probe(self.prepare())

    def test_shadow_application_symlink_is_rejected_before_probe(self):
        self.cache.mkdir(mode=0o700)
        self.shadow.symlink_to(self.app, target_is_directory=True)
        self.assert_rejected_without_probe(self.prepare())

    def test_manifest_symlink_is_rejected_without_changing_target(self):
        self.assert_ready(self.prepare())
        manifest = self.cache / "manifest.json"
        external = self.root / "external-manifest.json"
        manifest.rename(external)
        original = external.read_bytes()
        manifest.symlink_to(external)
        self.build.reset_mock()
        self.probe.reset_mock()
        self.assert_rejected_without_probe(self.prepare(), existing_copy=True)
        self.assertEqual(external.read_bytes(), original)

    def test_lock_symlink_is_rejected_without_changing_target(self):
        self.cache.mkdir(mode=0o700)
        external = self.root / "external-lock"
        external.write_bytes(b"external-lock-must-stay-untouched")
        external.chmod(0o600)
        lock = self.cache / "permission-helper.lock"
        lock.symlink_to(external)
        self.assert_rejected_without_probe(self.prepare())
        self.assertEqual(external.read_bytes(), b"external-lock-must-stay-untouched")

    def test_nonprivate_lock_file_is_rejected(self):
        self.cache.mkdir(mode=0o700)
        lock = self.cache / "permission-helper.lock"
        lock.write_bytes(b"")
        lock.chmod(0o644)
        self.assert_rejected_without_probe(self.prepare())

    def test_nonprivate_manifest_file_is_rejected(self):
        self.assert_ready(self.prepare())
        (self.cache / "manifest.json").chmod(0o644)
        self.build.reset_mock()
        self.probe.reset_mock()
        self.assert_rejected_without_probe(self.prepare())

    def test_concurrent_preparation_returns_busy_without_probe(self):
        self.cache.mkdir(mode=0o700)
        lock_path = self.cache / "permission-helper.lock"
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.prepare()
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)
        self.assert_rejected_without_probe(result)
        self.assertEqual(result["error"], "wechat_permission_helper_unavailable")

    def test_failed_rebuild_preserves_previous_copy_and_does_not_probe_it(self):
        self.assert_ready(self.prepare())
        before = self.helper._copy_fingerprint(self.shadow)
        self.source_fingerprint.return_value = "original-version-two"
        self.build.side_effect = RuntimeError("copy_creation_failed")
        self.probe.reset_mock()
        result = self.prepare()
        self.assertFalse(result["ready"], result)
        self.assertEqual(result["error"], "wechat_permission_helper_unavailable")
        self.assertEqual(Path(result["appPath"]), self.shadow)
        self.assertEqual(self.helper._copy_fingerprint(self.shadow), before)
        self.probe.assert_not_called()

    def test_corrupt_manifest_is_rejected_or_rebuilt_before_probe(self):
        self.assert_ready(self.prepare())
        (self.cache / "manifest.json").write_text("{broken-json", encoding="utf-8")
        self.build.reset_mock()
        self.probe.reset_mock()
        result = self.prepare()
        if result["ready"]:
            self.assert_ready(result)
            self.build.assert_called_once()
            self.probe.assert_called_once()
        else:
            self.assertTrue(result.get("error"), result)
            self.probe.assert_not_called()

    def test_external_symlink_inside_copy_is_never_probed(self):
        self.assert_ready(self.prepare())
        (self.shadow / "Contents" / "outside").symlink_to(self.original_executable)
        self.build.reset_mock()
        self.probe.reset_mock()
        result = self.prepare()
        if result["ready"]:
            self.build.assert_called_once()
            self.probe.assert_called_once()
            self.assertFalse((self.shadow / "Contents" / "outside").exists())
        else:
            self.assertTrue(result.get("error"), result)
            self.probe.assert_not_called()

    def run_real_probe(self, overrides=None, timeout=False, exact_identity=False):
        self.cache.mkdir(mode=0o700, exist_ok=True)
        shutil.copytree(self.app, self.shadow)
        executable = self.shadow / "Contents" / "MacOS" / "WeChat"
        child = mock.Mock()
        child.poll.return_value = 0
        if timeout:
            child.wait.side_effect = [subprocess.TimeoutExpired("fake-probe", 25), 0]
        else:
            child.wait.return_value = 0

        def start_probe(arguments, **options):
            self.assertEqual(arguments[0:2], [sys.executable, "-B"])
            self.assertEqual(arguments[3], "--probe-process")
            self.assertEqual(Path(arguments[4]), self.shadow)
            self.assertNotIn("PYTHONPATH", options["env"])
            self.assertEqual(options["env"]["PYTHONDONTWRITEBYTECODE"], "1")
            self.assertEqual(options["stdout"], subprocess.DEVNULL)
            self.assertEqual(options["stderr"], subprocess.DEVNULL)
            output = Path(arguments[5])
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
            value = {
                "challenge": arguments[6], "phase": "finished", "executable": str(executable),
                "probePid": 1234, "ready": True, "error": None,
            }
            value.update(overrides or {})
            output.write_text(json.dumps(value), encoding="utf-8")
            return child

        def has_exact_identity(pid, candidate):
            return exact_identity and pid == 1234 and Path(candidate) == executable

        with mock.patch.object(self.helper.subprocess, "Popen", side_effect=start_probe) as launch:
            with mock.patch.object(self.helper, "_exact_probe_pid", side_effect=has_exact_identity) as identity:
                with mock.patch.object(self.helper.os, "kill") as kill:
                    result = self.actual_probe(self.shadow, self.state)
        launch.assert_called_once()
        self.assertEqual(list(self.cache.glob("permission-probe-*")), [])
        self.assertEqual(list(self.state.glob("storage-session-*")), [])
        return result, child, identity, kill

    def test_probe_accepts_finished_result_with_matching_challenge_and_executable(self):
        result, child, identity, kill = self.run_real_probe()
        self.assertEqual(result, {"ready": True, "error": None, "probePid": 1234})
        child.wait.assert_called_once_with(timeout=25)
        child.kill.assert_not_called()
        identity.assert_not_called()
        kill.assert_not_called()

    def test_probe_rejects_result_with_wrong_challenge(self):
        result, child, identity, kill = self.run_real_probe({"challenge": "another-probe"})
        self.assertEqual(result, {"ready": False, "error": "wechat_copy_permission_probe_failed"})
        child.kill.assert_not_called()
        identity.assert_not_called()
        kill.assert_not_called()

    def test_probe_rejects_result_with_wrong_executable(self):
        result, child, identity, kill = self.run_real_probe({"executable": "/unrelated/WeChat"})
        self.assertEqual(result, {"ready": False, "error": "wechat_copy_permission_probe_failed"})
        child.kill.assert_not_called()
        identity.assert_not_called()
        kill.assert_not_called()

    def test_probe_rejects_unfinished_result(self):
        result, child, identity, kill = self.run_real_probe({"phase": "started"})
        self.assertEqual(result, {"ready": False, "error": "wechat_copy_permission_probe_failed"})
        child.kill.assert_not_called()
        identity.assert_not_called()
        kill.assert_not_called()

    def test_probe_timeout_kills_only_challenge_matched_exact_application_pid(self):
        result, child, identity, kill = self.run_real_probe(timeout=True, exact_identity=True)
        self.assertEqual(result, {"ready": False, "error": "wechat_copy_permission_probe_timeout"})
        identity.assert_called_once_with(1234, self.shadow / "Contents" / "MacOS" / "WeChat")
        kill.assert_called_once_with(1234, signal.SIGKILL)
        child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_args_list, [mock.call(timeout=25), mock.call(timeout=3)])

    def test_probe_timeout_does_not_kill_pid_with_unmatched_application_identity(self):
        result, child, identity, kill = self.run_real_probe(timeout=True, exact_identity=False)
        self.assertEqual(result, {"ready": False, "error": "wechat_copy_permission_probe_timeout"})
        identity.assert_called_once_with(1234, self.shadow / "Contents" / "MacOS" / "WeChat")
        kill.assert_not_called()
        child.kill.assert_called_once_with()

    def test_probe_timeout_does_not_kill_pid_from_another_challenge(self):
        result, child, identity, kill = self.run_real_probe(
            {"challenge": "another-probe"}, timeout=True, exact_identity=True
        )
        self.assertEqual(result, {"ready": False, "error": "wechat_copy_permission_probe_timeout"})
        identity.assert_called_once_with(None, self.shadow / "Contents" / "MacOS" / "WeChat")
        kill.assert_not_called()
        child.kill.assert_called_once_with()

    def test_probe_timeout_does_not_kill_pid_missing_from_result(self):
        result, child, identity, kill = self.run_real_probe(
            {"probePid": None}, timeout=True, exact_identity=True
        )
        self.assertEqual(result, {"ready": False, "error": "wechat_copy_permission_probe_timeout"})
        identity.assert_called_once_with(None, self.shadow / "Contents" / "MacOS" / "WeChat")
        kill.assert_not_called()
        child.kill.assert_called_once_with()

    def run_direct_probe(self, overrides=None, remove_error=False, child_pid=1234, running=True):
        if self.shadow.exists():
            shutil.rmtree(self.shadow)
        self.cache.mkdir(mode=0o700, exist_ok=True)
        shutil.copytree(self.app, self.shadow)
        output = self.cache / "result.json"
        challenge = "a" * 64
        executable = self.shadow / "Contents/MacOS/WeChat"
        value = {"challenge": challenge, "phase": "finished", "executable": str(executable),
                 "probePid": child_pid, "ready": True, "error": None}
        value.update(overrides or {})
        if remove_error:
            value.pop("error")
        self.helper._atomic_json(output, value)
        child = mock.Mock()
        child.pid = child_pid
        child.poll.return_value = None if running else 0
        captured = {}

        def start(arguments, **options):
            captured["argv"] = arguments
            captured["env"] = options["env"]
            captured["cwd"] = options["cwd"]
            return child

        container_environment = {
            "MEMMY_WECHAT_CONTAINER_SOURCE": "/fake-home/Library/Containers/com.tencent.xinWeChat",
            "MEMMY_WECHAT_CONTAINER_COPY": str(self.state / "private-container"),
            "MEMMY_WECHAT_GROUP_SOURCE": "/fake-home/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat",
            "MEMMY_WECHAT_GROUP_COPY": str(self.state / "private-group"),
        }
        with mock.patch.object(self.helper.subprocess, "Popen", side_effect=start) as launch, \
                mock.patch.dict(self.helper.os.environ, {**container_environment, "DYLD_LIBRARY_PATH": "/ambient"}), \
                mock.patch.object(self.helper.time, "monotonic", side_effect=[100, 101, 121]), \
                mock.patch.object(self.helper.time, "sleep") as sleep:
            code = self.helper._run_probe(self.shadow, output, challenge)
        launch.assert_called_once()
        return code, sleep, captured, child, container_environment

    def test_direct_probe_accepts_finished_result_and_injects_only_private_mappings(self):
        # The probe constructor _exits before WeChat's entry point, so by the time
        # its result is read the launched copy has already stopped.
        code, sleep, captured, child, container = self.run_direct_probe(running=False)
        self.assertEqual(code, 0)
        sleep.assert_not_called()
        child.kill.assert_not_called()
        probe = self.shadow / "Contents/Frameworks" / self.helper._PROBE_NAME
        bridge = probe.with_name(self.helper._BRIDGE_NAME)
        self.assertEqual(captured["argv"], [str(self.shadow / "Contents/MacOS/WeChat")])
        self.assertEqual(captured["env"]["DYLD_INSERT_LIBRARIES"], f"{bridge}:{probe}")
        self.assertEqual(captured["env"]["MEMMY_WECHAT_PERMISSION_CHALLENGE"], "a" * 64)
        self.assertNotIn("DYLD_LIBRARY_PATH", captured["env"])
        for key, value in container.items():
            self.assertEqual(captured["env"][key], value)

    def test_direct_probe_accepts_finished_private_storage_failure(self):
        code, sleep, captured, child, _ = self.run_direct_probe({
            "ready": False, "error": "wechat_private_storage_probe_failed"}, running=False)
        self.assertEqual(code, 0)  # Valid protocol completion; the outer layer keeps the failure.
        sleep.assert_not_called()

    def test_direct_probe_does_not_accept_started_result_while_still_running(self):
        code, sleep, captured, child, _ = self.run_direct_probe({"phase": "started"})
        self.assertEqual(code, 2)
        sleep.assert_called_once_with(0.025)
        child.kill.assert_called_once_with()

    def test_direct_probe_requires_complete_result_from_its_exact_process(self):
        for overrides, remove_error in (
            ({"challenge": "other"}, False), ({"executable": "/another/WeChat"}, False),
            ({"probePid": 9999}, False), ({"ready": True, "error": "wechat_private_storage_probe_failed"}, False),
            ({}, True),
        ):
            with self.subTest(overrides=overrides, remove_error=remove_error):
                code, sleep, captured, child, _ = self.run_direct_probe(overrides, remove_error)
                self.assertEqual(code, 2)
                sleep.assert_called_once_with(0.025)

    def test_direct_probe_fails_when_the_copy_exits_without_a_valid_result(self):
        code, sleep, captured, child, _ = self.run_direct_probe({"phase": "started"}, running=False)
        self.assertEqual(code, 2)
        child.kill.assert_not_called()



class HostDataAccessTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        home = Path(temporary.name).resolve()
        configuration = home / "Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/net/config.ini"
        configuration.parent.mkdir(parents=True)
        configuration.write_text("synthetic")
        patch = mock.patch.object(self.helper.pwd, "getpwuid", return_value=types.SimpleNamespace(pw_dir=str(home)))
        patch.start()
        self.addCleanup(patch.stop)

    def test_interrupted_listing_is_repeated(self):
        original = Path.glob
        calls = []

        def glob(path, pattern):
            calls.append(pattern)
            if len(calls) == 1:
                raise InterruptedError(errno.EINTR, "approval wait interrupted")
            return original(path, pattern)

        with mock.patch.object(Path, "glob", glob):
            self.helper._check_host_data_access()
        self.assertEqual(calls, ["app_data/net*/config.ini"] * 2)

    def test_repeated_interruption_is_reported_as_unapproved_data_access(self):
        with mock.patch.object(Path, "glob", side_effect=InterruptedError(errno.EINTR, "approval wait interrupted")) as glob:
            with self.assertRaisesRegex(RuntimeError, "^wechat_data_access_interrupted$"):
                self.helper._check_host_data_access()
        self.assertEqual(glob.call_count, 3)

    def test_denied_access_still_asks_for_disk_access(self):
        with mock.patch.object(Path, "glob", side_effect=PermissionError(errno.EPERM, "denied")) as glob:
            with self.assertRaisesRegex(RuntimeError, "^wechat_data_access_required$"):
                self.helper._check_host_data_access()
        glob.assert_called_once()


class PackagedLibraryTests(unittest.TestCase):
    def test_uses_packaged_library_without_compiler_or_developer_tool_shims(self):
        helper = load_helper()
        with tempfile.TemporaryDirectory() as directory:
            native = Path(directory) / "native"
            native.mkdir()
            library = native / helper._PROBE_NAME
            library.write_bytes(b"inert precompiled fixture")
            destination = Path(directory) / "installed.dylib"
            with mock.patch.object(helper, "_NATIVE_DIRECTORY", native), \
                    mock.patch.object(helper, "_developer_clang", side_effect=AssertionError("compiler launched")), \
                    mock.patch.object(helper, "_run", side_effect=AssertionError("child launched")):
                helper._install_library(helper._PROBE_NAME, destination, [])
            self.assertEqual(destination.read_bytes(), library.read_bytes())

    def test_source_checkout_with_no_developer_tools_fails_without_install_dialog(self):
        helper = load_helper()
        with mock.patch.object(Path, "is_file", return_value=False), \
                mock.patch.object(Path, "glob", return_value=[]), \
                mock.patch.object(helper.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "^wechat_native_helpers_unavailable$"):
                helper._developer_clang()
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
