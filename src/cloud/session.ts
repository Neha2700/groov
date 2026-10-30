// Who's signed in. Kept tiny so any module can ask without import cycles.
import { bus } from "../state";
import { supabase } from "./client";

export interface Account {
  id: string;
  email: string;
  name: string;
}

let account: Account | null = null;

export function getAccount(): Account | null {
  return account;
}

export function isSignedIn(): boolean {
  return account !== null;
}

async function loadAccount(user: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null) {
  if (!user) {
    setAccount(null);
    return;
  }
  const fallbackName = (user.user_metadata?.display_name as string) || (user.email ?? "").split("@")[0];
  // Show something right away, then the saved display name.
  setAccount({ id: user.id, email: user.email ?? "", name: fallbackName });
  const { data } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  if (data?.display_name && account?.id === user.id) setAccount({ ...account, name: data.display_name });
}

function setAccount(next: Account | null): void {
  const changed = account?.id !== next?.id || account?.name !== next?.name;
  account = next;
  if (changed) bus.emit("authchange", account);
}

export async function signUp(name: string, email: string, password: string): Promise<"signed-in" | "confirm-email"> {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { display_name: name.trim() } },
  });
  if (error) throw error;
  // With "Confirm email" switched off in Supabase, sign-up signs you in.
  return data.session ? "signed-in" : "confirm-email";
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export function initSession(): void {
  supabase.auth.onAuthStateChange((_event, session) => {
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    setTimeout(() => void loadAccount(session?.user ?? null), 0);
  });
}
