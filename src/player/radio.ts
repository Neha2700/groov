// Endless radio, Surprise me, and Shuffle my library.
//
// Radio on Android uses YouTube Music's own mix for a song (what it would
// play next), topped up from the last song whenever the queue runs low, so it
// never ends. On the laptop/web (no native engine) it falls back to more
// songs by the same artist and genre from the catalog.
import { fetchArtistTracks, fetchCategory, fetchTrendingSongs } from "../api/itunes";
import { getPlaylists } from "../library/playlists";
import { bus, trackRegistry } from "../state";
import type { Item } from "../types";
import { hasNativeAudio, nativeAudio } from "./native-audio";
import {
  appendToQueue,
  getCurrentTrackId,
  getQueueInfo,
  getRepeatMode,
  getUpcoming,
  isShuffleOn,
  playTrack,
  setAutoplayHandler,
  setQueue,
} from "./player";
import { storage } from "../utils";
import { mainArtist, playsSince, topSongs } from "../library/history";
import { getLikedPlaylist } from "../library/liked";
import { cachedFollowedSongs, getFollows } from "../library/follows";

interface RadioTrack {
  videoId: string;
  title: string;
  artist: string;
  durationSec: number;
  artwork: string | null;
}

let fetching = false;
let seedName: string | null = null;

export function isRadioOn(): boolean {
  return getQueueInfo().source === "radio";
}

export function getRadioSeed(): string | null {
  return isRadioOn() ? seedName : null;
}

// --- Turning YouTube titles into song names ---------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanArtist(name: string): string {
  return name
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s+Official$/i, "")
    .trim();
}

/** "Imagine Dragons - Demons (Official Music Video)" → "Demons". */
export function cleanTitle(title: string, artist: string): string {
  let s = title
    .replace(/\s*[([][^)\]]*(official|lyric|audio|video|visuali[sz]er|hd|4k|remaster)[^)\]]*[)\]]/gi, "")
    .replace(/\s*\|.*$/, "")
    .trim();
  if (artist) s = s.replace(new RegExp(`^${escapeRegex(artist)}\\s*[-–—:]\\s*`, "i"), "");
  // "Alok & Alan Walker - Headlights", "Alan Walker, Sabrina Carpenter - On My Way":
  // the part before " - " is the artists when it mentions this artist.
  const dash = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash && artist && sameArtist(dash[1], artist)) s = dash[2].trim();
  return s || title;
}

const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Does "Alok & Alan Walker" mention "Alan Walker and Alok" (or vice versa)? */
function sameArtist(credits: string, artist: string): boolean {
  const a = artist.split(/,|&| and | x | feat\.? /i).map(normName).filter((x) => x.length > 2);
  const c = normName(credits);
  return a.some((name) => c.includes(name));
}

/** Short name for a song: without "(with …)", "(feat. …)", "[Remix]". */
export function shortTitle(name: string): string {
  return name.replace(/\s*[([][^)\]]*[)\]]/g, "").trim() || name;
}

/** Channels that aren't the artist's name. */
const CHANNEL_ALIASES: Record<string, string> = { bangtantv: "BTS", "bts official": "BTS", blackpinkofficial: "BLACKPINK" };

/** "ImagineDragons" → "Imagine Dragons"; known channels → the artist. */
function channelToArtist(channel: string): string {
  const alias = CHANNEL_ALIASES[channel.toLowerCase()];
  if (alias) return alias;
  if (!channel.includes(" ") && /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(channel)) return channel.replace(/([a-z])([A-Z])/g, "$1 $2");
  return channel;
}

/** "BTS (방탄소년단)" → "BTS"; "정국 (Jung Kook)" → "Jung Kook": the name in Latin letters. */
function latinName(name: string): string {
  const m = name.match(/^(.+?)\s*\((.+)\)$/);
  if (!m) return name.trim();
  const latin = (x: string) => (x.match(/[A-Za-z]/g)?.length ?? 0) / x.replace(/\s/g, "").length;
  return (latin(m[1]) >= latin(m[2]) ? m[1] : m[2]).trim();
}

/**
 * K-pop style video titles: "BTS (방탄소년단) 'Dynamite' Official MV" →
 * {artist: "BTS", title: "Dynamite"}. Only when a video keyword follows the
 * quotes (so "they don't know 'bout us" is left alone).
 */
function parseQuotedTitle(title: string): { artist: string; title: string } | null {
  const m = title.match(/^(.+?)\s*['‘’"“](.+?)['‘’"”]\s*(?:official|m\/?v\b|music video|performance|special video|visuali[sz]er|lyric|teaser)/i);
  return m ? { artist: latinName(m[1]), title: m[2].trim() } : null;
}

export function toItem(t: RadioTrack): Item {
  const quoted = parseQuotedTitle(t.title || "");
  const artist = quoted?.artist || channelToArtist(cleanArtist(t.artist || ""));
  return {
    id: `yt-${t.videoId}`,
    name: quoted?.title || cleanTitle(t.title, artist),
    subtitle: artist,
    artwork: t.artwork,
    previewUrl: null,
    externalUrl: `https://music.youtube.com/watch?v=${t.videoId}`,
    topSubtitle: `Song · ${artist}`,
    durationMs: t.durationSec > 0 ? t.durationSec * 1000 : undefined,
  };
}

// --- Finding radio songs ----------------------------------------------------------

async function nativeRadioAfter(seed: Item): Promise<Item[]> {
  const videoId = seed.id.startsWith("yt-") ? seed.id.slice(3) : undefined;
  const { tracks } = await nativeAudio.radio({ key: seed.id, videoId });
  return tracks.map(toItem);
}

/** Without the native engine: same artist + same genre from the catalog. */
async function catalogRadioAfter(seed: Item): Promise<Item[]> {
  const jobs: Promise<Item[]>[] = [];
  if (seed.artistId) jobs.push(fetchArtistTracks(seed.artistId, 15));
  if (seed.genre) jobs.push(fetchCategory(seed.genre, "tracks", 15));
  if (!jobs.length) jobs.push(fetchCategory(seed.subtitle, "tracks", 15));
  const results = await Promise.allSettled(jobs);
  const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return items.filter((i) => i.id !== seed.id && i.previewUrl).sort(() => Math.random() - 0.5);
}

export async function radioAfter(seed: Item): Promise<Item[]> {
  if (hasNativeAudio) {
    try {
      const items = await nativeRadioAfter(seed);
      if (items.length) return items;
    } catch (err) {
      console.warn("Native radio failed, using the catalog:", err);
    }
  }
  return catalogRadioAfter(seed);
}

/** Start endless radio from a song (default: the one playing). */
export async function startRadio(seed?: Item): Promise<void> {
  const current = getCurrentTrackId();
  const item = seed ?? (current ? trackRegistry.get(current) : undefined);
  if (!item) return;
  bus.emit("toast", `📻 Starting radio from "${item.name}"…`);
  let items: Item[];
  try {
    items = mixInFavourites(await radioAfter(item), [item.id], true);
  } catch {
    items = [];
  }
  if (!items.length) {
    bus.emit("toast", "Couldn't find radio songs for this one");
    return;
  }
  items.forEach((i) => trackRegistry.set(i.id, i));
  trackRegistry.set(item.id, item);
  seedName = item.name;
  setQueue([item.id, ...items.map((i) => i.id)], item.id, "radio", `Radio · ${shortTitle(item.name)}`);
  if (getCurrentTrackId() !== item.id) await playTrack(item.id);
  bus.emit("toast", `📻 Radio based on "${item.name}"`);
}

/** Keep radio going: when 2 songs are left, add more from the last one. */
async function topUp(): Promise<void> {
  const { source, remaining, lastId } = getQueueInfo();
  if (source !== "radio" || remaining > 2 || fetching || !lastId) return;
  const last = trackRegistry.get(lastId);
  if (!last) return;
  fetching = true;
  try {
    const items = mixInFavourites(await radioAfter(last));
    items.forEach((i) => trackRegistry.set(i.id, i));
    if (getQueueInfo().source === "radio") appendToQueue(items.map((i) => i.id));
  } catch (err) {
    console.warn("Radio top-up failed:", err);
  } finally {
    fetching = false;
  }
}

// --- Your favourites, now and then --------------------------------------------------
// Like YouTube Music: every few radio/autoplay songs, one of yours — a liked
// song or one by an artist you follow. How often is up to you (Settings).

export type FavouriteMix = "off" | "rarely" | "sometimes";
/** One favourite after about this many radio songs. */
const EVERY: Record<FavouriteMix, number> = { off: 0, rarely: 12, sometimes: 6 };

export function getFavouriteMix(): FavouriteMix {
  const v = storage.get<string>("groov:favourite-mix", "rarely");
  return v === "off" || v === "rarely" || v === "sometimes" ? v : v === "often" ? "sometimes" : "rarely";
}

export function setFavouriteMix(mix: FavouriteMix): void {
  storage.set("groov:favourite-mix", mix);
}

/** Songs that were mixed in as favourites (Up next marks them ♥). */
export const favouriteIds = new Set<string>();
const recentlyMixed: string[] = [];
/** Radio songs since the last favourite (kept across top-ups, so the rhythm holds). */
let sinceFavourite = 0;
/** The next gap: `every`, give or take one, so it doesn't feel mechanical. */
let nextGap = 0;

function favouritePool(exclude: Set<string>): Item[] {
  const followed = getFollows().map((f) => f.name.toLowerCase());
  const byFollowed = (i: Item) => followed.includes(mainArtist(i.subtitle).toLowerCase());
  const liked = getLikedPlaylist()?.tracks ?? [];
  const top = topSongs(0, 300).map((s) => s.item);
  const recent = new Set(playsSince(Date.now() - 3600_000).map((e) => e[0])); // not in the last hour
  const seen = new Set<string>();
  const usable = (list: Item[]) =>
    list.filter((i) => {
      const key = normName(shortTitle(i.name));
      if (seen.has(key) || exclude.has(i.id) || recent.has(i.id) || recentlyMixed.includes(i.id)) return false;
      seen.add(key);
      return true;
    });
  const shuffle = (list: Item[]) => list.sort(() => Math.random() - 0.5);
  // Your picks first (liked songs, artists you follow), in random order…
  const pool = shuffle(usable([...liked, ...cachedFollowedSongs(), ...top.filter(byFollowed)]));
  // …and when there are too few, then your most-played songs and playlists.
  if (pool.length < 4) {
    const extra = [...topSongs(Date.now() - 60 * 86400_000, 60).filter((s) => s.plays >= 2).map((s) => s.item), ...librarySongs()];
    pool.push(...shuffle(usable(extra)));
  }
  return pool;
}

/**
 * Put one of your favourites in every so often (Settings). `fresh`: a new
 * radio is starting, so start counting again.
 */
export function mixInFavourites(items: Item[], alsoExclude: string[] = [], fresh = false): Item[] {
  const every = EVERY[getFavouriteMix()];
  if (!every || !items.length) return items;
  if (fresh) {
    sinceFavourite = 0;
    nextGap = 0;
  }
  const exclude = new Set([...getUpcoming(), getCurrentTrackId() ?? "", ...alsoExclude, ...items.map((i) => i.id)]);
  const names = new Set(items.map((i) => normName(shortTitle(i.name))));
  const pool = favouritePool(exclude).filter((i) => !names.has(normName(shortTitle(i.name))));
  if (!pool.length) return items;
  const out: Item[] = [];
  for (const item of items) {
    out.push(item);
    sinceFavourite++;
    if (!nextGap) nextGap = every - 1 + Math.floor(Math.random() * 3); // every ± 1
    if (sinceFavourite >= nextGap && pool.length) {
      const fav = pool.shift()!;
      trackRegistry.set(fav.id, fav);
      favouriteIds.add(fav.id);
      recentlyMixed.push(fav.id);
      if (recentlyMixed.length > 15) recentlyMixed.shift();
      out.push(fav);
      sinceFavourite = 0;
      nextGap = 0;
    }
  }
  return out;
}

// --- Surprise me / Shuffle my library ------------------------------------------------

export function librarySongs(): Item[] {
  const seen = new Map<string, Item>();
  for (const p of Object.values(getPlaylists())) for (const t of p.tracks) seen.set(t.id, t);
  return [...seen.values()];
}

/** A popular song you don't have yet, then endless radio from it. */
export async function surpriseMe(): Promise<void> {
  bus.emit("toast", "🎲 Picking something…");
  let chart: Item[];
  try {
    chart = await fetchTrendingSongs(100);
  } catch {
    bus.emit("toast", "Can't reach the charts right now");
    return;
  }
  const yours = new Set(librarySongs().map((t) => t.id));
  const fresh = chart.filter((t) => !yours.has(t.id));
  const pool = fresh.length ? fresh : chart;
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  chart.forEach((t) => trackRegistry.set(t.id, t));

  if (hasNativeAudio) {
    // Play it, then build radio around it (needs the song's YouTube match).
    setQueue([pick.id], pick.id);
    await playTrack(pick.id);
    await startRadio(pick);
  } else {
    const rest = pool.filter((t) => t.id !== pick.id).sort(() => Math.random() - 0.5);
    seedName = "Surprise me";
    setQueue([pick.id, ...rest.map((t) => t.id)], pick.id, "radio", "Surprise me");
    await playTrack(pick.id);
  }
}

/** Every song in all your playlists, in random order. */
export async function shuffleLibrary(): Promise<void> {
  const songs = librarySongs().sort(() => Math.random() - 0.5);
  if (!songs.length) {
    bus.emit("toast", "Add some songs to a playlist first");
    return;
  }
  songs.forEach((t) => trackRegistry.set(t.id, t));
  setQueue(
    songs.map((t) => t.id),
    songs[0].id,
    "list",
    "Shuffle · your library",
  );
  await playTrack(songs[0].id);
  bus.emit("toast", `🔀 Shuffling ${songs.length} songs from your playlists`);
}

/** Play a playlist: from the top, or from a random song if shuffle is on. */
export async function playPlaylist(playlistId: string): Promise<void> {
  const playlist = getPlaylists()[playlistId];
  if (!playlist?.tracks.length) return;
  const tracks = playlist.tracks;
  tracks.forEach((t) => trackRegistry.set(t.id, t));
  const start = isShuffleOn() ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[0];
  setQueue(
    tracks.map((t) => t.id),
    start.id,
    "list",
    playlist.name,
  );
  await playTrack(start.id);
}

// --- Autoplay -----------------------------------------------------------------------
// Like YouTube Music: when your list is nearly over, radio from its last song
// is fetched and shown in Up next under "Autoplay"; it plays after your list.
// Filter it with All / Familiar (songs you know) / Discover (new to you).
// Off in Settings, or with Repeat on.

export function isAutoplayOn(): boolean {
  return storage.get<boolean>("groov:autoplay", true);
}

export function setAutoplay(on: boolean): void {
  storage.set("groov:autoplay", on);
  bus.emit("queueupdate", undefined);
}

let preview: { seedId: string; seed: Item; items: Item[] } | null = null;
let previewLoading: string | null = null;
/** Last song a preview was tried for (don't retry in a loop when offline). */
let previewTriedFor: string | null = null;
const removed = new Set<string>();

/** Same song even when one copy came from iTunes and one from YouTube. */
const songKey = (i: Item) => `${normName(shortTitle(cleanTitle(i.name, i.subtitle)))}|${normName(i.subtitle).slice(0, 4)}`;

/** Songs that will autoplay after your list (already filtered). */
export function getAutoplayPreview(): { seed: Item; items: Item[] } | null {
  if (!preview || !autoplayApplies()) return null;
  const { lastId } = getQueueInfo();
  if (preview.seedId !== lastId) return null;
  const inQueue = new Set([...getUpcoming(), getCurrentTrackId()]);
  const items = preview.items.filter((i) => !removed.has(i.id) && !inQueue.has(i.id));
  return { seed: preview.seed, items };
}

export function isAutoplayLoading(): boolean {
  return previewLoading !== null;
}

export function removeFromAutoplay(id: string): void {
  removed.add(id);
  bus.emit("queueupdate", undefined);
}

function autoplayApplies(): boolean {
  return isAutoplayOn() && getQueueInfo().source === "list" && getRepeatMode() === "off";
}

/**
 * Radio that fits the whole list, not just its last song: YouTube Music's mix
 * after the last song and after the one before it, taken in turns. (One odd
 * last song — a feature, a remix — no longer decides everything.)
 */
async function radioForList(last: Item): Promise<Item[]> {
  const upcoming = getUpcoming();
  const beforeId = upcoming.length >= 2 ? upcoming[upcoming.length - 2] : getCurrentTrackId();
  const before = beforeId && beforeId !== last.id ? trackRegistry.get(beforeId) : undefined;
  const [a, b] = await Promise.all([
    radioAfter(last).catch(() => [] as Item[]),
    before ? radioAfter(before).catch(() => [] as Item[]) : Promise.resolve([] as Item[]),
  ]);
  const listKeys = new Set([...upcoming, getCurrentTrackId()].map((id) => id && trackRegistry.get(id)).filter(Boolean).map((i) => songKey(i as Item)));
  const seen = new Set<string>();
  const out: Item[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    for (const item of [a[i], b[i]]) {
      if (!item) continue;
      const key = songKey(item);
      if (seen.has(key) || listKeys.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  if (!out.length) throw new Error("no radio");
  return out.slice(0, 40);
}

/** Near the end of your list: get the autoplay songs ready. */
async function preparePreview(): Promise<void> {
  if (!autoplayApplies()) return;
  const { remaining, lastId } = getQueueInfo();
  if (remaining > 3 || !lastId || preview?.seedId === lastId || previewTriedFor === lastId) return;
  const seed = trackRegistry.get(lastId);
  if (!seed) return;
  previewLoading = lastId;
  previewTriedFor = lastId;
  bus.emit("queueupdate", undefined);
  try {
    const items = mixInFavourites(await radioForList(seed), [], true);
    items.forEach((i) => trackRegistry.set(i.id, i));
    preview = { seedId: lastId, seed, items };
    removed.clear();
  } catch {
    // offline: autoplay tries again when the list ends
  } finally {
    previewLoading = null;
    bus.emit("queueupdate", undefined);
  }
}

/** Play an autoplay song now: your list continues into autoplay from there. */
export async function playFromAutoplay(id: string): Promise<void> {
  const shown = getAutoplayPreview();
  if (!shown) return;
  const index = shown.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  const label = `Radio · ${shortTitle(shown.seed.name)}`;
  const current = getCurrentTrackId();
  const ids = shown.items.slice(index).map((i) => i.id);
  setQueue(current ? [current, ...ids] : ids, current ?? ids[0], "radio", label);
  seedName = shown.seed.name;
  preview = null;
  await playTrack(id);
}

let autoplaying = false;

/** The list ended: carry on with the autoplay songs. */
async function autoplay(): Promise<boolean> {
  const current = getCurrentTrackId();
  const item = current ? trackRegistry.get(current) : undefined;
  if (!isAutoplayOn() || !item || autoplaying) return false;
  autoplaying = true;
  try {
    let items = getAutoplayPreview()?.items;
    if (!items?.length) {
      bus.emit("toast", `📻 Autoplay: more like "${item.name}"…`);
      items = mixInFavourites((await radioAfter(item)).filter((i) => i.id !== item.id), [item.id], true);
    }
    if (!items.length || getCurrentTrackId() !== item.id) return false;
    items.forEach((i) => trackRegistry.set(i.id, i));
    seedName = item.name;
    setQueue([item.id, ...items.map((i) => i.id)], item.id, "radio", `Radio · ${shortTitle(item.name)}`);
    preview = null;
    return true;
  } catch {
    bus.emit("toast", "Nothing more to play");
    return false;
  } finally {
    autoplaying = false;
  }
}

export function initRadio(): void {
  bus.on("trackchange", () => void topUp());
  bus.on("trackchange", () => void preparePreview());
  bus.on("queueupdate", () => void preparePreview());
  bus.on("modechange", () => bus.emit("queueupdate", undefined));
  setAutoplayHandler(autoplay);
}
