#include "../../native/menu-bar-appearance.mm"
#include <cassert>

static unsigned notifications = 0;
napi_status napi_call_threadsafe_function(napi_threadsafe_function, void *, napi_threadsafe_function_call_mode) {
  ++notifications;
  return napi_ok;
}

@interface AppearanceTestButton : NSObject
@property(nonatomic, strong) NSAppearance *effectiveAppearance;
@end
@implementation AppearanceTestButton
@end

static void Bind(MemmyMenuBarAppearanceWatcher *observer, AppearanceTestButton *button) {
  [observer unwatch];
  observer.button = (NSStatusBarButton *)button;
  observer.lastMatch = AppearanceMatch(button.effectiveAppearance);
  observer.observing = YES;
  observer.callback = reinterpret_cast<napi_threadsafe_function>(1);
  [button addObserver:observer forKeyPath:@"effectiveAppearance" options:0 context:kMenuBarAppearanceContext];
}

static void Drain(void) {
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, false);
}

int main(void) {
  @autoreleasepool {
    NSAppearance *light = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    NSAppearance *dark = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    AppearanceTestButton *button = [AppearanceTestButton new];
    button.effectiveAppearance = light;
    MemmyMenuBarAppearanceWatcher *observer = [MemmyMenuBarAppearanceWatcher new];
    Bind(observer, button);

    // Snapshot drawing can temporarily alternate appearances without changing the final theme.
    for (unsigned i = 0; i < 100; ++i) {
      button.effectiveAppearance = dark;
      button.effectiveAppearance = light;
    }
    Drain();
    assert(notifications == 0);

    for (unsigned i = 0; i < 100; ++i) button.effectiveAppearance = dark;
    Drain();
    assert(notifications == 1);
    assert([observer.lastMatch isEqualToString:NSAppearanceNameDarkAqua]);
    button.effectiveAppearance = light;
    Drain();
    assert(notifications == 2);
    assert([observer.lastMatch isEqualToString:NSAppearanceNameAqua]);

    button.effectiveAppearance = dark;
    [observer unwatch];
    Drain();
    assert(notifications == 2);

    Bind(observer, button);
    button.effectiveAppearance = light;
    AppearanceTestButton *replacement = [AppearanceTestButton new];
    replacement.effectiveAppearance = light;
    Bind(observer, replacement);
    replacement.effectiveAppearance = dark;
    Drain();
    assert(notifications == 3);
    button.effectiveAppearance = dark;
    Drain();
    assert(notifications == 3);
    [observer unwatch];
  }
}
