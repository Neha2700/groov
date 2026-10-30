// HTML for cards, the top result and playlist rows. Rendering a track also
// registers it so play/add buttons can find it by id.
import { getCachedVideoId } from "../api/youtube";
import { isTrackPlaying } from "../player/player";
import { registerTrack } from "../state";
import { isSongDownloaded } from "../library/downloads";
import { icons } from "./icons";
import type { Category, Item } from "../types";
import { escapeHtml, formatTime } from "../utils";

/**
 * Card links stay for long-press / open-in-new-tab. A cached YouTube match is
 * preferred, but we no longer look one up just to render a link: that cost
 * 100 quota units per visible card and burned the daily quota in minutes.
 */
export function trackLinkUrl(item: Item, category: Category): string {
  if (category === "tracks") {
    const cachedId = getCachedVideoId(item.id);
    if (cachedId) return `https://www.youtube.com/watch?v=${cachedId}`;
  }
  return item.externalUrl || "#";
}

function artMarkup(item: Item, category: Category, sizeClass: string): string {
  const roundClass = category === "artists" ? "round" : "";
  if (item.artwork) {
    return `<img class="art ${sizeClass} ${roundClass}" src="${escapeHtml(item.artwork)}" alt="" loading="lazy" />`;
  }
  const icon = category === "tracks" ? "🎵" : category === "albums" ? "💿" : "🧑‍🎤";
  return `<div class="art ${sizeClass} ${roundClass} art-fallback">${icon}</div>`;
}

function playButton(cls: string, id: string): string {
  const playing = isTrackPlaying(id);
  return `<button class="${cls}${playing ? " is-playing" : ""}" data-id="${escapeHtml(id)}" aria-label="${playing ? "Pause" : "Play"}">${playing ? icons.pause : icons.play}</button>`;
}

function trackButtonsMarkup(item: Item, category: Category): string {
  if (category !== "tracks") return "";
  registerTrack(item);
  let html = "";
  // Every song is playable: full songs on Android, YouTube or the preview elsewhere.
  html += playButton("play-overlay", item.id);
  html += `<button class="add-overlay" data-id="${escapeHtml(item.id)}" aria-label="More: queue, like, playlists">${icons.more}</button>`;
  return html;
}

/** Tracks play; albums and artists open their page in the app. */
function linkAttrs(item: Item, category: Category): string {
  if (category === "tracks") return ` data-id="${escapeHtml(item.id)}"`;
  if (category === "albums" && item.collectionId) return ` data-album="${item.collectionId}"`;
  if (category === "artists" && item.artistId) {
    return ` data-artist="${item.artistId}" data-artist-name="${escapeHtml(item.name)}"`;
  }
  return "";
}

export function cardMarkup(item: Item, category: Category): string {
  const idAttr = linkAttrs(item, category);
  return `
    <a class="card" href="${escapeHtml(trackLinkUrl(item, category))}" target="_blank" rel="noopener noreferrer"${idAttr}>
      <div class="card-art-wrap">
        ${artMarkup(item, category, "")}
        ${trackButtonsMarkup(item, category)}
      </div>
      <div class="card-title">${escapeHtml(item.name)}</div>
      <div class="card-subtitle">${escapeHtml(item.subtitle)}</div>
    </a>
  `;
}

export function topResultMarkup(item: Item, category: Category): string {
  const idAttr = linkAttrs(item, category);
  return `
    <h2 class="section-title">Top result</h2>
    <a class="top-result-card" href="${escapeHtml(trackLinkUrl(item, category))}" target="_blank" rel="noopener noreferrer"${idAttr}>
      <div class="card-art-wrap">
        ${artMarkup(item, category, "large")}
        ${trackButtonsMarkup(item, category)}
      </div>
      <div class="top-result-name">${escapeHtml(item.name)}</div>
      <div class="top-result-subtitle">${escapeHtml(item.topSubtitle)}</div>
    </a>
  `;
}

/** A numbered song row for artist and album pages (play button + song menu). */
export function trackRowMarkup(item: Item, index: number, showArt = true): string {
  registerTrack(item);
  const art = showArt
    ? item.artwork
      ? `<img class="playlist-row-art" src="${escapeHtml(item.artwork)}" alt="" loading="lazy" />`
      : `<div class="playlist-row-art art-fallback">🎵</div>`
    : `<div class="track-number">${index + 1}</div>`;
  const length = item.durationMs ? formatTime(item.durationMs / 1000) : "";
  return `
    <div class="playlist-row">
      <div class="playlist-row-art-wrap">
        ${art}
        ${playButton("playlist-row-play", item.id)}
      </div>
      <div class="playlist-row-info">
        <div class="playlist-row-name">${escapeHtml(item.name)}</div>
        <div class="playlist-row-subtitle">${isSongDownloaded(item.id) ? `<span class="dl-badge" title="Downloaded">⬇</span>` : ""}${escapeHtml(item.subtitle)}${length ? ` · ${length}` : ""}</div>
      </div>
      <button class="add-overlay row-add" data-id="${escapeHtml(item.id)}" aria-label="More">${icons.more}</button>
    </div>
  `;
}

/** addedBy: "added by Neha" on shared playlists (omit for your own songs). */
export function playlistRowMarkup(playlistId: string, item: Item, addedBy?: string): string {
  registerTrack(item);
  const art = item.artwork
    ? `<img class="playlist-row-art" src="${escapeHtml(item.artwork)}" alt="" />`
    : `<div class="playlist-row-art art-fallback">🎵</div>`;
  return `
    <div class="playlist-row">
      <div class="playlist-row-art-wrap">
        ${art}
        ${playButton("playlist-row-play", item.id)}
      </div>
      <div class="playlist-row-info">
        <div class="playlist-row-name">${escapeHtml(item.name)}</div>
        <div class="playlist-row-subtitle">${isSongDownloaded(item.id) ? `<span class="dl-badge" title="Downloaded">⬇</span>` : ""}${escapeHtml(item.subtitle)}${
          addedBy ? ` · <span class="playlist-row-added-by">added by ${escapeHtml(addedBy)}</span>` : ""
        }</div>
      </div>
      <button class="add-overlay row-add" data-id="${escapeHtml(item.id)}" data-playlist="${escapeHtml(playlistId)}" aria-label="More: queue, remove, playlists">${icons.more}</button>
    </div>
  `;
}

export function sectionMarkup(title: string, items: Item[]): string {
  return `
    <div class="category-section">
      <h2 class="section-title">${escapeHtml(title)}</h2>
      <div class="card-grid card-row">${items.map((item) => cardMarkup(item, "tracks")).join("")}</div>
    </div>
  `;
}

/**
 * "Arijit Singh, Shreya Ghoshal & Pritam" → one link per artist. The first
 * opens straight away (we know their id); the others are looked up by name.
 */
export function splitArtists(subtitle: string): string[] {
  const parts = subtitle
    .split(/\s*,\s*|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [subtitle];
}

export function artistLinksMarkup(subtitle: string, artistId?: number | null): string {
  return splitArtists(subtitle)
    .map(
      (name, i) =>
        `<a class="artist-link" href="#" data-artist="${i === 0 && artistId ? artistId : ""}" data-artist-name="${escapeHtml(name)}">${escapeHtml(name)}</a>`,
    )
    .join(", ");
}

// --- Sideways rows: ‹ › buttons on a laptop (phones just swipe) -------------------

function addRowArrows(row: HTMLElement): void {
  if (row.dataset.arrows || !row.parentElement) return;
  row.dataset.arrows = "1";
  const wrap = document.createElement("div");
  wrap.className = "card-row-wrap";
  row.parentElement.insertBefore(wrap, row);
  wrap.appendChild(row);
  for (const dir of [-1, 1]) {
    const btn = document.createElement("button");
    btn.className = `row-arrow ${dir < 0 ? "left" : "right"}`;
    btn.setAttribute("aria-label", dir < 0 ? "Scroll left" : "Scroll right");
    btn.textContent = dir < 0 ? "‹" : "›";
    btn.addEventListener("click", () => row.scrollBy({ left: dir * row.clientWidth * 0.85, behavior: "smooth" }));
    wrap.appendChild(btn);
  }
  const update = () => {
    wrap.classList.toggle("at-start", row.scrollLeft < 8);
    wrap.classList.toggle("at-end", row.scrollLeft + row.clientWidth > row.scrollWidth - 8);
  };
  row.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(row);
  new MutationObserver(update).observe(row, { childList: true });
  update();
}

export function initRows(): void {
  document.querySelectorAll<HTMLElement>(".card-row").forEach(addRowArrows);
  new MutationObserver(() => document.querySelectorAll<HTMLElement>(".card-row:not([data-arrows])").forEach(addRowArrows)).observe(
    document.body,
    { childList: true, subtree: true },
  );
}
