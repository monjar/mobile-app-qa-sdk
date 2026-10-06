// Zero-code start for React Native apps: once the app has finished launching,
// tag reports as coming from the React Native wrapper and start Snitch from
// the Info.plist `Snitch` dictionary (written by the Expo config plugin, or by
// hand). Without that dictionary nothing starts (no UI, no capture, no network)
// until the app calls `Snitch.start({...})` from JavaScript.

#import <UIKit/UIKit.h>

#if __has_include("react_native_snitch-Swift.h")
#import "react_native_snitch-Swift.h"
#else
#import <react_native_snitch/react_native_snitch-Swift.h>
#endif

// SNITCH_RN_VERSION is set by react-native-snitch.podspec from package.json.
#ifndef SNITCH_RN_VERSION
#define SNITCH_RN_VERSION 0.0.0
#endif
#define SN_STRINGIFY_(x) #x
#define SN_STRINGIFY(x) SN_STRINGIFY_(x)

@interface SNAutoStart : NSObject
@end

@implementation SNAutoStart

static id<NSObject> sLaunchObserver;

+ (void)load
{
  // +load runs before main(): only register the observer here, do the work after launch.
  sLaunchObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *_Nonnull note) {
                [[NSNotificationCenter defaultCenter] removeObserver:sLaunchObserver];
                sLaunchObserver = nil;
                [SNSnitchBridge setWrapper:@"react-native" version:@SN_STRINGIFY(SNITCH_RN_VERSION)];
                // No `Snitch` dictionary: leave the SDK unstarted, so a later
                // `Snitch.start({...})` from JavaScript is not ignored as a second start.
                if ([[NSBundle mainBundle] objectForInfoDictionaryKey:@"Snitch"] != nil) {
                  [SNSnitchBridge startFromInfoPlist];
                }
              }];
}

@end
