import { storage } from "./utils";

export const DEBOUNCE_MS = 300;
/** Songs per row on Home and in search results (rows scroll sideways). */
export const OVERVIEW_LIMIT = 10;
export const SEE_ALL_LIMIT = 30;
export const MIN_QUERY_LENGTH = 1;

/**
 * Storage keys keep the original "search-demo:" prefix so playlists, recent
 * searches and the YouTube ID cache from earlier builds carry over.
 */
export const KEYS = {
  recent: "search-demo:recent-searches",
  theme: "search-demo:theme",
  ytCache: "search-demo:yt-cache",
  playlists: "search-demo:playlists",
  ytKey: "groov:youtube-api-key",
  /** The key saved to the Groov account (shared by everyone signed in). */
  accountYtKey: "groov:account-youtube-key",
} as const;

const BUILD_YOUTUBE_KEY = (import.meta.env.VITE_YOUTUBE_API_KEY as string | undefined) ?? "";

/** Key pasted on this device, else the account's shared key, else the built-in one. */
export function getYoutubeApiKey(): string {
  return storage.get<string>(KEYS.ytKey, "") || storage.get<string>(KEYS.accountYtKey, "") || BUILD_YOUTUBE_KEY;
}

export function hasAccountYoutubeKey(): boolean {
  return Boolean(storage.get<string>(KEYS.accountYtKey, ""));
}

export function setYoutubeApiKey(key: string): void {
  if (key.trim()) storage.set(KEYS.ytKey, key.trim());
  else storage.remove(KEYS.ytKey);
}

export function hasCustomYoutubeKey(): boolean {
  return Boolean(storage.get<string>(KEYS.ytKey, ""));
}
