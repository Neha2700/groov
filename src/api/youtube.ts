// YouTube Data API v3 lookups (costs quota) + the IFrame Player API (free).
import { KEYS, getYoutubeApiKey } from "../config";
import type { Item } from "../types";
import { storage } from "../utils";
import { lookupSharedVideoId, shareVideoId } from "../cloud/shared";

/** item id -> YouTube video id (null = searched, nothing found). */
const idCache: Record<string, string | null> = storage.get(KEYS.ytCache, {});

export function getCachedVideoId(itemId: string): string | null | undefined {
  return itemId in idCache ? idCache[itemId] : undefined;
}

/** Concurrent lookups for the same track share one request (and one quota hit). */
const inflight = new Map<string, Promise<string | null>>();

export async function findYoutubeVideoId(item: Item): Promise<string | null> {
  const cached = getCachedVideoId(item.id);
  if (cached !== undefined) return cached;
  const pending = inflight.get(item.id);
  if (pending) return pending;

  const lookup = (async () => {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoCategoryId: "10", // Music
      maxResults: "1",
      q: `${item.name} ${item.subtitle}`,
      key: getYoutubeApiKey(),
    });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (!response.ok) throw new Error(`YouTube API error: ${response.status}`);
    const data = (await response.json()) as { items?: { id?: { videoId?: string } }[] };
    const videoId = data.items?.[0]?.id?.videoId || null;
    idCache[item.id] = videoId;
    storage.set(KEYS.ytCache, idCache);
    if (videoId) shareVideoId(item.id, videoId);
    return videoId;
  })();

  inflight.set(item.id, lookup);
  try {
    return await lookup;
  } finally {
    inflight.delete(item.id);
  }
}

// --- IFrame Player API ------------------------------------------------------

let apiReady: Promise<typeof YT> | null = null;

export function loadYoutubeIframeApi(): Promise<typeof YT> {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return apiReady;
}

/**
 * Which video to play for a song, cheapest way first: songs from YouTube
 * know it; then this device's cache; then a match another Groov device
 * already found (free, no key); then a YouTube search (needs a key).
 */
export async function resolveVideoId(item: Item): Promise<string | null> {
  if (item.id.startsWith("yt-")) return item.id.slice(3);
  const cached = getCachedVideoId(item.id);
  if (cached) return cached;
  const shared = await lookupSharedVideoId(item.id);
  if (shared) {
    idCache[item.id] = shared;
    storage.set(KEYS.ytCache, idCache);
    return shared;
  }
  if (cached === null || !getYoutubeApiKey()) return null;
  try {
    return await findYoutubeVideoId(item);
  } catch {
    return null; // network/quota error: the caller falls back to the preview
  }
}
