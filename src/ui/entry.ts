import { supabase } from "../cloud/client";
import { signIn } from "../cloud/session";
import { isPlaying, pause } from "../player/player";
import { $ } from "../utils";
import { friendly } from "./account";

const root = document.documentElement;
const form = $<HTMLFormElement>("entry-form");
const emailInput = $<HTMLInputElement>("entry-email");
const passwordInput = $<HTMLInputElement>("entry-password");
const errorEl = $("entry-error");
const submitBtn = $<HTMLButtonElement>("entry-submit");

function hasSession(): boolean {
  try {
    return localStorage.getItem("groov:auth") !== null;
  } catch {
    return false;
  }
}

export function isEntryOpen(): boolean {
  return root.classList.contains("entry");
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.style.display = message ? "block" : "none";
}

function setOpen(open: boolean): void {
  if (open === isEntryOpen()) return;
  root.classList.toggle("entry", open);
  if (open) {
    if (isPlaying()) pause();
    passwordInput.value = "";
    showError("");
  }
}

export function initEntry(): void {
  setOpen(!hasSession());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    submitBtn.disabled = true;
    try {
      await signIn(emailInput.value, passwordInput.value);
      setOpen(false);
    } catch (err) {
      showError(friendly(err));
    } finally {
      submitBtn.disabled = false;
    }
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => setOpen(!session && !hasSession()), 0);
  });
}
