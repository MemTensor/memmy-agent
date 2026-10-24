// Loaded only into the private, ad-hoc signed connection copy. Never reads data.
#import <AppKit/AppKit.h>
#import <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static BOOL safeOutput(const char *path) {
    struct stat info;
    if (lstat(path, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_uid != getuid()
        || (info.st_mode & 077) != 0) return NO;
    NSString *parent = [[NSString stringWithUTF8String:path] stringByDeletingLastPathComponent];
    if (lstat(parent.fileSystemRepresentation, &info) != 0 || !S_ISDIR(info.st_mode)
        || info.st_uid != getuid() || (info.st_mode & 077) != 0) return NO;
    return YES;
}

static void report(const char *output, NSDictionary *value) {
    if (!safeOutput(output)) _exit(2);
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (data == nil || data.length > 8192) _exit(2);
    int fd = open(output, O_WRONLY | O_NOFOLLOW);
    if (fd < 0) _exit(2);
    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_uid != getuid()
        || (info.st_mode & 077) != 0) {
        close(fd);
        _exit(2);
    }
    if (ftruncate(fd, 0) != 0) { close(fd); _exit(2); }
    const char *bytes = data.bytes;
    size_t written = 0;
    while (written < data.length) {
        ssize_t count = write(fd, bytes + written, data.length - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { close(fd); _exit(2); }
        written += (size_t)count;
    }
    fsync(fd);
    close(fd);
}

static BOOL privateStorageReady(void) {
    const char *status = getenv("MEMMY_WECHAT_STORAGE_BRIDGE_STATUS");
    const char *source = getenv("MEMMY_WECHAT_CONTAINER_SOURCE");
    const char *copy = getenv("MEMMY_WECHAT_CONTAINER_COPY");
    if (!status || strcmp(status, "ready") || !source || !copy) return NO;
    NSString *relative = @"Data/Documents/.memmy-permission-probe";
    NSString *requested = [[NSString stringWithUTF8String:source] stringByAppendingPathComponent:relative];
    NSString *expected = [[NSString stringWithUTF8String:copy] stringByAppendingPathComponent:relative];
    // This empty sentinel exists only in the private fixture. Opening the
    // original spelling must resolve to its private physical location.
    int fd = open(requested.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return NO;
    char actual[PATH_MAX];
    struct stat info;
    BOOL valid = fcntl(fd, F_GETPATH, actual) == 0 && fstat(fd, &info) == 0
        && S_ISREG(info.st_mode) && info.st_uid == getuid() && info.st_size == 0
        && (info.st_mode & 077) == 0 && !strcmp(actual, expected.fileSystemRepresentation);
    close(fd);
    return valid;
}

__attribute__((constructor)) static void memmyPermissionProbe(void) {
    const char *output = getenv("MEMMY_WECHAT_PERMISSION_PROBE");
    const char *challenge = getenv("MEMMY_WECHAT_PERMISSION_CHALLENGE");
    if (output == NULL) return; // Ordinary connection loads no probe behavior.
    if (challenge == NULL || strlen(challenge) != 64 || getuid() == 0 || getuid() != geteuid()) _exit(2);
    for (const char *item = challenge; *item; ++item) {
        if (!((*item >= '0' && *item <= '9') || (*item >= 'a' && *item <= 'f'))) _exit(2);
    }
    @autoreleasepool {
        uint32_t capacity = 4096;
        char executableBuffer[4096], resolved[PATH_MAX];
        if (_NSGetExecutablePath(executableBuffer, &capacity) != 0
            || realpath(executableBuffer, resolved) == NULL) _exit(2);
        NSString *executable = [NSString stringWithUTF8String:resolved];
        NSMutableDictionary *result = [@{
            @"challenge": [NSString stringWithUTF8String:challenge],
            @"probePid": @(getpid()), @"executable": executable,
            @"phase": @"started", @"ready": @NO, @"error": @"probe_running"
        } mutableCopy];
        // Publish our exact PID before AppKit/TCC calls, so the supervisor can
        // terminate this probe alone if an OS framework stalls.
        report(output, result);
        NSString *failure = @"wechat_private_storage_probe_failed";
        @try {
            NSApplicationLoad();
            [[NSApplication sharedApplication] setActivationPolicy:NSApplicationActivationPolicyProhibited];
            SecCodeRef selfCode = NULL;
            CFDictionaryRef signing = NULL;
            if (SecCodeCopySelf(kSecCSDefaultFlags, &selfCode) != errSecSuccess
                || SecCodeCopySigningInformation(selfCode, kSecCSSigningInformation, &signing) != errSecSuccess) {
                if (selfCode) CFRelease(selfCode);
                failure = @"wechat_private_storage_probe_failed";
            } else {
                NSDictionary *metadata = (__bridge NSDictionary *)signing;
                NSData *hash = metadata[(__bridge NSString *)kSecCodeInfoUnique];
                if (hash != nil) {
                    NSMutableString *text = [NSMutableString string];
                    const unsigned char *bytes = hash.bytes;
                    for (NSUInteger index = 0; index < hash.length; index++) [text appendFormat:@"%02x", bytes[index]];
                    result[@"codeHash"] = text;
                }
                CFRelease(signing);
                CFRelease(selfCode);
                failure = privateStorageReady() ? nil : @"wechat_private_storage_probe_failed";
            }
        } @catch (__unused NSException *exception) {
            failure = @"wechat_private_storage_probe_failed";
        }
        result[@"phase"] = @"finished";
        result[@"ready"] = failure == nil ? @YES : @NO;
        result[@"error"] = failure ?: (id)[NSNull null];
        report(output, result);
        // Do not enter WeChat main, run a GUI event loop, call any WeChat API,
        // or execute application shutdown handlers.
        _exit(failure == nil ? 0 : 3);
    }
}
