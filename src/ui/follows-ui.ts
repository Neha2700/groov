// Artists you follow: the sidebar list, and "From artists you follow" on Home.
import { getFollows, loadFollowedSongs } from "../library/follows";
import { bus } from "../state";
import { $, escapeHtml } from "../utils";
import { cardMarkup } from "./cards";
import { closeSidebar } from "./layout";
import { openArtist } from "./views";

const section = $("follows-section");
const list = $("follows-list");
const homeSection = $("followed-section");
const homeGrid = $("followed-grid");

function renderSidebar(): void {
  const follows = getFollows();
  section.style.display = follows.length ? "block" : "none";
  list.innerHTML = follows
    .map(
      (f) => `
      <button class="playlist-nav-item follow-item" data-artist-id="${f.id ?? ""}" data-artist-name="${escapeHtml(f.name)}">
        ${
          f.artwork
            ? `<img class="follow-avatar" src="${escapeHtml(f.artwork)}" alt="" loading="lazy" />`
            : `<span class="playlist-nav-icon">🎤</span>`
        }
        <span class="playlist-nav-name">${escapeHtml(f.name)}</span>
      </button>`,
    )
    .join("");
}

let homeToken = 0;

export async function renderFollowedRow(): Promise<void> {
  const t = ++homeToken;
  if (!getFollows().length) {
    homeSection.style.display = "none";
    return;
  }
  const songs = await loadFollowedSongs().catch(() => []);
  if (t !== homeToken) return;
  homeSection.style.display = songs.length ? "block" : "none";
  homeGrid.innerHTML = songs.slice(0, 15).map((s) => cardMarkup(s, "tracks")).join("");
}

export function initFollowsUi(): void {
  list.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>(".follow-item");
    if (!btn) return;
    closeSidebar();
    void openArtist(Number(btn.dataset.artistId) || null, btn.dataset.artistName ?? "");
  });
  bus.on("followchange", () => {
    renderSidebar();
    if ($("recent-view").style.display !== "none") void renderFollowedRow();
  });
  renderSidebar();
  // Radio mixes in songs by artists you follow: have them ready in advance.
  setTimeout(() => void loadFollowedSongs().catch(() => undefined), 4000);
  bus.on("followchange", () => void loadFollowedSongs().catch(() => undefined));
}
