# react-native-snitch consumer rules (mirror android/snitch/consumer-rules.pro and
# android/snitch-system-capture's rules: the RN module compiles both sets of sources).

# Autostart provider and the React Native network-capture provider, instantiated by the framework.
-keep class io.github.monjar.snitch.SnitchInitProvider { <init>(); }
-keep class io.github.monjar.snitch.rn.SnitchReactNativeInitProvider { <init>(); }

# The core loads the system-capture entry point by name (Class.forName) and creates
# it with its no-arg constructor.
-keep class io.github.monjar.snitch.system.SystemCapture { public <init>(); }
