// Mirrors playback to the OS: the Android notification + lock screen (native
// MediaControls plugin), or media keys / the browser media popup on a laptop
// (Media Session API). Button presses come back here and drive the player.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { bus } from "../state";
import { getSnapshot, pause, play, playNext, playPrevious, seekTo } from "./player";

type NativeAction = "play" | "pause" | "next" | "previous" | "seek" | "stop";

interface NativeState {
  title: string;
  artist: string;
  artwork: string | null;
  playing: boolean;
  position: number;
  duration: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

interface MediaControlsPlugin {
  update(state: NativeState): Promise<void>;
  stop(): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<{ value: boolean }>;
  openBatterySettings(): Promise<void>;
  addListener(
    event: "action",
    fn: (e: { action: NativeAction; position?: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<MediaControlsPlugin>("MediaControls");
export const isNativeApp = Capacitor.isNativePlatform();

/** iTunes artwork URLs end in e.g. 100x100bb.jpg; ask for a sharper size. */
export function hiResArtwork(url: string | null | undefined, size = 600): string | null {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
}

// --- Native (Android) ------------------------------------------------------------

function syncNative(): void {
  const s = getSnapshot();
  if (!s.item) return;
  Native.update({
    title: s.item.name,
    artist: s.item.subtitle,
    artwork: hiResArtwork(s.item.artwork),
    playing: s.playing,
    position: s.position,
    duration: s.duration,
    hasNext: s.hasNext,
    hasPrevious: s.hasPrevious,
  }).catch(() => {
    // plugin unavailable (old APK); nothing to mirror to
  });
}

function onNativeAction({ action, position }: { action: NativeAction; position?: number }): void {
  switch (action) {
    case "play":
      play();
      break;
    case "pause":
      pause();
      break;
    case "next":
      void playNext();
      break;
    case "previous":
      void playPrevious();
      break;
    case "seek":
      if (typeof position === "number") seekTo(position);
      break;
    case "stop":
      pause();
      break;
  }
}

// --- Web (laptop / browser) -------------------------------------------------------

let webMetadataTrackId: string | null = null;

function syncWeb(): void {
  if (!("mediaSession" in navigator)) return;
  const s = getSnapshot();
  if (!s.item) return;
  const ms = navigator.mediaSession;

  if (webMetadataTrackId !== s.item.id) {
    webMetadataTrackId = s.item.id;
    const art = hiResArtwork(s.item.artwork, 512);
    ms.metadata = new MediaMetadata({
      title: s.item.name,
      artist: s.item.subtitle,
      artwork: art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : [],
    });
  }
  ms.playbackState = s.playing ? "playing" : "paused";
  if (s.duration > 0 && Number.isFinite(s.duration)) {
    try {
      ms.setPositionState({
        duration: s.duration,
        position: Math.min(Math.max(0, s.position), s.duration),
        playbackRate: 1,
      });
    } catch {
      // some browsers reject position state; metadata still works
    }
  }
}

function bindWebHandlers(): void {
  if (!("mediaSession" in navigator)) return;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => play()],
    ["pause", () => pause()],
    ["nexttrack", () => void playNext()],
    ["previoustrack", () => void playPrevious()],
    ["seekto", (d) => typeof d.seekTime === "number" && seekTo(d.seekTime)],
    ["stop", () => pause()],
  ];
  for (const [action, handler] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // action not supported by this browser
    }
  }
}

// --- Battery optimization (Android) ---------------------------------------------

export async function isBackgroundPlayAllowed(): Promise<boolean | null> {
  if (!isNativeApp) return null;
  try {
    return (await Native.isIgnoringBatteryOptimizations()).value;
  } catch {
    return null;
  }
}

export async function openBackgroundPlaySettings(): Promise<void> {
  if (isNativeApp) await Native.openBatterySettings().catch(() => undefined);
}

export function initMediaControls(): void {
  const sync = isNativeApp ? syncNative : syncWeb;
  if (isNativeApp) {
    void Native.addListener("action", onNativeAction).catch(() => undefined);
  } else {
    bindWebHandlers();
  }
  bus.on("trackchange", sync);
  bus.on("artworkchange", sync);
  bus.on("playstate", sync);
  bus.on("seeked", sync);
  // Android hides the seek bar until it knows the length, so resend then.
  bus.on("durationchange", sync);
}
