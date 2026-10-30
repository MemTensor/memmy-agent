"""Offline upstream format check. Never creates a desktop executor or admits execution."""
import importlib
import importlib.metadata
import json
import socket
import sys
from pathlib import Path
from unittest.mock import patch

assert importlib.metadata.version("openadapt-flow") == "1.35.1"
source = Path(sys.argv[1])
destination = Path(sys.argv[2])
manifest = json.loads((source / "memmy-export-manifest.json").read_text())
assert manifest["complete"] and manifest["executionAdmission"] == "not_admitted"
assert manifest["replayable"] is False
compiler = importlib.import_module("openadapt_flow.compiler.compile")
events = compiler._load_events(source)
macos = manifest.get("platform") == "macos"
assert len(events) == (3 if macos else 1) and events[0]["kind"] == "click"
assert (events[0]["x"], events[0]["y"]) == ((20, 40) if macos else (10, 20))
if macos:
    assert events[1]["kind"] == "hotkey" and events[1]["modifiers"] == ["cmd", "shift"]
    assert events[2]["kind"] == "scroll" and (events[2]["dx"], events[2]["dy"]) == (0, -24)
    assert manifest["clock"]["kind"] == "mach_host" and manifest["qpc"] is None
with patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden in compatibility check")), patch.object(compiler, "ocr", return_value=[]):
    workflow = compiler.compile_recording(source, destination, name="Memmy controlled export fixture", annotate=False, mine_effects=False, admit_api_bindings=False)
assert len(workflow.steps) == (3 if macos else 1)
assert (destination / "workflow.json").is_file()
assert (destination / "workflow.py").is_file()
print("OpenAdapt Flow 1.35.1 loaded and compiled the controlled fixture offline; execution remains not admitted.")
