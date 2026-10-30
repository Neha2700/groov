// "Your stats": minutes listened, plays, top songs and top artists for the
// last week, 4 weeks or all time. Built from the play history on the phone.
import { clearHistory, historySize, topArtists, topSongs, totalsSince } from "../library/history";
import { setQueue, playTrack } from "../player/player";
import { bus } from "../state";
import { $, escapeHtml, storage } from "../utils";
import { trackRowMarkup } from "./cards";
import { chooseOption } from "./choice";

const DAY = 86400000;
const PERIODS = [
  { id: "week", label: "7 days", ms: 7 * DAY },
  { id: "month", label: "4 weeks", ms: 28 * DAY },
  { id: "all", label: "All time", ms: Infinity },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

const view = $("stats-view");
let period = storage.get<PeriodId>("groov:stats-period", "month");
let topIds: string[] = [];

const since = () => {
  const p = PERIODS.find((x) => x.id === period)!;
  return p.ms === Infinity ? 0 : Date.now() - p.ms;
};

function formatMinutes(minutes: number): string {
  if (minutes < 120) return `${minutes}`;
  return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`;
}

export function renderStats(): void {
  if (view.style.display === "none") return;
  const tabs = `<div class="stats-tabs" role="tablist">${PERIODS.map(
    (p) => `<button class="stats-tab${p.id === period ? " active" : ""}" data-period="${p.id}">${p.label}</button>`,
  ).join("")}</div>`;

  if (!historySize()) {
    view.innerHTML = `<h1 class="stats-title">📊 Your stats</h1>
      <p class="muted">Nothing here yet. Songs count once they've played for 30 seconds — play some music and come back.</p>`;
    return;
  }

  const from = since();
  const totals = totalsSince(from);
  const songs = topSongs(from, 10);
  const artists = topArtists(from, 8);
  topIds = songs.map((s) => s.item.id);
  const minutesLabel = totals.minutes < 120 ? "minutes" : "listened";

  view.innerHTML = `
    <h1 class="stats-title">📊 Your stats</h1>
    ${tabs}
    <div class="stats-tiles">
      <div class="stats-tile"><div class="stats-num">${formatMinutes(totals.minutes)}</div><div class="stats-label">${minutesLabel}</div></div>
      <div class="stats-tile"><div class="stats-num">${totals.plays}</div><div class="stats-label">plays</div></div>
      <div class="stats-tile"><div class="stats-num">${totals.songs}</div><div class="stats-label">songs</div></div>
      <div class="stats-tile"><div class="stats-num">${totals.artists}</div><div class="stats-label">artists</div></div>
    </div>
    ${
      totals.plays
        ? `
    <div class="section-header">
      <h2 class="section-title">Top songs</h2>
      <button id="stats-play-top" class="text-btn">▶ Play all</button>
    </div>
    <div class="playlist-track-list stats-songs">
      ${songs
        .map(
          (s, i) =>
            `<div class="stats-row"><span class="stats-rank">${i + 1}</span>${trackRowMarkup(s.item, i)}<span class="stats-count">${s.plays}×</span></div>`,
        )
        .join("")}
    </div>
    <h2 class="section-title">Top artists</h2>
    <div class="stats-artists">
      ${artists
        .map(
          (a, i) => `
        <a class="stats-artist" href="#" data-artist="${a.artistId ?? ""}" data-artist-name="${escapeHtml(a.name)}">
          <span class="stats-rank">${i + 1}</span>
          ${a.artwork ? `<img src="${escapeHtml(a.artwork)}" alt="" loading="lazy" />` : `<div class="art-fallback">🎤</div>`}
          <span class="stats-artist-name">${escapeHtml(a.name)}</span>
          <span class="stats-count">${a.plays} plays · ${Math.max(1, Math.round(a.seconds / 60))} min</span>
        </a>`,
        )
        .join("")}
    </div>`
        : `<p class="muted">No plays in this period yet.</p>`
    }
    <button id="stats-clear" class="text-btn stats-clear">Clear listening history</button>
  `;
}

export function initStats(): void {
  view.addEventListener("click", (e) => {
    const target = e.target as Element;
    const tab = target.closest<HTMLElement>("[data-period]");
    if (tab) {
      period = tab.dataset.period as PeriodId;
      storage.set("groov:stats-period", period);
      renderStats();
      return;
    }
    if (target.closest("#stats-play-top") && topIds.length) {
      setQueue(topIds, topIds[0], "list", "Your top songs");
      void playTrack(topIds[0]);
      return;
    }
    if (target.closest("#stats-clear")) {
      void chooseOption("Clear listening history?", [
        { label: "Clear history (stats and Made for you)", value: true, danger: true },
        { label: "Cancel", value: false },
      ]).then((yes) => {
        if (!yes) return;
        clearHistory();
        bus.emit("toast", "Listening history cleared");
      });
    }
  });
  bus.on("historychange", renderStats);
}
