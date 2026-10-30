// Crisp line/solid icons (24×24, currentColor) instead of emoji, so the
// controls look the same on every phone.
const svg = (body: string, cls = "") =>
  `<svg class="icon${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${body}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

export const icons = {
  play: svg(`<path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z" fill="currentColor"/>`),
  pause: svg(`<rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/>`),
  prev: svg(`<path d="M18.2 5.4v13.2a.9.9 0 0 1-1.38.76L8.6 13.6v4.9a1 1 0 0 1-2 0v-13a1 1 0 0 1 2 0v4.9l8.22-5.76a.9.9 0 0 1 1.38.76z" fill="currentColor"/>`),
  next: svg(`<path d="M5.8 5.4v13.2a.9.9 0 0 0 1.38.76l8.22-5.76v4.9a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v4.9L7.18 4.64A.9.9 0 0 0 5.8 5.4z" fill="currentColor"/>`),
  shuffle: svg(stroke("M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5")),
  repeat: svg(stroke("M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3")),
  repeatOne: svg(
    stroke("M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3") +
      `<path d="M11.2 10.2 12.4 9.6v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  heart: svg(stroke("M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.1 4.3 6.6-1.8 4.8-9.3 9.4-9.3 9.4z")),
  heartFilled: svg(
    `<path d="M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.1 4.3 6.6-1.8 4.8-9.3 9.4-9.3 9.4z" fill="currentColor"/>`,
  ),
  lyrics: svg(stroke("M4 6h16M4 12h10M4 18h7M17.5 14.5v5.2a1.8 1.8 0 1 1-1.2-1.7M17.5 14.5 21 13.5")),
  addTo: svg(stroke("M4 6h11M4 12h11M4 18h7M18 14v7M14.5 17.5h7")),
  radio: svg(
    stroke("M6.3 17.7a8 8 0 0 1 0-11.4M17.7 6.3a8 8 0 0 1 0 11.4M9.2 14.8a4 4 0 0 1 0-5.6M14.8 9.2a4 4 0 0 1 0 5.6") +
      `<circle cx="12" cy="12" r="1.6" fill="currentColor"/>`,
  ),
  queue: svg(stroke("M4 6h12M4 12h12M4 18h8M17 15v6l4-3z")),
  moon: svg(stroke("M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z")),
  more: svg(`<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>`),
  video: svg(stroke("M3.5 6.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM16.5 10.5l5-3v9l-5-3")),
  down: svg(stroke("M6 9l6 6 6-6")),
  download: svg(stroke("M12 4v11M7 10.5l5 5 5-5M5 20h14")),
  downloaded: svg(stroke("M5 12.5l4.5 4.5L19 7.5")),
};

export type IconName = keyof typeof icons;
