// Navigation between the search/home view and playlist views, plus the
// sidebar playlist list.
import { addTrackToPlaylist, renamePlaylist, deletePlaylist, getPlaylists, isOwner, removeTrackFromPlaylist, createPlaylist } from "../library/playlists";
import { hasNativeAudio, nativeAudio } from "../player/native-audio";
import { getAccount } from "../cloud/session";
import { sharePlaylist } from "../cloud/sync";
import { playPlaylist, toItem } from "../player/radio";
import { isShuffleOn, toggleShuffle } from "../player/player";
import { findArtistId } from "../api/itunes";
import { renderDetail } from "./detail";
import { isLikedPlaylist, LIKED_NAME } from "../library/liked";
import { renderStats } from "./stats";
import { canDownload, downloadPlaylist, isPlaylistDownloaded, playlistProgress, removePlaylistDownload, retryFailed } from "../library/downloads";
import { chooseOption } from "./choice";
import { icons } from "./icons";

function renderShuffleToggle(): void {
  const btn = $("shuffle-playlist-btn");
  const on = isShuffleOn();
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Shuffle on" : "Shuffle off";
}
import type { Item, Playlist } from "../types";
import { bus } from "../state";
import { $, escapeHtml } from "../utils";
import { playlistRowMarkup } from "./cards";
import { renderHomeFeed } from "./home";
import { closeSidebar } from "./layout";
import { pushStep } from "./back";

const searchInput = $<HTMLInputElement>("search-input");
const recentView = $("recent-view");
const resultsView = $("results-view");
const loadingView = $("loading-view");
const navSearchBtn = $("nav-search");
const playlistNavList = $("playlist-nav-list");
const playlistViewEl = $("playlist-view");
const playlistViewTitle = $("playlist-view-title");
const playlistTrackListEl = $("playlist-track-list");
const playlistEmptyEl = $("playlist-empty");
const playlistMetaEl = $("playlist-meta");
const shareBtn = $("share-playlist-btn");
const deleteBtn = $("delete-playlist-btn");
const detailViewEl = $("detail-view");
const statsViewEl = $("stats-view");
const navStatsBtn = $("nav-stats");

/** "search", "stats", a playlist id, "artist:<id>:<name>" or "album:<id>". */
let currentView = "search";
let viewStepCount = 0;

const isDetail = (view: string) => /^(artist|album|mix):/.test(view);

/** Back from here returns to the view we're leaving. */
function recordViewChange(): void {
  const previous = currentView;
  pushStep(`view-${++viewStepCount}`, () => navigateTo(previous, false));
}

export function navigateTo(view: string, record = true): void {
  if (view === "search") navigateToSearch(record);
  else if (view === "stats") navigateToStats(record);
  else if (isDetail(view)) navigateToDetail(view, record);
  else navigateToPlaylist(view, record);
}

function hideMainSections(): void {
  recentView.style.display = "none";
  resultsView.style.display = "none";
  loadingView.style.display = "none";
  playlistViewEl.style.display = "none";
  detailViewEl.style.display = "none";
  statsViewEl.style.display = "none";
  navStatsBtn.classList.remove("active");
}

export function navigateToStats(record = true): void {
  if (record && currentView !== "stats") recordViewChange();
  currentView = "stats";
  hideMainSections();
  statsViewEl.style.display = "block";
  navSearchBtn.classList.remove("active");
  navStatsBtn.classList.add("active");
  renderPlaylistNav();
  renderStats();
  window.scrollTo({ top: 0 });
}

function navigateToDetail(view: string, record = true): void {
  if (record && currentView !== view) recordViewChange();
  currentView = view;
  hideMainSections();
  detailViewEl.style.display = "block";
  navSearchBtn.classList.remove("active");
  renderPlaylistNav();
  renderDetail(view);
  window.scrollTo({ top: 0 });
}

/** Open an artist's page (looks the artist up by name if needed). */
export async function openArtist(artistId: number | null | undefined, name: string): Promise<void> {
  const id = artistId || (await findArtistId(name));
  if (!id) {
    bus.emit("toast", `Couldn't find ${name}`);
    return;
  }
  navigateTo(`artist:${id}:${encodeURIComponent(name)}`);
}

export function openAlbum(collectionId: number): void {
  navigateTo(`album:${collectionId}`);
}

export type SearchSubview = "recent" | "results" | "loading";

export function showView(view: SearchSubview): void {
  if (currentView !== "search") {
    // Typing a search while a playlist is open: back returns to the playlist.
    recordViewChange();
    currentView = "search";
    navSearchBtn.classList.add("active");
    renderPlaylistNav();
  }
  playlistViewEl.style.display = "none";
  detailViewEl.style.display = "none";
  statsViewEl.style.display = "none";
  navStatsBtn.classList.remove("active");
  recentView.style.display = view === "recent" ? "block" : "none";
  resultsView.style.display = view === "results" ? "block" : "none";
  loadingView.style.display = view === "loading" ? "block" : "none";
  if (view === "recent") void renderHomeFeed();
}

export function renderPlaylistNav(): void {
  const playlists = getPlaylists();
  const ids = Object.keys(playlists);
  playlistNavList.innerHTML = "";

  if (!ids.length) {
    playlistNavList.innerHTML = `<div class="playlist-nav-empty">Create a playlist to save songs you find here.</div>`;
    return;
  }

  // Liked Songs first, then the rest in their usual order.
  ids.sort((a, b) => Number(isLikedPlaylist(playlists[b])) - Number(isLikedPlaylist(playlists[a])));
  for (const id of ids) {
    const liked = isLikedPlaylist(playlists[id]);
    const btn = document.createElement("button");
    btn.className = `playlist-nav-item${currentView === id ? " active" : ""}${liked ? " liked" : ""}`;
    btn.dataset.id = id;
    const p = playlists[id];
    const icon = liked ? "❤️" : p.shared ? "👥" : "♪";
    btn.innerHTML = `<span class="playlist-nav-icon">${icon}</span><span class="playlist-nav-name">${escapeHtml(p.name)}</span><span class="playlist-nav-count">${p.tracks.length}</span>`;
    btn.addEventListener("click", () => {
      navigateToPlaylist(id);
      closeSidebar();
    });
    playlistNavList.appendChild(btn);
  }
}

function renderPlaylistView(id: string): void {
  const playlist = getPlaylists()[id];
  if (!playlist) {
    navigateToSearch();
    return;
  }
  playlistViewTitle.textContent = playlist.name;
  renderCover(playlist);
  renderPlaylistMeta(playlist);
  playlistEmptyEl.style.display = playlist.tracks.length ? "none" : "block";
  const me = getAccount()?.id;
  playlistTrackListEl.innerHTML = playlist.tracks
    .map((item) => {
      const by = playlist.shared ? playlist.addedBy?.[item.id] : undefined;
      return playlistRowMarkup(id, item, by && by.id !== me ? by.name : undefined);
    })
    .join("");
}

/** Up to 4 song pictures as the cover; ♥ for Liked Songs. */
function renderCover(playlist: Playlist): void {
  const cover = $("playlist-cover");
  const liked = isLikedPlaylist(playlist);
  const arts = [...new Set(playlist.tracks.map((t) => t.artwork).filter(Boolean) as string[])].slice(0, 4);
  cover.className = `playlist-cover${liked ? " liked" : ""}${arts.length >= 4 ? " grid" : ""}`;
  cover.innerHTML = liked
    ? icons.heartFilled
    : arts.length >= 4
      ? arts.map((a) => `<img src="${escapeHtml(a)}" alt="" loading="lazy" />`).join("")
      : arts[0]
        ? `<img src="${escapeHtml(arts[0])}" alt="" />`
        : `<span class="playlist-cover-note">♪</span>`;
  const mins = Math.round(playlist.tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0) / 60000);
  const n = playlist.tracks.length;
  $("playlist-count").textContent = `${n} song${n === 1 ? "" : "s"}${mins ? ` · ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}` : ""}`;
}

/** "Shared with Neha" / "Shared by Neha", Share / Delete / Leave buttons. */
function renderPlaylistMeta(playlist: Playlist): void {
  const owner = isOwner(playlist);
  const me = getAccount()?.id;
  let meta = "";
  if (playlist.shared && owner) {
    const names = (playlist.members ?? []).map((m) => m.name);
    meta = names.length ? `👥 Shared with ${names.join(", ")}` : "";
  } else if (playlist.shared) {
    const others = (playlist.members ?? []).filter((m) => m.id !== me).map((m) => m.name);
    meta = `👥 Shared by ${playlist.ownerName ?? "someone"}` + (others.length ? ` · also ${others.join(", ")}` : "");
  } else if (!playlist.cloud) {
    meta = getAccount() ? "" : "Only on this device · sign in to sync and share";
  }
  playlistMetaEl.textContent = meta;
  playlistMetaEl.style.display = meta ? "block" : "none";
  const liked = isLikedPlaylist(playlist);
  shareBtn.style.display = owner && getAccount() && !liked ? "inline-flex" : "none";
  deleteBtn.style.display = liked ? "none" : "inline-flex";
  $("rename-playlist-btn").style.display = owner && !liked ? "inline-flex" : "none";
  const hasSongs = playlist.tracks.length > 0;
  $("play-playlist-btn").style.display = hasSongs ? "inline-flex" : "none";
  $("shuffle-playlist-btn").style.display = playlist.tracks.length > 1 ? "inline-flex" : "none";
  deleteBtn.textContent = owner ? "Delete playlist" : "Leave playlist";
  renderDownloadBtn(playlist);
}

const downloadBtn = $("download-playlist-btn");

/** Paste a YouTube, YouTube Music or Spotify link: it becomes a Groov playlist. */
async function importFromYoutube(): Promise<void> {
  const link = prompt(
    "Paste a playlist link from YouTube, YouTube Music or Spotify.\n(In the app: open the playlist → ⋮ / ··· → Share → Copy link)",
  );
  if (!link?.trim()) return;
  await importFromLink(link.trim());
}

/** Import a YouTube / YouTube Music / Spotify playlist or album link. */
export async function importFromLink(url: string): Promise<void> {
  bus.emit("toast", "⤓ Importing playlist…");
  try {
    let name: string;
    let items: Item[];
    if (/spotify\.com|^spotify:/i.test(url)) {
      // Spotify gives names only; each song is found on YouTube Music when it plays.
      const r = await nativeAudio.importSpotify({ url });
      name = r.name;
      items = r.songs.map((s) => ({
        id: `sp-${s.id}`,
        name: s.title,
        subtitle: s.artists,
        artwork: null,
        previewUrl: null,
        externalUrl: `https://open.spotify.com/track/${s.id}`,
        topSubtitle: `Song · ${s.artists}`,
        durationMs: s.durationMs || undefined,
      }));
    } else {
      const r = await nativeAudio.importPlaylist({ url, max: 500 });
      name = r.name;
      items = r.tracks.map(toItem);
    }
    const tracks = items;
    const id = createPlaylist(name.slice(0, 60));
    for (const t of tracks) addTrackToPlaylist(id, t);
    closeSidebar();
    navigateToPlaylist(id);
    bus.emit("toast", `⤓ Imported "${name}" · ${tracks.length} songs`);
  } catch (err) {
    bus.emit("toast", `Couldn't import: ${(err as Error)?.message || "check the link"}`);
  }
}

function renderDownloadBtn(playlist: Playlist): void {
  if (!canDownload || !playlist.tracks.length) {
    downloadBtn.style.display = "none";
    return;
  }
  downloadBtn.style.display = "inline-flex";
  const on = isPlaylistDownloaded(playlist.id);
  const { done, total, failed } = playlistProgress(playlist);
  downloadBtn.classList.toggle("active", on);
  const complete = on && done >= total;
  downloadBtn.innerHTML = (complete ? icons.downloaded : icons.download) + `<span class="download-label"></span>`;
  downloadBtn.classList.toggle("has-label", on && !complete);
  downloadBtn.title = !on ? "Download for offline" : complete ? "Downloaded · tap to remove" : "Downloading…";
  downloadBtn.querySelector(".download-label")!.textContent = !on || complete
    ? ""
    : failed && done + failed >= total
      ? `${done}/${total} · retry`
      : `${done}/${total}`;
}

export function navigateToPlaylist(id: string, record = true): void {
  if (record && currentView !== id) recordViewChange();
  currentView = id;
  hideMainSections();
  playlistViewEl.style.display = "block";
  navSearchBtn.classList.remove("active");
  renderPlaylistNav();
  renderPlaylistView(id);
}

export function navigateToSearch(record = true): void {
  if (record && currentView !== "search") recordViewChange();
  currentView = "search";
  playlistViewEl.style.display = "none";
  detailViewEl.style.display = "none";
  statsViewEl.style.display = "none";
  navStatsBtn.classList.remove("active");
  navSearchBtn.classList.add("active");
  renderPlaylistNav();
  showView(searchInput.value.trim() ? "results" : "recent");
}

export function initViews(): void {
  // Album and artist cards (and artist links) open their page in the app.
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest<HTMLElement>("[data-album], [data-artist]");
    if (!link || (e.target as Element).closest(".play-overlay, .add-overlay")) return;
    e.preventDefault();
    if (link.dataset.album) openAlbum(Number(link.dataset.album));
    else void openArtist(Number(link.dataset.artist), link.dataset.artistName ?? "");
  });

  playlistTrackListEl.addEventListener("click", (e) => {
    const removeBtn = (e.target as Element).closest<HTMLElement>(".playlist-row-remove");
    if (!removeBtn) return;
    removeTrackFromPlaylist(removeBtn.dataset.playlist!, removeBtn.dataset.track!);
  });

  navSearchBtn.addEventListener("click", () => {
    navigateToSearch();
    closeSidebar();
  });
  downloadBtn.addEventListener("click", async () => {
    const playlist = getPlaylists()[currentView];
    if (!playlist) return;
    if (!isPlaylistDownloaded(playlist.id)) {
      downloadPlaylist(playlist.id);
      bus.emit("toast", `⬇ Downloading ${playlist.tracks.length} songs for offline`);
      return;
    }
    const { done, total, failed } = playlistProgress(playlist);
    if (failed && done + failed >= total) {
      retryFailed();
      return;
    }
    const remove = await chooseOption("Remove download?", [
      { label: "Remove download (songs may be deleted to make room)", value: true, danger: true },
      { label: "Keep it", value: false },
    ]);
    if (remove) {
      removePlaylistDownload(playlist.id);
      bus.emit("toast", "Download removed");
    }
  });
  bus.on("downloadchange", () => {
    const playlist = getPlaylists()[currentView];
    if (playlist && playlistViewEl.style.display !== "none") {
      renderDownloadBtn(playlist);
      renderPlaylistView(playlist.id);
    }
  });
  navStatsBtn.addEventListener("click", () => {
    navigateToStats();
    closeSidebar();
  });

  $("create-playlist").addEventListener("click", async () => {
    const choice = hasNativeAudio
      ? await chooseOption("Add a playlist", [
          { label: "＋ New playlist", value: "new" },
          { label: "⤓ Import from YouTube, YouTube Music or Spotify", value: "import" },
        ])
      : "new";
    if (choice === "import") return void importFromYoutube();
    if (choice !== "new") return;
    const name = prompt("Playlist name");
    if (name === null) return;
    navigateToPlaylist(createPlaylist(name || "New Playlist"));
  });

  $("play-playlist-btn").addEventListener("click", () => void playPlaylist(currentView));
  // ⋯: Rename / Share / Delete (whichever this playlist allows).
  $("playlist-more-btn").addEventListener("click", async () => {
    const options = (
      [
        ["rename-playlist-btn", "✏️ Rename"],
        ["share-playlist-btn", "👥 Share with a friend"],
        ["delete-playlist-btn", deleteBtn.textContent === "Leave playlist" ? "🚪 Leave playlist" : "🗑 Delete playlist"],
      ] as const
    )
      .filter(([id]) => $(id).style.display !== "none")
      .map(([id, label]) => ({ label, value: id as string, danger: id === "delete-playlist-btn" }));
    if (!options.length) return;
    const choice = await chooseOption(playlistViewTitle.textContent ?? "Playlist", options);
    if (choice) $(choice).click();
  });
  $("rename-playlist-btn").addEventListener("click", () => {
    const playlist = getPlaylists()[currentView];
    if (!playlist) return;
    const name = prompt("Rename playlist", playlist.name);
    if (name === null || !name.trim() || name.trim() === playlist.name) return;
    if (name.trim() === LIKED_NAME) {
      bus.emit("toast", `"${LIKED_NAME}" is used for your likes`);
      return;
    }
    if (renamePlaylist(playlist.id, name)) bus.emit("toast", `Renamed to "${name.trim()}"`);
  });
  // The same shuffle setting as in Now Playing, not a separate action.
  $("shuffle-playlist-btn").addEventListener("click", () => {
    toggleShuffle();
    bus.emit("toast", isShuffleOn() ? "🔀 Shuffle on" : "Shuffle off");
  });
  bus.on("modechange", renderShuffleToggle);
  renderShuffleToggle();

  shareBtn.addEventListener("click", async () => {
    const playlist = getPlaylists()[currentView];
    if (!playlist) return;
    const email = prompt(`Share "${playlist.name}" with…\nEnter their Groov account email:`);
    if (!email?.trim()) return;
    shareBtn.textContent = "Sharing…";
    try {
      const name = await sharePlaylist(playlist.id, email);
      alert(`Shared with ${name}. They can now add and remove songs.`);
    } catch (err) {
      alert(`Couldn't share: ${(err as Error).message}`);
    } finally {
      shareBtn.textContent = "Share";
    }
  });

  deleteBtn.addEventListener("click", () => {
    if (currentView === "search") return;
    const playlist = getPlaylists()[currentView];
    const name = playlist?.name || "this playlist";
    const question = playlist && !isOwner(playlist)
      ? `Leave "${name}"? It will disappear from your playlists.`
      : playlist?.shared
        ? `Delete "${name}" for everyone it's shared with? This can't be undone.`
        : `Delete "${name}"? This can't be undone.`;
    if (!confirm(question)) return;
    deletePlaylist(currentView);
    navigateToSearch(false);
  });

  const refresh = () => {
    renderPlaylistNav();
    if (currentView !== "search" && !isDetail(currentView)) renderPlaylistView(currentView);
  };
  bus.on("authchange", refresh);
  bus.on("playlistschange", refresh);

  renderPlaylistNav();
}
