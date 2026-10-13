// React Native's side of the report timeline (docs/sdk-spec.md §11.4, §11.5): JavaScript console
// lines and requests made with fetch / XMLHttpRequest. Neither hook does anything in an inert SDK
// (store builds, `Enabled` false, no configuration).
//
// Network (`CaptureNetwork` in the Info.plist `Snitch` dictionary, off by default): at +load,
// before React Native creates its URLSession, install a session configuration provider that
// returns React Native's own default configuration with Snitch's URLProtocol in front. React
// Native builds that session once, possibly before Snitch has activated, so the protocol decides
// per request (canInit) and only takes requests while Snitch is active with network capture on.
// An app that calls RCTSetCustomNSURLSessionConfigurationProvider itself replaces this provider
// (the last call wins); requests made with that configuration are then not in the timeline.
// expo/fetch (Expo's streaming fetch) has its own session and its own provider hook,
// EXFetchCustomExtension, which gets the same configuration when Expo is in the app; it is looked
// up at run time so the pod doesn't depend on Expo. Sessions other libraries create themselves
// are not covered.
//
// Console (`CaptureConsole`, on by default): once Snitch has activated, add a React Native log
// function that hands JavaScript console lines to Snitch. React Native passes JS lines through
// RCTLog (bridge and bridgeless alike), filtered by the log threshold, so lower that to info.

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTHTTPRequestHandler.h>
#import <React/RCTLog.h>

#if __has_include("react_native_snitch-Swift.h")
#import "react_native_snitch-Swift.h"
#else
#import <react_native_snitch/react_native_snitch-Swift.h>
#endif

@interface SNReactNativeCapture : NSObject
@end

/// A boolean in the `Snitch` dictionary (written as a plist bool; a hand-written "YES"/"true" works too).
static BOOL SNConfigFlag(NSDictionary *config, NSString *key, BOOL fallback)
{
  id value = config[key];
  return [value respondsToSelector:@selector(boolValue)] ? [value boolValue] : fallback;
}

static NSString *SNJavaScriptLevel(RCTLogLevel level)
{
  switch (level) {
    case RCTLogLevelTrace:
      return @"debug";
    case RCTLogLevelInfo:
      return @"info";
    case RCTLogLevelWarning:
      return @"warn";
    case RCTLogLevelError:
    case RCTLogLevelFatal:
      return @"error";
  }
  return @"info";
}

/// Set while a line is handed to Snitch on this thread, so nothing Snitch does can loop back here.
static __thread BOOL sForwardingLogLine;

static void SNInstallConsoleCapture(void)
{
  // console.log is RCTLogLevelInfo: make sure React Native lets it through (it keeps lower levels).
  RCTSetLogThreshold(MIN(RCTGetLogThreshold(), RCTLogLevelInfo));
  // Runs on the JS thread for every line that passes the threshold: forward and return.
  RCTAddLogFunction(^(RCTLogLevel level, RCTLogSource source, NSString *fileName, NSNumber *lineNumber, NSString *message) {
    if (source != RCTLogSourceJavaScript || message == nil || sForwardingLogLine) {
      return;
    }
    sForwardingLogLine = YES;
    [SNSnitchBridge logJS:message level:SNJavaScriptLevel(level)];
    sForwardingLogLine = NO;
  });
}

/// React Native's default session configuration with Snitch's protocol in front.
static NSURLSessionConfiguration *SNCapturingConfiguration(void)
{
  // React Native's default configuration, as RCTHTTPRequestHandler builds it without a
  // provider (unchanged from React Native 0.76 to 0.86; ExpoFetchModule builds the same one
  // in Expo 52 and 57): cookies always accepted and sent from the shared storage, and Wi-Fi
  // only when ReactNetworkForceWifiOnly is YES.
  NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
  NSNumber *useWifiOnly = [[[NSBundle mainBundle] infoDictionary] objectForKey:@"ReactNetworkForceWifiOnly"];
  if (useWifiOnly) {
    configuration.allowsCellularAccess = ![useWifiOnly boolValue];
  }
  [configuration setHTTPShouldSetCookies:YES];
  [configuration setHTTPCookieAcceptPolicy:NSHTTPCookieAcceptPolicyAlways];
  [configuration setHTTPCookieStorage:[NSHTTPCookieStorage sharedHTTPCookieStorage]];

  // Snitch's protocol first; it passes on every request it doesn't take.
  Class snitchProtocol = [SNSnitchBridge networkProtocolClass];
  NSMutableArray<Class> *protocols = [NSMutableArray arrayWithObject:snitchProtocol];
  for (Class protocol in configuration.protocolClasses) {
    if (protocol != snitchProtocol) {
      [protocols addObject:protocol];
    }
  }
  configuration.protocolClasses = protocols;
  return configuration;
}

static void SNInstallNetworkCapture(void)
{
  RCTSetCustomNSURLSessionConfigurationProvider(^NSURLSessionConfiguration * {
    return SNCapturingConfiguration();
  });

  // expo/fetch: +[EXFetchCustomExtension setCustomURLSessionConfigurationProvider:] takes a block
  // returning a configuration (Expo 52 types it with React Native's typedef, Expo 57 with its own
  // optional-returning alias; both are this block). ExpoFetchModule reads it when it creates its
  // session, on the first expo/fetch request. Main thread here, as Expo 57 requires.
  Class expoFetch = NSClassFromString(@"EXFetchCustomExtension");
  SEL setter = NSSelectorFromString(@"setCustomURLSessionConfigurationProvider:");
  if (expoFetch != nil && [expoFetch respondsToSelector:setter]) {
    NSURLSessionConfiguration * (^provider)(void) = ^NSURLSessionConfiguration * {
      return SNCapturingConfiguration();
    };
    ((void (*)(id, SEL, id))[expoFetch methodForSelector:setter])(expoFetch, setter, provider);
  }
}

@implementation SNReactNativeCapture

static id<NSObject> sActivationObserver;

+ (void)load
{
  NSDictionary *config = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"Snitch"];
  if ([config isKindOfClass:[NSDictionary class]] && SNConfigFlag(config, @"Enabled", YES) &&
      SNConfigFlag(config, @"CaptureNetwork", NO)) {
    SNInstallNetworkCapture();
  }

  // Snitch activates once it has a configuration (Info.plist or Snitch.start from JavaScript)
  // and the release type is enabled; an inert SDK never posts this.
  sActivationObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:SNSnitchBridge.didActivateNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *_Nonnull note) {
                if (![SNSnitchBridge consoleCaptureEnabled]) {
                  return;
                }
                [[NSNotificationCenter defaultCenter] removeObserver:sActivationObserver];
                sActivationObserver = nil;
                SNInstallConsoleCapture();
              }];
}

@end
