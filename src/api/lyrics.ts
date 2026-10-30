// Synced lyrics from lrclib.net: free, no key, CORS-open.
import type { Item, LyricLine, Lyrics } from "../types";

const LRCLIB_API = "https://lrclib.net/api";
const cache = new Map<string, Lyrics | null>(); // track id -> lyrics | null (not found)

export function parseLrc(lrc: string | null | undefined): LyricLine[] | null {
  if (!lrc) return null;
  const lines: LyricLine[] = [];
  const timeTag = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
  for (const rawLine of lrc.split("\n")) {
    const matches = [...rawLine.matchAll(timeTag)];
    if (!matches.length) continue;
    const text = rawLine.replace(timeTag, "").trim();
    for (const m of matches) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
      lines.push({ time: minutes * 60 + seconds + ms / 1000, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines.length ? lines : null;
}

interface LrclibRecord {
  trackName?: string;
  artistName?: string;
  duration?: number; // seconds
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** "Arijit Singh, Shreya Ghoshal" → "Arijit Singh" (lrclib lists the main artist). */
function firstArtist(subtitle: string): string {
  return subtitle.split(/,|&| feat\.? | ft\.? | x /i)[0].trim() || subtitle;
}

/** "Kesariya (From \"Brahmastra\")" → "Kesariya". */
function plainTitle(name: string): string {
  return name.replace(/\s*[([][^)\]]*[)\]]/g, "").replace(/\s+-\s+.*$/, "").trim() || name;
}

/**
 * Lrclib often has several versions of a song (album, radio edit, video with
 * a longer intro…). Their timings differ, so pick the one whose length is
 * closest to what's actually playing, preferring synced lyrics.
 */
function pickBest(records: LrclibRecord[], durationSec: number): LrclibRecord | null {
  const usable = records.filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics));
  if (!usable.length) return null;
  const off = (r: LrclibRecord) => (durationSec > 0 && r.duration ? Math.abs(r.duration - durationSec) : 999);
  const score = (r: LrclibRecord) => off(r) + (r.syncedLyrics ? 0 : 30); // synced unless way off
  return [...usable].sort((a, b) => score(a) - score(b))[0];
}

/** durationSec: the length of the song as it's playing now (0 if unknown yet). */
export async function fetchLyrics(item: Item, durationSec = 0): Promise<Lyrics | null> {
  if (cache.has(item.id)) return cache.get(item.id) ?? null;
  const duration = durationSec || (item.durationMs ? item.durationMs / 1000 : 0);
  const artist = firstArtist(item.subtitle || "");
  const title = plainTitle(item.name || "");

  const results = [
    ...((await getJson<LrclibRecord[]>(
      `${LRCLIB_API}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`,
    )) ?? []),
  ];
  // Nothing close enough: also try a looser search.
  const best = pickBest(results, duration);
  if (!best || (duration && best.duration && Math.abs(best.duration - duration) > 3)) {
    const loose = await getJson<LrclibRecord[]>(`${LRCLIB_API}/search?${new URLSearchParams({ q: `${title} ${artist}` })}`);
    // A looser search finds other songs too: keep only this title by this artist.
    const norm = (x = "") => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const same = (r: LrclibRecord) =>
      norm(r.trackName).includes(norm(title)) &&
      Boolean(norm(r.artistName)) &&
      (norm(r.artistName).includes(norm(artist)) || norm(artist).includes(norm(r.artistName)));
    if (loose) results.push(...loose.filter(same));
  }
  const data = pickBest(results, duration);

  const parsed = data ? { plain: data.plainLyrics || "", synced: parseLrc(data.syncedLyrics) } : null;
  // Don't remember "not found" for long: may just have been offline.
  if (parsed || results.length) cache.set(item.id, parsed);
  return parsed;
}
