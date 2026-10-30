// "Share → Groov" from other apps (Android). The shared text usually holds a
// link: a song plays right away (then autoplay keeps going), a playlist or
// album is imported, anything else is searched for.
import { hasNativeAudio, nativeAudio } from "../player/native-audio";
import { playItem } from "../player/player";
import { toItem } from "../player/radio";
import { bus } from "../state";
import type { Item } from "../types";
import { $ } from "../utils";
import { isEntryOpen } from "./entry";
import { closeSidebar } from "./layout";
import { importFromLink } from "./views";

declare global {
  interface Window {
    groovShare?: (text: string) => void;
  }
}

const URL_RE = /https?:\/\/\S+|spotify:\S+/i;

/** YouTube video id from watch?v=, youtu.be/, shorts/, music.youtube.com/watch… */
function youtubeVideoId(url: string): string | null {
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ??
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ??
    url.match(/youtube\.com\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function playShared(item: Item): Promise<void> {
  await playItem(item);
  bus.emit("toast", `▶ ${item.name}`);
}

export async function handleShared(text: string): Promise<void> {
  const url = text.match(URL_RE)?.[0]?.replace(/[)\].,]+$/, "");
  closeSidebar();
  if (!url) return search(text);
  try {
    if (/spotify/i.test(url)) {
      if (/(playlist|album)[/:]/.test(url)) return void (await importFromLink(url));
      if (/track[/:]/.test(url)) {
        bus.emit("toast", "Finding the song…");
        const s = await nativeAudio.linkInfo({ spotify: url });
        return playShared({
          id: `sp-${s.id}`,
          name: s.title,
          subtitle: s.artists ?? "",
          artwork: null,
          previewUrl: null,
          externalUrl: url,
          topSubtitle: `Song · ${s.artists ?? ""}`,
          durationMs: s.durationMs || undefined,
        });
      }
    }
    if (/youtu/i.test(url)) {
      const videoId = youtubeVideoId(url);
      // A song (even one opened inside a playlist) plays; a playlist link imports.
      if (videoId) {
        bus.emit("toast", "Finding the song…");
        const t = await nativeAudio.linkInfo({ videoId });
        return playShared(
          toItem({
            videoId,
            title: t.title,
            artist: t.artist ?? "",
            durationSec: t.durationSec ?? 0,
            artwork: t.artwork ?? null,
          }),
        );
      }
      if (/[?&]list=/.test(url)) return void (await importFromLink(url));
    }
  } catch (err) {
    bus.emit("toast", `Couldn't open that link: ${(err as Error)?.message || "unknown error"}`);
    return;
  }
  // Some other link or text: search for it.
  search(text.replace(URL_RE, "").trim() || url);
}

function search(text: string): void {
  const input = $<HTMLInputElement>("search-input");
  input.value = text.slice(0, 100);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function initShare(): void {
  if (!hasNativeAudio) return;
  window.groovShare = (text: string) => {
    if (!isEntryOpen()) void handleShared(text);
  };
}
