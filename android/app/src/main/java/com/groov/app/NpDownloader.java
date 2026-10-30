package com.groov.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import androidx.annotation.NonNull;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;

/** The HTTP client NewPipeExtractor uses for its YouTube requests. */
final class NpDownloader extends Downloader {

    /** Same desktop UA NewPipe uses; YouTube serves its web pages to it. */
    static final String USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

    private static NpDownloader instance;

    static synchronized NpDownloader get() {
        if (instance == null) instance = new NpDownloader();
        return instance;
    }

    private NpDownloader() {}

    @Override
    public Response execute(@NonNull Request request) throws IOException, ReCaptchaException {
        HttpURLConnection conn = (HttpURLConnection) new URL(request.url()).openConnection();
        try {
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(20_000);
            conn.setRequestMethod(request.httpMethod());
            conn.setRequestProperty("User-Agent", USER_AGENT);

            Map<String, List<String>> headers = request.headers();
            if (headers != null) {
                for (Map.Entry<String, List<String>> h : headers.entrySet()) {
                    if (h.getKey() == null || h.getValue() == null) continue;
                    boolean first = true;
                    for (String value : h.getValue()) {
                        if (first) conn.setRequestProperty(h.getKey(), value);
                        else conn.addRequestProperty(h.getKey(), value);
                        first = false;
                    }
                }
            }

            byte[] body = request.dataToSend();
            if (body != null) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body);
                }
            }

            int code = conn.getResponseCode();
            if (code == 429) throw new ReCaptchaException("reCaptcha Challenge requested", request.url());

            InputStream raw = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String responseBody = null;
            if (raw != null) {
                InputStream in = "gzip".equalsIgnoreCase(conn.getContentEncoding()) ? new GZIPInputStream(raw) : raw;
                try (InputStream stream = in) {
                    responseBody = readAll(stream);
                }
            }

            // HttpURLConnection puts the status line under a null key; the extractor dislikes that.
            Map<String, List<String>> responseHeaders = new HashMap<>();
            for (Map.Entry<String, List<String>> h : conn.getHeaderFields().entrySet()) {
                if (h.getKey() != null) responseHeaders.put(h.getKey(), h.getValue());
            }

            return new Response(code, conn.getResponseMessage(), responseHeaders, responseBody, conn.getURL().toString());
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
