// "Is YouTube broken for Groov?" When YouTube changes its site, the free
// library Groov uses to get full songs (NewPipe) stops working until it's
// updated. That shows up as several *different* songs failing in a row with
// the same kind of error (not "no internet", not one blocked song).
// Then Groov says so plainly instead of silently skipping songs.
import { bus } from "../state";
import { storage } from "../utils";

const KEY = "groov:youtube-broken";
const WINDOW = 30 * 60_000;
const THRESHOLD = 3;

/** Errors that mean "YouTube changed", not "this song" or "no signal". */
const BROKEN =
  /Extraction|Parsing|decipher|signature|throttl|ReCaptcha|bot|HTTP\s*(?:response code:?\s*)?(?:403|429)|Could not get (?:stream|the)|n param|player response|PoToken|Sign in to confirm/i;
const NOT_BROKEN = /Unknown ?Host|Timeout|ConnectException|SSL|network|No YouTube Music match|Age|Geographic|private|not available in your country/i;

let failures: { id: string; at: number }[] = [];

export function isYoutubeBroken(): boolean {
  return storage.get<number>(KEY, 0) > 0;
}

/** A song failed natively: count it if it looks like YouTube changed. */
export function reportPlayFailure(trackId: string, message: string): void {
  if (!navigator.onLine || NOT_BROKEN.test(message) || !BROKEN.test(message)) return;
  const now = Date.now();
  failures = failures.filter((f) => now - f.at < WINDOW && f.id !== trackId);
  failures.push({ id: trackId, at: now });
  if (failures.length >= THRESHOLD && !isYoutubeBroken()) {
    storage.set(KEY, now);
    bus.emit("healthchange", undefined);
    bus.emit("toast", "⚠️ YouTube changed something — full songs need a Groov update. Downloaded songs still play.");
  }
}

/** A song played fine: all good again. */
export function reportPlaySuccess(): void {
  failures = [];
  if (isYoutubeBroken()) {
    storage.remove(KEY);
    bus.emit("healthchange", undefined);
  }
}
