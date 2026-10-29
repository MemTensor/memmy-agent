#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#include <cstdint>
#include <libproc.h>
#include <mutex>
#include <node_api.h>

// The menu bar can be dark while the app and AppleInterfaceStyle stay light,
// for example light mode over a dark wallpaper. The status button's effective
// appearance is the value AppKit actually uses to tint template icons.
static NSStatusBarButton *FindStatusBarButton(void) {
  for (NSWindow *window in NSApp.windows) {
    NSMutableArray<NSView *> *stack = [NSMutableArray array];
    if (window.contentView) [stack addObject:window.contentView];
    while (stack.count > 0) {
      NSView *view = stack.lastObject;
      [stack removeLastObject];
      if ([view isKindOfClass:[NSStatusBarButton class]]) return (NSStatusBarButton *)view;
      for (NSView *subview in view.subviews) [stack addObject:subview];
    }
  }
  return nil;
}

static NSString *AppearanceMatch(NSAppearance *appearance) {
  return [appearance bestMatchFromAppearancesWithNames:@[
    NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
}

static const char *AppearanceLabel(void) {
  NSStatusBarButton *button = FindStatusBarButton();
  if (!button) return "unknown";
  return [AppearanceMatch(button.effectiveAppearance) isEqualToString:NSAppearanceNameDarkAqua]
    ? "dark" : "light";
}

static void *const kMenuBarAppearanceContext = (void *)&kMenuBarAppearanceContext;

@interface MemmyMenuBarAppearanceWatcher : NSObject
@property(nonatomic, weak) NSStatusBarButton *button;
@property(nonatomic, copy) NSString *lastMatch;
@property(nonatomic) BOOL observing;
@property(nonatomic) napi_threadsafe_function callback;
@end

@implementation MemmyMenuBarAppearanceWatcher
- (void)observeValueForKeyPath:(NSString *)keyPath
                        ofObject:(id)object
                          change:(NSDictionary *)change
                         context:(void *)context {
  if (context != kMenuBarAppearanceContext) {
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
    return;
  }
  NSString *match = AppearanceMatch(self.button.effectiveAppearance);
  if (match == self.lastMatch || [match isEqualToString:self.lastMatch]) return;
  self.lastMatch = match;
  napi_threadsafe_function callback = self.callback;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (callback) napi_call_threadsafe_function(callback, nullptr, napi_tsfn_nonblocking);
  });
}

- (BOOL)rebind {
  NSStatusBarButton *button = FindStatusBarButton();
  if (self.observing && button == self.button) return button != nil;
  [self unwatch];
  if (!button) return NO;
  self.button = button;
  self.lastMatch = AppearanceMatch(button.effectiveAppearance);
  @try {
    [button addObserver:self forKeyPath:@"effectiveAppearance" options:0 context:kMenuBarAppearanceContext];
    self.observing = YES;
  } @catch (NSException *) {
    self.observing = NO;
    self.button = nil;
  }
  return YES;
}

- (void)unwatch {
  if (!self.observing) return;
  NSStatusBarButton *button = self.button;
  self.observing = NO;
  self.button = nil;
  if (button) [button removeObserver:self forKeyPath:@"effectiveAppearance" context:kMenuBarAppearanceContext];
}
@end

static MemmyMenuBarAppearanceWatcher *watcher;
static napi_threadsafe_function appearanceCallback = nullptr;

static void CallAppearanceCallback(napi_env env, napi_value jsCallback, void *, void *) {
  napi_value global;
  napi_get_global(env, &global);
  napi_value result;
  napi_call_function(env, global, jsCallback, 0, nullptr, &result);
}

static napi_value MenuBarAppearance(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_string_utf8(env, AppearanceLabel(), NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value WatchMenuBarButton(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (!watcher) watcher = [MemmyMenuBarAppearanceWatcher new];
  if (!watcher.callback && argc == 1) {
    napi_value name;
    napi_create_string_utf8(env, "menuBarAppearance", NAPI_AUTO_LENGTH, &name);
    napi_create_threadsafe_function(env, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
      CallAppearanceCallback, &appearanceCallback);
    watcher.callback = appearanceCallback;
  }
  bool attached = [watcher rebind];
  napi_value result;
  napi_get_boolean(env, attached, &result);
  return result;
}

static napi_value UnwatchMenuBarButton(napi_env env, napi_callback_info) {
  [watcher unwatch];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static NSString *AppleEventCode(OSType code) {
  char value[5] = {
    static_cast<char>((code >> 24) & 0xff), static_cast<char>((code >> 16) & 0xff),
    static_cast<char>((code >> 8) & 0xff), static_cast<char>(code & 0xff), '\0'
  };
  for (size_t index = 0; index < 4; ++index) {
    if (value[index] < 0x20 || value[index] > 0x7e) return @"unknown";
  }
  return [NSString stringWithUTF8String:value];
}

// Electron emits before-quit after AppKit has finished dispatching the quit
// Apple event. Snapshot its sender while the sender process is still available,
// then chain to AppKit's handler so normal quit behavior is unchanged.
static const CFTimeInterval kRecordedQuitEventMaxAge = 2.0;
static AEEventHandlerUPP previousQuitHandler = nullptr;
static SRefCon previousQuitRefcon = nullptr;
static BOOL quitEventObserverInstalled = NO;
static NSDictionary<NSString *, id> *recordedQuitContext;
static NSTimeInterval recordedQuitContextAt = 0;

// This notification is an additional veto, not the only system-quit signal:
// AppKit does not document its ordering relative to the quit Apple event, nor
// a cancellation notification. Bound its lifetime so a cancelled logout cannot
// suppress permission restarts for the rest of this process's lifetime.
static const NSTimeInterval kSystemSessionEndingMaxAge = 30.0;
static id systemSessionEndingObserver;
static BOOL systemSessionEndingObserverInstalled = NO;
static std::mutex systemSessionEndingMutex;
static NSTimeInterval systemSessionEndingAt = 0;
static uint32_t systemSessionEndingSequence = 0;

static NSDictionary<NSString *, id> *SnapshotQuitContext(NSAppleEventDescriptor *event) {
  if (!event || event.eventClass != kCoreEventClass || event.eventID != kAEQuitApplication) return nil;
  NSAppleEventDescriptor *senderDescriptor = [event attributeDescriptorForKeyword:keySenderPIDAttr];
  const pid_t senderPid = senderDescriptor ? senderDescriptor.int32Value : 0;
  NSRunningApplication *sender = senderPid > 0
    ? [NSRunningApplication runningApplicationWithProcessIdentifier:senderPid] : nil;
  NSString *senderExecutablePath = sender.executableURL.path;
  if (!senderExecutablePath && senderPid > 0) {
    char path[PROC_PIDPATHINFO_MAXSIZE] = {};
    if (proc_pidpath(senderPid, path, sizeof(path)) > 0) {
      senderExecutablePath = [NSString stringWithUTF8String:path];
    }
  }
  NSString *senderBundleId = sender.bundleIdentifier;
  // ExtensionKit processes are not always exposed as NSRunningApplication.
  // Resolve only the actual system privacy extension, never an arbitrary app.
  if (!senderBundleId && [senderExecutablePath isEqualToString:
      @"/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension"]) {
    senderBundleId = [NSBundle bundleWithPath:
      @"/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex"].bundleIdentifier;
  }
  NSAppleEventDescriptor *reason = [event attributeDescriptorForKeyword:kAEQuitReason]
    ?: [event paramDescriptorForKeyword:kAEQuitReason];
  // A present but unreadable reason must not become a missing reason.
  NSString *quitReason = reason ? AppleEventCode(reason.enumCodeValue) : nil;
  return @{
    @"eventClass": AppleEventCode(event.eventClass),
    @"eventId": AppleEventCode(event.eventID),
    @"senderBundleId": [senderBundleId copy] ?: NSNull.null,
    @"senderExecutablePath": [senderExecutablePath copy] ?: NSNull.null,
    @"quitReason": [quitReason copy] ?: NSNull.null,
  };
}

static void InstallSystemSessionEndingObserver(void) {
  if (systemSessionEndingObserverInstalled) return;
  @try {
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    systemSessionEndingObserver = [workspace.notificationCenter
      addObserverForName:NSWorkspaceWillPowerOffNotification object:workspace queue:nil
      usingBlock:^(NSNotification *) {
        const std::lock_guard<std::mutex> lock(systemSessionEndingMutex);
        systemSessionEndingAt = NSProcessInfo.processInfo.systemUptime;
        ++systemSessionEndingSequence;
      }];
    systemSessionEndingObserverInstalled = systemSessionEndingObserver != nil;
  } @catch (NSException *) {
    systemSessionEndingObserverInstalled = NO;
  }
}

static OSErr ObserveQuitAppleEvent(const AppleEvent *event, AppleEvent *reply, SRefCon) {
  // Clear even if duplication or sender lookup fails; do not reuse an older quit.
  recordedQuitContext = nil;
  @try {
    AEDesc copy;
    if (AEDuplicateDesc(event, &copy) == noErr) {
      NSAppleEventDescriptor *descriptor = [[NSAppleEventDescriptor alloc] initWithAEDescNoCopy:&copy];
      recordedQuitContext = SnapshotQuitContext(descriptor);
      recordedQuitContextAt = NSProcessInfo.processInfo.systemUptime;
    }
  } @catch (NSException *) {
    recordedQuitContext = nil;
  }
  if (!previousQuitHandler) return errAEEventNotHandled;
  return InvokeAEEventHandlerUPP(event, reply, previousQuitRefcon, previousQuitHandler);
}

// Call after AppKit finished launching; it installs the quit handler being chained.
static napi_value InstallQuitEventObserver(napi_env env, napi_callback_info) {
  if ([NSThread isMainThread]) {
    InstallSystemSessionEndingObserver();
  }
  if ([NSThread isMainThread] && !quitEventObserverInstalled) {
    AEEventHandlerUPP handler = nullptr;
    SRefCon refcon = nullptr;
    if (AEGetEventHandler(kCoreEventClass, kAEQuitApplication, &handler, &refcon, false) == noErr
        && handler != ObserveQuitAppleEvent) {
      previousQuitHandler = handler;
      previousQuitRefcon = refcon;
      quitEventObserverInstalled = AEInstallEventHandler(kCoreEventClass, kAEQuitApplication,
        ObserveQuitAppleEvent, nullptr, false) == noErr;
    }
  }
  napi_value result;
  napi_get_boolean(env, quitEventObserverInstalled, &result);
  return result;
}

static NSDictionary<NSString *, id> *TakeQuitContext(void) {
  NSDictionary<NSString *, id> *recorded = recordedQuitContext;
  const NSTimeInterval age = NSProcessInfo.processInfo.systemUptime - recordedQuitContextAt;
  const BOOL recordedIsFresh = recorded && age >= 0 && age <= kRecordedQuitEventMaxAge;
  recordedQuitContext = nil;
  recordedQuitContextAt = 0;
  if (recordedIsFresh) return recorded;
  // Once the observer is installed, only its single-use snapshot is accepted.
  // Rereading currentAppleEvent could consume the same in-flight event twice.
  if (quitEventObserverInstalled) return nil;
  return SnapshotQuitContext(NSAppleEventManager.sharedAppleEventManager.currentAppleEvent);
}

// Each recorded quit event is consumed by the first read, so a later plain Quit
// cannot inherit a System Settings sender.
static napi_value ReadCurrentQuitContext(napi_env env, napi_callback_info) {
  napi_value empty;
  napi_get_null(env, &empty);
  if (![NSThread isMainThread]) return empty;
  @try {
    NSDictionary<NSString *, id> *context = TakeQuitContext();
    if (!context) return empty;
    napi_value result;
    napi_create_object(env, &result);
    for (NSString *key in context) {
      napi_value property;
      id value = context[key];
      if ([value isKindOfClass:NSString.class]) {
        napi_create_string_utf8(env, [value UTF8String], NAPI_AUTO_LENGTH, &property);
      } else {
        napi_get_null(env, &property);
      }
      napi_set_named_property(env, result, key.UTF8String, property);
    }
    return result;
  } @catch (NSException *) {
    return empty;
  }
}

static napi_value ReadSystemSessionEnding(napi_env env, napi_callback_info) {
  BOOL ending = YES;
  if ([NSThread isMainThread] && systemSessionEndingObserverInstalled) {
    NSTimeInterval observedAt;
    {
      const std::lock_guard<std::mutex> lock(systemSessionEndingMutex);
      observedAt = systemSessionEndingAt;
    }
    const NSTimeInterval age = NSProcessInfo.processInfo.systemUptime - observedAt;
    ending = observedAt > 0 && (age < 0 || age <= kSystemSessionEndingMaxAge);
  }
  napi_value result;
  napi_get_boolean(env, ending, &result);
  return result;
}

// Preserve the reason for the veto. A notification already present when a
// verified permission quit arrives must be distinguishable from one that
// arrives later during cleanup (an actual session termination).
static napi_value ReadSystemSessionEndingState(napi_env env, napi_callback_info) {
  const BOOL mainThread = [NSThread isMainThread];
  NSTimeInterval observedAt;
  uint32_t sequence;
  {
    const std::lock_guard<std::mutex> lock(systemSessionEndingMutex);
    observedAt = systemSessionEndingAt;
    sequence = systemSessionEndingSequence;
  }
  const NSTimeInterval age = NSProcessInfo.processInfo.systemUptime - observedAt;
  const BOOL notificationRecent = observedAt > 0 && (age < 0 || age <= kSystemSessionEndingMaxAge);
  napi_value result;
  napi_create_object(env, &result);
  napi_value value;
  napi_get_boolean(env, mainThread, &value);
  napi_set_named_property(env, result, "mainThread", value);
  napi_get_boolean(env, systemSessionEndingObserverInstalled, &value);
  napi_set_named_property(env, result, "observerInstalled", value);
  napi_get_boolean(env, notificationRecent, &value);
  napi_set_named_property(env, result, "notificationRecent", value);
  napi_create_uint32(env, sequence, &value);
  napi_set_named_property(env, result, "notificationSequence", value);
  if (observedAt > 0) napi_create_double(env, age * 1000, &value);
  else napi_get_null(env, &value);
  napi_set_named_property(env, result, "notificationAgeMs", value);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"menuBarAppearance", nullptr, MenuBarAppearance, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"watchMenuBarButton", nullptr, WatchMenuBarButton, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unwatchMenuBarButton", nullptr, UnwatchMenuBarButton, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readCurrentQuitContext", nullptr, ReadCurrentQuitContext, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"installQuitEventObserver", nullptr, InstallQuitEventObserver, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readSystemSessionEnding", nullptr, ReadSystemSessionEnding, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readSystemSessionEndingState", nullptr, ReadSystemSessionEndingState, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
