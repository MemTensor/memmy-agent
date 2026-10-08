#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

// Maps Electron desktopCapturer window IDs to their owning application.
// Only metadata is emitted; video frames remain in the Electron capture stream.
int main(void) {
  @autoreleasepool {
    CFArrayRef raw = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
    NSArray<NSDictionary *> *windows = CFBridgingRelease(raw);
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
    for (NSDictionary *window in windows) {
      NSNumber *number = window[(NSString *)kCGWindowNumber];
      NSNumber *layer = window[(NSString *)kCGWindowLayer];
      NSNumber *pid = window[(NSString *)kCGWindowOwnerPID];
      NSString *owner = window[(NSString *)kCGWindowOwnerName];
      if (!number || !pid || !owner || layer.intValue != 0) continue;
      NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid.intValue];
      [rows addObject:@{
        @"id": number,
        @"owner": owner,
        @"bundleId": application.bundleIdentifier ?: @"",
        @"title": window[(NSString *)kCGWindowName] ?: @""
      }];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
    if (json) {
      fwrite(json.bytes, 1, json.length, stdout);
      fputc('\n', stdout);
    } else {
      puts("[]");
    }
  }
  return 0;
}
