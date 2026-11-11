"""Run with Python + the Hermes plugin's declared PyYAML dependency."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memmy_provider", Path(__file__).resolve().parents[2] / "adapters/hermes/memmy_provider/__init__.py")
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


class ConnectionTests(unittest.TestCase):
    def test_mixed_origins_and_matching_pairs(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config.yaml"
            config.write_text(json.dumps({"memmyMemory": {"storage": {"endpoint": "http://memory.test:18080", "token": "new-token"}}}))
            for old in ("http://other.test:18080", "http://memory.test:18081", "https://memory.test:18080"):
                with self.subTest(old=old), patch.dict(os.environ, {"MEMMY_CONFIG": str(config), "MEMMY_MEMORY_URL": "http://memory.test:18080", "MEMORY_SERVICE_URL": old, "MEMORY_SERVICE_TOKEN": "old-token"}, clear=True):
                    self.assertEqual(provider._connection()[1], "new-token")
                    os.environ["MEMMY_MEMORY_TOKEN"] = "explicit-token"
                    self.assertEqual(provider._connection()[1], "explicit-token")
                    del os.environ["MEMMY_MEMORY_TOKEN"]
                    del os.environ["MEMMY_MEMORY_URL"]
                    self.assertEqual(provider._connection(), (old, "old-token"))

    def test_unpaired_token_and_file_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config.yaml"
            def write(token):
                config.write_text(json.dumps({"memmyMemory": {"storage": {"endpoint": "https://MEMORY.test:443/base", "token": token}}}))
            with patch.dict(os.environ, {"MEMMY_CONFIG": str(config), "MEMMY_MEMORY_URL": "https://memory.test/"}, clear=True):
                for token in ("", "initialized", "rotated"):
                    write(token)
                    self.assertEqual(provider._connection()[1], token)
                os.environ["MEMORY_SERVICE_TOKEN"] = "file-origin-token"
                self.assertEqual(provider._connection()[1], "file-origin-token")
                os.environ["MEMMY_MEMORY_URL"] = "https://other.test"
                self.assertEqual(provider._connection()[1], "")

    def test_invalid_and_equivalent_origins(self):
        for endpoint in ("https://MEMORY.test:443/", "https://memory.test/path"):
            self.assertTrue(provider._same_http_origin(endpoint, "https://memory.test"))
        for endpoint in ("https://memory.test:0", "https://memory.test:wrong", "ftp://memory.test", "garbage"):
            self.assertFalse(provider._same_http_origin(endpoint, "https://memory.test"))


if __name__ == "__main__":
    unittest.main()
