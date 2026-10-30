package com.groov.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.linkhandler.SearchQueryHandler;
import org.schabi.newpipe.extractor.localization.ContentCountry;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.playlist.PlaylistInfo;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.services.youtube.ItagItem;
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.AudioTrackType;
import org.schabi.newpipe.extractor.stream.DeliveryMethod;
import org.schabi.newpipe.extractor.stream.StreamExtractor;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

/**
 * Finds a song on YouTube Music and downloads its audio, the way NewPipe does.
 *
 * No API key, no quota. Songs are cached as files (LRU, ~800 MB), so replays
 * are instant and work offline. All methods block: call off the main thread.
 */
final class YouTubeAudio {

    private static final String TAG = "GroovYouTube";
    private static final int DEFAULT_CACHE_LIMIT_MB = 800;
    private static final int CHUNK_BYTES = 2 * 1024 * 1024;
    /** YouTube's own player sends this POST body for media requests. */
    private static final byte[] POST_BODY = new byte[] { 0x78, 0 };

    private static final String GAIN_PREFIX = "gain:";
    private static boolean initialized;

    private final File cacheDir;
    private final SharedPreferences ids;
    private final ConcurrentHashMap<String, Object> locks = new ConcurrentHashMap<>();

    YouTubeAudio(Context context) {
        synchronized (YouTubeAudio.class) {
            if (!initialized) {
                NewPipe.init(NpDownloader.get(), new Localization("en", "IN"), new ContentCountry("IN"));
                initialized = true;
            }
        }
        cacheDir = new File(context.getFilesDir(), "audio");
        //noinspection ResultOfMethodCallIgnored
        cacheDir.mkdirs();
        ids = context.getSharedPreferences("groov_youtube_ids", Context.MODE_PRIVATE);
    }

    static final class Track {
        final String key; // the app's track id, e.g. "song-1440818839"
        final String title;
        final String artist;
        final long durationMs; // 0 = unknown

        Track(String key, String title, String artist, long durationMs) {
            this.key = key;
            this.title = title;
            this.artist = artist;
            this.durationMs = durationMs;
        }
    }

    /** Returns a playable local file for the track, downloading it if needed. */
    File fetch(Track track) throws Exception {
        String videoId = resolveVideoId(track);
        try {
            return fetchVideo(videoId);
        } catch (Exception e) {
            // Some uploads can't be played (age-restricted, blocked here…):
            // try the song's other matches before giving up.
            if (track.key.startsWith("yt-") || isNetworkError(e)) throw e;
            Log.i(TAG, "Match " + videoId + " for " + track.title + " failed (" + describe(e) + "), trying others");
            for (String other : searchCandidates(track)) {
                if (other.equals(videoId)) continue;
                try {
                    File file = fetchVideo(other);
                    ids.edit().putString(track.key, other).apply();
                    return file;
                } catch (Exception again) {
                    if (isNetworkError(again)) throw again;
                    Log.i(TAG, "Also failed: " + other + " (" + describe(again) + ")");
                }
            }
            throw e;
        }
    }

    private File fetchVideo(String videoId) throws Exception {
        Object lock = locks.computeIfAbsent(videoId, k -> new Object());
        synchronized (lock) {
            File cached = findCached(videoId);
            if (cached != null) {
                //noinspection ResultOfMethodCallIgnored
                cached.setLastModified(System.currentTimeMillis());
                return cached;
            }
            File file = download(videoId);
            trimCache(file);
            return file;
        }
    }

    /** The YouTube video id this track was matched to, if known. */
    String knownVideoId(String key) {
        if (key.startsWith("yt-")) return key.substring(3);
        return ids.getString(key, null);
    }

    static final class RadioTrack {
        final String videoId;
        final String title;
        final String uploader;
        final long durationSec;
        final String thumbnail;

        RadioTrack(String videoId, String title, String uploader, long durationSec, String thumbnail) {
            this.videoId = videoId;
            this.title = title;
            this.uploader = uploader;
            this.durationSec = durationSec;
            this.thumbnail = thumbnail;
        }
    }

    /**
     * Endless radio: YouTube Music's own mix for a song (what it plays after
     * it), falling back to the regular YouTube mix, then "related videos".
     */
    List<RadioTrack> radio(String videoId) throws Exception {
        StreamingService yt = ServiceList.YouTube;
        List<StreamInfoItem> items = new ArrayList<>();
        for (String list : new String[] { "RDAMVM" + videoId, "RD" + videoId }) {
            try {
                items = PlaylistInfo.getInfo(yt, "https://www.youtube.com/watch?v=" + videoId + "&list=" + list).getRelatedItems();
                if (items.size() > 1) break;
            } catch (Exception e) {
                Log.i(TAG, "Mix " + list + " failed: " + describe(e));
            }
        }
        if (items.size() <= 1) {
            items = new ArrayList<>();
            for (InfoItem item : StreamInfo.getInfo(yt, "https://www.youtube.com/watch?v=" + videoId).getRelatedItems()) {
                if (item instanceof StreamInfoItem) items.add((StreamInfoItem) item);
            }
        }
        List<RadioTrack> out = new ArrayList<>();
        for (StreamInfoItem item : items) {
            String id;
            try {
                id = yt.getStreamLHFactory().getId(item.getUrl());
            } catch (Exception e) {
                continue;
            }
            if (id.equals(videoId)) continue; // the seed song itself
            long duration = item.getDuration();
            if (duration > 0 && (duration < 60 || duration > 15 * 60)) continue; // skip shorts and long mixes
            String thumb = null;
            List<Image> thumbs = item.getThumbnails();
            int best = -1;
            for (Image image : thumbs) {
                if (image.getHeight() > best) {
                    best = image.getHeight();
                    thumb = image.getUrl();
                }
            }
            out.add(new RadioTrack(id, item.getName(), item.getUploaderName(), duration, thumb));
        }
        if (out.isEmpty()) throw new IOException("No radio songs for " + videoId);
        return out;
    }

    static final class ImportedPlaylist {
        final String name;
        final List<RadioTrack> tracks;

        ImportedPlaylist(String name, List<RadioTrack> tracks) {
            this.name = name;
            this.tracks = tracks;
        }
    }

    /**
     * A YouTube or YouTube Music playlist from its link (any link with
     * "list=…", or a playlist id). Up to `max` songs, page by page.
     */
    ImportedPlaylist importPlaylist(String link, int max) throws Exception {
        String id = link.trim();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("[?&]list=([A-Za-z0-9_-]+)").matcher(id);
        if (m.find()) id = m.group(1);
        if (!id.matches("[A-Za-z0-9_-]{10,}")) throw new IOException("That doesn't look like a YouTube playlist link");
        if (id.startsWith("RD")) throw new IOException("Mixes can't be imported — open the mix and use a saved playlist instead");
        StreamingService yt = ServiceList.YouTube;
        String url = "https://www.youtube.com/playlist?list=" + id;
        PlaylistInfo info = PlaylistInfo.getInfo(yt, url);
        List<StreamInfoItem> items = new ArrayList<>(info.getRelatedItems());
        org.schabi.newpipe.extractor.Page page = info.getNextPage();
        while (items.size() < max && org.schabi.newpipe.extractor.Page.isValid(page)) {
            org.schabi.newpipe.extractor.ListExtractor.InfoItemsPage<StreamInfoItem> more = PlaylistInfo.getMoreItems(yt, url, page);
            items.addAll(more.getItems());
            page = more.getNextPage();
        }
        List<RadioTrack> out = new ArrayList<>();
        for (StreamInfoItem item : items) {
            if (out.size() >= max) break;
            String videoId;
            try {
                videoId = yt.getStreamLHFactory().getId(item.getUrl());
            } catch (Exception e) {
                continue;
            }
            out.add(new RadioTrack(videoId, item.getName(), item.getUploaderName(), item.getDuration(), bestThumb(item.getThumbnails())));
        }
        if (out.isEmpty()) throw new IOException("This playlist is empty or private");
        String name = info.getName();
        return new ImportedPlaylist(name == null || name.isEmpty() ? "Imported playlist" : name, out);
    }

    private static String bestThumb(List<Image> thumbs) {
        String thumb = null;
        int best = -1;
        for (Image image : thumbs) {
            if (image.getHeight() > best) {
                best = image.getHeight();
                thumb = image.getUrl();
            }
        }
        return thumb;
    }

    /** Title, channel, length and picture of one video (a shared link). */
    RadioTrack videoInfo(String videoId) throws Exception {
        StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + videoId);
        return new RadioTrack(videoId, info.getName(), info.getUploaderName(), info.getDuration(), bestThumb(info.getThumbnails()));
    }

    boolean isCached(Track track) {
        String videoId = knownVideoId(track.key);
        return videoId != null && findCached(videoId) != null;
    }

    // --- Storage settings ---------------------------------------------------------

    int cacheLimitMb() {
        return ids.getInt("cacheLimitMb", DEFAULT_CACHE_LIMIT_MB);
    }

    void setCacheLimitMb(int mb, File keep) {
        ids.edit().putInt("cacheLimitMb", Math.max(100, mb)).apply();
        trimCache(keep);
    }

    /** {bytes used, number of songs}. */
    /** {bytes, songs, downloaded bytes, downloaded songs, smart bytes, smart songs}. */
    long[] cacheStats() {
        File[] files = cacheDir.listFiles((dir, name) -> !name.endsWith(".part"));
        Set<String> pinned = pinnedIds();
        Set<String> smart = smartIds();
        long bytes = 0, pinnedBytes = 0, pinnedSongs = 0, smartBytes = 0, smartSongs = 0;
        if (files != null) {
            for (File f : files) {
                bytes += f.length();
                String id = videoIdOf(f);
                if (pinned.contains(id)) {
                    pinnedBytes += f.length();
                    pinnedSongs++;
                } else if (smart.contains(id)) {
                    smartBytes += f.length();
                    smartSongs++;
                }
            }
        }
        return new long[] { bytes, files == null ? 0 : files.length, pinnedBytes, pinnedSongs, smartBytes, smartSongs };
    }

    /** Delete saved songs except the one playing (and downloads, unless asked). */
    int clearCache(File keep, boolean includeDownloads) {
        File[] files = cacheDir.listFiles();
        Set<String> pinned = includeDownloads ? new HashSet<>() : pinnedIds();
        int deleted = 0;
        if (files != null) {
            for (File f : files) {
                if (f.equals(keep) || pinned.contains(videoIdOf(f))) continue;
                if (f.delete()) deleted++;
            }
        }
        if (includeDownloads) ids.edit().remove(PINNED).apply();
        ids.edit().remove(SMART).apply(); // smart downloads come back by themselves
        return deleted;
    }

    // --- Downloads: songs kept for offline, never removed to make room ----------

    private static final String PINNED = "pinned";

    private static String videoIdOf(File f) {
        String name = f.getName();
        int dot = name.indexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    synchronized Set<String> pinnedIds() {
        return new HashSet<>(ids.getStringSet(PINNED, new HashSet<>()));
    }

    /** Download (if needed) and keep a song. */
    void pin(Track track) throws Exception {
        fetch(track);
        String videoId = knownVideoId(track.key);
        if (videoId == null) return;
        synchronized (this) {
            Set<String> set = pinnedIds();
            set.add(videoId);
            ids.edit().putStringSet(PINNED, set).apply();
        }
    }

    /** Stop keeping a song (it stays saved until room is needed). */
    synchronized void unpin(String key) {
        String videoId = knownVideoId(key);
        if (videoId == null) return;
        Set<String> set = pinnedIds();
        if (set.remove(videoId)) ids.edit().putStringSet(PINNED, set).apply();
    }

    // --- Smart downloads: mixes kept for offline automatically ---------------
    // Their own budget; removed before your own downloads when space is short.

    private static final String SMART = "smart";

    synchronized Set<String> smartIds() {
        return new HashSet<>(ids.getStringSet(SMART, new HashSet<>()));
    }

    /**
     * Keep exactly these songs as smart downloads (in order of importance),
     * downloading what's missing, within `limitMb`. Songs that drop out
     * become normal saved songs. Returns how many are kept.
     */
    int setSmart(List<Track> tracks, int limitMb) {
        long budget = limitMb * 1024L * 1024L;
        long used = 0;
        Set<String> pinned = pinnedIds();
        Set<String> keep = new HashSet<>();
        for (Track track : tracks) {
            if (used >= budget) break;
            try {
                File f = fetch(track);
                String videoId = knownVideoId(track.key);
                if (videoId == null) continue;
                if (!pinned.contains(videoId)) used += f.length(); // your downloads aren't counted
                keep.add(videoId);
                synchronized (this) {
                    Set<String> set = smartIds();
                    set.add(videoId);
                    ids.edit().putStringSet(SMART, set).apply();
                }
            } catch (Exception e) {
                if (isNetworkError(e)) break; // lost Wi-Fi: try again later
                Log.i(TAG, "Smart download skipped " + track.title + ": " + describe(e));
            }
        }
        synchronized (this) {
            ids.edit().putStringSet(SMART, keep).apply();
        }
        return keep.size();
    }

    /**
     * Phone storage nearly full: free room. Saved songs go first, then smart
     * downloads (oldest first); your own downloads are never removed.
     */
    private void freeSpaceIfLow(File keep) {
        long minFree = 300L * 1024 * 1024;
        if (cacheDir.getUsableSpace() >= minFree) return;
        File[] files = cacheDir.listFiles((dir, name) -> !name.endsWith(".part"));
        if (files == null) return;
        Set<String> pinned = pinnedIds();
        Set<String> smart = smartIds();
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int pass = 0; pass < 2; pass++) {
            for (File f : files) {
                if (cacheDir.getUsableSpace() >= minFree) return;
                String id = videoIdOf(f);
                if (f.equals(keep) || pinned.contains(id)) continue;
                if ((pass == 0) == smart.contains(id)) continue; // pass 0: saved songs; pass 1: smart
                if (f.delete() && pass == 1) {
                    synchronized (this) {
                        Set<String> set = smartIds();
                        set.remove(id);
                        ids.edit().putStringSet(SMART, set).apply();
                    }
                }
            }
        }
    }

    boolean isDownloaded(String key) {
        String videoId = knownVideoId(key);
        return videoId != null && pinnedIds().contains(videoId) && findCached(videoId) != null;
    }

    // --- Search ------------------------------------------------------------------

    private String resolveVideoId(Track track) throws Exception {
        // Songs that came from YouTube itself (radio) already know their video.
        if (track.key.startsWith("yt-")) return track.key.substring(3);
        String known = ids.getString(track.key, null);
        if (known != null) return known;

        List<String> candidates = searchCandidates(track);
        if (candidates.isEmpty()) throw new IOException("No YouTube Music match for " + track.title);
        String videoId = candidates.get(0);
        ids.edit().putString(track.key, videoId).apply();
        return videoId;
    }

    /**
     * YouTube Music matches for a song, best first: results about as long as
     * the catalog's version (within 10s; skips live versions, remixes), then
     * the rest of the top results, then regular YouTube videos.
     */
    private List<String> searchCandidates(Track track) throws Exception {
        StreamingService yt = ServiceList.YouTube;
        String query = (track.title + " " + track.artist).trim();
        List<String> good = new ArrayList<>();
        List<String> rest = new ArrayList<>();
        for (String filter : new String[] { YoutubeSearchQueryHandlerFactory.MUSIC_SONGS, YoutubeSearchQueryHandlerFactory.VIDEOS }) {
            SearchQueryHandler q = yt.getSearchQHFactory().fromQuery(query, Collections.singletonList(filter), "");
            int n = 0;
            for (InfoItem item : SearchInfo.getInfo(yt, q).getRelatedItems()) {
                if (!(item instanceof StreamInfoItem) || ++n > 5) continue;
                String id = yt.getStreamLHFactory().getId(item.getUrl());
                long d = ((StreamInfoItem) item).getDuration();
                boolean fits = track.durationMs <= 0 || (d > 0 && Math.abs(d - track.durationMs / 1000) <= 10);
                (fits ? good : rest).add(id);
            }
            if (!good.isEmpty()) break; // songs found: no need for plain videos
        }
        List<String> all = new ArrayList<>(good);
        for (String id : rest) if (!all.contains(id)) all.add(id);
        return all;
    }

    private static boolean isNetworkError(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof java.net.UnknownHostException
                || t instanceof java.net.SocketTimeoutException
                || t instanceof java.net.ConnectException
                || t instanceof javax.net.ssl.SSLException) return true;
        }
        return false;
    }

    /**
     * The song's real music video (YouTube Music's song uploads are usually
     * just the album cover). Only one about as long as the song playing, so
     * switching between audio and video keeps the same spot in the song.
     * Null when there's no such video. Remembered per song.
     */
    String findMusicVideo(Track track, long audioSec) throws Exception {
        String cacheKey = "mv:" + track.key;
        if (ids.contains(cacheKey)) {
            String v = ids.getString(cacheKey, "");
            return v.isEmpty() ? null : v;
        }
        StreamingService yt = ServiceList.YouTube;
        String query = (track.title + " " + track.artist).trim();
        SearchQueryHandler q = yt
            .getSearchQHFactory()
            .fromQuery(query, Collections.singletonList(YoutubeSearchQueryHandlerFactory.MUSIC_VIDEOS), "");
        String found = "";
        int checked = 0;
        for (InfoItem item : SearchInfo.getInfo(yt, q).getRelatedItems()) {
            if (!(item instanceof StreamInfoItem)) continue;
            if (++checked > 5) break;
            long d = ((StreamInfoItem) item).getDuration();
            if (audioSec > 0 && d > 0 && Math.abs(d - audioSec) <= 4) {
                found = yt.getStreamLHFactory().getId(item.getUrl());
                break;
            }
        }
        ids.edit().putString(cacheKey, found).apply();
        Log.i(TAG, "Music video for " + query + ": " + (found.isEmpty() ? "none" : found));
        return found.isEmpty() ? null : found;
    }

    // --- Download ------------------------------------------------------------------

    /** Fetches YouTube's info for a video; remembers its loudness while at it. */
    private StreamInfo loadInfo(String videoId) throws Exception {
        StreamExtractor extractor = ServiceList.YouTube.getStreamExtractor("https://www.youtube.com/watch?v=" + videoId);
        StreamInfo info = StreamInfo.getInfo(extractor);
        Float loudnessDb = Loudness.find(extractor, bestAudioOf(info, videoId).getItag());
        float gain = Loudness.gainFor(loudnessDb);
        ids.edit().putFloat(GAIN_PREFIX + videoId, gain).apply();
        Log.i(TAG, "Loudness for " + videoId + ": " + loudnessDb + " dB -> volume " + gain);
        return info;
    }

    /**
     * Volume (0..1) that matches YouTube's own loudness normalization, so the
     * song sounds the same here as in the video. NaN if not known yet.
     */
    float gainFor(String videoId) {
        return ids.getFloat(GAIN_PREFIX + videoId, Float.NaN);
    }

    /** For songs cached before gains were stored: look it up now (network). */
    float ensureGain(String videoId) throws Exception {
        float known = gainFor(videoId);
        if (!Float.isNaN(known)) return known;
        loadInfo(videoId);
        return gainFor(videoId);
    }

    private AudioStream bestAudio(String videoId) throws Exception {
        return bestAudioOf(loadInfo(videoId), videoId);
    }

    private static AudioStream bestAudioOf(StreamInfo info, String videoId) throws IOException {
        AudioStream best = null;
        int bestScore = Integer.MIN_VALUE;
        for (AudioStream s : info.getAudioStreams()) {
            if (!s.isUrl() || s.getDeliveryMethod() != DeliveryMethod.PROGRESSIVE_HTTP) continue;
            AudioTrackType type = s.getAudioTrackType();
            if (type != null && type != AudioTrackType.ORIGINAL) continue; // skip dubbed tracks
            int bitrate = s.getAverageBitrate() > 0 ? s.getAverageBitrate() : s.getBitrate();
            // Opus is better per bit; AAC (m4a) as a close second.
            int score = bitrate + (s.getFormat() == MediaFormat.WEBMA_OPUS ? 16_000 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = s;
            }
        }
        if (best == null) throw new IOException("No downloadable audio stream for " + videoId);
        return best;
    }

    private File download(String videoId) throws Exception {
        AudioStream stream = bestAudio(videoId);
        String ext = stream.getFormat() != null ? stream.getFormat().getSuffix() : "m4a";
        File part = new File(cacheDir, videoId + "." + ext + ".part");
        File done = new File(cacheDir, videoId + "." + ext);

        ItagItem itag = stream.getItagItem();
        long total = itag != null ? itag.getContentLength() : -1;
        String url = stream.getContent();

        try (OutputStream out = new FileOutputStream(part)) {
            long pos = 0;
            int requestNumber = 0;
            while (total <= 0 || pos < total) {
                long end = pos + CHUNK_BYTES - 1;
                if (total > 0) end = Math.min(end, total - 1);
                long wanted = end - pos + 1;
                long got = fetchRange(url, pos, end, requestNumber++, out);
                pos += got;
                if (got == 0 || got < wanted) break; // short read: end of file
            }
            if (pos == 0) throw new IOException("Empty audio for " + videoId);
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw e;
        }
        if (!part.renameTo(done)) throw new IOException("Could not save " + done);
        return done;
    }

    /** One ranged request, written to out. Returns bytes read. */
    private long fetchRange(String url, long start, long end, int rn, OutputStream out) throws IOException {
        String requestUrl = url + "&range=" + start + "-" + end + "&rn=" + rn;
        HttpURLConnection conn = (HttpURLConnection) new URL(requestUrl).openConnection();
        try {
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(20_000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(POST_BODY.length);
            if (YoutubeParsingHelper.isWebStreamingUrl(requestUrl)) {
                conn.setRequestProperty("Origin", "https://www.youtube.com");
                conn.setRequestProperty("Referer", "https://www.youtube.com/");
            }
            conn.setRequestProperty(
                "User-Agent",
                YoutubeParsingHelper.isVisionOsStreamingUrl(requestUrl)
                    ? YoutubeParsingHelper.getVisionOsUserAgent(null)
                    : NpDownloader.USER_AGENT
            );
            conn.setRequestProperty("Accept-Encoding", "identity");
            try (OutputStream body = conn.getOutputStream()) {
                body.write(POST_BODY);
            }

            int code = conn.getResponseCode();
            if (code == 416) return 0; // asked past the end
            if (code >= 400) throw new IOException("YouTube media request failed: HTTP " + code);

            long read = 0;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = conn.getInputStream()) {
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    read += n;
                }
            }
            return read;
        } finally {
            conn.disconnect();
        }
    }

    // --- Cache ---------------------------------------------------------------------

    private File findCached(String videoId) {
        for (String ext : new String[] { "webm", "m4a" }) {
            File f = new File(cacheDir, videoId + "." + ext);
            if (f.isFile() && f.length() > 0) return f;
        }
        return null;
    }

    private void trimCache(File keep) {
        File[] files = cacheDir.listFiles((dir, name) -> !name.endsWith(".part"));
        if (files == null) return;
        long total = 0;
        for (File f : files) total += f.length();
        freeSpaceIfLow(keep);
        files = cacheDir.listFiles((dir, name) -> !name.endsWith(".part"));
        if (files == null) return;
        total = 0;
        for (File f : files) total += f.length();
        // Downloads (yours and smart ones) don't count towards the limit and
        // aren't removed here.
        Set<String> pinned = pinnedIds();
        pinned.addAll(smartIds());
        for (File f : files) if (pinned.contains(videoIdOf(f))) total -= f.length();
        long limit = cacheLimitMb() * 1024L * 1024L;
        if (total <= limit) return;
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : files) {
            if (total <= limit) break;
            if (f.equals(keep) || pinned.contains(videoIdOf(f))) continue;
            total -= f.length();
            if (!f.delete()) Log.w(TAG, "Could not delete " + f);
        }
    }

    static String describe(Throwable e) {
        String msg = e.getMessage();
        return e.getClass().getSimpleName() + (msg != null ? ": " + msg : "");
    }
}
