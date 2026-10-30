export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(s: string | null | undefined): string {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

/** Match quality of a result name against the query: exact > prefix > substring. */
export function scoreMatch(name: string | null | undefined, query: string): number {
  // Ignore case, punctuation and accents: "Don't" ~ "dont", "Beyoncé" ~ "beyonce".
  const clean = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const n = clean(name || "");
  const q = clean(query);
  if (!q) return 0;
  if (n === q) return 3;
  if (n.startsWith(q)) return 2;
  if (n.includes(q)) return 1;
  return 0;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function cssEscape(id: string): string {
  return typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(id) : id.replace(/"/g, '\\"');
}

/** Typed element lookup that fails loudly if index.html and the code drift apart. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/** JSON localStorage wrapper that never throws (private mode, full quota, etc). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable or full; the value just won't persist
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

type Listener<T> = (payload: T) => void;

/** Tiny typed event bus so modules can talk without importing each other. */
export function createEmitter<Events extends Record<string, unknown>>() {
  const listeners = new Map<keyof Events, Set<Listener<never>>>();
  return {
    on<K extends keyof Events>(event: K, fn: Listener<Events[K]>) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn as Listener<never>);
      return () => listeners.get(event)!.delete(fn as Listener<never>);
    },
    emit<K extends keyof Events>(event: K, payload: Events[K]) {
      listeners.get(event)?.forEach((fn) => (fn as Listener<Events[K]>)(payload));
    },
  };
}
