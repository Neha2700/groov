// Playlists live on the phone (localStorage) as full track snapshots, so
// they work offline and stay playable after a reload. When signed in, every
// change is also queued for the account (cloud/outbox.ts) and synced
// (cloud/sync.ts); the copy on the phone is then a cache of the account.
import { KEYS } from "../config";
import { enqueue } from "../cloud/outbox";
import { getAccount, isSignedIn } from "../cloud/session";
import { bus } from "../state";
import type { Item, Playlist, Playlists } from "../types";
import { storage } from "../utils";

export function getPlaylists(): Playlists {
  return storage.get<Playlists>(KEYS.playlists, {});
}

function save(playlists: Playlists): void {
  storage.set(KEYS.playlists, playlists);
  bus.emit("playlistschange", undefined);
}

/** Replace everything (used by sync after downloading from the account). */
export function replacePlaylists(playlists: Playlists): void {
  // Keep pictures this phone already found (e.g. for songs from Spotify),
  // in case the account's copy doesn't have them yet.
  const pictures = new Map<string, string>();
  for (const p of Object.values(getPlaylists())) for (const t of p.tracks) if (t.artwork) pictures.set(t.id, t.artwork);
  for (const p of Object.values(playlists)) {
    for (const t of p.tracks) if (!t.artwork && pictures.has(t.id)) t.artwork = pictures.get(t.id)!;
  }
  save(playlists);
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // RFC 4122 v4 fallback for old WebViews
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
  );
}

export function isOwner(playlist: Playlist): boolean {
  return !playlist.cloud || !playlist.ownerId || playlist.ownerId === getAccount()?.id;
}

/** Plain track info for storing: no playback-only fields. */
function snapshot(item: Item): Item {
  const { id, name, subtitle, artwork, previewUrl, externalUrl, topSubtitle, artistId, genre, durationMs } = item;
  return { id, name, subtitle, artwork, previewUrl, externalUrl, topSubtitle, artistId, genre, durationMs };
}

export function createPlaylist(name: string): string {
  const playlists = getPlaylists();
  const id = newId();
  const account = getAccount();
  const cleanName = name.trim().slice(0, 100) || "New Playlist";
  playlists[id] = {
    id,
    name: cleanName,
    tracks: [],
    cloud: isSignedIn(),
    ownerId: account?.id,
    ownerName: account?.name,
  };
  save(playlists);
  enqueue({ type: "createPlaylist", id, name: cleanName });
  return id;
}

/** Owners delete; people it was shared with leave it instead. */
export function deletePlaylist(id: string): void {
  const playlists = getPlaylists();
  const playlist = playlists[id];
  if (!playlist) return;
  delete playlists[id];
  save(playlists);
  if (playlist.cloud) enqueue(isOwner(playlist) ? { type: "deletePlaylist", id } : { type: "leavePlaylist", id });
}

export function addTrackToPlaylist(playlistId: string, item: Item): void {
  const playlists = getPlaylists();
  const playlist = playlists[playlistId];
  if (!playlist || playlist.tracks.some((t) => t.id === item.id)) return;
  const track = snapshot(item);
  playlist.tracks.push(track);
  const account = getAccount();
  if (playlist.shared && account) {
    playlist.addedBy = { ...playlist.addedBy, [track.id]: { id: account.id, name: account.name } };
  }
  save(playlists);
  if (playlist.cloud) enqueue({ type: "addTrack", playlistId, track, position: Date.now() });
}

export function removeTrackFromPlaylist(playlistId: string, trackId: string): void {
  const playlists = getPlaylists();
  const playlist = playlists[playlistId];
  if (!playlist) return;
  playlist.tracks = playlist.tracks.filter((t) => t.id !== trackId);
  save(playlists);
  if (playlist.cloud) enqueue({ type: "removeTrack", playlistId, trackKey: trackId });
}

/**
 * Songs imported without a picture (from Spotify): once YouTube knows the
 * song, use the video's thumbnail. Saved on this phone.
 */
export function fillMissingArtwork(trackId: string, videoId: string): string | null {
  const url = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const playlists = getPlaylists();
  let changed = false;
  for (const p of Object.values(playlists)) {
    for (const t of p.tracks) {
      if (t.id === trackId && !t.artwork) {
        t.artwork = url;
        changed = true;
        // …and in the account, so other devices (and the next sync) have it.
        if (p.cloud) enqueue({ type: "updateTrack", playlistId: p.id, track: t });
      }
    }
  }
  if (changed) save(playlists);
  return changed ? url : null;
}

/** Rename (owner only). Returns false if not allowed. */
export function renamePlaylist(id: string, name: string): boolean {
  const playlists = getPlaylists();
  const playlist = playlists[id];
  const clean = name.trim().slice(0, 100);
  if (!playlist || !clean || !isOwner(playlist)) return false;
  playlist.name = clean;
  save(playlists);
  if (playlist.cloud) enqueue({ type: "renamePlaylist", id, name: clean });
  return true;
}

/** Fill in pictures for every song the phone has already matched (Android). */
export async function fillAllMissingArtwork(lookup: (keys: string[]) => Promise<Record<string, string>>): Promise<void> {
  const missing = [...new Set(Object.values(getPlaylists()).flatMap((p) => p.tracks.filter((t) => !t.artwork).map((t) => t.id)))];
  if (!missing.length) return;
  const ids = await lookup(missing).catch(() => ({}) as Record<string, string>);
  for (const [trackId, videoId] of Object.entries(ids)) fillMissingArtwork(trackId, videoId);
}
