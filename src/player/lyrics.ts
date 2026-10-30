// Lyrics overlay: fetches on open, follows track changes, highlights the
// current line of synced lyrics as playback progresses.
import { fetchLyrics } from "../api/lyrics";
import { bus, trackRegistry } from "../state";
import type { Item, Lyrics } from "../types";
import { $, escapeHtml, storage } from "../utils";
import { getCurrentTrackId, getDuration, getPosition } from "./player";
import { pushStep, removeStep } from "../ui/back";

const toggleBtn = $("lyrics-toggle-btn");
const overlay = $("lyrics-overlay");
const closeBtn = $("lyrics-close");
const trackName = $("lyrics-track-name");
const trackArtist = $("lyrics-track-artist");
const body = $("lyrics-body");
const timingEl = $("lyrics-timing");
const timingValue = $("lyrics-timing-value");

// "Lyrics a bit early/late?" nudge, remembered per song.
// Positive = lyrics show later.
const OFFSETS_KEY = "groov:lyrics-offsets";
const offsets = storage.get<Record<string, number>>(OFFSETS_KEY, {});
let offset = 0;

function setOffset(value: number): void {
  const id = getCurrentTrackId();
  // Round down: the tapped line must count as already started.
  offset = Math.floor(value * 10 + 1e-6) / 10;
  if (id) {
    if (offset) offsets[id] = offset;
    else delete offsets[id];
    storage.set(OFFSETS_KEY, offsets);
  }
  renderTiming();
  activeLineIndex = -2; // force a redraw
  highlight(getPosition());
}

function renderTiming(): void {
  timingEl.style.display = currentLyrics?.synced ? "flex" : "none";
  timingValue.textContent = offset ? `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s · reset` : "Tap the line being sung";
}

let currentLyrics: Lyrics | null = null;
let activeLineIndex = -1;

const isOpen = () => overlay.style.display !== "none";

function render(): void {
  if (!currentLyrics || (!currentLyrics.plain && !currentLyrics.synced)) {
    body.innerHTML = `<p class="lyrics-empty">No lyrics found for this track.</p>`;
    return;
  }
  if (currentLyrics.synced) {
    body.innerHTML = currentLyrics.synced
      .map((line, i) => `<div class="lyrics-line" data-index="${i}">${escapeHtml(line.text || "♪")}</div>`)
      .join("");
  } else {
    body.innerHTML = `<p>${escapeHtml(currentLyrics.plain).replace(/\n/g, "<br>")}</p>`;
  }
}

async function load(item: Item): Promise<void> {
  trackName.textContent = item.name || "";
  trackArtist.textContent = item.subtitle || "";
  body.innerHTML = `<p class="lyrics-empty">Loading lyrics…</p>`;
  currentLyrics = null;
  activeLineIndex = -1;
  offset = offsets[item.id] ?? 0;
  renderTiming();

  const lyrics = await fetchLyrics(item, getDuration());
  if (getCurrentTrackId() !== item.id || !isOpen()) return;
  currentLyrics = lyrics;
  render();
  renderTiming();
  highlight(getPosition());
}

export function openLyrics(): void {
  const id = getCurrentTrackId();
  const item = id ? trackRegistry.get(id) : undefined;
  if (!item) return;
  overlay.style.display = "flex";
  pushStep("lyrics", close);
  void load(item);
}

function close(): void {
  removeStep("lyrics");
  overlay.style.display = "none";
}

function highlight(currentTime: number): void {
  if (!currentLyrics?.synced || !isOpen()) return;
  let newIndex = -1;
  for (let i = 0; i < currentLyrics.synced.length; i++) {
    if (currentLyrics.synced[i].time + offset <= currentTime) newIndex = i;
    else break;
  }
  if (newIndex === activeLineIndex) return;
  activeLineIndex = newIndex;
  const lines = body.querySelectorAll(".lyrics-line");
  lines.forEach((el) => el.classList.remove("active"));
  const activeEl = lines[newIndex];
  if (activeEl) {
    activeEl.classList.add("active");
    activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

export function initLyrics(): void {
  toggleBtn.addEventListener("click", openLyrics);
  closeBtn.addEventListener("click", close);
  $("lyrics-earlier").addEventListener("click", () => setOffset(offset - 0.5));
  $("lyrics-later").addEventListener("click", () => setOffset(offset + 0.5));
  timingValue.addEventListener("click", () => offset && setOffset(0));
  // Out of sync? Tap the line that's being sung right now: it lines up.
  body.addEventListener("click", (e) => {
    const line = (e.target as Element).closest<HTMLElement>(".lyrics-line");
    const synced = currentLyrics?.synced;
    if (!line || !synced) return;
    const lineTime = synced[Number(line.dataset.index)]?.time;
    if (lineTime === undefined) return;
    setOffset(getPosition() - lineTime);
    bus.emit("toast", offset ? `Lyrics synced (${offset > 0 ? "+" : ""}${offset.toFixed(1)}s)` : "Lyrics in sync");
  });
  bus.on("trackchange", (item) => {
    currentLyrics = null;
    activeLineIndex = -1;
    if (isOpen()) void load(item);
  });
  bus.on("progress", ({ currentTime }) => highlight(currentTime));
}
