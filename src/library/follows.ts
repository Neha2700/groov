// Artists you follow. Kept on the phone (works signed out/offline) and
// synced to the account (the `follows` table, supabase/003_follows.sql).
import { supabase } from "../cloud/client";
import { getAccount } from "../cloud/session";
import { bus } from "../state";
import { storage } from "../utils";
import { fetchArtistTracks, findArtistId } from "../api/itunes";
import type { Item } from "../types";

export interface FollowedArtist {
  key: string;
  id?: number;
  name: string;
  artwork?: string | null;
  at: number;
}

type Pending = { op: "add"; artist: FollowedArtist } | { op: "remove"; key: string };

const KEY = "groov:follows";
const PENDING_KEY = "groov:follows-pending";

let follows: FollowedArtist[] = storage.get<FollowedArtist[]>(KEY, []);

export function artistKey(id: number | null | undefined, name: string): string {
  return id ? `id:${id}` : `name:${name.trim().toLowerCase()}`;
}

function save(): void {
  storage.set(KEY, follows);
  bus.emit("followchange", undefined);
}

export function getFollows(): FollowedArtist[] {
  return [...follows].sort((a, b) => b.at - a.at);
}

export function isFollowing(id: number | null | undefined, name: string): boolean {
  const k = artistKey(id, name);
  const n = name.trim().toLowerCase();
  return follows.some((f) => f.key === k || f.name.toLowerCase() === n);
}

/** Follow or unfollow. Returns true when now following. */
export function toggleFollow(artist: { id?: number | null; name: string; artwork?: string | null }): boolean {
  const n = artist.name.trim().toLowerCase();
  const existing = follows.find((f) => f.key === artistKey(artist.id, artist.name) || f.name.toLowerCase() === n);
  if (existing) {
    follows = follows.filter((f) => f !== existing);
    queue({ op: "remove", key: existing.key });
    save();
    bus.emit("toast", `Unfollowed ${existing.name}`);
    return false;
  }
  const followed: FollowedArtist = {
    key: artistKey(artist.id, artist.name),
    id: artist.id ?? undefined,
    name: artist.name,
    artwork: artist.artwork ?? null,
    at: Date.now(),
  };
  follows.push(followed);
  queue({ op: "add", artist: followed });
  save();
  bus.emit("toast", `✓ Following ${artist.name}`);
  return true;
}

// --- Account sync -----------------------------------------------------------------

function queue(p: Pending): void {
  if (!getAccount()) return;
  storage.set(PENDING_KEY, [...storage.get<Pending[]>(PENDING_KEY, []), p]);
  void flush();
}

let flushing = false;

async function flush(): Promise<boolean> {
  if (flushing || !getAccount()) return false;
  flushing = true;
  try {
    let pending = storage.get<Pending[]>(PENDING_KEY, []);
    while (pending.length) {
      const p = pending[0];
      const { error } =
        p.op === "add"
          ? await supabase
              .from("follows")
              .upsert({ artist_key: p.artist.key, artist: p.artist }, { onConflict: "user_id,artist_key" })
          : await supabase.from("follows").delete().eq("artist_key", p.key);
      if (error) return false; // offline, or table not created yet: try later
      pending = pending.slice(1);
      storage.set(PENDING_KEY, pending);
    }
    return true;
  } catch {
    return false;
  } finally {
    flushing = false;
  }
}

async function pull(): Promise<void> {
  const { data, error } = await supabase.from("follows").select("artist");
  if (error || !data) return;
  follows = (data as { artist: FollowedArtist }[]).map((r) => r.artist).filter((a) => a?.name);
  save();
}

const MIGRATED_KEY = "groov:follows-migrated";

async function onSignIn(): Promise<void> {
  const me = getAccount();
  if (!me) return;
  // First sign-in on this phone: send up artists followed while signed out.
  if (storage.get<string | null>(MIGRATED_KEY, null) !== me.id) {
    const local = follows.map((artist) => ({ op: "add", artist }) as Pending);
    storage.set(PENDING_KEY, [...local, ...storage.get<Pending[]>(PENDING_KEY, [])]);
  }
  if (await flush()) {
    storage.set(MIGRATED_KEY, me.id);
    await pull();
  }
}

export function initFollows(): void {
  bus.on("authchange", (account) => {
    if (account) void onSignIn();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getAccount()) void flush().then((ok) => {
        if (ok) void pull();
      });
  });
}

// --- Songs by the artists you follow (for Home and for radio) ----------------------

const SONGS_KEY = "groov:follows-songs";
type SongsCache = { day: number; keys: string; songs: Item[] };
const today = () => Math.floor(Date.now() / 86400000);

/** Songs from followed artists fetched today (empty until loaded once). */
export function cachedFollowedSongs(): Item[] {
  return storage.get<SongsCache | null>(SONGS_KEY, null)?.songs ?? [];
}

let loading: Promise<Item[]> | null = null;

/** A few popular songs from each artist you follow, taken in turns. Daily. */
export function loadFollowedSongs(): Promise<Item[]> {
  const keys = follows.map((f) => f.key).sort().join(",");
  const hit = storage.get<SongsCache | null>(SONGS_KEY, null);
  if (hit && hit.day === today() && hit.keys === keys) return Promise.resolve(hit.songs);
  if (!follows.length) return Promise.resolve([]);
  loading ??= (async () => {
    const artists = getFollows().slice(0, 8);
    const lists = await Promise.all(
      artists.map(async (a) => {
        try {
          const id = a.id || (await findArtistId(a.name));
          return id ? (await fetchArtistTracks(id, 12)).slice(0, 6) : [];
        } catch {
          return [] as Item[];
        }
      }),
    );
    const songs: Item[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      for (const list of lists) {
        const s = list[i];
        if (s && !seen.has(s.name.toLowerCase())) {
          seen.add(s.name.toLowerCase());
          songs.push(s);
        }
      }
    }
    if (songs.length) storage.set(SONGS_KEY, { day: today(), keys, songs });
    return songs;
  })().finally(() => (loading = null));
  return loading;
}
