package com.family.planner;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.graphics.Color;
import android.hardware.biometrics.BiometricPrompt;
import android.hardware.fingerprint.FingerprintManager;
import android.os.CancellationSignal;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Native shell around the deployed planner: keeps the session cookie, handles the
 * back button and exposes AndroidBridge.notify(title, body) to the web app so
 * planner alerts appear as real Android notifications.
 */
public class MainActivity extends Activity {

    // Supplied by Gradle (android/gradle.properties -> plannerApiBaseUrl), so a
    // debug build can point at a local Worker without touching this file.
    private static final String START_URL = BuildConfig.PLANNER_URL;
    // In-app links are the ones on the deployment's own host, so moving the Worker to
    // another domain (freebuff.page -> workers.dev) needs no code change here.
    private static final String APP_HOST = Uri.parse(START_URL).getHost() == null
            ? "" : Uri.parse(START_URL).getHost();
    private static final String CHANNEL_ID = "planner_alerts";
    // Reminders get their own channel because Android freezes a channel's importance
    // at creation: planner_alerts was created at IMPORTANCE_DEFAULT and can never
    // show a heads-up banner, however the notification that uses it is posted.
    private static final String REMINDER_CHANNEL_ID = "planner_reminders_v2";
    private static final String ALERT_PREFS = "planner_alerts";
    private static final long POSTED_KEEP_MS = 7L * 24 * 60 * 60 * 1000;
    private static final long POLL_INTERVAL_MS = 15L * 60 * 1000;
    private static final String ALERT_ACTION = "com.family.planner.CHECK_ALERTS";
    private static final int ALERT_REQUEST = 90;
    private static final int NOTIFICATION_PERMISSION = 7;
    // Social sign-in starts in the system browser and comes back as an app link on
    // this path (see the intent filter in AndroidManifest.xml).
    private static final String OAUTH_RETURN_PATH = "/api/auth/oauth/finish";

    // A <input type="file"> in the page (import a CSV/Excel file, attach a receipt,
    // restore a backup) only opens the system picker if the WebView has a
    // WebChromeClient that answers onShowFileChooser. Without one, Android silently
    // does nothing when the clicked input asks for a file.
    private static final int FILE_CHOOSER_REQUEST = 4501;
    private ValueCallback<Uri[]> filePathCallback;
    // True while our own picker is in front. The picker pauses this activity, and a
    // pause normally locks the planner and drops what is on screen — which would make
    // finishing an import impossible, because the unlock screen replaces the form.
    private boolean choosingFile;

    private WebView web;
    private View splash;
    // Non-null while the system biometric prompt is up. It is also the guard that
    // stops a double tap from opening two prompts on top of each other.
    private CancellationSignal biometricCancel;
    // The lock screen asks once per paint; the answer is cached for the loaded
    // page so a re-render never waits on the bridge again.
    private boolean biometricKnown;
    private boolean biometricEnrolled;
    // System bar height in CSS pixels, published to the page as --inset-top/--inset-bottom.
    private int insetTopDp;
    private int insetBottomDp;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        createChannel();
        createReminderChannel();
        requestNotificationPermission();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0F172A"));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Everything the app needs comes from the deployed origin over HTTPS. File and
        // content access are switched off so a crafted page cannot read anything the
        // app has on disk (the session cookie and cached planner data live there), and
        // a file:// page can never navigate into the deployment's origin.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Keep the rendered app and its assets on disk so a warm start paints from
        // cache while the network request for fresh data is still in flight.
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " FamilyPlannerApp/2.1");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        // Lets `chrome://inspect` attach to a build made with plannerWebViewDebug.
        // Off in the published APK: the bridge and the session cookie are only
        // reachable from this WebView, and a remote debugger is another way in.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.WEBVIEW_DEBUG);

        web.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // A second request while one is open replaces the first, otherwise the
                // earlier callback never receives a value and the page waits forever.
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                filePathCallback = callback;
                choosingFile = true;
                Intent picker;
                try {
                    picker = params.createIntent();
                } catch (Exception e) {
                    picker = null;
                }
                if (picker == null) {
                    picker = new Intent(Intent.ACTION_GET_CONTENT);
                    picker.addCategory(Intent.CATEGORY_OPENABLE);
                    picker.setType("*/*");
                }
                try {
                    startActivityForResult(picker, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    choosingFile = false;
                    return false;
                }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost() == null ? "" : uri.getHost();
                if (host.equals(APP_HOST)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // no handler installed for this link
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                // Navigating away invalidates any prompt that belonged to the old
                // page; leaving it up would authenticate a screen that is gone.
                cancelBiometric();
                biometricKnown = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // A new page may be shown after the person enrolled or removed a
                // fingerprint in system settings, so the cached answer is dropped.
                biometricKnown = false;
                hideSplash();
                pushInsets();
                CookieManager.getInstance().flush();
            }
        });

        // The splash is native, so the first frame is instant instead of a white
        // rectangle that waits for DNS, TLS and the Worker cold start.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0F172A"));
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
        watchInsets(root);
        // A cold start can itself be the return leg of a browser sign-in, in which
        // case this replaces the normal entry point with the ticket URL.
        Uri launch = getIntent() == null ? null : getIntent().getData();
        if (launch != null && "https".equals(launch.getScheme())
                && APP_HOST.equals(launch.getHost() == null ? "" : launch.getHost())
                && (launch.getPath() == null ? "" : launch.getPath()).startsWith(OAUTH_RETURN_PATH)) {
            web.loadUrl(launch.toString());
        } else {
            web.loadUrl(START_URL);
        }
    }

    private View buildSplash() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setBackgroundColor(Color.parseColor("#0F172A"));

        TextView logo = new TextView(this);
        logo.setText("₹");
        logo.setTextSize(44f);
        logo.setGravity(Gravity.CENTER);
        logo.setTextColor(Color.parseColor("#34D399"));

        TextView title = new TextView(this);
        title.setText("Family Finance Planner");
        title.setTextSize(20f);
        title.setGravity(Gravity.CENTER);
        title.setTextColor(Color.WHITE);

        TextView hint = new TextView(this);
        hint.setText("Opening your planner…");
        hint.setTextSize(13f);
        hint.setGravity(Gravity.CENTER);
        hint.setTextColor(Color.parseColor("#94A3B8"));

        ProgressBar bar = new ProgressBar(this);
        bar.setIndeterminate(true);

        column.addView(logo);
        column.addView(title);
        column.addView(hint);
        column.addView(bar);
        return column;
    }

    private void hideSplash() {
        if (splash == null || splash.getVisibility() != View.VISIBLE) return;
        splash.animate().alpha(0f).setDuration(150).withEndAction(new Runnable() {
            @Override
            public void run() {
                if (splash != null) splash.setVisibility(View.GONE);
            }
        }).start();
    }

    /*
     * Android 15 forces every app targeting SDK 35 edge to edge, and a WebView does
     * not expose env(safe-area-inset-*) on Android, so the top bar was drawn under
     * the status bar and could not be tapped. Whatever the platform gives us here is
     * published to the page as --inset-top / --inset-bottom, which style.css adds to
     * the top bar, the drawer and the tab bar.
     */
    private void watchInsets(View root) {
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                readInsets(insets);
                pushInsets();
                return insets;
            }
        });
        root.requestApplyInsets();
    }

    private void readInsets(WindowInsets insets) {
        if (insets == null) return;
        int top;
        int bottom;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            top = bars.top;
            bottom = bars.bottom;
        } else {
            top = insets.getSystemWindowInsetTop();
            bottom = insets.getSystemWindowInsetBottom();
        }
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        insetTopDp = Math.round(top / density);
        insetBottomDp = Math.round(bottom / density);
    }

    private void pushInsets() {
        if (web == null) return;
        String js = "document.documentElement.style.setProperty('--inset-top','" + insetTopDp
                + "px');document.documentElement.style.setProperty('--inset-bottom','" + insetBottomDp + "px');";
        web.evaluateJavascript(js, null);
    }

    private void createChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Planner alerts", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Bills, insurance renewals, tasks and birthdays");
        manager.createNotificationChannel(channel);
    }

    /**
     * The channel deadlines are posted on. IMPORTANCE_HIGH is what makes a banner
     * slide down over whatever is on screen; the sound and vibration are the
     * phone's defaults, the same ones the test alert already used.
     */
    private void createReminderChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                REMINDER_CHANNEL_ID, "Deadline reminders", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("A task with a time is due now");
        channel.enableVibration(true);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, NOTIFICATION_PERMISSION);
        }
    }

    /**
     * A sign-in that started in the browser returns to {@code /api/auth/oauth/finish}
     * with a one-time ticket. Loading that URL here, rather than in the browser,
     * is what puts the session cookie in this app's WebView.
     */
    private void handleOauthReturn(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        String host = data.getHost() == null ? "" : data.getHost();
        String path = data.getPath() == null ? "" : data.getPath();
        if (!"https".equals(data.getScheme()) || !APP_HOST.equals(host) || !path.startsWith(OAUTH_RETURN_PATH)) return;
        if (web != null) web.loadUrl(data.toString());
    }

    /**
     * The file the picker returned. Without this the callback stays open and the
     * page's input never receives a file, which looks like the button does nothing.
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            choosingFile = false;
            Uri[] picked = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    picked = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        picked[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    picked = new Uri[]{data.getData()};
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(picked);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOauthReturn(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // A WebView does not reliably deliver visibilitychange for every way the app
        // can leave the foreground (Home, recents, screen off, a system dialog), so the
        // lock is requested from here as well. This is what makes closing the app lock
        // it instead of relying on the inactivity timer.
        if (web != null) {
            // The file picker is our own activity: the user has not left the planner,
            // and locking here would throw away the form they are filling in.
            if (!choosingFile) {
                web.evaluateJavascript("window.__plannerHide&&window.__plannerHide()", null);
            }
            web.onPause();
        }
        // A sign-in arrives as an XHR Set-Cookie, long after onPageFinished, so the
        // cookie jar still holds it only in memory. Without this flush the process
        // dying (swipe away, low memory) loses the session and the next launch asks
        // the user to sign in again.
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The person may have enrolled or removed a credential in system settings
        // while the app was away, so the cached answer is no longer trusted.
        biometricKnown = false;
        // A picker that returned without a result (back press) still ends the pause
        // exemption, so the next Home press locks as usual.
        if (choosingFile && filePathCallback == null) choosingFile = false;
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        cancelBiometric();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    void postNotification(String title, String body) {
        try {
            Intent intent = new Intent(this, MainActivity.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(this, 0, intent, flags);

            String text = body == null ? "" : body;
            Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title == null ? "Family Finance Planner" : title)
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setAutoCancel(true)
                    .setContentIntent(pending);

            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            manager.notify((int) (System.currentTimeMillis() % 100000), builder.build());
        } catch (Exception error) {
            Toast.makeText(this, "Could not show notification", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * True only while the WebView is showing the deployment itself. The bridge is
     * reachable from any script that runs in that WebView, including one injected into
     * a page opened by a link, so every call checks the current origin before doing
     * anything. The check runs on the UI thread because getUrl is read from there.
     */
    private boolean onTrustedPage() {
        // @JavascriptInterface methods arrive on a WebView bridge thread, so the URL is
        // read on the UI thread and handed back. A timeout keeps a stuck UI thread from
        // blocking the page that called in.
        final String[] current = new String[1];
        final java.util.concurrent.CountDownLatch ready = new java.util.concurrent.CountDownLatch(1);
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    current[0] = web == null ? null : web.getUrl();
                } finally {
                    ready.countDown();
                }
            }
        });
        try {
            if (!ready.await(500, java.util.concurrent.TimeUnit.MILLISECONDS)) return false;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
        String url = current[0];
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        return "https".equals(uri.getScheme()) && APP_HOST.equals(uri.getHost());
    }

    /**
     * A fingerprint reader or face unlock, with at least one credential enrolled.
     * Android 9+ answers this through BiometricManager; the two older releases
     * this app supports (26-27) only have FingerprintManager.
     */
    private boolean biometricAvailable() {
        if (biometricKnown) return biometricEnrolled;
        boolean enrolled = false;
        try {
            if (Build.VERSION.SDK_INT >= 28) {
                android.hardware.biometrics.BiometricManager manager =
                        (android.hardware.biometrics.BiometricManager) getSystemService(Context.BIOMETRIC_SERVICE);
                enrolled = manager != null && manager.canAuthenticate()
                        == android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS;
            } else {
                FingerprintManager legacy =
                        (FingerprintManager) getSystemService(Context.FINGERPRINT_SERVICE);
                enrolled = legacy != null && legacy.isHardwareDetected() && legacy.hasEnrolledFingerprints();
            }
        } catch (Exception error) {
            enrolled = false;
        }
        biometricEnrolled = enrolled;
        biometricKnown = true;
        return enrolled;
    }

    /**
     * One system prompt. The page is told only pass or fail — never the reason and
     * never anything the sensor saw — so a cancelled prompt and a rejected finger
     * both land on "use your PIN".
     */
    private void startBiometric() {
        if (biometricCancel != null) return;
        try {
            biometricCancel = new CancellationSignal();
            if (Build.VERSION.SDK_INT >= 28) {
                BiometricPrompt.Builder builder = new BiometricPrompt.Builder(this)
                        .setTitle("Unlock Family Planner")
                        .setSubtitle("Confirm it is you")
                        // A visible way out that is not "give up": it lands on the PIN
                        // form with a readable message, never on a dead screen.
                        .setNegativeButton("Use PIN", getMainExecutor(), (dialog, which) -> finishBiometric(false));
                if (Build.VERSION.SDK_INT >= 30) {
                    // Strong fingerprint only. The device credential (PIN/pattern) is
                    // the app's own lock screen, not the platform's, so mixing the two
                    // here would let the system PIN stand in for the planner session.
                    builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG);
                }
                BiometricPrompt prompt = builder.build();
                prompt.authenticate(biometricCancel, getMainExecutor(),
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                finishBiometric(true);
                            }

                            @Override
                            public void onAuthenticationError(int code, CharSequence message) {
                                finishBiometric(false);
                            }
                        });
            } else {
                FingerprintManager legacy =
                        (FingerprintManager) getSystemService(Context.FINGERPRINT_SERVICE);
                if (legacy == null) {
                    finishBiometric(false);
                    return;
                }
                legacy.authenticate(null, biometricCancel, 0,
                        new FingerprintManager.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(FingerprintManager.AuthenticationResult result) {
                                finishBiometric(true);
                            }

                            @Override
                            public void onAuthenticationError(int code, CharSequence message) {
                                finishBiometric(false);
                            }
                        }, null);
            }
        } catch (Exception error) {
            finishBiometric(false);
        }
    }

    /** Drops a prompt that is still waiting; the page hears "not recognised". */
    private void cancelBiometric() {
        if (biometricCancel == null) return;
        CancellationSignal signal = biometricCancel;
        biometricCancel = null;
        try {
            signal.cancel();
        } catch (Exception ignored) {
            // already finished
        }
    }

    private void finishBiometric(boolean ok) {
        biometricCancel = null;
        if (web == null) return;
        final boolean passed = ok;
        web.post(new Runnable() {
            @Override
            public void run() {
                if (web == null) return;
                web.evaluateJavascript(
                        "window.__plannerBiometric&&window.__plannerBiometric(" + (passed ? "true" : "false") + ")",
                        null);
            }
        });
    }

    /* ------------------------------------------------------ deadline alerts */

    /** A posted-id key: printable, bounded, and stable for one due moment. */
    static String alertKey(String raw) {
        String base = raw == null ? "" : raw.replaceAll("[^A-Za-z0-9:_-]", "").trim();
        return base.length() > 120 ? base.substring(0, 120) : base;
    }

    static SharedPreferences alertPrefs(Context context) {
        return context.getSharedPreferences(ALERT_PREFS, Context.MODE_PRIVATE);
    }

    /** True when this exact deadline has already been posted on this phone. */
    static boolean alreadyPosted(Context context, String key) {
        if (key.isEmpty()) return false;
        return alertPrefs(context).getLong(key, 0L) > 0L;
    }

    /**
     * Remembers a posted id. Everything older than the retention window is dropped
     * on the same write, so the file stays small without a separate prune pass.
     */
    static void markPosted(Context context, String key) {
        if (key.isEmpty()) return;
        SharedPreferences prefs = alertPrefs(context);
        SharedPreferences.Editor edit = prefs.edit().putLong(key, System.currentTimeMillis());
        long cutoff = System.currentTimeMillis() - POSTED_KEEP_MS;
        for (java.util.Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Long && (Long) value < cutoff) edit.remove(entry.getKey());
        }
        edit.apply();
    }

    /**
     * One tray entry on the heads-up channel. Keyed by the deadline, so posting the
     * same one again replaces it instead of stacking a duplicate.
     */
    static void postReminder(Context context, String key, String title, String body) {
        try {
            Intent open = new Intent(context, MainActivity.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(context, 0, open, flags);
            String text = body == null ? "" : body;
            Notification.Builder builder = new Notification.Builder(context, REMINDER_CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title == null || title.isEmpty() ? "Deadline reminder" : title)
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setAutoCancel(true)
                    .setContentIntent(pending);
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(key.hashCode(), builder.build());
        } catch (Exception ignored) {
            // A failed post must never take the app down with it.
        }
    }

    /** The 15-minute check. Runs with the app closed; holds no state of its own. */
    public static class AlertReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            AlertPoll.poll(context);
        }
    }

    /** Re-arms the alarm after a reboot or an app update; repeating alarms do not survive either. */
    public static class BootReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String action = intent.getAction();
            if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                    || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
                AlertPoll.schedule(context);
            }
        }
    }

    /**
     * The closed-app half of reminders: an inexact 15-minute alarm, one request for
     * the caller's own deadlines, and one tray entry per deadline that has not been
     * posted yet. The session cookie is read from the WebView's own jar and is never
     * copied anywhere; the answer is parsed in memory and dropped.
     */
    static final class AlertPoll {
        private AlertPoll() {
        }

        static PendingIntent intent(Context context) {
            Intent check = new Intent(context, AlertReceiver.class).setAction(ALERT_ACTION);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            return PendingIntent.getBroadcast(context, ALERT_REQUEST, check, flags);
        }

        static void schedule(Context context) {
            try {
                AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
                if (alarms == null) return;
                // Inexact on purpose: no exact-alarm permission is needed, and a
                // reminder a few minutes late is still a reminder.
                alarms.setInexactRepeating(AlarmManager.RTC,
                        System.currentTimeMillis() + POLL_INTERVAL_MS, POLL_INTERVAL_MS, intent(context));
            } catch (Exception ignored) {
                // A platform that refuses the alarm leaves the open-app path working.
            }
        }

        static void cancel(Context context) {
            try {
                AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
                if (alarms != null) alarms.cancel(intent(context));
            } catch (Exception ignored) {
                // nothing to cancel
            }
        }

        static void poll(final Context context) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    java.net.HttpURLConnection conn = null;
                    try {
                        String cookie = CookieManager.getInstance().getCookie(START_URL);
                        // No cookie means signed out: nothing to ask for, and the
                        // next tick after sign-in picks the work up again.
                        if (cookie == null || cookie.isEmpty()) return;
                        java.net.URL url = new java.net.URL(START_URL + "api/alerts/due");
                        conn = (java.net.HttpURLConnection) url.openConnection();
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(15000);
                        conn.setRequestProperty("Cookie", cookie);
                        conn.setRequestProperty("Accept", "application/json");
                        if (conn.getResponseCode() != 200) return;
                        StringBuilder text = new StringBuilder();
                        try (java.io.InputStream in = conn.getInputStream();
                             java.io.BufferedReader reader = new java.io.BufferedReader(
                                     new java.io.InputStreamReader(in, "UTF-8"))) {
                            String line;
                            while ((line = reader.readLine()) != null) text.append(line);
                        }
                        org.json.JSONArray items = new org.json.JSONObject(text.toString()).optJSONArray("items");
                        if (items == null) return;
                        for (int i = 0; i < items.length(); i++) {
                            org.json.JSONObject item = items.optJSONObject(i);
                            if (item == null) continue;
                            String key = alertKey(item.optString("id"));
                            if (alreadyPosted(context, key)) continue;
                            postReminder(context, key, item.optString("title"), "");
                            markPosted(context, key);
                        }
                    } catch (Exception ignored) {
                        // Offline, signed out or a bad answer: the next tick retries.
                    } finally {
                        if (conn != null) {
                            try {
                                conn.disconnect();
                            } catch (Exception ignored) {
                                // already gone
                            }
                        }
                    }
                }
            }).start();
        }
    }

    /** Exposed to JavaScript as window.AndroidBridge. */
    class AndroidBridge {
        AndroidBridge() {
        }

        @JavascriptInterface
        public void notify(String title, String body) {
            if (!onTrustedPage()) return;
            // Titles come from the page, so keep them short and single-line: the
            // notification tray is not a place to render arbitrary HTML or noise.
            String safeTitle = title == null ? "" : title.replaceAll("[\\p{Cntrl}]", " ").trim();
            if (safeTitle.length() > 80) safeTitle = safeTitle.substring(0, 80);
            String safeBody = body == null ? "" : body.replaceAll("[\\p{Cntrl}]", " ").trim();
            if (safeBody.length() > 300) safeBody = safeBody.substring(0, 300);
            postNotification(safeTitle, safeBody);
        }

        /**
         * A deadline reminder: heads-up channel, posted once per id. The id comes
         * from the page (task plus due moment), so a re-render cannot repeat it.
         */
        @JavascriptInterface
        public void notifyReminder(String id, String title, String body) {
            if (!onTrustedPage()) return;
            String key = alertKey(id);
            if (alreadyPosted(MainActivity.this, key)) return;
            String safeTitle = title == null ? "" : title.replaceAll("[\\p{Cntrl}]", " ").trim();
            if (safeTitle.length() > 80) safeTitle = safeTitle.substring(0, 80);
            String safeBody = body == null ? "" : body.replaceAll("[\\p{Cntrl}]", " ").trim();
            if (safeBody.length() > 300) safeBody = safeBody.substring(0, 300);
            postReminder(MainActivity.this, key, safeTitle, safeBody);
            markPosted(MainActivity.this, key);
        }

        /** Arms the closed-app check. Called once the planner is open and unlocked. */
        @JavascriptInterface
        public boolean startAlerts() {
            if (!onTrustedPage()) return false;
            AlertPoll.schedule(MainActivity.this);
            return true;
        }

        /** Disarms it on sign-out, so a signed-out phone asks for nothing. */
        @JavascriptInterface
        public boolean stopAlerts() {
            if (!onTrustedPage()) return false;
            AlertPoll.cancel(MainActivity.this);
            return true;
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        /**
         * Status and navigation bar height in CSS pixels, as "top,bottom". The page
         * reads this once at startup so the first painted header already clears the
         * status bar instead of jumping down after onPageFinished.
         */
        @JavascriptInterface
        public String insets() {
            if (!onTrustedPage()) return "0,0";
            return insetTopDp + "," + insetBottomDp;
        }

        /**
         * Whether this phone will actually show a notification.
         *
         * The page cannot ask: a WebView has a Notification API of its own that
         * has nothing to do with the tray, and the Android permission belongs to
         * the app. Android 13+ gates the tray behind POST_NOTIFICATIONS, and every
         * version also honours the per-app switch in system settings, so both are
         * checked. Settings shows this instead of telling a phone user that alerts
         * are enabled when they are not. Returns "allowed", "blocked" or
         * "unknown" (never a bare boolean the page could misread).
         */
        @JavascriptInterface
        public String notificationState() {
            if (!onTrustedPage()) return "unknown";
            try {
                if (android.os.Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    return "blocked";
                }
                if (android.os.Build.VERSION.SDK_INT >= 24) {
                    android.app.NotificationManager manager =
                            (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    if (manager != null && !manager.areNotificationsEnabled()) return "blocked";
                }
                return "allowed";
            } catch (Exception err) {
                // An OEM build without these APIs must not crash the settings page.
                return "unknown";
            }
        }

            /**
             * True when this phone has a fingerprint reader or face unlock AND the
             * person has enrolled at least one. The lock screen only shows the
             * biometric button when this is true, so the button never dead-ends.
             */
            @JavascriptInterface
            public boolean hasBiometric() {
                if (!onTrustedPage()) return false;
                return biometricAvailable();
            }

            /**
             * Ask the system to authenticate. Returns false when the device cannot,
             * which the page turns into "use your PIN" instead of a spinner that
             * never finishes. The result comes back as window.__plannerBiometric(ok).
             */
            @JavascriptInterface
            public boolean promptBiometric() {
                if (!onTrustedPage()) return false;
                if (!biometricAvailable()) return false;
                // A prompt that is already up will answer on its own; starting a
                // second one would orphan the first callback.
                if (biometricCancel != null) return true;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        startBiometric();
                    }
                });
                return true;
            }

            /**
             * Opens a provider's sign-in page in the device's browser. Only the page
             * already loaded in this WebView may ask for it, and only for https, so
             * injected content cannot launch arbitrary intents.
             */
        @JavascriptInterface
        public boolean openExternal(String url) {
            if (!onTrustedPage()) return false;
            if (url == null) return false;
            Uri uri = Uri.parse(url);
            if (!"https".equals(uri.getScheme())) return false;
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception err) {
                return false;
            }
        }
    }
}
