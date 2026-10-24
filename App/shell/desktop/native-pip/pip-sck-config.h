#pragma once
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "pip-capture-plan.h"

namespace memmy_pip {
inline std::vector<CaptureWindowIdentity> readCaptureWindowIdentities() {
  CFArrayRef raw = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  std::vector<CaptureWindowIdentity> result;
  for (NSDictionary *record in (__bridge NSArray *)raw) {
    CGRect bounds = CGRectZero;
    NSDictionary *rectangle = record[(__bridge NSString *)kCGWindowBounds];
    if (![rectangle isKindOfClass:[NSDictionary class]]
        || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rectangle, &bounds)) bounds = CGRectZero;
    NSNumber *rawAlpha = record[(__bridge NSString *)kCGWindowAlpha];
    result.push_back({[record[(__bridge NSString *)kCGWindowNumber] unsignedIntValue],
      [record[(__bridge NSString *)kCGWindowOwnerPID] intValue],
      (bool)[record[(__bridge NSString *)kCGWindowIsOnscreen] boolValue],
      [record[(__bridge NSString *)kCGWindowLayer] intValue],
      {bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height},
      [rawAlpha isKindOfClass:[NSNumber class]] ? rawAlpha.doubleValue : 1});
  }
  if (raw) CFRelease(raw);
  return result;
}
inline bool captureWindowIdentity(std::uint32_t id, std::int32_t pid,
    const std::vector<CaptureWindowIdentity> &available, CGRect &bounds, BOOL &onScreen) {
  if (!id || pid <= 0) return false;
  unsigned matches = 0;
  const CaptureWindowIdentity *match = nullptr;
  for (const auto &window : available) if (window.id == id) { ++matches; match = &window; }
  if (matches != 1 || !match || match->pid != pid || !validCaptureRect(match->bounds)) return false;
  const auto rect = match->bounds;
  bounds = CGRectMake(rect.x, rect.y, rect.width, rect.height);
  onScreen = match->onScreen;
  return true;
}
inline bool readWindowCaptureIdentity(CGWindowID id, pid_t pid, CGRect &bounds, BOOL &onScreen) {
  return captureWindowIdentity(id, pid, readCaptureWindowIdentities(), bounds, onScreen);
}
// Select the exact root plus individually verified associations and overlays.
// includeChildWindows supplements this group; all PID windows are never selected.
inline SCContentFilter *configureWindowCapture(SCWindow *window, NSArray<SCDisplay *> *displays,
                                               SCStreamConfiguration *configuration,
                                               CapturePlan &plan, NSArray<SCWindow *> *associated = @[],
                                               CGRect verifiedBounds = CGRectNull, BOOL verifiedOnScreen = YES) {
  std::vector<CaptureDisplay> candidates;
  for (SCDisplay *display in displays) {
    const CGRect b = display.frame;
    candidates.push_back({display.displayID, {b.origin.x, b.origin.y, b.size.width, b.size.height},
      b.size.width > 0 ? display.width / b.size.width : 0});
  }
  const CGRect bounds = CGRectIsNull(verifiedBounds) ? window.frame : verifiedBounds;
  bool childCapture = false;
  if (@available(macOS 14.2, *)) childCapture = CGRectIsNull(verifiedBounds) ? window.isOnScreen : verifiedOnScreen;
  plan = capturePlan({bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height}, candidates, childCapture);
  SCContentFilter *filter = nil;
  if (@available(macOS 14.2, *)) {
    if (plan.includesChildren) {
      for (SCDisplay *display in displays) {
        if (display.displayID != plan.displayID) continue;
        NSMutableArray<SCWindow *> *windows = [NSMutableArray arrayWithObject:window];
        for (SCWindow *related in associated) {
          if (related.windowID == window.windowID || !related.isOnScreen
              || related.owningApplication.processID != window.owningApplication.processID) continue;
          [windows addObject:related];
        }
        filter = [[SCContentFilter alloc] initWithDisplay:display includingWindows:windows];
        configuration.includeChildWindows = YES;
        configuration.ignoreShadowsDisplay = YES;
        const auto rect = plan.sourceRect;
        configuration.sourceRect = CGRectMake(rect.x, rect.y, rect.width, rect.height);
        break;
      }
    }
  }
  if (!filter) {
    plan = {};
    filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    configuration.ignoreShadowsSingleWindow = YES;
  }
  const CGFloat defaultScale = NSScreen.mainScreen.backingScaleFactor;
  const double scale = plan.includesChildren ? plan.scale : defaultScale > 0 ? defaultScale : 2;
  configuration.width = (size_t)MAX(2, round(bounds.size.width * scale));
  configuration.height = (size_t)MAX(2, round(bounds.size.height * scale));
  return filter;
}
} // namespace memmy_pip
