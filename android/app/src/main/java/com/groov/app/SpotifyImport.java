package com.groov.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A public Spotify playlist or album from its link, with no login and no API
 * key: Spotify's embed page (the small player other websites show) carries
 * the song list as JSON. Up to 100 songs, as the embed shows.
 */
final class SpotifyImport {

    static final class Song {
        final String id;
        final String title;
        final String artists;
        final long durationMs;

        Song(String id, String title, String artists, long durationMs) {
            this.id = id;
            this.title = title;
            this.artists = artists;
            this.durationMs = durationMs;
        }
    }

    static final class Result {
        final String name;
        final String cover;
        final List<Song> songs;

        Result(String name, String cover, List<Song> songs) {
            this.name = name;
            this.cover = cover;
            this.songs = songs;
        }
    }

    private static final Pattern LINK = Pattern.compile("(playlist|album)[/:]([A-Za-z0-9]{16,})");
    private static final Pattern TRACK = Pattern.compile("track[/:]([A-Za-z0-9]{16,})");

    /** One shared Spotify song: its name and artists (to find it on YouTube Music). */
    static Song fetchTrack(String link) throws Exception {
        Matcher m = TRACK.matcher(link);
        if (!m.find()) throw new IOException("That doesn't look like a Spotify song link");
        String id = m.group(1);
        JSONObject entity = findEntity(get("https://open.spotify.com/embed/track/" + id));
        if (entity == null) throw new IOException("Spotify didn't share this song");
        String title = entity.optString("name", entity.optString("title", ""));
        StringBuilder artists = new StringBuilder();
        JSONArray list = entity.optJSONArray("artists");
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                String name = list.optJSONObject(i) != null ? list.optJSONObject(i).optString("name", "") : "";
                if (name.isEmpty()) continue;
                if (artists.length() > 0) artists.append(", ");
                artists.append(name);
            }
        }
        if (artists.length() == 0) artists.append(entity.optString("subtitle", "").replace('\u00a0', ' '));
        if (title.isEmpty()) throw new IOException("No song found at this link");
        return new Song(id, title, artists.toString().trim(), entity.optLong("duration", 0));
    }
    /** The page has used three ways to carry its data over the years. */
    private static final Pattern NEXT_DATA = Pattern.compile("<script[^>]*id=\"__NEXT_DATA__\"[^>]*>(.+?)</script>", Pattern.DOTALL);
    private static final Pattern BASE64_SCRIPT = Pattern.compile("<script[^>]*id=\"(resource|initial-state)\"[^>]*>([A-Za-z0-9+/=\\s]+)</script>", Pattern.DOTALL);

    private static JSONObject findEntity(String html) {
        try {
            Matcher next = NEXT_DATA.matcher(html);
            if (next.find()) {
                JSONObject state = new JSONObject(next.group(1)).getJSONObject("props").getJSONObject("pageProps").optJSONObject("state");
                if (state != null) return state.getJSONObject("data").getJSONObject("entity");
            }
            Matcher b64 = BASE64_SCRIPT.matcher(html);
            while (b64.find()) {
                String json = new String(android.util.Base64.decode(b64.group(2).trim(), android.util.Base64.DEFAULT), StandardCharsets.UTF_8);
                JSONObject o = new JSONObject(json);
                if (b64.group(1).equals("resource")) return o;
                JSONObject data = o.optJSONObject("data");
                if (data != null && data.optJSONObject("entity") != null) return data.getJSONObject("entity");
            }
        } catch (Exception e) {
            android.util.Log.w("GroovSpotify", "Couldn't read the Spotify page", e);
        }
        return null;
    }

    static boolean isSpotifyLink(String link) {
        return link.contains("spotify.com") || link.startsWith("spotify:");
    }

    static Result fetch(String link) throws Exception {
        Matcher m = LINK.matcher(link);
        if (!m.find()) throw new IOException("That doesn't look like a Spotify playlist or album link");
        String type = m.group(1);
        String id = m.group(2);
        String html = get("https://open.spotify.com/embed/" + type + "/" + id);
        JSONObject entity = findEntity(html);
        if (entity == null) throw new IOException("Spotify didn't share this " + type + " (is it private?)");

        String name = entity.optString("name", entity.optString("title", "Spotify " + type));
        String cover = null;
        JSONObject visual = entity.optJSONObject("visualIdentity");
        JSONObject coverArt = entity.optJSONObject("coverArt");
        JSONArray images = coverArt != null ? coverArt.optJSONArray("sources")
            : visual != null ? visual.optJSONArray("image") : entity.optJSONArray("images");
        if (images != null && images.length() > 0) cover = images.getJSONObject(images.length() - 1).optString("url", null);

        List<Song> songs = new ArrayList<>();
        JSONArray list = entity.optJSONArray("trackList");
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject t = list.getJSONObject(i);
                String title = t.optString("title", "");
                if (title.isEmpty()) continue;
                String uri = t.optString("uri", ""); // spotify:track:<id>
                String trackId = uri.substring(uri.lastIndexOf(':') + 1);
                String artists = t.optString("subtitle", "").replace(' ', ' ').trim();
                songs.add(new Song(trackId.isEmpty() ? String.valueOf(i) : trackId, title, artists, t.optLong("duration", 0)));
            }
        }
        if (songs.isEmpty()) throw new IOException("No songs found in this " + type);
        return new Result(name, cover, songs);
    }

    private static String get(String url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestProperty("User-Agent", NpDownloader.USER_AGENT);
        conn.setRequestProperty("Accept-Language", "en");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        try {
            int code = conn.getResponseCode();
            if (code == 404) throw new IOException("Spotify says this doesn't exist (is it private?)");
            if (code >= 400) throw new IOException("Spotify answered " + code);
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toString(StandardCharsets.UTF_8.name());
            }
        } finally {
            conn.disconnect();
        }
    }
}
