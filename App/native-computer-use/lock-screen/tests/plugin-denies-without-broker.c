#include <Security/AuthorizationPlugin.h>
#include <Security/SecBase.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>

static AuthorizationResult observed = kAuthorizationResultUndefined;
static OSStatus setResult(AuthorizationEngineRef engine, AuthorizationResult result) {
    (void)engine;
    observed = result;
    return errSecSuccess;
}
static OSStatus deactivate(AuthorizationEngineRef engine) {
    (void)engine;
    return errSecSuccess;
}

int main(void) {
    AuthorizationCallbacks callbacks = {0};
    callbacks.version = kAuthorizationCallbacksVersion;
    callbacks.SetResult = setResult;
    callbacks.DidDeactivate = deactivate;
    AuthorizationPluginRef plugin = NULL;
    const AuthorizationPluginInterface *interface = NULL;
    assert(AuthorizationPluginCreate(&callbacks, &plugin, &interface) == errSecSuccess);
    assert(plugin != NULL && interface != NULL);
    AuthorizationMechanismRef mechanism = NULL;
    AuthorizationEngineRef engine = (AuthorizationEngineRef)(uintptr_t)1;
    assert(interface->MechanismCreate(plugin, engine, "allow", &mechanism) == errSecSuccess);
    assert(interface->MechanismInvoke(mechanism) == errSecSuccess);
    assert(observed == kAuthorizationResultDeny);
    assert(interface->MechanismDestroy(mechanism) == errSecSuccess);
    assert(interface->PluginDestroy(plugin) == errSecSuccess);
    puts("authorization plugin denied without signed broker");
}
