"""Native capture against synthetic processes/databases; never launches WeChat."""
import hashlib
import hmac
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import time
import unittest


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat/key_capture_bridge.c"
FIXTURE = r'''
#include <CommonCrypto/CommonCrypto.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
static atomic_bool running = 1;
static void *churn(void *unused) {
    (void)unused;
    unsigned char *codec = calloc(1, 120);
    const uint32_t fields[8] = {0, 256000, 2, 16, 32, 16, 16, 4096};
    memcpy(codec, fields, sizeof fields);
    while (atomic_load(&running)) {
        unsigned char *p = mmap(NULL, 16384, PROT_READ | PROT_WRITE, MAP_ANON | MAP_PRIVATE, -1, 0);
        if (p == MAP_FAILED) continue;
        uint64_t key = (uint64_t)(uintptr_t)(p + 128), mac = key + 32;
        memcpy(p + 8, &key, 8); memcpy(p + 16, &mac, 8);
        memset(p + 128, 91, 64);
        memcpy(codec + 96, &p, 8); memcpy(codec + 104, &p, 8);
        mprotect(p, 16384, PROT_NONE);
        munmap(p, 16384);
    }
    free(codec);
    return NULL;
}
static void load(const char *helper) {
    if (!dlopen(helper, RTLD_NOW | RTLD_LOCAL)) { fprintf(stderr, "%s", dlerror()); exit(71); }
}
static void late_literal(void) {
    // The candidate does not enter this process until after the scan deadline
    // or host cancellation. Keep it visible until the process exits.
    char *literal = calloc(1, 68);
    literal[0] = 'x'; literal[1] = '\'';
    if (fread(literal + 2, 1, 64, stdin) != 64) exit(72);
    literal[66] = '\'';
    sleep(2);
    free(literal);
}
static void cipher_context(const char *helper, size_t offset, int masked) {
    // Exercise public SQLCipher contexts and the independently audited WeChat
    // 4.1.15 WCDB layout, whose key/pass buffers use this compile-time XOR mask.
    const unsigned char mask[32] = {
      0xb8,0xec,0x38,0x29,0x1b,0xd5,0x9c,0x96,0x3f,0x46,0x54,0xd8,0xf9,0xd7,0x43,0x7e,
      0x1a,0xcc,0x81,0xa6,0xca,0xd6,0x31,0x3c,0x7b,0xd0,0xf5,0xe7,0x32,0x38,0xd4,0xaf
    };
    unsigned char *key = calloc(1, 32), *mac = calloc(1, 32), *pass = calloc(1, 32);
    if (fread(key, 1, 32, stdin) != 32 || fread(pass, 1, 32, stdin) != 32) exit(76);
    if (masked) for (int i = 0; i < 32; ++i) { key[i] ^= mask[i]; pass[i] ^= mask[i]; mac[i] = mask[i]; }
    unsigned char *context = calloc(1, 32);
    uint32_t pass_length = 32;
    memcpy(context + 4, &pass_length, 4);
    memcpy(context + 8, &key, 8); memcpy(context + 16, &mac, 8); memcpy(context + 24, &pass, 8);
    unsigned char *region = mmap(NULL, 512 * 1024, PROT_READ | PROT_WRITE, MAP_ANON | MAP_PRIVATE, -1, 0);
    if (region == MAP_FAILED) exit(77);
    // Place the codec header across the scanner's chunk boundary.
    unsigned char *codec = region + 256 * 1024 - 32;
    const uint32_t fields[8] = {1, 256000, 2, 16, 32, 16, 16, 4096};
    memcpy(codec, fields, sizeof fields);
    // One pointer only: a second valid pointer must not conceal a broken
    // layout branch in the production scanner.
    memcpy(codec + offset, &context, 8);
    load(helper); sleep(5);
    munmap(region, 512 * 1024); free(context); free(key); free(mac); free(pass);
}
int main(int argc, char **argv) {
    if (argc < 3) return 64;
    const char *mode = argv[1], *helper = argv[2];
    if (!strcmp(mode, "pbkdf")) {
        unsigned char salt[16], key[32]; memset(salt, 45, sizeof salt);
        return CCKeyDerivationPBKDF(kCCPBKDF2, "synthetic-password", 18, salt, sizeof salt,
                                    kCCPRFHmacAlgSHA512, 2, key, sizeof key);
    }
    if (!strcmp(mode, "pbkdf-many")) {
        unsigned char salt[16], key[32]; memset(salt, 45, sizeof salt);
        uint32_t pid = (uint32_t)getpid();
        for (uint32_t sequence = 0; sequence < 500; ++sequence) {
            char password[32] = {0};
            memcpy(password, &pid, sizeof pid);
            memcpy(password + 4, &sequence, sizeof sequence);
            int result = CCKeyDerivationPBKDF(kCCPBKDF2, password, sizeof password, salt, sizeof salt,
                                             kCCPRFHmacAlgSHA512, 2, key, sizeof key);
            if (result) return result;
        }
        return 0;
    }
    if (!strcmp(mode, "late")) {
        load(helper); puts("READY"); fflush(stdout); sleep(2); late_literal(); return 0;
    }
    if (!strcmp(mode, "race")) {
        pthread_t thread; pthread_create(&thread, NULL, churn, NULL);
        load(helper); sleep(2); atomic_store(&running, 0); pthread_join(thread, NULL); return 0;
    }
    if (!strcmp(mode, "plain96")) { cipher_context(helper, 96, 0); return 0; }
    if (!strcmp(mode, "plain104")) { cipher_context(helper, 104, 0); return 0; }
    if (!strcmp(mode, "masked104")) { cipher_context(helper, 104, 1); return 0; }
    if (!strcmp(mode, "masked112")) { cipher_context(helper, 112, 1); return 0; }
    if (!strcmp(mode, "databases")) {
        if (argc < 6) return 65;
        void *library = dlopen(argv[3], RTLD_NOW | RTLD_LOCAL);
        if (!library) { fprintf(stderr, "%s", dlerror()); return 66; }
        int (*open_db)(const char *, void **) = dlsym(library, "sqlite3_open");
        int (*set_key)(void *, const void *, int) = dlsym(library, "sqlite3_key");
        int (*exec_db)(void *, const char *, void *, void *, void *) = dlsym(library, "sqlite3_exec");
        int (*close_db)(void *) = dlsym(library, "sqlite3_close");
        if (!open_db || !set_key || !exec_db || !close_db) return 67;
        void *databases[2] = {0};
        for (int i = 0; i < 2; ++i) {
            unsigned char password[32];
            if (fread(password, 1, sizeof password, stdin) != sizeof password) return 68;
            if (open_db(argv[4 + i], &databases[i]) || set_key(databases[i], password, sizeof password)) return 69;
            if (exec_db(databases[i], "PRAGMA cipher_compatibility=4; CREATE TABLE fixture(value); INSERT INTO fixture VALUES (1);", NULL, NULL, NULL)) return 70;
            memset(password, 0, sizeof password);
        }
        puts("READY"); fflush(stdout);
        if (getchar() != 'S') return 73;
        // All key derivations happened before the helper is loaded: success
        // here demonstrates memory-context recovery independently of hooks.
        load(helper);
        sleep(5);
        for (int i = 0; i < 2; ++i) {
            if (exec_db(databases[i], "SELECT * FROM fixture", NULL, NULL, NULL)) return 74;
            close_db(databases[i]);
        }
        return 0;
    }
    return 75;
}
'''


def encrypted_page(key, salt):
    body = bytes(4016)
    mac_key = hashlib.pbkdf2_hmac("sha512", key, bytes(v ^ 0x3a for v in salt), 2, 32)
    return salt + body + hmac.new(mac_key, body + b"\x01\0\0\0", hashlib.sha512).digest()


def records(path):
    data = path.read_bytes()
    result = []
    while data:
        if len(data) < 16 or data[:4] != b"MKC1":
            raise AssertionError("invalid native sink framing")
        rounds, salt_length, password_length = struct.unpack_from("<III", data, 4)
        length = 16 + salt_length + password_length
        if len(data) < length:
            raise AssertionError("truncated native sink record")
        result.append((rounds, data[16:16 + salt_length], data[16 + salt_length:length]))
        data = data[length:]
    return result


@unittest.skipUnless(platform.system() == "Darwin" and shutil.which("xcrun"), "macOS SDK required")
class KeyCaptureNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="wechat-key-native-")
        cls.root = Path(cls.temporary.name).resolve()
        cls.helper = cls.root / "capture.dylib"
        cls.fixture = cls.root / "fixture"
        source = cls.root / "fixture.c"
        source.write_text(FIXTURE)
        common = ["xcrun", "clang", "-Wall", "-Wextra", "-Werror", "-O2"]
        subprocess.run(common + ["-dynamiclib", str(SOURCE), "-o", str(cls.helper)], check=True, capture_output=True)
        subprocess.run(common + [str(source), "-o", str(cls.fixture)], check=True, capture_output=True)
        for path in (cls.helper, cls.fixture):
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(path)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix="case-", dir=self.root))
        self.addCleanup(shutil.rmtree, self.case)
        self.sink = self.case / "capture.sink"
        self.sink.touch(mode=0o600)
        self.pages = self.case / "pages.bin"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("DYLD_", "MEMMY_WECHAT_"))}
        self.env.update(MEMMY_WECHAT_KEY_SINK=str(self.sink), MEMMY_WECHAT_CAPTURE_PAGES=str(self.pages),
                        MEMMY_WECHAT_CAPTURE_SECONDS="3")

    def page_file(self, pages):
        self.pages.write_bytes(b"MKP1" + struct.pack("<I", len(pages)) + b"".join(pages))
        self.pages.chmod(0o600)

    def launch(self, mode, *arguments):
        child = subprocess.Popen([str(self.fixture), mode, str(self.helper), *map(str, arguments)],
                                 env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.communicate()
        self.addCleanup(cleanup)
        return child

    def test_compatibility_interpose_keeps_real_pbkdf_working_without_scanner_pages(self):
        self.env.pop("MEMMY_WECHAT_CAPTURE_PAGES")
        self.env["DYLD_INSERT_LIBRARIES"] = str(self.helper)
        child = self.launch("pbkdf")
        _, error = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(records(self.sink), [(2, bytes([45]) * 16, b"synthetic-password")])

    @unittest.skipUnless(os.environ.get("MEMMY_SQLCIPHER_CONTEXT_TEST_LIBRARY"), "explicit SQLCipher 4.5.x context fixture library required")
    def test_preopened_real_sqlcipher_databases_recover_distinct_keys_past_unmatched_page(self):
        library = os.environ["MEMMY_SQLCIPHER_CONTEXT_TEST_LIBRARY"]
        first, second = self.case / "one.db", self.case / "two.db"
        passwords = [os.urandom(32), os.urandom(32)]
        child = self.launch("databases", library, first, second)
        child.stdin.write(b"".join(passwords)); child.stdin.flush()
        self.assertEqual(child.stdout.readline().strip(), b"READY")
        real_pages = [first.read_bytes()[:4096], second.read_bytes()[:4096]]
        self.assertTrue(all(len(page) == 4096 and not page.startswith(b"SQLite format 3") for page in real_pages))
        # The first page deliberately cannot be recovered. It must not prevent
        # recovering either independent database which follows it.
        self.page_file([encrypted_page(os.urandom(32), os.urandom(16)), *real_pages])
        expected = {hashlib.pbkdf2_hmac("sha512", password, page[:16], 256000, 32)
                    for password, page in zip(passwords, real_pages)}
        _, error = child.communicate(input=b"S", timeout=12)
        self.assertEqual(child.returncode, 0, error)
        actual = {password for rounds, _, password in records(self.sink) if rounds == 2}
        self.assertEqual(actual, expected)

    def test_each_cipher_layout_and_passphrase_across_chunk_boundary(self):
        for mode in ("plain96", "plain104", "masked104", "masked112"):
            with self.subTest(layout=mode):
                self.sink.write_bytes(b"")
                password, salt = os.urandom(32), os.urandom(16)
                key = hashlib.pbkdf2_hmac("sha512", password, salt, 256000, 32)
                self.page_file([encrypted_page(key, salt)])
                child = self.launch(mode)
                _, error = child.communicate(input=key + password, timeout=10)
                self.assertEqual(child.returncode, 0, error)
                recovered = records(self.sink)
                self.assertIn((2, bytes(v ^ 0x3a for v in salt), key), recovered)
                self.assertIn((256000, salt, password), recovered)

    def test_multiple_injected_processes_write_complete_distinct_sink_records(self):
        self.env.pop("MEMMY_WECHAT_CAPTURE_PAGES")
        self.env["DYLD_INSERT_LIBRARIES"] = str(self.helper)
        children = [self.launch("pbkdf-many") for _ in range(16)]
        for child in children:
            _, error = child.communicate(timeout=15)
            self.assertEqual(child.returncode, 0, error)
        recovered = records(self.sink)
        expected = {(2, bytes([45]) * 16, struct.pack("<II", child.pid, sequence) + bytes(24))
                    for child in children for sequence in range(500)}
        self.assertEqual(len(recovered), 8000)
        self.assertEqual(set(recovered), expected)

    def test_concurrent_unmap_and_protection_changes_do_not_crash_target(self):
        self.page_file([encrypted_page(os.urandom(32), os.urandom(16))])
        child = self.launch("race")
        _, error = child.communicate(timeout=6)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(records(self.sink), [])

    def test_deadline_stops_before_a_late_valid_candidate_arrives(self):
        key = os.urandom(32)
        self.page_file([encrypted_page(key, os.urandom(16))])
        self.env["MEMMY_WECHAT_CAPTURE_SECONDS"] = "1"
        child = self.launch("late")
        self.assertEqual(child.stdout.readline().strip(), b"READY")
        time.sleep(2.2)
        _, error = child.communicate(input=key.hex().encode(), timeout=5)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(records(self.sink), [])

    def test_host_removing_pages_cancels_before_a_late_valid_candidate(self):
        key = os.urandom(32)
        self.page_file([encrypted_page(key, os.urandom(16))])
        self.env["MEMMY_WECHAT_CAPTURE_SECONDS"] = "10"
        child = self.launch("late")
        self.assertEqual(child.stdout.readline().strip(), b"READY")
        time.sleep(0.5)
        self.pages.unlink()
        time.sleep(1.7)
        _, error = child.communicate(input=key.hex().encode(), timeout=5)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(records(self.sink), [])

    def test_rejects_insecure_or_malformed_page_files(self):
        for scenario in ("mode", "header", "count", "truncated", "symlink"):
            with self.subTest(scenario=scenario):
                self.page_file([encrypted_page(os.urandom(32), os.urandom(16))])
                if scenario == "mode": self.pages.chmod(0o644)
                elif scenario == "header": self.pages.write_bytes(b"BAD!" + self.pages.read_bytes()[4:])
                elif scenario == "count": self.pages.write_bytes(b"MKP1" + struct.pack("<I", 1025))
                elif scenario == "truncated": self.pages.write_bytes(self.pages.read_bytes()[:-1])
                else:
                    target = self.case / "target.bin"
                    self.pages.rename(target); self.pages.symlink_to(target)
                child = self.launch("race")
                _, error = child.communicate(timeout=6)
                self.assertEqual(child.returncode, 0, error)
                self.assertEqual(records(self.sink), [])
                self.pages.unlink()


if __name__ == "__main__":
    unittest.main()
