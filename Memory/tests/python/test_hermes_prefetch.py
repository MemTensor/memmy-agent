"""Run with Python + the Hermes plugin's declared PyYAML dependency."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memmy_provider", Path(__file__).resolve().parents[2] / "adapters/hermes/memmy_provider/__init__.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def prefetch_with(injected_context):
    def request(_self, path, body=None, **_kwargs):
        if path == "/sessions/open":
            return {"sessionId": body["sessionId"]}
        if path == "/turns/start":
            return {"turnId": "turn-1", "injectedContext": injected_context}
        raise AssertionError(f"unexpected request: {path}")

    with patch.object(provider.MemmyProvider, "_request", request):
        return provider.MemmyProvider().prefetch("what did we decide?", session_id="s1")


class PrefetchContextTests(unittest.TestCase):
    def test_returns_markdown_from_structured_context(self):
        context = {
            "markdown": "## Recalled\n- use sqlite-vec\n",
            "sections": [{"title": "Recalled", "content": "- use sqlite-vec"}],
            "tokenEstimate": 12,
        }
        self.assertEqual(prefetch_with(context), "## Recalled\n- use sqlite-vec")

    def test_empty_recall_injects_nothing(self):
        self.assertEqual(prefetch_with({"markdown": "", "sections": [], "tokenEstimate": 0}), "")

    def test_plain_string_context_is_kept(self):
        self.assertEqual(prefetch_with("## Recalled\n- plain text"), "## Recalled\n- plain text")

    def test_missing_or_malformed_context_injects_nothing(self):
        for value in (None, {}, {"markdown": None}, {"sections": []}, ["unexpected"], 7):
            with self.subTest(value=value):
                self.assertEqual(prefetch_with(value), "")


if __name__ == "__main__":
    unittest.main()
