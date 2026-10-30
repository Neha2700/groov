// Listen together: hear the same song at the same moment as a friend.
//
// Everyone signed in hosts a little live channel, "jam:<their id>". To listen
// along with Neha, you join hers. Messages go over Supabase Realtime
// broadcast (nothing is stored):
//   state    the song, position, playing/paused, and when it was sent
//   hello    a new listener asking for the current state
//   command  a listener pressed next/previous (the host's queue decides)
// Play, pause and seek work from either side. Drift is corrected with a
// heartbeat every few seconds while playing.
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  getCurrentTrackId,
  getDuration,
  getPosition,
  getSnapshot,
  isPlaying,
  pause,
  play,
  playItem,
  playNext,
  playPrevious,
  seekTo,
  setSkipInterceptor,
} from "../player/player";
import { bus } from "../state";
import type { Item } from "../types";
import { supabase } from "./client";
import { setListeningTo } from "./presence";
import type { Account } from "./session";

interface StateMsg {
  type: "state";
  from: string;
  track: Item | null;
  position: number;
  playing: boolean;
  at: number;
}
type JamMsg = StateMsg | { type: "hello"; from: string } | { type: "command"; from: string; cmd: "next" | "previous" };

export interface JamInfo {
  /** Listening along with this person (or null). */
  joined: { id: string; name: string } | null;
  /** People listening along with me. */
  listeners: { id: string; name: string }[];
}

const DRIFT_LIMIT = 2; // seconds of difference before we correct
const HEARTBEAT_MS = 8000;
const ECHO_WINDOW_MS = 1500;

let me: Account | null = null;
let ownChannel: RealtimeChannel | null = null;
let joined: { id: string; name: string; channel: RealtimeChannel } | null = null;
let listeners: { id: string; name: string }[] = [];
let lastRemoteAt = 0;
/** Ignore our own events for a moment after applying a remote change. */
let suppressUntil = 0;
/** A remote song is loading; finish syncing when it starts. */
let pendingSync: StateMsg | null = null;
let loading = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
/** Waiting for the host's first answer after "Listen along". */
let answerTimer: ReturnType<typeof setTimeout> | undefined;
const ANSWER_MS = 10000;
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;

export function getJamInfo(): JamInfo {
  return { joined: joined ? { id: joined.id, name: joined.name } : null, listeners };
}

function emitChange(): void {
  bus.emit("jamchange", getJamInfo());
}

/** The channel we talk on: the host's when listening along, else ours if anyone's listening. */
function activeChannel(): RealtimeChannel | null {
  if (joined) return joined.channel;
  return listeners.length ? ownChannel : null;
}

function send(channel: RealtimeChannel | null, msg: JamMsg): void {
  if (channel) void channel.send({ type: "broadcast", event: "jam", payload: msg });
}

function currentState(): StateMsg {
  const s = getSnapshot();
  return { type: "state", from: me!.id, track: s.item ?? null, position: s.position, playing: s.playing, at: Date.now() };
}

/** Tell the others what we're doing (skipped while applying their change). */
function broadcastState(force = false): void {
  if (!me) return;
  if (!force && (Date.now() < suppressUntil || pendingSync || loading)) return;
  send(activeChannel(), currentState());
}

function scheduleBroadcast(): void {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => broadcastState(), 400);
}

// --- Applying the other side's state ------------------------------------------------

function expectedPosition(msg: StateMsg): number {
  return msg.position + (msg.playing ? (Date.now() - msg.at) / 1000 : 0);
}

async function applyState(msg: StateMsg): Promise<void> {
  if (msg.at <= lastRemoteAt) return; // older than what we already applied
  lastRemoteAt = msg.at;
  suppressUntil = Date.now() + ECHO_WINDOW_MS;

  if (!msg.track) {
    pause();
    return;
  }
  if (getCurrentTrackId() !== msg.track.id) {
    // Only the host changes songs; a listener's stale song is ignored.
    if (!joined || msg.from !== joined.id) return;
    pendingSync = msg;
    await playItem(msg.track);
    return; // finishPendingSync() runs once it's playing
  }
  if (msg.playing && !isPlaying()) play();
  else if (!msg.playing && isPlaying()) pause();
  const target = expectedPosition(msg);
  if (Math.abs(getPosition() - target) > DRIFT_LIMIT) seekTo(target);
}

/** The host's song finished loading here: jump to where they are now. */
function finishPendingSync(): void {
  const msg = pendingSync;
  if (!msg || getCurrentTrackId() !== msg.track?.id) return;
  // Can't jump until the player knows the song's length; durationchange retries.
  if (getDuration() <= 0) return;
  pendingSync = null;
  suppressUntil = Date.now() + ECHO_WINDOW_MS;
  const target = expectedPosition(msg);
  if (Math.abs(getPosition() - target) > DRIFT_LIMIT) seekTo(target);
  if (!msg.playing) pause();
}

function onMessage(msg: JamMsg, asHost: boolean): void {
  if (!me || msg.from === me.id) return;
  if (msg.type === "hello" && asHost) broadcastState(true);
  else if (msg.type === "command" && asHost) void (msg.cmd === "next" ? playNext() : playPrevious());
  else if (msg.type === "state") {
    if (!asHost && joined && msg.from === joined.id && answerTimer) {
      clearTimeout(answerTimer);
      answerTimer = undefined;
      bus.emit("toast", `🎧 Listening along with ${joined.name}`);
    }
    void applyState(msg);
  }
}

// --- My own channel (people listening along with me) -------------------------------

function openOwnChannel(account: Account): void {
  ownChannel = supabase.channel(`jam:${account.id}`, {
    config: { presence: { key: account.id }, broadcast: { self: false } },
  });
  ownChannel
    .on("broadcast", { event: "jam" }, ({ payload }) => onMessage(payload as JamMsg, true))
    .on("presence", { event: "sync" }, () => {
      const state = ownChannel!.presenceState<{ name: string }>();
      const before = new Set(listeners.map((l) => l.id));
      listeners = Object.entries(state)
        .filter(([id]) => id !== account.id)
        .map(([id, metas]) => ({ id, name: metas[0]?.name ?? "Someone" }));
      const newcomer = listeners.find((l) => !before.has(l.id));
      if (newcomer) {
        bus.emit("toast", `🎧 ${newcomer.name} is listening along`);
        broadcastState(true);
      }
      updateHeartbeat();
      emitChange();
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") void ownChannel!.track({ name: account.name });
    });
}

// --- Listening along with someone ----------------------------------------------------

export async function listenAlong(hostId: string, hostName: string): Promise<void> {
  if (!me || hostId === me.id) return;
  await stopListening(false);
  const channel = supabase.channel(`jam:${hostId}`, {
    config: { presence: { key: me.id }, broadcast: { self: false } },
  });
  joined = { id: hostId, name: hostName, channel };
  lastRemoteAt = 0;
  bus.emit("toast", `Connecting to ${hostName}…`);
  // Their phone may be asleep or Groov closed: give up instead of hanging.
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => {
    answerTimer = undefined;
    if (joined?.channel !== channel) return;
    void stopListening(false);
    bus.emit("toast", `${hostName}'s Groov isn't answering — it may be closed or the phone asleep`);
  }, ANSWER_MS);
  channel
    .on("broadcast", { event: "jam" }, ({ payload }) => onMessage(payload as JamMsg, false))
    .subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      void channel.track({ name: me!.name });
      send(channel, { type: "hello", from: me!.id });
    });
  // Their queue decides next/previous.
  setSkipInterceptor((direction) => {
    send(joined?.channel ?? null, { type: "command", from: me!.id, cmd: direction });
    return true;
  });
  setListeningTo(hostId);
  updateHeartbeat();
  emitChange();
}

export async function stopListening(notify = true): Promise<void> {
  clearTimeout(answerTimer);
  answerTimer = undefined;
  if (!joined) return;
  const { channel, name } = joined;
  joined = null;
  pendingSync = null;
  setSkipInterceptor(null);
  setListeningTo(null);
  await supabase.removeChannel(channel);
  updateHeartbeat();
  emitChange();
  if (notify) bus.emit("toast", `Stopped listening with ${name}`);
}

// --- Keeping in sync ------------------------------------------------------------------

function updateHeartbeat(): void {
  clearInterval(heartbeat);
  heartbeat = undefined;
  // Only the host sends the steady beat; listeners just react.
  if (!joined && listeners.length) {
    heartbeat = setInterval(() => {
      if (isPlaying()) broadcastState();
    }, HEARTBEAT_MS);
  }
}

function signedIn(account: Account): void {
  me = account;
  openOwnChannel(account);
}

async function signedOut(): Promise<void> {
  await stopListening(false);
  if (ownChannel) await supabase.removeChannel(ownChannel);
  ownChannel = null;
  listeners = [];
  me = null;
  updateHeartbeat();
  emitChange();
}

export function initJam(): void {
  bus.on("authchange", (account) => {
    if (account?.id === me?.id) {
      if (account) me = account; // name changed
      return;
    }
    void signedOut().then(() => account && signedIn(account));
  });
  bus.on("loading", (isLoading) => {
    loading = isLoading;
  });
  bus.on("playstate", (playing) => {
    if (playing && pendingSync) finishPendingSync();
    else scheduleBroadcast();
  });
  bus.on("trackchange", () => scheduleBroadcast());
  bus.on("seeked", () => scheduleBroadcast());
  bus.on("durationchange", () => {
    if (pendingSync && isPlaying()) finishPendingSync();
  });
}
