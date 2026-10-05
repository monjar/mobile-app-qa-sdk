# Snitch core. Everything is called directly except the optional
# snitch-system-capture module, which the core finds by name (its own
# consumer rules keep that class).
-keep class io.github.monjar.snitch.SnitchInitProvider { <init>(); }
