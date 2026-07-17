#!/usr/bin/env python3
"""Quick validation for memmy-agent skills."""

import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

try:
    import yaml  # type: ignore
except ModuleNotFoundError:
    yaml = None

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_FRONTMATTER_KEYS = {
    "name",
    "description",
    "metadata",
    "always",
    "license",
    "allowed-tools",
}
ALLOWED_ROOT_ENTRIES = {"SKILL.md", "scripts", "references", "assets"}
VALID_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _extract_frontmatter(content: str) -> Tuple[Optional[str], str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, content
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return "\n".join(lines[1:index]), "\n".join(lines[index + 1 :])
    return None, content


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if value in {"true", "True"}:
        return True
    if value in {"false", "False"}:
        return False
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    if value.startswith("{") or value.startswith("["):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _parse_simple_frontmatter(frontmatter_text: str) -> Optional[Dict[str, Any]]:
    parsed: Dict[str, Any] = {}
    current_key: Optional[str] = None
    for raw_line in frontmatter_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if raw_line[:1].isspace():
            if current_key is None:
                return None
            current_value = parsed[current_key]
            parsed[current_key] = f"{current_value}\n{stripped}" if current_value else stripped
            continue
        if ":" not in stripped:
            return None
        key, value = stripped.split(":", 1)
        key = key.strip()
        if not key:
            return None
        parsed[key] = _parse_scalar(value)
        current_key = key
    return parsed


def _load_frontmatter(frontmatter_text: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if yaml is not None:
        try:
            parsed = yaml.safe_load(frontmatter_text)
        except yaml.YAMLError as exc:  # type: ignore[attr-defined]
            return None, f"Invalid YAML in frontmatter: {exc}"
        if not isinstance(parsed, dict):
            return None, "Frontmatter must be a YAML dictionary"
        return {str(key): value for key, value in parsed.items()}, None

    parsed = _parse_simple_frontmatter(frontmatter_text)
    if parsed is None:
        return None, "Invalid YAML in frontmatter: unsupported syntax without PyYAML installed"
    return parsed, None


def _normalize_metadata(value: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if value is None:
        return None, None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None, "metadata must be a YAML mapping or JSON object string"
    if not isinstance(value, dict):
        return None, "metadata must be a mapping"
    metadata = {str(key): nested for key, nested in value.items()}
    unexpected = sorted(set(metadata) - {"memmy"})
    if unexpected:
        return None, f"Unsupported metadata namespace(s): {', '.join(unexpected)}. Use metadata.memmy."
    memmy = metadata.get("memmy")
    if memmy is not None and not isinstance(memmy, dict):
        return None, "metadata.memmy must be a mapping"
    return metadata, None


def _validate_memmy_metadata(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    if not metadata or "memmy" not in metadata:
        return None
    memmy = metadata["memmy"]
    if not memmy:
        return None
    allowed = {"always", "requires"}
    unexpected = sorted(set(str(key) for key in memmy) - allowed)
    if unexpected:
        return f"Unexpected metadata.memmy key(s): {', '.join(unexpected)}"
    if "always" in memmy and not isinstance(memmy["always"], bool):
        return "metadata.memmy.always must be a boolean"
    requires = memmy.get("requires")
    if requires is None:
        return None
    if not isinstance(requires, dict):
        return "metadata.memmy.requires must be a mapping"
    unexpected_requires = sorted(set(str(key) for key in requires) - {"bins", "env"})
    if unexpected_requires:
        return f"Unexpected metadata.memmy.requires key(s): {', '.join(unexpected_requires)}"
    for key in ("bins", "env"):
        values = requires.get(key)
        if values is None:
            continue
        if not isinstance(values, list) or not all(isinstance(item, str) and item for item in values):
            return f"metadata.memmy.requires.{key} must be a list of strings"
    return None


def _validate_root(skill_path: Path) -> Optional[str]:
    for child in skill_path.iterdir():
        if child.name not in ALLOWED_ROOT_ENTRIES:
            return f"Unexpected file or directory in skill root: {child.name}"
        if child.name == "SKILL.md":
            if not child.is_file():
                return "SKILL.md must be a file"
        elif not child.is_dir():
            return f"{child.name} must be a directory"
    return None


def validate_skill(skill_path: Any) -> Tuple[bool, str]:
    root = Path(skill_path)
    if not root.exists() or not root.is_dir():
        return False, "Skill directory not found"

    root_error = _validate_root(root)
    if root_error:
        return False, root_error

    skill_md = root / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as exc:
        return False, f"Could not read SKILL.md: {exc}"

    frontmatter_text, body = _extract_frontmatter(content)
    if frontmatter_text is None:
        return False, "Invalid frontmatter format"

    frontmatter, error = _load_frontmatter(frontmatter_text)
    if error:
        return False, error
    assert frontmatter is not None

    unexpected = sorted(set(frontmatter) - ALLOWED_FRONTMATTER_KEYS)
    if unexpected:
        allowed = ", ".join(sorted(ALLOWED_FRONTMATTER_KEYS))
        return False, f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(unexpected)}. Allowed properties are: {allowed}"

    name = frontmatter.get("name")
    if not isinstance(name, str) or not name.strip():
        return False, "Missing or invalid 'name' in frontmatter"
    name = name.strip()
    if not VALID_NAME_RE.match(name):
        return False, f"Name '{name}' should be hyphen-case using lowercase letters, digits, and single hyphens"
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return False, f"Name is too long ({len(name)} characters). Maximum is {MAX_SKILL_NAME_LENGTH} characters."

    description = frontmatter.get("description")
    if not isinstance(description, str) or not description.strip():
        return False, "Missing or invalid 'description' in frontmatter"
    description = description.strip()
    if len(description) > 1024:
        return False, f"Description is too long ({len(description)} characters). Maximum is 1024 characters."
    if re.search(r"\bTODO\b|fill me in|\[TODO", description, re.IGNORECASE):
        return False, "Description contains TODO placeholder text"
    if "<" in description or ">" in description:
        return False, "Description cannot contain angle brackets (< or >)"

    if "always" in frontmatter and not isinstance(frontmatter["always"], bool):
        return False, "always must be a boolean"

    metadata, error = _normalize_metadata(frontmatter.get("metadata"))
    if error:
        return False, error
    metadata_error = _validate_memmy_metadata(metadata)
    if metadata_error:
        return False, metadata_error

    if not body.strip():
        return False, "SKILL.md body is empty"

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 quick-validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
