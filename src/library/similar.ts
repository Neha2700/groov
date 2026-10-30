// "Similar to [artist]": new artists for you. Takes one of your top 3
// artists (a different one each day), YouTube Music's radio from their
// songs, and keeps only *other* artists you don't know yet, 1–2 songs each.
import { fetchArtistTracks, findArtistId } from "../api/itunes";
import { librarySongs, radioAfter } from "../player/radio";
import type { Item } from "../types";
import { storage } from "../utils";
import { mainArtist, topArtists, topSongs } from "./history";

const KEY = "groov:similar";
const DAY = 86400000;
const today = () => Math.floor(Date.now() / DAY);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

interface Cached {
  day: number;
  artist: string;
  items: Item[];
}

/** Your top artists: from listening, else from your playlists. */
function yourTopArtists(): { name: string; artistId?: number }[] {
  const heard = topArtists(Date.now() - 28 * DAY, 3);
  if (heard.length) return heard.map((a) => ({ name: a.name, artistId: a.artistId }));
  const counts = new Map<string, { name: string; artistId?: number; n: number }>();
  for (const t of librarySongs()) {
    const name = mainArtist(t.subtitle);
    const c = counts.get(norm(name)) ?? { name, artistId: t.artistId, n: 0 };
    c.n++;
    counts.set(norm(name), c);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 3);
}

export function cachedSimilar(): Cached | null {
  const hit = storage.get<Cached | null>(KEY, null);
  return hit && hit.day === today() ? hit : null;
}

let job: Promise<Cached | null> | null = null;

export function loadSimilar(): Promise<Cached | null> {
  const hit = cachedSimilar();
  if (hit) return Promise.resolve(hit);
  job ??= (async () => {
    const artists = yourTopArtists();
    if (!artists.length) return null;
    const artist = artists[today() % artists.length];
    const key = norm(artist.name);
    // Seeds: their songs you play most, else their popular songs.
    let seeds = topSongs(0, 300)
      .map((s) => s.item)
      .filter((i) => norm(mainArtist(i.subtitle)) === key)
      .slice(0, 2);
    if (!seeds.length) {
      const id = artist.artistId || (await findArtistId(artist.name));
      if (id) seeds = (await fetchArtistTracks(id, 3).catch(() => [])).slice(0, 2);
    }
    if (!seeds.length) return null;
    const lists = await Promise.all(seeds.map((s) => radioAfter(s).catch(() => [] as Item[])));

    // Not the artist, not songs you already know, at most 2 per artist.
    const known = new Set([...librarySongs(), ...topSongs(0, 2000).map((s) => s.item)].map((i) => norm(i.name)));
    const perArtist = new Map<string, number>();
    const items: Item[] = [];
    for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)) && items.length < 15; i++) {
      for (const list of lists) {
        const item = list[i];
        if (!item) continue;
        const a = norm(mainArtist(item.subtitle));
        if (!a || a.includes(key) || key.includes(a) || norm(item.subtitle).includes(key)) continue;
        if (known.has(norm(item.name)) || (perArtist.get(a) ?? 0) >= 2) continue;
        perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
        items.push(item);
      }
    }
    if (items.length < 4) return null;
    const result = { day: today(), artist: artist.name, items };
    storage.set(KEY, result);
    return result;
  })().finally(() => (job = null));
  return job;
}
