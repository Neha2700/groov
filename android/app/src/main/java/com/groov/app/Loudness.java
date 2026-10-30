package com.groov.app;

import java.lang.reflect.Field;
import java.util.List;
import java.util.Map;

/**
 * YouTube normalizes loudness: its player turns loud songs down so every
 * video plays at a similar level, using a per-video "loudnessDb" from the
 * player response. The downloaded audio has no such adjustment, so without
 * this it plays a little louder than the video does.
 *
 * NewPipeExtractor receives that value but doesn't expose it, so we read it
 * from the extractor's parsed responses (nanojson objects are plain Maps).
 */
final class Loudness {

    private Loudness() {}

    /** YouTube only turns loud content down, never quiet content up. */
    static float gainFor(Float loudnessDb) {
        if (loudnessDb == null || loudnessDb.isNaN() || loudnessDb <= 0) return 1f;
        float gain = (float) Math.pow(10, -loudnessDb / 20.0);
        return Math.max(0.1f, Math.min(1f, gain));
    }

    /** The format's own loudnessDb if present, else the video-wide value. */
    static Float find(Object extractor, int itag) {
        Float formatLevel = null;
        Float videoLevel = null;
        for (Class<?> c = extractor.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
            for (Field field : c.getDeclaredFields()) {
                if (!Map.class.isAssignableFrom(field.getType())) continue;
                Object value;
                try {
                    field.setAccessible(true);
                    value = field.get(extractor);
                } catch (Exception e) {
                    continue;
                }
                if (!(value instanceof Map)) continue;
                Map<?, ?> json = (Map<?, ?>) value;

                // playerResponse.playerConfig.audioConfig.loudnessDb
                Number video = number(get(get(json, "playerConfig"), "audioConfig"), "loudnessDb");
                if (video != null && videoLevel == null) videoLevel = video.floatValue();

                // streamingData.adaptiveFormats[itag].loudnessDb
                Object streamingData = json.containsKey("adaptiveFormats") ? json : json.get("streamingData");
                Object formats = get(streamingData, "adaptiveFormats");
                if (formats instanceof List) {
                    for (Object f : (List<?>) formats) {
                        Number formatItag = number(f, "itag");
                        Number loudness = number(f, "loudnessDb");
                        if (formatItag != null && formatItag.intValue() == itag && loudness != null) {
                            formatLevel = loudness.floatValue();
                        }
                    }
                }
            }
        }
        return formatLevel != null ? formatLevel : videoLevel;
    }

    private static Object get(Object map, String key) {
        return map instanceof Map ? ((Map<?, ?>) map).get(key) : null;
    }

    private static Number number(Object map, String key) {
        Object v = get(map, key);
        return v instanceof Number ? (Number) v : null;
    }
}
