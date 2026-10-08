#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/IOKitLib.h>
#import <math.h>

static double inputIdle(void) {
  mach_port_t port;
  if (@available(macOS 12.0, *)) port = kIOMainPortDefault;
  else port = kIOMasterPortDefault;
  io_service_t service = IOServiceGetMatchingService(port, IOServiceMatching("IOHIDSystem"));
  if (!service) return 1000000;
  CFTypeRef raw = IORegistryEntryCreateCFProperty(service, CFSTR("HIDIdleTime"), kCFAllocatorDefault, 0);
  IOObjectRelease(service);
  int64_t nanoseconds = 0;
  if (raw && CFGetTypeID(raw) == CFNumberGetTypeID())
    CFNumberGetValue((CFNumberRef)raw, kCFNumberSInt64Type, &nanoseconds);
  if (raw) CFRelease(raw);
  double seconds = (double)nanoseconds / 1000000000.0;
  return isfinite(seconds) && seconds >= 0 ? fmin(seconds, 1000000) : 1000000;
}

static void emit(id value) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (!json) { puts("{}"); return; }
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
}

static BOOL boundsForAXWindow(AXUIElementRef window, CGRect *bounds) {
  CFTypeRef position = NULL, size = NULL;
  AXError positionError = AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &position);
  AXError sizeError = AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &size);
  CGPoint origin = CGPointZero;
  CGSize dimensions = CGSizeZero;
  BOOL valid = positionError == kAXErrorSuccess && sizeError == kAXErrorSuccess
    && position && size && CFGetTypeID(position) == AXValueGetTypeID()
    && CFGetTypeID(size) == AXValueGetTypeID()
    && AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &origin)
    && AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &dimensions);
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  if (valid) *bounds = (CGRect){ origin, dimensions };
  return valid;
}

static BOOL sameWindowBounds(CGRect a, CGRect b) {
  return fabs(a.origin.x - b.origin.x) <= 3 && fabs(a.origin.y - b.origin.y) <= 3
    && fabs(a.size.width - b.size.width) <= 3 && fabs(a.size.height - b.size.height) <= 3;
}

// CGWindowID is not a public AX window attribute. Match the exact CG window's
// owner and bounds against AX windows, and refuse ties instead of raising another document.
static AXUIElementRef copyWindowForID(pid_t pid, CGWindowID windowID) {
  CFArrayRef descriptions = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowID);
  if (!descriptions) return NULL;
  CGRect wanted = CGRectNull;
  for (NSDictionary *description in (__bridge NSArray *)descriptions) {
    NSNumber *number = description[(id)kCGWindowNumber];
    NSNumber *owner = description[(id)kCGWindowOwnerPID];
    NSDictionary *bounds = description[(id)kCGWindowBounds];
    if (number.unsignedIntValue == windowID && owner.intValue == pid && bounds)
      CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &wanted);
  }
  CFRelease(descriptions);
  if (CGRectIsNull(wanted)) return NULL;
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute, &value);
  CFRelease(appElement);
  if (error != kAXErrorSuccess || !value || CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value) CFRelease(value);
    return NULL;
  }
  AXUIElementRef match = NULL;
  NSUInteger matches = 0;
  for (id candidate in (__bridge NSArray *)value) {
    if (CFGetTypeID((__bridge CFTypeRef)candidate) != AXUIElementGetTypeID()) continue;
    CGRect bounds;
    if (boundsForAXWindow((__bridge AXUIElementRef)candidate, &bounds) && sameWindowBounds(bounds, wanted)) {
      match = (__bridge AXUIElementRef)candidate;
      matches++;
    }
  }
  if (matches == 1) CFRetain(match);
  else match = NULL;
  CFRelease(value);
  return match;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc >= 2 && strcmp(argv[1], "snapshot") == 0) {
      NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
      emit(@{
        @"pid": @(front.processIdentifier),
        @"name": front.localizedName ?: @"",
        @"bundleId": front.bundleIdentifier ?: @"",
        @"inputIdle": @(inputIdle()),
      });
      return 0;
    }
    if (argc == 4 && strcmp(argv[1], "restore") == 0) {
      pid_t prior = (pid_t)atoi(argv[2]);
      pid_t expected = (pid_t)atoi(argv[3]);
      NSRunningApplication *current = NSWorkspace.sharedWorkspace.frontmostApplication;
      BOOL safe = prior > 0 && expected > 0 && current.processIdentifier == expected
        && inputIdle() > 0.3;
      NSRunningApplication *target = safe ? [NSRunningApplication runningApplicationWithProcessIdentifier:prior] : nil;
      BOOL restored = target ? [target activateWithOptions:0] : NO;
      emit(@{ @"restored": @(restored) });
      return 0;
    }
    if (argc == 3 && strcmp(argv[1], "reveal") == 0) {
      pid_t pid = (pid_t)atoi(argv[2]);
      NSRunningApplication *target = pid > 0
        ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
      BOOL success = NO;
      if (target) {
        [target unhide];
        AXUIElementRef appElement = AXUIElementCreateApplication(pid);
        AXUIElementSetAttributeValue(appElement, kAXHiddenAttribute, kCFBooleanFalse);
        CFRelease(appElement);
        success = [target activateWithOptions:0];
      }
      emit(@{ @"success": @(success), @"hidden": @(target.hidden), @"active": @(target.active) });
      return 0;
    }
    if (argc == 4 && strcmp(argv[1], "reveal-window") == 0) {
      pid_t pid = (pid_t)atoi(argv[2]);
      CGWindowID windowID = (CGWindowID)strtoul(argv[3], NULL, 10);
      NSRunningApplication *target = pid > 0 && windowID > 0
        ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
      AXUIElementRef window = target ? copyWindowForID(pid, windowID) : NULL;
      BOOL success = NO;
      if (target && window) {
        [target unhide];
        AXUIElementRef appElement = AXUIElementCreateApplication(pid);
        AXUIElementSetAttributeValue(appElement, kAXHiddenAttribute, kCFBooleanFalse);
        BOOL activated = [target activateWithOptions:0];
        AXError raised = AXUIElementPerformAction(window, kAXRaiseAction);
        if (raised == kAXErrorSuccess)
          AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute, window);
        success = activated && raised == kAXErrorSuccess;
        CFRelease(appElement);
      }
      if (window) CFRelease(window);
      emit(@{ @"success": @(success), @"matched": @(window != NULL), @"active": @(target.active) });
      return 0;
    }
    fputs("Usage: focus-guard snapshot | restore <prior-pid> <expected-pid> | reveal <pid> | reveal-window <pid> <window-id>\n", stderr);
  }
  return 2;
}
