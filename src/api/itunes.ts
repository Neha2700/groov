// iTunes Search API + Apple's public top-songs feed: free, no key, CORS-open.
import type { Category, Item, SearchResult } from "../types";
import { scoreMatch } from "../utils";

const ITUNES_API = "https://itunes.apple.com/search";

export const CATEGORY_LABELS: Record<Category, string> = {
  tracks: "Songs",
  artists: "Artists",
  albums: "Albums",
};

const ENTITY_BY_CATEGORY: Record<Category, string> = {
  tracks: "song",
  artists: "musicArtist",
  albums: "album",
};

// Shape of the iTunes fields we read; the API returns many more.
interface ITunesRaw {
  wrapperType?: string;
  trackId?: number;
  trackName?: string;
  artistId?: number;
  artistName?: string;
  collectionId?: number;
  collectionName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
  collectionViewUrl?: string;
  artistLinkUrl?: string;
  primaryGenreName?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  trackNumber?: number;
  discNumber?: number;
  trackCount?: number;
}

export function normalizeResult(raw: ITunesRaw, category: Category): Item {
  if (category === "tracks") {
    return {
      id: `song-${raw.trackId}`,
      name: raw.trackName ?? "",
      subtitle: raw.artistName ?? "",
      artwork: raw.artworkUrl100 ?? null,
      previewUrl: raw.previewUrl ?? null,
      externalUrl: raw.trackViewUrl ?? null,
      topSubtitle: `Song · ${raw.artistName ?? ""}`,
      artistId: raw.artistId,
      collectionId: raw.collectionId,
      genre: raw.primaryGenreName,
      durationMs: raw.trackTimeMillis,
    };
  }
  if (category === "albums") {
    const year = raw.releaseDate ? new Date(raw.releaseDate).getFullYear() : "";
    return {
      id: `album-${raw.collectionId}`,
      name: raw.collectionName ?? "",
      subtitle: year ? `${year} · ${raw.artistName ?? ""}` : (raw.artistName ?? ""),
      artwork: raw.artworkUrl100 ?? null,
      externalUrl: raw.collectionViewUrl ?? null,
      topSubtitle: `Album · ${raw.artistName ?? ""}`,
      artistId: raw.artistId,
      collectionId: raw.collectionId,
    };
  }
  return {
    id: `artist-${raw.artistId}`,
    name: raw.artistName ?? "",
    subtitle: raw.primaryGenreName ? `${raw.primaryGenreName} artist` : "Artist",
    artwork: null,
    externalUrl: raw.artistLinkUrl ?? null,
    topSubtitle: "Artist",
    artistId: raw.artistId,
  };
}

export async function fetchCategory(
  term: string,
  category: Category,
  limit: number,
  signal?: AbortSignal,
): Promise<Item[]> {
  const params = new URLSearchParams({
    term,
    media: "music",
    entity: ENTITY_BY_CATEGORY[category],
    limit: String(limit),
  });
  const response = await fetch(`${ITUNES_API}?${params}`, { signal });
  if (!response.ok) throw new Error(`iTunes API error: ${response.status}`);
  const data = (await response.json()) as { results: ITunesRaw[] };
  return data.results.map((r) => normalizeResult(r, category));
}

/** Songs fetched to judge popularity, even though fewer are shown. */
const POPULARITY_SAMPLE = 15;

/**
 * Top result = good name match AND popular. iTunes lists songs roughly by
 * popularity, so a song's rank is its popularity; an artist or album is as
 * popular as the number of top songs that belong to it. So "demons" gives
 * Imagine Dragons' hit, not an unknown artist literally named "Demons",
 * while "imagine dragons" still gives the artist.
 */
export function pickTopResult(
  query: string,
  songs: Item[],
  albums: Item[],
  artists: Item[],
): SearchResult["best"] {
  const MATCH_POINTS = [0, 2, 4, 6]; // none, contains, prefix, exact
  const sample = songs.slice(0, POPULARITY_SAMPLE);
  const songsBy = (pred: (s: Item) => boolean) => sample.filter(pred).length;
  const matchOf = (item: Item, withArtist: boolean) =>
    Math.max(scoreMatch(item.name, query), withArtist ? scoreMatch(`${item.name} ${item.subtitle}`, query) : 0);

  type Candidate = { item: Item; category: Category; score: number };
  const candidates: Candidate[] = [
    ...sample.slice(0, 10).map((item, i) => ({
      item,
      category: "tracks" as const,
      score: MATCH_POINTS[matchOf(item, true)] + (10 - i),
    })),
    ...albums.slice(0, 3).map((item) => ({
      item,
      category: "albums" as const,
      score: MATCH_POINTS[matchOf(item, false)] + 2 * songsBy((s) => s.collectionId === item.collectionId),
    })),
    ...artists.slice(0, 3).map((item, i) => ({
      item,
      category: "artists" as const,
      score: MATCH_POINTS[matchOf(item, false)] + 2 * songsBy((s) => s.artistId === item.artistId) + (i === 0 ? 1 : 0),
    })),
  ];
  // Nothing matching the words at all: still show the most popular song.
  const best = candidates
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || (a.category === "tracks" ? -1 : 1))[0];
  return best ? { item: best.item, category: best.category, score: best.score } : null;
}

export async function searchCatalog(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const [songs, albums, artists] = await Promise.allSettled([
    fetchCategory(query, "tracks", Math.max(limit, POPULARITY_SAMPLE), signal),
    fetchCategory(query, "albums", limit, signal),
    fetchCategory(query, "artists", limit, signal),
  ]);
  // Every category failing means the network is down, not "no results".
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if ([songs, albums, artists].every((s) => s.status === "rejected")) throw new Error("Catalog unreachable");

  const value = (r: PromiseSettledResult<Item[]>) => (r.status === "fulfilled" ? r.value : []);
  const allSongs = value(songs);
  const matches: SearchResult["matches"] = {
    tracks: allSongs.slice(0, limit),
    albums: value(albums),
    artists: value(artists),
  };
  return { matches, best: pickTopResult(query, allSongs, value(albums), value(artists)) };
}

async function lookup(params: Record<string, string>): Promise<ITunesRaw[]> {
  const response = await fetch(`https://itunes.apple.com/lookup?${new URLSearchParams(params)}`);
  if (!response.ok) throw new Error(`iTunes lookup error: ${response.status}`);
  return ((await response.json()) as { results: ITunesRaw[] }).results;
}

export interface ArtistPage {
  artist: Item;
  topSongs: Item[];
  albums: Item[];
}

/**
 * An artist's most popular songs and their albums. Popularity comes from
 * the search ranking (filtered to this artist); albums are newest first.
 */
export async function fetchArtistPage(artistId: number, name?: string): Promise<ArtistPage> {
  const [info, albumsRaw] = await Promise.all([
    lookup({ id: String(artistId) }),
    lookup({ id: String(artistId), entity: "album", limit: "60" }).catch(() => [] as ITunesRaw[]),
  ]);
  const artistRaw = info.find((r) => r.wrapperType === "artist");
  const artistName = artistRaw?.artistName ?? name ?? "Artist";
  const artist = normalizeResult(artistRaw ?? { artistId, artistName }, "artists");

  let topSongs = (await fetchCategory(artistName, "tracks", 50).catch(() => [] as Item[])).filter(
    (s) => s.artistId === artistId,
  );
  if (topSongs.length < 5) {
    const more = (await lookup({ id: String(artistId), entity: "song", limit: "30" }).catch(() => []))
      .filter((r) => r.wrapperType === "track")
      .map((r) => normalizeResult(r, "tracks"));
    const seen = new Set(topSongs.map((s) => s.id));
    topSongs = [...topSongs, ...more.filter((s) => !seen.has(s.id))];
  }

  const albums = albumsRaw
    .filter((r) => r.wrapperType === "collection" && (r.trackCount ?? 2) > 1)
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    .map((r) => normalizeResult(r, "albums"));
  // De-duplicate clean/explicit and deluxe twins: keep the plainest name
  // ("Night Visions" over "Night Visions (Deluxe)"), in newest-first order.
  const byName = new Map<string, Item>();
  for (const a of albums) {
    const key = a.name.toLowerCase().replace(/\s*[([].*?[)\]]/g, "").trim();
    const kept = byName.get(key);
    if (!kept || a.name.length < kept.name.length) byName.set(key, a);
  }
  const keep = new Set(byName.values());
  const uniqueAlbums = albums.filter((a) => keep.has(a));

  if (!artist.artwork) artist.artwork = topSongs[0]?.artwork ?? uniqueAlbums[0]?.artwork ?? null;
  return { artist, topSongs: topSongs.slice(0, 10), albums: uniqueAlbums };
}

export interface AlbumPage {
  album: Item;
  tracks: Item[];
  year: number | null;
}

/** An album's songs in track order. */
export async function fetchAlbumPage(collectionId: number): Promise<AlbumPage> {
  const results = await lookup({ id: String(collectionId), entity: "song", limit: "200" });
  const albumRaw = results.find((r) => r.wrapperType === "collection");
  if (!albumRaw) throw new Error("Album not found");
  const tracks = results
    .filter((r) => r.wrapperType === "track")
    .sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
    .map((r) => normalizeResult(r, "tracks"));
  return {
    album: normalizeResult(albumRaw, "albums"),
    tracks,
    year: albumRaw.releaseDate ? new Date(albumRaw.releaseDate).getFullYear() : null,
  };
}

/** Find an artist by name (for songs that came without an artist id). */
export async function findArtistId(name: string): Promise<number | null> {
  const artists = await fetchCategory(name, "artists", 5).catch(() => [] as Item[]);
  const lower = name.toLowerCase();
  const exact =
    artists.find((a) => a.name.toLowerCase() === lower) ??
    artists.find((a) => a.name.toLowerCase().startsWith(lower));
  return (exact ?? artists[0])?.artistId ?? null;
}

export async function fetchArtistTracks(artistId: number, limit: number): Promise<Item[]> {
  const params = new URLSearchParams({ id: String(artistId), entity: "song", limit: String(limit) });
  const response = await fetch(`https://itunes.apple.com/lookup?${params}`);
  if (!response.ok) throw new Error(`iTunes lookup error: ${response.status}`);
  const data = (await response.json()) as { results: ITunesRaw[] };
  return data.results
    .filter((r) => r.wrapperType === "track")
    .map((r) => normalizeResult(r, "tracks"));
}

// --- Top-songs chart feed ------------------------------------------------

interface Labelled {
  label?: string;
}
interface ChartLink {
  attributes?: { rel?: string; href?: string };
}
interface ChartEntry {
  id?: { attributes?: { "im:id"?: string } };
  "im:name"?: Labelled;
  "im:artist"?: Labelled;
  "im:image"?: Labelled[];
  link?: ChartLink | ChartLink[];
  category?: { attributes?: { label?: string } };
}

function normalizeChartEntry(entry: ChartEntry): Item {
  const images = entry["im:image"] || [];
  const links = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];
  const previewLink = links.find((l) => l.attributes?.rel === "enclosure");
  const htmlLink = links.find((l) => l.attributes?.rel === "alternate") ?? links[0];
  const artistName = entry["im:artist"]?.label || "";
  return {
    id: `song-${entry.id?.attributes?.["im:id"]}`,
    name: entry["im:name"]?.label || "",
    subtitle: artistName,
    artwork: images[images.length - 1]?.label || null,
    previewUrl: previewLink?.attributes?.href || null,
    externalUrl: htmlLink?.attributes?.href || null,
    topSubtitle: `Song · ${artistName}`,
    genre: entry.category?.attributes?.label,
  };
}

/** Charts for India (the app's listeners); "us" for the US chart. */
export const CHART_COUNTRY = "in";

export async function fetchTrendingSongs(limit: number, country = CHART_COUNTRY): Promise<Item[]> {
  const response = await fetch(`https://itunes.apple.com/${country}/rss/topsongs/limit=${limit}/json`);
  if (!response.ok) throw new Error(`Charts feed error: ${response.status}`);
  const data = (await response.json()) as { feed?: { entry?: ChartEntry[] } };
  return (data.feed?.entry || []).map(normalizeChartEntry);
}
