// One step back at a time, like any Android app: the back button closes
// whatever is on top (popover, lyrics, Now Playing, sidebar), then goes back
// through the views (playlist → previous view, search results → home).
// With nothing left, Android minimizes the app (music keeps playing).
//
// Android calls window.groovBack() from MainActivity; on the web, the
// browser's back button goes through a history entry kept while steps exist.

interface Step {
  id: string;
  undo: () => void;
}

const steps: Step[] = [];
const isWeb = !("androidBridge" in window);
let trapArmed = false;
let ignoreNextPop = false;

/** Register something the back button should undo. Same id replaces. */
export function pushStep(id: string, undo: () => void): void {
  removeStep(id);
  steps.push({ id, undo });
  syncTrap();
}

/** The thing was closed some other way (✕ button, tap outside…). */
export function removeStep(id: string): void {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) steps.splice(i, 1);
  syncTrap();
}

export function hasStep(id: string): boolean {
  return steps.some((s) => s.id === id);
}

/** Undo the top step. Returns false when there's nothing left to undo. */
export function goBack(): boolean {
  const step = steps.pop();
  if (!step) return false;
  step.undo();
  syncTrap();
  return true;
}

// --- Browser back button (laptop / web) -------------------------------------------

let syncPending = false;

/**
 * Settle the browser history once, after the current changes: closing one
 * sheet and opening another in the same moment must not touch history
 * (a back() racing a pushState() could leave the page).
 */
function syncTrap(): void {
  if (!isWeb || syncPending) return;
  syncPending = true;
  setTimeout(() => {
    syncPending = false;
    applyTrap();
  }, 0);
}

function applyTrap(): void {
  if (steps.length && !trapArmed) {
    history.pushState({ groovBack: true }, "");
    trapArmed = true;
  } else if (!steps.length && trapArmed) {
    trapArmed = false;
    ignoreNextPop = true;
    history.back();
  }
}

export function initBack(): void {
  (window as Window & { groovBack?: () => boolean }).groovBack = goBack;
  if (!isWeb) return;
  window.addEventListener("popstate", () => {
    if (ignoreNextPop) {
      ignoreNextPop = false;
      return;
    }
    trapArmed = false;
    goBack();
  });
}
