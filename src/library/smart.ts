// Smart downloads (Android): On Repeat and your Daily Mixes (and, if you
// like, Liked Songs) kept offline automatically — refreshed once a day, on
// Wi-Fi only. They have their own space budget and are removed before your
// own downloads when the phone runs low (see YouTubeAudio.setSmart).
import { hasNativeAudio, nativeAudio, toNativeTrack } from "../player/native-audio";
import { bus } from "../state";
import type { Item } from "../types";
import { storage } from "../utils";
import { getLikedPlaylist } from "./liked";
import { getMixes, loadMixSongs } from "./mixes";

export type SmartMode = "off" | "mixes" | "mixes-liked";
export const SMART_LIMIT_MB = 600;
const MODE_KEY = "groov:smart";
const DONE_KEY = "groov:smart-done";
const MAX_SONGS = 120;
const today = () => Math.floor(Date.now() / 86400000);

export function getSmartMode(): SmartMode {
  return storage.get<SmartMode>(MODE_KEY, "mixes");
}

export function setSmartMode(mode: SmartMode): void {
  storage.set(MODE_KEY, mode);
  storage.remove(DONE_KEY);
  void runSmart(true);
}

let running = false;

/** What to keep, most important first. */
async function smartSongs(mode: SmartMode): Promise<Item[]> {
  if (mode === "off") return [];
  const mixes = getMixes();
  const lists: Item[][] = [];
  for (const id of ["repeat", "daily1", "daily2"]) {
    const mix = mixes.find((m) => m.id === id);
    if (mix) lists.push(await loadMixSongs(mix).catch(() => []));
  }
  if (mode === "mixes-liked") lists.push(getLikedPlaylist()?.tracks ?? []);
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const list of lists) {
    for (const song of list) {
      if (out.length >= MAX_SONGS) break;
      if (!seen.has(song.id)) {
        seen.add(song.id);
        out.push(song);
      }
    }
  }
  return out;
}

/** Once a day (or right away after a settings change), on Wi-Fi. */
export async function runSmart(force = false): Promise<void> {
  if (!hasNativeAudio || running) return;
  if (!force && storage.get<number>(DONE_KEY, 0) === today()) return;
  running = true;
  try {
    const songs = await smartSongs(getSmartMode());
    await nativeAudio.smartDownload({ tracks: songs.map(toNativeTrack), limitMb: SMART_LIMIT_MB, wifiOnly: true });
    storage.set(DONE_KEY, today()); // started; it finishes in the background
  } catch {
    // not on Wi-Fi (or offline): try again later
  } finally {
    running = false;
  }
}

export function initSmart(): void {
  if (!hasNativeAudio) return;
  void nativeAudio.addListener("smartdone", () => bus.emit("downloadchange", undefined));
  setTimeout(() => void runSmart(), 20000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void runSmart();
  });
  window.addEventListener("online", () => void runSmart());
}
