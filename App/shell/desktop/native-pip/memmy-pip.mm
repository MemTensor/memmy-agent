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

// A nonactivating panel shows one app window live, including when that window
// is covered. The agent pointer is drawn inside the card. There is no hover
// control chrome: the user's own desktop cursor stays theirs.
@class MemmyPIP;

@interface MemmyPIPPanel : NSPanel
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

@interface MemmyPIP : NSObject <SCStreamOutput>
@property(nonatomic, strong) MemmyPIPPanel *panel;
@property(nonatomic, strong) NSImageView *imageView;
@property(nonatomic, strong) NSImageView *cursorView;
@property(nonatomic, strong) MemmyPIPContentView *contentView;
@property(nonatomic, strong) NSView *cardView;
@property(nonatomic, strong) CALayer *shadowLayer;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) CIContext *captureContext;
@property(nonatomic) napi_env env;
@property(nonatomic) napi_ref actionCallback;
@property(nonatomic) NSInteger identifier;
@property(nonatomic) BOOL anchoredToHost;
@property(nonatomic) NSRect hostBounds;
@property(nonatomic) NSRect hostWorkArea;
@property(nonatomic) CGWindowID targetWindowID;
@property(nonatomic) CGFloat cardAspectRatio;
@property(nonatomic) NSPoint moveStart;
@property(nonatomic) NSPoint moveOrigin;
@property(nonatomic) BOOL moveStarted;
@property(nonatomic) BOOL liveFrameReceived;
@property(nonatomic) NSInteger captureGeneration;
@property(nonatomic) size_t frameWidth;
@property(nonatomic) size_t frameHeight;
@property(nonatomic) double cursorX;
@property(nonatomic) double cursorY;
- (void)beginMove;
- (void)continueMove;
- (void)performAction:(const char *)action;
- (void)performPointerAction:(const char *)action point:(NSPoint)point deltaY:(double)deltaY;
- (void)resizeToLongEdge:(CGFloat)edge;
- (void)placeNearHost:(NSRect)host workArea:(NSRect)workArea animated:(BOOL)animated;
- (void)setTargetWindowID:(CGWindowID)windowID;
@end

@implementation MemmyPIPContentView
- (BOOL)isOpaque { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (NSView *)hitTest:(NSPoint)point { return self; }
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

@implementation MemmyPIP
- (instancetype)initWithID:(NSInteger)identifier title:(NSString *)title width:(CGFloat)width
                  height:(CGFloat)height x:(CGFloat)x y:(CGFloat)y env:(napi_env)env
                  callback:(napi_ref)callback placementAvailable:(BOOL)placementAvailable
                  interruptAvailable:(BOOL)interruptAvailable {
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
  (void)placementAvailable;
  (void)interruptAvailable;
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
  napi_value callback, global, arguments[6];
  if (napi_get_reference_value(_env, _actionCallback, &callback) == napi_ok
      && napi_get_global(_env, &global) == napi_ok
      && napi_create_string_utf8(_env, action, NAPI_AUTO_LENGTH, &arguments[0]) == napi_ok
      && napi_create_double(_env, x, &arguments[1]) == napi_ok
      && napi_create_double(_env, y, &arguments[2]) == napi_ok
      && napi_create_double(_env, deltaY, &arguments[3]) == napi_ok
      && napi_create_double(_env, (double)_frameWidth, &arguments[4]) == napi_ok
      && napi_create_double(_env, (double)_frameHeight, &arguments[5]) == napi_ok)
    napi_call_function(_env, global, callback, 6, arguments, nullptr);
  napi_close_handle_scope(_env, scope);
}
- (void)performAction:(const char *)action { [self emitAction:action x:0 y:0 deltaY:0]; }
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
    self.anchoredToHost = NO;
    [self performAction:"dragged"];
  }
  self.moveStarted = YES;
  [self.panel setFrameOrigin:NSMakePoint(self.moveOrigin.x + dx, self.moveOrigin.y + dy)];
}
- (void)performPointerAction:(const char *)action point:(NSPoint)point deltaY:(double)deltaY {
  NSRect card = _cardView.frame;
  if (!NSPointInRect(point, card)) return;
  double localX = point.x - NSMinX(card), localY = point.y - NSMinY(card);
  double radius = MIN(8, MIN(NSWidth(card), NSHeight(card)) / 2);
  double centerX = localX < radius ? radius : localX > NSWidth(card) - radius ? NSWidth(card) - radius : localX;
  double centerY = localY < radius ? radius : localY > NSHeight(card) - radius ? NSHeight(card) - radius : localY;
  if (hypot(localX - centerX, localY - centerY) > radius) return;
  double x = localX / NSWidth(card);
  double y = 1 - localY / NSHeight(card);
  [self emitAction:action x:x y:y deltaY:deltaY];
}
- (void)layoutCursor {
  if (_cursorView.hidden) return;
  NSRect card = _cardView.bounds;
  CGFloat tipX = _cursorX * NSWidth(card);
  CGFloat tipY = (1.0 - _cursorY) * NSHeight(card);
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
  if (![active isKindOfClass:[NSNumber class]] || !active.boolValue) {
    _cursorView.hidden = YES;
    return;
  }
  NSNumber *x = info[@"x"];
  NSNumber *y = info[@"y"];
  if (![x isKindOfClass:[NSNumber class]] || ![y isKindOfClass:[NSNumber class]]) return;
  _cursorX = MIN(1, MAX(0, x.doubleValue));
  _cursorY = MIN(1, MAX(0, y.doubleValue));
  _cursorView.hidden = NO;
  [self layoutCursor];
}
- (void)setTargetWindowID:(CGWindowID)windowID {
  if (windowID == 0 || (windowID == _targetWindowID && _stream != nil)) return;
  _targetWindowID = windowID;
  _liveFrameReceived = NO;
  _frameWidth = 0;
  _frameHeight = 0;
  _cursorView.hidden = YES;
  NSInteger generation = ++_captureGeneration;
  SCStream *previous = _stream;
  _stream = nil;
  [previous stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; }];
  __weak MemmyPIP *weakSelf = self;
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
    completionHandler:^(SCShareableContent *content, NSError *error) {
      MemmyPIP *owner = weakSelf;
      if (!owner || error || !content || owner.captureGeneration != generation) return;
      SCWindow *match = nil;
      for (SCWindow *window in content.windows) {
        if (window.windowID == windowID) { match = window; break; }
      }
      if (!match) return;
      SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:match];
      SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
      CGFloat scale = NSScreen.mainScreen.backingScaleFactor > 0 ? NSScreen.mainScreen.backingScaleFactor : 2;
      config.width = (size_t)MAX(2, round(match.frame.size.width * scale));
      config.height = (size_t)MAX(2, round(match.frame.size.height * scale));
      config.showsCursor = NO;
      config.pixelFormat = kCVPixelFormatType_32BGRA;
      config.minimumFrameInterval = CMTimeMake(1, 30);
      config.queueDepth = 4;
      SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
      dispatch_queue_t queue = dispatch_queue_create("memmy.pip.capture", DISPATCH_QUEUE_SERIAL);
      NSError *addError = nil;
      if (![stream addStreamOutput:owner type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&addError] || addError) return;
      [stream startCaptureWithCompletionHandler:^(NSError *startError) { (void)startError; }];
      dispatch_async(dispatch_get_main_queue(), ^{
        MemmyPIP *owner = weakSelf;
        if (!owner || owner.captureGeneration != generation || owner.targetWindowID != windowID) {
          [stream stopCaptureWithCompletionHandler:^(NSError *stopError) { (void)stopError; }];
          return;
        }
        owner.stream = stream;
      });
    }];
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeScreen || stream != _stream) return;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  if (attachments && CFArrayGetCount(attachments) > 0) {
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *status = info[SCStreamFrameInfoStatus];
    if ([status isKindOfClass:[NSNumber class]] && status.integerValue != SCFrameStatusComplete
        && status.integerValue != SCFrameStatusStarted) return;
  }
  CVImageBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (!pixelBuffer) return;
  if (!_captureContext) _captureContext = [CIContext contextWithOptions:nil];
  CIImage *image = [CIImage imageWithCVPixelBuffer:pixelBuffer];
  if (CGRectIsEmpty(image.extent)) return;
  CGImageRef frame = [_captureContext createCGImage:image fromRect:image.extent];
  if (!frame) return;
  size_t width = CGImageGetWidth(frame);
  size_t height = CGImageGetHeight(frame);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.stream != stream) { CGImageRelease(frame); return; }
    self.frameWidth = width;
    self.frameHeight = height;
    self.liveFrameReceived = YES;
    self.imageView.hidden = YES;
    self.cardView.layer.contents = (__bridge id)frame;
    self.cardView.layer.contentsGravity = kCAGravityResizeAspect;
    CGImageRelease(frame);
  });
}
- (void)resizeToLongEdge:(CGFloat)edge {
  NSRect frame = _panel.frame;
  CGFloat width = _cardAspectRatio >= 1 ? edge : edge * _cardAspectRatio;
  CGFloat height = _cardAspectRatio >= 1 ? edge / _cardAspectRatio : edge;
  frame.origin.y += frame.size.height - (height + 32);
  frame.size = NSMakeSize(width + 32, height + 32);
  [_panel setFrame:frame display:YES animate:YES];
  _cardView.frame = NSMakeRect(16, 16, width, height);
  _shadowLayer.frame = CGRectMake(16, 16, width, height);
  CGPathRef path = CGPathCreateWithRoundedRect(CGRectMake(0, 0, width, height), 8, 8, NULL);
  _shadowLayer.shadowPath = path;
  CGPathRelease(path);
  if (_anchoredToHost) {
    _anchoredToHost = NO;
    [self performAction:"dragged"];
  }
  [self layoutCursor];
}
- (void)placeNearHost:(NSRect)host workArea:(NSRect)workArea animated:(BOOL)animated {
  if (NSWidth(host) <= 0 || NSHeight(host) <= 0 || NSWidth(workArea) <= 0 || NSHeight(workArea) <= 0) return;
  _anchoredToHost = YES;
  _hostBounds = host;
  _hostWorkArea = workArea;
  NSRect card = _cardView.frame;
  CGFloat x = NSMidX(host) - NSWidth(card) / 2;
  CGFloat y = NSMaxY(host) + 12;
  if (y + NSHeight(card) > NSMaxY(workArea) - 8) y = NSMinY(host) - NSHeight(card) - 12;
  x = MAX(NSMinX(workArea) + 8, MIN(x, NSMaxX(workArea) - NSWidth(card) - 8));
  y = MAX(NSMinY(workArea) + 8, MIN(y, NSMaxY(workArea) - NSHeight(card) - 8));
  NSRect panelFrame = _panel.frame;
  panelFrame.origin = NSMakePoint(x - 16, y - 16);
  [_panel setFrame:panelFrame display:YES animate:animated];
  [self layoutCursor];
}
- (void)setImageData:(NSData *)data {
  if (_liveFrameReceived) return;
  NSImage *image = [[NSImage alloc] initWithData:data];
  if (!image) return;
  _imageView.hidden = NO;
  _imageView.image = image;
}
- (void)close {
  [[NSDistributedNotificationCenter defaultCenter] removeObserver:self];
  SCStream *stream = _stream;
  _stream = nil;
  if (stream) {
    [stream removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
    [stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; }];
  }
  [_panel close];
  if (_actionCallback) { napi_delete_reference(_env, _actionCallback); _actionCallback = nullptr; }
}
@end

static std::map<int, MemmyPIP *> windows;
static int nextID = 1;

static bool getNumber(napi_env env, napi_value value, double *out) {
  return napi_get_value_double(env, value, out) == napi_ok && std::isfinite(*out);
}
static napi_value create(napi_env env, napi_callback_info info) {
  size_t argc = 8; napi_value args[8];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 6 || argc > 8) { napi_throw_type_error(env, nullptr, "create(title,width,height,x,y,onAction,placementAvailable?,interruptAvailable?)"); return nullptr; }
  size_t length = 0; napi_get_value_string_utf8(env, args[0], nullptr, 0, &length);
  if (length > 256) { napi_throw_range_error(env, nullptr, "title too long"); return nullptr; }
  std::string title(length + 1, '\0');
  napi_get_value_string_utf8(env, args[0], title.data(), title.size(), &length);
  double width, height, x, y;
  if (!getNumber(env,args[1],&width) || !getNumber(env,args[2],&height) ||
      !getNumber(env,args[3],&x) || !getNumber(env,args[4],&y) ||
      width < 100 || height < 100 || width > 800 || height > 800) {
    napi_throw_range_error(env, nullptr, "invalid bounds"); return nullptr;
  }
  napi_valuetype kind; napi_typeof(env,args[5],&kind);
  if (kind != napi_function) { napi_throw_type_error(env,nullptr,"onAction must be a function"); return nullptr; }
  bool placementAvailable = true;
  if (argc >= 7 && napi_get_value_bool(env,args[6],&placementAvailable) != napi_ok) {
    napi_throw_type_error(env,nullptr,"placementAvailable must be a boolean"); return nullptr;
  }
  bool interruptAvailable = false;
  if (argc == 8 && napi_get_value_bool(env,args[7],&interruptAvailable) != napi_ok) {
    napi_throw_type_error(env,nullptr,"interruptAvailable must be a boolean"); return nullptr;
  }
  napi_ref callback; napi_create_reference(env,args[5],1,&callback);
  int id = nextID++;
  NSString *name = [[NSString alloc] initWithBytes:title.data() length:length encoding:NSUTF8StringEncoding];
  MemmyPIP *window = [[MemmyPIP alloc] initWithID:id title:name width:width height:height x:x y:y
    env:env callback:callback placementAvailable:placementAvailable interruptAvailable:interruptAvailable];
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
  size_t argc = 2; napi_value args[2]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  if (argc == 2) {
    MemmyPIP *window = lookup(env,args[0]); int32_t target = 0;
    if (window && napi_get_value_int32(env,args[1],&target) == napi_ok && target > 0)
      window.targetWindowID = (CGWindowID)target;
  }
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value placeNearHost(napi_env env, napi_callback_info info) {
  size_t argc = 10; napi_value args[10]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  if (argc == 10) {
    MemmyPIP *window = lookup(env,args[0]); double values[8]; bool valid = window != nil;
    for (int i = 0; i < 8 && valid; i++) valid = getNumber(env,args[i + 1],&values[i]);
    bool animated = false;
    valid = valid && napi_get_value_bool(env,args[9],&animated) == napi_ok;
    if (valid && values[2] > 0 && values[3] > 0 && values[6] > 0 && values[7] > 0)
      [window placeNearHost:NSMakeRect(values[0],values[1],values[2],values[3])
        workArea:NSMakeRect(values[4],values[5],values[6],values[7]) animated:animated];
  }
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value closeWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  if (argc == 1) { int32_t id; if (napi_get_value_int32(env,args[0],&id) == napi_ok) {
    auto item = windows.find(id); if (item != windows.end()) { [item->second close]; windows.erase(item); }
  }}
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"create",nullptr,create,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setImage",nullptr,setImage,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setTargetWindow",nullptr,setTargetWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"placeNearHost",nullptr,placeNearHost,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"close",nullptr,closeWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
  };
  napi_define_properties(env,exports,sizeof(properties) / sizeof(properties[0]),properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
