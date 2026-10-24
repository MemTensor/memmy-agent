import contextlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat"


def load_helper(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture = load_helper("capture_keys")
connect = load_helper("connect")


class CaptureResultTests(unittest.TestCase):
    def test_native_crash_takes_priority_over_missing_output_or_old_error(self):
        self.assertEqual(
            connect.capture_failure_category(-signal.SIGBUS, False, "wechat_login_required"),
            "key_capture_crashed",
        )

    def test_helper_error_survives_the_connection_wrapper(self):
        lines = [
            json.dumps({"event": "waiting_for_login"}),
            "not a status",
            json.dumps({"event": "capture_error", "category": "wechat_consent_revoked"}),
        ]
        child = subprocess.Popen(
            [sys.executable, "-c", "import sys; print(sys.argv[1]); sys.exit(2)", "\n".join(lines)],
            stdout=subprocess.PIPE, text=True,
        )
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code, category = connect.wait_for_capture(child)
            self.assertEqual(code, 2)
            self.assertEqual(output.getvalue().splitlines(), lines)
            self.assertEqual(connect.capture_failure_category(code, False, category), "wechat_consent_revoked")
        finally:
            child.stdout.close()
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_no_verified_keys_is_distinct_from_helper_failure(self):
        self.assertEqual(connect.capture_failure_category(3, False), "key_capture_no_keys")
        self.assertEqual(connect.capture_failure_category(2, False), "key_capture_failed")
        self.assertEqual(connect.capture_failure_category(0, False), "key_capture_output_missing")
        self.assertIsNone(connect.capture_failure_category(0, True))


class SinkParsingTests(unittest.TestCase):
    def record(self, rounds, salt, password):
        import struct
        return (capture._SINK_MAGIC + struct.pack("<III", rounds, len(salt), len(password)) + salt + password)

    def test_splits_complete_records_and_keeps_a_trailing_partial(self):
        first = self.record(256000, bytes(range(16)), b"first-pass")
        second = self.record(2, bytes(range(16, 32)), b"k" * 32)
        records, remainder = capture._parse_sink(first + second)
        self.assertEqual(records, [
            (256000, bytes(range(16)), b"first-pass"),
            (2, bytes(range(16, 32)), b"k" * 32),
        ])
        self.assertEqual(remainder, b"")
        # A header or body split across reads is returned intact for the next read.
        records, remainder = capture._parse_sink(first + second[:5])
        self.assertEqual(len(records), 1)
        self.assertEqual(remainder, second[:5])

    def test_rejects_corruption_rather_than_looping(self):
        with self.assertRaisesRegex(RuntimeError, "^key_sink_corrupt$"):
            capture._parse_sink(b"XXXX" + b"\x00" * 16)


if __name__ == "__main__":
    unittest.main()
