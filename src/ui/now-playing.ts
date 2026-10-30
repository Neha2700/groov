// The player bar and the full-screen Now Playing view (tap the song in the
// bar to open it). Both render from player events, so they always agree.
import { hiResArtwork } from "../player/media-controls";
import {
  getDuration,
  getEngine,
  isPlaying,
  playNext,
  playPrevious,
  seekTo,
  togglePlayback,
  getCurrentTrackId,
  lastNativeError,
  canShowVideo,
  cycleRepeat,
  getRepeatMode,
  isShuffleOn,
  toggleShuffle,
  isVideoPending,
  startVideo,
  stopVideo,
} from "../player/player";
import { openLyrics } from "../player/lyrics";
import { getRadioSeed, startRadio } from "../player/radio";
import { bus } from "../state";
import type { Item } from "../types";
import { $, cssEscape, formatTime } from "../utils";
import { updateBackgroundArt } from "./layout";
import { openAddToPlaylist } from "./popover";
import { createSeekBar, type SeekBar } from "./seekbar";
import { pushStep, removeStep } from "./back";
import { openArtist } from "./views";
import { artistLinksMarkup } from "./cards";
import { isLiked, toggleLike } from "../library/liked";
import { icons, type IconName } from "./icons";

/** Buttons marked data-icon="…" in the HTML get their SVG icon (kept labels). */
function fillIcons(): void {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    const icon = icons[el.dataset.icon as IconName];
    if (icon && !el.querySelector("svg")) el.insertAdjacentHTML("afterbegin", icon);
  });
}

function setIcon(el: HTMLElement, name: IconName): void {
  const label = el.querySelector("span");
  el.innerHTML = icons[name];
  if (label) el.appendChild(label);
}

const bar = $("player-bar");
const barArt = $<HTMLImageElement>("player-art");
const barName = $("player-name");
const barArtist = $("player-artist");
const barToggle = $("player-toggle");
const barElapsed = $("player-time-elapsed");
const barTotal = $("player-time-total");

const np = $("now-playing");
const npBg = $("np-bg");
const npArtSlot = $("np-art-slot");
const npArt = $<HTMLImageElement>("np-art");
const npTitle = $("np-title");
const npArtist = $("np-artist");
const npElapsed = $("np-elapsed");
const npTotal = $("np-total");
const npToggle = $("np-toggle");
const npVideoBtn = $("np-video");
const npLabel = document.querySelector<HTMLElement>(".np-label")!;
const ytHost = $("yt-host");
const miniFill = $("player-mini-fill");

let currentItem: Item | null = null;
let videoMode = false;
const seekBars: SeekBar[] = [];

const isOpen = () => np.style.display !== "none";

// --- Rendering -------------------------------------------------------------------

function renderTrack(item: Item): void {
  currentItem = item;
  bar.style.display = "grid";
  document.body.classList.add("has-player");

  const small = hiResArtwork(item.artwork, 200) || "";
  const large = hiResArtwork(item.artwork, 600) || "";
  barArt.src = small;
  barArt.style.visibility = small ? "visible" : "hidden";
  barName.textContent = item.name;
  barArtist.textContent = item.subtitle;

  npArt.src = large;
  npArt.classList.toggle("empty", !large);
  npTitle.textContent = item.name;
  npArtist.innerHTML = artistLinksMarkup(item.subtitle, item.artistId);
  npBg.style.backgroundImage = large ? `url("${large}")` : "";
  updateBackgroundArt(item.artwork);
}

function renderPlayState(playing: boolean): void {
  for (const btn of [barToggle, npToggle]) {
    setIcon(btn, playing ? "pause" : "play");
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  np.classList.toggle("playing", playing);

  // Play buttons on cards and playlist rows.
  document.querySelectorAll<HTMLElement>(".play-overlay.is-playing, .playlist-row-play.is-playing").forEach((b) => {
    b.innerHTML = icons.play;
    b.classList.remove("is-playing");
    b.setAttribute("aria-label", "Play");
  });
  const id = getCurrentTrackId();
  if (playing && id) {
    const sel = cssEscape(id);
    document
      .querySelectorAll<HTMLElement>(`.play-overlay[data-id="${sel}"], .playlist-row-play[data-id="${sel}"]`)
      .forEach((b) => {
        b.innerHTML = icons.pause;
        b.classList.add("is-playing");
        b.setAttribute("aria-label", "Pause");
      });
  }
}

function renderTimes(elapsed: number, duration: number): void {
  const e = formatTime(elapsed);
  const t = duration > 0 ? formatTime(duration) : "0:00";
  barElapsed.textContent = e;
  npElapsed.textContent = e;
  barTotal.textContent = t;
  npTotal.textContent = t;
}

function renderProgress(currentTime: number, duration: number): void {
  const ratio = duration > 0 ? currentTime / duration : 0;
  seekBars.forEach((s) => s.set(ratio));
  miniFill.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
  if (!seekBars.some((s) => s.isDragging())) renderTimes(currentTime, duration);
}

// --- Video mode -------------------------------------------------------------------
// Lays the hidden YouTube player over the artwork slot, 16:9, centered.

function placeVideo(): void {
  if (!videoMode) return;
  const r = npArtSlot.getBoundingClientRect();
  const height = Math.min(r.height, (r.width * 9) / 16);
  const width = (height * 16) / 9;
  Object.assign(ytHost.style, {
    left: `${r.left + (r.width - width) / 2}px`,
    top: `${r.top + (r.height - height) / 2}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
}

async function setVideoMode(on: boolean): Promise<void> {
  if (on && !videoMode && getEngine() === "native") await startVideo();
  if (!on && videoMode) {
    videoMode = false; // first, so the engine switch below doesn't re-enter
    stopVideo();
  }
  // While the video loads, the song keeps playing as audio (isVideoPending).
  videoMode = on && (getEngine() === "youtube" || isVideoPending());
  ytHost.classList.toggle("as-video", videoMode);
  np.classList.toggle("video-mode", videoMode);
  npVideoBtn.classList.toggle("active", videoMode);
  npVideoBtn.setAttribute("aria-label", videoMode ? "Show artwork" : "Show video");
  if (videoMode) placeVideo();
  else ytHost.removeAttribute("style");
}

const ENGINE_LABELS = {
  native: "Full song",
  youtube: "Full song · YouTube",
  audio: "30s preview",
} as const;

function renderModes(): void {
  const repeat = getRepeatMode();
  for (const id of ["np-shuffle", "player-shuffle"]) $(id).classList.toggle("active", isShuffleOn());
  for (const id of ["np-repeat", "player-repeat"]) {
    const repeatBtn = $(id);
    repeatBtn.classList.toggle("active", repeat !== "off");
    setIcon(repeatBtn, repeat === "one" ? "repeatOne" : "repeat");
    repeatBtn.title = repeat === "one" ? "Repeat this song" : repeat === "all" ? "Repeat all" : "Repeat off";
  }
}

function renderEngine(): void {
  const engine = getEngine();
  const radio = getRadioSeed();
  npLabel.textContent = !currentItem
    ? "Now playing"
    : radio
      ? `📻 Radio · ${radio}`
      : `Now playing · ${ENGINE_LABELS[engine]}`;
  npLabel.title = engine !== "native" && lastNativeError ? `Full song failed: ${lastNativeError}` : "";
  npVideoBtn.style.visibility = canShowVideo() ? "visible" : "hidden";
  if (engine === "audio" && videoMode) void setVideoMode(false);
}

// --- Open / close (Android back button closes it too) -----------------------------

function open(): void {
  if (!currentItem || isOpen()) return;
  np.style.display = "flex";
  document.body.classList.add("np-open");
  pushStep("now-playing", close);
  requestAnimationFrame(() => np.classList.add("visible"));
}

function close(): void {
  removeStep("now-playing");
  if (!isOpen()) return;
  void setVideoMode(false);
  np.classList.remove("visible");
  document.body.classList.remove("np-open");
  np.style.display = "none";
}

// --- Init ---------------------------------------------------------------------------

export function initNowPlaying(): void {
  fillIcons();
  const onSeek = (ratio: number) => seekTo(ratio * getDuration());
  const onPreview = (ratio: number) => renderTimes(ratio * getDuration(), getDuration());
  seekBars.push(createSeekBar($("player-seek"), { onSeek, onPreview }));
  seekBars.push(createSeekBar($("np-seek"), { onSeek, onPreview }));

  barToggle.addEventListener("click", () => togglePlayback());
  npToggle.addEventListener("click", () => togglePlayback());
  $("player-prev").addEventListener("click", () => void playPrevious());
  $("player-next").addEventListener("click", () => void playNext());
  $("np-prev").addEventListener("click", () => void playPrevious());
  $("np-next").addEventListener("click", () => void playNext());

  $("player-open").addEventListener("click", open);
  // Tap the label to see why a song fell back from the native full song.
  npLabel.addEventListener("click", () => {
    if (npLabel.title) alert(npLabel.title);
  });
  $("np-close").addEventListener("click", () => close());
  npVideoBtn.addEventListener("click", () => void setVideoMode(!videoMode));
  $("np-lyrics").addEventListener("click", () => openLyrics());
  const likeBtns = [$("np-like"), $("player-like")];
  const renderLike = () => {
    const liked = currentItem ? isLiked(currentItem.id) : false;
    for (const likeBtn of likeBtns) {
      setIcon(likeBtn, liked ? "heartFilled" : "heart");
      likeBtn.classList.toggle("liked", liked);
      likeBtn.setAttribute("aria-label", liked ? "Unlike" : "Like");
    }
  };
  for (const likeBtn of likeBtns) {
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentItem) toggleLike(currentItem);
    });
  }
  $("player-shuffle").addEventListener("click", () => $("np-shuffle").click());
  $("player-repeat").addEventListener("click", () => $("np-repeat").click());
  $("player-queue").addEventListener("click", () => $("np-queue").click());
  bus.on("trackchange", () => setTimeout(renderLike, 0));
  bus.on("artworkchange", (item) => renderTrack(item));
  bus.on("likechange", renderLike);
  bus.on("playlistschange", renderLike);
  // Tap an artist's name to open their page (each artist separately).
  npArtist.classList.add("link");
  npArtist.addEventListener("click", (e) => {
    const link = (e.target as Element).closest<HTMLElement>(".artist-link");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation(); // not the document-wide artist handler too
    close();
    void openArtist(Number(link.dataset.artist) || null, link.dataset.artistName ?? "");
  });
  $("np-shuffle").addEventListener("click", () => {
    toggleShuffle();
    bus.emit("toast", isShuffleOn() ? "🔀 Shuffle on" : "Shuffle off");
  });
  $("np-repeat").addEventListener("click", () => {
    cycleRepeat();
    const mode = getRepeatMode();
    bus.emit("toast", mode === "one" ? "🔂 Repeating this song" : mode === "all" ? "🔁 Repeat all" : "Repeat off");
  });
  $("np-radio").addEventListener("click", () => void startRadio());
  bus.on("modechange", renderModes);
  bus.on("queuechange", () => renderEngine());
  renderModes();
  $("np-add").addEventListener("click", (e) => {
    e.stopPropagation();
    const id = getCurrentTrackId();
    if (id) openAddToPlaylist(id, e.currentTarget as HTMLElement);
  });

  window.addEventListener("resize", placeVideo);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  bus.on("trackchange", (item) => {
    // A new song always starts as audio; hide the video of the old one.
    if (videoMode) {
      videoMode = false;
      ytHost.classList.remove("as-video");
      np.classList.remove("video-mode");
      npVideoBtn.classList.remove("active");
      ytHost.removeAttribute("style");
    }
    renderTrack(item);
  });
  bus.on("playstate", (playing) => renderPlayState(playing));
  bus.on("progress", ({ currentTime, duration }) => renderProgress(currentTime, duration));
  bus.on("enginechange", renderEngine);
  bus.on("videounavailable", () => {
    if (videoMode) void setVideoMode(false);
    npLabel.textContent = "Video unavailable · playing audio";
  });
  bus.on("loading", (loading) => {
    for (const btn of [barToggle, npToggle]) btn.classList.toggle("is-loading", loading);
    if (loading) npLabel.textContent = "Finding the full song…";
    else renderEngine();
  });

  // Cards re-render often; keep their play icons in sync.
  bus.on("playlistschange", () => renderPlayState(isPlaying()));
  renderEngine();
}
