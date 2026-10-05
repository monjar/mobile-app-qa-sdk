# The Snitch core loads this class reflectively (Class.forName) and creates it
# with its no-arg constructor.
-keep class io.github.monjar.snitch.system.SystemCapture { public <init>(); }
