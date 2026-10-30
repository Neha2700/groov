// Draggable seek bar (mouse + touch). While dragging, progress updates from
// the player are ignored so the thumb doesn't fight the finger; the seek
// happens once, on release.

export interface SeekBar {
  /** Show playback progress (0..1). Ignored while the user is dragging. */
  set(ratio: number): void;
  isDragging(): boolean;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

export function createSeekBar(
  el: HTMLElement,
  handlers: { onSeek: (ratio: number) => void; onPreview?: (ratio: number) => void },
): SeekBar {
  const fill = el.querySelector<HTMLElement>(".seekbar-fill")!;
  const thumb = el.querySelector<HTMLElement>(".seekbar-thumb")!;
  let dragging = false;
  let current = 0;

  const render = (ratio: number) => {
    const pct = `${(clamp(ratio) * 100).toFixed(3)}%`;
    fill.style.width = pct;
    thumb.style.left = pct;
    el.setAttribute("aria-valuenow", String(Math.round(clamp(ratio) * 100)));
  };

  const ratioAt = (clientX: number) => {
    const rect = el.getBoundingClientRect();
    return rect.width ? clamp((clientX - rect.left) / rect.width) : 0;
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    current = ratioAt(e.clientX);
    render(current);
    handlers.onPreview?.(current);
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    current = ratioAt(e.clientX);
    render(current);
    handlers.onPreview?.(current);
  });

  const finish = (commit: boolean) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    if (commit) handlers.onSeek(current);
  };
  el.addEventListener("pointerup", () => finish(true));
  el.addEventListener("pointercancel", () => finish(false));
  el.addEventListener("lostpointercapture", () => finish(true));

  // Keyboard: ←/→ jump 5% (the slider has focus, so Space still toggles play).
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.shiftKey) return; // Shift+arrows = previous/next track
    e.preventDefault();
    e.stopPropagation();
    const step = e.key === "ArrowRight" ? 0.05 : -0.05;
    current = clamp(current + step);
    render(current);
    handlers.onSeek(current);
  });

  return {
    set(ratio: number) {
      if (dragging) return;
      current = clamp(ratio);
      render(current);
    },
    isDragging: () => dragging,
  };
}
