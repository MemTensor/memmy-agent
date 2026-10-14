#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreImage/CoreImage.h>
#include <node_api.h>
#include <map>
#include <string>
#include <cmath>
#include "pip-geometry.h"
#include "pip-capture-state.h"
#include "pip-capture-stop.h"
#include "pip-capture-plan.h"
#include "pip-sck-config.h"
#include "pip-cursor-state.h"

// A nonactivating panel shows one app window live, including when that window
// is covered. Hover controls live in a second nonactivating panel, so neither
// watching nor arranging a presentation steals the foreground app.
@class MemmyPIP;

@interface MemmyPIPCaptureSink : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, weak) MemmyPIP *owner;
@property(nonatomic) uint64_t attempt;
@property(nonatomic, strong) CIContext *context;
@end

// A closed panel cannot own stop completion. Keep each retired stream alive
// independently, without any pointer back to a presentation or its new stream.
@interface MemmyPIPCaptureStop : NSObject
- (instancetype)initWithStream:(SCStream *)stream sink:(MemmyPIPCaptureSink *)sink
                        window:(CGWindowID)window pid:(pid_t)pid epoch:(double)epoch;
- (void)start;
- (void)stopAttempt;
- (void)completed:(unsigned)attempt error:(NSError *)error;
- (void)record:(const char *)stage error:(NSError *)error;
@end

static NSMutableSet<MemmyPIPCaptureStop *> *retiredCaptureStops;

static NSString *captureStopErrorDomain(NSError *error) {
  NSString *domain = error.domain ?: @"MemmyPIPCapture";
  NSMutableString *safe = [NSMutableString string];
  for (NSUInteger i = 0; i < MIN(domain.length, 80u); ++i) {
    const unichar c = [domain characterAtIndex:i];
    const BOOL allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
      || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    [safe appendFormat:@"%C", allowed ? c : (unichar)'_'];
  }
  return safe.length ? safe : @"MemmyPIPCapture";
}

@implementation MemmyPIPCaptureStop {
  SCStream *_retiredStream;
  MemmyPIPCaptureSink *_retiredSink;
  CGWindowID _windowID;
  pid_t _pid;
  double _epoch;
  memmy_pip::CaptureStopState _stopState;
}
- (instancetype)initWithStream:(SCStream *)stream sink:(MemmyPIPCaptureSink *)sink
                        window:(CGWindowID)window pid:(pid_t)pid epoch:(double)epoch {
  if (!(self = [super init])) return nil;
  _retiredStream = stream;
  _retiredSink = sink;
  _windowID = window;
  _pid = pid;
  _epoch = epoch;
  return self;
}
- (void)record:(const char *)stage error:(NSError *)error {
  NSLog(@"Memmy PiP capture window=%u pid=%d epoch=%.0f attempt=%u stage=%s domain=%@ code=%ld",
    _windowID, _pid, _epoch, _stopState.attempts, stage, captureStopErrorDomain(error), (long)error.code);
}
- (void)start {
  if (!_retiredStream) return;
  if (!retiredCaptureStops) retiredCaptureStops = [NSMutableSet set];
  [retiredCaptureStops addObject:self];
  NSError *removeError = nil;
  const BOOL removed = !_retiredSink || [_retiredStream removeStreamOutput:_retiredSink type:SCStreamOutputTypeScreen error:&removeError];
  if (!removed || removeError)
    [self record:"stop-remove-output" error:removeError];
  [self stopAttempt];
}
- (void)stopAttempt {
  const unsigned attempt = _stopState.begin();
  if (!attempt) return;
  [self record:"stop-capture-request" error:nil];
  [_retiredStream stopCaptureWithCompletionHandler:^(NSError *error) {
    // SCK can complete on another queue. Serialize policy and job ownership
    // with panel teardown while retaining this exact retired stream.
    dispatch_async(dispatch_get_main_queue(), ^{ [self completed:attempt error:error]; });
  }];
}
- (void)completed:(unsigned)attempt error:(NSError *)error {
  const auto result = _stopState.complete(attempt, error != nil);
  if (result == memmy_pip::CaptureStopResult::ignored) return;
  if (error) [self record:result == memmy_pip::CaptureStopResult::exhausted
    ? "stop-capture-exhausted" : "stop-capture" error:error];
  else [self record:"stop-capture-complete" error:nil];
  if (result == memmy_pip::CaptureStopResult::retry) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)_stopState.retryDelayMs() * NSEC_PER_MSEC),
      dispatch_get_main_queue(), ^{ [self stopAttempt]; });
    return;
  }
  _retiredStream = nil;
  _retiredSink = nil;
  [retiredCaptureStops removeObject:self];
}
@end

@interface MemmyPIPPanel : NSPanel
@end

@interface MemmyPIPControlsView : NSView
@property(nonatomic, weak) MemmyPIP *owner;
@end

@interface MemmyPIPButton : NSButton
@end
@implementation MemmyPIPButton
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
@end
@implementation MemmyPIPPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface MemmyPIPContentView : NSView
@property(nonatomic, weak) MemmyPIP *owner;
@property(nonatomic) NSPoint dragStart;
@property(nonatomic) NSPoint frameStart;
@property(nonatomic) BOOL dragged;
@property(nonatomic) BOOL pressedCard;
@property(nonatomic) BOOL resizing;
@property(nonatomic) CGFloat resizeStartEdge;
@end

@interface MemmyPIP : NSObject
@property(nonatomic, strong) MemmyPIPPanel *panel;
@property(nonatomic, strong) MemmyPIPPanel *controlsPanel;
@property(nonatomic, strong) NSImageView *imageView;
@property(nonatomic, strong) NSImageView *cursorView;
@property(nonatomic, strong) MemmyPIPContentView *contentView;
@property(nonatomic, strong) NSView *cardView;
@property(nonatomic, strong) CALayer *shadowLayer;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) MemmyPIPCaptureSink *captureSink;
@property(nonatomic) napi_env env;
@property(nonatomic) napi_ref actionCallback;
@property(nonatomic) NSInteger identifier;
@property(nonatomic) CGWindowID targetWindowID;
@property(nonatomic) pid_t targetPID;
@property(nonatomic) double captureEpoch;
@property(nonatomic) CGRect captureBounds;
@property(nonatomic) CGDirectDisplayID captureDisplayID;
@property(nonatomic) CGRect captureDisplayBounds;
@property(nonatomic) BOOL captureOnScreen;
@property(nonatomic) CGFloat cardAspectRatio;
@property(nonatomic) NSPoint moveStart;
@property(nonatomic) NSPoint moveOrigin;
@property(nonatomic) BOOL moveStarted;
@property(nonatomic) BOOL liveFrameReceived;
@property(nonatomic) BOOL captureRetryPending;
@property(nonatomic) size_t frameWidth;
@property(nonatomic) size_t frameHeight;
@property(nonatomic) double cursorX;
@property(nonatomic) double cursorY;
@property(nonatomic) NSInteger controlsGeneration;
@property(nonatomic) BOOL hidden;
- (void)beginMove;
- (void)continueMove;
- (void)performAction:(const char *)action;
- (void)performPointerAction:(const char *)action point:(NSPoint)point deltaY:(double)deltaY;
- (void)resizeToLongEdge:(CGFloat)edge;
- (void)resizeToLongEdge:(CGFloat)edge notify:(BOOL)notify;
- (void)bindTargetWindow:(CGWindowID)windowID pid:(pid_t)pid epoch:(double)epoch associated:(const std::vector<uint32_t> &)associated;
- (void)clearTargetWindow:(double)epoch;
- (void)startTargetCapture;
- (void)captureFailed:(uint64_t)attempt error:(NSError *)error stage:(const char *)stage;
- (void)acceptFrame:(CGImageRef)frame stream:(SCStream *)stream attempt:(uint64_t)attempt;
- (void)acceptFrameStatus:(NSInteger)status stream:(SCStream *)stream attempt:(uint64_t)attempt;
- (void)checkCaptureTimeout:(uint64_t)attempt;
- (void)checkCaptureGeometry:(uint64_t)attempt;
- (void)stopTargetCapture;
- (void)showControls;
- (void)scheduleControlsHide;
- (void)layoutControls;
- (void)setPresentationVisible:(BOOL)visible;
- (void)setCardPosition:(NSPoint)position;
- (NSRect)visibleImageRect;
@end

@implementation MemmyPIPControlsView
- (void)updateTrackingAreas {
  for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
  [super updateTrackingAreas];
  [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:self.bounds
    options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil]];
}
- (void)mouseEntered:(NSEvent *)event { [self.owner showControls]; }
- (void)mouseExited:(NSEvent *)event { [self.owner scheduleControlsHide]; }
@end

@implementation MemmyPIPContentView
- (BOOL)isOpaque { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (NSView *)hitTest:(NSPoint)point { return self; }
- (void)updateTrackingAreas {
  for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
  [super updateTrackingAreas];
  [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:self.bounds
    options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil]];
}
- (void)mouseEntered:(NSEvent *)event { [self.owner showControls]; }
- (void)mouseExited:(NSEvent *)event { [self.owner scheduleControlsHide]; }
- (void)mouseDown:(NSEvent *)event {
  NSPoint local = [self convertPoint:event.locationInWindow fromView:nil];
  NSRect card = self.owner.cardView.frame;
  self.dragStart = [NSEvent mouseLocation];
  self.frameStart = self.window.frame.origin;
  self.dragged = NO;
  self.pressedCard = NSPointInRect(local, card);
  // The card sits inside a transparent margin. Dragging that margin, or the
  // bottom-right corner just outside the card, must still move or resize.
  self.resizing = local.x >= NSMaxX(card) - 18 && local.y <= NSMinY(card) + 18
    && local.x <= NSMaxX(self.bounds) && local.y >= NSMinY(self.bounds);
  self.resizeStartEdge = MAX(NSWidth(card), NSHeight(card));
  if (!self.resizing) [self.owner beginMove];
}
- (void)mouseDragged:(NSEvent *)event {
  NSPoint point = [NSEvent mouseLocation];
  CGFloat dx = point.x - self.dragStart.x;
  if (self.resizing) {
    if (fabs(dx) + fabs(point.y - self.dragStart.y) < 3 && !self.dragged) return;
    self.dragged = YES;
    [self.owner resizeToLongEdge:MAX(200, MIN(400, self.resizeStartEdge + dx))];
    return;
  }
  [self.owner continueMove];
  self.dragged = self.owner.moveStarted;
}
- (void)mouseUp:(NSEvent *)event {
  if (self.dragged || self.resizing || !self.pressedCard) return;
  if (event.clickCount == 1) [self.owner performAction:"open"];
}
- (void)scrollWheel:(NSEvent *)event {
  NSPoint local = [self convertPoint:event.locationInWindow fromView:nil];
  if (!NSPointInRect(local, self.owner.cardView.frame)) return;
  // NSEvent uses positive Y for upward motion; the renderer contract uses positive Y for down.
  double deltaY = MAX(-1000, MIN(1000, -event.scrollingDeltaY));
  if (fabs(deltaY) >= 1) [self.owner performPointerAction:"scroll" point:local deltaY:deltaY];
}
@end

@implementation MemmyPIP {
  memmy_pip::CaptureState _captureState;
  memmy_pip::CursorSourceState _cursorSources;
  std::vector<uint32_t> _associatedWindowIDs;
  std::vector<uint32_t> _includedAssociatedWindowIDs;
}
- (instancetype)initWithID:(NSInteger)identifier title:(NSString *)title width:(CGFloat)width
                  height:(CGFloat)height x:(CGFloat)x y:(CGFloat)y env:(napi_env)env
                  callback:(napi_ref)callback interruptAvailable:(BOOL)interruptAvailable {
  if (!(self = [super init])) return nil;
  _identifier = identifier; _env = env; _actionCallback = callback;
  _cardAspectRatio = width / height;
  NSRect frame = NSMakeRect(x - 16, y - 16, width + 32, height + 32);
  _panel = [[MemmyPIPPanel alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskNonactivatingPanel
     backing:NSBackingStoreBuffered defer:NO];
  _panel.title = title;
  _panel.backgroundColor = NSColor.clearColor;
  _panel.opaque = NO;
  _panel.hasShadow = NO;
  _panel.hidesOnDeactivate = NO;
  _panel.releasedWhenClosed = NO;
  _panel.acceptsMouseMovedEvents = YES;
  _panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  _panel.level = NSFloatingWindowLevel;
  _contentView = [[MemmyPIPContentView alloc] initWithFrame:NSMakeRect(0, 0, width + 32, height + 32)];
  _contentView.owner = self;
  _contentView.wantsLayer = YES;
  _contentView.layer.backgroundColor = NSColor.clearColor.CGColor;
  _shadowLayer = [CALayer layer];
  _shadowLayer.frame = CGRectMake(16, 16, width, height);
  _shadowLayer.backgroundColor = NSColor.blackColor.CGColor;
  _shadowLayer.cornerRadius = 8;
  _shadowLayer.cornerCurve = kCACornerCurveContinuous;
  _shadowLayer.shadowColor = NSColor.blackColor.CGColor;
  _shadowLayer.shadowOpacity = 0.16f;
  _shadowLayer.shadowOffset = CGSizeMake(0, -6);
  _shadowLayer.shadowRadius = 10;
  CGPathRef initialShadowPath = CGPathCreateWithRoundedRect(CGRectMake(0, 0, width, height), 8, 8, NULL);
  _shadowLayer.shadowPath = initialShadowPath;
  CGPathRelease(initialShadowPath);
  [_contentView.layer addSublayer:_shadowLayer];
  _cardView = [[NSView alloc] initWithFrame:NSMakeRect(16, 16, width, height)];
  _cardView.wantsLayer = YES;
  _cardView.layer.backgroundColor = NSColor.blackColor.CGColor;
  _cardView.layer.cornerRadius = 8;
  _cardView.layer.cornerCurve = kCACornerCurveContinuous;
  _cardView.layer.masksToBounds = YES;
  _imageView = [[NSImageView alloc] initWithFrame:_cardView.bounds];
  _imageView.imageScaling = NSImageScaleProportionallyUpOrDown;
  _imageView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [_cardView addSubview:_imageView];
  NSImage *cursor = [NSCursor arrowCursor].image;
  NSSize cursorSize = cursor.size.width > 1 && cursor.size.height > 1 ? cursor.size : NSMakeSize(16, 16);
  _cursorView = [[NSImageView alloc] initWithFrame:NSMakeRect(0, 0, cursorSize.width, cursorSize.height)];
  _cursorView.imageScaling = NSImageScaleNone;
  _cursorView.image = cursor;
  _cursorView.hidden = YES;
  [_cardView addSubview:_cursorView];
  [_contentView addSubview:_cardView];
  _panel.contentView = _contentView;
  CGFloat controlsWidth = 28;
  _controlsPanel = [[MemmyPIPPanel alloc] initWithContentRect:NSMakeRect(0, 0, controlsWidth, 28)
    styleMask:NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
  _controlsPanel.backgroundColor = NSColor.clearColor;
  _controlsPanel.opaque = NO;
  _controlsPanel.hasShadow = NO;
  _controlsPanel.hidesOnDeactivate = NO;
  _controlsPanel.releasedWhenClosed = NO;
  _controlsPanel.collectionBehavior = _panel.collectionBehavior;
  _controlsPanel.level = _panel.level + 1;
  MemmyPIPControlsView *controls = [[MemmyPIPControlsView alloc] initWithFrame:NSMakeRect(0, 0, controlsWidth, 28)];
  controls.owner = self;
  controls.wantsLayer = YES;
  controls.layer.backgroundColor = [NSColor colorWithWhite:0.12 alpha:0.9].CGColor;
  controls.layer.cornerRadius = 14;
  _controlsPanel.contentView = controls;
  MemmyPIPButton *hide = [[MemmyPIPButton alloc] initWithFrame:NSMakeRect(3, 3, 22, 22)];
  hide.bordered = NO; hide.title = @"×"; hide.toolTip = @"隐藏实时小窗";
  hide.contentTintColor = NSColor.whiteColor;
  hide.target = self; hide.action = @selector(hideMenu:);
  [controls addSubview:hide];
  (void)interruptAvailable;
  [self layoutControls];
  [[NSDistributedNotificationCenter defaultCenter] addObserver:self
    selector:@selector(cursorNotification:) name:@"cn.memtensor.memmy.computeruse.cursor"
    object:nil suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  [_panel orderFrontRegardless];
  return self;
}
- (void)emitAction:(const char *)action x:(double)x y:(double)y deltaY:(double)deltaY {
  if (!_actionCallback) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(_env, &scope) != napi_ok) return;
  napi_value callback, global, arguments[7];
  if (napi_get_reference_value(_env, _actionCallback, &callback) == napi_ok
      && napi_get_global(_env, &global) == napi_ok
      && napi_create_string_utf8(_env, action, NAPI_AUTO_LENGTH, &arguments[0]) == napi_ok
      && napi_create_double(_env, x, &arguments[1]) == napi_ok
      && napi_create_double(_env, y, &arguments[2]) == napi_ok
      && napi_create_double(_env, deltaY, &arguments[3]) == napi_ok
      && napi_create_double(_env, _liveFrameReceived ? (double)_frameWidth : 0, &arguments[4]) == napi_ok
      && napi_create_double(_env, _liveFrameReceived ? (double)_frameHeight : 0, &arguments[5]) == napi_ok
      && napi_create_double(_env, _captureEpoch, &arguments[6]) == napi_ok)
    napi_call_function(_env, global, callback, 7, arguments, nullptr);
  napi_close_handle_scope(_env, scope);
}
- (void)performAction:(const char *)action { [self emitAction:action x:0 y:0 deltaY:0]; }
- (void)layoutControls {
  NSRect card = [_panel convertRectToScreen:_cardView.frame];
  [_controlsPanel setFrameOrigin:NSMakePoint(NSMaxX(card) - NSWidth(_controlsPanel.frame), NSMaxY(card) + 4)];
}
- (void)showControls {
  ++_controlsGeneration;
  if (_hidden) return;
  [self layoutControls];
  [_controlsPanel orderFrontRegardless];
}
- (void)scheduleControlsHide {
  NSInteger generation = ++_controlsGeneration;
  __weak MemmyPIP *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    MemmyPIP *owner = weakSelf;
    if (!owner || owner.controlsGeneration != generation) return;
    NSPoint point = NSEvent.mouseLocation;
    if (NSPointInRect(point, owner.panel.frame) || NSPointInRect(point, owner.controlsPanel.frame)) return;
    [owner.controlsPanel orderOut:nil];
  });
}
- (void)hideMenu:(NSButton *)sender {
  ++_controlsGeneration;
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"隐藏实时小窗"];
  for (NSString *title in @[@"隐藏当前聊天的小窗", @"隐藏所有聊天的小窗"]) {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(requestHide:) keyEquivalent:@""];
    item.target = self; item.tag = menu.numberOfItems;
    [menu addItem:item];
  }
  [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, -3) inView:sender];
  [self scheduleControlsHide];
}
- (void)requestHide:(NSMenuItem *)sender { [self performAction:sender.tag == 0 ? "hide-task" : "hide-all"]; }
- (void)setPresentationVisible:(BOOL)visible {
  _hidden = !visible;
  ++_controlsGeneration;
  [_controlsPanel orderOut:nil];
  if (visible) [_panel orderFrontRegardless];
  else [_panel orderOut:nil];
}
- (void)setCardPosition:(NSPoint)position {
  [_panel setFrameOrigin:NSMakePoint(position.x - 16, position.y - 16)];
  [self layoutControls];
}
- (void)beginMove {
  self.moveStart = [NSEvent mouseLocation];
  self.moveOrigin = self.panel.frame.origin;
  self.moveStarted = NO;
}
- (void)continueMove {
  NSPoint point = [NSEvent mouseLocation];
  CGFloat dx = point.x - self.moveStart.x, dy = point.y - self.moveStart.y;
  if (fabs(dx) + fabs(dy) < 3 && !self.moveStarted) return;
  if (!self.moveStarted) {
    [self performAction:"dragged"];
  }
  self.moveStarted = YES;
  [self.panel setFrameOrigin:NSMakePoint(self.moveOrigin.x + dx, self.moveOrigin.y + dy)];
  [self layoutControls];
}
- (void)performPointerAction:(const char *)action point:(NSPoint)point deltaY:(double)deltaY {
  NSRect card = _cardView.frame;
  if (!NSPointInRect(point, card)) return;
  double localX = point.x - NSMinX(card), localY = point.y - NSMinY(card);
  double radius = MIN(8, MIN(NSWidth(card), NSHeight(card)) / 2);
  double centerX = localX < radius ? radius : localX > NSWidth(card) - radius ? NSWidth(card) - radius : localX;
  double centerY = localY < radius ? radius : localY > NSHeight(card) - radius ? NSHeight(card) - radius : localY;
  if (hypot(localX - centerX, localY - centerY) > radius) return;
  NSRect visible = [self visibleImageRect];
  double x, y;
  if (!memmy_pip::normalizedPoint({visible.origin.x, visible.origin.y, visible.size.width, visible.size.height},
      localX, localY, x, y)) return;
  [self emitAction:action x:x y:y deltaY:deltaY];
}
- (NSRect)visibleImageRect {
  NSRect card = _cardView.bounds;
  NSSize source = _imageView.hidden && _cardView.layer.contents
    ? NSMakeSize(_frameWidth, _frameHeight) : _imageView.image.size;
  if (source.width <= 0 || source.height <= 0) return card;
  const auto fitted = memmy_pip::aspectFit(NSWidth(card), NSHeight(card), source.width, source.height);
  return NSMakeRect(fitted.x, fitted.y, fitted.width, fitted.height);
}
- (void)layoutCursor {
  if (_cursorView.hidden) return;
  NSRect card = [self visibleImageRect];
  CGFloat tipX = NSMinX(card) + _cursorX * NSWidth(card);
  CGFloat tipY = NSMinY(card) + (1.0 - _cursorY) * NSHeight(card);
  NSSize size = _cursorView.frame.size;
  if (size.width < 1 || size.height < 1) size = NSMakeSize(16, 20);
  _cursorView.frame = NSMakeRect(tipX, tipY - size.height, size.width, size.height);
}
- (void)cursorNotification:(NSNotification *)note {
  if (![NSThread isMainThread]) {
    [self performSelectorOnMainThread:@selector(cursorNotification:) withObject:note waitUntilDone:NO];
    return;
  }
  NSDictionary *info = note.userInfo;
  NSNumber *windowID = info[@"windowID"];
  if (![windowID isKindOfClass:[NSNumber class]] || windowID.unsignedIntValue != _targetWindowID) return;
  NSNumber *active = info[@"active"];
  NSString *sourceID = info[@"sourceID"];
  const std::string source = [sourceID isKindOfClass:[NSString class]] && sourceID.length > 0
    ? std::string(sourceID.UTF8String) : "legacy";
  if (![active isKindOfClass:[NSNumber class]] || !active.boolValue) {
    _cursorSources.remove(source);
  } else {
    NSNumber *x = info[@"x"];
    NSNumber *y = info[@"y"];
    if (![x isKindOfClass:[NSNumber class]] || ![y isKindOfClass:[NSNumber class]]
        || !std::isfinite(x.doubleValue) || !std::isfinite(y.doubleValue)) return;
    _cursorSources.update(source, x.doubleValue, y.doubleValue);
  }
  const auto latest = _cursorSources.latest();
  if (!latest) { _cursorView.hidden = YES; return; }
  _cursorX = latest->x;
  _cursorY = latest->y;
  _cursorView.hidden = NO;
  [self layoutCursor];
}
- (void)stopTargetCapture {
  SCStream *previous = _stream;
  MemmyPIPCaptureSink *sink = _captureSink;
  _stream = nil;
  _captureSink = nil;
  if (!previous) return;
  sink.owner = nil;
  MemmyPIPCaptureStop *stop = [[MemmyPIPCaptureStop alloc] initWithStream:previous sink:sink
    window:_targetWindowID pid:_targetPID epoch:_captureEpoch];
  [stop start];
}
- (void)bindTargetWindow:(CGWindowID)windowID pid:(pid_t)pid epoch:(double)epoch associated:(const std::vector<uint32_t> &)associated {
  if (windowID == 0 || pid <= 0 || epoch <= 0) return;
  if (windowID == _targetWindowID && pid == _targetPID && epoch == _captureEpoch && associated == _associatedWindowIDs
      && (_captureState.active || _captureRetryPending)) return;
  const BOOL changedTarget = windowID != _targetWindowID || pid != _targetPID;
  _captureState.invalidate();
  _captureState.failures = 0;
  _captureRetryPending = NO;
  [self stopTargetCapture];
  _targetWindowID = windowID;
  _targetPID = pid;
  _captureEpoch = epoch;
  _associatedWindowIDs = associated;
  _liveFrameReceived = NO;
  _cursorSources.clear();
  _cursorView.hidden = YES;
  if (changedTarget) {
    // A previous document's pixels must not be shown under a new identity.
    _frameWidth = _frameHeight = 0;
    _cardView.layer.contents = nil;
    _imageView.image = nil;
    _imageView.hidden = NO;
  }
  [self startTargetCapture];
}
- (void)clearTargetWindow:(double)epoch {
  _captureState.invalidate();
  _captureRetryPending = NO;
  [self stopTargetCapture];
  _targetWindowID = 0;
  _targetPID = 0;
  _captureEpoch = epoch;
  _associatedWindowIDs.clear();
  _includedAssociatedWindowIDs.clear();
  _liveFrameReceived = NO;
  _frameWidth = _frameHeight = 0;
  _cursorSources.clear();
  _cursorView.hidden = YES;
  _cardView.layer.contents = nil;
  _imageView.image = nil;
  _imageView.hidden = NO;
}
- (void)captureFailed:(uint64_t)attempt error:(NSError *)error stage:(const char *)stage {
  const int delay = _captureState.fail(attempt, NSDate.timeIntervalSinceReferenceDate);
  if (delay < 0) return;
  // Error descriptions may contain titles or paths. Log only bounded protocol
  // fields, identity, stage and numeric codes for package-side diagnostics.
  NSString *domain = error.domain ?: @"MemmyPIPCapture";
  if (domain.length > 80) domain = [domain substringToIndex:80];
  NSLog(@"Memmy PiP capture window=%u pid=%d epoch=%.0f attempt=%llu stage=%s domain=%@ code=%ld retryMs=%d",
    _targetWindowID, _targetPID, _captureEpoch, (unsigned long long)attempt, stage, domain, (long)(error ? error.code : 0), delay);
  _liveFrameReceived = NO;
  _cursorView.hidden = YES;
  // Keep the last decoded image until a verified replacement is available.
  // A temporary stream failure must not turn the card into an empty layer.
  [self stopTargetCapture];
  [self emitAction:"capture-ended" x:_targetWindowID y:0 deltaY:0];
  _captureRetryPending = YES;
  const uint64_t retryGeneration = _captureState.attempt;
  __weak MemmyPIP *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)delay * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    MemmyPIP *owner = weakSelf;
    if (!owner || owner->_captureState.attempt != retryGeneration || !owner.captureRetryPending) return;
    owner.captureRetryPending = NO;
    [owner startTargetCapture];
  });
}
- (void)checkCaptureTimeout:(uint64_t)attempt {
  if (!_captureState.accepts(attempt)) return;
  const auto timeout = _captureState.timeout(attempt, NSDate.timeIntervalSinceReferenceDate);
  if (timeout != memmy_pip::CaptureTimeout::none) {
    [self captureFailed:attempt error:nil stage:timeout == memmy_pip::CaptureTimeout::firstFrame
      ? "first-frame-timeout" : timeout == memmy_pip::CaptureTimeout::blankFrames
      ? "blank-frame-timeout" : timeout == memmy_pip::CaptureTimeout::visibleSuspension
      ? "visible-suspension-timeout" : "invalid-frame-timeout"];
    return;
  }
  __weak MemmyPIP *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    [weakSelf checkCaptureTimeout:attempt];
  });
}
- (void)checkCaptureGeometry:(uint64_t)attempt {
  if (!_captureState.accepts(attempt) || !_stream) return;
  const auto available = memmy_pip::readCaptureWindowIdentities();
  CGRect bounds = CGRectZero;
  BOOL onScreen = NO;
  const BOOL validBounds = memmy_pip::captureWindowIdentity(_targetWindowID, _targetPID, available, bounds, onScreen);
  if (!validBounds) { [self captureFailed:attempt error:nil stage:"geometry-target-identity"]; return; }
  _captureState.confirmVisibility(attempt, onScreen, NSDate.timeIntervalSinceReferenceDate);
  const auto included = memmy_pip::combinedRelatedWindows(_targetWindowID, _targetPID, _associatedWindowIDs, available);
  const BOOL associationChanged = included != _includedAssociatedWindowIDs;
  const BOOL displayChanged = _captureDisplayID && !CGRectEqualToRect(CGDisplayBounds(_captureDisplayID), _captureDisplayBounds);
  const BOOL restoredIndependentWindow = !_captureDisplayID && !_captureOnScreen && onScreen;
  if (!CGRectEqualToRect(bounds, _captureBounds) || restoredIndependentWindow || displayChanged || associationChanged) {
    NSLog(@"Memmy PiP capture window=%u pid=%d epoch=%.0f attempt=%llu stage=%s",
      _targetWindowID, _targetPID, _captureEpoch, (unsigned long long)attempt,
      associationChanged ? "association-rebind" : "geometry-rebind");
    _captureState.invalidate();
    _liveFrameReceived = NO;
    _cursorView.hidden = YES;
    [self stopTargetCapture];
    [self emitAction:"capture-ended" x:_targetWindowID y:0 deltaY:0];
    [self startTargetCapture];
    return;
  }
  _captureOnScreen = onScreen;
  __weak MemmyPIP *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    [weakSelf checkCaptureGeometry:attempt];
  });
}
- (void)startTargetCapture {
  // The PiP runs in Memmy's host process. ScreenCaptureKit can display its
  // own first-use prompt here, bypassing the host-owned restart intent.
  // Keep every initial bind and retry behind the same passive TCC check.
  if (!CGPreflightScreenCaptureAccess()) {
    [self emitAction:"screen-permission-required" x:_targetWindowID y:0 deltaY:0];
    return;
  }
  const CGWindowID windowID = _targetWindowID;
  const pid_t pid = _targetPID;
  const uint64_t attempt = _captureState.begin(NSDate.timeIntervalSinceReferenceDate);
  __weak MemmyPIP *weakSelf = self;
  [self checkCaptureTimeout:attempt];
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
    completionHandler:^(SCShareableContent *content, NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
      MemmyPIP *owner = weakSelf;
      if (!owner || !owner->_captureState.accepts(attempt)) return;
      if (error || !content) { [owner captureFailed:attempt error:error stage:"shareable-content"]; return; }
      SCWindow *match = nil;
      for (SCWindow *window in content.windows) {
        if (window.windowID == windowID && window.owningApplication.processID == pid) { match = window; break; }
      }
      if (!match) { [owner captureFailed:attempt error:nil stage:"target-identity"]; return; }
      const auto currentWindows = memmy_pip::readCaptureWindowIdentities();
      CGRect rootBounds = CGRectZero; BOOL rootOnScreen = NO;
      if (!memmy_pip::captureWindowIdentity(windowID, pid, currentWindows, rootBounds, rootOnScreen)) {
        [owner captureFailed:attempt error:nil stage:"target-bounds-identity"]; return;
      }
      SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
      std::vector<memmy_pip::CaptureWindowIdentity> available;
      for (SCWindow *window in content.windows)
        available.push_back({window.windowID, window.owningApplication.processID, (bool)window.isOnScreen});
      const auto requestedIDs = memmy_pip::combinedRelatedWindows(windowID, pid, owner->_associatedWindowIDs, currentWindows);
      const auto associatedIDs = memmy_pip::validatedRelatedWindows(windowID, pid, requestedIDs, available);
      if (associatedIDs != requestedIDs) {
        // A visible required overlay missing from SCK cannot be represented by
        // a root-only stream. Keep the verified snapshot while capture retries.
        [owner captureFailed:attempt error:nil stage:"required-overlay-unavailable"]; return;
      }
      NSMutableArray<SCWindow *> *associated = [NSMutableArray array];
      for (SCWindow *window in content.windows)
        if (std::binary_search(associatedIDs.begin(), associatedIDs.end(), window.windowID)) [associated addObject:window];
      memmy_pip::CapturePlan plan;
      SCContentFilter *filter = memmy_pip::configureWindowCapture(match, content.displays, config, plan, associated, rootBounds, rootOnScreen);
      if (!memmy_pip::capturePlanSupportsRelatedWindows(plan, associatedIDs)) {
        [owner captureFailed:attempt error:nil stage:"overlay-group-unavailable"]; return;
      }
      owner->_includedAssociatedWindowIDs = plan.includesChildren ? associatedIDs : std::vector<uint32_t>{};
      owner.captureBounds = rootBounds;
      owner.captureOnScreen = rootOnScreen;
      owner.captureDisplayID = plan.displayID;
      owner.captureDisplayBounds = plan.displayID ? CGDisplayBounds(plan.displayID) : CGRectZero;
      config.showsCursor = NO;
      config.pixelFormat = kCVPixelFormatType_32BGRA;
      config.minimumFrameInterval = CMTimeMake(1, 30);
      config.queueDepth = 4;
      MemmyPIPCaptureSink *sink = [[MemmyPIPCaptureSink alloc] init];
      sink.owner = owner;
      sink.attempt = attempt;
      sink.context = [CIContext contextWithOptions:nil];
      SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:sink];
      dispatch_queue_t queue = dispatch_queue_create("memmy.pip.capture", DISPATCH_QUEUE_SERIAL);
      owner.captureSink = sink;
      owner.stream = stream;
      NSError *addError = nil;
      if (![stream addStreamOutput:sink type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&addError] || addError) {
        [owner captureFailed:attempt error:addError stage:"add-output"]; return;
      }
      // Retained before add/start: a frame can precede the completion callback,
      // and even a partially attached output must be removed on failure.
      [stream startCaptureWithCompletionHandler:^(NSError *startError) {
        if (!startError) return;
        dispatch_async(dispatch_get_main_queue(), ^{
          MemmyPIP *owner = weakSelf;
          if (owner && owner.stream == stream) [owner captureFailed:attempt error:startError stage:"start-capture"];
        });
      }];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        [weakSelf checkCaptureGeometry:attempt];
      });
      });
    }];
}
- (void)acceptFrameStatus:(NSInteger)status stream:(SCStream *)stream attempt:(uint64_t)attempt {
  if (_stream != stream || !_captureState.accepts(attempt)) return;
  if (status == SCFrameStatusStopped) {
    [self captureFailed:attempt error:[NSError errorWithDomain:@"MemmyPIPFrameStatus" code:status userInfo:nil]
      stage:"frame-stopped"];
  } else if (status == SCFrameStatusBlank || status == SCFrameStatusSuspended) {
    const bool alreadyUnavailable = _captureState.suspended || _captureState.blank;
    _captureState.pause(attempt, status == SCFrameStatusSuspended, NSDate.timeIntervalSinceReferenceDate);
    _liveFrameReceived = NO;
    _cursorView.hidden = YES;
    if (!alreadyUnavailable) {
      NSLog(@"Memmy PiP capture window=%u pid=%d epoch=%.0f attempt=%llu stage=%s domain=MemmyPIPFrameStatus code=%ld",
        _targetWindowID, _targetPID, _captureEpoch, (unsigned long long)attempt,
        status == SCFrameStatusBlank ? "frame-blank" : "frame-suspended", (long)status);
      [self emitAction:"capture-ended" x:_targetWindowID y:0 deltaY:0];
    }
    // A decoded, minimized/suspended window can resume the same stream. Blank
    // frames get a short grace period; neither status bypasses first-frame timeouts.
  } else if (status == SCFrameStatusIdle) {
    _captureState.idle(attempt);
  } else {
    _captureState.invalidFrame(attempt, NSDate.timeIntervalSinceReferenceDate);
  }
}
- (void)acceptFrame:(CGImageRef)frame stream:(SCStream *)stream attempt:(uint64_t)attempt {
  if (_stream != stream || !_captureState.accepts(attempt)) return;
  _frameWidth = CGImageGetWidth(frame);
  _frameHeight = CGImageGetHeight(frame);
  CGFloat ratio = (CGFloat)_frameWidth / _frameHeight;
  if (fabs(_cardAspectRatio - ratio) > 0.001) {
    _cardAspectRatio = ratio;
    [self resizeToLongEdge:MAX(NSWidth(_cardView.frame), NSHeight(_cardView.frame)) notify:NO];
  }
  const bool becameLive = _captureState.decoded(attempt, NSDate.timeIntervalSinceReferenceDate);
  _liveFrameReceived = YES;
  _imageView.hidden = YES;
  _cardView.layer.contents = (__bridge id)frame;
  _cardView.layer.contentsGravity = kCAGravityResizeAspect;
  [self layoutCursor];
  // Publish only after the first real image has been installed in the layer.
  if (becameLive) [self emitAction:"capture-ready" x:_targetWindowID y:0 deltaY:0];
}
- (void)resizeToLongEdge:(CGFloat)edge {
  [self resizeToLongEdge:edge notify:YES];
}
- (void)resizeToLongEdge:(CGFloat)edge notify:(BOOL)notify {
  NSRect frame = _panel.frame;
  CGFloat width = _cardAspectRatio >= 1 ? edge : edge * _cardAspectRatio;
  CGFloat height = _cardAspectRatio >= 1 ? edge / _cardAspectRatio : edge;
  frame.origin.y += frame.size.height - (height + 32);
  frame.size = NSMakeSize(width + 32, height + 32);
  [_panel setFrame:frame display:YES animate:!notify];
  _cardView.frame = NSMakeRect(16, 16, width, height);
  _shadowLayer.frame = CGRectMake(16, 16, width, height);
  CGPathRef path = CGPathCreateWithRoundedRect(CGRectMake(0, 0, width, height), 8, 8, NULL);
  _shadowLayer.shadowPath = path;
  CGPathRelease(path);
  [self layoutCursor];
  [self layoutControls];
  [self emitAction:notify ? "resized" : "source-size" x:width y:height deltaY:0];
}
- (void)setImageData:(NSData *)data {
  if (_liveFrameReceived) return;
  NSImage *image = [[NSImage alloc] initWithData:data];
  if (!image) return;
  _imageView.hidden = NO;
  _imageView.image = image;
}
- (void)close {
  _captureState.invalidate();
  ++_controlsGeneration;
  _captureRetryPending = NO;
  [[NSDistributedNotificationCenter defaultCenter] removeObserver:self];
  [self stopTargetCapture];
  [_panel close];
  [_controlsPanel close];
  if (_actionCallback) { napi_delete_reference(_env, _actionCallback); _actionCallback = nullptr; }
}
@end

@implementation MemmyPIPCaptureSink {
  memmy_pip::PendingFrame _pendingFrame;
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  __weak MemmyPIP *owner = _owner;
  const uint64_t attempt = _attempt;
  dispatch_async(dispatch_get_main_queue(), ^{
    MemmyPIP *strongOwner = owner;
    if (strongOwner && strongOwner.stream == stream)
      [strongOwner captureFailed:attempt error:error stage:"stream-stopped"];
  });
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeScreen) return;
  __weak MemmyPIP *owner = _owner;
  if (!owner) return;
  const uint64_t attempt = _attempt;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  NSInteger status = SCFrameStatusComplete;
  if (attachments && CFArrayGetCount(attachments) > 0) {
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *value = info[SCStreamFrameInfoStatus];
    if ([value isKindOfClass:[NSNumber class]]) status = value.integerValue;
  }
  if (status != SCFrameStatusComplete && status != SCFrameStatusStarted) {
    dispatch_async(dispatch_get_main_queue(), ^{ [owner acceptFrameStatus:status stream:stream attempt:attempt]; });
    return;
  }
  // At most one GPU-backed decoded image per stream can wait for AppKit. An
  // unbounded main-queue backlog can otherwise exhaust SCK's surface pool.
  if (!_pendingFrame.acquire()) return;
  @autoreleasepool {
    CVImageBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    CIImage *image = pixelBuffer ? [CIImage imageWithCVPixelBuffer:pixelBuffer] : nil;
    CGImageRef frame = image && !CGRectIsEmpty(image.extent) ? [_context createCGImage:image fromRect:image.extent] : nil;
    if (!frame) {
      _pendingFrame.release();
      // Complete metadata without decodable pixels cannot prove live output.
      dispatch_async(dispatch_get_main_queue(), ^{ [owner acceptFrameStatus:-1 stream:stream attempt:attempt]; });
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [owner acceptFrame:frame stream:stream attempt:attempt];
      CGImageRelease(frame);
      self->_pendingFrame.release();
    });
  }
}
@end

static std::map<int, MemmyPIP *> windows;
static int nextID = 1;

static bool getNumber(napi_env env, napi_value value, double *out) {
  return napi_get_value_double(env, value, out) == napi_ok && std::isfinite(*out);
}
static napi_value create(napi_env env, napi_callback_info info) {
  size_t argc = 7; napi_value args[7];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 6 || argc > 7) { napi_throw_type_error(env, nullptr, "create(title,width,height,x,y,onAction,interruptAvailable?)"); return nullptr; }
  size_t length = 0; napi_get_value_string_utf8(env, args[0], nullptr, 0, &length);
  if (length > 256) { napi_throw_range_error(env, nullptr, "title too long"); return nullptr; }
  std::string title(length + 1, '\0');
  napi_get_value_string_utf8(env, args[0], title.data(), title.size(), &length);
  double width, height, x, y;
  if (!getNumber(env,args[1],&width) || !getNumber(env,args[2],&height) ||
      !getNumber(env,args[3],&x) || !getNumber(env,args[4],&y) ||
      width < 1 || height < 1 || width > 800 || height > 800) {
    napi_throw_range_error(env, nullptr, "invalid bounds"); return nullptr;
  }
  napi_valuetype kind; napi_typeof(env,args[5],&kind);
  if (kind != napi_function) { napi_throw_type_error(env,nullptr,"onAction must be a function"); return nullptr; }
  bool interruptAvailable = false;
  if (argc == 7 && napi_get_value_bool(env,args[6],&interruptAvailable) != napi_ok) {
    napi_throw_type_error(env,nullptr,"interruptAvailable must be a boolean"); return nullptr;
  }
  napi_ref callback; napi_create_reference(env,args[5],1,&callback);
  int id = nextID++;
  NSString *name = [[NSString alloc] initWithBytes:title.data() length:length encoding:NSUTF8StringEncoding];
  MemmyPIP *window = [[MemmyPIP alloc] initWithID:id title:name width:width height:height x:x y:y
    env:env callback:callback interruptAvailable:interruptAvailable];
  windows[id] = window;
  napi_value result; napi_create_int32(env,id,&result); return result;
}
static MemmyPIP *lookup(napi_env env, napi_value value) {
  int32_t id; if (napi_get_value_int32(env,value,&id) != napi_ok) return nil;
  auto item = windows.find(id); return item == windows.end() ? nil : item->second;
}
static napi_value setImage(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  if (argc == 2) {
    MemmyPIP *window = lookup(env,args[0]); void *bytes = nullptr; size_t length = 0;
    bool isBuffer = false; napi_is_buffer(env,args[1],&isBuffer);
    if (window && isBuffer && napi_get_buffer_info(env,args[1],&bytes,&length) == napi_ok && length <= 8'000'000)
      [window setImageData:[NSData dataWithBytes:bytes length:length]];
  }
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value setTargetWindow(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value args[5]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  double target, pid, epoch;
  bool isArray = false; uint32_t count = 0;
  if (argc != 5 || !getNumber(env,args[1],&target) || target < 1 || target > UINT32_MAX || floor(target) != target
      || !getNumber(env,args[2],&pid) || pid < 1 || pid > INT32_MAX || floor(pid) != pid
      || !getNumber(env,args[3],&epoch) || epoch < 1 || epoch > 9007199254740991.0 || floor(epoch) != epoch
      || napi_is_array(env,args[4],&isArray) != napi_ok || !isArray
      || napi_get_array_length(env,args[4],&count) != napi_ok || count > 64) {
    napi_throw_range_error(env,nullptr,"setTargetWindow requires a window ID, PID, binding epoch and bounded associated IDs"); return nullptr;
  }
  std::vector<uint32_t> associated;
  for (uint32_t i = 0; i < count; ++i) {
    napi_value value; double id;
    if (napi_get_element(env,args[4],i,&value) != napi_ok || !getNumber(env,value,&id)
        || id < 1 || id > UINT32_MAX || floor(id) != id) {
      napi_throw_range_error(env,nullptr,"invalid associated window ID"); return nullptr;
    }
    if (id != target) associated.push_back((uint32_t)id);
  }
  std::sort(associated.begin(), associated.end());
  associated.erase(std::unique(associated.begin(), associated.end()), associated.end());
  [lookup(env,args[0]) bindTargetWindow:(CGWindowID)target pid:(pid_t)pid epoch:epoch associated:associated];
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value clearTargetWindow(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  double epoch;
  if (argc != 2 || !getNumber(env,args[1],&epoch) || epoch < 1 || epoch > 9007199254740991.0 || floor(epoch) != epoch) {
    napi_throw_range_error(env,nullptr,"clearTargetWindow requires a safe positive binding epoch"); return nullptr;
  }
  [lookup(env,args[0]) clearTargetWindow:epoch];
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value setVisible(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  bool visible = false;
  if (argc == 2 && napi_get_value_bool(env,args[1],&visible) == napi_ok)
    [lookup(env,args[0]) setPresentationVisible:visible];
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value setPosition(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value args[3]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  double x, y;
  if (argc == 3 && getNumber(env,args[1],&x) && getNumber(env,args[2],&y))
    [lookup(env,args[0]) setCardPosition:NSMakePoint(x,y)];
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value closeWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  if (argc == 1) { int32_t id; if (napi_get_value_int32(env,args[0],&id) == napi_ok) {
    auto item = windows.find(id); if (item != windows.end()) { [item->second close]; windows.erase(item); }
  }}
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value screenRecordingGranted(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, CGPreflightScreenCaptureAccess(), &result);
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"create",nullptr,create,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setImage",nullptr,setImage,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setTargetWindow",nullptr,setTargetWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"clearTargetWindow",nullptr,clearTargetWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setVisible",nullptr,setVisible,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setPosition",nullptr,setPosition,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"close",nullptr,closeWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"screenRecordingGranted",nullptr,screenRecordingGranted,nullptr,nullptr,nullptr,napi_default,nullptr},
  };
  napi_define_properties(env,exports,sizeof(properties) / sizeof(properties[0]),properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
