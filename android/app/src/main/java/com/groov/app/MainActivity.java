package com.groov.app;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge is created.
        registerPlugin(MediaControlsPlugin.class);
        registerPlugin(NativeAudioPlugin.class);
        super.onCreate(savedInstanceState);
        handleShare(getIntent());

        // Back button: let the app go back one step (close Now Playing, leave a
        // playlist, clear a search…). Only at the home screen, minimize the app
        // instead of closing it, so the music keeps playing.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                    "(window.groovBack && window.groovBack()) ? 'handled' : 'root'",
                    result -> {
                        if (!"\"handled\"".equals(result)) moveTaskToBack(true);
                    }
                );
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleShare(intent);
    }

    /**
     * A link shared to Groov: hand it to the app (window.groovShare), waiting
     * for the page to be ready when Groov was just opened by the share.
     */
    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) return;
        intent.setAction(Intent.ACTION_MAIN); // don't handle it again on rotate
        deliverShare(org.json.JSONObject.quote(text), 0);
    }

    private void deliverShare(String quoted, int attempt) {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null || attempt > 40) {
            if (attempt <= 40) new Handler(Looper.getMainLooper()).postDelayed(() -> deliverShare(quoted, attempt + 1), 500);
            return;
        }
        webView.evaluateJavascript(
            "(window.groovShare ? (window.groovShare(" + quoted + "), 'ok') : 'wait')",
            result -> {
                if (!"\"ok\"".equals(result)) {
                    new Handler(Looper.getMainLooper()).postDelayed(() -> deliverShare(quoted, attempt + 1), 500);
                }
            }
        );
    }
}
