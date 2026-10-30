// Sidebar settings: paste a YouTube key at runtime (no rebuild needed),
// allow background play on Android, and show which version is installed.
import { getYoutubeApiKey, hasAccountYoutubeKey, hasCustomYoutubeKey, setYoutubeApiKey } from "../config";
import { shareYoutubeKey } from "../cloud/shared";
import { isBackgroundPlayAllowed, isNativeApp, openBackgroundPlaySettings } from "../player/media-controls";
import { $ } from "../utils";
import { hasNativeAudio, nativeAudio } from "../player/native-audio";
import { getCrossfadeSeconds, setCrossfadeSeconds } from "../player/player";
import { bus } from "../state";
import { chooseOption } from "./choice";
import { getSmartMode, setSmartMode, SMART_LIMIT_MB, type SmartMode } from "../library/smart";
import { getFavouriteMix, isAutoplayOn, setAutoplay, setFavouriteMix, type FavouriteMix } from "../player/radio";

const keyBtn = $("youtube-key-btn");
const backgroundBtn = $("background-play-btn");
const versionEl = $("app-version");
const crossfadeBtn = $("crossfade-btn");
const autoplayBtn = $("autoplay-btn");
const favMixBtn = $("favmix-btn");
const FAV_LABELS: Record<FavouriteMix, string> = { off: "Off", rarely: "Rarely", sometimes: "Sometimes" };

function renderFavMix(): void {
  favMixBtn.textContent = `Your favourites in radio: ${FAV_LABELS[getFavouriteMix()]}`;
}

async function chooseFavMix(): Promise<void> {
  const current = getFavouriteMix();
  const choice = await chooseOption<FavouriteMix>(
    "Your favourites in radio",
    [
      { label: "Off", value: "off", active: current === "off" },
      { label: "Rarely (about 1 in 12 songs)", value: "rarely", active: current === "rarely" },
      { label: "Sometimes (about 1 in 6 songs)", value: "sometimes", active: current === "sometimes" },
    ],
    "Mixes your liked songs and songs by artists you follow into radio and autoplay, now and then. Never one you played in the last hour. Marked ♥ in Up next.",
  );
  if (choice === null) return;
  setFavouriteMix(choice);
  renderFavMix();
}

function renderAutoplay(): void {
  autoplayBtn.textContent = isAutoplayOn() ? "Autoplay: on (radio when the queue ends)" : "Autoplay: off";
}
const storageBtn = $("storage-btn");

// --- Crossfade (Android) ---------------------------------------------------------

function renderCrossfade(): void {
  const s = getCrossfadeSeconds();
  crossfadeBtn.textContent = s ? `Crossfade: ${s} seconds` : "Crossfade: off";
}

async function chooseCrossfade(): Promise<void> {
  const current = getCrossfadeSeconds();
  const choice = await chooseOption(
    "Crossfade",
    [0, 3, 6, 10].map((s) => ({ label: s ? `${s} seconds` : "Off", value: s, active: s === current })),
    "Fades each song into the next one. Works once the next song has downloaded (it downloads while the current one plays).",
  );
  if (choice === null) return;
  setCrossfadeSeconds(choice);
  renderCrossfade();
}

// --- Equalizer (Android) ----------------------------------------------------------

const eqBtn = $("eq-btn");
const bassBtn = $("bass-btn");
const BASS = [
  { label: "Off", value: 0 },
  { label: "Light", value: 300 },
  { label: "Medium", value: 600 },
  { label: "Strong", value: 1000 },
];

async function renderEq(): Promise<Awaited<ReturnType<typeof nativeAudio.eqInfo>> | null> {
  try {
    const info = await nativeAudio.eqInfo();
    eqBtn.style.display = info.available ? "block" : "none";
    bassBtn.style.display = info.bassAvailable ? "block" : "none";
    eqBtn.textContent = `Equalizer: ${info.preset >= 0 ? info.presets[info.preset] ?? "On" : "Off"}`;
    const bass = BASS.reduce((best, b) => (Math.abs(b.value - info.bass) < Math.abs(best.value - info.bass) ? b : best));
    bassBtn.textContent = `Bass boost: ${bass.label}`;
    return info;
  } catch {
    return null; // older app version
  }
}

async function chooseEq(): Promise<void> {
  const info = await renderEq();
  if (!info) return;
  const choice = await chooseOption(
    "Equalizer",
    [{ label: "Off", value: -1, active: info.preset < 0 }, ...info.presets.map((name, i) => ({ label: name, value: i, active: info.preset === i }))],
    "Sound presets from your phone. Applies to every song, with headphones and speakers.",
    `<b>How to choose</b>
     <ul>
       <li><b>Off / Normal</b>: the song as the artist made it. Start here.</li>
       <li><b>Pop</b>: clearer vocals. A good everyday pick with earphones.</li>
       <li><b>Rock</b>: punchier drums and guitars.</li>
       <li><b>Dance / Hip Hop</b>: more low end for beats.</li>
       <li><b>Classical / Jazz</b>: softer, more natural.</li>
     </ul>
     Play a song you know well and switch presets while it plays. Keep the one you'd miss if you turned it off; if you can't hear a difference, choose Off.`,
  );
  if (choice === null) return;
  await nativeAudio.setEq({ preset: choice }).catch(() => undefined);
  void renderEq();
}

async function chooseBass(): Promise<void> {
  const info = await renderEq();
  if (!info) return;
  const choice = await chooseOption(
    "Bass boost",
    BASS.map((b) => ({ ...b, active: Math.abs(b.value - info.bass) < 150 })),
    "Strong bass can distort on small phone speakers; it's best with headphones.",
    `<b>How to choose</b>
     <ul>
       <li><b>Earphones / headphones</b>: Light or Medium.</li>
       <li><b>Phone speaker</b>: Off — small speakers crackle with boosted bass.</li>
       <li><b>Bluetooth speaker</b>: Light, only if it sounds thin.</li>
     </ul>
     Safe start: Equalizer <b>Pop</b> + Bass boost <b>Light</b>. If the sound gets muddy or crackles, go one step down.`,
  );
  if (choice === null) return;
  await nativeAudio.setEq({ bass: choice }).catch(() => undefined);
  void renderEq();
}

// --- Smart downloads (Android) -------------------------------------------------------

const smartBtn = $("smart-btn");
const SMART_LABELS: Record<SmartMode, string> = { off: "Off", mixes: "Mixes", "mixes-liked": "Mixes + Liked Songs" };

function renderSmart(): void {
  smartBtn.textContent = `Smart downloads: ${SMART_LABELS[getSmartMode()]}${getSmartMode() === "off" ? "" : " (Wi-Fi)"}`;
}

async function chooseSmart(): Promise<void> {
  const current = getSmartMode();
  const choice = await chooseOption<SmartMode>(
    "Smart downloads",
    [
      { label: "Off", value: "off", active: current === "off" },
      { label: "Mixes: On Repeat + Daily Mixes", value: "mixes", active: current === "mixes" },
      { label: "Mixes + Liked Songs", value: "mixes-liked", active: current === "mixes-liked" },
    ],
    `Keeps these offline automatically, refreshed daily on Wi-Fi only. Up to ${SMART_LIMIT_MB} MB, separate from your own downloads.`,
    `<b>How it works</b>
     <ul>
       <li>Once a day, on Wi-Fi, Groov downloads today's On Repeat and Daily Mixes (and Liked Songs if you pick it).</li>
       <li>Never on mobile data.</li>
       <li>Your own downloads always come first: if the phone runs low on space, smart downloads are removed before them — yours are never touched.</li>
     </ul>`,
  );
  if (choice === null) return;
  setSmartMode(choice);
  renderSmart();
  bus.emit("toast", choice === "off" ? "Smart downloads off" : "Smart downloads on — next time you're on Wi-Fi");
}

// --- Saved songs (Android cache) -----------------------------------------------------

const LIMITS = [300, 800, 1500, 3000];

function formatSize(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1).replace(/\.0$/, "")} GB` : `${Math.round(mb)} MB`;
}

type StorageInfo = Awaited<ReturnType<typeof nativeAudio.storageInfo>>;

async function renderStorage(): Promise<StorageInfo | null> {
  try {
    const info = await nativeAudio.storageInfo();
    const dl =
      (info.downloadedSongs ? ` · ${info.downloadedSongs} yours` : "") + (info.smartSongs ? ` · ${info.smartSongs} smart` : "");
    storageBtn.textContent = `Saved songs: ${info.songs} · ${formatSize(info.bytes)}${dl}`;
    return info;
  } catch {
    storageBtn.textContent = "Saved songs";
    return null;
  }
}

async function chooseStorage(): Promise<void> {
  const info = await renderStorage();
  const limit = info?.limitMb ?? 800;
  type Choice = number | "clear" | "clear-all";
  const options: { label: string; value: Choice; active?: boolean; danger?: boolean }[] = LIMITS.map((mb) => ({
    label: `Keep up to ${formatSize(mb * 1e6)}`,
    value: mb,
    active: mb === limit,
  }));
  const downloaded = info?.downloadedSongs ?? 0;
  options.push({ label: downloaded ? "Delete saved songs (keep downloads)" : "Delete saved songs now", value: "clear", danger: true });
  if (downloaded) options.push({ label: `Delete everything, downloads too (${downloaded})`, value: "clear-all", danger: true });
  const note = info
    ? `${info.songs} songs saved (${formatSize(info.bytes)}). Saved songs play instantly and work offline; the oldest are removed when the limit is reached.` +
      (downloaded
        ? ` ${downloaded} are your downloads (${formatSize(info.downloadedBytes ?? 0)}): kept until you remove them, not counted in the limit.`
        : "") +
      (info.smartSongs ? ` ${info.smartSongs} are smart downloads (${formatSize(info.smartBytes ?? 0)}).` : "")
    : "";
  const choice = await chooseOption<Choice>("Saved songs", options, note);
  if (choice === null) return;
  if (choice === "clear" || choice === "clear-all") {
    const { deleted } = await nativeAudio.clearCache({ includeDownloads: choice === "clear-all" }).catch(() => ({ deleted: 0 }));
    bus.emit("toast", `Deleted ${deleted} saved songs`);
    if (choice === "clear-all") {
      localStorage.removeItem("groov:downloaded-playlists"); // or they'd download again
      location.reload();
    }
  } else {
    await nativeAudio.setCacheLimit({ mb: choice }).catch(() => undefined);
    bus.emit("toast", `Keeping up to ${formatSize(choice * 1e6)} of songs`);
  }
  setTimeout(() => void renderStorage(), 500);
}

function renderKeyStatus(): void {
  const key = getYoutubeApiKey();
  if (hasNativeAudio) {
    // Full songs are built in on Android; the key is only a fallback.
    keyBtn.textContent = key ? "Backup YouTube key: set ✓" : "Backup YouTube key: none (optional)";
    return;
  }
  const source = hasCustomYoutubeKey() ? "your key" : hasAccountYoutubeKey() ? "from your account" : "built-in key";
  keyBtn.textContent = key ? `YouTube: full songs (${source})` : "YouTube: add key for full songs";
}

async function renderBackgroundStatus(): Promise<void> {
  const allowed = await isBackgroundPlayAllowed();
  if (allowed === null) return;
  backgroundBtn.style.display = "block";
  backgroundBtn.textContent = allowed
    ? "Background play: allowed ✓"
    : "Background play: tap to allow (stops music being killed)";
}

export function initSettings(): void {
  renderAutoplay();
  renderFavMix();
  favMixBtn.addEventListener("click", () => void chooseFavMix());
  autoplayBtn.addEventListener("click", () => {
    setAutoplay(!isAutoplayOn());
    renderAutoplay();
    bus.emit("toast", isAutoplayOn() ? "📻 Autoplay on" : "Autoplay off");
  });
  versionEl.textContent = `Groov v${__APP_VERSION__}`;
  renderKeyStatus();
  keyBtn.addEventListener("click", () => {
    const value = prompt(
      "Paste your YouTube Data API v3 key.\nLeave empty to go back to the built-in key (or 30s previews if there is none).",
      hasCustomYoutubeKey() ? getYoutubeApiKey() : "",
    );
    if (value === null) return;
    setYoutubeApiKey(value);
    renderKeyStatus();
    if (value.trim()) {
      void shareYoutubeKey(value.trim()).then((shared) => {
        if (shared) bus.emit("toast", "🔑 Key saved to your account: your other devices and friends get it too");
      });
    }
  });
  bus.on("youtubekeychange", renderKeyStatus);

  if (hasNativeAudio) {
    crossfadeBtn.style.display = "block";
    storageBtn.style.display = "block";
    renderCrossfade();
    void renderStorage();
    crossfadeBtn.addEventListener("click", () => void chooseCrossfade());
    void renderEq();
    smartBtn.style.display = "block";
    renderSmart();
    smartBtn.addEventListener("click", () => void chooseSmart());
    eqBtn.addEventListener("click", () => void chooseEq());
    bassBtn.addEventListener("click", () => void chooseBass());
    storageBtn.addEventListener("click", () => void chooseStorage());
    document.getElementById("mobile-menu-toggle")?.addEventListener("click", () => void renderStorage());
  }

  if (isNativeApp) {
    void renderBackgroundStatus();
    backgroundBtn.addEventListener("click", () => void openBackgroundPlaySettings());
    // Re-check when coming back from Android's settings screen.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void renderBackgroundStatus();
    });
  }
}
