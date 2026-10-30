// Playback engines + queue. No layout here: the player bar and the Now
// Playing screen (ui/now-playing.ts) render from the events this emits.
//
// Three interchangeable engines behind one interface, tried in this order:
//  - "native":  Android only. Full songs from YouTube Music, no key, played
//               by ExoPlayer and cached on the phone (see NativeAudioPlugin).
//  - "youtube": full length via ONE hidden YouTube IFrame player, used when a
//               YouTube key is set and a match is found.
//  - "audio":   the free, always-available 30s iTunes preview clip.
// Each one falls back to the next on any failure.
//
// The YouTube iframe lives in #yt-host. It's invisible by default (the UI
// shows album art); the Now Playing screen can lay it over its artwork
// slot to show the video. Only CSS moves it, never the DOM, because
// re-parenting a live iframe reloads it and restarts the song.
import { loadYoutubeIframeApi, resolveVideoId } from "../api/youtube";
import { shareVideoId } from "../cloud/shared";
import { fillMissingArtwork } from "../library/playlists";
import { reportPlayFailure, reportPlaySuccess } from "./health";
import { bus, trackRegistry } from "../state";
import type { Item } from "../types";
import { $, storage } from "../utils";
import { hasNativeAudio, nativeAudio, toNativeTrack } from "./native-audio";

export type Engine = "audio" | "youtube" | "native";

let currentTrackId: string | null = null;
let activeEngine: Engine = "audio";
let currentQueue: string[] = [];
let currentQueueIndex = -1;
let progressTimer: ReturnType<typeof setInterval> | undefined;

export function getCurrentTrackId(): string | null {
  return currentTrackId;
}

export function getEngine(): Engine {
  return activeEngine;
}

// --- Seeking ------------------------------------------------------------------
// After a seek, engines keep reporting the old time for a moment while they
// buffer. Report the target instead until they catch up, so the bar and the
// notification move once, smoothly, instead of jumping back and forth.

let pendingSeek: { target: number; until: number } | null = null;

function settledPosition(actual: number): number {
  if (!pendingSeek) return actual;
  if (Math.abs(actual - pendingSeek.target) < 1.5 || Date.now() > pendingSeek.until) {
    pendingSeek = null;
    return actual;
  }
  return pendingSeek.target;
}

// --- iTunes 30s preview engine -------------------------------------------------

const audio = new Audio();
audio.preload = "none";

audio.addEventListener("play", () => activeEngine === "audio" && onPlaybackStarted());
audio.addEventListener("pause", () => activeEngine === "audio" && onPlaybackPaused());
audio.addEventListener("ended", () => activeEngine === "audio" && onPlaybackEnded());
audio.addEventListener("loadedmetadata", () => {
  if (activeEngine === "audio" && Number.isFinite(audio.duration)) {
    bus.emit("durationchange", audio.duration);
    emitProgress();
  }
});
audio.addEventListener("timeupdate", () => activeEngine === "audio" && emitProgress());

// --- YouTube full-track engine --------------------------------------------------

let yt: YT.Player | null = null;
let ytReady: Promise<YT.Player> | null = null;
let lastReportedDuration = 0;
let unmuteTimer: ReturnType<typeof setTimeout> | undefined;

function getYoutubePlayer(): Promise<YT.Player> {
  ytReady ??= loadYoutubeIframeApi().then(
    (YTApi) =>
      new Promise((resolve) => {
        const player: YT.Player = new YTApi.Player($("youtube-player"), {
          height: "100%",
          width: "100%",
          playerVars: {
            controls: 0, // our own controls
            disablekb: 1,
            fs: 0,
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
            iv_load_policy: 3, // no annotations
            cc_load_policy: 0, // no captions by default
          },
          events: {
            onReady: () => resolve((yt = player)),
            onStateChange: onYoutubeStateChange,
          },
        });
      }),
  );
  return ytReady;
}

function hideCaptions(player: YT.Player): void {
  // Undocumented but widely used; YouTube may still show captions if the
  // viewer turned them on globally, so we also unload the module.
  try {
    player.unloadModule?.("captions");
    player.unloadModule?.("cc");
  } catch {
    // older player builds
  }
}

function onYoutubeStateChange(e: YT.OnStateChangeEvent): void {
  const S = window.YT.PlayerState;
  if (videoHandover && e.data === S.PLAYING) {
    continueHandover(e.target);
    return;
  }
  if (activeEngine !== "youtube") return;
  if (e.data === S.PLAYING) {
    hideCaptions(e.target);
    finishSeekMute();
    onPlaybackStarted();
  } else if (e.data === S.PAUSED) {
    onPlaybackPaused();
  } else if (e.data === S.ENDED) {
    onPlaybackEnded();
  }
}

function startProgressPolling(): void {
  clearInterval(progressTimer);
  lastReportedDuration = 0;
  progressTimer = setInterval(() => {
    if (activeEngine !== "youtube" || !yt?.getDuration) return;
    const duration = yt.getDuration() || 0;
    if (duration > 0 && duration !== lastReportedDuration) {
      lastReportedDuration = duration;
      bus.emit("durationchange", duration);
    }
    emitProgress();
  }, 250);
}

/** Mute across a YouTube seek so its buffering stutter isn't heard. */
function startSeekMute(): void {
  if (!yt) return;
  yt.mute();
  clearTimeout(unmuteTimer);
  unmuteTimer = setTimeout(finishSeekMute, 1200); // safety net
}

function finishSeekMute(): void {
  clearTimeout(unmuteTimer);
  unmuteTimer = undefined;
  if (yt?.isMuted?.()) yt.unMute();
}

// --- Native engine (Android) --------------------------------------------------------
// Position arrives every 500ms; interpolate between updates.

let nativePlaying = false;
let nativePosition = 0;
let nativePositionAt = 0;
let nativeDuration = 0;
/** YouTube video the current native song came from (for "show video"). */
let nativeVideoId: string | null = null;
/** True while the video is shown in place of a native song. */
let videoFromNative = false;

/** Why the last full-song attempt failed (shown in Settings, for debugging). */
export let lastNativeError: string | null = null;

function initNativeEngine(): void {
  if (!hasNativeAudio) return;
  void nativeAudio.addListener("state", ({ playing }) => {
    if (activeEngine !== "native") return;
    nativePlaying = playing;
    nativePositionAt = Date.now();
    if (playing) onPlaybackStarted();
    else onPlaybackPaused();
  });
  void nativeAudio.addListener("progress", ({ position, duration }) => {
    if (activeEngine !== "native") return;
    nativePosition = position;
    nativePositionAt = Date.now();
    if (duration > 0 && duration !== nativeDuration) {
      nativeDuration = duration;
      bus.emit("durationchange", duration);
      // Find the music video in the background, so "Show video" is instant.
      const item = currentTrackId ? trackRegistry.get(currentTrackId) : undefined;
      if (item) setTimeout(() => currentTrackId === item.id && void findMusicVideo(item), 4000);
    }
    emitProgress();
    maybeCrossfade();
  });
  void nativeAudio.addListener("ended", () => {
    if (activeEngine !== "native") return;
    nativePlaying = false;
    onPlaybackEnded();
  });
  void nativeAudio.addListener("error", ({ message }) => {
    if (activeEngine !== "native") return;
    console.warn("Native playback error:", message);
    nativePlaying = false;
    lastNativeError = message || "Playback error";
    // The song file broke mid-way: move on rather than going silent.
    const item = currentTrackId ? trackRegistry.get(currentTrackId) : undefined;
    if (item) skipUnplayable(item);
    else onPlaybackPaused();
  });
}

function nativePositionNow(): number {
  if (!nativePlaying) return nativePosition;
  const p = nativePosition + (Date.now() - nativePositionAt) / 1000;
  return nativeDuration > 0 ? Math.min(p, nativeDuration) : p;
}

/** Download the next song in the queue while this one plays. */
function prefetchNext(): void {
  if (activeEngine !== "native" || !hasNext()) return;
  const next = trackRegistry.get(currentQueue[currentQueueIndex + 1]);
  if (next) void nativeAudio.prefetch(toNativeTrack(next)).catch(() => undefined);
}

// --- Shared state -------------------------------------------------------------

function getRawPosition(): number {
  if (activeEngine === "native") return nativePositionNow();
  if (activeEngine === "youtube") return yt?.getCurrentTime?.() || 0;
  return audio.currentTime || 0;
}

export function getPosition(): number {
  return settledPosition(getRawPosition());
}

export function getDuration(): number {
  if (activeEngine === "native") return nativeDuration;
  if (activeEngine === "youtube") return yt?.getDuration?.() || 0;
  return Number.isFinite(audio.duration) ? audio.duration : 0;
}

function emitProgress(): void {
  const duration = getDuration();
  bus.emit("progress", { currentTime: getPosition(), duration: duration || 30 });
}

function onPlaybackStarted(): void {
  bus.emit("playstate", true);
}

function onPlaybackPaused(): void {
  bus.emit("playstate", false);
}

function onPlaybackEnded(): void {
  if (stopAfterCurrent) {
    // Sleep timer "end of song": stop here, ready to play the next one.
    stopAfterCurrent = false;
    resumeGoesToNext = true;
    bus.emit("sleepchange", undefined);
    if (activeEngine === "native") void nativeAudio.pause().catch(() => undefined);
    onPlaybackPaused();
    return;
  }
  if (repeatMode === "one") {
    seekTo(0);
    play();
    return;
  }
  onPlaybackPaused();
  void playNextInQueue();
}

export function isTrackPlaying(id: string): boolean {
  if (currentTrackId !== id) return false;
  if (activeEngine === "native") return nativePlaying;
  if (activeEngine === "youtube") {
    return yt?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
  }
  return !audio.paused;
}

export function isPlaying(): boolean {
  return currentTrackId ? isTrackPlaying(currentTrackId) : false;
}

// --- Queue --------------------------------------------------------------------
// Autoplay continues through whichever grid or playlist the current track was
// started from, in the order it appears there (or shuffled).

export type QueueSource = "list" | "radio";
export type RepeatMode = "off" | "all" | "one";

let queueSource: QueueSource = "list";
/** Where the list came from, for "Playing from …" in Up next. */
let queueLabel = "Your queue";
/** The list as it was given, for turning shuffle back off. */
let originalQueue: string[] = [];
let shuffleOn = storage.get<boolean>("groov:shuffle", false);
let repeatMode = storage.get<RepeatMode>("groov:repeat", "off");

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function setQueue(ids: string[], startId: string, source: QueueSource = "list", label?: string): void {
  queueLabel = label ?? (source === "radio" ? "Radio" : "Your queue");
  const list = [...new Set(ids.length ? ids : [startId])];
  originalQueue = list;
  queueSource = source;
  // A copy: the two lists must never be the same array (appends would double).
  currentQueue = shuffleOn ? [startId, ...shuffled(list.filter((id) => id !== startId))] : [...list];
  currentQueueIndex = Math.max(0, currentQueue.indexOf(startId));
  manualCount = 0;
  bus.emit("queuechange", { source, remaining: currentQueue.length - 1 - currentQueueIndex });
  queueUpdated();
}

// --- Up next: Play next / Add to queue / reorder ----------------------------------
// Songs you queue by hand go right after the current one, in the order you
// added them, ahead of the rest of the list (like Spotify's "Next in queue").

let manualCount = 0;

function queueUpdated(): void {
  bus.emit("queueupdate", undefined);
}

export function getUpcoming(): string[] {
  return currentQueue.slice(currentQueueIndex + 1);
}

/** Songs already played in this list (most recent last), for Up next. */
export function getPlayedBefore(limit = 3): string[] {
  return currentQueue.slice(Math.max(0, currentQueueIndex - limit), Math.max(0, currentQueueIndex));
}

/** Go back to a song played earlier in this list (n songs back). */
export async function playBack(n: number): Promise<void> {
  if (n <= 0 || currentQueueIndex - n < 0) return;
  await playQueueIndex(currentQueueIndex - n);
}

export function getQueueLabel(): string {
  return queueLabel;
}

function insertAt(id: string, offset: number): void {
  // Moving a song that's already coming up: take it out first.
  const existing = currentQueue.indexOf(id, currentQueueIndex + 1);
  if (existing !== -1) {
    currentQueue.splice(existing, 1);
    if (existing - currentQueueIndex - 1 < manualCount) manualCount--;
  }
  currentQueue.splice(currentQueueIndex + 1 + Math.min(offset, manualCount), 0, id);
  if (!originalQueue.includes(id)) originalQueue.push(id);
  manualCount++;
  queueUpdated();
}

/** Play right after the current song. With nothing playing, play it now. */
export function playNextInsert(item: Item): void {
  trackRegistry.set(item.id, item);
  if (!currentTrackId) {
    setQueue([item.id], item.id);
    void playTrack(item.id);
    return;
  }
  if (item.id === currentTrackId) return;
  insertAt(item.id, 0);
}

/** Add after the songs you've already queued. */
export function addToQueueEnd(item: Item): void {
  trackRegistry.set(item.id, item);
  if (!currentTrackId) {
    playNextInsert(item);
    return;
  }
  if (item.id === currentTrackId) return;
  insertAt(item.id, manualCount);
}

/** Reorder upcoming songs (indexes into getUpcoming()). */
export function moveUpcoming(from: number, to: number): void {
  const base = currentQueueIndex + 1;
  const [id] = currentQueue.splice(base + from, 1);
  if (!id) return;
  currentQueue.splice(base + Math.max(0, Math.min(to, currentQueue.length - base)), 0, id);
  queueUpdated();
}

export function removeUpcoming(index: number): void {
  const [id] = currentQueue.splice(currentQueueIndex + 1 + index, 1);
  if (!id) return;
  if (index < manualCount) manualCount--;
  originalQueue = originalQueue.filter((x) => x !== id || x === currentTrackId);
  queueUpdated();
}

/** Jump to an upcoming song (skipping the ones before it). */
export async function playUpcoming(index: number): Promise<void> {
  manualCount = Math.max(0, manualCount - index - 1);
  await playQueueIndex(currentQueueIndex + 1 + index);
}

/** Add songs to the end of the queue (radio keeps it topped up). */
export function appendToQueue(ids: string[]): void {
  const fresh = ids.filter((id) => !originalQueue.includes(id));
  originalQueue.push(...fresh);
  currentQueue.push(...(shuffleOn ? shuffled(fresh) : fresh));
  queueUpdated();
}

export function getQueueInfo(): { source: QueueSource; remaining: number; lastId: string | null } {
  return {
    source: queueSource,
    remaining: Math.max(0, currentQueue.length - 1 - currentQueueIndex),
    lastId: currentQueue[currentQueue.length - 1] ?? null,
  };
}

export function isShuffleOn(): boolean {
  return shuffleOn;
}

export function getRepeatMode(): RepeatMode {
  return repeatMode;
}

export function toggleShuffle(): void {
  shuffleOn = !shuffleOn;
  storage.set("groov:shuffle", shuffleOn);
  const current = currentQueue[currentQueueIndex];
  if (current) {
    // Songs queued by hand stay next, in their order, either way.
    const manual = currentQueue.slice(currentQueueIndex + 1, currentQueueIndex + 1 + manualCount);
    if (shuffleOn) {
      const others = originalQueue.filter((id) => id !== current && !manual.includes(id));
      currentQueue = [current, ...manual, ...shuffled(others)];
      currentQueueIndex = 0;
    } else {
      const pos = originalQueue.indexOf(current);
      const before = originalQueue.slice(0, Math.max(0, pos)).filter((id) => !manual.includes(id));
      const after = originalQueue.slice(pos + 1).filter((id) => !manual.includes(id));
      currentQueue = [...before, current, ...manual, ...after];
      currentQueueIndex = before.length;
    }
    queueUpdated();
  }
  bus.emit("modechange", undefined);
}

export function cycleRepeat(): void {
  repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
  storage.set("groov:repeat", repeatMode);
  bus.emit("modechange", undefined);
}

export function queueFromElement(el: HTMLElement): void {
  const id = el.dataset.id!;
  const container = el.closest(".card-grid, .playlist-track-list");
  const ids = container
    ? [...container.querySelectorAll<HTMLElement>(".play-overlay[data-id], .playlist-row-play[data-id]")].map(
        (b) => b.dataset.id!,
      )
    : [id];
  const label = el.closest("#playlist-view")
    ? document.getElementById("playlist-view-title")?.textContent?.replace(/^❤️ /, "")
    : el.closest("#detail-view")
      ? document.getElementById("detail-title")?.textContent
      : el.closest("#results-view")
        ? "Search results"
        : el.closest("#stats-view")
          ? "Your top songs"
          : undefined;
  setQueue(ids, id, "list", label || undefined);
}

const hasNext = () =>
  currentQueueIndex >= 0 && (currentQueueIndex < currentQueue.length - 1 || (repeatMode === "all" && currentQueue.length > 1));

async function playQueueIndex(index: number): Promise<void> {
  const id = currentQueue[index];
  if (!id) return;
  // Moving forward one song uses up one hand-queued song.
  if (index === currentQueueIndex + 1 && manualCount > 0) manualCount--;
  else if (index <= currentQueueIndex) manualCount = 0;
  currentQueueIndex = index;
  queueUpdated();
  await playTrack(id);
}

// Autoplay: with nothing left to play, keep going with radio (radio.ts).
let autoplayHandler: (() => Promise<boolean>) | null = null;

export function setAutoplayHandler(fn: () => Promise<boolean>): void {
  autoplayHandler = fn;
}

async function playNextInQueue(): Promise<void> {
  if (!hasNext()) {
    if (repeatMode === "off" && !skipInterceptor && autoplayHandler && (await autoplayHandler())) {
      if (hasNext()) await playQueueIndex(currentQueueIndex + 1);
    }
    return;
  }
  if (currentQueueIndex >= currentQueue.length - 1) {
    // Repeat all: start over (in a new random order if shuffling).
    if (shuffleOn) currentQueue = shuffled(originalQueue);
    await playQueueIndex(0);
    return;
  }
  await playQueueIndex(currentQueueIndex + 1);
}

// Listening along with someone: their queue decides what's next, so
// skips are sent to them instead (see cloud/jam.ts).
type SkipInterceptor = (direction: "next" | "previous") => boolean;
let skipInterceptor: SkipInterceptor | null = null;

export function setSkipInterceptor(fn: SkipInterceptor | null): void {
  skipInterceptor = fn;
}

export async function playNext(): Promise<void> {
  if (skipInterceptor?.("next")) return;
  await playNextInQueue();
}

/** Play a song that isn't in any list on screen (e.g. from a friend). */
export async function playItem(item: Item): Promise<void> {
  trackRegistry.set(item.id, item);
  if (currentTrackId === item.id) return;
  setQueue([item.id], item.id);
  await playTrack(item.id);
}

/** Like every music app: restart the song if past 3s, else go back one. */
export async function playPrevious(): Promise<void> {
  if (skipInterceptor?.("previous")) return;
  if (getPosition() > 3 || currentQueueIndex <= 0) {
    seekTo(0);
    return;
  }
  await playQueueIndex(currentQueueIndex - 1);
}

// --- Sleep timer: stop when this song ends ----------------------------------------

let stopAfterCurrent = false;
/** Stopped by the sleep timer at a song's end: Play carries on with the next. */
let resumeGoesToNext = false;

export function setStopAfterCurrent(on: boolean): void {
  stopAfterCurrent = on;
}

export function isStopAfterCurrent(): boolean {
  return stopAfterCurrent;
}

// --- Crossfade (Android): fade into the next song before this one ends -------------

let crossfadeSeconds = storage.get<number>("groov:crossfade", 0);
/** The song a crossfade was tried for (once per song). */
let crossfadeTriedFor: string | null = null;

export function getCrossfadeSeconds(): number {
  return crossfadeSeconds;
}

export function setCrossfadeSeconds(seconds: number): void {
  crossfadeSeconds = seconds;
  storage.set("groov:crossfade", seconds);
}

function nextQueueIndex(): number {
  if (!hasNext()) return -1;
  return currentQueueIndex >= currentQueue.length - 1 ? 0 : currentQueueIndex + 1;
}

function maybeCrossfade(): void {
  if (!crossfadeSeconds || !currentTrackId || crossfadeTriedFor === currentTrackId) return;
  if (!nativePlaying || videoFromNative || stopAfterCurrent || repeatMode === "one" || skipInterceptor) return;
  if (nativeDuration < crossfadeSeconds * 3) return; // short clip: just play through
  if (nativeDuration - nativePositionNow() > crossfadeSeconds) return;
  const index = nextQueueIndex();
  if (index < 0) return;
  // Repeat all wraps to a reshuffled start: leave that to the normal path.
  if (index === 0 && shuffleOn) return;
  const next = trackRegistry.get(currentQueue[index]);
  if (!next) return;
  crossfadeTriedFor = currentTrackId;
  const fromId = currentTrackId;
  nativeAudio
    .crossfade({ ...toNativeTrack(next), seconds: crossfadeSeconds })
    .then(({ cancelled, videoId }) => {
      if (cancelled || currentTrackId !== fromId) return;
      // The next song is now playing: catch everything up, like playTrack.
      if (index === currentQueueIndex + 1 && manualCount > 0) manualCount--;
      currentQueueIndex = index;
      cancelHandover();
      currentTrackId = next.id;
      nativeVideoId = videoId ?? null;
      if (videoId && !next.artwork) {
        next.artwork = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        fillMissingArtwork(next.id, videoId);
      }
      nativePosition = 0;
      nativePositionAt = Date.now();
      nativeDuration = 0;
      nativePlaying = true;
      queueUpdated();
      bus.emit("trackchange", next);
      emitProgressReset();
      bus.emit("playstate", true);
      prefetchNext();
    })
    .catch(() => undefined); // not downloaded yet: the song plays to the end as usual
}

// --- Public controls ----------------------------------------------------------

function stopActiveEngine(): void {
  cancelHandover();
  nativeVideoId = null;
  videoFromNative = false;
  if (activeEngine === "native") {
    nativePlaying = false;
    void nativeAudio.stop().catch(() => undefined);
  }
  nativePosition = 0;
  nativeDuration = 0;
  audio.pause();
  clearInterval(progressTimer);
  finishSeekMute();
  pendingSeek = null;
  yt?.pauseVideo?.();
}

export async function playTrack(id: string): Promise<void> {
  const item = trackRegistry.get(id);
  if (!item) return;

  // Same track already loaded: just toggle play/pause.
  if (currentTrackId === id) {
    togglePlayback();
    return;
  }

  stopActiveEngine();
  resumeGoesToNext = false;
  if (!autoSkipping) unplayableInARow = 0; // you picked a song: start counting again
  const previousId = currentTrackId;
  currentTrackId = id;
  if (previousId) bus.emit("playstate", false);
  bus.emit("trackchange", item);
  emitProgressReset();

  if (hasNativeAudio) {
    // Claim the engine first: ExoPlayer's "playing" event can arrive before
    // play() resolves.
    setEngine("native");
    bus.emit("loading", true);
    try {
      const { cancelled, videoId } = await nativeAudio.play(toNativeTrack(item));
      if (cancelled || currentTrackId !== id) return;
      nativeVideoId = videoId ?? null;
      if (videoId) shareVideoId(item.id, videoId);
      unplayableInARow = 0;
      reportPlaySuccess();
      if (videoId && !item.artwork) {
        // Imported from Spotify (no pictures): use the YouTube thumbnail.
        item.artwork = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        fillMissingArtwork(item.id, videoId);
        bus.emit("artworkchange", item);
      }
      bus.emit("loading", false);
      prefetchNext();
      return;
    } catch (err) {
      if (currentTrackId !== id) return;
      bus.emit("loading", false);
      console.warn("Native playback failed, falling back:", err);
      lastNativeError = (err as Error)?.message || String(err);
      reportPlayFailure(id, lastNativeError);
    }
  }

  const youtubeId = await resolveVideoId(item);

  if (currentTrackId !== id) return; // superseded by another click meanwhile

  if (youtubeId) {
    setEngine("youtube");
    const player = await getYoutubePlayer();
    if (currentTrackId !== id) return;
    player.loadVideoById(youtubeId);
    player.playVideo();
    startProgressPolling();
  } else if (item.previewUrl) {
    setEngine("audio");
    audio.src = item.previewUrl;
    audio.currentTime = 0;
    audio.play().catch(() => onPlaybackPaused());
  } else {
    skipUnplayable(item);
  }
}

// A song that can't be played anywhere (no match, blocked, offline and not
// saved): don't just stop — say so and go on to the next one. After 3 in a
// row it stops (probably no internet), so it never loops through everything.
let unplayableInARow = 0;
/** True while moving on from an unplayable song (not a tap by you). */
let autoSkipping = false;

function skipUnplayable(item: Item): void {
  onPlaybackPaused();
  unplayableInARow++;
  const online = navigator.onLine !== false;
  if (unplayableInARow > 3 || !online) {
    bus.emit("toast", online ? `Couldn't play "${item.name}"` : "No internet — play a downloaded song");
    unplayableInARow = 0;
    return;
  }
  bus.emit("toast", `Couldn't play "${item.name}" — skipping`);
  const id = item.id;
  setTimeout(() => {
    if (currentTrackId !== id) return;
    autoSkipping = true;
    void playNextInQueue().finally(() => (autoSkipping = false));
  }, 1200);
}

function emitProgressReset(): void {
  bus.emit("progress", { currentTime: 0, duration: 0 });
}

function setEngine(engine: Engine): void {
  activeEngine = engine;
  bus.emit("enginechange", engine);
}

// --- Video for native songs ---------------------------------------------------------
// The native engine is audio only. "Show video" hands playback to the hidden
// YouTube player at the same position; hiding it hands back.

export function canShowVideo(): boolean {
  return activeEngine === "youtube" || (activeEngine === "native" && Boolean(nativeVideoId));
}

// Gapless: while playing, the song keeps going natively and the video loads
// muted; once the video is really playing at the same spot, sound hands over.
let videoHandover: { trackId: string; attempts: number; timer: ReturnType<typeof setTimeout> } | null = null;

export function isVideoPending(): boolean {
  return videoHandover !== null;
}

function cancelHandover(): void {
  if (!videoHandover) return;
  clearTimeout(videoHandover.timer);
  videoHandover = null;
  yt?.pauseVideo?.();
  if (yt?.isMuted?.()) yt.unMute();
}

function continueHandover(player: YT.Player): void {
  const h = videoHandover!;
  if (currentTrackId !== h.trackId || activeEngine !== "native") {
    cancelHandover();
    return;
  }
  const target = nativePositionNow();
  // Too far off (the video took a while to load): jump closer, stay muted, retry.
  if (Math.abs(player.getCurrentTime() - target) > 0.35 && h.attempts < 2) {
    h.attempts += 1;
    player.seekTo(target + 0.15, true);
    return;
  }
  clearTimeout(h.timer);
  videoHandover = null;
  setEngine("youtube"); // first, so the native "paused" event is ignored
  videoFromNative = true;
  nativePlaying = false;
  player.unMute();
  void nativeAudio.pause().catch(() => undefined);
  hideCaptions(player);
  startProgressPolling();
  onPlaybackStarted();
}

// The song's real music video (the audio upload is usually a still picture).
// Looked up natively, once per song, in the background while it plays.
const musicVideos = new Map<string, Promise<string | null>>();

function findMusicVideo(item: Item): Promise<string | null> {
  let job = musicVideos.get(item.id);
  if (!job) {
    job = nativeAudio
      .musicVideo({ ...toNativeTrack(item), audioSec: nativeDuration })
      .then((r) => r.videoId || null)
      .catch(() => null);
    musicVideos.set(item.id, job);
  }
  return job;
}

/** The video to show for the native song: the music video if there's one. */
async function videoForNative(item: Item | undefined): Promise<string | null> {
  if (!item) return nativeVideoId;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
  return (await Promise.race([findMusicVideo(item), timeout])) || nativeVideoId;
}

export async function startVideo(): Promise<void> {
  if (activeEngine !== "native" || !nativeVideoId || !currentTrackId) return;
  const id = currentTrackId;
  const videoId = await videoForNative(trackRegistry.get(id));
  if (currentTrackId !== id || activeEngine !== "native" || !videoId) return;
  const position = getPosition();
  const wasPlaying = nativePlaying;
  const player = await getYoutubePlayer();
  if (currentTrackId !== id || activeEngine !== "native") return;

  if (wasPlaying) {
    cancelHandover();
    player.mute();
    videoHandover = {
      trackId: id,
      attempts: 0,
      // Video never started (network, blocked video): stay on audio.
      timer: setTimeout(() => {
        cancelHandover();
        bus.emit("videounavailable", undefined);
      }, 12000),
    };
    player.loadVideoById(videoId, getPosition() + 0.5);
    return;
  }

  // Switch engines before pausing, so the native "paused" event is ignored.
  setEngine("youtube");
  videoFromNative = true;
  nativePlaying = false;
  void nativeAudio.pause().catch(() => undefined);
  player.loadVideoById(videoId, position);
  if (!wasPlaying) setTimeout(() => player.pauseVideo(), 300);
  startProgressPolling();
}

export function stopVideo(): void {
  if (videoHandover) {
    cancelHandover();
    return;
  }
  if (!videoFromNative || activeEngine !== "youtube" || !yt) return;
  const position = yt.getCurrentTime() || 0;
  const wasPlaying = yt.getPlayerState() === window.YT.PlayerState.PLAYING;
  videoFromNative = false;
  setEngine("native"); // before pausing, so YouTube's "paused" event is ignored
  clearInterval(progressTimer);
  finishSeekMute();
  nativePosition = position;
  nativePositionAt = Date.now();
  void nativeAudio.seek({ position }).catch(() => undefined);
  if (wasPlaying) {
    // Start the saved audio first (it's instant), then stop the video, so
    // there's no silent gap in between.
    void nativeAudio.resume().catch(() => undefined);
    const player = yt;
    setTimeout(() => {
      if (activeEngine === "native") player.pauseVideo();
    }, 150);
  } else {
    yt.pauseVideo();
    onPlaybackPaused();
  }
}

export function togglePlayback(): void {
  if (resumeGoesToNext) {
    resumeGoesToNext = false;
    if (hasNext()) {
      void playNextInQueue();
      return;
    }
    seekTo(0);
  }
  if (activeEngine === "native") {
    void (nativePlaying ? nativeAudio.pause() : nativeAudio.resume()).catch(() => undefined);
  } else if (activeEngine === "youtube" && yt) {
    if (yt.getPlayerState() === window.YT.PlayerState.PLAYING) yt.pauseVideo();
    else yt.playVideo();
  } else if (audio.paused) {
    audio.play().catch(() => onPlaybackPaused());
  } else {
    audio.pause();
  }
}

export function play(): void {
  if (currentTrackId && !isPlaying()) togglePlayback();
}

export function pause(): void {
  if (currentTrackId && isPlaying()) togglePlayback();
}

export function seekTo(seconds: number): void {
  if (!currentTrackId) return;
  const duration = getDuration();
  const target = Math.max(0, duration > 0 ? Math.min(seconds, duration - 0.25) : seconds);
  if (activeEngine === "native") {
    nativePosition = target;
    nativePositionAt = Date.now();
    void nativeAudio.seek({ position: target }).catch(() => undefined);
  } else if (activeEngine === "youtube" && yt) {
    if (isPlaying()) startSeekMute();
    yt.seekTo(target, true);
  } else if (Number.isFinite(audio.duration)) {
    audio.currentTime = target;
  } else {
    return;
  }
  pendingSeek = { target, until: Date.now() + 4000 };
  emitProgress();
  bus.emit("seeked", undefined);
}

/** Everything the notification / media keys need to show. */
export function getSnapshot(): {
  item: Item | undefined;
  playing: boolean;
  position: number;
  duration: number;
  hasNext: boolean;
  hasPrevious: boolean;
} {
  const item = currentTrackId ? trackRegistry.get(currentTrackId) : undefined;
  return {
    item,
    playing: isPlaying(),
    position: getPosition(),
    duration: getDuration(),
    hasNext: hasNext(),
    // Always offered: on the first song it restarts the track.
    hasPrevious: Boolean(item),
  };
}

export function initPlayer(): void {
  initNativeEngine();

  // Play buttons are re-created on every render, so delegate from document.
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>(".play-overlay, .playlist-row-play");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    queueFromElement(btn);
    void playTrack(btn.dataset.id!);
  });

  // Keyboard on laptop: Space = play/pause, Shift+←/→ = previous/next.
  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (!currentTrackId || target.closest("input, textarea, [contenteditable]")) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlayback();
    } else if (e.shiftKey && e.code === "ArrowRight") {
      void playNext();
    } else if (e.shiftKey && e.code === "ArrowLeft") {
      void playPrevious();
    }
  });
}
