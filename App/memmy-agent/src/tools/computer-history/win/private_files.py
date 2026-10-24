"""Private WeChat state on POSIX and per-user NTFS, without extra dependencies."""

import ctypes
import argparse
from functools import lru_cache
import json
import os
from pathlib import Path
import stat
import uuid


WINDOWS = os.name == "nt"
FILE_ALL_ACCESS = 0x1F01FF
TRUSTED_SERVICE_SIDS = {"S-1-5-18", "S-1-5-32-544"}  # SYSTEM / Administrators


def descriptor_is_private(owner, current_sid, protected, entries, require_protected=False):
    """Reject unknown ACEs and any access granted outside the user/system/admins."""
    if owner != current_sid or (require_protected and not protected) or not entries:
        return False
    current_access = 0
    for ace_type, flags, mask, sid in entries:
        if ace_type != 0 or flags & 0x08 or sid not in TRUSTED_SERVICE_SIDS | {current_sid}:
            return False
        if sid == current_sid:
            current_access |= mask
    return current_access & FILE_ALL_ACCESS == FILE_ALL_ACCESS


class _WindowsSecurity:
    def __init__(self):
        from ctypes import wintypes as w
        self.w = w
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        pointer = ctypes.c_void_p
        out = ctypes.POINTER(pointer)
        self.kernel.GetCurrentProcess.restype = w.HANDLE
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.LocalFree.argtypes = [pointer]
        self.kernel.LocalFree.restype = pointer
        self.advapi.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
        self.advapi.OpenProcessToken.restype = w.BOOL
        self.advapi.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, pointer, w.DWORD, ctypes.POINTER(w.DWORD)]
        self.advapi.GetTokenInformation.restype = w.BOOL
        self.advapi.ConvertSidToStringSidW.argtypes = [pointer, out]
        self.advapi.ConvertSidToStringSidW.restype = w.BOOL
        self.advapi.GetNamedSecurityInfoW.argtypes = [w.LPCWSTR, ctypes.c_int, w.DWORD, out, out, out, out, out]
        self.advapi.GetNamedSecurityInfoW.restype = w.DWORD
        self.advapi.GetSecurityDescriptorControl.argtypes = [pointer, ctypes.POINTER(w.WORD), ctypes.POINTER(w.DWORD)]
        self.advapi.GetSecurityDescriptorControl.restype = w.BOOL
        self.advapi.GetAce.argtypes = [pointer, w.DWORD, out]
        self.advapi.GetAce.restype = w.BOOL
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, out, ctypes.POINTER(w.DWORD)]
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL
        self.advapi.GetSecurityDescriptorDacl.argtypes = [pointer, ctypes.POINTER(w.BOOL), out, ctypes.POINTER(w.BOOL)]
        self.advapi.GetSecurityDescriptorDacl.restype = w.BOOL
        self.advapi.SetNamedSecurityInfoW.argtypes = [w.LPWSTR, ctypes.c_int, w.DWORD, pointer, pointer, pointer, pointer]
        self.advapi.SetNamedSecurityInfoW.restype = w.DWORD

    def sid_string(self, sid):
        result = ctypes.c_void_p()
        if not sid or not self.advapi.ConvertSidToStringSidW(sid, ctypes.byref(result)):
            raise RuntimeError("private_state_acl_unavailable")
        try:
            return ctypes.wstring_at(result)
        finally:
            self.kernel.LocalFree(result)

    def current_sid(self):
        token = self.w.HANDLE()
        if not self.advapi.OpenProcessToken(self.kernel.GetCurrentProcess(), 0x08, ctypes.byref(token)):
            raise RuntimeError("private_state_acl_unavailable")
        try:
            length = self.w.DWORD()
            self.advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(length))
            buffer = ctypes.create_string_buffer(length.value)
            if not self.advapi.GetTokenInformation(token, 1, buffer, length, ctypes.byref(length)):
                raise RuntimeError("private_state_acl_unavailable")
            # TOKEN_USER starts with SID_AND_ATTRIBUTES, whose first member is PSID.
            return self.sid_string(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0])
        finally:
            self.kernel.CloseHandle(token)

    def descriptor(self, path):
        owner, dacl, descriptor = (ctypes.c_void_p() for _ in range(3))
        code = self.advapi.GetNamedSecurityInfoW(str(path), 1, 0x01 | 0x04,
            ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
        if code:
            raise RuntimeError("private_state_acl_unavailable")
        try:
            control, revision = self.w.WORD(), self.w.DWORD()
            if not self.advapi.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
                raise RuntimeError("private_state_acl_unavailable")
            entries = []
            if dacl:
                # ACL: BYTE revision/reserved; WORD size/ACE count/reserved.
                count = ctypes.c_uint16.from_address(dacl.value + 4).value
                for index in range(count):
                    ace = ctypes.c_void_p()
                    if not self.advapi.GetAce(dacl, index, ctypes.byref(ace)):
                        raise RuntimeError("private_state_acl_unavailable")
                    ace_type = ctypes.c_uint8.from_address(ace.value).value
                    flags = ctypes.c_uint8.from_address(ace.value + 1).value
                    size = ctypes.c_uint16.from_address(ace.value + 2).value
                    if ace_type != 0 or size < 16:
                        entries.append((ace_type, flags, 0, "unknown"))
                        continue
                    mask = ctypes.c_uint32.from_address(ace.value + 4).value
                    entries.append((ace_type, flags, mask, self.sid_string(ace.value + 8)))
            return self.sid_string(owner), bool(control.value & 0x1000), entries
        finally:
            self.kernel.LocalFree(descriptor)

    def protect(self, path, directory):
        sid = self.current_sid()
        owner, _, _ = self.descriptor(path)
        if owner != sid:
            raise RuntimeError("private_state_owner_mismatch")
        flags = "OICI" if directory else ""
        sddl = "D:P" + "".join(f"(A;{flags};FA;;;{principal})" for principal in [sid, "SY", "BA"])
        descriptor, dacl = ctypes.c_void_p(), ctypes.c_void_p()
        if not self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise RuntimeError("private_state_acl_unavailable")
        try:
            present, defaulted = self.w.BOOL(), self.w.BOOL()
            if not self.advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)) or not present or not dacl:
                raise RuntimeError("private_state_acl_unavailable")
            # Only change an owned object's DACL. Never take ownership or elevate.
            if self.advapi.SetNamedSecurityInfoW(str(path), 1, 0x04 | 0x80000000, None, None, dacl, None):
                raise RuntimeError("private_state_acl_unavailable")
        finally:
            self.kernel.LocalFree(descriptor)
        if not descriptor_is_private(*self._policy_inputs(path), require_protected=True):
            raise RuntimeError("private_state_acl_unavailable")

    def _policy_inputs(self, path):
        owner, protected, entries = self.descriptor(path)
        return owner, self.current_sid(), protected, entries


@lru_cache(maxsize=1)
def _windows_security():
    return _WindowsSecurity()


def _plain_path(path, directory=False):
    info = path.lstat()
    if path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
        raise RuntimeError("private_file_required")
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise RuntimeError("private_file_required")
    return info


def protect_directory(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    _plain_path(directory, directory=True)
    if WINDOWS:
        _windows_security().protect(directory, directory=True)
    else:
        os.chmod(directory, 0o700)


def validate_private_file(path):
    path = Path(path)
    info = _plain_path(path)
    if WINDOWS:
        _plain_path(path.parent, directory=True)
        api = _windows_security()
        if not descriptor_is_private(*api._policy_inputs(path.parent), require_protected=True) or not descriptor_is_private(*api._policy_inputs(path)):
            raise RuntimeError("private_file_required")
    elif info.st_mode & 0o077:
        raise RuntimeError("private_file_required")


def protect_file(path):
    path = Path(path)
    _plain_path(path)
    protect_directory(path.parent)
    if WINDOWS:
        _windows_security().protect(path, directory=False)
    else:
        os.chmod(path, 0o600)
    validate_private_file(path)


def write_private_json(path, payload):
    path = Path(path)
    protect_directory(path.parent)
    if path.exists() or path.is_symlink():
        _plain_path(path)
        if WINDOWS and _windows_security().descriptor(path)[0] != _windows_security().current_sid():
            raise RuntimeError("private_state_owner_mismatch")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.pending")
    # The protected parent gives new NTFS files a private inherited DACL from creation.
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf8") as output:
            if WINDOWS:
                _windows_security().protect(temporary, directory=False)
            json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("prepare-directory", "validate-consent"))
    parser.add_argument("path", type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.mode == "prepare-directory":
            protect_directory(arguments.path)
        else:
            # Upgrade only the current user's existing consent ACL; never change its value.
            try:
                validate_private_file(arguments.path)
            except RuntimeError:
                protect_file(arguments.path)
        print('{"private":true}')
    except Exception:
        # Do not expose state paths, identity or contents in application diagnostics.
        raise SystemExit(2)
