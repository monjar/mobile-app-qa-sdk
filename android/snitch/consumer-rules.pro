# Snitch core. Everything is called directly except the optional
# snitch-system-capture module, which the core finds by name (its own
# consumer rules keep that class).
-keep class io.github.monjar.snitch.SnitchInitProvider { <init>(); }

# SnitchOkHttpInterceptor is compiled against OkHttp but the library doesn't
# depend on it: in apps without OkHttp the class is unused and R8 drops it.
-dontwarn okhttp3.**
-dontwarn okio.**
