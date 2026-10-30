// Home feed: "Made for you" mixes and recently played (from what you listen
// to), the live top-songs chart, and "Recommended for you" (more from
// artists/genres already in your playlists).
import { fetchArtistTracks, fetchTrendingSongs } from "../api/itunes";
import { OVERVIEW_LIMIT } from "../config";
import { historySize, recentlyPlayed } from "../library/history";
import { loadSimilar } from "../library/similar";
import { cachedMixSongs, getMixes, loadMixSongs, warmMixes, type Mix } from "../library/mixes";
import { getPlaylists } from "../library/playlists";
import { isShuffleOn, playTrack, setQueue } from "../player/player";
import { navigateTo } from "./views";
import { renderFollowedRow } from "./follows-ui";
import { bus, trackRegistry } from "../state";
import type { Item } from "../types";
import { $, escapeHtml } from "../utils";
import { cardMarkup, sectionMarkup } from "./cards";

// --- Made for you -------------------------------------------------------------------

const trendingSection = $("trending-section");
const trendingGrid = $("trending-grid");
const recommendationsSection = $("recommendations-section");
const recommendationsContainer = $("recommendations-container");
const madeSection = $("made-for-you-section");
const madeRow = $("made-for-you");
const recentSection = $("recently-played-section");
const recentGrid = $("recently-played-grid");

export function mixArtMarkup(mix: Mix): string {
  const songs = cachedMixSongs(mix) ?? (mix.seed ? [mix.seed] : []);
  const imgs = [...new Set(songs.map((s) => s.artwork).filter(Boolean) as string[])].slice(0, 4);
  if (imgs.length >= 4) {
    return `<div class="mix-art grid">${imgs.map((src) => `<img src="${escapeHtml(src)}" alt="" loading="lazy" />`).join("")}</div>`;
  }
  return imgs[0]
    ? `<div class="mix-art"><img src="${escapeHtml(imgs[0])}" alt="" loading="lazy" /></div>`
    : `<div class="mix-art art-fallback">🎵</div>`;
}

let mixes: Mix[] = [];

function renderMadeForYou(): void {
  mixes = getMixes();
  madeSection.style.display = mixes.length ? "block" : "none";
  madeRow.innerHTML = mixes
    .map((m) => {
      const songs = cachedMixSongs(m);
      const count = songs ? ` · ${songs.length} songs` : "";
      return `
      <div class="mix-card" data-mix="${m.id}" role="button" tabindex="0">
        ${mixArtMarkup(m)}
        <button class="mix-play" data-mix-play="${m.id}" aria-label="Play ${escapeHtml(m.title)}">▶</button>
        <span class="mix-title">${escapeHtml(m.title)}</span>
        <span class="mix-sub">${escapeHtml(m.subtitle)}${count}</span>
      </div>`;
    })
    .join("");

  const recent = recentlyPlayed(15);
  recentSection.style.display = recent.length >= 2 ? "block" : "none";
  recentGrid.innerHTML = recent.map((item) => cardMarkup(item, "tracks")).join("");
  void warmMixes();
}

/** Play a mix from the top (or a random song when shuffle is on). */
export async function playMix(mix: Mix): Promise<void> {
  let songs: Item[];
  try {
    if (!cachedMixSongs(mix)) bus.emit("toast", `Getting ${mix.title} ready…`);
    songs = await loadMixSongs(mix);
  } catch {
    bus.emit("toast", "Can't load this mix right now");
    return;
  }
  if (!songs.length) return;
  songs.forEach((s) => trackRegistry.set(s.id, s));
  const start = isShuffleOn() ? songs[Math.floor(Math.random() * songs.length)] : songs[0];
  setQueue(
    songs.map((s) => s.id),
    start.id,
    "list",
    mix.title,
  );
  await playTrack(start.id);
  bus.emit("toast", `▶ ${mix.title}`);
}

export function initHome(): void {
  madeRow.addEventListener("click", (e) => {
    const target = e.target as Element;
    const play = target.closest<HTMLElement>("[data-mix-play]");
    if (play) {
      const mix = mixes.find((m) => m.id === play.dataset.mixPlay);
      if (mix) void playMix(mix);
      return;
    }
    const card = target.closest<HTMLElement>("[data-mix]");
    if (card) navigateTo(`mix:${card.dataset.mix}`);
  });
  const refresh = () => {
    if ($("recent-view").style.display !== "none") renderMadeForYou();
  };
  bus.on("historychange", refresh);
  bus.on("mixchange", refresh);
  bus.on("playlistschange", refresh);
}

async function renderTrending(): Promise<void> {
  try {
    const items = await fetchTrendingSongs(OVERVIEW_LIMIT);
    trendingGrid.innerHTML = items.map((item) => cardMarkup(item, "tracks")).join("");
    trendingSection.style.display = items.length ? "block" : "none";
  } catch {
    trendingSection.style.display = "none"; // not a core feature: fail quietly
  }
}

function recommendationSignals() {
  const allTracks = Object.values(getPlaylists()).flatMap((p) => p.tracks);
  const artistCounts = new Map<number, { count: number; name: string }>();
  const genreCounts = new Map<string, number>();
  for (const t of allTracks) {
    if (t.artistId) {
      const current = artistCounts.get(t.artistId) ?? { count: 0, name: t.subtitle };
      current.count += 1;
      artistCounts.set(t.artistId, current);
    }
    if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + 1);
  }
  return { allTracks, artistCounts, genreCounts };
}

async function renderRecommendations(): Promise<void> {
  const { allTracks, artistCounts } = recommendationSignals();
  recommendationsSection.style.display = "block";

  if (!allTracks.length && historySize() < 5) {
    recommendationsContainer.innerHTML = `<p class="muted">Add a few songs to a playlist and recommendations based on them will show up here.</p>`;
    return;
  }

  const savedIds = new Set(allTracks.map((t) => t.id));
  const fresh = <T extends { id: string }>(items: T[]) =>
    items.filter((i) => !savedIds.has(i.id)).slice(0, OVERVIEW_LIMIT);

  const topArtists = [...artistCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 2);

  // Run lookups in parallel; one failing shouldn't blank the others.
  // New artists first: "Similar to [one of your top artists]" (not them).
  const jobs: Promise<string>[] = [
    (async () => {
      const similar = await loadSimilar();
      return similar ? sectionMarkup(`Similar to ${similar.artist}`, similar.items) : "";
    })(),
    ...topArtists.map(async ([artistId, info]) => {
      const items = fresh(await fetchArtistTracks(artistId, OVERVIEW_LIMIT + 4));
      return items.length ? sectionMarkup(`More by ${info.name}`, items) : "";
    }),
  ];
  const sections = (await Promise.allSettled(jobs))
    .map((r) => (r.status === "fulfilled" ? r.value : ""))
    .join("");

  recommendationsContainer.innerHTML =
    sections || `<p class="muted">Add a few more songs to your playlists to get recommendations.</p>`;
}

let loading = false;

export async function renderHomeFeed(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    renderMadeForYou();
    await Promise.all([renderTrending(), renderRecommendations(), renderFollowedRow()]);
  } finally {
    loading = false;
  }
}
