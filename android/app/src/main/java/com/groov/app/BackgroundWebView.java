package com.groov.app;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import com.getcapacitor.CapacitorWebView;
import java.lang.ref.WeakReference;

/**
 * Capacitor's WebView, but it can pretend to stay visible.
 *
 * When the app goes to the background or the screen turns off, Android tells
 * the WebView its window is hidden. Chromium then marks the page hidden and
 * pauses media, which stops the YouTube player. While a track is loaded we
 * report the window as still visible, so playback continues. Swapped in via
 * res/layout/capacitor_bridge_layout_main.xml, which overrides Capacitor's.
 */
public class BackgroundWebView extends CapacitorWebView {

    private static WeakReference<BackgroundWebView> current = new WeakReference<>(null);
    private static boolean keepAlive = false;

    public BackgroundWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        current = new WeakReference<>(this);
    }

    /** Must be called on the main thread. */
    static void setKeepAlive(boolean enabled) {
        if (keepAlive == enabled) return;
        keepAlive = enabled;
        BackgroundWebView view = current.get();
        // Turning it off: hand the real visibility back to Chromium, so the
        // page can sleep if the app is already in the background.
        if (view != null && !enabled) view.applyRealVisibility();
    }

    private void applyRealVisibility() {
        super.onWindowVisibilityChanged(getWindowVisibility());
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(keepAlive ? View.VISIBLE : visibility);
    }
}
