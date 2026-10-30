// Artist, album and Made for you mix pages, inside the app.
//   Artist: popular songs (by popularity), albums (newest first), Play, Radio.
//   Album: songs in track order, Play, Radio, tap the artist to open them.
import { fetchAlbumPage, fetchArtistPage } from "../api/itunes";
import { hiResArtwork } from "../player/media-controls";
import { isShuffleOn, playTrack, setQueue } from "../player/player";
import { startRadio } from "../player/radio";
import { bus, trackRegistry } from "../state";
import { cachedMixSongs, getMix, loadMixSongs } from "../library/mixes";
import { addTrackToPlaylist, createPlaylist, getPlaylists } from "../library/playlists";
import { isFollowing, toggleFollow } from "../library/follows";
import type { Item } from "../types";
import { $, escapeHtml } from "../utils";
import { artistLinksMarkup, cardMarkup, trackRowMarkup } from "./cards";

const art = $<HTMLImageElement>("detail-art");
const kindEl = $("detail-kind");
const titleEl = $("detail-title");
const subEl = $("detail-sub");
const body = $("detail-body");
const playBtn = $<HTMLButtonElement>("detail-play");
const radioBtn = $<HTMLButtonElement>("detail-radio");
const saveBtn = $<HTMLButtonElement>("detail-save");
const followBtn = $<HTMLButtonElement>("detail-follow");
let currentArtist: { id: number; name: string; artwork: string | null } | null = null;

function renderFollow(): void {
  if (!currentArtist) {
    followBtn.style.display = "none";
    return;
  }
  const on = isFollowing(currentArtist.id, currentArtist.name);
  followBtn.style.display = "inline-flex";
  followBtn.classList.toggle("following", on);
  followBtn.textContent = on ? "✓ Following" : "+ Follow";
}
let currentMixTitle = "";

let token = 0;
let tracks: Item[] = [];

type Kind = "Artist" | "Album" | "Made for you";

function setHeader(kind: Kind, title: string, subHtml: string, artwork: string | null): void {
  kindEl.textContent = kind;
  titleEl.textContent = title;
  subEl.innerHTML = subHtml;
  art.classList.toggle("round", kind === "Artist");
  const src = hiResArtwork(artwork, 600);
  art.src = src ?? "";
  art.style.visibility = src ? "visible" : "hidden";
}

function setLoading(kind: Kind, hintName: string): void {
  setHeader(kind, hintName || "Loading…", "", null);
  playBtn.disabled = true;
  radioBtn.disabled = true;
  body.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
}

function showError(): void {
  body.innerHTML = `<p class="muted">Couldn't load this. Check your internet and try again.</p>`;
}

async function renderArtist(artistId: number, hintName: string, t: number): Promise<void> {
  setLoading("Artist", hintName);
  const page = await fetchArtistPage(artistId, hintName);
  if (t !== token) return;
  const genre = page.artist.subtitle && page.artist.subtitle !== "Artist" ? page.artist.subtitle.replace(/ artist$/, "") : "";
  setHeader("Artist", page.artist.name, escapeHtml(genre), page.artist.artwork);
  tracks = page.topSongs;
  currentArtist = { id: artistId, name: page.artist.name, artwork: page.artist.artwork ?? tracks[0]?.artwork ?? null };
  renderFollow();
  body.innerHTML = `
    ${
      tracks.length
        ? `<h2 class="section-title">Popular</h2>
           <div class="playlist-track-list">${tracks.map((s, i) => trackRowMarkup(s, i)).join("")}</div>`
        : ""
    }
    ${
      page.albums.length
        ? `<h2 class="section-title">Albums</h2>
           <div class="card-grid">${page.albums.map((a) => cardMarkup(a, "albums")).join("")}</div>`
        : ""
    }
  `;
  playBtn.disabled = !tracks.length;
  radioBtn.disabled = !tracks.length;
}

async function renderAlbum(collectionId: number, t: number): Promise<void> {
  setLoading("Album", "");
  const page = await fetchAlbumPage(collectionId);
  if (t !== token) return;
  const artistName = page.album.subtitle.replace(/^\d{4} · /, "");
  const artistLink = `<span class="detail-artist-link">${artistLinksMarkup(artistName, page.album.artistId)}</span>`;
  const bits = [artistLink, page.year ? String(page.year) : "", `${page.tracks.length} songs`].filter(Boolean);
  setHeader("Album", page.album.name, bits.join(" · "), page.album.artwork);
  // Album songs carry the album's art (lookups often omit it on tracks).
  tracks = page.tracks.map((s) => ({ ...s, artwork: s.artwork ?? page.album.artwork }));
  body.innerHTML = `<div class="playlist-track-list">${tracks.map((s, i) => trackRowMarkup(s, i, false)).join("")}</div>`;
  playBtn.disabled = !tracks.length;
  radioBtn.disabled = !tracks.length;
}

async function renderMix(id: string, t: number): Promise<void> {
  const mix = getMix(id);
  if (!mix) {
    body.innerHTML = `<p class="muted">This mix isn't available any more — Made for you changes every day.</p>`;
    return;
  }
  currentMixTitle = mix.title;
  const cached = cachedMixSongs(mix);
  if (!cached) setLoading("Made for you", mix.title);
  const songs = cached ?? (await loadMixSongs(mix));
  if (t !== token) return;
  const art = songs.find((s) => s.artwork)?.artwork ?? null;
  const daily = mix.seed ? " · new every day" : "";
  setHeader("Made for you", mix.title, `${escapeHtml(mix.subtitle)} · ${songs.length} songs${daily}`, art);
  tracks = songs;
  body.innerHTML = songs.length
    ? `<div class="playlist-track-list">${songs.map((s, i) => trackRowMarkup(s, i)).join("")}</div>`
    : `<p class="muted">Couldn't find songs for this mix. Check your internet and try again.</p>`;
  playBtn.disabled = !songs.length;
  radioBtn.disabled = !songs.length;
  saveBtn.style.display = songs.length ? "inline-flex" : "none";
}

/** view is "artist:<id>[:name]", "album:<id>" or "mix:<id>". */
export function renderDetail(view: string): void {
  const t = ++token;
  const [kind, id, ...rest] = view.split(":");
  saveBtn.style.display = "none";
  currentArtist = null;
  renderFollow();
  const job =
    kind === "artist"
      ? renderArtist(Number(id), decodeURIComponent(rest.join(":")), t)
      : kind === "mix"
        ? renderMix(id, t)
        : renderAlbum(Number(id), t);
  job.catch(() => t === token && showError());
}

export function initDetail(): void {
  playBtn.addEventListener("click", () => {
    if (!tracks.length) return;
    tracks.forEach((s) => trackRegistry.set(s.id, s));
    const start = isShuffleOn() ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[0];
    setQueue(
      tracks.map((s) => s.id),
      start.id,
      "list",
      titleEl.textContent || undefined,
    );
    void playTrack(start.id);
  });
  radioBtn.addEventListener("click", () => {
    if (tracks[0]) void startRadio(tracks[0]);
  });
  followBtn.addEventListener("click", () => {
    if (currentArtist) toggleFollow(currentArtist);
  });
  bus.on("followchange", renderFollow);
  saveBtn.addEventListener("click", () => {
    if (!tracks.length) return;
    // "Daily Mix 1 · 27 Oct", so saving again tomorrow makes a new one.
    const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const name = `${currentMixTitle} · ${date}`;
    const existing = Object.values(getPlaylists()).find((p) => p.name === name);
    const id = existing?.id ?? createPlaylist(name);
    tracks.forEach((s) => addTrackToPlaylist(id, s));
    bus.emit("toast", `Saved ${tracks.length} songs to "${name}"`);
  });
}
