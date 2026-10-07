#import "RNSnitch.h"

#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>

// Objective-C++ compiles without Clang modules, so the generated Swift header's
// `@import`s are skipped there: import what it may reference (UIKit) first.
#if __has_include("react_native_snitch-Swift.h")
#import "react_native_snitch-Swift.h"
#else
#import <react_native_snitch/react_native_snitch-Swift.h>
#endif

#ifdef RCT_NEW_ARCH_ENABLED
#import <RNSnitchSpec/RNSnitchSpec.h>

@interface RNSnitch () <NativeSnitchSpec>
@end
#else
@interface RNSnitch () <RCTBridgeModule>
@end
#endif

/// JS null arrives as NSNull inside dictionaries; the Swift side expects absent keys.
static NSDictionary<NSString *, id> *SNWithoutNulls(NSDictionary *options)
{
  if (![options isKindOfClass:[NSDictionary class]]) {
    return @{};
  }
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionaryWithCapacity:options.count];
  [options enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
    if ([key isKindOfClass:[NSString class]] && value != [NSNull null]) {
      clean[key] = value;
    }
  }];
  return clean;
}

static NSString *_Nullable SNNullable(NSString *_Nullable value)
{
  return [value isKindOfClass:[NSString class]] ? value : nil;
}

@implementation RNSnitch

RCT_EXPORT_MODULE(Snitch)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

/// Async methods run on the main queue, in call order. SNSnitchBridge hops to
/// main itself as well, so this only saves a dispatch and keeps ordering.
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

// RCT_EXPORT_METHOD keeps the module usable through the bridge (old
// architecture); on the new architecture the codegen'd JSI glue below calls
// the same selectors.

RCT_EXPORT_METHOD(start : (NSString *)serverUrl ingestKey : (NSString *)ingestKey options : (NSDictionary *)options)
{
  [SNSnitchBridge startWithServerURL:serverUrl ingestKey:ingestKey options:SNWithoutNulls(options)];
}

RCT_EXPORT_METHOD(show : (NSString *_Nullable)type)
{
  [SNSnitchBridge show:SNNullable(type)];
}

RCT_EXPORT_METHOD(setUser : (NSString *_Nullable)userId email : (NSString *_Nullable)email name : (NSString *_Nullable)name)
{
  [SNSnitchBridge setUser:SNNullable(userId) email:SNNullable(email) name:SNNullable(name)];
}

RCT_EXPORT_METHOD(setMetadata : (NSString *)key value : (NSString *_Nullable)value)
{
  [SNSnitchBridge setMetadata:key value:SNNullable(value)];
}

RCT_EXPORT_METHOD(log : (NSString *)message level : (NSString *)level)
{
  [SNSnitchBridge log:message level:level];
}

RCT_EXPORT_METHOD(setEnabled : (BOOL)enabled)
{
  [SNSnitchBridge setEnabled:enabled];
}

// Synchronous: called on the JS thread. SNSnitchBridge's getters are thread-safe.
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSNumber *, isEnabled)
{
  return @([SNSnitchBridge isEnabled]);
}

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSString *, getReleaseType)
{
  return [SNSnitchBridge releaseType];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeSnitchSpecJSI>(params);
}
#endif

@end
