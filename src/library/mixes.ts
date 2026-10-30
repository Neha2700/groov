// "Made for you": mixes you can open like a playlist.
//   On Repeat   – your most-played songs of the last 4 weeks
//   Daily Mix   – 2–3 songs you love (different artists) + YouTube Music's
//                 mixes after them, blended: at most 4 songs per artist and
//                 never the same artist twice in a row. Fetched once a day;
//                 first songs downloaded in advance (instant, offline).
//   Rediscover  – favourites you haven't played in 3 weeks
// New listeners get Daily Mixes from their playlists, or from the charts.
import { fetchTrendingSongs } from "../api/itunes";
import { hasNativeAudio, nativeAudio, toNativeTrack } from "../player/native-audio";
import { librarySongs, radioAfter } from "../player/radio";
import { bus, trackRegistry } from "../state";
import type { Item } from "../types";
import { storage } from "../utils";
import { historySize, mainArtist, topSongs, type SongStat } from "./history";

const DAY = 86400000;
const MIX_SIZE = 25;
const CACHE_KEY = "groov:daily-mixes";
const PREFETCH_KEY = "groov:mix-prefetched";
/** Songs per Daily Mix downloaded ahead of time (Android). */
const PREFETCH_PER_MIX = 4;

export interface Mix {
  id: string;
  title: string;
  subtitle: string;
  /** Known songs (On Repeat / Rediscover), or the seeds of a Daily Mix. */
  songs?: Item[];
  seed?: Item;
  seeds?: Item[];
}

/** At most this many songs by one artist in a Daily Mix. */
const MAX_PER_ARTIST = 4;

const today = () => Math.floor(Date.now() / DAY);

/** One song each from different artists. */
function byDifferentArtists(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const a = mainArtist(i.subtitle).toLowerCase();
    if (seen.has(a)) return false;
    seen.add(a);
    return true;
  });
}

let chartSeeds: Item[] = [];

export function getMixes(): Mix[] {
  const now = Date.now();
  const out: Mix[] = [];
  const month = topSongs(now - 28 * DAY, 60);

  const onRepeat = month.filter((s) => s.plays >= 2).slice(0, MIX_SIZE);
  if (onRepeat.length >= 3) {
    out.push({ id: "repeat", title: "On Repeat", subtitle: "Songs you can't stop playing", songs: onRepeat.map((s) => s.item) });
  }

  // Seeds: your top songs; else your playlists; else today's chart.
  const fromHistory = (month.length >= 3 ? month : topSongs(0, 60)).map((s: SongStat) => s.item);
  let seeds = byDifferentArtists(historySize() >= 5 ? fromHistory : []);
  if (seeds.length < 2) seeds = byDifferentArtists([...seeds, ...librarySongs()]);
  if (seeds.length < 2) seeds = byDifferentArtists([...seeds, ...chartSeeds]);
  // Two mixes, each from up to 3 of your top songs (different artists),
  // taken in turns and rotated daily so the mixes change.
  const top = seeds.slice(0, 8);
  const shift = top.length ? today() % top.length : 0;
  const rotated = [...top.slice(shift), ...top.slice(0, shift)];
  const groups = [rotated.filter((_, i) => i % 2 === 0).slice(0, 3), rotated.filter((_, i) => i % 2 === 1).slice(0, 3)];
  if (!groups[1].length && rotated.length) groups[1] = rotated.slice(-1).filter((s) => s !== groups[0][0]);
  groups.forEach((group, i) => {
    if (!group.length) return;
    const names = [...new Set(group.map((g) => mainArtist(g.subtitle)))];
    out.push({
      id: `daily${i + 1}`,
      title: `Daily Mix ${i + 1}`,
      subtitle: `${names.slice(0, 2).join(", ")} and more`,
      seed: group[0],
      seeds: group,
    });
  });

  const rediscover = topSongs(0, 300)
    .filter((s) => s.lastPlayed < now - 21 * DAY && s.plays >= 2)
    .slice(0, MIX_SIZE);
  if (rediscover.length >= 3) {
    out.push({ id: "rediscover", title: "Rediscover", subtitle: "Old favourites you haven't played lately", songs: rediscover.map((s) => s.item) });
  }
  return out;
}

export function getMix(id: string): Mix | undefined {
  return getMixes().find((m) => m.id === id);
}

// --- Daily Mix songs (fetched once a day per seed) -------------------------------------

type Cache = Record<string, { day: number; songs: Item[] }>;

const mixKey = (mix: Mix) => (mix.seeds ?? (mix.seed ? [mix.seed] : [])).map((s) => s.id).join("+");

export function cachedMixSongs(mix: Mix): Item[] | null {
  if (mix.songs) return mix.songs;
  if (!mix.seed) return [];
  const hit = storage.get<Cache>(CACHE_KEY, {})[mixKey(mix)];
  return hit && hit.day === today() ? hit.songs : null;
}

const artistOf = (i: Item) => mainArtist(i.subtitle).toLowerCase();
const titleOf = (i: Item) => i.name.toLowerCase().replace(/\s*[([].*$/, "").trim();

/**
 * Blend: the seeds first, then their mixes in turns; at most MAX_PER_ARTIST
 * songs per artist; then spread so one artist never plays twice in a row.
 */
export function blendMix(seeds: Item[], lists: Item[][], size = MIX_SIZE): Item[] {
  const perArtist = new Map<string, number>();
  const titles = new Set<string>();
  const picked: Item[] = [];
  const take = (i: Item) => {
    const a = artistOf(i);
    const t = titleOf(i);
    if (titles.has(t) || (perArtist.get(a) ?? 0) >= MAX_PER_ARTIST) return;
    titles.add(t);
    perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
    picked.push(i);
  };
  seeds.forEach(take);
  for (let i = 0; picked.length < size && i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const list of lists) if (list[i] && picked.length < size) take(list[i]);
  }
  // Spread: take the next song whose artist differs from the previous one.
  const out: Item[] = [];
  const rest = [...picked];
  while (rest.length) {
    const prev = out.length ? artistOf(out[out.length - 1]) : "";
    const idx = rest.findIndex((i) => artistOf(i) !== prev);
    out.push(rest.splice(idx < 0 ? 0 : idx, 1)[0]);
  }
  return out;
}

const inflight = new Map<string, Promise<Item[]>>();

export async function loadMixSongs(mix: Mix): Promise<Item[]> {
  const cached = cachedMixSongs(mix);
  if (cached) return cached;
  const seeds = mix.seeds ?? [mix.seed!];
  const key = mixKey(mix);
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      const lists = await Promise.all(seeds.map((s) => radioAfter(s).catch(() => [] as Item[])));
      if (!lists.some((l) => l.length)) throw new Error("no radio");
      const songs = blendMix(seeds, lists);
      const cache = storage.get<Cache>(CACHE_KEY, {});
      // Keep only today's mixes.
      for (const k of Object.keys(cache)) if (cache[k].day !== today()) delete cache[k];
      cache[key] = { day: today(), songs };
      storage.set(CACHE_KEY, cache);
      return songs;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const songs = await job;
  songs.forEach((s) => trackRegistry.set(s.id, s));
  return songs;
}

// --- Getting today's mixes ready in the background -------------------------------------

let warming = false;

/** Fetch today's Daily Mixes and download their first songs (once a day). */
export async function warmMixes(): Promise<void> {
  if (warming) return;
  warming = true;
  try {
    if (!chartSeeds.length && historySize() < 5 && librarySongs().length < 2) {
      chartSeeds = await fetchTrendingSongs(20).catch(() => []);
      if (chartSeeds.length) bus.emit("mixchange", undefined);
    }
    const daily = getMixes().filter((m) => m.seed);
    let changed = false;
    for (const mix of daily) {
      if (cachedMixSongs(mix)) continue;
      try {
        await loadMixSongs(mix);
        changed = true;
      } catch {
        // offline: try again next time Home opens
      }
    }
    if (changed) bus.emit("mixchange", undefined);

    if (!hasNativeAudio) return;
    const done = storage.get<{ day: number; ids: string[] }>(PREFETCH_KEY, { day: 0, ids: [] });
    const ids = done.day === today() ? done.ids : [];
    for (const mix of daily) {
      const songs = cachedMixSongs(mix) ?? [];
      for (const song of songs.slice(0, PREFETCH_PER_MIX)) {
        if (ids.includes(song.id)) continue;
        // One at a time, so it doesn't slow down what you're playing.
        await nativeAudio.prefetch({ ...toNativeTrack(song), wait: true }).catch(() => undefined);
        ids.push(song.id);
        storage.set(PREFETCH_KEY, { day: today(), ids });
      }
    }
  } finally {
    warming = false;
  }
}
