"""Run with Python; no Hermes install or network access is needed."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memmy_provider", Path(__file__).resolve().parents[2] / "adapters/hermes/memmy_provider/__init__.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)

EPISODE = {"id": "episode_1", "memoryLayer": "Episode", "timeline": {"episodeId": "episode_1", "items": [{"id": "trace_1"}]}}


class TimelineToolTests(unittest.TestCase):
    def call(self, args):
        calls = []

        def request(_self, path, body=None, *, method="POST", **_kwargs):
            calls.append((method, path))
            return EPISODE

        with patch.object(provider.MemmyProvider, "_request", request):
            result = provider.MemmyProvider().handle_tool_call("memos_timeline", args)
        return calls, json.loads(result)

    def test_reads_the_episode_through_the_memory_route(self):
        calls, result = self.call({"episodeId": "episode_1"})
        self.assertEqual(calls, [("GET", "/memory/episode_1")])
        self.assertEqual(result["timeline"]["items"], [{"id": "trace_1"}])

    def test_episode_id_is_escaped(self):
        calls, _ = self.call({"episodeId": "episode/一"})
        self.assertEqual(calls, [("GET", "/memory/episode%2F%E4%B8%80")])


if __name__ == "__main__":
    unittest.main()
