// Sidebar "Account": sign in / create account, sign out, sync status.
import { getAccount, signIn, signOut, signUp, type Account } from "../cloud/session";
import { getSyncStatus, type SyncStatus } from "../cloud/sync";
import { bus } from "../state";
import { $ } from "../utils";
import { pushStep, removeStep } from "./back";

const accountBtn = $("account-btn");
const statusEl = $("sync-status");
const dialog = $("account-dialog");
const form = $<HTMLFormElement>("account-form");
const title = $("account-title");
const nameRow = $("account-name-row");
const nameInput = $<HTMLInputElement>("account-name");
const emailInput = $<HTMLInputElement>("account-email");
const passwordInput = $<HTMLInputElement>("account-password");
const errorEl = $("account-error");
const submitBtn = $<HTMLButtonElement>("account-submit");
const switchBtn = $("account-switch");

let mode: "sign-in" | "sign-up" = "sign-in";

const STATUS_TEXT: Record<SyncStatus, string> = {
  "signed-out": "",
  syncing: "Syncing…",
  synced: "Playlists synced ✓",
  offline: "Offline: changes will sync later",
};

function renderAccount(account: Account | null): void {
  accountBtn.textContent = account ? `${account.name} · Sign out` : "Sign in to sync playlists";
  renderStatus(getSyncStatus());
}

function renderStatus(status: SyncStatus): void {
  statusEl.textContent = getAccount() ? STATUS_TEXT[status] : "Playlists are only on this device";
}

function setMode(next: typeof mode): void {
  mode = next;
  const signUpMode = mode === "sign-up";
  title.textContent = signUpMode ? "Create account" : "Sign in";
  submitBtn.textContent = signUpMode ? "Create account" : "Sign in";
  switchBtn.textContent = signUpMode ? "Have an account? Sign in" : "New here? Create an account";
  nameRow.style.display = signUpMode ? "flex" : "none";
  nameInput.required = signUpMode;
  passwordInput.autocomplete = signUpMode ? "new-password" : "current-password";
  showError("");
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.style.display = message ? "block" : "none";
}

/** Open the sign-in (or create-account) dialog. */
export function openAccount(start: "sign-in" | "sign-up" = "sign-in"): void {
  if (getAccount()) return;
  open(start);
}

function open(start: "sign-in" | "sign-up" = "sign-in"): void {
  setMode(start);
  dialog.style.display = "flex";
  pushStep("account", close);
  setTimeout(() => emailInput.focus(), 50);
}

function close(): void {
  removeStep("account");
  dialog.style.display = "none";
  passwordInput.value = "";
}

/** Supabase's errors, in plain words. */
export function friendly(error: unknown): string {
  const msg = (error as Error)?.message || String(error);
  if (/invalid login credentials/i.test(msg)) return "Wrong email or password.";
  if (/already registered|already exists/i.test(msg)) return "That email already has an account. Sign in instead.";
  if (/password should be at least/i.test(msg)) return "Password needs at least 6 characters.";
  if (/email not confirmed/i.test(msg)) return "Confirm your email first (check your inbox).";
  if (/signups not allowed|signup is disabled/i.test(msg)) return "New accounts are switched off for this app.";
  if (/rate limit/i.test(msg)) return "Too many tries. Wait a minute and try again.";
  if (/fetch|network/i.test(msg)) return "Can't reach the server. Check your internet.";
  return msg;
}

export function initAccount(): void {
  accountBtn.addEventListener("click", async () => {
    if (!getAccount()) {
      open();
      return;
    }
    if (!confirm("Sign out? You'll need to sign in again to use Groov. Your playlists stay in your account.")) return;
    await signOut();
  });

  switchBtn.addEventListener("click", () => setMode(mode === "sign-in" ? "sign-up" : "sign-in"));
  $("account-cancel").addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    submitBtn.disabled = true;
    try {
      if (mode === "sign-up") {
        const result = await signUp(nameInput.value, emailInput.value, passwordInput.value);
        if (result === "confirm-email") {
          showError("Check your email to confirm the account, then sign in.");
          setMode("sign-in");
          return;
        }
      } else {
        await signIn(emailInput.value, passwordInput.value);
      }
      close();
    } catch (err) {
      showError(friendly(err));
    } finally {
      submitBtn.disabled = false;
    }
  });

  bus.on("authchange", renderAccount);
  bus.on("syncstatus", renderStatus);
  renderAccount(getAccount());
}
