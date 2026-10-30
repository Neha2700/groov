// Bridge to the Android NativeAudio plugin: full songs from YouTube Music
// with no API key, played by ExoPlayer. Not available on the web/laptop.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { Item } from "../types";

interface NativeTrack {
  key: string;
  title: string;
  artist: string;
  durationMs: number;
}

interface NativeAudioPlugin {
  play(track: NativeTrack): Promise<{ cancelled: boolean; videoId?: string | null }>;
  prefetch(track: NativeTrack & { wait?: boolean }): Promise<void>;
  radio(o: { key: string; videoId?: string }): Promise<{
    tracks: { videoId: string; title: string; artist: string; durationSec: number; artwork: string | null }[];
  }>;
  crossfade(o: NativeTrack & { seconds: number }): Promise<{ cancelled: boolean; videoId?: string | null }>;
  musicVideo(o: NativeTrack & { audioSec: number }): Promise<{ videoId?: string | null }>;
  importPlaylist(o: { url: string; max?: number }): Promise<{
    name: string;
    tracks: { videoId: string; title: string; artist: string; durationSec: number; artwork: string | null }[];
  }>;
  importSpotify(o: { url: string }): Promise<{
    name: string;
    cover: string | null;
    songs: { id: string; title: string; artists: string; durationMs: number }[];
  }>;
  eqInfo(): Promise<{ available: boolean; presets: string[]; preset: number; bass: number; bassAvailable: boolean }>;
  setEq(o: { preset?: number; bass?: number }): Promise<void>;
  linkInfo(o: { videoId?: string; spotify?: string }): Promise<{
    videoId?: string;
    title: string;
    artist?: string;
    artists?: string;
    durationSec?: number;
    durationMs?: number;
    artwork?: string | null;
    id?: string;
  }>;
  videoIds(o: { keys: string[] }): Promise<{ ids: Record<string, string> }>;
  storageInfo(): Promise<{ bytes: number; songs: number; limitMb: number; downloadedBytes?: number; downloadedSongs?: number; smartBytes?: number; smartSongs?: number }>;
  smartDownload(o: { tracks: NativeTrack[]; limitMb: number; wifiOnly: boolean }): Promise<void>;
  download(o: { tracks: NativeTrack[] }): Promise<void>;
  removeDownloads(o: { keys: string[] }): Promise<void>;
  downloadState(o: { keys: string[] }): Promise<{ downloaded: string[] }>;
  setCacheLimit(o: { mb: number }): Promise<void>;
  clearCache(o?: { includeDownloads?: boolean }): Promise<{ deleted: number }>;
  resume(): Promise<void>;
  pause(): Promise<void>;
  seek(o: { position: number }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: "state", fn: (e: { playing: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(
    event: "progress",
    fn: (e: { position: number; duration: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "ended", fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: "error", fn: (e: { message?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "smartdone", fn: (e: { kept: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "download", fn: (e: { key: string; ok: boolean; error?: string; videoId?: string | null }) => void): Promise<PluginListenerHandle>;
}

export const nativeAudio = registerPlugin<NativeAudioPlugin>("NativeAudio");
export const hasNativeAudio = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

export function toNativeTrack(item: Item): NativeTrack {
  return {
    key: item.id,
    title: item.name,
    artist: item.subtitle,
    durationMs: item.durationMs ?? 0,
  };
}
