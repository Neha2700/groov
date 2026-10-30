// Download playlists for offline (Android). The songs stay on the phone and
// are never removed to make room; songs added later download too.
import { hasNativeAudio, nativeAudio, toNativeTrack } from "../player/native-audio";
import { bus } from "../state";
import type { Playlist } from "../types";
import { storage } from "../utils";
import { fillAllMissingArtwork, fillMissingArtwork, getPlaylists } from "./playlists";

const KEY = "groov:downloaded-playlists";

let downloadedPlaylists = new Set<string>(storage.get<string[]>(KEY, []));
/** Songs on the phone for offline. */
const done = new Set<string>();
/** Songs waiting to download. */
const pending = new Set<string>();
const failed = new Set<string>();

export const canDownload = hasNativeAudio;

export function isPlaylistDownloaded(id: string): boolean {
  return downloadedPlaylists.has(id);
}

export function isSongDownloaded(trackId: string): boolean {
  return done.has(trackId);
}

/** {done, total, failed} for a playlist's songs. */
export function playlistProgress(p: Playlist): { done: number; total: number; failed: number } {
  return {
    done: p.tracks.filter((t) => done.has(t.id)).length,
    total: p.tracks.length,
    failed: p.tracks.filter((t) => failed.has(t.id)).length,
  };
}

function saveSet(): void {
  storage.set(KEY, [...downloadedPlaylists]);
}

/** Songs that some downloaded playlist still wants. */
function wanted(): Set<string> {
  const playlists = getPlaylists();
  const ids = new Set<string>();
  for (const pid of downloadedPlaylists) for (const t of playlists[pid]?.tracks ?? []) ids.add(t.id);
  return ids;
}

function downloadMissing(): void {
  const playlists = getPlaylists();
  const tracks = new Map<string, ReturnType<typeof toNativeTrack>>();
  for (const pid of downloadedPlaylists) {
    for (const t of playlists[pid]?.tracks ?? []) {
      if (!done.has(t.id) && !pending.has(t.id) && !failed.has(t.id)) tracks.set(t.id, toNativeTrack(t));
    }
  }
  if (!tracks.size) return;
  tracks.forEach((_, id) => pending.add(id));
  void nativeAudio.download({ tracks: [...tracks.values()] }).catch(() => tracks.forEach((_, id) => pending.delete(id)));
  bus.emit("downloadchange", undefined);
}

export function downloadPlaylist(id: string): void {
  if (!canDownload) return;
  downloadedPlaylists.add(id);
  saveSet();
  failed.clear();
  downloadMissing();
  bus.emit("downloadchange", undefined);
}

export function removePlaylistDownload(id: string): void {
  downloadedPlaylists.delete(id);
  saveSet();
  // Songs no other downloaded playlist has can make room again.
  const keep = wanted();
  const drop = (getPlaylists()[id]?.tracks ?? []).map((t) => t.id).filter((tid) => !keep.has(tid));
  drop.forEach((tid) => done.delete(tid));
  if (drop.length) void nativeAudio.removeDownloads({ keys: drop }).catch(() => undefined);
  bus.emit("downloadchange", undefined);
}

async function refreshState(): Promise<void> {
  const keys = [...wanted()];
  if (!keys.length) return;
  try {
    const { downloaded } = await nativeAudio.downloadState({ keys });
    downloaded.forEach((k) => done.add(k));
  } catch {
    // older app version: nothing to show
  }
  bus.emit("downloadchange", undefined);
}

/** Retry songs that failed (e.g. no internet at the time). */
export function retryFailed(): void {
  failed.clear();
  downloadMissing();
}

export function initDownloads(): void {
  if (!canDownload) return;
  void nativeAudio.addListener("download", ({ key, ok, videoId }) => {
    pending.delete(key);
    if (ok) done.add(key);
    if (ok && videoId) fillMissingArtwork(key, videoId);
    else failed.add(key);
    bus.emit("downloadchange", undefined);
  });
  // Playlists changed (songs added, or a downloaded playlist deleted).
  bus.on("playlistschange", () => {
    const playlists = getPlaylists();
    const before = downloadedPlaylists.size;
    downloadedPlaylists = new Set([...downloadedPlaylists].filter((id) => playlists[id]));
    if (downloadedPlaylists.size !== before) saveSet();
    downloadMissing();
  });
  window.addEventListener("online", retryFailed);
  // Pictures for imported songs played before (now, and after each sync).
  const fill = () => void fillAllMissingArtwork((keys) => nativeAudio.videoIds({ keys }).then((r) => r.ids));
  setTimeout(fill, 5000);
  let fillTimer = 0;
  bus.on("playlistschange", () => {
    clearTimeout(fillTimer);
    fillTimer = window.setTimeout(fill, 3000);
  });
  void refreshState().then(downloadMissing);
}
