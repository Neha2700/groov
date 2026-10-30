package com.groov.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS <-> native bridge for background playback.
 *
 * JS calls update() whenever the track, play state or position changes, and
 * listens for "action" events (play, pause, next, previous, seek, stop) coming
 * from the notification, lock screen, headphones or Bluetooth.
 */
@CapacitorPlugin(name = "MediaControls")
public class MediaControlsPlugin extends Plugin {

    private static final String TAG = "GroovMediaControls";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4711;

    private static MediaControlsPlugin instance;

    /** One worker keeps updates in order while artwork downloads. */
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private String artworkUrl;
    private Bitmap artwork;
    private boolean askedNotificationPermission;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        worker.shutdownNow();
    }

    @PluginMethod
    public void update(PluginCall call) {
        PlaybackService.State s = new PlaybackService.State();
        s.title = call.getString("title", "");
        s.artist = call.getString("artist", "");
        s.playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        s.positionMs = Math.max(0, Math.round(call.getDouble("position", 0.0) * 1000));
        s.durationMs = Math.max(0, Math.round(call.getDouble("duration", 0.0) * 1000));
        s.hasNext = Boolean.TRUE.equals(call.getBoolean("hasNext", false));
        s.hasPrevious = Boolean.TRUE.equals(call.getBoolean("hasPrevious", false));
        final String url = call.getString("artwork", null);

        if (s.playing) askForNotificationPermissionOnce();

        worker.execute(() -> {
            if (url == null || url.isEmpty()) {
                artworkUrl = null;
                artwork = null;
            } else if (!url.equals(artworkUrl)) {
                artworkUrl = url;
                artwork = download(url);
            }
            s.artwork = artwork;
            main.post(() -> {
                if (s.playing) BackgroundWebView.setKeepAlive(true);
                PlaybackService.apply(getContext(), s);
            });
        });
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            PlaybackService.stop();
            BackgroundWebView.setKeepAlive(false);
        });
        call.resolve();
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject result = new JSObject();
        result.put("value", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(result);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context ctx = getContext();
        Intent ask = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:" + ctx.getPackageName()));
        try {
            getActivity().startActivity(ask);
        } catch (ActivityNotFoundException | SecurityException e) {
            // Some phones hide the direct prompt; open the full list instead.
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (ActivityNotFoundException ignored) {
                call.reject("Battery settings are not available on this phone");
                return;
            }
        }
        call.resolve();
    }

    /** Sends a control action to JS. Called on the main thread by PlaybackService. */
    static void emit(String action) {
        emit(action, -1);
    }

    static void emit(String action, long positionMs) {
        MediaControlsPlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        if (positionMs >= 0) data.put("position", positionMs / 1000.0);
        plugin.notifyListeners("action", data);
    }

    // Android 13+ needs permission to show notifications. Media notifications
    // are exempt on most phones, but some (Xiaomi, Oppo, Vivo) still hide
    // them, so ask once.
    private void askForNotificationPermissionOnce() {
        if (askedNotificationPermission || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        askedNotificationPermission = true;
        if (
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) return;
        main.post(() ->
            ActivityCompat.requestPermissions(
                getActivity(),
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                NOTIFICATION_PERMISSION_REQUEST
            )
        );
    }

    private static Bitmap download(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            try (InputStream in = conn.getInputStream()) {
                Bitmap bmp = BitmapFactory.decodeStream(in);
                if (bmp == null) return null;
                int max = 512;
                if (bmp.getWidth() <= max && bmp.getHeight() <= max) return bmp;
                float scale = Math.min((float) max / bmp.getWidth(), (float) max / bmp.getHeight());
                return Bitmap.createScaledBitmap(
                    bmp,
                    Math.round(bmp.getWidth() * scale),
                    Math.round(bmp.getHeight() * scale),
                    true
                );
            }
        } catch (Exception e) {
            Log.w(TAG, "Artwork download failed: " + url, e);
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
