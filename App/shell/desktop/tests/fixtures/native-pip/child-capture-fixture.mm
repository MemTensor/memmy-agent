#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <cstdio>
#include <vector>
#include "pip-sck-config.h"

// Opt-in isolated acceptance: only these nonactivating fixture windows are
// created. Preflight precedes AppKit/window creation and never requests TCC.
static bool waitFor(BOOL (^predicate)(void), double timeout) {
  const double deadline = NSDate.timeIntervalSinceReferenceDate + timeout;
  while (!predicate() && NSDate.timeIntervalSinceReferenceDate < deadline)
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  return predicate();
}

@interface FixtureOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) CIContext *context;
@property(nonatomic) BOOL verified;
@property(nonatomic) BOOL failed;
@property(nonatomic) BOOL expectChild;
@property(nonatomic) size_t redPixels;
@property(nonatomic) size_t bluePixels;
@property(nonatomic) size_t greenPixels;
@property(nonatomic) size_t yellowPixels;
@end
@implementation FixtureOutput
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  dispatch_async(dispatch_get_main_queue(), ^{ self.failed = YES; });
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeScreen) return;
  CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
  if (!pixels) return;
  @autoreleasepool {
    CIImage *image = [CIImage imageWithCVPixelBuffer:pixels];
    CGImageRef frame = [_context createCGImage:image fromRect:image.extent];
    if (!frame) return;
    const size_t width = CGImageGetWidth(frame), height = CGImageGetHeight(frame);
    std::vector<unsigned char> rgba(width * height * 4);
    CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
    CGContextRef bitmap = CGBitmapContextCreate(rgba.data(), width, height, 8, width * 4, color,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(color);
    if (!bitmap) { CGImageRelease(frame); return; }
    CGContextDrawImage(bitmap, CGRectMake(0, 0, width, height), frame);
    CGContextRelease(bitmap);
    CGImageRelease(frame);
    size_t red = 0, blue = 0, green = 0, yellow = 0;
    for (size_t i = 0; i < rgba.size(); i += 4) {
      if (rgba[i] > 200 && rgba[i+1] < 40 && rgba[i+2] < 40) ++red;
      if (rgba[i+2] > 200 && rgba[i] < 40 && rgba[i+1] < 40) ++blue;
      if (rgba[i+1] > 200 && rgba[i] < 40 && rgba[i+2] < 40) ++green;
      if (rgba[i] > 200 && rgba[i+1] > 200 && rgba[i+2] < 40) ++yellow;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      self.redPixels = red; self.bluePixels = blue; self.greenPixels = green;
      self.yellowPixels = yellow;
      self.verified = red > width * height / 2 && green == 0 && (self.expectChild ? blue > 500 && yellow > 500 : blue == 0);
    });
  }
}
@end

static NSPanel *panel(NSRect rect, NSColor *color, NSString *title) {
  NSPanel *window = [[NSPanel alloc] initWithContentRect:rect styleMask:NSWindowStyleMaskNonactivatingPanel
    backing:NSBackingStoreBuffered defer:NO];
  window.title = title;
  window.backgroundColor = color;
  window.opaque = YES;
  window.hasShadow = NO;
  window.hidesOnDeactivate = NO;
  window.releasedWhenClosed = NO;
  [window orderFrontRegardless];
  return window;
}

static bool capture(NSPanel *root, NSPanel *popup, NSPanel *child, bool children, bool explicitChild, const char *stage) {
  __block SCShareableContent *content = nil;
  __block NSError *contentError = nil;
  __block BOOL resolved = NO;
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
    completionHandler:^(SCShareableContent *value, NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{ content = value; contentError = error; resolved = YES; });
    }];
  if (!waitFor(^BOOL { return resolved; }, 4) || contentError || !content) {
    printf("FAIL %s stage=shareable-content code=%ld\n", stage, (long)(contentError ? contentError.code : 0));
    fflush(stdout); return false;
  }
  SCWindow *target = nil;
  SCWindow *associated = nil;
  SCWindow *childTarget = nil;
  for (SCWindow *window in content.windows) {
    if (window.windowID == root.windowNumber && window.owningApplication.processID == NSProcessInfo.processInfo.processIdentifier)
      target = window;
    if (window.windowID == popup.windowNumber && window.owningApplication.processID == NSProcessInfo.processInfo.processIdentifier)
      associated = window;
    if (window.windowID == child.windowNumber && window.owningApplication.processID == NSProcessInfo.processInfo.processIdentifier)
      childTarget = window;
  }
  if (!target || !associated || !childTarget) {
    printf("FAIL %s stage=fixture-window-identity\n", stage); fflush(stdout); return false;
  }
  CGRect rootBounds = CGRectZero; BOOL rootOnScreen = NO;
  if (!memmy_pip::readWindowCaptureIdentity(target.windowID, NSProcessInfo.processInfo.processIdentifier, rootBounds, rootOnScreen)) {
    printf("FAIL %s stage=cg-window-identity\n", stage); fflush(stdout); return false;
  }
  printf("GEOMETRY %s childInsideRoot=%d childOnScreen=%d parentLinked=%d root=%.0f,%.0f,%.0f,%.0f child=%.0f,%.0f,%.0f,%.0f\n", stage,
    CGRectContainsRect(target.frame, childTarget.frame), childTarget.isOnScreen, child.parentWindow == root,
    target.frame.origin.x, target.frame.origin.y, target.frame.size.width, target.frame.size.height,
    childTarget.frame.origin.x, childTarget.frame.origin.y, childTarget.frame.size.width, childTarget.frame.size.height);
  fflush(stdout);
  SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
  memmy_pip::CapturePlan plan;
  NSArray<SCWindow *> *group = !children ? @[] : explicitChild ? @[associated, childTarget] : @[associated];
  SCContentFilter *filter = memmy_pip::configureWindowCapture(target, content.displays, configuration, plan, group, rootBounds, rootOnScreen);
  if (!plan.includesChildren) {
    printf("FAIL %s stage=display-plan rootOnScreen=%d cgRoot=%.0f,%.0f,%.0f,%.0f displays=%lu\n", stage,
      rootOnScreen, rootBounds.origin.x, rootBounds.origin.y, rootBounds.size.width, rootBounds.size.height, (unsigned long)content.displays.count);
    for (SCDisplay *display in content.displays) printf("DISPLAY id=%u rect=%.0f,%.0f,%.0f,%.0f\n", display.displayID,
      display.frame.origin.x, display.frame.origin.y, display.frame.size.width, display.frame.size.height);
    fflush(stdout); return false;
  }
  if (!children) {
    // The public child switch is supported for display-window capture. The
    // old independent-window control yielded no pixels when forcing it off.
    if (@available(macOS 14.2, *)) configuration.includeChildWindows = NO;
  }
  configuration.showsCursor = NO;
  configuration.pixelFormat = kCVPixelFormatType_32BGRA;
  configuration.minimumFrameInterval = CMTimeMake(1, 10);
  configuration.queueDepth = 3;
  FixtureOutput *output = [[FixtureOutput alloc] init];
  output.context = [CIContext contextWithOptions:nil];
  output.expectChild = children;
  SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:output];
  NSError *addError = nil;
  if (![stream addStreamOutput:output type:SCStreamOutputTypeScreen
      sampleHandlerQueue:dispatch_queue_create("memmy.pip.child.fixture", DISPATCH_QUEUE_SERIAL) error:&addError]) return false;
  [stream startCaptureWithCompletionHandler:^(NSError *error) {
    if (error) dispatch_async(dispatch_get_main_queue(), ^{ output.failed = YES; });
  }];
  const bool success = waitFor(^BOOL { return output.verified || output.failed; }, 4) && output.verified;
  [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:nil];
  __block BOOL stopped = NO;
  [stream stopCaptureWithCompletionHandler:^(NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{ stopped = YES; });
  }];
  waitFor(^BOOL { return stopped; }, 2);
  printf("%s %s red=%zu associatedBlue=%zu unrelatedGreen=%zu childYellow=%zu\n", success ? "PASS" : "FAIL", stage,
    output.redPixels, output.bluePixels, output.greenPixels, output.yellowPixels);
  fflush(stdout);
  return success;
}

int main() {
  @autoreleasepool {
    if (!CGPreflightScreenCaptureAccess()) {
      printf("SKIP screen-recording-unavailable; no windows created or permission requested\n");
      return 77;
    }
    if (@available(macOS 14.2, *)) {} else { printf("SKIP macOS-14.2-required\n"); return 77; }
    [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyProhibited];
    const pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    const NSRect screen = NSScreen.screens.firstObject.visibleFrame;
    NSPanel *root = panel(NSMakeRect(NSMinX(screen) + 100, NSMinY(screen) + 100, 400, 280), NSColor.redColor, @"Memmy isolated capture root");
    NSPanel *unrelated = panel(NSMakeRect(NSMinX(root.frame) + 20, NSMinY(root.frame) + 20, 80, 80), NSColor.greenColor, @"Memmy isolated unrelated document");
    NSPanel *child = panel(NSMakeRect(NSMinX(root.frame) + 110, NSMinY(root.frame) + 180, 70, 60), NSColor.yellowColor, @"Memmy isolated child menu");
    [root addChildWindow:child ordered:NSWindowAbove];
    NSPanel *popup = panel(NSMakeRect(NSMinX(root.frame) + 200, NSMinY(root.frame) + 130, 140, 100), NSColor.blueColor, @"Memmy isolated associated popup");
    [root displayIfNeeded]; [child displayIfNeeded]; [popup displayIfNeeded]; [unrelated displayIfNeeded];
    const double settled = NSDate.timeIntervalSinceReferenceDate + 0.2;
    waitFor(^BOOL { return NSDate.timeIntervalSinceReferenceDate >= settled; }, 0.3);
    bool success = false;
    @try {
      success = capture(root, popup, child, false, false, "display-root-only-excludes-associated-popup-and-other-document");
      // Record public auto-child behavior separately: only the explicit group
      // path is the reliable ownership contract used for known associated IDs.
      const bool autoChild = capture(root, popup, child, true, false, "auto-child-supplement-probe");
      printf("OBSERVATION automatic-child-supplement=%s\n", autoChild ? "present" : "absent");
      success = capture(root, popup, child, true, true, "explicit-related-popup-and-child-exclude-other-document") && success;
      if (success) {
        [root setFrameOrigin:NSMakePoint(NSMinX(root.frame) + 30, NSMinY(root.frame) + 20)];
        success = capture(root, popup, child, true, true, "moved-root-recomputes-crop");
      }
      if (success) {
        NSRect resized = root.frame; resized.size = NSMakeSize(450, 320);
        [root setFrame:resized display:YES];
        // Re-establish the fixture's child position after AppKit adjusts child
        // geometry during a parent resize. This is only our own test window.
        [child setFrameOrigin:NSMakePoint(NSMinX(root.frame) + 110, NSMinY(root.frame) + 180)];
        [child orderWindow:NSWindowAbove relativeTo:root.windowNumber];
        success = capture(root, popup, child, true, true, "resized-root-recomputes-crop");
      }
      if (success) success = capture(root, popup, child, true, true, "restart-after-stop-delivers-real-frame");
      const bool foregroundPreserved = foreground != NSProcessInfo.processInfo.processIdentifier
        && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != NSProcessInfo.processInfo.processIdentifier;
      success = success && foregroundPreserved;
      printf("%s foreground-preserved\n", foregroundPreserved ? "PASS" : "FAIL");
    } @finally {
      [root removeChildWindow:child];
      [child close]; [popup close]; [unrelated close]; [root close];
    }
    return success ? 0 : 1;
  }
}
