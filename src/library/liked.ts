// ❤️ Liked songs. Kept as a special playlist named "Liked Songs", so it
// syncs to the account (and across phones) through the normal playlist sync,
// with no extra database tables.
import { bus } from "../state";
import type { Item, Playlist } from "../types";
import { addTrackToPlaylist, createPlaylist, getPlaylists, isOwner, removeTrackFromPlaylist } from "./playlists";

export const LIKED_NAME = "Liked Songs";

export function isLikedPlaylist(p: Playlist): boolean {
  return p.name === LIKED_NAME && isOwner(p);
}

export function getLikedPlaylist(): Playlist | null {
  return Object.values(getPlaylists()).find(isLikedPlaylist) ?? null;
}

export function isLiked(trackId: string): boolean {
  return getLikedPlaylist()?.tracks.some((t) => t.id === trackId) ?? false;
}

export function toggleLike(item: Item): boolean {
  const liked = getLikedPlaylist();
  if (liked && liked.tracks.some((t) => t.id === item.id)) {
    removeTrackFromPlaylist(liked.id, item.id);
    bus.emit("likechange", undefined);
    bus.emit("toast", "Removed from Liked Songs");
    return false;
  }
  const id = liked?.id ?? createPlaylist(LIKED_NAME);
  addTrackToPlaylist(id, item);
  bus.emit("likechange", undefined);
  bus.emit("toast", "❤️ Added to Liked Songs");
  return true;
}
