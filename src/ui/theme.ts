// Theme presets. Each one overrides only the hue-specific tokens (see the
// comment atop style.css's :root); the neutral glass tokens stay shared,
// which keeps every theme feeling like the same app.
import { KEYS } from "../config";
import { $ } from "../utils";

interface Theme {
  label: string;
  vars: Record<string, string>;
}

const THEMES: Record<string, Theme> = {
  indigo: {
    label: "Indigo and gold",
    vars: {
      "--bg": "#15082e",
      "--accent-1": "#2e3f8f",
      "--accent-2": "#d4af37",
      "--accent-2-bright": "#f2c94c",
      "--accent-soft": "rgba(242, 201, 76, 0.35)",
      "--topbar-bg": "rgba(24, 10, 48, 0.55)",
      "--bg-blur-gradient": "linear-gradient(145deg, #050714 0%, #101a3c 35%, #1b2a63 70%, #02030a 100%)",
      "--bg-overlay-gradient":
        "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(212, 175, 55, 0.3), transparent 60%), linear-gradient(170deg, rgba(27, 42, 99, 0.55) 0%, rgba(6, 8, 20, 0.88) 65%, rgba(3, 4, 10, 0.96) 100%)",
    },
  },
  teal: {
    label: "Midnight teal and amber",
    vars: {
      "--bg": "#04120f",
      "--accent-1": "#0f6e56",
      "--accent-2": "#d9842c",
      "--accent-2-bright": "#f2a93c",
      "--accent-soft": "rgba(242, 169, 60, 0.35)",
      "--topbar-bg": "rgba(5, 20, 17, 0.6)",
      "--bg-blur-gradient": "linear-gradient(145deg, #020a08 0%, #04201a 35%, #0f6e56 70%, #010403 100%)",
      "--bg-overlay-gradient":
        "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(217, 132, 44, 0.3), transparent 60%), linear-gradient(170deg, rgba(15, 110, 86, 0.5) 0%, rgba(3, 10, 8, 0.88) 65%, rgba(2, 5, 4, 0.96) 100%)",
    },
  },
  emerald: {
    label: "Emerald and charcoal",
    vars: {
      "--bg": "#0a0a0a",
      "--accent-1": "#14532d",
      "--accent-2": "#1ed760",
      "--accent-2-bright": "#3df27a",
      "--accent-soft": "rgba(61, 242, 122, 0.3)",
      "--topbar-bg": "rgba(10, 10, 10, 0.6)",
      "--bg-blur-gradient": "linear-gradient(145deg, #050505 0%, #0d1f17 35%, #14532d 70%, #020302 100%)",
      "--bg-overlay-gradient":
        "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(30, 215, 96, 0.25), transparent 60%), linear-gradient(170deg, rgba(20, 83, 45, 0.5) 0%, rgba(5, 5, 5, 0.9) 65%, rgba(3, 3, 3, 0.96) 100%)",
    },
  },
  sunset: {
    label: "Sunset noir",
    vars: {
      "--bg": "#0d0604",
      "--accent-1": "#7a2e12",
      "--accent-2": "#e2703a",
      "--accent-2-bright": "#f2905a",
      "--accent-soft": "rgba(242, 144, 90, 0.35)",
      "--topbar-bg": "rgba(13, 6, 4, 0.6)",
      "--bg-blur-gradient": "linear-gradient(145deg, #0a0403 0%, #2b1008 35%, #7a2e12 70%, #040201 100%)",
      "--bg-overlay-gradient":
        "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(226, 112, 58, 0.3), transparent 60%), linear-gradient(170deg, rgba(122, 46, 18, 0.5) 0%, rgba(8, 4, 3, 0.88) 65%, rgba(4, 2, 1, 0.96) 100%)",
    },
  },
};

const swatchesEl = $("theme-swatches");

// The theme id is stored as a raw string (not JSON) to stay compatible with
// what earlier builds wrote.
function readThemeId(): string {
  try {
    return localStorage.getItem(KEYS.theme) || "indigo";
  } catch {
    return "indigo";
  }
}

function applyTheme(id: string): void {
  const theme = THEMES[id] ?? THEMES.indigo;
  const root = document.documentElement.style;
  for (const [prop, value] of Object.entries(theme.vars)) root.setProperty(prop, value);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.vars["--bg"]);
  try {
    localStorage.setItem(KEYS.theme, id);
  } catch {
    // theme just won't persist
  }
  swatchesEl.querySelectorAll<HTMLElement>(".theme-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === id);
  });
}

export function initTheme(): void {
  const activeId = readThemeId();
  swatchesEl.innerHTML = "";
  for (const [id, theme] of Object.entries(THEMES)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `theme-swatch${id === activeId ? " active" : ""}`;
    btn.dataset.theme = id;
    btn.title = theme.label;
    btn.setAttribute("aria-label", theme.label);
    btn.style.background = `linear-gradient(135deg, ${theme.vars["--accent-1"]}, ${theme.vars["--accent-2"]})`;
    btn.addEventListener("click", () => applyTheme(id));
    swatchesEl.appendChild(btn);
  }
  applyTheme(activeId);
}
