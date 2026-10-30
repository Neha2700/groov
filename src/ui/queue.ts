// "Up next" sheet: what's coming, drag ≡ to reorder, ✕ to remove, tap to
// jump to a song. Songs you queued by hand are marked "queued".
import {
  getCurrentTrackId,
  getPlayedBefore,
  getQueueInfo,
  getQueueLabel,
  getRepeatMode,
  getUpcoming,
  moveUpcoming,
  playBack,
  playUpcoming,
  removeUpcoming,
} from "../player/player";
import {
  getAutoplayPreview,
  getRadioSeed,
  favouriteIds,
  isAutoplayLoading,
  isAutoplayOn,
  playFromAutoplay,
  removeFromAutoplay,
} from "../player/radio";
import { addTrackToPlaylist, createPlaylist, getPlaylists } from "../library/playlists";
import { bus, trackRegistry } from "../state";
import type { Item } from "../types";
import { $, escapeHtml, formatTime } from "../utils";
import { pushStep, removeStep } from "./back";

const sheet = $("queue-sheet");
const list = $("queue-list");
const nowEl = $("queue-now");
/** How many upcoming songs to draw (radio can be long). */
const MAX_ROWS = 60;

const isOpen = () => sheet.style.display !== "none";

let manualIds = new Set<string>();

/** Songs queued by hand, so they can be labelled (tracked from the events). */
export function markManual(id: string): void {
  manualIds.add(id);
}

function rowMarkup(item: Item, attrs: string, cls: string, left: string, right: string): string {
  const art = item.artwork
    ? `<img class="queue-art" src="${escapeHtml(item.artwork)}" alt="" loading="lazy" />`
    : `<div class="queue-art"></div>`;
  const length = item.durationMs ? ` · ${formatTime(item.durationMs / 1000)}` : "";
  return `
    <div class="queue-row ${cls}" ${attrs}>
      ${left}
      <div class="queue-art-wrap">${art}</div>
      <div class="queue-info">
        <div class="queue-name">${escapeHtml(item.name)}</div>
        <div class="queue-artist">${favouriteIds.has(item.id) ? `<span class="queue-fav">♥ Your favourite</span> · ` : ""}${escapeHtml(item.subtitle)}${length}</div>
      </div>
      ${right}
    </div>`;
}

function autoplayMarkup(): string {
  const { source } = getQueueInfo();
  if (source !== "list") return "";
  if (!isAutoplayOn()) {
    return `<div class="queue-section"><div class="queue-section-title">Autoplay is off</div>
      <div class="queue-section-sub">Turn it on in Settings to keep the music going after your list.</div></div>`;
  }
  if (getRepeatMode() !== "off") return "";
  const shown = getAutoplayPreview();
  const header = (sub: string) => `
    <div class="queue-section">
      <div class="queue-section-title">Autoplay</div>
      <div class="queue-section-sub">${sub}</div>
    </div>`;
  if (!shown) {
    return isAutoplayLoading()
      ? header("Finding songs to play after your list…")
      : `<div class="queue-section"><div class="queue-section-title">Autoplay</div>
         <div class="queue-section-sub">Songs like the last one in your list will show here when it's nearly over.</div></div>`;
  }
  const rows = shown.items
    .slice(0, MAX_ROWS)
    .map((item) =>
      rowMarkup(
        item,
        `data-auto="${escapeHtml(item.id)}"`,
        "auto",
        `<span class="queue-handle placeholder"></span>`,
        `<button class="queue-remove" data-auto-remove="${escapeHtml(item.id)}" aria-label="Remove">✕</button>`,
      ),
    )
    .join("");
  return (
    header(`More like your list · plays when it ends`) +
    (rows || `<div class="queue-empty">You removed them all. More will come when your list ends.</div>`)
  );
}

function render(): void {
  if (!isOpen()) return;
  const current = getCurrentTrackId();
  const now = current ? trackRegistry.get(current) : undefined;
  const radio = getRadioSeed();
  nowEl.textContent = radio && getQueueLabel() === "Radio" ? `Radio · ${radio}` : getQueueLabel();

  const played = getPlayedBefore(3)
    .map((id, i, all) => {
      const item = trackRegistry.get(id);
      return item
        ? rowMarkup(item, `data-back="${all.length - i}"`, "played", `<span class="queue-handle placeholder"></span>`, "")
        : "";
    })
    .join("");
  const nowRow = now
    ? rowMarkup(now, "", "current", `<span class="queue-handle placeholder"></span>`, `<span class="queue-eq" aria-label="Playing"><i></i><i></i><i></i></span>`)
    : "";
  const upcoming = getUpcoming()
    .slice(0, MAX_ROWS)
    .map((id, i) => {
      const item = trackRegistry.get(id);
      if (!item) return "";
      return rowMarkup(
        item,
        `data-index="${i}"`,
        `${manualIds.has(id) ? "manual" : ""}`,
        `<button class="queue-handle" aria-label="Drag to reorder">≡</button>`,
        `<button class="queue-remove" data-remove="${i}" aria-label="Remove">✕</button>`,
      ).replace('<div class="queue-info">', `<div class="queue-info" data-play="${i}">`);
    })
    .join("");
  const auto = autoplayMarkup();
  const empty =
    !upcoming && !auto
      ? `<div class="queue-empty">Nothing up next. Use ⋯ on any song → "Add to queue", or start 📻 Radio.</div>`
      : "";
  list.innerHTML = played + nowRow + upcoming + empty + auto;
  playedCount = getPlayedBefore(3).length;
  // Keep the playing song in view, with the played ones just above it.
  if (scrollOnRender) {
    scrollOnRender = false;
    list.querySelector(".queue-row.current")?.scrollIntoView({ block: "start" });
    if (playedCount) list.scrollTop = Math.max(0, list.scrollTop - 4);
  }
}

let playedCount = 0;
let scrollOnRender = false;

async function saveQueue(): Promise<void> {
  const current = getCurrentTrackId();
  const ids = [...(current ? [current] : []), ...getUpcoming()];
  if (!ids.length) return;
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const base = getQueueLabel() === "Your queue" ? "My queue" : getQueueLabel();
  const name = `${base} · ${date}`;
  const id = Object.values(getPlaylists()).find((p) => p.name === name)?.id ?? createPlaylist(name);
  ids.forEach((tid) => {
    const item = trackRegistry.get(tid);
    if (item) addTrackToPlaylist(id, item);
  });
  bus.emit("toast", `Saved ${ids.length} songs to "${name}"`);
}

function open(): void {
  sheet.style.display = "flex";
  scrollOnRender = true;
  pushStep("queue", close);
  render();
}

function close(): void {
  removeStep("queue");
  sheet.style.display = "none";
}

// --- Drag to reorder (touch + mouse) --------------------------------------------------

function enableDrag(): void {
  let row: HTMLElement | null = null;
  let startY = 0;
  let from = 0;
  let rowHeight = 60;

  list.addEventListener("pointerdown", (e) => {
    const handle = (e.target as Element).closest(".queue-handle");
    if (!handle) return;
    row = handle.closest<HTMLElement>(".queue-row");
    if (!row) return;
    e.preventDefault();
    from = Number(row.dataset.index);
    startY = e.clientY;
    rowHeight = row.getBoundingClientRect().height || 60;
    row.classList.add("dragging");
    (handle as HTMLElement).setPointerCapture(e.pointerId);
  });

  list.addEventListener("pointermove", (e) => {
    if (!row) return;
    row.style.transform = `translateY(${e.clientY - startY}px)`;
  });

  const drop = (e: PointerEvent) => {
    if (!row) return;
    const steps = Math.round((e.clientY - startY) / rowHeight);
    row.classList.remove("dragging");
    row.style.transform = "";
    row = null;
    if (steps !== 0) moveUpcoming(from, from + steps);
  };
  list.addEventListener("pointerup", drop);
  list.addEventListener("pointercancel", drop);
}

export function initQueue(): void {
  $("np-queue").addEventListener("click", open);
  $("queue-close").addEventListener("click", close);
  $("queue-save").addEventListener("click", () => void saveQueue());
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) close();
  });
  list.addEventListener("click", (e) => {
    const target = e.target as Element;
    const remove = target.closest<HTMLElement>("[data-remove]");
    if (remove) {
      removeUpcoming(Number(remove.dataset.remove));
      return;
    }
    // Tap anywhere on a song (not ≡ or ✕) to play it.
    if (target.closest(".queue-handle")) return;
    const play = target.closest<HTMLElement>(".queue-row[data-index]");
    if (play) {
      play.classList.add("starting");
      void playUpcoming(Number(play.dataset.index));
      return;
    }
    const autoRemove = target.closest<HTMLElement>("[data-auto-remove]");
    if (autoRemove) {
      removeFromAutoplay(autoRemove.dataset.autoRemove!);
      return;
    }
    const auto = target.closest<HTMLElement>("[data-auto]");
    if (auto) {
      void playFromAutoplay(auto.dataset.auto!);
      return;
    }
    const back = target.closest<HTMLElement>("[data-back]");
    if (back) void playBack(Number(back.dataset.back));
  });
  enableDrag();
  bus.on("queueupdate", render);
  bus.on("playstate", (playing) => sheet.classList.toggle("paused", !playing));
  // Finding/downloading the song: a spinner on it instead of the bars.
  bus.on("loading", (on) => sheet.classList.toggle("is-loading", on));
  bus.on("trackchange", render);
  bus.on("queuechange", () => {
    manualIds = new Set();
    render();
  });
}
