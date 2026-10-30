// The ⋯ song menu: Play next, Add to queue, Like, Radio, Add to playlist.
// On a phone it's a bottom sheet (always fits, scrolls); on a laptop a
// small menu next to the button, flipped up when there's no room below.
import { addTrackToPlaylist, createPlaylist, getPlaylists, removeTrackFromPlaylist } from "../library/playlists";
import {
  addToQueueEnd,
  getCurrentTrackId,
  isTrackPlaying,
  playItem,
  playNextInsert,
  queueFromElement,
  playTrack,
} from "../player/player";
import { startRadio } from "../player/radio";
import { isLiked, isLikedPlaylist, toggleLike } from "../library/liked";
import { bus, trackRegistry } from "../state";
import { $, escapeHtml } from "../utils";
import { pushStep, removeStep } from "./back";
import { markManual } from "./queue";

const popover = $("add-to-playlist-popover");
const backdrop = document.createElement("div");
backdrop.className = "popover-backdrop";
document.body.appendChild(backdrop);

const isPhone = () => window.matchMedia("(max-width: 700px)").matches;

function close(): void {
  removeStep("popover");
  popover.style.display = "none";
  popover.innerHTML = "";
  popover.classList.remove("sheet");
  backdrop.style.display = "none";
}

function place(anchorEl: HTMLElement): void {
  popover.style.top = popover.style.left = popover.style.bottom = popover.style.maxHeight = "";
  if (isPhone()) {
    popover.classList.add("sheet");
    backdrop.style.display = "block";
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  const width = popover.offsetWidth || 240;
  const below = window.innerHeight - rect.bottom - 16;
  const above = rect.top - 16;
  popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 16))}px`;
  if (below >= 320 || below >= above) {
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.maxHeight = `${Math.max(160, below)}px`;
  } else {
    popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    popover.style.maxHeight = `${Math.max(160, above)}px`;
  }
}

/** Play this song now, as part of the list it's shown in (if any). */
function playNow(trackId: string, anchorEl: HTMLElement): void {
  const btn = anchorEl
    .closest(".playlist-row, .card, .top-result-card")
    ?.querySelector<HTMLElement>(".playlist-row-play, .play-overlay");
  if (btn && !isTrackPlaying(trackId)) btn.click();
  else if (!btn) void playItem(trackRegistry.get(trackId)!);
}

/** playlistId: opened from a song in that playlist (offers "Remove from …"). */
export function openAddToPlaylist(trackId: string, anchorEl: HTMLElement, playlistId?: string): void {
  const item = trackRegistry.get(trackId);
  if (!item) return;
  const inPlaylist = playlistId ? getPlaylists()[playlistId] : undefined;
  const playlists = getPlaylists();
  // Liked Songs has its own ❤️ action; other playlists listed below it.
  const ids = Object.keys(playlists).filter((id) => !isLikedPlaylist(playlists[id]));
  const liked = isLiked(trackId);
  // The song that's playing can't come up after itself.
  const isCurrent = getCurrentTrackId() === trackId;

  let html = `
    <div class="popover-title"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.subtitle)}</small></div>
    ${
      isCurrent
        ? ""
        : `<button class="popover-action" data-action="now">▶ Play now</button>
           <button class="popover-action" data-action="next">⤵ Play next</button>
           <button class="popover-action" data-action="queue">➕ Add to queue</button>`
    }
    <button class="popover-action" data-action="like">${liked ? "💔 Remove from Liked Songs" : "❤️ Like"}</button>
    <button class="popover-action" data-action="radio">📻 Start radio</button>
    ${
      inPlaylist
        ? `<button class="popover-action danger" data-action="remove">🗑 Remove from "${escapeHtml(inPlaylist.name)}"</button>`
        : ""
    }
    <div class="popover-divider"></div>
    <div class="popover-label">Add to playlist</div>
  `;
  html += ids.length
    ? ids
        .map((id) => {
          const checked = playlists[id].tracks.some((t) => t.id === trackId);
          return `<button class="popover-item${checked ? " checked" : ""}" data-playlist="${escapeHtml(id)}">${escapeHtml(playlists[id].name)}</button>`;
        })
        .join("")
    : `<div class="playlist-nav-empty">No playlists yet — create one below.</div>`;
  html += `
    <div class="popover-divider"></div>
    <form class="popover-new-form">
      <input type="text" placeholder="New playlist name" maxlength="60" autocomplete="off" />
      <button type="submit">Create</button>
    </form>
  `;
  popover.innerHTML = html;

  popover.style.display = "block";
  pushStep("popover", close);
  place(anchorEl);
  popover.scrollTop = 0;

  popover.querySelectorAll<HTMLElement>(".popover-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "now") playNow(item.id, anchorEl);
      else if (action === "remove" && playlistId) {
        removeTrackFromPlaylist(playlistId, item.id);
        bus.emit("toast", `Removed from "${inPlaylist?.name ?? "playlist"}"`);
      } else if (action === "next") {
        playNextInsert(item);
        markManual(item.id);
        bus.emit("toast", `▶ "${item.name}" plays next`);
      } else if (action === "queue") {
        addToQueueEnd(item);
        markManual(item.id);
        bus.emit("toast", `➕ Added "${item.name}" to the queue`);
      } else if (action === "like") toggleLike(item);
      else if (action === "radio") void startRadio(item);
      close();
    });
  });

  popover.querySelectorAll<HTMLElement>(".popover-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pid = btn.dataset.playlist!;
      if (btn.classList.contains("checked")) removeTrackFromPlaylist(pid, trackId);
      else {
        addTrackToPlaylist(pid, item);
        bus.emit("toast", `Added to "${getPlaylists()[pid]?.name ?? "playlist"}"`);
      }
      close();
    });
  });

  popover.querySelector<HTMLFormElement>(".popover-new-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = (e.currentTarget as HTMLFormElement).querySelector("input")!.value.trim();
    if (!name) return;
    addTrackToPlaylist(createPlaylist(name), item);
    bus.emit("toast", `Created "${name}" with this song`);
    close();
  });
}

export function initPopover(): void {
  document.addEventListener("click", (e) => {
    const target = e.target as Element;
    const addBtn = target.closest<HTMLElement>(".add-overlay");
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      openAddToPlaylist(addBtn.dataset.id!, addBtn, addBtn.dataset.playlist);
      return;
    }
    // Tap anywhere on a song row to play it (not its buttons or links).
    const row = target.closest<HTMLElement>(".playlist-row");
    if (row && !target.closest("button, a, input") && popover.style.display === "none") {
      const play = row.querySelector<HTMLElement>(".playlist-row-play");
      if (play && !isTrackPlaying(play.dataset.id!)) play.click();
      return;
    }
    if (popover.style.display !== "none" && !popover.contains(target)) close();
  });
  // A laptop window resized: the menu would be in the wrong place. (Not on
  // phones: the keyboard opening resizes the screen, and that's no reason.)
  window.addEventListener("resize", () => {
    if (popover.style.display === "none" || popover.classList.contains("sheet")) return;
    if (popover.contains(document.activeElement)) return;
    close();
  });

  // Long-press a song (card or row) to open its menu, like other music apps.
  document.addEventListener("contextmenu", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("a.card[data-id], a.top-result-card[data-id], .playlist-row");
    if (!el) return;
    const id = el.dataset.id ?? el.querySelector<HTMLElement>("[data-id]")?.dataset.id;
    if (!id || !trackRegistry.has(id)) return;
    e.preventDefault();
    openAddToPlaylist(id, el, el.querySelector<HTMLElement>("[data-playlist]")?.dataset.playlist);
  });

  // A plain click on a track card plays it in-app instead of following the
  // link out to YouTube/Apple Music; the href stays for long-press/new-tab.
  // Registered after the play/add handlers so their preventDefault is seen.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    const link = (e.target as Element).closest<HTMLElement>("a.card[data-id], a.top-result-card[data-id]");
    if (!link) return;
    e.preventDefault();
    queueFromElement(link);
    void playTrack(link.dataset.id!);
  });
}
