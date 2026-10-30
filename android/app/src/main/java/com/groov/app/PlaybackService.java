package com.groov.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground "media playback" service: keeps Groov alive with the screen off,
 * and gives it a media notification, lock-screen controls, Bluetooth and
 * headphone buttons and pause-on-unplug.
 *
 * The music itself still plays inside the WebView. This service only mirrors
 * the state JS sends through MediaControlsPlugin, and sends button presses
 * back to JS as actions.
 */
public class PlaybackService extends Service {

    private static final String TAG = "GroovPlayback";
    private static final String CHANNEL_ID = "groov_playback";
    private static final int NOTIFICATION_ID = 1001;
    private static final String CUSTOM_ACTION_CLOSE = "close";

    static final String ACTION_UPDATE = "com.groov.app.action.UPDATE";
    static final String ACTION_PLAY = "com.groov.app.action.PLAY";
    static final String ACTION_PAUSE = "com.groov.app.action.PAUSE";
    static final String ACTION_NEXT = "com.groov.app.action.NEXT";
    static final String ACTION_PREVIOUS = "com.groov.app.action.PREVIOUS";
    static final String ACTION_CLOSE = "com.groov.app.action.CLOSE";

    /** Snapshot of what JS is playing. Immutable once handed to the service. */
    static final class State {
        String title = "";
        String artist = "";
        Bitmap artwork;
        boolean playing;
        long positionMs;
        long durationMs;
        boolean hasNext;
        boolean hasPrevious;
    }

    // Main-thread only.
    private static State current = new State();
    private static PlaybackService running;

    private MediaSessionCompat session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private boolean inForeground;

    // --- Called from MediaControlsPlugin (main thread) -----------------------

    static void apply(Context context, State state) {
        current = state;
        if (running != null) {
            running.refresh();
            return;
        }
        // Only start the service once something actually plays.
        if (!state.playing) return;
        try {
            Intent intent = new Intent(context, PlaybackService.class).setAction(ACTION_UPDATE);
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException e) {
            // Android 12+ refuses to start a foreground service from the background.
            Log.w(TAG, "Could not start playback service", e);
        }
    }

    static void stop() {
        if (running != null) running.shutdown();
    }

    // --- Lifecycle -------------------------------------------------------------

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        createChannel();

        session = new MediaSessionCompat(this, "Groov");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                MediaControlsPlugin.emit("play");
            }

            @Override
            public void onPause() {
                MediaControlsPlugin.emit("pause");
            }

            @Override
            public void onSkipToNext() {
                MediaControlsPlugin.emit("next");
            }

            @Override
            public void onSkipToPrevious() {
                MediaControlsPlugin.emit("previous");
            }

            @Override
            public void onSeekTo(long pos) {
                MediaControlsPlugin.emit("seek", pos);
            }

            @Override
            public void onStop() {
                close();
            }

            @Override
            public void onCustomAction(String action, android.os.Bundle extras) {
                if (CUSTOM_ACTION_CLOSE.equals(action)) close();
            }
        });
        session.setActive(true);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "groov:playback");
        wakeLock.setReferenceCounted(false);

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "groov:playback");
            wifiLock.setReferenceCounted(false);
        }

        ContextCompat.registerReceiver(
            this,
            noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A startForegroundService() call must be followed by startForeground().
        refresh();

        String action = intent != null ? intent.getAction() : null;
        if (action != null) {
            switch (action) {
                case ACTION_PLAY:
                    MediaControlsPlugin.emit("play");
                    break;
                case ACTION_PAUSE:
                    MediaControlsPlugin.emit("pause");
                    break;
                case ACTION_NEXT:
                    MediaControlsPlugin.emit("next");
                    break;
                case ACTION_PREVIOUS:
                    MediaControlsPlugin.emit("previous");
                    break;
                case ACTION_CLOSE:
                    close();
                    break;
                default:
                    break;
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The WebView (and the music) dies with the task, so go too.
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        try {
            unregisterReceiver(noisyReceiver);
        } catch (IllegalArgumentException ignored) {
            // not registered
        }
        releaseLocks();
        session.setActive(false);
        session.release();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // --- State -----------------------------------------------------------------

    private void refresh() {
        State s = current;

        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, s.durationMs);
        if (s.artwork != null) meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, s.artwork);
        session.setMetadata(meta.build());

        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SEEK_TO
            | PlaybackStateCompat.ACTION_STOP;
        if (s.hasNext) actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        if (s.hasPrevious) actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;

        session.setPlaybackState(
            new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(
                    s.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                    s.positionMs,
                    s.playing ? 1f : 0f,
                    SystemClock.elapsedRealtime()
                )
                .addCustomAction(
                    new PlaybackStateCompat.CustomAction.Builder(
                        CUSTOM_ACTION_CLOSE,
                        "Close",
                        android.R.drawable.ic_menu_close_clear_cancel
                    ).build()
                )
                .build()
        );

        if (s.playing) {
            acquireLocks();
        } else {
            releaseLocks();
        }

        Notification notification = buildNotification(s);
        if (!inForeground) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0
            );
            inForeground = true;
        } else {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTIFICATION_ID, notification);
        }
    }

    /** Close from the notification: pause in JS, then remove everything. */
    private void close() {
        MediaControlsPlugin.emit("stop");
        shutdown();
    }

    private void shutdown() {
        // Detach first, so a late update starts a fresh service instead of
        // reviving this one while it's stopping.
        if (running == this) running = null;
        BackgroundWebView.setKeepAlive(false);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        inForeground = false;
        stopSelf();
    }

    // --- Notification ------------------------------------------------------------

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shows what's playing, with controls");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(channel);
    }

    private PendingIntent serviceIntent(String action, int requestCode) {
        Intent intent = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    private Notification buildNotification(State s) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_groov)
            .setContentTitle(s.title)
            .setContentText(s.artist)
            .setContentIntent(contentIntent)
            .setDeleteIntent(serviceIntent(ACTION_CLOSE, 4))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setOngoing(s.playing);
        if (s.artwork != null) b.setLargeIcon(s.artwork);

        b.addAction(android.R.drawable.ic_media_previous, "Previous", serviceIntent(ACTION_PREVIOUS, 1));
        if (s.playing) {
            b.addAction(android.R.drawable.ic_media_pause, "Pause", serviceIntent(ACTION_PAUSE, 2));
        } else {
            b.addAction(android.R.drawable.ic_media_play, "Play", serviceIntent(ACTION_PLAY, 2));
        }
        b.addAction(android.R.drawable.ic_media_next, "Next", serviceIntent(ACTION_NEXT, 3));
        b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Close", serviceIntent(ACTION_CLOSE, 5));

        b.setStyle(
            new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2)
        );
        return b.build();
    }

    // --- Unplug, locks ------------------------------------------------------------
    //
    // No audio focus here on purpose: the WebView's media engine already holds
    // focus for the music (and pauses for calls). Requesting it again from
    // this service made Android take focus away from the WebView, which
    // paused every song ~0.2s after it started.

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            // Headphones unplugged / Bluetooth disconnected: don't blast the speaker.
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()) && current.playing) {
                MediaControlsPlugin.emit("pause");
            }
        }
    };

    private void acquireLocks() {
        // Renewed on every play; the timeout is a safety net if we never get a pause.
        wakeLock.acquire(3 * 60 * 60 * 1000L);
        if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
    }
}
