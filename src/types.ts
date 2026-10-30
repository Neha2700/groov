export type Category = "tracks" | "artists" | "albums";

/** A normalized catalog item (song, artist or album) as the UI uses it. */
export interface Item {
  id: string;
  name: string;
  subtitle: string;
  artwork: string | null;
  previewUrl?: string | null;
  externalUrl?: string | null;
  topSubtitle: string;
  artistId?: number;
  collectionId?: number;
  genre?: string;
  /** Track length from the catalog; helps pick the right YouTube version. */
  durationMs?: number;
}

export interface Playlist {
  id: string;
  name: string;
  tracks: Item[];
  /** Saved to the account (synced), not just this device. */
  cloud?: boolean;
  ownerId?: string;
  ownerName?: string;
  /** Shared with other people (they can add and remove songs). */
  shared?: boolean;
  members?: { id: string; name: string }[];
  /** track id -> who added it, for shared playlists. */
  addedBy?: Record<string, { id: string | null; name: string }>;
}

export type Playlists = Record<string, Playlist>;

export interface SearchResult {
  matches: Partial<Record<Category, Item[]>>;
  best: { item: Item; score: number; category: Category } | null;
}

export interface LyricLine {
  time: number;
  text: string;
}

export interface Lyrics {
  plain: string;
  synced: LyricLine[] | null;
}
