# react-native-snitch consumer rules (mirror android/snitch/consumer-rules.pro and
# android/snitch-system-capture's rules: the RN module compiles both sets of sources).

# Autostart provider, instantiated by the framework.
-keep class io.github.monjar.snitch.SnitchInitProvider { <init>(); }

# The core loads the system-capture entry point by name (Class.forName) and creates
# it with its no-arg constructor.
-keep class io.github.monjar.snitch.system.SystemCapture { public <init>(); }
