"""Consent-gated copy-on-write storage for a private WeChat connection session.

Only the current user's two fixed WeChat containers are accepted. Source data is
never written, decoded, or emitted. There is deliberately no bulk-copy fallback.
"""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import tempfile
import time


class SourceChangedError(RuntimeError):
    """Metadata-only diagnostics; never include account names or chat paths."""

    def __init__(self, source, kind, fields):
        super().__init__("wechat_private_storage_source_changed")
        parts = source.parts
        area = "cache" if any("cache" in part.lower() for part in parts) else (
            "database" if "db_storage" in parts else "other")
        self.detail = {"kind": kind, "area": area, "fields": ",".join(fields),
                       "pathHash": hashlib.sha256(os.fsencode(source)).hexdigest()[:16]}


def _changed_fields(before, after, fields):
    return [field for field in fields if getattr(before, "st_" + field) != getattr(after, "st_" + field)]


_CONTAINER = "Library/Containers/com.tencent.xinWeChat"
_GROUP = "Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"
_SESSION = re.compile(r"storage-session-[0-9a-f]{32}\Z")
_MARKER = ".memmy-private-storage.json"
_LIBRARY_ALIASES = (
    "Filters", "Calendars", "PDF Services", "Keychains", "ColorPickers", "KeyBindings",
    "ColorSync", "QuickLook", "Mail", "Compositions", "Favorites", "FontCollections",
    "Sounds", "Components", "Audio", "Keyboard Layouts", "Colors", "Dictionaries",
    "Fonts", "Spelling", "Input Methods", "Application Support/SyncServices",
    "Application Support/AddressBook", "Application Support/iCloud",
    "Application Scripts/com.tencent.xinWeChat", "Images/People",
)
_LIBRARY_FILE_ALIASES = ("Preferences/com.apple.security.plist", "Preferences/com.apple.security_common.plist")
_GROUP_SCRIPT_ALIAS = Path("Library/Application Scripts/5A4RE8SF68.com.tencent.xinWeChat")
_HOME_ALIASES = ("Music", "Pictures", "Desktop", "Movies", "Downloads", ".CFUserTextEncoding")
# containermanagerd's own record of a container, kept at the container root. It
# is not WeChat data, and macOS can refuse to open it (EPERM) even for its owner.
_CONTAINER_MANAGER_METADATA = (".com.apple.containermanagerd.", ".com.apple.mobile_container_manager.")
# macOS holds a process's first access to another app's container until sandboxd
# approves it. When that approval request is lost, the kernel fails the waiting
# call with EINTR after about ten seconds; calling again requests approval again.
_INTERRUPTED_ATTEMPTS = 3


class StorageError(RuntimeError):
    """A connection category, plus the source path and the check or call that failed."""

    def __init__(self, category, path, **detail):
        super().__init__(category)
        error_number = detail.pop("errno", None)
        if error_number is not None:
            detail["errno"] = errno.errorcode.get(error_number, str(error_number))
        self.detail = {"path": str(path), **detail}


def _retrying(operation, path, function, *arguments):
    for attempt in range(_INTERRUPTED_ATTEMPTS):
        try:
            return function(*arguments)
        except InterruptedError:
            if attempt + 1 == _INTERRUPTED_ATTEMPTS:
                raise StorageError("wechat_data_access_interrupted", path, operation=operation,
                                   errno=errno.EINTR) from None


def _source_lstat(path):
    return _retrying("lstat", path, os.lstat, path)


def _source_names(directory):
    return _retrying("listdir", directory, os.listdir, directory)


def _source_exists(path):
    try:
        _source_lstat(path)
    except FileNotFoundError:
        return False
    return True


def _container_manager_metadata(path, root):
    return path.parent == root and path.name.startswith(_CONTAINER_MANAGER_METADATA)


def _real_home():
    return Path(pwd.getpwuid(os.getuid()).pw_dir)


def _absolute(path):
    path = Path(path)
    if ".." in path.parts:
        raise RuntimeError("wechat_private_storage_unsafe_path")
    return Path(os.path.abspath(path))


def _ancestors(path):
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError("wechat_private_storage_unsafe_path")
        if item != path and (not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022):
            # A sticky system temporary ancestor is safe only because the
            # managed state itself must be owned, private and already present.
            if not (stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & stat.S_ISVTX):
                raise RuntimeError("wechat_private_storage_unsafe_path")
        if info.st_uid not in (0, os.getuid()):
            raise RuntimeError("wechat_private_storage_unsafe_path")


def _directory(path, private=False):
    _ancestors(path)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & (0o077 if private else 0o022)):
        raise RuntimeError("wechat_private_storage_unsafe_path")
    return info


def _source_directory(path, root):
    # The fixed container root and its ancestors remain private to the user.
    # Within it, WeChat creates ordinary caches with shared modes (even 0777).
    # Source modes do not carry into the independent private snapshot.
    path.relative_to(root)
    _directory(root)
    for item in (path, *path.parents):
        if item == root:
            break
        info = _source_lstat(item)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise StorageError("wechat_private_storage_unsafe_path", item, reason="directory")
    return _source_lstat(path)


def _read_private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise RuntimeError("wechat_private_storage_unsafe_path")
        value = os.read(descriptor, 4097)
        if len(value) > 4096:
            raise ValueError("oversized private storage metadata")
        return json.loads(value)
    finally:
        os.close(descriptor)


def _consent(state, identifier, initial=False):
    valid = False
    try:
        _directory(state, private=True)
        value = _read_private_json(state / "consent.json")
        valid = (isinstance(identifier, str) and bool(identifier) and isinstance(value, dict)
                 and value.get("version") == 1 and value.get("enabled") is True
                 and bool(value.get("consentedAt")) and value.get("consentId") == identifier)
    except (OSError, ValueError, RuntimeError):
        pass
    if not valid:
        raise RuntimeError("wechat_consent_required" if initial else "wechat_consent_revoked")


def _write_private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())


def _clone_file(source, destination, root=None):
    operation = "open"
    try:
        source_descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise SourceChangedError(source, "file", ("ino",)) from None
    except OSError as error:
        raise StorageError("wechat_private_storage_clone_failed", source, operation=operation,
                           errno=error.errno) from None
    destination_descriptor = None
    try:
        operation = "fstat"
        info = os.fstat(source_descriptor)
        operation = "lstat"
        try:
            expected = _source_lstat(source)
        except FileNotFoundError:
            raise SourceChangedError(source, "file", ("ino",)) from None
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or (info.st_dev, info.st_ino) != (expected.st_dev, expected.st_ino)):
            raise StorageError("wechat_private_storage_unsafe_path", source, reason="identity")
        # F_GETPATH is public Darwin fcntl(2). It binds the open descriptor to
        # the fixed source spelling rather than following a raced ancestor link.
        # A hard-linked file may report another of its names instead; a name
        # inside the same fixed root still proves the descriptor never left it.
        operation = "getpath"
        actual = Path(os.fsdecode(fcntl.fcntl(source_descriptor, 50, b"\0" * 1024).split(b"\0", 1)[0]))
        if actual != source:
            try:
                actual.relative_to(source.parent if root is None else root)
            except ValueError:
                raise StorageError("wechat_private_storage_unsafe_path", source, reason="path") from None
        operation = "open_destination"
        destination_descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        operation = "clone"
        function = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).fclonefileat
        function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        function.restype = ctypes.c_int
        for attempt in range(_INTERRUPTED_ATTEMPTS):
            # CLONE_NOOWNERCOPY | CLONE_NOFOLLOW_ANY; never clone source ACLs.
            if function(source_descriptor, destination_descriptor, os.fsencode(destination.name), 0x0002 | 0x0008) == 0:
                break
            error_number = ctypes.get_errno()
            if error_number != errno.EINTR or attempt + 1 == _INTERRUPTED_ATTEMPTS:
                raise OSError(error_number, os.strerror(error_number))
        operation = "verify"
        after = os.fstat(source_descriptor)
        changed = _changed_fields(info, after, ("size", "mtime_ns", "ctime_ns"))
        if changed:
            raise SourceChangedError(source, "file", changed)
        cloned = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            copied = os.fstat(cloned)
            if (not stat.S_ISREG(copied.st_mode) or copied.st_uid != os.getuid() or copied.st_nlink != 1
                    or (copied.st_dev, copied.st_ino) == (info.st_dev, info.st_ino)):
                raise StorageError("wechat_private_storage_unsafe_path", source, reason="copy")
            os.fchmod(cloned, 0o600)
        finally:
            os.close(cloned)
    except (OSError, AttributeError) as error:
        error_number = getattr(error, "errno", None)
        category = ("wechat_data_access_interrupted" if error_number == errno.EINTR
                    else "wechat_private_storage_clone_failed")
        raise StorageError(category, source, operation=operation, errno=error_number) from None
    finally:
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        os.close(source_descriptor)


def _standard_alias(relative, target, home, root=None):
    if Path(target).is_absolute():
        return False
    if root == home / _GROUP:
        return (relative == _GROUP_SCRIPT_ALIAS
                and Path(os.path.normpath(root / relative.parent / target)) == home / _GROUP_SCRIPT_ALIAS)
    aliases = {Path("Data") / name: home / name for name in _HOME_ALIASES}
    aliases.update({Path("Data/Library") / name: home / "Library" / name for name in _LIBRARY_ALIASES})
    aliases.update({Path("Data/Library") / name: home / "Library" / name for name in _LIBRARY_FILE_ALIASES})
    expected = aliases.get(relative)
    if expected is None:
        return False
    original_parent = home / _CONTAINER / relative.parent
    return Path(os.path.normpath(original_parent / target)) == expected


def _source_item(path, root, home):
    info = _source_lstat(path)
    if info.st_uid != os.getuid():
        raise StorageError("wechat_private_storage_unsafe_path", path, reason="owner")
    if stat.S_ISLNK(info.st_mode):
        target = _retrying("readlink", path, os.readlink, path)
        relative = path.relative_to(root)
        if root in (home / _CONTAINER, home / _GROUP) and _standard_alias(relative, target, home, root):
            return info, target, True
        if Path(target).is_absolute():
            raise StorageError("wechat_private_storage_unsafe_path", path, reason="symlink")
        try:
            path.resolve(strict=False).relative_to(root)
        except (ValueError, RuntimeError):
            raise StorageError("wechat_private_storage_unsafe_path", path, reason="symlink") from None
        return info, target, False
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        raise StorageError("wechat_private_storage_unsafe_path", path, reason="file_type")
    return info, None, False


def _preflight_tree(source, root, home, guard):
    guard()
    _source_directory(source, root)
    for name in _source_names(source):
        guard()
        path = source / name
        if _container_manager_metadata(path, root):
            continue
        try:
            info, _, _ = _source_item(path, root, home)
            if stat.S_ISDIR(info.st_mode):
                _preflight_tree(path, root, home, guard)
        except FileNotFoundError:
            # WeChat may remove a live cache entry after enumeration. The
            # fixed roots are checked again below; final cloning is strict.
            continue
    guard()


def _preflight_clone(state, roots, guard):
    device = _directory(state, private=True).st_dev
    for root in roots:
        if _directory(root).st_dev != device:
            raise StorageError("wechat_private_storage_clone_failed", root, reason="volume")
    # Prove copy-on-write support using our own inert bytes on the same volume.
    # Never clone changing chat data or create a file in the source containers.
    with tempfile.TemporaryDirectory(prefix="clone-preflight-", dir=state) as temporary:
        directory = Path(temporary)
        source = directory / "source"
        descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(b"Memmy private storage clone preflight\n")
        guard()
        _clone_file(source, directory / "copy")
        guard()


def preflight_private_storage(state, consent_id):
    """Check paths and inert clone support before normally quitting WeChat."""
    state = _absolute(state)
    home = _absolute(_real_home())
    _directory(state, private=True)
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise RuntimeError("root_execution_refused")
    _consent(state, consent_id, initial=True)
    guard = lambda: _consent(state, consent_id)
    container = home / _CONTAINER
    _preflight_tree(container, container, home, guard)
    roots = [container]
    group = home / _GROUP
    if _source_exists(group):
        _preflight_tree(group, group, home, guard)
        roots.append(group)
    _preflight_clone(state, roots, guard)


def _clone_tree(source, destination, root, home, guard):
    guard()
    try:
        original = _source_directory(source, root)
        names = _source_names(source)
    except FileNotFoundError:
        raise SourceChangedError(source, "directory", ("ino",)) from None
    destination.mkdir(mode=0o700)
    for name in names:
        guard()
        path = source / name
        if _container_manager_metadata(path, root):
            continue
        copy = destination / name
        try:
            info, target, standard_alias = _source_item(path, root, home)
        except FileNotFoundError:
            raise SourceChangedError(path, "entry", ("ino",)) from None
        if stat.S_ISLNK(info.st_mode):
            relative = path.relative_to(root)
            if standard_alias:
                if relative == Path("Data/.CFUserTextEncoding") or relative in {
                        Path("Data/Library") / name for name in _LIBRARY_FILE_ALIASES}:
                    descriptor = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    os.close(descriptor)
                else:
                    copy.mkdir(mode=0o700)
                continue
            copy.symlink_to(target)
        elif stat.S_ISDIR(info.st_mode):
            _clone_tree(path, copy, root, home, guard)
        elif stat.S_ISREG(info.st_mode):
            _clone_file(path, copy, root)
            copied_descriptor = os.open(copy, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                copied = os.fstat(copied_descriptor)
                if (not stat.S_ISREG(copied.st_mode) or copied.st_uid != os.getuid() or copied.st_nlink != 1
                        or (copied.st_dev, copied.st_ino) == (info.st_dev, info.st_ino)):
                    raise StorageError("wechat_private_storage_unsafe_path", path, reason="copy")
                os.fchmod(copied_descriptor, 0o600)
            finally:
                os.close(copied_descriptor)
        else:
            raise StorageError("wechat_private_storage_unsafe_path", path, reason="file_type")
    try:
        after = _source_lstat(source)
    except FileNotFoundError:
        raise SourceChangedError(source, "directory", ("ino",)) from None
    changed = _changed_fields(original, after, ("dev", "ino", "mtime_ns", "ctime_ns"))
    if changed:
        raise SourceChangedError(source, "directory", changed)
    guard()


def create_private_storage(state, original_container=None, optional_group=None, consent_id=None):
    """Allow exit-time writes to settle; discard every inconsistent attempt."""
    state = _absolute(state)
    _directory(state, private=True)
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise RuntimeError("root_execution_refused")
    _consent(state, consent_id, initial=True)
    started = time.monotonic()
    for attempt in range(1, 4):
        # A vanished main process does not mean helpers have finished writing.
        # This pause is only a settling grace period, not proof of consistency:
        # all strict source checks below still apply on every attempt.
        for _ in range(4 * attempt):
            _consent(state, consent_id)
            time.sleep(0.25)
        _consent(state, consent_id)
        try:
            return _create_private_storage_once(state, original_container, optional_group, consent_id)
        except SourceChangedError as error:
            error.detail.update(attempts=attempt, elapsedMs=int((time.monotonic() - started) * 1000))
            if attempt == 3:
                raise


def _create_private_storage_once(state, original_container=None, optional_group=None, consent_id=None):
    state = _absolute(state)
    home = _absolute(_real_home())
    _directory(state, private=True)
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise RuntimeError("root_execution_refused")
    _consent(state, consent_id, initial=True)
    container = home / _CONTAINER
    group = home / _GROUP
    if original_container is not None and _absolute(original_container) != container:
        raise RuntimeError("wechat_private_storage_source_refused")
    if optional_group is not None and _absolute(optional_group) != group:
        raise RuntimeError("wechat_private_storage_source_refused")
    _directory(container)
    has_group = _source_exists(group)
    if has_group:
        _directory(group)
    try:
        state.relative_to(container)
        raise RuntimeError("wechat_private_storage_unsafe_path")
    except ValueError:
        pass
    try:
        state.relative_to(group)
        raise RuntimeError("wechat_private_storage_unsafe_path")
    except ValueError:
        pass
    session = state / ("storage-session-" + secrets.token_hex(16))
    session.mkdir(mode=0o700)
    original_session = session.lstat()
    try:
        _write_private_json(session / _MARKER, {"version": 1, "session": session.name, "state": str(state)})
        private_home = session / "home"
        for directory in (private_home, private_home / "Library", private_home / "Library/Containers",
                          private_home / "Library/Group Containers"):
            directory.mkdir(mode=0o700)
        private_container = private_home / _CONTAINER
        private_group = private_home / _GROUP
        guard = lambda: _consent(state, consent_id)
        _clone_tree(container, private_container, container, home, guard)
        mappings = {str(container): str(private_container), str(group): str(private_group)}
        if has_group:
            _clone_tree(group, private_group, group, home, guard)
        else:
            private_group.mkdir(mode=0o700)
        guard()
        return {"sessionPath": str(session), "privateHome": str(private_home),
                "containerPath": str(private_container), "groupPath": str(private_group),
                "mappings": mappings}
    except BaseException:
        # Only this freshly created inode may be removed on a partial failure.
        try:
            _directory(state, private=True)
            info = session.lstat()
            if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == (original_session.st_dev, original_session.st_ino):
                shutil.rmtree(session)
        except OSError:
            raise RuntimeError("wechat_private_storage_cleanup_failed") from None
        raise


def cleanup(path, state):
    state = _absolute(state)
    candidate = _absolute(path)
    _directory(state, private=True)
    if candidate.parent != state or not _SESSION.fullmatch(candidate.name):
        raise RuntimeError("wechat_private_storage_unsafe_path")
    if not candidate.exists() and not candidate.is_symlink():
        return False
    _directory(candidate, private=True)
    try:
        marker = _read_private_json(candidate / _MARKER)
    except (OSError, ValueError):
        raise RuntimeError("wechat_private_storage_unsafe_path") from None
    if marker != {"version": 1, "session": candidate.name, "state": str(state)}:
        raise RuntimeError("wechat_private_storage_unsafe_path")
    shutil.rmtree(candidate)
    return True
