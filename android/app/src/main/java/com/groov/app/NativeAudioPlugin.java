package com.groov.app;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Full-length songs without an API key: finds the song on YouTube Music,
 * downloads the audio (cached), and plays it with ExoPlayer.
 *
 * JS stays in charge of the queue and UI; this is just an engine. Events:
 * "state" {playing}, "progress" {position, duration}, "ended", "error" {message}.
 */
@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {

    private static final String TAG = "GroovNativeAudio";

    private final Handler main = new Handler(Looper.getMainLooper());
    /** Current song: one at a time; a newer play() cancels the older one. */
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    /** Next song in the queue, downloaded in the background. */
    private final ExecutorService prefetcher = Executors.newSingleThreadExecutor();
    /** Downloads for offline, one at a time, so playing stays quick. */
    private final ExecutorService downloader = Executors.newSingleThreadExecutor();
    /** Radio look-ups, so they never wait behind a download. */
    private final ExecutorService radioWorker = Executors.newSingleThreadExecutor();
    private final AtomicInteger playToken = new AtomicInteger();

    private YouTubeAudio youtube;
    private ExoPlayer player; // main thread only; the song you hear (and events come from)
    private File currentFile;

    // Crossfade: the previous song fading out, and the fade in progress.
    private ExoPlayer fadingOut;
    private Runnable fadeTask;
    private float targetVolume = 1f;

    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            emitProgress();
            if (player.isPlaying()) main.postDelayed(this, 500);
        }
    };

    @Override
    public void load() {
        youtube = new YouTubeAudio(getContext());
        eqPrefs = getContext().getSharedPreferences("groov_eq", android.content.Context.MODE_PRIVATE);
        android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        audioSession = am != null ? am.generateAudioSessionId() : C.AUDIO_SESSION_ID_UNSET;
        main.post(() -> {
            player = createPlayer(true);
            setUpEffects();
        });
    }

    // --- Equalizer --------------------------------------------------------------
    // Both players (crossfade) share one audio session, so one equalizer and
    // one bass boost cover every song. Settings are kept on the phone.

    private int audioSession = C.AUDIO_SESSION_ID_UNSET;
    private android.content.SharedPreferences eqPrefs;
    private android.media.audiofx.Equalizer equalizer;
    private android.media.audiofx.BassBoost bassBoost;

    private void setUpEffects() {
        if (audioSession == C.AUDIO_SESSION_ID_UNSET) return;
        try {
            equalizer = new android.media.audiofx.Equalizer(0, audioSession);
        } catch (Exception e) {
            Log.i(TAG, "No equalizer on this phone: " + YouTubeAudio.describe(e));
        }
        try {
            bassBoost = new android.media.audiofx.BassBoost(0, audioSession);
        } catch (Exception e) {
            Log.i(TAG, "No bass boost on this phone: " + YouTubeAudio.describe(e));
        }
        applyEffects();
    }

    private void applyEffects() {
        int preset = eqPrefs.getInt("preset", -1);
        int bass = eqPrefs.getInt("bass", 0);
        try {
            if (equalizer != null) {
                if (preset >= 0 && preset < equalizer.getNumberOfPresets()) {
                    equalizer.usePreset((short) preset);
                    equalizer.setEnabled(true);
                } else {
                    equalizer.setEnabled(false);
                }
            }
            if (bassBoost != null) {
                if (bass > 0 && bassBoost.getStrengthSupported()) {
                    bassBoost.setStrength((short) Math.min(1000, bass));
                    bassBoost.setEnabled(true);
                } else {
                    bassBoost.setEnabled(false);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Couldn't apply the equalizer", e);
        }
    }

    /** {available, presets: [names], preset (-1 = off), bass (0..1000), bassAvailable}. */
    @PluginMethod
    public void eqInfo(PluginCall call) {
        main.post(() -> {
            JSObject result = new JSObject();
            JSArray presets = new JSArray();
            try {
                if (equalizer != null) for (short i = 0; i < equalizer.getNumberOfPresets(); i++) presets.put(equalizer.getPresetName(i));
            } catch (Exception ignored) {
                // some phones refuse: none listed
            }
            result.put("available", equalizer != null && presets.length() > 0);
            result.put("presets", presets);
            result.put("preset", eqPrefs.getInt("preset", -1));
            result.put("bass", eqPrefs.getInt("bass", 0));
            result.put("bassAvailable", bassBoost != null && bassBoost.getStrengthSupported());
            call.resolve(result);
        });
    }

    /** {preset?: index or -1 for off, bass?: 0..1000}. */
    @PluginMethod
    public void setEq(PluginCall call) {
        android.content.SharedPreferences.Editor edit = eqPrefs.edit();
        if (call.hasOption("preset")) edit.putInt("preset", call.getInt("preset", -1));
        if (call.hasOption("bass")) edit.putInt("bass", Math.max(0, Math.min(1000, call.getInt("bass", 0))));
        edit.apply();
        main.post(this::applyEffects);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        loader.shutdownNow();
        prefetcher.shutdownNow();
        radioWorker.shutdownNow();
        main.post(() -> {
            finishFade();
            if (player != null) {
                player.release();
                player = null;
            }
            if (equalizer != null) equalizer.release();
            if (bassBoost != null) bassBoost.release();
        });
    }

    private static final AudioAttributes MUSIC = new AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build();

    /**
     * handleFocus: ExoPlayer manages audio focus (pauses for calls). Off for a
     * song fading in, or it would take focus from (and pause) the one fading out.
     */
    private ExoPlayer createPlayer(boolean handleFocus) {
        final ExoPlayer p = new ExoPlayer.Builder(getContext())
            .setAudioAttributes(MUSIC, handleFocus)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build();
        if (audioSession != C.AUDIO_SESSION_ID_UNSET) p.setAudioSessionId(audioSession); // shared: see Equalizer

        p.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (p != player) return; // a song fading out: not what JS follows
                JSObject data = new JSObject();
                data.put("playing", isPlaying);
                notifyListeners("state", data);
                emitProgress();
                if (isPlaying) {
                    main.removeCallbacks(progressTick);
                    main.post(progressTick);
                }
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (p != player) return;
                if (state == Player.STATE_READY) emitProgress();
                if (state == Player.STATE_ENDED) notifyListeners("ended", new JSObject());
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                if (p != player) return;
                Log.w(TAG, "Playback error", error);
                JSObject data = new JSObject();
                data.put("message", error.getMessage());
                notifyListeners("error", data);
            }
        });
        return p;
    }

    /** End a crossfade now: drop the old song, new one at full volume. */
    private void finishFade() {
        if (fadeTask != null) main.removeCallbacks(fadeTask);
        fadeTask = null;
        if (fadingOut != null) {
            fadingOut.release();
            fadingOut = null;
            // Now the new song may take audio focus (pause for calls etc).
            if (player != null) player.setAudioAttributes(MUSIC, true);
        }
        if (player != null) player.setVolume(targetVolume);
    }

    private void emitProgress() {
        if (player == null) return;
        long duration = player.getDuration();
        JSObject data = new JSObject();
        data.put("position", Math.max(0, player.getCurrentPosition()) / 1000.0);
        data.put("duration", duration == C.TIME_UNSET ? 0 : duration / 1000.0);
        notifyListeners("progress", data);
    }

    private static YouTubeAudio.Track trackFrom(PluginCall call) {
        Double duration = call.getDouble("durationMs", 0.0);
        return new YouTubeAudio.Track(
            call.getString("key", ""),
            call.getString("title", ""),
            call.getString("artist", ""),
            duration == null ? 0 : Math.round(duration)
        );
    }

    // --- JS API --------------------------------------------------------------------

    /** Resolves once the song starts, with {cancelled: true} if a newer play() won. */
    @PluginMethod
    public void play(PluginCall call) {
        YouTubeAudio.Track track = trackFrom(call);
        if (track.key.isEmpty() || track.title.isEmpty()) {
            call.reject("Missing track");
            return;
        }
        int token = playToken.incrementAndGet();
        main.post(() -> {
            finishFade();
            if (player != null) player.stop(); // silence the old song right away
        });

        loader.execute(() -> {
            File file;
            try {
                file = youtube.fetch(track);
            } catch (Exception e) {
                Log.w(TAG, "Could not get " + track.title, e);
                if (token == playToken.get()) call.reject(YouTubeAudio.describe(e));
                else resolveCancelled(call);
                return;
            }
            // Match YouTube's loudness normalization so it sounds the same as the video.
            String videoId = youtube.knownVideoId(track.key);
            float gain = videoId != null ? youtube.gainFor(videoId) : Float.NaN;
            if (Float.isNaN(gain) && videoId != null) {
                // Saved before gains were stored: look it up in the background.
                prefetcher.execute(() -> {
                    try {
                        float g = youtube.ensureGain(videoId);
                        main.post(() -> {
                            if (token != playToken.get() || player == null) return;
                            targetVolume = g;
                            if (fadeTask == null) player.setVolume(g);
                        });
                    } catch (Exception e) {
                        Log.i(TAG, "No loudness for " + videoId + ": " + YouTubeAudio.describe(e));
                    }
                });
            }
            main.post(() -> {
                if (token != playToken.get() || player == null) {
                    resolveCancelled(call);
                    return;
                }
                targetVolume = Float.isNaN(gain) ? 1f : gain;
                player.setVolume(targetVolume);
                currentFile = file;
                player.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)));
                player.prepare();
                player.play();
                JSObject result = new JSObject();
                result.put("cancelled", false);
                result.put("videoId", youtube.knownVideoId(track.key)); // for "show video"
                call.resolve(result);
            });
        });
    }

    private static void resolveCancelled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("cancelled", true);
        call.resolve(result);
    }

    /**
     * Crossfade into the next song: it starts silently and fades in while
     * the current one fades out. Only for songs already saved on the phone
     * (the next song is downloaded in advance); otherwise rejects "not-ready"
     * and JS just plays it normally when the current song ends.
     */
    @PluginMethod
    public void crossfade(PluginCall call) {
        YouTubeAudio.Track track = trackFrom(call);
        Double secondsArg = call.getDouble("seconds", 6.0);
        long fadeMs = Math.max(500, Math.round((secondsArg == null ? 6.0 : secondsArg) * 1000));
        if (track.key.isEmpty() || !youtube.isCached(track)) {
            call.reject("not-ready");
            return;
        }
        int token = playToken.incrementAndGet();
        loader.execute(() -> {
            File file;
            try {
                file = youtube.fetch(track); // instant: already saved
            } catch (Exception e) {
                call.reject(YouTubeAudio.describe(e));
                return;
            }
            String videoId = youtube.knownVideoId(track.key);
            float gain = videoId != null ? youtube.gainFor(videoId) : Float.NaN;
            main.post(() -> {
                if (token != playToken.get() || player == null) {
                    resolveCancelled(call);
                    return;
                }
                finishFade();
                final ExoPlayer old = player;
                final float oldVolume = old.getVolume();
                final ExoPlayer next = createPlayer(false);
                targetVolume = Float.isNaN(gain) ? 1f : gain;
                next.setVolume(0f);
                next.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)));
                next.prepare();
                player = next; // JS now follows the new song
                currentFile = file;
                fadingOut = old;
                next.play();

                final long start = android.os.SystemClock.uptimeMillis();
                fadeTask = new Runnable() {
                    @Override
                    public void run() {
                        float t = Math.min(1f, (android.os.SystemClock.uptimeMillis() - start) / (float) fadeMs);
                        // Equal-power curve: no dip in loudness halfway through.
                        next.setVolume(targetVolume * (float) Math.sin(t * Math.PI / 2));
                        old.setVolume(oldVolume * (float) Math.cos(t * Math.PI / 2));
                        if (t < 1f) main.postDelayed(this, 40);
                        else finishFade();
                    }
                };
                main.post(fadeTask);

                JSObject result = new JSObject();
                result.put("cancelled", false);
                result.put("videoId", videoId);
                call.resolve(result);
            });
        });
    }

    /** {videoId: the song's real music video, or null}. Searches YouTube Music once per song. */
    @PluginMethod
    public void musicVideo(PluginCall call) {
        YouTubeAudio.Track track = trackFrom(call);
        Double secs = call.getDouble("audioSec", 0.0);
        long audioSec = Math.round(secs == null ? 0 : secs);
        radioWorker.execute(() -> {
            JSObject result = new JSObject();
            try {
                result.put("videoId", youtube.findMusicVideo(track, audioSec));
            } catch (Exception e) {
                Log.i(TAG, "Music video search failed: " + YouTubeAudio.describe(e));
                result.put("videoId", JSObject.NULL);
            }
            call.resolve(result);
        });
    }

    /**
     * Keep songs for offline: [{key, title, artist, durationMs}]. Downloads
     * one by one in the background; a "download" event {key, ok, error} for each.
     */
    @PluginMethod
    public void download(PluginCall call) {
        JSArray tracks = call.getArray("tracks");
        call.resolve();
        if (tracks == null) return;
        for (int i = 0; i < tracks.length(); i++) {
            org.json.JSONObject o = tracks.optJSONObject(i);
            if (o == null) continue;
            YouTubeAudio.Track track = new YouTubeAudio.Track(
                o.optString("key", ""), o.optString("title", ""), o.optString("artist", ""), o.optLong("durationMs", 0));
            if (track.key.isEmpty()) continue;
            downloader.execute(() -> {
                JSObject event = new JSObject();
                event.put("key", track.key);
                try {
                    youtube.pin(track);
                    event.put("ok", true);
                    event.put("videoId", youtube.knownVideoId(track.key));
                } catch (Exception e) {
                    Log.i(TAG, "Download failed for " + track.title + ": " + YouTubeAudio.describe(e));
                    event.put("ok", false);
                    event.put("error", YouTubeAudio.describe(e));
                }
                notifyListeners("download", event);
            });
        }
    }

    /** True on Wi-Fi (or any network that isn't charged by the MB). */
    private boolean onUnmeteredNetwork() {
        android.net.ConnectivityManager cm =
            (android.net.ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
        return caps != null
            && caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
    }

    /**
     * Smart downloads: keep these songs offline (most important first) within
     * {limitMb}. Only on Wi-Fi unless {wifiOnly: false}: rejects "not-wifi".
     * A "smartdone" event {kept} when finished.
     */
    @PluginMethod
    public void smartDownload(PluginCall call) {
        boolean wifiOnly = !Boolean.FALSE.equals(call.getBoolean("wifiOnly", true));
        if (wifiOnly && !onUnmeteredNetwork()) {
            call.reject("not-wifi");
            return;
        }
        JSArray tracks = call.getArray("tracks");
        Integer limit = call.getInt("limitMb", 600);
        java.util.List<YouTubeAudio.Track> list = new java.util.ArrayList<>();
        if (tracks != null) {
            for (int i = 0; i < tracks.length(); i++) {
                org.json.JSONObject o = tracks.optJSONObject(i);
                if (o == null || o.optString("key", "").isEmpty()) continue;
                list.add(new YouTubeAudio.Track(o.optString("key"), o.optString("title", ""), o.optString("artist", ""), o.optLong("durationMs", 0)));
            }
        }
        call.resolve();
        downloader.execute(() -> {
            int kept = youtube.setSmart(list, limit == null ? 600 : limit);
            JSObject event = new JSObject();
            event.put("kept", kept);
            notifyListeners("smartdone", event);
        });
    }

    /** Stop keeping songs for offline: {keys: [...]}. */
    @PluginMethod
    public void removeDownloads(PluginCall call) {
        JSArray keys = call.getArray("keys");
        if (keys != null) for (int i = 0; i < keys.length(); i++) youtube.unpin(keys.optString(i, ""));
        call.resolve();
    }

    /** Songs already matched to a YouTube video: {keys} → {ids: {key: videoId}}. */
    @PluginMethod
    public void videoIds(PluginCall call) {
        JSArray keys = call.getArray("keys");
        JSObject ids = new JSObject();
        if (keys != null) {
            for (int i = 0; i < keys.length(); i++) {
                String k = keys.optString(i, "");
                String v = k.isEmpty() ? null : youtube.knownVideoId(k);
                if (v != null) ids.put(k, v);
            }
        }
        JSObject result = new JSObject();
        result.put("ids", ids);
        call.resolve(result);
    }

    /** Which of these songs are downloaded: {keys} → {downloaded: [...]}. */
    @PluginMethod
    public void downloadState(PluginCall call) {
        JSArray keys = call.getArray("keys");
        prefetcher.execute(() -> {
            JSArray done = new JSArray();
            if (keys != null) {
                for (int i = 0; i < keys.length(); i++) {
                    String k = keys.optString(i, "");
                    if (!k.isEmpty() && youtube.isDownloaded(k)) done.put(k);
                }
            }
            JSObject result = new JSObject();
            result.put("downloaded", done);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void storageInfo(PluginCall call) {
        long[] stats = youtube.cacheStats();
        JSObject result = new JSObject();
        result.put("bytes", stats[0]);
        result.put("songs", stats[1]);
        result.put("downloadedBytes", stats[2]);
        result.put("downloadedSongs", stats[3]);
        result.put("smartBytes", stats[4]);
        result.put("smartSongs", stats[5]);
        result.put("limitMb", youtube.cacheLimitMb());
        call.resolve(result);
    }

    @PluginMethod
    public void setCacheLimit(PluginCall call) {
        Integer mb = call.getInt("mb", 800);
        final File keep = currentFile;
        prefetcher.execute(() -> youtube.setCacheLimitMb(mb == null ? 800 : mb, keep));
        call.resolve();
    }

    @PluginMethod
    public void clearCache(PluginCall call) {
        final File keep = currentFile;
        boolean all = Boolean.TRUE.equals(call.getBoolean("includeDownloads", false));
        prefetcher.execute(() -> {
            JSObject result = new JSObject();
            result.put("deleted", youtube.clearCache(keep, all));
            call.resolve(result);
        });
    }

    /** Songs for endless radio after a track: [{videoId, title, artist, durationSec, artwork}]. */
    @PluginMethod
    public void radio(PluginCall call) {
        String key = call.getString("key", "");
        String videoId = call.getString("videoId", youtube.knownVideoId(key));
        if (videoId == null || videoId.isEmpty()) {
            call.reject("Play the song first so it can be found on YouTube");
            return;
        }
        radioWorker.execute(() -> {
            try {
                JSArray tracks = new JSArray();
                for (YouTubeAudio.RadioTrack t : youtube.radio(videoId)) {
                    JSObject o = new JSObject();
                    o.put("videoId", t.videoId);
                    o.put("title", t.title);
                    o.put("artist", t.uploader);
                    o.put("durationSec", t.durationSec);
                    o.put("artwork", t.thumbnail);
                    tracks.put(o);
                }
                JSObject result = new JSObject();
                result.put("tracks", tracks);
                call.resolve(result);
            } catch (Exception e) {
                Log.w(TAG, "Radio failed for " + videoId, e);
                call.reject(YouTubeAudio.describe(e));
            }
        });
    }

    /** {url} → {name, tracks: [{videoId, title, artist, durationSec, artwork}]}. */
    @PluginMethod
    public void importPlaylist(PluginCall call) {
        String url = call.getString("url", "");
        Integer max = call.getInt("max", 500);
        radioWorker.execute(() -> {
            try {
                YouTubeAudio.ImportedPlaylist p = youtube.importPlaylist(url, max == null ? 500 : max);
                JSArray tracks = new JSArray();
                for (YouTubeAudio.RadioTrack t : p.tracks) {
                    JSObject o = new JSObject();
                    o.put("videoId", t.videoId);
                    o.put("title", t.title);
                    o.put("artist", t.uploader);
                    o.put("durationSec", t.durationSec);
                    o.put("artwork", t.thumbnail);
                    tracks.put(o);
                }
                JSObject result = new JSObject();
                result.put("name", p.name);
                result.put("tracks", tracks);
                call.resolve(result);
            } catch (Exception e) {
                Log.w(TAG, "Import failed for " + url, e);
                String msg = e.getMessage();
                call.reject(msg != null && !msg.isEmpty() ? msg : YouTubeAudio.describe(e));
            }
        });
    }

    /** A shared link's song: {videoId} → {videoId, title, artist, durationSec, artwork}, or {spotify: url} → {id, title, artists, durationMs}. */
    @PluginMethod
    public void linkInfo(PluginCall call) {
        String videoId = call.getString("videoId", "");
        String spotify = call.getString("spotify", "");
        radioWorker.execute(() -> {
            try {
                JSObject o = new JSObject();
                if (!spotify.isEmpty()) {
                    SpotifyImport.Song s = SpotifyImport.fetchTrack(spotify);
                    o.put("id", s.id);
                    o.put("title", s.title);
                    o.put("artists", s.artists);
                    o.put("durationMs", s.durationMs);
                } else {
                    YouTubeAudio.RadioTrack t = youtube.videoInfo(videoId);
                    o.put("videoId", t.videoId);
                    o.put("title", t.title);
                    o.put("artist", t.uploader);
                    o.put("durationSec", t.durationSec);
                    o.put("artwork", t.thumbnail);
                }
                call.resolve(o);
            } catch (Exception e) {
                String msg = e.getMessage();
                call.reject(msg != null && !msg.isEmpty() ? msg : YouTubeAudio.describe(e));
            }
        });
    }

    /** A public Spotify playlist/album: {url} → {name, cover, songs: [{id, title, artists, durationMs}]}. */
    @PluginMethod
    public void importSpotify(PluginCall call) {
        String url = call.getString("url", "");
        radioWorker.execute(() -> {
            try {
                SpotifyImport.Result r = SpotifyImport.fetch(url);
                JSArray songs = new JSArray();
                for (SpotifyImport.Song s : r.songs) {
                    JSObject o = new JSObject();
                    o.put("id", s.id);
                    o.put("title", s.title);
                    o.put("artists", s.artists);
                    o.put("durationMs", s.durationMs);
                    songs.put(o);
                }
                JSObject result = new JSObject();
                result.put("name", r.name);
                result.put("cover", r.cover);
                result.put("songs", songs);
                call.resolve(result);
            } catch (Exception e) {
                Log.w(TAG, "Spotify import failed for " + url, e);
                String msg = e.getMessage();
                call.reject(msg != null && !msg.isEmpty() ? msg : YouTubeAudio.describe(e));
            }
        });
    }

    /** Download the next song in the background so it starts instantly. */
    @PluginMethod
    public void prefetch(PluginCall call) {
        YouTubeAudio.Track track = trackFrom(call);
        // wait: resolve once downloaded (for downloading songs one by one).
        boolean wait = Boolean.TRUE.equals(call.getBoolean("wait", false));
        if (!wait) call.resolve();
        if (track.key.isEmpty() || youtube.isCached(track)) {
            if (wait) call.resolve();
            return;
        }
        prefetcher.execute(() -> {
            try {
                youtube.fetch(track);
            } catch (Exception e) {
                Log.i(TAG, "Prefetch failed for " + track.title + ": " + YouTubeAudio.describe(e));
            }
            if (wait) call.resolve();
        });
    }

    @PluginMethod
    public void resume(PluginCall call) {
        main.post(() -> {
            if (player == null) return;
            if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
            player.play();
        });
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        main.post(() -> {
            finishFade();
            if (player != null) player.pause();
        });
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double position = call.getDouble("position", 0.0);
        long ms = Math.max(0, Math.round((position == null ? 0 : position) * 1000));
        main.post(() -> {
            if (player == null) return;
            finishFade();
            player.seekTo(ms);
            emitProgress();
        });
        call.resolve();
    }

    /** Stop and forget the current song (switching to another engine). */
    @PluginMethod
    public void stop(PluginCall call) {
        playToken.incrementAndGet();
        main.post(() -> {
            finishFade();
            if (player != null) {
                player.stop();
                player.clearMediaItems();
            }
        });
        call.resolve();
    }
}
