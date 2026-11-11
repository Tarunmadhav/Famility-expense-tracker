package com.family.planner;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.Context;
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
    // System bar height in CSS pixels, published to the page as --inset-top/--inset-bottom.
    private int insetTopDp;
    private int insetBottomDp;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        createChannel();
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
            public void onPageFinished(WebView view, String url) {
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
        // A picker that returned without a result (back press) still ends the pause
        // exemption, so the next Home press locks as usual.
        if (choosingFile && filePathCallback == null) choosingFile = false;
        if (web != null) web.onResume();
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
