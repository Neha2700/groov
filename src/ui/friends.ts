// Sidebar "Friends": who's online, what they're playing, "Listen along".
// Plus the "Listening with Neha · Leave" bar in Now Playing, and toasts.
import { getJamInfo, listenAlong, stopListening, type JamInfo } from "../cloud/jam";
import { getFriends, type FriendStatus } from "../cloud/presence";
import { getAccount } from "../cloud/session";
import { bus } from "../state";
import { $, escapeHtml } from "../utils";
import { closeSidebar } from "./layout";

const section = $("friends-section");
const list = $("friends-list");
const listenersEl = $("jam-listeners");
const npJam = $("np-jam");
const npJamText = $("np-jam-text");
const toastEl = $("toast");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function statusLine(friend: FriendStatus, friends: FriendStatus[]): string {
  if (friend.listeningTo) {
    const host =
      friend.listeningTo === getAccount()?.id ? "you" : friends.find((f) => f.id === friend.listeningTo)?.name ?? "someone";
    return `🎧 Listening along with ${host}`;
  }
  if (friend.track && friend.playing) return `🎵 ${friend.track.name} · ${friend.track.subtitle}`;
  if (friend.track) return `⏸ ${friend.track.name}`;
  return "Online";
}

function render(): void {
  const signedIn = Boolean(getAccount());
  section.style.display = signedIn ? "block" : "none";
  if (!signedIn) return;

  const friends = getFriends();
  const jam: JamInfo = getJamInfo();

  listenersEl.textContent = jam.listeners.length
    ? `🎧 ${jam.listeners.map((l) => l.name).join(", ")} ${jam.listeners.length > 1 ? "are" : "is"} listening along with you`
    : "";
  listenersEl.style.display = jam.listeners.length ? "block" : "none";

  if (!friends.length) {
    list.innerHTML = `<div class="friends-empty">No friends online right now. When someone with a Groov account opens the app, they'll show up here.</div>`;
  } else {
    list.innerHTML = friends
      .map((f) => {
        const joinedThem = jam.joined?.id === f.id;
        // Only while they're actually playing: joining a paused friend does nothing.
        const canJoin = !joinedThem && Boolean(f.track) && f.playing && !f.listeningTo;
        const button = joinedThem
          ? `<button class="friend-btn leave" data-leave="1">Leave</button>`
          : canJoin
            ? `<button class="friend-btn" data-join="${escapeHtml(f.id)}" data-name="${escapeHtml(f.name)}">Listen along</button>`
            : "";
        return `
          <div class="friend">
            <span class="friend-dot"></span>
            <div class="friend-info">
              <div class="friend-name">${escapeHtml(f.name)}</div>
              <div class="friend-status">${escapeHtml(statusLine(f, friends))}</div>
            </div>
            ${button}
          </div>`;
      })
      .join("");
  }

  npJam.style.display = jam.joined ? "flex" : "none";
  npJamText.textContent = jam.joined ? `🎧 Listening with ${jam.joined.name}` : "";
}

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

export function initFriends(): void {
  list.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>("button");
    if (!btn) return;
    if (btn.dataset.leave) void stopListening();
    else if (btn.dataset.join) {
      void listenAlong(btn.dataset.join, btn.dataset.name ?? "your friend");
      closeSidebar();
    }
  });
  $("np-jam-leave").addEventListener("click", () => void stopListening());

  bus.on("friendschange", render);
  bus.on("jamchange", render);
  bus.on("authchange", render);
  bus.on("toast", toast);
  render();
}
