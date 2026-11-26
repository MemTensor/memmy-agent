"""Run with Python; no Hermes install or network access is needed."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memmy_provider", Path(__file__).resolve().parents[2] / "adapters/hermes/memmy_provider/__init__.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def recorded_paths(action):
    paths = []

    def request(_self, path, body=None, **_kwargs):
        paths.append(path)
        return {}

    with patch.object(provider.MemmyProvider, "_request", request):
        instance = provider.MemmyProvider()
        action(instance)
    return paths


class PathSegmentTests(unittest.TestCase):
    def test_turn_id_is_escaped_when_completing_a_turn(self):
        def action(instance):
            instance._session_id = "hermes:会话"
            instance._turn_id = "hermes:会话:1"
            instance.sync_turn("question", "answer")

        self.assertEqual(recorded_paths(action), ["/turns/hermes%3A%E4%BC%9A%E8%AF%9D%3A1/complete"])

    def test_session_id_is_escaped_when_closing_a_session(self):
        def action(instance):
            instance._session_id = "hermes:notes/2026 q4"
            instance.on_session_end([])

        self.assertEqual(recorded_paths(action), ["/sessions/hermes%3Anotes%2F2026%20q4/close"])

    def test_memory_id_is_escaped_in_tool_calls(self):
        for tool in ("memos_get", "memos_skill_get"):
            with self.subTest(tool=tool):
                paths = recorded_paths(lambda instance: instance.handle_tool_call(tool, {"id": "a/b?c#d 记忆"}))
                self.assertEqual(paths, ["/memory/a%2Fb%3Fc%23d%20%E8%AE%B0%E5%BF%86"])

    def test_plain_ids_are_unchanged(self):
        paths = recorded_paths(lambda instance: instance.handle_tool_call("memos_get", {"id": "trace_0123abcd-ef"}))
        self.assertEqual(paths, ["/memory/trace_0123abcd-ef"])


if __name__ == "__main__":
    unittest.main()
