#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// The `Snitch` TurboModule (JS: `TurboModuleRegistry.get('Snitch')`).
///
/// Conformance to the codegen'd `NativeSnitchSpec` protocol is declared in
/// RNSnitch.mm: the spec header is Objective-C++ only, while this header ends
/// up in the pod's umbrella header, which Swift and plain .m files import.
@interface RNSnitch : NSObject
@end

NS_ASSUME_NONNULL_END
