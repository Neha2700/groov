import { $ } from "../utils";
import { pushStep, removeStep } from "./back";

const layoutEl = $("layout");
const bgBlurEl = $("bg-blur");

export function closeSidebar(): void {
  removeStep("sidebar");
  layoutEl.classList.remove("sidebar-open");
}

export function updateBackgroundArt(url: string | null | undefined): void {
  bgBlurEl.style.backgroundImage = url ? `url("${url}")` : "";
}

export function initLayout(): void {
  $("mobile-menu-toggle").addEventListener("click", () => {
    if (layoutEl.classList.toggle("sidebar-open")) pushStep("sidebar", closeSidebar);
    else removeStep("sidebar");
  });
  $("sidebar-backdrop").addEventListener("click", closeSidebar);
}
