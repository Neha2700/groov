// Debounced search-as-you-type with a scored top result, per-category
// sections with "See all", and recent searches.
import { CATEGORY_LABELS, fetchCategory, searchCatalog } from "../api/itunes";
import { DEBOUNCE_MS, KEYS, MIN_QUERY_LENGTH, OVERVIEW_LIMIT, SEE_ALL_LIMIT } from "../config";
import type { Category, Item, SearchResult } from "../types";
import { $, debounce, escapeHtml, storage } from "../utils";
import { cardMarkup, topResultMarkup } from "./cards";
import { showView } from "./views";
import { hasStep, pushStep, removeStep } from "./back";

const searchInput = $<HTMLInputElement>("search-input");
const clearButton = $("clear-input");
const emptyView = $("empty-view");
const recentChips = $("recent-chips");
const clearRecentBtn = $("clear-recent");
const recentEmpty = $("recent-empty");
const topResultEl = $("top-result");
const sectionsEl = $("category-sections");

// --- Recent searches ----------------------------------------------------------

const getRecentSearches = () => storage.get<string[]>(KEYS.recent, []);

function saveRecentSearch(term: string): void {
  const trimmed = term.trim();
  if (!trimmed) return;
  const rest = getRecentSearches().filter((t) => t.toLowerCase() !== trimmed.toLowerCase());
  storage.set(KEYS.recent, [trimmed, ...rest].slice(0, 8));
}

function renderRecentChips(): void {
  const recents = getRecentSearches();
  recentChips.innerHTML = "";
  clearRecentBtn.style.display = recents.length ? "inline-flex" : "none";
  recentEmpty.style.display = recents.length ? "none" : "block";

  for (const term of recents) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = `<span>🕘 ${escapeHtml(term)}</span>`;
    chip.addEventListener("click", () => {
      searchInput.value = term;
      clearButton.style.display = "flex";
      void runSearch(term);
      searchInput.focus();
    });
    recentChips.appendChild(chip);
  }
}

/** Back from search results clears the search and returns home. */
function recordSearchStep(): void {
  if (hasStep("search")) return;
  pushStep("search", () => {
    searchInput.value = "";
    clearButton.style.display = "none";
    searchInput.blur();
    showHome();
  });
}

function showHome(): void {
  removeStep("search");
  activeController?.abort();
  showView("recent");
  renderRecentChips();
}

// --- Results --------------------------------------------------------------------

function renderTopResult(best: SearchResult["best"]): void {
  if (!best) {
    topResultEl.innerHTML = "";
    topResultEl.style.display = "none";
    return;
  }
  topResultEl.style.display = "block";
  topResultEl.innerHTML = topResultMarkup(best.item, best.category);
}

function renderSections(matches: SearchResult["matches"], query: string): void {
  sectionsEl.innerHTML = "";
  let anyResults = false;

  for (const [category, label] of Object.entries(CATEGORY_LABELS) as [Category, string][]) {
    const items = matches[category] || [];
    if (!items.length) continue;
    anyResults = true;

    const visible = items.slice(0, OVERVIEW_LIMIT);
    const hasMore = items.length > OVERVIEW_LIMIT;
    const gridHtml = (list: Item[]) => list.map((item) => cardMarkup(item, category)).join("");

    const section = document.createElement("section");
    section.className = "category-section";
    section.innerHTML = `
      <div class="section-header">
        <h2 class="section-title">${label}</h2>
        ${hasMore ? `<button class="see-all">See all</button>` : ""}
      </div>
      <div class="card-grid card-row">${gridHtml(visible)}</div>
    `;

    if (hasMore) {
      let expandedItems: Item[] | null = null;
      const btn = section.querySelector<HTMLButtonElement>(".see-all")!;
      const grid = section.querySelector<HTMLElement>(".card-grid")!;
      btn.addEventListener("click", async () => {
        if (btn.textContent === "Show less") {
          grid.classList.add("card-row");
          grid.innerHTML = gridHtml(visible);
          btn.textContent = "See all";
          return;
        }
        if (!expandedItems) {
          btn.textContent = "Loading…";
          btn.disabled = true;
          try {
            expandedItems = await fetchCategory(query, category, SEE_ALL_LIMIT);
          } catch {
            expandedItems = items; // fall back to what we already have
          }
          btn.disabled = false;
        }
        grid.classList.remove("card-row"); // "See all": everything, as a grid
        grid.innerHTML = gridHtml(expandedItems);
        btn.textContent = "Show less";
      });
    }

    sectionsEl.appendChild(section);
  }

  emptyView.style.display = anyResults ? "none" : "block";
  if (!anyResults) emptyView.querySelector(".query-text")!.textContent = query;
}

let activeController: AbortController | null = null;

async function runSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    showHome();
    return;
  }

  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  recordSearchStep();
  showView("loading");

  let result: SearchResult;
  try {
    // One extra item per category, purely as a cheap "is there more?" signal.
    result = await searchCatalog(trimmed, OVERVIEW_LIMIT + 1, controller.signal);
  } catch (err) {
    if ((err as Error).name === "AbortError" || controller.signal.aborted) return;
    showView("results");
    sectionsEl.innerHTML = "";
    topResultEl.style.display = "none";
    emptyView.style.display = "block";
    emptyView.querySelector(".query-text")!.textContent = `${trimmed}" — network error reaching the catalog`;
    return;
  }

  if (controller.signal.aborted) return; // a newer search started meanwhile

  showView("results");
  renderTopResult(result.best);
  renderSections(result.matches, trimmed);
  shownQuery = trimmed;
}

/** The search whose results are on screen (saved once you use them). */
let shownQuery: string | null = null;

/**
 * Save the search to "Recent searches" only once it's actually used: tapping
 * a result, adding a song, "See all", or pressing Enter. Typing "demons"
 * saves just "demons", not "de" and "demo" on the way.
 */
function commitSearch(): void {
  if (!shownQuery) return;
  saveRecentSearch(shownQuery);
  renderRecentChips();
}

export function initSearch(): void {
  // Any tap on the results (play, add, open, See all) counts as using them.
  $("results-view").addEventListener("click", commitSearch, true);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    searchInput.blur(); // hides the keyboard on phones
    if (shownQuery && shownQuery === searchInput.value.trim()) commitSearch();
    else void runSearch(searchInput.value).then(commitSearch);
  });
  const debouncedSearch = debounce((q: string) => void runSearch(q), DEBOUNCE_MS);

  searchInput.addEventListener("input", () => {
    const value = searchInput.value;
    clearButton.style.display = value ? "flex" : "none";
    if (value.trim().length < MIN_QUERY_LENGTH) showHome();
    else debouncedSearch(value);
  });

  searchInput.addEventListener("focus", () => {
    if (!searchInput.value.trim()) showHome();
  });

  clearButton.addEventListener("click", () => {
    searchInput.value = "";
    clearButton.style.display = "none";
    showHome();
    searchInput.focus();
  });

  clearRecentBtn.addEventListener("click", () => {
    storage.remove(KEYS.recent);
    renderRecentChips();
  });

  showHome();
}
