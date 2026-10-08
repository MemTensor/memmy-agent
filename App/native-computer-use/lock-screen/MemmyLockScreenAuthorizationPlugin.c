#include <CoreFoundation/CoreFoundation.h>
#include <Security/AuthorizationPlugin.h>
#include <Security/SecCode.h>
#include <Security/SecRequirement.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

// This plug-in has no credential API. It can only answer the authorization
// engine's screen-unlock question. A denial leaves the stock login UI rule.
#ifndef MEMMY_AUTH_SOCKET
#define MEMMY_AUTH_SOCKET "/tmp/cn.memtensor.memmy.computeruse/LockScreenAuthorization.sock"
#endif
#ifndef MEMMY_PEER_REQUIREMENT
#define MEMMY_PEER_REQUIREMENT "identifier \"cn.memtensor.memmy\" and anchor apple generic and certificate leaf[subject.OU] = \"S7NLXHGBJ2\""
#endif

typedef struct {
    const AuthorizationCallbacks *callbacks;
} MemmyPlugin;

typedef struct {
    MemmyPlugin *plugin;
    AuthorizationEngineRef engine;
    bool knownMechanism;
} MemmyMechanism;

static bool signedMemmyPeer(int descriptor) {
    pid_t pid = 0;
    socklen_t length = sizeof(pid);
    if (getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) != 0 || pid <= 0) return false;

    CFNumberRef pidValue = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &pid);
    if (!pidValue) return false;
    const void *keys[] = { kSecGuestAttributePid };
    const void *values[] = { pidValue };
    CFDictionaryRef attributes = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFRelease(pidValue);
    if (!attributes) return false;

    SecCodeRef code = NULL;
    OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
    CFRelease(attributes);
    if (status != errSecSuccess || !code) return false;

    CFStringRef requirementText = CFSTR(MEMMY_PEER_REQUIREMENT);
    SecRequirementRef requirement = NULL;
    status = SecRequirementCreateWithString(requirementText, kSecCSDefaultFlags, &requirement);
    if (status == errSecSuccess && requirement) {
        status = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
        CFRelease(requirement);
    }
    CFRelease(code);
    return status == errSecSuccess;
}

static bool brokerAllowsUnlock(void) {
    int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
    if (descriptor < 0) return false;
    bool allowed = false;
    do {
        int flags = fcntl(descriptor, F_GETFL, 0);
        if (flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) != 0) break;

        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        if (strlen(MEMMY_AUTH_SOCKET) >= sizeof(address.sun_path)) break;
        strlcpy(address.sun_path, MEMMY_AUTH_SOCKET, sizeof(address.sun_path));
        int result = connect(descriptor, (struct sockaddr *)&address, sizeof(address));
        if (result != 0 && errno != EINPROGRESS) break;

        struct pollfd pollfd = { .fd = descriptor, .events = POLLOUT };
        if (poll(&pollfd, 1, 700) != 1) break;
        int socketError = 0;
        socklen_t errorLength = sizeof(socketError);
        if (getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socketError, &errorLength) != 0 || socketError != 0) break;
        if (!signedMemmyPeer(descriptor)) break;

        if (write(descriptor, "V1\n", 3) != 3) break;
        pollfd.events = POLLIN;
        if (poll(&pollfd, 1, 700) != 1) break;
        char reply = 0;
        allowed = read(descriptor, &reply, 1) == 1 && reply == '1';
    } while (false);
    close(descriptor);
    return allowed;
}

static OSStatus pluginDestroy(AuthorizationPluginRef reference) {
    free(reference);
    return errSecSuccess;
}

static OSStatus mechanismCreate(AuthorizationPluginRef reference, AuthorizationEngineRef engine,
                                AuthorizationMechanismId identifier, AuthorizationMechanismRef *output) {
    if (!reference || !output) return errAuthorizationInternal;
    MemmyMechanism *mechanism = calloc(1, sizeof(*mechanism));
    if (!mechanism) return errAuthorizationInternal;
    mechanism->plugin = (MemmyPlugin *)reference;
    mechanism->engine = engine;
    mechanism->knownMechanism = identifier && strcmp(identifier, "allow") == 0;
    *output = mechanism;
    return errSecSuccess;
}

static OSStatus mechanismInvoke(AuthorizationMechanismRef reference) {
    MemmyMechanism *mechanism = (MemmyMechanism *)reference;
    if (!mechanism || !mechanism->plugin || !mechanism->plugin->callbacks) return errAuthorizationInternal;
    bool allowed = mechanism->knownMechanism && brokerAllowsUnlock();
    return mechanism->plugin->callbacks->SetResult(mechanism->engine,
        allowed ? kAuthorizationResultAllow : kAuthorizationResultDeny);
}

static OSStatus mechanismDeactivate(AuthorizationMechanismRef reference) {
    MemmyMechanism *mechanism = (MemmyMechanism *)reference;
    if (!mechanism || !mechanism->plugin || !mechanism->plugin->callbacks) return errAuthorizationInternal;
    return mechanism->plugin->callbacks->DidDeactivate(mechanism->engine);
}

static OSStatus mechanismDestroy(AuthorizationMechanismRef reference) {
    free(reference);
    return errSecSuccess;
}

static const AuthorizationPluginInterface interface = {
    .version = kAuthorizationPluginInterfaceVersion,
    .PluginDestroy = pluginDestroy,
    .MechanismCreate = mechanismCreate,
    .MechanismInvoke = mechanismInvoke,
    .MechanismDeactivate = mechanismDeactivate,
    .MechanismDestroy = mechanismDestroy,
};

OSStatus AuthorizationPluginCreate(const AuthorizationCallbacks *callbacks,
                                   AuthorizationPluginRef *output,
                                   const AuthorizationPluginInterface **outputInterface) {
    if (!callbacks || !output || !outputInterface) return errAuthorizationInternal;
    MemmyPlugin *plugin = calloc(1, sizeof(*plugin));
    if (!plugin) return errAuthorizationInternal;
    plugin->callbacks = callbacks;
    *output = plugin;
    *outputInterface = &interface;
    return errSecSuccess;
}
