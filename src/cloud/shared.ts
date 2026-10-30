// Things shared by everyone signed in to Groov:
//   - the YouTube key: paste it once (on any device) and every signed-in
//     device and friend gets full songs on the laptop version too.
//   - song → YouTube video matches: the phone finds them for free while
//     playing; the laptop reuses them instead of searching (no quota, and
//     no key needed for those songs).
import { KEYS } from "../config";
import { bus } from "../state";
import { storage } from "../utils";
import { supabase } from "./client";
import { getAccount } from "./session";

const KEY_NAME = "youtube_api_key";

async function pullSharedKey(): Promise<void> {
  const { data, error } = await supabase.from("app_settings").select("value").eq("key", KEY_NAME).maybeSingle();
  if (error) return; // table not created yet, or offline: keep what we have
  const value = (data as { value?: string } | null)?.value ?? "";
  // The account has no key yet but this phone does: share it.
  const local = storage.get<string>(KEYS.ytKey, "");
  if (!value && local) {
    if (await shareYoutubeKey(local)) bus.emit("youtubekeychange", undefined);
    return;
  }
  if (value !== storage.get<string>(KEYS.accountYtKey, "")) {
    if (value) storage.set(KEYS.accountYtKey, value);
    else storage.remove(KEYS.accountYtKey);
    bus.emit("youtubekeychange", undefined);
  }
}

/** Save the key to the account so other devices and friends get it. */
export async function shareYoutubeKey(key: string): Promise<boolean> {
  if (!getAccount() || !key) return false;
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: KEY_NAME, value: key, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) {
    console.warn("Couldn't save the YouTube key to the account:", error.message);
    return false;
  }
  storage.set(KEYS.accountYtKey, key);
  return true;
}

// --- Song → video matches ---------------------------------------------------------

const reported = new Set<string>(storage.get<string[]>("groov:video-ids-shared", []));

/** The phone found which video a song is: let other devices reuse it. */
export function shareVideoId(trackKey: string, videoId: string): void {
  if (!getAccount() || trackKey.startsWith("yt-") || reported.has(trackKey)) return;
  reported.add(trackKey);
  storage.set("groov:video-ids-shared", [...reported].slice(-3000));
  void supabase
    .from("video_ids")
    .upsert({ track_key: trackKey, video_id: videoId, updated_at: new Date().toISOString() }, { onConflict: "track_key" })
    .then(({ error }) => {
      if (error) reported.delete(trackKey);
    });
}

/** A match found earlier by any Groov device (undefined: nobody knows yet). */
export async function lookupSharedVideoId(trackKey: string): Promise<string | undefined> {
  if (!getAccount()) return undefined;
  try {
    const { data } = await supabase.from("video_ids").select("video_id").eq("track_key", trackKey).maybeSingle();
    return (data as { video_id?: string } | null)?.video_id || undefined;
  } catch {
    return undefined;
  }
}

export function initShared(): void {
  bus.on("authchange", (account) => {
    if (account) void pullSharedKey();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getAccount()) void pullSharedKey();
  });
}
