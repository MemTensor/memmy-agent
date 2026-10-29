#ifndef MEMMY_FOCUS_GUARD_IDENTITY_TEST
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/IOKitLib.h>
#import <dlfcn.h>
#endif
#import <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  double x, y, width, height;
  bool valid;
} MemmyWindowBounds;

typedef struct {
  int32_t pid;
  uint32_t windowID;
  MemmyWindowBounds bounds;
} MemmyCGWindowIdentity;

typedef struct {
  // Zero means the native identity could not be read, not a wildcard ID.
  uint32_t nativeWindowID;
  MemmyWindowBounds bounds;
} MemmyAXWindowIdentity;

static bool memmySameWindowBounds(MemmyWindowBounds a, MemmyWindowBounds b) {
  return a.valid && b.valid && isfinite(a.x) && isfinite(a.y)
    && isfinite(a.width) && isfinite(a.height) && isfinite(b.x) && isfinite(b.y)
    && isfinite(b.width) && isfinite(b.height) && a.width > 0 && a.height > 0
    && b.width > 0 && b.height > 0
    && fabs(a.x - b.x) <= 1 && fabs(a.y - b.y) <= 1
    && fabs(a.width - b.width) <= 1 && fabs(a.height - b.height) <= 1;
}

// Pure identity selection, also compiled as C by the injected-record test.
// A known AX ID can never be replaced by a coincident window's geometry.
static int memmyResolveAXWindowIndex(int32_t pid, uint32_t windowID,
  const MemmyCGWindowIdentity *cg, size_t cgCount,
  const MemmyAXWindowIdentity *ax, size_t axCount) {
  if (pid <= 0 || windowID == 0) return -1;
  const MemmyCGWindowIdentity *wanted = NULL;
  size_t ownedTargets = 0;
  for (size_t i = 0; i < cgCount; i++) {
    if (cg[i].pid == pid && cg[i].windowID == windowID) {
      wanted = &cg[i]; ownedTargets++;
    }
  }
  if (ownedTargets != 1) return -1;
  int knownMatch = -1;
  size_t knownMatches = 0;
  for (size_t i = 0; i < axCount; i++) {
    if (ax[i].nativeWindowID == windowID) { knownMatch = (int)i; knownMatches++; }
  }
  if (knownMatches > 0) return knownMatches == 1 ? knownMatch : -1;

  size_t geometryCGMatches = 0;
  for (size_t i = 0; i < cgCount; i++) {
    if (cg[i].pid == pid && memmySameWindowBounds(cg[i].bounds, wanted->bounds))
      geometryCGMatches++;
  }
  if (geometryCGMatches != 1) return -1;
  int fallback = -1;
  size_t fallbackMatches = 0;
  for (size_t i = 0; i < axCount; i++) {
    if (ax[i].nativeWindowID == 0 && memmySameWindowBounds(ax[i].bounds, wanted->bounds)) {
      fallback = (int)i; fallbackMatches++;
    }
  }
  return fallbackMatches == 1 ? fallback : -1;
}

#ifndef MEMMY_FOCUS_GUARD_IDENTITY_TEST

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
  return memmySameWindowBounds((MemmyWindowBounds){ a.origin.x, a.origin.y, a.size.width, a.size.height, true },
    (MemmyWindowBounds){ b.origin.x, b.origin.y, b.size.width, b.size.height, true });
}

static CGWindowID nativeAXWindowID(AXUIElementRef window) {
  typedef AXError (*GetWindow)(AXUIElementRef, CGWindowID *);
  GetWindow getWindow = (GetWindow)dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
  CGWindowID windowID = 0;
  return getWindow && getWindow(window, &windowID) == kAXErrorSuccess ? windowID : 0;
}

// Hidden windows need the complete CG inventory. A same-size visible sibling
// cannot stand in for a target that is absent from the AX window list.
static AXUIElementRef copyWindowForID(pid_t pid, CGWindowID windowID) {
  CFArrayRef descriptions = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  if (!descriptions) return NULL;
  size_t cgCapacity = (size_t)CFArrayGetCount(descriptions);
  MemmyCGWindowIdentity *cg = calloc(cgCapacity ?: 1, sizeof(*cg));
  if (!cg) { CFRelease(descriptions); return NULL; }
  size_t cgCount = 0;
  for (NSDictionary *description in (__bridge NSArray *)descriptions) {
    NSNumber *number = description[(id)kCGWindowNumber];
    NSNumber *owner = description[(id)kCGWindowOwnerPID];
    if (!number || !owner || owner.intValue != pid) continue;
    CGRect bounds = CGRectNull;
    NSDictionary *rawBounds = description[(id)kCGWindowBounds];
    BOOL valid = rawBounds && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rawBounds, &bounds);
    cg[cgCount++] = (MemmyCGWindowIdentity){ owner.intValue, number.unsignedIntValue,
      { bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height, valid } };
  }
  CFRelease(descriptions);
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  CFTypeRef value = NULL;
  AXError error = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute, &value);
  CFRelease(appElement);
  if (error != kAXErrorSuccess || !value || CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value) CFRelease(value);
    free(cg);
    return NULL;
  }
  size_t axCapacity = (size_t)CFArrayGetCount((CFArrayRef)value);
  MemmyAXWindowIdentity *ax = calloc(axCapacity ?: 1, sizeof(*ax));
  AXUIElementRef *elements = calloc(axCapacity ?: 1, sizeof(*elements));
  if (!ax || !elements) {
    free(cg); free(ax); free(elements); CFRelease(value); return NULL;
  }
  size_t axCount = 0;
  for (id candidate in (__bridge NSArray *)value) {
    if (CFGetTypeID((__bridge CFTypeRef)candidate) != AXUIElementGetTypeID()) continue;
    AXUIElementRef element = (__bridge AXUIElementRef)candidate;
    CGRect bounds = CGRectNull;
    BOOL valid = boundsForAXWindow(element, &bounds);
    elements[axCount] = element;
    ax[axCount++] = (MemmyAXWindowIdentity){ nativeAXWindowID(element),
      { bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height, valid } };
  }
  int index = memmyResolveAXWindowIndex(pid, windowID, cg, cgCount, ax, axCount);
  AXUIElementRef match = index >= 0 ? elements[index] : NULL;
  if (match) CFRetain(match);
  free(cg); free(ax); free(elements);
  CFRelease(value);
  return match;
}

static CGWindowID focusedWindowID(pid_t pid) {
  if (pid <= 0) return 0;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFTypeRef focused = NULL;
  AXError error = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &focused);
  CFRelease(app);
  CGRect wanted = CGRectNull;
  BOOL valid = error == kAXErrorSuccess && focused
    && CFGetTypeID(focused) == AXUIElementGetTypeID()
    && boundsForAXWindow((AXUIElementRef)focused, &wanted);
  if (focused) CFRelease(focused);
  if (!valid) return 0;
  CFArrayRef descriptions = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (!descriptions) return 0;
  CGWindowID match = 0;
  NSUInteger matches = 0;
  for (NSDictionary *description in (__bridge NSArray *)descriptions) {
    if ([description[(id)kCGWindowOwnerPID] intValue] != pid
        || [description[(id)kCGWindowLayer] intValue] != 0) continue;
    CGRect bounds;
    NSDictionary *rawBounds = description[(id)kCGWindowBounds];
    if (rawBounds && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rawBounds, &bounds)
        && sameWindowBounds(bounds, wanted)) {
      match = [description[(id)kCGWindowNumber] unsignedIntValue];
      matches++;
    }
  }
  CFRelease(descriptions);
  // Refuse ambiguous geometry instead of declaring another document safe.
  return matches == 1 ? match : 0;
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
        @"windowId": @(focusedWindowID(front.processIdentifier)),
      });
      return 0;
    }
    if (argc == 6 && strcmp(argv[1], "restore-window") == 0) {
      pid_t prior = (pid_t)atoi(argv[2]);
      CGWindowID priorWindow = (CGWindowID)strtoul(argv[3], NULL, 10);
      pid_t expected = (pid_t)atoi(argv[4]);
      CGWindowID expectedWindow = (CGWindowID)strtoul(argv[5], NULL, 10);
      NSRunningApplication *current = NSWorkspace.sharedWorkspace.frontmostApplication;
      BOOL safe = prior > 0 && priorWindow > 0 && expected > 0 && expectedWindow > 0
        && current.processIdentifier == expected && focusedWindowID(expected) == expectedWindow
        && inputIdle() > 0.3;
      NSRunningApplication *target = safe
        ? [NSRunningApplication runningApplicationWithProcessIdentifier:prior] : nil;
      AXUIElementRef window = target ? copyWindowForID(prior, priorWindow) : NULL;
      BOOL restored = NO;
      // AX enumeration can be slow. Recheck the foreground and input clock
      // immediately before restoring, so user input during lookup wins.
      if (target && window && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == expected
          && focusedWindowID(expected) == expectedWindow && inputIdle() > 0.3) {
        BOOL activated = [target activateWithOptions:0];
        AXError raised = AXUIElementPerformAction(window, kAXRaiseAction);
        restored = activated && raised == kAXErrorSuccess;
      }
      if (window) CFRelease(window);
      emit(@{ @"restored": @(restored) });
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
    fputs("Usage: focus-guard snapshot | restore <prior-pid> <expected-pid> | restore-window <prior-pid> <prior-window> <expected-pid> <expected-window> | reveal <pid> | reveal-window <pid> <window-id>\n", stderr);
  }
  return 2;
}
#endif
