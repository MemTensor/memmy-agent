// Redirect the connection copy's libc file operations to Memmy's private clone.
// This is an I/O compatibility layer, not a sandbox or a grant of TCC access.
// Direct syscalls and APIs which do not bind these public symbols are not covered.
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <pwd.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/xattr.h>
#include <unistd.h>

// Apple's documented dyld __DATA,__interpose tuple. The convenience header is
// present in dyld's public source distribution but not in every macOS SDK.
#define DYLD_INTERPOSE(replacement, original) \
    __attribute__((used)) static const struct { const void *replacement; const void *original; } \
    interpose_##replacement __attribute__((section("__DATA,__interpose"))) = \
    { (const void *)(uintptr_t)&replacement, (const void *)(uintptr_t)&original }

typedef struct { char source[PATH_MAX]; char copy[PATH_MAX]; } Mapping;
static Mapping mappings[2];
static size_t mapping_count;
static char unavailable_group[PATH_MAX];
static pthread_once_t initialized = PTHREAD_ONCE_INIT;
static _Thread_local bool initializing;
static _Thread_local bool resolving_base;

static bool prefix(const char *path, const char *root) {
    size_t length = strlen(root);
    return strncmp(path, root, length) == 0 && (path[length] == '\0' || path[length] == '/');
}

// Locale-free: the printf family locks the global locale, and these interposed
// file calls can run while libc already holds that lock (e.g. setlocale opening
// its locale file), which would recursively lock an os_unfair_lock and abort.
static bool append(char output[PATH_MAX], const char *first, const char *second) {
    size_t first_length = strlen(first), second_length = strlen(second);
    if (first_length + second_length >= PATH_MAX) { errno = ENAMETOOLONG; return false; }
    memcpy(output, first, first_length);
    memcpy(output + first_length, second, second_length + 1);
    return true;
}

// Lexical normalization does not follow a link or inspect the protected source.
static bool normalize(const char *path, char output[PATH_MAX]) {
    if (path == NULL || path[0] != '/') { errno = EINVAL; return false; }
    size_t offsets[PATH_MAX / 2], count = 0, length = 1;
    output[0] = '/'; output[1] = '\0';
    for (const char *item = path + 1; *item;) {
        while (*item == '/') ++item;
        const char *end = item;
        while (*end && *end != '/') ++end;
        size_t part = (size_t)(end - item);
        if (part == 0) break;
        if (part == 1 && item[0] == '.') { item = end; continue; }
        if (part == 2 && item[0] == '.' && item[1] == '.') {
            if (count > 0) { length = offsets[--count]; output[length] = '\0'; }
            item = end; continue;
        }
        size_t previous = length;
        if (length > 1) ++length;
        if (length + part >= PATH_MAX || count >= PATH_MAX / 2) {
            errno = ENAMETOOLONG; return false;
        }
        if (previous > 1) output[previous] = '/';
        offsets[count++] = previous;
        memcpy(output + length, item, part); length += part; output[length] = '\0';
        item = end;
    }
    return true;
}

static void unsafe_configuration(void) {
    static const char message[] = "{\"error\":\"wechat_private_storage_unsafe\"}\n";
    (void)write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(2);
}

// Reject symlink ancestors. Ownership/privacy is required from the session down,
// while system ancestors (e.g. /private/var) retain their ordinary permissions.
static bool private_directory(const char *path, const char *session) {
    char component[PATH_MAX];
    if (!append(component, path, "")) return false;
    for (char *item = component + 1;; ++item) {
        if (*item != '/' && *item != '\0') continue;
        char saved = *item; *item = '\0';
        struct stat info;
        bool okay = lstat(component, &info) == 0 && S_ISDIR(info.st_mode);
        if (okay && prefix(component, session)) {
            okay = info.st_uid == getuid() && (info.st_mode & 077) == 0;
        }
        *item = saved;
        if (!okay) return false;
        if (saved == '\0') return true;
    }
}

static bool validate_copy(const char *copy, const char *suffix, char session[PATH_MAX]) {
    char normalized[PATH_MAX], resolved[PATH_MAX];
    if (!normalize(copy, normalized) || strcmp(copy, normalized) != 0
        || realpath(copy, resolved) == NULL || strcmp(copy, resolved) != 0) return false;
    size_t length = strlen(copy), suffix_length = strlen(suffix);
    if (length <= suffix_length || strcmp(copy + length - suffix_length, suffix) != 0) return false;
    size_t session_length = length - suffix_length;
    memcpy(session, copy, session_length); session[session_length] = '\0';
    const char *name = strrchr(session, '/');
    if (name == NULL || strncmp(name + 1, "storage-session-", 16) != 0) return false;
    const char *hex = name + 17;
    // The supervisor creates random 128-bit session names, not caller-chosen roots.
    if (strlen(hex) != 32) return false;
    for (; *hex; ++hex) if (!((*hex >= '0' && *hex <= '9') || (*hex >= 'a' && *hex <= 'f'))) return false;
    return private_directory(copy, session);
}

static void initialize(void) {
    initializing = true;
    const char *source = getenv("MEMMY_WECHAT_CONTAINER_SOURCE");
    const char *copy = getenv("MEMMY_WECHAT_CONTAINER_COPY");
    const char *group_source = getenv("MEMMY_WECHAT_GROUP_SOURCE");
    const char *group_copy = getenv("MEMMY_WECHAT_GROUP_COPY");
    if (source == NULL && copy == NULL && group_source == NULL && group_copy == NULL) {
        initializing = false; return; // Preparing a bundle alone has no data bridge.
    }
    if (getuid() == 0 || getuid() != geteuid() || source == NULL || copy == NULL
        || (group_source == NULL) != (group_copy == NULL)) unsafe_configuration();
    const char *home;
#ifdef MEMMY_WECHAT_BRIDGE_TEST_HOME
    // Native fixtures use a compile-time constant; production has no HOME override.
    home = MEMMY_WECHAT_BRIDGE_TEST_HOME;
#else
    struct passwd *user = getpwuid(getuid());
    home = user == NULL ? NULL : user->pw_dir;
#endif
    if (home == NULL || home[0] != '/') unsafe_configuration();
    static const char container_suffix[] = "/Library/Containers/com.tencent.xinWeChat";
    static const char group_suffix[] = "/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat";
    char expected[PATH_MAX], session[PATH_MAX], group_session[PATH_MAX];
    if (!append(expected, home, container_suffix) || strcmp(source, expected) != 0
        || !validate_copy(copy, "/home/Library/Containers/com.tencent.xinWeChat", session)
        || prefix(copy, source) || prefix(source, copy)) unsafe_configuration();
    if (!append(mappings[0].source, source, "") || !append(mappings[0].copy, copy, "")) unsafe_configuration();
    mapping_count = 1;
    if (group_source != NULL) {
        if (!append(expected, home, group_suffix) || strcmp(group_source, expected) != 0
            || !validate_copy(group_copy,
                "/home/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat", group_session)
            || strcmp(session, group_session) != 0) unsafe_configuration();
        if (!append(mappings[1].source, group_source, "")
            || !append(mappings[1].copy, group_copy, "")) unsafe_configuration();
        mapping_count = 2;
    } else if (!append(unavailable_group, home, group_suffix)) {
        unsafe_configuration();
    }
    if (setenv("MEMMY_WECHAT_STORAGE_BRIDGE_STATUS", "ready", 1) != 0) unsafe_configuration();
    initializing = false;
}

__attribute__((constructor)) static void initialize_bridge(void) {
    if (pthread_once(&initialized, initialize) != 0) unsafe_configuration();
}

// Existing clone links may be inspected/deleted, but cannot be followed to the
// original protected data. Missing components are permitted for mkdir/create.
static bool safe_copy_path_inner(const char *path, const char *root, bool follow_final, unsigned links) {
    char part[PATH_MAX];
    if (!append(part, path, "")) return false;
    size_t root_length = strlen(root);
    for (char *item = part + root_length;; ++item) {
        if (*item != '/' && *item != '\0') continue;
        char saved = *item; *item = '\0';
        struct stat info;
        int status = lstat(part, &info), saved_errno = errno;
        *item = saved;
        if (status != 0) {
            if (saved_errno == ENOENT) return true;
            errno = saved_errno; return false;
        }
        if (info.st_uid != getuid()) { errno = EACCES; return false; }
        if (S_ISLNK(info.st_mode) && (saved != '\0' || follow_final)) {
            // Retain only relative links which resolve entirely inside this
            // same clone root, including any remaining suffix after the link.
            if (links >= 40) { errno = ELOOP; return false; }
            char target[PATH_MAX], combined[PATH_MAX], normalized[PATH_MAX];
            *item = '\0';
            ssize_t length = readlink(part, target, sizeof(target) - 1);
            *item = saved;
            if (length < 0) return false;
            target[length] = '\0';
            if (target[0] == '/') { errno = EACCES; return false; }
            // last may be inside the remaining suffix: derive the link parent
            // from the component being inspected, rather than the full path.
            char *component_last = item;
            while (component_last > part && component_last[-1] != '/') --component_last;
            size_t parent_length = component_last > part ? (size_t)(component_last - part - 1) : 0;
            size_t target_length = strlen(target), item_length = strlen(item);
            if (parent_length + 1 + target_length + item_length >= sizeof(combined)) {
                errno = ENAMETOOLONG; return false;
            }
            memcpy(combined, part, parent_length);
            combined[parent_length] = '/';
            memcpy(combined + parent_length + 1, target, target_length);
            memcpy(combined + parent_length + 1 + target_length, item, item_length + 1);
            if (!normalize(combined, normalized) || !prefix(normalized, root)) { errno = EACCES; return false; }
            return safe_copy_path_inner(normalized, root, follow_final, links + 1);
        }
        if (saved == '\0') return true;
    }
}

static bool safe_copy_path(const char *path, const char *root, bool follow_final) {
    return safe_copy_path_inner(path, root, follow_final, 0);
}

// A relative path is resolved from the actual descriptor/cwd. Descriptors opened
// through this layer already point at the copy, so fd-based read/write/mmap work
// without any data-content interception. Copy-relative '..' cannot escape it.
static const char *mapped_at(int dirfd, const char *path, char output[PATH_MAX], bool follow_final) {
    if (path == NULL || path[0] == '\0') return path;
    if (initializing || resolving_base) return path;
    initialize_bridge();
    if (mapping_count == 0) return path;
    char absolute[PATH_MAX], normalized[PATH_MAX], base[PATH_MAX];
    if (path[0] == '/') {
        if (!append(absolute, path, "")) return NULL;
    } else {
        if (dirfd == AT_FDCWD) {
            // libc getcwd itself can call realpath/stat. Its internal calls
            // must use the actual copy cwd rather than recursively remapping.
            resolving_base = true;
            char *result = getcwd(base, sizeof(base));
            resolving_base = false;
            if (result == NULL) return NULL;
        } else {
            resolving_base = true;
            int result = fcntl(dirfd, F_GETPATH, base);
            resolving_base = false;
            if (result != 0) return NULL;
        }
        size_t base_length = strlen(base), path_length = strlen(path);
        if (base_length + 1 + path_length >= sizeof(absolute)) { errno = ENAMETOOLONG; return NULL; }
        memcpy(absolute, base, base_length);
        absolute[base_length] = '/';
        memcpy(absolute + base_length + 1, path, path_length + 1);
    }
    if (!normalize(absolute, normalized)) return NULL;
    if (unavailable_group[0] != '\0'
        && (prefix(absolute, unavailable_group) || prefix(normalized, unavailable_group))) {
        errno = EACCES; return NULL;
    }
    for (size_t index = 0; index < mapping_count; ++index) {
        const Mapping *mapping = &mappings[index];
        // Check raw spelling as well: /source/../x must not silently reach x.
        bool source_path = prefix(absolute, mapping->source) || prefix(normalized, mapping->source);
        bool copy_path = prefix(absolute, mapping->copy) || prefix(normalized, mapping->copy);
        if (!source_path && !copy_path) continue;
        const char *root = source_path ? mapping->source : mapping->copy;
        if (!prefix(normalized, root)) { errno = EACCES; return NULL; }
        if (!append(output, mapping->copy, normalized + strlen(root))) return NULL;
        if (!safe_copy_path(output, mapping->copy, follow_final)) return NULL;
        return output;
    }
    return path; // No other user's files or application resources are remapped.
}

#define MAP_PATH(path, follow, failure) \
    char storage[PATH_MAX]; const char *actual = mapped_at(AT_FDCWD, path, storage, follow); \
    if (path != NULL && actual == NULL) return failure
#define MAP_AT(fd, path, follow, failure) \
    char storage[PATH_MAX]; const char *actual = mapped_at(fd, path, storage, follow); \
    if (path != NULL && actual == NULL) return failure
#define INTERPOSE(replacement, original) DYLD_INTERPOSE(replacement, original)

static int bridge_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list arguments; va_start(arguments, flags); mode = (mode_t)va_arg(arguments, int); va_end(arguments); }
    MAP_PATH(path, !(flags & O_NOFOLLOW), -1);
    return open(actual, flags, mode);
}
INTERPOSE(bridge_open, open);
extern int open_nocancel(const char *, int, ...) __asm("_open$NOCANCEL");
static int bridge_open_nocancel(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list arguments; va_start(arguments, flags); mode = (mode_t)va_arg(arguments, int); va_end(arguments); }
    MAP_PATH(path, !(flags & O_NOFOLLOW), -1);
    return open_nocancel(actual, flags, mode);
}
INTERPOSE(bridge_open_nocancel, open_nocancel);

static int bridge_openat(int fd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list arguments; va_start(arguments, flags); mode = (mode_t)va_arg(arguments, int); va_end(arguments); }
    MAP_AT(fd, path, !(flags & O_NOFOLLOW), -1);
    return openat(fd, actual, flags, mode);
}
INTERPOSE(bridge_openat, openat);
extern int openat_nocancel(int, const char *, int, ...) __asm("_openat$NOCANCEL");
static int bridge_openat_nocancel(int fd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list arguments; va_start(arguments, flags); mode = (mode_t)va_arg(arguments, int); va_end(arguments); }
    MAP_AT(fd, path, !(flags & O_NOFOLLOW), -1);
    return openat_nocancel(fd, actual, flags, mode);
}
INTERPOSE(bridge_openat_nocancel, openat_nocancel);

static FILE *bridge_fopen(const char *path, const char *mode) { MAP_PATH(path, true, NULL); return fopen(actual, mode); }
INTERPOSE(bridge_fopen, fopen);
static FILE *bridge_freopen(const char *path, const char *mode, FILE *stream) {
    MAP_PATH(path, true, NULL); return freopen(actual, mode, stream);
}
INTERPOSE(bridge_freopen, freopen);
static DIR *bridge_opendir(const char *path) { MAP_PATH(path, true, NULL); return opendir(actual); }
INTERPOSE(bridge_opendir, opendir);

#define SINGLE_INT(name, follow) \
    static int bridge_##name(const char *path) { MAP_PATH(path, follow, -1); return name(actual); } \
    INTERPOSE(bridge_##name, name)
SINGLE_INT(chdir, true);
SINGLE_INT(unlink, false);
SINGLE_INT(rmdir, false);
SINGLE_INT(remove, false);

static int bridge_access(const char *path, int mode) { MAP_PATH(path, true, -1); return access(actual, mode); }
INTERPOSE(bridge_access, access);
static int bridge_faccessat(int fd, const char *path, int mode, int flags) {
    MAP_AT(fd, path, !(flags & AT_SYMLINK_NOFOLLOW), -1); return faccessat(fd, actual, mode, flags);
}
INTERPOSE(bridge_faccessat, faccessat);
static int bridge_stat(const char *path, struct stat *info) { MAP_PATH(path, true, -1); return stat(actual, info); }
INTERPOSE(bridge_stat, stat);
static int bridge_lstat(const char *path, struct stat *info) { MAP_PATH(path, false, -1); return lstat(actual, info); }
INTERPOSE(bridge_lstat, lstat);
static int bridge_fstatat(int fd, const char *path, struct stat *info, int flags) {
    MAP_AT(fd, path, !(flags & AT_SYMLINK_NOFOLLOW), -1); return fstatat(fd, actual, info, flags);
}
INTERPOSE(bridge_fstatat, fstatat);

static int bridge_mkdir(const char *path, mode_t mode) { MAP_PATH(path, false, -1); return mkdir(actual, mode); }
INTERPOSE(bridge_mkdir, mkdir);
static int bridge_mkdirat(int fd, const char *path, mode_t mode) { MAP_AT(fd, path, false, -1); return mkdirat(fd, actual, mode); }
INTERPOSE(bridge_mkdirat, mkdirat);
static int bridge_unlinkat(int fd, const char *path, int flags) { MAP_AT(fd, path, false, -1); return unlinkat(fd, actual, flags); }
INTERPOSE(bridge_unlinkat, unlinkat);
static ssize_t bridge_readlink(const char *path, char *buffer, size_t size) { MAP_PATH(path, false, -1); return readlink(actual, buffer, size); }
INTERPOSE(bridge_readlink, readlink);
static ssize_t bridge_readlinkat(int fd, const char *path, char *buffer, size_t size) {
    MAP_AT(fd, path, false, -1); return readlinkat(fd, actual, buffer, size);
}
INTERPOSE(bridge_readlinkat, readlinkat);

static int bridge_rename(const char *from, const char *to) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(AT_FDCWD, from, first, false), *b = mapped_at(AT_FDCWD, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    return rename(a, b);
}
INTERPOSE(bridge_rename, rename);
static int bridge_renameat(int from_fd, const char *from, int to_fd, const char *to) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(from_fd, from, first, false), *b = mapped_at(to_fd, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    return renameat(from_fd, a, to_fd, b);
}
INTERPOSE(bridge_renameat, renameat);
static int bridge_renamex_np(const char *from, const char *to, unsigned int flags) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(AT_FDCWD, from, first, false), *b = mapped_at(AT_FDCWD, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    return renamex_np(a, b, flags);
}
INTERPOSE(bridge_renamex_np, renamex_np);
static int bridge_renameatx_np(int from_fd, const char *from, int to_fd, const char *to, unsigned int flags) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(from_fd, from, first, false), *b = mapped_at(to_fd, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    return renameatx_np(from_fd, a, to_fd, b, flags);
}
INTERPOSE(bridge_renameatx_np, renameatx_np);

static int bridge_link(const char *from, const char *to) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(AT_FDCWD, from, first, false), *b = mapped_at(AT_FDCWD, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    // A cross-root hard link could import original live data into the clone.
    if ((a != from) != (b != to)) { errno = EACCES; return -1; }
    return link(a, b);
}
INTERPOSE(bridge_link, link);
static int bridge_linkat(int from_fd, const char *from, int to_fd, const char *to, int flags) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(from_fd, from, first, (flags & AT_SYMLINK_FOLLOW) != 0);
    const char *b = mapped_at(to_fd, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    if ((a != from) != (b != to)) { errno = EACCES; return -1; }
    return linkat(from_fd, a, to_fd, b, flags);
}
INTERPOSE(bridge_linkat, linkat);

static bool safe_link_target(const char *target, const char *destination) {
    if (destination == NULL) return true; // Preserve libc's invalid argument result.
    const char *root = NULL;
    for (size_t index = 0; index < mapping_count; ++index) {
        if (prefix(destination, mappings[index].copy)) { root = mappings[index].copy; break; }
    }
    if (root == NULL) return true;
    if (target == NULL || target[0] == '/') { errno = EACCES; return false; }
    const char *last = strrchr(destination, '/');
    char combined[PATH_MAX], normalized[PATH_MAX];
    size_t prefix_length = (size_t)(last - destination), target_length = strlen(target);
    if (prefix_length + 1 + target_length >= sizeof(combined)) { errno = ENAMETOOLONG; return false; }
    memcpy(combined, destination, prefix_length);
    combined[prefix_length] = '/';
    memcpy(combined + prefix_length + 1, target, target_length + 1);
    if (!normalize(combined, normalized) || !prefix(normalized, root)) { errno = EACCES; return false; }
    return safe_copy_path(normalized, root, true);
}
static int bridge_symlink(const char *target, const char *path) {
    MAP_PATH(path, false, -1);
    if (!safe_link_target(target, actual)) return -1;
    return symlink(target, actual);
}
INTERPOSE(bridge_symlink, symlink);
static int bridge_symlinkat(const char *target, int fd, const char *path) {
    MAP_AT(fd, path, false, -1);
    if (!safe_link_target(target, actual)) return -1;
    return symlinkat(target, fd, actual);
}
INTERPOSE(bridge_symlinkat, symlinkat);

static int bridge_getattrlist(const char *path, struct attrlist *list, void *buffer, size_t size, unsigned long options) {
    MAP_PATH(path, !(options & FSOPT_NOFOLLOW), -1); return getattrlist(actual, list, buffer, size, options);
}
INTERPOSE(bridge_getattrlist, getattrlist);
static int bridge_setattrlist(const char *path, struct attrlist *list, void *buffer, size_t size, unsigned long options) {
    MAP_PATH(path, !(options & FSOPT_NOFOLLOW), -1); return setattrlist(actual, list, buffer, size, options);
}
INTERPOSE(bridge_setattrlist, setattrlist);
static int bridge_getattrlistat(int fd, const char *path, void *list, void *buffer, size_t size, unsigned long options) {
    MAP_AT(fd, path, !(options & FSOPT_NOFOLLOW), -1); return getattrlistat(fd, actual, list, buffer, size, options);
}
INTERPOSE(bridge_getattrlistat, getattrlistat);
static int bridge_setattrlistat(int fd, const char *path, void *list, void *buffer, size_t size, uint32_t options) {
    MAP_AT(fd, path, !(options & FSOPT_NOFOLLOW), -1); return setattrlistat(fd, actual, list, buffer, size, options);
}
INTERPOSE(bridge_setattrlistat, setattrlistat);

static int bridge_copyfile(const char *from, const char *to, copyfile_state_t state, copyfile_flags_t flags) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(AT_FDCWD, from, first, !(flags & COPYFILE_NOFOLLOW_SRC));
    const char *b = mapped_at(AT_FDCWD, to, second, !(flags & COPYFILE_NOFOLLOW_DST));
    if ((from && !a) || (to && !b)) return -1;
    return copyfile(a, b, state, flags);
}
INTERPOSE(bridge_copyfile, copyfile);
static int bridge_clonefile(const char *from, const char *to, uint32_t flags) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(AT_FDCWD, from, first, !(flags & CLONE_NOFOLLOW));
    const char *b = mapped_at(AT_FDCWD, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    return clonefile(a, b, flags);
}
INTERPOSE(bridge_clonefile, clonefile);
static int bridge_clonefileat(int from_fd, const char *from, int to_fd, const char *to, uint32_t flags) {
    char first[PATH_MAX], second[PATH_MAX];
    const char *a = mapped_at(from_fd, from, first, !(flags & CLONE_NOFOLLOW));
    const char *b = mapped_at(to_fd, to, second, false);
    if ((from && !a) || (to && !b)) return -1;
    return clonefileat(from_fd, a, to_fd, b, flags);
}
INTERPOSE(bridge_clonefileat, clonefileat);
static int bridge_fclonefileat(int from_fd, int to_fd, const char *to, uint32_t flags) {
    MAP_AT(to_fd, to, false, -1); return fclonefileat(from_fd, to_fd, actual, flags);
}
INTERPOSE(bridge_fclonefileat, fclonefileat);

static int bridge_chmod(const char *path, mode_t mode) { MAP_PATH(path, true, -1); return chmod(actual, mode); }
INTERPOSE(bridge_chmod, chmod);
static int bridge_chown(const char *path, uid_t owner, gid_t group) { MAP_PATH(path, true, -1); return chown(actual, owner, group); }
INTERPOSE(bridge_chown, chown);
static int bridge_lchown(const char *path, uid_t owner, gid_t group) { MAP_PATH(path, false, -1); return lchown(actual, owner, group); }
INTERPOSE(bridge_lchown, lchown);
static int bridge_fchmodat(int fd, const char *path, mode_t mode, int flags) {
    MAP_AT(fd, path, !(flags & AT_SYMLINK_NOFOLLOW), -1); return fchmodat(fd, actual, mode, flags);
}
INTERPOSE(bridge_fchmodat, fchmodat);
static int bridge_fchownat(int fd, const char *path, uid_t owner, gid_t group, int flags) {
    MAP_AT(fd, path, !(flags & AT_SYMLINK_NOFOLLOW), -1); return fchownat(fd, actual, owner, group, flags);
}
INTERPOSE(bridge_fchownat, fchownat);
static int bridge_truncate(const char *path, off_t length) { MAP_PATH(path, true, -1); return truncate(actual, length); }
INTERPOSE(bridge_truncate, truncate);
static int bridge_utimes(const char *path, const struct timeval times[2]) { MAP_PATH(path, true, -1); return utimes(actual, times); }
INTERPOSE(bridge_utimes, utimes);
static int bridge_lutimes(const char *path, const struct timeval times[2]) { MAP_PATH(path, false, -1); return lutimes(actual, times); }
INTERPOSE(bridge_lutimes, lutimes);
static int bridge_utimensat(int fd, const char *path, const struct timespec times[2], int flags) {
    MAP_AT(fd, path, !(flags & AT_SYMLINK_NOFOLLOW), -1); return utimensat(fd, actual, times, flags);
}
INTERPOSE(bridge_utimensat, utimensat);
static int bridge_statfs(const char *path, struct statfs *info) { MAP_PATH(path, true, -1); return statfs(actual, info); }
INTERPOSE(bridge_statfs, statfs);
static int bridge_statvfs(const char *path, struct statvfs *info) { MAP_PATH(path, true, -1); return statvfs(actual, info); }
INTERPOSE(bridge_statvfs, statvfs);
static ssize_t bridge_getxattr(const char *path, const char *name, void *value, size_t size, uint32_t position, int options) {
    MAP_PATH(path, !(options & XATTR_NOFOLLOW), -1); return getxattr(actual, name, value, size, position, options);
}
INTERPOSE(bridge_getxattr, getxattr);
static int bridge_setxattr(const char *path, const char *name, const void *value, size_t size, uint32_t position, int options) {
    MAP_PATH(path, !(options & XATTR_NOFOLLOW), -1); return setxattr(actual, name, value, size, position, options);
}
INTERPOSE(bridge_setxattr, setxattr);
static ssize_t bridge_listxattr(const char *path, char *buffer, size_t size, int options) {
    MAP_PATH(path, !(options & XATTR_NOFOLLOW), -1); return listxattr(actual, buffer, size, options);
}
INTERPOSE(bridge_listxattr, listxattr);
static int bridge_removexattr(const char *path, const char *name, int options) {
    MAP_PATH(path, !(options & XATTR_NOFOLLOW), -1); return removexattr(actual, name, options);
}
INTERPOSE(bridge_removexattr, removexattr);

// realpath must retain the vendor-visible account path, even though filesystem
// resolution occurs only inside the clone. The result can safely be passed back
// to any interposed operation above.
static char *bridge_realpath(const char *path, char *resolved) {
    if (initializing || resolving_base) return realpath(path, resolved);
    MAP_PATH(path, true, NULL);
    char private_result[PATH_MAX];
    if (realpath(actual, private_result) == NULL) return NULL;
    char visible[PATH_MAX]; const char *value = private_result;
    for (size_t index = 0; index < mapping_count; ++index) {
        if (prefix(private_result, mappings[index].copy)) {
            if (!append(visible, mappings[index].source, private_result + strlen(mappings[index].copy))) return NULL;
            value = visible; break;
        }
    }
    if (resolved == NULL) return strdup(value);
    return strcpy(resolved, value);
}
INTERPOSE(bridge_realpath, realpath);
