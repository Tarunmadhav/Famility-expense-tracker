package com.family.planner;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
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

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        createChannel();
        requestNotificationPermission();

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " FamilyPlannerApp/2.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new AndroidBridge(this), "AndroidBridge");
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
        });

        setContentView(web);
        web.loadUrl(START_URL);
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

    /** Exposed to JavaScript as window.AndroidBridge. */
    static class AndroidBridge {
        private final MainActivity activity;

        AndroidBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void notify(String title, String body) {
            activity.postNotification(title, body);
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }
}
