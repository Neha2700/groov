// First-time guide: what to set up, in order. Shown once; reopen it from
// Settings → "Help & setup". On the laptop, if there's still no YouTube key
// after signing in, it walks you through getting a free one.
import { getYoutubeApiKey } from "../config";
import { getAccount } from "../cloud/session";
import { isBackgroundPlayAllowed, isNativeApp, openBackgroundPlaySettings } from "../player/media-controls";
import { bus } from "../state";
import { storage } from "../utils";
import { openAccount } from "./account";
import { pushStep, removeStep } from "./back";
import { isEntryOpen } from "./entry";

const SEEN_KEY = "groov:welcome-seen";
const KEY_GUIDE_KEY = "groov:key-guide-dismissed";

let sheet: HTMLElement | null = null;

function close(): void {
  sheet?.remove();
  sheet = null;
  removeStep("welcome");
}

function show(html: string, wire: (root: HTMLElement) => void): void {
  close();
  sheet = document.createElement("div");
  sheet.className = "welcome-sheet";
  sheet.innerHTML = `<div class="welcome-panel" role="dialog" aria-label="Welcome">${html}</div>`;
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || (e.target as Element).closest("[data-close]")) close();
  });
  document.body.appendChild(sheet);
  pushStep("welcome", close);
  wire(sheet);
}

const step = (n: number, title: string, body: string, done = false) => `
  <div class="welcome-step${done ? " done" : ""}">
    <div class="welcome-num">${done ? "✓" : n}</div>
    <div class="welcome-step-body"><b>${title}</b>${body}</div>
  </div>`;

/** The welcome guide (phone or laptop). */
export async function openWelcome(): Promise<void> {
  storage.set(SEEN_KEY, true);
  const signedIn = !!getAccount();
  const hasKey = !!getYoutubeApiKey();
  const background = isNativeApp ? await isBackgroundPlayAllowed() : true;

  const account = step(
    1,
    signedIn ? `Signed in as ${getAccount()!.name}` : "Sign in",
    signedIn
      ? `<p>Your playlists, likes, follows and history sync across your devices. Use the same account on all of them.</p>`
      : `<p>Sign in with the same email on every device.</p>
         <div class="welcome-buttons">
           <button class="welcome-btn primary" data-act="sign-in">Sign in</button>
         </div>`,
    signedIn,
  );

  const second = isNativeApp
    ? step(
        2,
        "Let music play in the background",
        background === false
          ? `<p>So Android doesn't stop the music when the screen is off.</p>
             <div class="welcome-buttons"><button class="welcome-btn primary" data-act="background">Allow background play</button></div>`
          : `<p>All set — music keeps playing with the screen off.</p>`,
        background !== false,
      )
    : step(
        2,
        hasKey ? "Full songs are on" : "Full songs on the laptop: a free YouTube key",
        hasKey
          ? `<p>Your YouTube key is set${signedIn ? " (shared through your account)" : ""}.</p>`
          : `<p>${
              signedIn
                ? "No one in your group has saved a key yet."
                : "If a friend already saved one, signing in brings it automatically."
            } Without it, searched songs play 30-second previews (radio and mixes still play in full).</p>
             <div class="welcome-buttons"><button class="welcome-btn primary" data-act="key-guide">Show me how (5 min)</button></div>`,
        hasKey,
      );

  const tips = step(
    3,
    "Good to know",
    `<ul>
       ${isNativeApp ? "<li><b>Share → Groov</b> from YouTube, YT Music or Spotify plays a song or imports a playlist.</li>" : ""}
       ${isNativeApp ? "<li>Tap <b>⬇</b> on a playlist to keep it offline; <b>Smart downloads</b> (Settings) keep your mixes ready on Wi-Fi.</li>" : ""}
       <li><b>＋</b> next to Your Playlists: create one, or import from YouTube / Spotify.</li>
       <li>Long-press any song for Play next, Add to queue, Radio and more.</li>
     </ul>`,
  );

  show(
    `<div class="welcome-head">
       <img src="./favicon.svg" alt="" class="welcome-logo" />
       <div><h2>Welcome to Groov</h2><p>Three quick things and you're set.</p></div>
     </div>
     ${account}${second}${tips}
     <button class="welcome-btn primary wide" data-close>Let's go</button>`,
    (root) => {
      root.querySelector('[data-act="sign-in"]')?.addEventListener("click", () => {
        close();
        openAccount("sign-in");
      });
      root.querySelector('[data-act="background"]')?.addEventListener("click", () => void openBackgroundPlaySettings());
      root.querySelector('[data-act="key-guide"]')?.addEventListener("click", () => openKeyGuide());
    },
  );
}

/** Getting a free YouTube Data API key, step by step (laptop). */
export function openKeyGuide(): void {
  const site = location.host || "aaditya007x.github.io";
  show(
    `<div class="welcome-head"><div><h2>Free YouTube key</h2><p>About 5 minutes, once. Free — you won't be charged.</p></div></div>
     ${step(1, "Open Google Cloud", `<p>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> and sign in with any Google account. Create a project (any name, e.g. "Groov").</p>`)}
     ${step(2, "Turn on YouTube", `<p>Menu → <b>APIs &amp; Services → Library</b> → search <b>YouTube Data API v3</b> → <b>Enable</b>.</p>`)}
     ${step(3, "Create the key", `<p><b>APIs &amp; Services → Credentials → Create credentials → API key</b>. Copy it.</p>`)}
     ${step(4, "Lock it to Groov (recommended)", `<p>Edit the key → <b>Website restrictions</b> → add <code>https://${site}/*</code>, and under API restrictions choose <b>YouTube Data API v3</b>. Then no one else can use it.</p>`)}
     ${step(5, "Paste it into Groov", `<p>${getAccount() ? "It's saved to your account, so your other devices and friends get it too." : "Sign in first if you want it to reach your other devices and friends."}</p>
        <div class="welcome-buttons"><button class="welcome-btn primary" data-act="paste">Paste my key</button></div>`)}
     <button class="welcome-btn wide" data-close>Later</button>`,
    (root) => {
      root.querySelector('[data-act="paste"]')?.addEventListener("click", () => {
        close();
        document.getElementById("youtube-key-btn")?.click();
      });
    },
  );
}

export function initWelcome(): void {
  // First time: once the app has settled (and after signing in).
  const firstTime = () => {
    if (!storage.get<boolean>(SEEN_KEY, false) && !isEntryOpen()) void openWelcome();
  };
  setTimeout(firstTime, 1500);
  bus.on("authchange", (account) => {
    if (account) setTimeout(firstTime, 1500);
  });
  // Laptop: signed in but still no key → offer the key guide once.
  if (!isNativeApp) {
    bus.on("authchange", (account) => {
      if (!account || storage.get<boolean>(KEY_GUIDE_KEY, false)) return;
      setTimeout(() => {
        if (getYoutubeApiKey() || sheet) return;
        storage.set(KEY_GUIDE_KEY, true);
        openKeyGuide();
      }, 4000); // the shared key arrives a moment after sign-in
    });
  }
}
