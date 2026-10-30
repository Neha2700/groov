import type { Item } from "./types";
import type { Account } from "./cloud/session";
import type { SyncStatus } from "./cloud/sync";
import type { FriendStatus } from "./cloud/presence";
import type { JamInfo } from "./cloud/jam";
import type { Engine, QueueSource } from "./player/player";
import { createEmitter } from "./utils";

/** Every track rendered anywhere, by id, so play buttons can look them up. */
export const trackRegistry = new Map<string, Item>();

export function registerTrack(item: Item): void {
  trackRegistry.set(item.id, item);
}

/** App-wide events. Modules subscribe instead of importing each other. */
export const bus = createEmitter<{
  /** A new track was loaded into the player. */
  trackchange: Item;
  /** Playback started (true) or paused/stopped (false). */
  playstate: boolean;
  progress: { currentTime: number; duration: number };
  /** The user jumped to a new position. */
  seeked: void;
  /** The current track's length became known (seconds). */
  durationchange: number;
  /** Switched between the native player, YouTube player and 30s preview. */
  enginechange: Engine;
  /** A song is being found/downloaded before it can start. */
  loading: boolean;
  /** "Show video" gave up (the video wouldn't start); stay on audio. */
  videounavailable: void;
  /** Playlists were created, edited or deleted. */
  playlistschange: void;
  /** Signed in (the account) or out (null). */
  authchange: Account | null;
  /** A change was queued for the account. */
  outbox: void;
  syncstatus: SyncStatus;
  /** Who's online and what they're playing. */
  friendschange: FriendStatus[];
  /** Listening along with someone / people listening along with me. */
  jamchange: JamInfo;
  /** A short message at the bottom of the screen. */
  toast: string;
  /** A new list started playing (from a list, or radio). */
  queuechange: { source: QueueSource; remaining: number };
  /** Shuffle or repeat changed. */
  modechange: void;
  /** The upcoming songs changed (queued, reordered, removed, advanced). */
  queueupdate: void;
  /** A song was liked or unliked. */
  likechange: void;
  /** A play was counted (or history pulled / cleared). */
  historychange: void;
  /** The sleep timer was set, ticked or ended. */
  sleepchange: void;
  /** Made for you mixes changed (new day, songs fetched). */
  mixchange: void;
  /** The YouTube key arrived from (or was saved to) the account. */
  youtubekeychange: void;
  /** An artist was followed or unfollowed (or follows synced). */
  followchange: void;
  /** Offline downloads progressed or changed. */
  downloadchange: void;
  /** The playing song got a picture (it had none). */
  artworkchange: Item;
  /** YouTube looks broken for Groov (or fine again). */
  healthchange: void;
}>();
