// A bottom sheet with a few options (sleep timer, crossfade, storage...).
// Resolves with the chosen value, or null if dismissed.
import { escapeHtml } from "../utils";
import { pushStep, removeStep } from "./back";

export interface ChoiceOption<T> {
  label: string;
  value: T;
  active?: boolean;
  danger?: boolean;
}

let closeCurrent: (() => void) | null = null;

/** info: a short guide behind an ⓘ button in the sheet's header. */
export function chooseOption<T>(title: string, options: ChoiceOption<T>[], note = "", info = ""): Promise<T | null> {
  closeCurrent?.();
  return new Promise((resolve) => {
    const sheet = document.createElement("div");
    sheet.className = "queue-sheet choice-sheet";
    sheet.innerHTML = `
      <div class="queue-panel choice-panel" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="queue-header"><h2>${escapeHtml(title)}</h2>${
          info ? `<button class="choice-info-btn" aria-label="How to choose" aria-expanded="false">ⓘ</button>` : ""
        }</div>
        ${info ? `<div class="choice-info" hidden>${info}</div>` : ""}
        ${note ? `<div class="queue-now">${escapeHtml(note)}</div>` : ""}
        <div class="choice-list">
          ${options
            .map(
              (o, i) =>
                `<button class="choice-option${o.active ? " active" : ""}${o.danger ? " danger" : ""}" data-choice="${i}">
                   <span>${escapeHtml(o.label)}</span>${o.active ? "<span>✓</span>" : ""}
                 </button>`,
            )
            .join("")}
        </div>
      </div>`;
    const finish = (value: T | null) => {
      if (!sheet.isConnected) return;
      sheet.remove();
      removeStep("choice");
      closeCurrent = null;
      resolve(value);
    };
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet) return finish(null);
      const infoBtn = (e.target as Element).closest<HTMLElement>(".choice-info-btn");
      if (infoBtn) {
        const box = sheet.querySelector<HTMLElement>(".choice-info")!;
        box.hidden = !box.hidden;
        infoBtn.setAttribute("aria-expanded", String(!box.hidden));
        infoBtn.classList.toggle("active", !box.hidden);
        return;
      }
      const btn = (e.target as Element).closest<HTMLElement>("[data-choice]");
      if (btn) finish(options[Number(btn.dataset.choice)].value);
    });
    document.body.appendChild(sheet);
    pushStep("choice", () => finish(null));
    closeCurrent = () => finish(null);
  });
}
