// Keeps the phone's playlists and the account in step.
//
//  - Upload: queued changes (outbox.ts) are sent in order. Network trouble →
//    keep them and retry later; a change the server refuses → drop it.
//  - Download: once nothing is waiting to upload, fetch every playlist the
//    account can see and replace the phone's copy.
//  - Live: when anyone changes a playlist we can see (e.g. a friend adds a
//    song to a shared one), Supabase Realtime tells us and we download again.
//  - First sign-in on a phone: playlists made before signing in move into
//    the account.
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getPlaylists, newId, replacePlaylists } from "../library/playlists";
import { bus, trackRegistry } from "../state";
import type { Item, Playlist, Playlists } from "../types";
import { supabase } from "./client";
import { clearOutbox, enqueue, pendingOps, setPendingOps, type Op } from "./outbox";
import { getAccount, type Account } from "./session";

export type SyncStatus = "signed-out" | "syncing" | "synced" | "offline";

let status: SyncStatus = "signed-out";
let flushing = false;
let pullTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let channel: RealtimeChannel | null = null;

export function getSyncStatus(): SyncStatus {
  return status;
}

function setStatus(next: SyncStatus): void {
  if (next === status) return;
  status = next;
  bus.emit("syncstatus", status);
}

// --- Upload ----------------------------------------------------------------------

interface DbError {
  code?: string;
  message?: string;
}

/** True when it's worth retrying later (offline, server hiccup). */
function isRetryable(error: DbError): boolean {
  if (!error.code) return true; // fetch failed: no network
  return error.code.startsWith("5") || error.code === "PGRST301" || error.code === "57014";
}

async function run(op: Op, me: Account): Promise<DbError | null> {
  switch (op.type) {
    case "createPlaylist": {
      const { error } = await supabase.from("playlists").insert({ id: op.id, name: op.name });
      return error?.code === "23505" ? null : error; // already created
    }
    case "updateTrack": {
      const { error } = await supabase
        .from("playlist_tracks")
        .update({ track: op.track })
        .eq("playlist_id", op.playlistId)
        .eq("track_key", op.track.id);
      return error;
    }
    case "renamePlaylist": {
      const { error } = await supabase.from("playlists").update({ name: op.name }).eq("id", op.id);
      return error;
    }
    case "deletePlaylist": {
      const { error } = await supabase.from("playlists").delete().eq("id", op.id);
      return error;
    }
    case "leavePlaylist": {
      const { error } = await supabase
        .from("playlist_members")
        .delete()
        .eq("playlist_id", op.id)
        .eq("user_id", me.id);
      return error;
    }
    case "addTrack": {
      const { error } = await supabase.from("playlist_tracks").upsert(
        { playlist_id: op.playlistId, track_key: op.track.id, track: op.track, position: op.position },
        { onConflict: "playlist_id,track_key", ignoreDuplicates: true },
      );
      return error;
    }
    case "removeTrack": {
      const { error } = await supabase
        .from("playlist_tracks")
        .delete()
        .eq("playlist_id", op.playlistId)
        .eq("track_key", op.trackKey);
      return error;
    }
    case "logPlay": {
      const { error } = await supabase
        .from("play_history")
        .insert({ track_key: op.track.id, track: op.track, played_at: op.playedAt });
      return error;
    }
  }
}

async function flush(): Promise<void> {
  const me = getAccount();
  if (!me || flushing) return;
  flushing = true;
  setStatus("syncing");
  try {
    while (true) {
      const ops = pendingOps();
      if (!ops.length) break;
      let error: DbError | null;
      try {
        error = await run(ops[0], me);
      } catch (e) {
        error = { message: String(e) }; // thrown fetch error: treat as offline
      }
      if (error && isRetryable(error)) {
        setStatus("offline");
        scheduleRetry();
        return;
      }
      if (error) console.warn("Sync: server refused a change, skipping it:", ops[0], error);
      // Done (or refused): drop it. Re-read in case more were queued meanwhile.
      setPendingOps(pendingOps().slice(1));
    }
    await pull();
  } finally {
    flushing = false;
  }
}

function scheduleRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void flush(), 30_000);
}

// --- Download --------------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  is_shared: boolean;
  owner_id: string;
  owner: { display_name: string } | null;
  playlist_members: { user_id: string; profile: { display_name: string } | null }[];
  playlist_tracks: {
    track_key: string;
    track: Item;
    position: number;
    added_by: string | null;
    adder: { display_name: string } | null;
  }[];
}

const SELECT = `
  id, name, is_shared, owner_id, created_at,
  owner:profiles!playlists_owner_id_fkey(display_name),
  playlist_members(user_id, profile:profiles(display_name)),
  playlist_tracks(track_key, track, position, added_by, adder:profiles(display_name))
`;

async function pull(): Promise<void> {
  const me = getAccount();
  if (!me) return;
  if (pendingOps().length) return; // upload first, or we'd hide unsent changes
  const { data, error } = await supabase.from("playlists").select(SELECT).order("created_at");
  if (error) {
    setStatus(isRetryable(error) ? "offline" : "synced");
    if (isRetryable(error)) scheduleRetry();
    else console.warn("Sync: download failed", error);
    return;
  }
  if (pendingOps().length) return; // something changed while downloading

  const next: Playlists = {};
  // Keep anything still local-only (made signed-out, not migrated yet).
  for (const p of Object.values(getPlaylists())) if (!p.cloud) next[p.id] = p;

  for (const row of data as unknown as Row[]) {
    const tracks = [...row.playlist_tracks].sort((a, b) => a.position - b.position);
    const members = row.playlist_members.map((m) => ({ id: m.user_id, name: m.profile?.display_name ?? "Someone" }));
    const playlist: Playlist = {
      id: row.id,
      name: row.name,
      cloud: true,
      ownerId: row.owner_id,
      ownerName: row.owner?.display_name ?? "Someone",
      shared: members.length > 0,
      members,
      tracks: tracks.map((t) => t.track),
      addedBy: Object.fromEntries(
        tracks.map((t) => [t.track_key, { id: t.added_by, name: t.adder?.display_name ?? "Someone" }]),
      ),
    };
    playlist.tracks.forEach((t) => trackRegistry.set(t.id, t));
    next[row.id] = playlist;
  }
  replacePlaylists(next);
  setStatus("synced");
}

function schedulePull(delay = 600): void {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(() => void (pendingOps().length ? flush() : pull()), delay);
}

/** Download now (e.g. after sharing), unless uploads are pending. */
export function refresh(): void {
  schedulePull(0);
}

// --- Sharing ----------------------------------------------------------------------

/** Share a playlist with another Groov account. Returns their name. */
export async function sharePlaylist(playlistId: string, friendEmail: string): Promise<string> {
  // Make sure the playlist itself has reached the account first.
  await flush();
  if (pendingOps().some((op) => op.type === "createPlaylist" && op.id === playlistId)) {
    throw new Error("You're offline. Try sharing again when you're connected.");
  }
  const { data, error } = await supabase.rpc("share_playlist", { pid: playlistId, friend_email: friendEmail });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, "") || "Couldn't share");
  refresh();
  return data as string;
}

// --- Sign in / out ----------------------------------------------------------------

const MIGRATED_KEY = "groov:migrated-to";

/** First sign-in on this phone: move local playlists into the account. */
function migrateLocalPlaylists(me: Account): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const playlists = getPlaylists();
  const next: Playlists = {};
  let moved = 0;
  for (const p of Object.values(playlists)) {
    if (p.cloud) {
      next[p.id] = p;
      continue;
    }
    const id = uuid.test(p.id) ? p.id : newId();
    next[id] = { ...p, id, cloud: true, ownerId: me.id, ownerName: me.name };
    enqueue({ type: "createPlaylist", id, name: p.name.slice(0, 100) || "Playlist" });
    p.tracks.forEach((track, i) => enqueue({ type: "addTrack", playlistId: id, track, position: Date.now() + i }));
    moved++;
  }
  if (moved) replacePlaylists(next);
  try {
    localStorage.setItem(MIGRATED_KEY, me.id);
  } catch {
    // ignore
  }
}

function subscribe(): void {
  channel?.unsubscribe();
  channel = supabase
    .channel("groov-playlists")
    .on("postgres_changes", { event: "*", schema: "public", table: "playlists" }, () => schedulePull())
    .on("postgres_changes", { event: "*", schema: "public", table: "playlist_tracks" }, () => schedulePull())
    .on("postgres_changes", { event: "*", schema: "public", table: "playlist_members" }, () => schedulePull())
    .subscribe();
}

let lastAccountId: string | null = null;

function onAuthChange(me: Account | null): void {
  if (me?.id === lastAccountId) return;
  const wasSignedIn = lastAccountId !== null;
  lastAccountId = me?.id ?? null;

  if (!me) {
    // Signed out: forget the account's playlists on this phone.
    channel?.unsubscribe();
    channel = null;
    clearOutbox();
    if (wasSignedIn) {
      const localOnly = Object.fromEntries(Object.entries(getPlaylists()).filter(([, p]) => !p.cloud));
      replacePlaylists(localOnly);
    }
    setStatus("signed-out");
    return;
  }

  migrateLocalPlaylists(me);
  subscribe();
  void flush();
}

export function initSync(): void {
  bus.on("authchange", onAuthChange);
  bus.on("outbox", () => void flush());
  window.addEventListener("online", () => void flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getAccount()) schedulePull(0);
  });
}
