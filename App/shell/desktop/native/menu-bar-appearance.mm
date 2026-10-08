#import <AppKit/AppKit.h>
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"menuBarAppearance", nullptr, MenuBarAppearance, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"watchMenuBarButton", nullptr, WatchMenuBarButton, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unwatchMenuBarButton", nullptr, UnwatchMenuBarButton, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
