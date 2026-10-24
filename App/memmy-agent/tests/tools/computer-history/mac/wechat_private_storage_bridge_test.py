"""Exercise the actual injected C bridge with synthetic files, never WeChat."""
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat/private_storage_bridge.c"
CONTAINER = "/Library/Containers/com.tencent.xinWeChat"
GROUP = "/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"
VARIABLES = (
    "MEMMY_WECHAT_CONTAINER_SOURCE", "MEMMY_WECHAT_CONTAINER_COPY",
    "MEMMY_WECHAT_GROUP_SOURCE", "MEMMY_WECHAT_GROUP_COPY",
    "MEMMY_WECHAT_STORAGE_BRIDGE_STATUS",
)

FIXTURE = r'''
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/clonefile.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/xattr.h>
#include <unistd.h>
extern int open_nocancel(const char *, int, ...) __asm("_open$NOCANCEL");
extern int openat_nocancel(int, const char *, int, ...) __asm("_openat$NOCANCEL");
static int failure(void) { printf("errno=%d\n", errno); return 70; }
static int read_fd(int fd) {
    if (fd < 0) return failure();
    char text[1024]; ssize_t count = read(fd, text, sizeof(text)-1); close(fd);
    if (count < 0) return failure();
    text[count] = 0; printf("%s\n", text); return 0;
}
int main(int argc, char **argv) {
    if (argc < 3) return 64;
    const char *action = argv[1], *path = argv[2], *other = argc > 3 ? argv[3] : NULL;
    if (!strcmp(action, "main")) {
        const char *status = getenv("MEMMY_WECHAT_STORAGE_BRIDGE_STATUS");
        printf("MAIN:%s\n", status ? status : "inert"); return 0;
    }
    if (!strcmp(action, "locale")) {
        // setlocale opens its locale data while holding libc's locale lock.
        // The interposed open must not call printf-family functions here.
        if (!setlocale(LC_ALL, "en_US.UTF-8")) return 71;
        if (!setlocale(LC_ALL, "zh_CN.UTF-8")) return 72;
        return read_fd(open(path, O_RDONLY));
    }
    if (!strcmp(action, "read")) return read_fd(open(path, O_RDONLY));
    if (!strcmp(action, "nocancel")) return read_fd(open_nocancel(path, O_RDONLY));
    if (!strcmp(action, "fopen") || !strcmp(action, "freopen")) {
        FILE *file = !strcmp(action, "freopen") ? freopen(path, "r", stdin) : fopen(path, "r");
        if (!file) return failure();
        char text[1024]; if (!fgets(text, sizeof(text), file)) return failure();
        fclose(file); printf("%s\n", text); return 0;
    }
    if (!strcmp(action, "openat") || !strcmp(action, "openat-nocancel")) {
        int directory = open(path, O_RDONLY | O_DIRECTORY); if (directory < 0) return failure();
        int fd = !strcmp(action, "openat") ? openat(directory, other, O_RDONLY) : openat_nocancel(directory, other, O_RDONLY);
        close(directory); return read_fd(fd);
    }
    if (!strcmp(action, "chdir")) { if (chdir(path)) return failure(); return read_fd(open(other, O_RDONLY)); }
    if (!strcmp(action, "mmap")) {
        int fd = open(path, O_RDONLY); if (fd < 0) return failure(); struct stat info;
        if (fstat(fd, &info)) return failure();
        char *data = mmap(NULL, (size_t)info.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
        if (data == MAP_FAILED) return failure();
        printf("%.*s\n", (int)info.st_size, data); munmap(data, (size_t)info.st_size); close(fd); return 0;
    }
    if (!strcmp(action, "write")) {
        int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600); if (fd < 0) return failure();
        if (write(fd, other, strlen(other)) != (ssize_t)strlen(other)) return failure(); close(fd); return 0;
    }
    if (!strcmp(action, "stat") || !strcmp(action, "lstat")) {
        struct stat info; int result = !strcmp(action, "stat") ? stat(path, &info) : lstat(path, &info);
        if (result) return failure(); printf("size=%lld\n", (long long)info.st_size); return 0;
    }
    if (!strcmp(action, "access")) { if (access(path, R_OK | W_OK)) return failure(); return 0; }
    if (!strcmp(action, "opendir")) {
        DIR *directory = opendir(path); if (!directory) return failure();
        struct dirent *entry; while ((entry = readdir(directory))) printf("%s\n", entry->d_name);
        closedir(directory); return 0;
    }
    if (!strcmp(action, "getattrlist")) {
        struct attrlist list = {0}; list.bitmapcount = ATTR_BIT_MAP_COUNT; list.commonattr = ATTR_CMN_OBJTYPE;
        uint32_t result[2]; if (getattrlist(path, &list, result, sizeof(result), 0)) return failure(); return 0;
    }
    if (!strcmp(action, "rename")) { if (rename(path, other)) return failure(); return 0; }
    if (!strcmp(action, "mkdir")) { if (mkdir(path, 0700)) return failure(); return 0; }
    if (!strcmp(action, "rmdir")) { if (rmdir(path)) return failure(); return 0; }
    if (!strcmp(action, "unlink")) { if (unlink(path)) return failure(); return 0; }
    if (!strcmp(action, "remove")) { if (remove(path)) return failure(); return 0; }
    if (!strcmp(action, "symlink")) { if (symlink(other, path)) return failure(); return 0; }
    if (!strcmp(action, "link")) { if (link(path, other)) return failure(); return 0; }
    if (!strcmp(action, "renamex")) { if (renamex_np(path, other, RENAME_EXCL)) return failure(); return 0; }
    if (!strcmp(action, "statfs")) { struct statfs info; if (statfs(path, &info)) return failure(); return 0; }
    if (!strcmp(action, "statvfs")) { struct statvfs info; if (statvfs(path, &info)) return failure(); return 0; }
    if (!strcmp(action, "at")) {
        int dir = open(path, O_RDONLY | O_DIRECTORY); if (dir < 0) return failure();
        struct stat info;
        if (fstatat(dir, "fixture.txt", &info, 0) || info.st_size != 13) return failure();
        if (faccessat(dir, "fixture.txt", R_OK, 0)) return failure();
        if (fchmodat(dir, "fixture.txt", 0600, 0)) return failure();
        struct timespec times[2] = {{0, UTIME_OMIT}, {0, UTIME_OMIT}};
        if (utimensat(dir, "fixture.txt", times, 0)) return failure();
        struct attrlist list = {0}; list.bitmapcount = ATTR_BIT_MAP_COUNT; list.commonattr = ATTR_CMN_OBJTYPE;
        uint32_t attributes[2]; if (getattrlistat(dir, "fixture.txt", &list, attributes, sizeof(attributes), 0)) return failure();
        if (mkdirat(dir, "at-directory", 0700)) return failure();
        if (symlinkat("fixture.txt", dir, "at-link")) return failure();
        char target[64]; if (readlinkat(dir, "at-link", target, sizeof(target)) != 11) return failure();
        if (linkat(dir, "fixture.txt", dir, "at-hardlink", 0)) return failure();
        if (renameat(dir, "at-hardlink", dir, "at-renamed")) return failure();
        if (renameatx_np(dir, "at-renamed", dir, "at-renamed-again", RENAME_EXCL)) return failure();
        if (clonefileat(dir, "fixture.txt", dir, "at-clone", 0)) return failure();
        if (unlinkat(dir, "at-directory", AT_REMOVEDIR)) return failure();
        if (unlinkat(dir, "at-link", 0)) return failure();
        close(dir); return 0;
    }
    if (!strcmp(action, "readlink")) {
        char result[1024]; ssize_t length = readlink(path, result, sizeof(result)-1);
        if (length < 0) return failure(); result[length] = 0; printf("%s\n", result); return 0;
    }
    if (!strcmp(action, "copyfile")) { if (copyfile(path, other, NULL, COPYFILE_DATA)) return failure(); return 0; }
    if (!strcmp(action, "clonefile")) { if (clonefile(path, other, 0)) return failure(); return 0; }
    if (!strcmp(action, "truncate")) { if (truncate(path, 2)) return failure(); return 0; }
    if (!strcmp(action, "realpath")) { char resolved[4096]; if (!realpath(path, resolved)) return failure(); printf("%s\n", resolved); return 0; }
    if (!strcmp(action, "xattr")) {
        if (setxattr(path, "com.memmy.test", "clone", 5, 0, 0)) return failure();
        char value[32]; ssize_t length = getxattr(path, "com.memmy.test", value, sizeof(value)-1, 0, 0);
        if (length < 0) return failure(); value[length] = 0; printf("%s\n", value);
        if (removexattr(path, "com.memmy.test", 0)) return failure(); return 0;
    }
    return 65;
}
'''


@unittest.skipUnless(platform.system() == "Darwin" and shutil.which("xcrun"), "macOS SDK required")
class PrivateStorageBridgeNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="wechat-storage-native-")
        cls.root = Path(cls.temporary.name).resolve()
        cls.root.chmod(0o700)
        cls.home = cls.root / "real-home"
        cls.home.mkdir(mode=0o700)
        cls.library = cls.root / "bridge.dylib"
        cls.production_library = cls.root / "production-bridge.dylib"
        cls.fixture = cls.root / "fixture"
        source = cls.root / "fixture.c"
        source.write_text(FIXTURE)
        common = ["xcrun", "clang", "-Wall", "-Wextra", "-Werror", "-O2"]
        subprocess.run(common + ["-dynamiclib", str(SOURCE), "-o", str(cls.production_library)], check=True, capture_output=True)
        subprocess.run(common + ["-dynamiclib", f'-DMEMMY_WECHAT_BRIDGE_TEST_HOME="{cls.home}"', str(SOURCE), "-o", str(cls.library)], check=True, capture_output=True)
        subprocess.run(common + [str(source), "-o", str(cls.fixture)], check=True, capture_output=True)
        for artifact in (cls.library, cls.production_library, cls.fixture):
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(artifact)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix="case-", dir=self.root))
        self.case.chmod(0o700)
        self.session = self.case / ("storage-session-" + "a" * 32)
        self.copy = Path(str(self.session / "home") + CONTAINER)
        self.group_copy = Path(str(self.session / "home") + GROUP)
        for path in (self.copy, self.group_copy):
            path.mkdir(parents=True, mode=0o700)
        for directory in self.case.rglob("*"):
            if directory.is_dir(): directory.chmod(0o700)
        self.source = Path(str(self.home) + CONTAINER)
        self.group_source = Path(str(self.home) + GROUP)
        for source in (self.source, self.group_source):
            if source.exists(): shutil.rmtree(source)
            source.mkdir(parents=True, mode=0o700)
        self.original = self.source / "fixture.txt"
        self.clone = self.copy / "fixture.txt"
        self.original.write_text("ORIGINAL_UNCHANGED")
        self.clone.write_text("PRIVATE_CLONE")
        (self.group_source / "group.txt").write_text("ORIGINAL_GROUP")
        (self.group_copy / "group.txt").write_text("PRIVATE_GROUP")
        self.env = dict(os.environ)
        for variable in VARIABLES: self.env.pop(variable, None)
        self.env.update({
            "DYLD_INSERT_LIBRARIES": str(self.library),
            "MEMMY_WECHAT_CONTAINER_SOURCE": str(self.source),
            "MEMMY_WECHAT_CONTAINER_COPY": str(self.copy),
            "MEMMY_WECHAT_GROUP_SOURCE": str(self.group_source),
            "MEMMY_WECHAT_GROUP_COPY": str(self.group_copy),
        })
        self.addCleanup(shutil.rmtree, self.case)

    def run_fixture(self, action, path=None, other=None, env=None, success=True):
        command = [str(self.fixture), action, str(path or self.original)]
        if other is not None: command.append(str(other))
        result = subprocess.run(command, env=env or self.env, text=True, capture_output=True, timeout=5)
        if success:
            self.assertEqual(result.returncode, 0, f"{action}: {result.stdout} {result.stderr}")
        return result

    def assert_original_unchanged(self):
        self.assertEqual(self.original.read_text(), "ORIGINAL_UNCHANGED")

    def test_actual_injection_reads_only_clone_through_public_apis(self):
        for action in ("read", "nocancel", "fopen", "freopen", "mmap"):
            with self.subTest(action=action):
                self.assertEqual(self.run_fixture(action).stdout.strip(), "PRIVATE_CLONE")
        self.assert_original_unchanged()

    def test_setlocale_can_open_its_data_without_recursively_locking_libc(self):
        self.assertEqual(self.run_fixture("locale").stdout.strip(), "PRIVATE_CLONE")
        self.assert_original_unchanged()

    def test_at_relative_and_chdir_paths_read_clone(self):
        for action in ("openat", "openat-nocancel", "chdir"):
            self.assertEqual(self.run_fixture(action, self.source, "fixture.txt").stdout.strip(), "PRIVATE_CLONE")

    def test_group_directory_uses_its_private_copy(self):
        self.assertEqual(self.run_fixture("read", self.group_source / "group.txt").stdout.strip(), "PRIVATE_GROUP")

    def test_metadata_directory_and_extended_attributes_use_clone(self):
        self.assertEqual(self.run_fixture("stat").stdout.strip(), "size=13")
        self.assertEqual(self.run_fixture("lstat").stdout.strip(), "size=13")
        self.run_fixture("access")
        self.run_fixture("getattrlist")
        self.run_fixture("statfs")
        self.run_fixture("statvfs")
        self.assertIn("fixture.txt", self.run_fixture("opendir", self.source).stdout)
        self.assertEqual(self.run_fixture("xattr").stdout.strip(), "clone")
        self.assert_original_unchanged()

    def test_write_create_and_truncate_do_not_modify_original(self):
        self.run_fixture("write", self.original, "UPDATED_COPY")
        self.assertEqual(self.clone.read_text(), "UPDATED_COPY")
        created = self.source / "new.txt"
        self.run_fixture("write", created, "NEW_COPY")
        self.assertFalse(created.exists())
        self.assertEqual((self.copy / "new.txt").read_text(), "NEW_COPY")
        self.run_fixture("truncate")
        self.assertEqual(self.clone.read_text(), "UP")
        self.assert_original_unchanged()

    def test_rename_unlink_mkdir_and_rmdir_affect_only_clone(self):
        renamed = self.source / "renamed.txt"
        self.run_fixture("rename", self.original, renamed)
        self.assertFalse(self.clone.exists())
        self.assertEqual((self.copy / "renamed.txt").read_text(), "PRIVATE_CLONE")
        self.run_fixture("unlink", renamed)
        self.assertFalse((self.copy / "renamed.txt").exists())
        directory = self.source / "created"
        self.run_fixture("mkdir", directory)
        self.assertTrue((self.copy / "created").is_dir())
        self.run_fixture("rmdir", directory)
        self.assertFalse(directory.exists())
        self.assert_original_unchanged()

    def test_copyfile_and_clonefile_map_both_arguments(self):
        for action in ("copyfile", "clonefile"):
            destination = self.source / (action + ".txt")
            self.run_fixture(action, self.original, destination)
            self.assertEqual((self.copy / destination.name).read_text(), "PRIVATE_CLONE")
            self.assertFalse(destination.exists())
        self.assert_original_unchanged()

    def test_native_at_family_and_rename_variants_use_copy_descriptors(self):
        self.run_fixture("at", self.source)
        for filename in ("at-clone", "at-renamed-again"):
            self.assertEqual((self.copy / filename).read_text(), "PRIVATE_CLONE")
            self.assertFalse((self.source / filename).exists())
        self.run_fixture("renamex", self.original, self.source / "exclusive-renamed")
        self.assertEqual((self.copy / "exclusive-renamed").read_text(), "PRIVATE_CLONE")
        self.assert_original_unchanged()

    def test_creating_links_is_limited_to_private_clone(self):
        self.run_fixture("symlink", self.source / "created-link", "fixture.txt")
        self.assertEqual((self.copy / "created-link").read_text(), "PRIVATE_CLONE")
        self.run_fixture("link", self.original, self.source / "hardlink")
        self.assertEqual((self.copy / "hardlink").stat().st_ino, self.clone.stat().st_ino)
        self.assertFalse((self.source / "created-link").exists())
        for target in (str(self.original), "../escape"):
            result = self.run_fixture("symlink", self.source / "bad-link", target, success=False)
            self.assertEqual(result.returncode, 70)
        other = self.case / "outside-hardlink"
        self.assertEqual(self.run_fixture("link", self.original, other, success=False).returncode, 70)
        self.assertFalse(other.exists())
        self.run_fixture("remove", self.source / "created-link")
        self.assertFalse((self.copy / "created-link").exists())
        self.assert_original_unchanged()

    def test_realpath_keeps_vendor_visible_source_path(self):
        self.assertEqual(self.run_fixture("realpath").stdout.strip(), str(self.original))

    def test_internal_relative_links_work_without_following_external_links(self):
        (self.copy / "internal").symlink_to("fixture.txt")
        (self.copy / "directory").mkdir(mode=0o700)
        (self.copy / "directory" / "internal").symlink_to("../fixture.txt")
        for relative in ("internal", "directory/internal"):
            self.assertEqual(self.run_fixture("read", self.source / relative).stdout.strip(), "PRIVATE_CLONE")
        self.assertEqual(self.run_fixture("readlink", self.source / "internal").stdout.strip(), "fixture.txt")
        (self.copy / "external").symlink_to(self.original)
        self.assertEqual(self.run_fixture("read", self.source / "external", success=False).returncode, 70)
        self.run_fixture("lstat", self.source / "external")
        self.run_fixture("unlink", self.source / "external")
        self.assert_original_unchanged()

    def test_relative_link_escape_and_link_cycle_are_rejected(self):
        (self.copy / "escape").symlink_to("../outside.txt")
        (self.copy.parent / "outside.txt").write_text("OUTSIDE")
        (self.copy / "cycle").symlink_to("cycle")
        for name in ("escape", "cycle"):
            self.assertEqual(self.run_fixture("read", self.source / name, success=False).returncode, 70)

    def test_source_and_copy_dotdot_cannot_escape_mapping(self):
        for path in (str(self.source) + "/../outside", str(self.copy) + "/../outside"):
            result = self.run_fixture("write", path, "NEVER_CREATED", success=False)
            self.assertEqual(result.returncode, 70)
        result = self.run_fixture("openat", self.source, "../../../../../../etc/passwd", success=False)
        self.assertEqual(result.returncode, 70)
        self.assertFalse((self.copy.parent / "outside").exists())

    def test_prefix_neighbor_and_other_paths_are_untouched(self):
        neighbor = self.source.parent / "com.tencent.xinWeChat-other"
        neighbor.mkdir(mode=0o700, exist_ok=True)
        text = neighbor / "fixture.txt"
        text.write_text("NEIGHBOR")
        self.assertEqual(self.run_fixture("read", text).stdout.strip(), "NEIGHBOR")
        other = self.case / "outside.txt"
        other.write_text("OTHER")
        self.assertEqual(self.run_fixture("read", other).stdout.strip(), "OTHER")

    def test_missing_configuration_is_inert_and_partial_configuration_exits_before_main(self):
        env = dict(self.env)
        for variable in VARIABLES: env.pop(variable, None)
        self.assertEqual(self.run_fixture("main", env=env).stdout.strip(), "MAIN:inert")
        env["MEMMY_WECHAT_CONTAINER_SOURCE"] = str(self.source)
        result = self.run_fixture("main", env=env, success=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn('"error":"wechat_private_storage_unsafe"', result.stderr)

    def test_optional_absent_group_fails_closed_instead_of_touching_original(self):
        env = dict(self.env)
        env.pop("MEMMY_WECHAT_GROUP_SOURCE")
        env.pop("MEMMY_WECHAT_GROUP_COPY")
        result = self.run_fixture("read", self.group_source / "group.txt", env=env, success=False)
        self.assertEqual(result.returncode, 70)
        self.assertEqual((self.group_source / "group.txt").read_text(), "ORIGINAL_GROUP")

    def test_wrong_source_layout_world_readable_or_symlink_copy_exits_before_main(self):
        bad_envs = []
        env = dict(self.env); env["MEMMY_WECHAT_CONTAINER_SOURCE"] = str(self.source) + "-wrong"; bad_envs.append(env)
        env = dict(self.env); env["MEMMY_WECHAT_CONTAINER_COPY"] = str(self.case); bad_envs.append(env)
        alias = self.case / "alias"; alias.symlink_to(self.session)
        env = dict(self.env); env["MEMMY_WECHAT_CONTAINER_COPY"] = str(alias / "home") + CONTAINER; bad_envs.append(env)
        env = dict(self.env); env.pop("MEMMY_WECHAT_GROUP_COPY"); bad_envs.append(env)
        for env in bad_envs:
            result = self.run_fixture("main", env=env, success=False)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
        self.session.chmod(0o755)
        self.assertEqual(self.run_fixture("main", success=False).returncode, 2)

    def test_production_build_has_no_environment_override_for_real_home(self):
        env = dict(self.env)
        env["DYLD_INSERT_LIBRARIES"] = str(self.production_library)
        env["MEMMY_WECHAT_BRIDGE_TEST_HOME"] = str(self.home)
        result = self.run_fixture("main", env=env, success=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
