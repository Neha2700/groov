// What you've listened to, for Stats and "Made for you".
// Kept on the phone (works signed out and offline). A song counts as a play
// once it has played 30 seconds; the time you actually listen is added up
// too. When signed in, plays are also saved to the account (play_history),
// and a new phone pulls them down once.
import { supabase } from "../cloud/client";
import { enqueue } from "../cloud/outbox";
import { getAccount } from "../cloud/session";
import { bus } from "../state";
import type { Item } from "../types";
import { storage } from "../utils";

/** [track id, played at (ms), seconds listened] */
type Entry = [string, number, number];

const ENTRIES_KEY = "groov:history";
const TRACKS_KEY = "groov:history-tracks";
const PULLED_KEY = "groov:history-pulled";
const MAX_ENTRIES = 5000;
const COUNT_AFTER = 30;

let entries: Entry[] = storage.get<Entry[]>(ENTRIES_KEY, []);
let tracks: Record<string, Item> = storage.get<Record<string, Item>>(TRACKS_KEY, {});

function slim(item: Item): Item {
  const { id, name, subtitle, artwork, artistId, genre, durationMs, previewUrl, collectionId } = item;
  return { id, name, subtitle, artwork, artistId, genre, durationMs, previewUrl, collectionId, topSubtitle: "" } as Item;
}

function save(): void {
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  // Forget song details nothing refers to any more.
  const used = new Set(entries.map((e) => e[0]));
  for (const id of Object.keys(tracks)) if (!used.has(id)) delete tracks[id];
  storage.set(ENTRIES_KEY, entries);
  storage.set(TRACKS_KEY, tracks);
}

// --- Recording ------------------------------------------------------------------

let current: Item | null = null;
let listened = 0; // seconds of this play so far
let lastTime = 0;
let entry: Entry | null = null; // this play, once it counts
let unsaved = 0;

function startPlay(item: Item | null): void {
  if (entry && unsaved) save();
  current = item;
  listened = 0;
  lastTime = 0;
  entry = null;
  unsaved = 0;
}

function onProgress(currentTime: number): void {
  if (!current) return;
  // Back at the start after a long way in: repeat-one, so a new play.
  if (currentTime < 5 && lastTime > COUNT_AFTER && entry) startPlay(current);
  const delta = currentTime - lastTime;
  lastTime = currentTime;
  if (delta <= 0 || delta > 3) return; // paused, or a seek
  listened += delta;
  if (entry) {
    entry[2] = Math.round(listened);
    unsaved += delta;
    if (unsaved >= 15) {
      unsaved = 0;
      save();
    }
    return;
  }
  if (listened < COUNT_AFTER) return;
  entry = [current.id, Date.now() - listened * 1000, Math.round(listened)];
  tracks[current.id] = slim(current);
  entries.push(entry);
  save();
  enqueue({ type: "logPlay", track: slim(current), playedAt: new Date(entry[1]).toISOString() });
  bus.emit("historychange", undefined);
}

// --- First sign-in on a phone: bring down plays from the account ------------

async function pullFromAccount(): Promise<void> {
  const me = getAccount();
  if (!me || storage.get<string | null>(PULLED_KEY, null) === me.id) return;
  const { data, error } = await supabase
    .from("play_history")
    .select("track_key, track, played_at")
    .order("played_at", { ascending: false })
    .limit(MAX_ENTRIES);
  if (error || !data) return;
  const have = new Set(entries.map((e) => `${e[0]}@${Math.round(e[1] / 60000)}`));
  let added = 0;
  for (const row of data as { track_key: string; track: Item; played_at: string }[]) {
    const at = Date.parse(row.played_at);
    const key = Math.round(at / 60000);
    if (!row.track?.name || have.has(`${row.track_key}@${key}`) || have.has(`${row.track_key}@${key - 1}`)) continue;
    const secs = row.track.durationMs ? Math.round(row.track.durationMs / 1000) : 180;
    entries.push([row.track_key, at, secs]);
    tracks[row.track_key] = { ...row.track, id: row.track_key };
    added++;
  }
  entries.sort((a, b) => a[1] - b[1]);
  save();
  storage.set(PULLED_KEY, me.id);
  if (added) bus.emit("historychange", undefined);
}

export function initHistory(): void {
  bus.on("trackchange", (item) => startPlay(item));
  bus.on("progress", ({ currentTime }) => onProgress(currentTime));
  bus.on("authchange", (account) => {
    if (account) void pullFromAccount().catch(() => undefined);
  });
  window.addEventListener("pagehide", () => entry && save());
}

// --- Reading ---------------------------------------------------------------------

export interface SongStat {
  item: Item;
  plays: number;
  seconds: number;
  lastPlayed: number;
}

export interface ArtistStat {
  name: string;
  artistId?: number;
  plays: number;
  seconds: number;
  artwork?: string | null;
}

/** "Arijit Singh, Shreya Ghoshal" and "A feat. B" count for the first artist. */
export function mainArtist(subtitle: string): string {
  return subtitle.split(/,|&| feat\.? | ft\.? | x |\(/i)[0].trim() || subtitle;
}

export function playsSince(since: number): Entry[] {
  return entries.filter((e) => e[1] >= since && tracks[e[0]]);
}

export function totalsSince(since: number): { plays: number; minutes: number; songs: number; artists: number } {
  const list = playsSince(since);
  const seconds = list.reduce((sum, e) => sum + e[2], 0);
  return {
    plays: list.length,
    minutes: Math.round(seconds / 60),
    songs: new Set(list.map((e) => e[0])).size,
    artists: new Set(list.map((e) => mainArtist(tracks[e[0]].subtitle).toLowerCase())).size,
  };
}

export function topSongs(since: number, limit = 10, until = Infinity): SongStat[] {
  const byId = new Map<string, SongStat>();
  for (const [id, at, secs] of entries) {
    if (at < since || at >= until || !tracks[id]) continue;
    const s = byId.get(id) ?? { item: tracks[id], plays: 0, seconds: 0, lastPlayed: 0 };
    s.plays++;
    s.seconds += secs;
    s.lastPlayed = Math.max(s.lastPlayed, at);
    byId.set(id, s);
  }
  return [...byId.values()].sort((a, b) => b.plays - a.plays || b.seconds - a.seconds).slice(0, limit);
}

export function topArtists(since: number, limit = 10): ArtistStat[] {
  const byName = new Map<string, ArtistStat>();
  for (const [id, at, secs] of entries) {
    if (at < since || !tracks[id]) continue;
    const t = tracks[id];
    const name = mainArtist(t.subtitle);
    const key = name.toLowerCase();
    const a = byName.get(key) ?? { name, plays: 0, seconds: 0, artwork: t.artwork };
    a.plays++;
    a.seconds += secs;
    if (!a.artistId && t.artistId && t.subtitle === name) a.artistId = t.artistId;
    if (!a.artwork) a.artwork = t.artwork;
    byName.set(key, a);
  }
  return [...byName.values()].sort((a, b) => b.plays - a.plays || b.seconds - a.seconds).slice(0, limit);
}

/** Distinct songs, most recent first. */
export function recentlyPlayed(limit = 12): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const id = entries[i][0];
    if (seen.has(id) || !tracks[id]) continue;
    seen.add(id);
    out.push(tracks[id]);
  }
  return out;
}

export function historySize(): number {
  return entries.length;
}

export function clearHistory(): void {
  const me = getAccount();
  if (me) void supabase.from("play_history").delete().eq("user_id", me.id).then(() => undefined);
  entries = [];
  tracks = {};
  save();
  bus.emit("historychange", undefined);
}
