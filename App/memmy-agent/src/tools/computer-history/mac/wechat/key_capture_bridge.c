// Recover verified SQLCipher keys only inside the temporary reader process.
// A CommonCrypto interpose remains for providers that use it. Other providers
// (including statically linked ones) are supported by recognizing SQLCipher
// key literals / cipher contexts in snapshots of this process's own memory.
// No debugger, other-process attachment, or original-database access is used.
#include <CommonCrypto/CommonCrypto.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define DYLD_INTERPOSE(replacement, original) \
    __attribute__((used)) static const struct { const void *replacement; const void *original; } \
    interpose_##replacement __attribute__((section("__DATA,__interpose"))) = \
    { (const void *)(uintptr_t)&replacement, (const void *)(uintptr_t)&original }

#define PAGE_SIZE_BYTES 4096u
#define KEY_BYTES 32u
#define SALT_BYTES 16u
#define MAX_PASSWORD 256u
#define MAX_PAGES 1024u
#define CHUNK_BYTES (256u * 1024u)
#define OVERLAP_BYTES 200u
#define CACHE_SLOTS 16384u
#define MAX_RECORDS 4096u

// WCDB in WeChat 4.1.15 arm64 XORs stored key/HMAC/pass bytes with this
// compile-time constant. Verified in its cipher provider callsite; this is not
// an account key. Always require a target-page HMAC after applying it, so a
// different version/layout cannot be mistaken for a successful connection.
static const uint8_t wcdb_mask[KEY_BYTES] = {
    0xb8,0xec,0x38,0x29,0x1b,0xd5,0x9c,0x96,0x3f,0x46,0x54,0xd8,0xf9,0xd7,0x43,0x7e,
    0x1a,0xcc,0x81,0xa6,0xca,0xd6,0x31,0x3c,0x7b,0xd0,0xf5,0xe7,0x32,0x38,0xd4,0xaf
};

static int sink_descriptor = -1;
static pthread_mutex_t sink_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t sink_ready = PTHREAD_ONCE_INIT;
static unsigned record_count;
// The scanner's own PBKDF must never feed the compatibility interpose.
static _Thread_local bool scanning;

static void open_sink(void) {
    const char *path = getenv("MEMMY_WECHAT_KEY_SINK");
    if (path == NULL || path[0] != '/') return;
    int fd = open(path, O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW);
    struct stat info;
    if (fd < 0) return;
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid()
        || (info.st_mode & 0777) != 0600 || info.st_nlink != 1) {
        close(fd); return;
    }
    sink_descriptor = fd;
}

static bool write_all(const void *data, size_t length) {
    const uint8_t *bytes = data;
    for (size_t written = 0; written < length;) {
        ssize_t count = write(sink_descriptor, bytes + written, length - written);
        if (count > 0) { written += (size_t)count; continue; }
        if (count < 0 && errno == EINTR) continue;
        return false;
    }
    return true;
}

// Existing host protocol: MKC1 | rounds/saltLen/pwLen u32le | salt | password.
static void capture(unsigned rounds, const uint8_t *salt, size_t salt_length,
                    const char *password, size_t password_length) {
    if (salt == NULL || password == NULL || salt_length != SALT_BYTES
        || password_length == 0 || password_length > MAX_PASSWORD
        || (rounds != 2 && rounds != 256000)) return;
    pthread_once(&sink_ready, open_sink);
    if (sink_descriptor < 0) return;
    uint8_t record[16 + SALT_BYTES + MAX_PASSWORD];
    uint32_t fields[3] = { rounds, (uint32_t)salt_length, (uint32_t)password_length };
    memcpy(record, "MKC1", 4);
    memcpy(record + 4, fields, sizeof fields);
    memcpy(record + 16, salt, salt_length);
    memcpy(record + 16 + salt_length, password, password_length);
    pthread_mutex_lock(&sink_lock);
    if (record_count < MAX_RECORDS) {
        ++record_count;
        // Child helpers can inherit the injection. Serialize whole records
        // across processes as well as threads, even if write returns short.
        int locked;
        do { locked = flock(sink_descriptor, LOCK_EX); } while (locked < 0 && errno == EINTR);
        if (locked == 0) {
            if (!write_all(record, 16 + salt_length + password_length)) record_count = MAX_RECORDS;
            (void)flock(sink_descriptor, LOCK_UN);
        }
    }
    pthread_mutex_unlock(&sink_lock);
    memset(record, 0, sizeof record);
}

static int memmy_key_derivation_pbkdf(CCPBKDFAlgorithm algorithm, const char *password, size_t password_length,
                                    const uint8_t *salt, size_t salt_length, CCPseudoRandomAlgorithm prf,
                                    unsigned rounds, uint8_t *derived_key, size_t derived_key_length) {
    if (!scanning && prf == kCCPRFHmacAlgSHA512)
        capture(rounds, salt, salt_length, password, password_length);
    return CCKeyDerivationPBKDF(algorithm, password, password_length, salt, salt_length,
                               prf, rounds, derived_key, derived_key_length);
}
DYLD_INTERPOSE(memmy_key_derivation_pbkdf, CCKeyDerivationPBKDF);

typedef struct {
    uint8_t bytes[PAGE_SIZE_BYTES];
    bool matched;
} target_page;

typedef struct {
    target_page *pages;
    size_t count, remaining;
    uint64_t cache[CACHE_SLOTS];
    uint16_t verified_page[CACHE_SLOTS];
    uint64_t pass_cache[8];
    size_t pass_attempts;
    double deadline;
    char *page_path;
    dev_t page_device;
    ino_t page_inode;
    uint8_t *chunk;
} scanner_state;

static double now_seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 1e30;
    return (double)now.tv_sec + (double)now.tv_nsec / 1e9;
}

static bool active(scanner_state *state) {
    if (state->remaining == 0 || now_seconds() >= state->deadline) return false;
    // The host removes the private page file when capture is cancelled.
    struct stat info;
    return lstat(state->page_path, &info) == 0 && S_ISREG(info.st_mode)
        && info.st_dev == state->page_device && info.st_ino == state->page_inode;
}

static bool read_exact(int fd, void *buffer, size_t length) {
    uint8_t *out = buffer;
    for (size_t offset = 0; offset < length;) {
        ssize_t count = read(fd, out + offset, length - offset);
        if (count > 0) { offset += (size_t)count; continue; }
        if (count < 0 && errno == EINTR) continue;
        return false;
    }
    return true;
}

static bool load_pages(scanner_state *state) {
    const char *path = getenv("MEMMY_WECHAT_CAPTURE_PAGES");
    if (path == NULL || path[0] != '/') return false;
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return false;
    struct stat info;
    uint8_t header[8];
    uint32_t count = 0;
    bool valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid()
        && (info.st_mode & 0777) == 0600 && info.st_nlink == 1
        && read_exact(fd, header, sizeof header) && memcmp(header, "MKP1", 4) == 0;
    if (valid) memcpy(&count, header + 4, sizeof count);
    valid = valid && count > 0 && count <= MAX_PAGES
        && info.st_size == (off_t)(sizeof header + (size_t)count * PAGE_SIZE_BYTES);
    if (valid) {
        state->pages = calloc(count, sizeof(target_page));
        valid = state->pages != NULL;
    }
    if (valid) {
        for (uint32_t index = 0; index < count; ++index) {
            if (!read_exact(fd, state->pages[index].bytes, PAGE_SIZE_BYTES)) { valid = false; break; }
        }
    }
    close(fd);
    if (!valid) { free(state->pages); state->pages = NULL; return false; }
    state->count = state->remaining = count;
    state->page_path = strdup(path);
    if (state->page_path == NULL) { free(state->pages); state->pages = NULL; return false; }
    state->page_device = info.st_dev;
    state->page_inode = info.st_ino;
    return true;
}

static bool authenticate(const uint8_t key[KEY_BYTES], const uint8_t page[PAGE_SIZE_BYTES]) {
    uint8_t salt[SALT_BYTES], mac_key[KEY_BYTES], mac[64];
    for (size_t i = 0; i < SALT_BYTES; ++i) salt[i] = page[i] ^ 0x3a;
    if (CCKeyDerivationPBKDF(kCCPBKDF2, (const char *)key, KEY_BYTES, salt, SALT_BYTES,
                            kCCPRFHmacAlgSHA512, 2, mac_key, KEY_BYTES) != kCCSuccess) return false;
    CCHmacContext context;
    CCHmacInit(&context, kCCHmacAlgSHA512, mac_key, sizeof mac_key);
    CCHmacUpdate(&context, page + 16, 4016);
    const uint8_t page_number[4] = {1, 0, 0, 0};
    CCHmacUpdate(&context, page_number, sizeof page_number);
    CCHmacFinal(&context, mac);
    bool valid = memcmp(mac, page + 4032, 64) == 0;
    memset(mac_key, 0, sizeof mac_key);
    return valid;
}

static int candidate(scanner_state *state, const uint8_t key[KEY_BYTES]) {
    // Cache fingerprints only; do not keep copies of unrelated candidate keys.
    uint64_t hash = UINT64_C(1469598103934665603);
    for (size_t i = 0; i < KEY_BYTES; ++i) hash = (hash ^ key[i]) * UINT64_C(1099511628211);
    if (hash == 0) hash = 1;
    size_t slot = hash % CACHE_SLOTS;
    if (state->cache[slot] == hash) return (int)state->verified_page[slot] - 1;
    state->cache[slot] = hash;
    state->verified_page[slot] = 0;
    for (size_t i = 0; i < state->count; ++i) {
        target_page *page = &state->pages[i];
        if (page->matched || !authenticate(key, page->bytes)) continue;
        uint8_t salt[SALT_BYTES];
        for (size_t j = 0; j < SALT_BYTES; ++j) salt[j] = page->bytes[j] ^ 0x3a;
        capture(2, salt, sizeof salt, (const char *)key, KEY_BYTES);
        page->matched = true;
        --state->remaining;
        state->verified_page[slot] = (uint16_t)(i + 1);
    }
    return (int)state->verified_page[slot] - 1;
}

static bool safe_read(uint64_t address, void *out, size_t length);

static void passphrase(scanner_state *state, const uint8_t *data, uint32_t length, int verified, bool masked) {
    if (verified < 0 || length == 0 || length > MAX_PASSWORD || state->pass_attempts >= 8) return;
    uint64_t pointer;
    memcpy(&pointer, data + 24, 8);
    uint8_t password[MAX_PASSWORD], derived[KEY_BYTES];
    if (!safe_read(pointer, password, length)) return;
    if (masked) for (uint32_t i = 0; i < length; ++i) password[i] ^= wcdb_mask[i % KEY_BYTES];
    // A raw-key literal is already handled as a key, not a PBKDF passphrase.
    if (length >= 2 && (password[0] == 'x' || password[0] == 'X') && password[1] == '\'') return;
    uint64_t hash = UINT64_C(1469598103934665603);
    for (uint32_t i = 0; i < length; ++i) hash = (hash ^ password[i]) * UINT64_C(1099511628211);
    for (size_t i = 0; i < state->pass_attempts; ++i) if (state->pass_cache[i] == hash) return;
    state->pass_cache[state->pass_attempts++] = hash;
    const uint8_t *page = state->pages[verified].bytes;
    if (CCKeyDerivationPBKDF(kCCPBKDF2, (const char *)password, length, page, SALT_BYTES,
                            kCCPRFHmacAlgSHA512, 256000, derived, KEY_BYTES) == kCCSuccess
        && authenticate(derived, page)) {
        capture(256000, page, SALT_BYTES, (const char *)password, length);
    }
    memset(password, 0, sizeof password); memset(derived, 0, sizeof derived);
}

// Always read via the kernel. A concurrent unmap/protection change must yield a
// missed candidate, never a fault in WeChat. Region metadata is only a hint.
static bool safe_read(uint64_t address, void *out, size_t length) {
    if (address < 0x100000000ull || address >= 0x0001000000000000ull
        || length > 0x0001000000000000ull - address) return false;
    mach_vm_size_t actual = 0;
    return mach_vm_read_overwrite(mach_task_self(), address, length,
        (mach_vm_address_t)(uintptr_t)out, &actual) == KERN_SUCCESS && actual == length;
}

static int hex_value(uint8_t value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static void literal(scanner_state *state, const uint8_t *data, size_t length) {
    if (length < 67 || (data[0] != 'x' && data[0] != 'X') || data[1] != '\'') return;
    size_t hex_length = 0;
    while (2 + hex_length < length && hex_length < 192 && hex_value(data[2 + hex_length]) >= 0) ++hex_length;
    if ((hex_length != 64 && hex_length != 96 && hex_length != 128 && hex_length != 192)
        || 2 + hex_length >= length || data[2 + hex_length] != '\'') return;
    uint8_t key[KEY_BYTES];
    for (size_t i = 0; i < KEY_BYTES; ++i)
        key[i] = (uint8_t)((hex_value(data[2 + i * 2]) << 4) | hex_value(data[3 + i * 2]));
    candidate(state, key);
    memset(key, 0, sizeof key);
}

static bool plausible_pointer(uint64_t value) {
    return value >= 0x100000000ull && value < 0x0001000000000000ull && (value & 7) == 0;
}

static void cipher_context(scanner_state *state, const uint8_t *data, size_t length, bool masked) {
    if (length < 32) return;
    uint32_t derive, pass_length;
    uint64_t key_pointer, mac_pointer;
    memcpy(&derive, data, 4); memcpy(&pass_length, data + 4, 4);
    memcpy(&key_pointer, data + 8, 8); memcpy(&mac_pointer, data + 16, 8);
    if (derive > 1 || pass_length > MAX_PASSWORD || !plausible_pointer(key_pointer)
        || !plausible_pointer(mac_pointer) || key_pointer == mac_pointer) return;
    uint8_t key[KEY_BYTES], mac[KEY_BYTES];
    if (safe_read(key_pointer, key, sizeof key) && safe_read(mac_pointer, mac, sizeof mac)) {
        if (masked) for (size_t i = 0; i < KEY_BYTES; ++i) key[i] ^= wcdb_mask[i];
        int verified = candidate(state, key);
        passphrase(state, data, pass_length, verified, masked);
    }
    memset(key, 0, sizeof key); memset(mac, 0, sizeof mac);
}

static void codec_context(scanner_state *state, const uint8_t *data, size_t length) {
    if (length < 120) return;
    uint32_t fields[8];
    memcpy(fields, data, sizeof fields);
    // Public SQLCipher codec_ctx: store_pass, kdf_iter, fast_kdf_iter,
    // kdf_salt_sz, key_sz, iv_sz, block_sz, page_sz. A pointer pair alone is
    // common in arbitrary objects; this entire tuple is highly selective.
    if (fields[0] > 1 || fields[1] != 256000 || fields[2] != 2 || fields[3] != 16
        || fields[4] != 32 || fields[5] != 16 || fields[6] != 16 || fields[7] != 4096) return;
    // Upstream 4.5.x has read/write at 96/104. WeChat 4.1.15's WCDB
    // variant has additional metadata, with read/write at 104/112.
    for (size_t offset = 96; offset <= 112; offset += 8) {
        uint64_t pointer;
        uint8_t context[32];
        memcpy(&pointer, data + offset, 8);
        if (plausible_pointer(pointer) && safe_read(pointer, context, sizeof context)) {
            if (offset <= 104) cipher_context(state, context, sizeof context, false);
            if (offset >= 104) cipher_context(state, context, sizeof context, true);
        }
    }
}

static void inspect_chunk(scanner_state *state, const uint8_t *data, size_t length, uint64_t address) {
    for (size_t offset = 0; offset < length && state->remaining; ++offset) {
        if ((offset & 16383u) == 0 && !active(state)) return;
        if ((data[offset] == 'x' || data[offset] == 'X') && length - offset >= 67)
            literal(state, data + offset, length - offset);
        if (((address + offset) & 7) == 0 && length - offset >= 120)
            codec_context(state, data + offset, length - offset);
    }
}

static void scan_once(scanner_state *state) {
    mach_vm_address_t address = 0;
    while (active(state)) {
        mach_vm_size_t size = 0;
        vm_region_basic_info_data_64_t info;
        mach_msg_type_number_t info_count = VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object = MACH_PORT_NULL;
        if (mach_vm_region(mach_task_self(), &address, &size, VM_REGION_BASIC_INFO_64,
            (vm_region_info_t)&info, &info_count, &object) != KERN_SUCCESS) break;
        if (object != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), object);
        if (size == 0 || size > UINT64_MAX - address) break;
        if ((info.protection & (VM_PROT_READ | VM_PROT_WRITE)) == (VM_PROT_READ | VM_PROT_WRITE)
            && !(info.protection & VM_PROT_EXECUTE)) {
            for (mach_vm_size_t offset = 0; offset < size && active(state); offset += CHUNK_BYTES) {
                size_t length = size - offset > CHUNK_BYTES + OVERLAP_BYTES ? CHUNK_BYTES + OVERLAP_BYTES : (size_t)(size - offset);
                if (safe_read(address + offset, state->chunk, length))
                    inspect_chunk(state, state->chunk, length, address + offset);
                // Yield between bounded slices, including very large VM regions.
                usleep(1000);
            }
        }
        address += size;
    }
}

static void *scanner(void *unused) {
    (void)unused;
    scanning = true;
    scanner_state *state = calloc(1, sizeof(scanner_state));
    if (state == NULL) return NULL;
    if (!load_pages(state)) { free(state); return NULL; }
    const char *seconds_text = getenv("MEMMY_WECHAT_CAPTURE_SECONDS");
    char *end = NULL;
    long seconds = seconds_text ? strtol(seconds_text, &end, 10) : 180;
    if (seconds_text && (end == seconds_text || *end != '\0')) seconds = 180;
    if (seconds < 1) seconds = 1;
    if (seconds > 300) seconds = 300;
    state->deadline = now_seconds() + (double)seconds;
    state->chunk = malloc(CHUNK_BYTES + OVERLAP_BYTES);
    if (state->chunk != NULL) {
        while (active(state)) { scan_once(state); if (active(state)) usleep(250000); }
        memset(state->chunk, 0, CHUNK_BYTES + OVERLAP_BYTES);
        free(state->chunk);
    }
    free(state->pages);
    free(state->page_path);
    memset(state, 0, sizeof *state);
    free(state);
    return NULL;
}

__attribute__((constructor)) static void start_scanner(void) {
    if (getenv("MEMMY_WECHAT_KEY_SINK") == NULL || getenv("MEMMY_WECHAT_CAPTURE_PAGES") == NULL) return;
    pthread_t thread;
    if (pthread_create(&thread, NULL, scanner, NULL) == 0) pthread_detach(thread);
}
