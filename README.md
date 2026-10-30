# Groov

A private Spotify-style music player for Android and laptop, built only on free
music APIs. Search, full-length playback, synced lyrics, playlists and themes.

> **Showcase copy.** Groov was started by **Neha Sah** — the original idea, design
> and first version. **Aaditya Sah** ([AADITYA007x](https://github.com/AADITYA007x))
> grew it into the full app shown here. The live app is built and released from
> [AADITYA007x/groov](https://github.com/AADITYA007x/groov); this copy is for
> reading and doesn't build or publish anything.

## Features

- Search songs, artists and albums (iTunes catalog), with a top result and "See all"
- Full-length songs through the YouTube player when a YouTube key is set; 30s previews otherwise
- Synced, auto-scrolling lyrics (lrclib.net)
- Playlists, recent searches, autoplay through the current list
- Trending chart and "Recommended for you" from your playlists
- Four colour themes
- Android APK built automatically by GitHub Actions; web version on GitHub Pages

See [the roadmap](#roadmap) for what's coming.

## Install on a phone

1. Open the repo's **Releases** page on the phone and download the latest `groov-…apk`.
   (Builds from the `dev` branch are under **Actions → Build Android APK → latest run → Artifacts**.)
2. Open the file and allow "Install unknown apps" for your browser or file manager when asked.
3. Updates install over the old version, and your playlists stay.

### Full-length songs

Open the sidebar → **Settings → YouTube** and paste a free
[YouTube Data API v3](https://console.cloud.google.com/) key.
Each person should use their own key: one key allows about 100 new song lookups a day,
and songs you've played before don't count again.

To get a key: Google Cloud Console → create a project → **APIs & Services → Library** →
enable "YouTube Data API v3" → **Credentials → Create credentials → API key**.

## Accounts and sync (Supabase)

Sign-in, synced playlists, shared playlists and play history use a free
[Supabase](https://supabase.com) project. The URL and publishable key are in
`src/cloud/client.ts` (they're meant to ship in apps); access is enforced by
row-level security in [`supabase/schema.sql`](supabase/schema.sql). Run that
file once in Supabase's SQL Editor to set up a new project.

## Develop

Needs [Node.js 22+](https://nodejs.org/).

```bash
npm install
npm run dev        # http://localhost:4173 — reloads as you edit
npm run build      # type-check + production build into dist/
```

Optional: copy `.env.example` to `.env.local` and set `VITE_YOUTUBE_API_KEY` to bake a key into
local builds. Never put a real key in CI or commit it, because anyone who downloads the APK can read it.

### Project layout

```
index.html            app shell (Vite entry)
src/
  main.ts             wires everything up
  config.ts           constants, storage keys, YouTube key handling
  state.ts            track registry + app-wide event bus
  api/                iTunes, YouTube and lrclib clients
  player/             playback engines, queue, lyrics overlay
  library/            playlists (localStorage)
  ui/                 search, home feed, cards, views, popover, theme, settings
  style.css
android/              Capacitor Android project
.github/workflows/    APK build + GitHub Pages deploy
```

### Building the APK

GitHub Actions builds a signed APK on every push to `main` or `dev`
(`.github/workflows/android.yml`). It needs two repository secrets:

| Secret | Value |
| --- | --- |
| `GROOV_KEYSTORE_BASE64` | the release keystore, base64-encoded |
| `GROOV_KEYSTORE_PASSWORD` | its password (alias `groov`) |

Without them the build still works, but it's signed with a throwaway key and won't install over earlier builds.

To build locally instead, you need JDK 21 and the Android SDK (Android Studio is optional):

```bash
npm run android:apk
# → android/app/build/outputs/apk/release/app-release.apk
```

For local release signing, create `android/keystore.properties` (git-ignored):

```properties
storeFile=/absolute/path/to/groov-release.jks
storePassword=…
keyAlias=groov
keyPassword=…
```

## Roadmap

1. ~~Proper project: Vite + TypeScript, CI-built signed APK~~
2. ~~Spotify-style playback: background and screen-off play, lock-screen and notification controls, media keys~~
3. ~~Full songs from YouTube audio streams with no search quota, plus offline downloads~~
4. ~~For the two of us: login, synced and shared playlists, listen together~~
5. Discovery and polish: Last.fm recommendations, Deezer charts, artist pages, stats, crossfade
