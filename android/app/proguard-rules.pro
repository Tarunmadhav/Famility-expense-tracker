# R8 rules for the release build.
#
# The app has no reflection of its own: the WebView bridge is plain
# evaluateJavascript, and every entry point (activity, receiver, service) is
# named in AndroidManifest.xml, which AGP keeps automatically. These rules are
# only here so the JavaScript interface and the manifest-declared components stay
# obvious to anyone reading a shrinking bug report.

# Keep the activity that hosts the WebView (the manifest already does this, but
# naming it here makes a shrinking failure impossible to misdiagnose).
-keep class com.family.planner.MainActivity { *; }

# Keep @JavascriptInterface members, whether or not a WebView bridge is added
# later; R8 would otherwise strip a method that is only called from JavaScript.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
