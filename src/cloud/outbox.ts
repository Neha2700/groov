// Changes waiting to be saved to the account. Survives restarts and works
// offline: changes apply on the phone right away and upload when possible.
import { bus } from "../state";
import type { Item } from "../types";
import { storage } from "../utils";
import { isSignedIn } from "./session";

export type Op =
  | { type: "createPlaylist"; id: string; name: string }
  | { type: "deletePlaylist"; id: string }
  | { type: "renamePlaylist"; id: string; name: string }
  | { type: "updateTrack"; playlistId: string; track: Item }
  | { type: "leavePlaylist"; id: string }
  | { type: "addTrack"; playlistId: string; track: Item; position: number }
  | { type: "removeTrack"; playlistId: string; trackKey: string }
  | { type: "logPlay"; track: Item; playedAt: string };

const KEY = "groov:outbox";

export function pendingOps(): Op[] {
  return storage.get<Op[]>(KEY, []);
}

export function setPendingOps(ops: Op[]): void {
  storage.set(KEY, ops);
}

/** Queue a change for the account (ignored when signed out: local only). */
export function enqueue(op: Op): void {
  if (!isSignedIn()) return;
  setPendingOps([...pendingOps(), op]);
  bus.emit("outbox", undefined);
}

export function clearOutbox(): void {
  storage.remove(KEY);
}
