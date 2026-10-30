// Who's online and what they're playing, via Supabase Realtime presence.
// Nothing is stored: it's live state that disappears when the app closes.
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSnapshot } from "../player/player";
import { bus } from "../state";
import type { Item } from "../types";
import { supabase } from "./client";
import { getAccount, type Account } from "./session";

export interface FriendStatus {
  id: string;
  name: string;
  /** What they're playing (enough to play it too). */
  track: Item | null;
  playing: boolean;
  /** Whose music they're listening along to, if anyone's. */
  listeningTo: string | null;
  at: number;
}

let channel: RealtimeChannel | null = null;
let friends: FriendStatus[] = [];
let listeningTo: string | null = null;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

export function getFriends(): FriendStatus[] {
  return friends;
}

/** Called by jam.ts so friends can see "listening along with …". */
export function setListeningTo(hostId: string | null): void {
  listeningTo = hostId;
  scheduleUpdate(0);
}

function myStatus(me: Account): FriendStatus {
  const s = getSnapshot();
  const track = s.item
    ? (({ id, name, subtitle, artwork, previewUrl, topSubtitle, artistId, genre, durationMs }) => ({
        id, name, subtitle, artwork, previewUrl, topSubtitle, artistId, genre, durationMs,
      }))(s.item)
    : null;
  return { id: me.id, name: me.name, track, playing: s.playing, listeningTo, at: Date.now() };
}

/** Groov in the background with nothing playing: not really "online". */
function isAway(): boolean {
  return document.visibilityState === "hidden" && !getSnapshot().playing;
}

function scheduleUpdate(delay = 800): void {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    const me = getAccount();
    if (!me || !channel) return;
    if (isAway()) void channel.untrack();
    else void channel.track(myStatus(me));
  }, delay);
}

function join(me: Account): void {
  leave();
  channel = supabase.channel("groov-online", { config: { presence: { key: me.id } } });
  channel
    .on("presence", { event: "sync" }, () => {
      const state = channel!.presenceState<FriendStatus>();
      friends = Object.entries(state)
        .filter(([id]) => id !== me.id)
        .map(([, metas]) => metas.sort((a, b) => b.at - a.at)[0])
        .filter((f): f is FriendStatus & { presence_ref: string } => Boolean(f))
        .map(({ id, name, track, playing, listeningTo: lt, at }) => ({ id, name, track, playing, listeningTo: lt, at }));
      bus.emit("friendschange", friends);
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") scheduleUpdate(0);
    });
}

function leave(): void {
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  friends = [];
  bus.emit("friendschange", friends);
}

export function initPresence(): void {
  bus.on("authchange", (me) => (me ? join(me) : leave()));
  bus.on("trackchange", () => scheduleUpdate());
  bus.on("playstate", () => scheduleUpdate());
  // Back in the app: shown as online again. Left with music paused: hidden
  // from friends after a short while (playing in the background still counts).
  document.addEventListener("visibilitychange", () => {
    scheduleUpdate(document.visibilityState === "visible" ? 0 : 20000);
  });
}
