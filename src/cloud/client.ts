// Supabase: accounts, synced + shared playlists, play history.
// The publishable key is meant to ship inside apps; the database's
// row-level security rules (supabase/schema.sql) decide who can see what.
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://tuampzpsciqannjolflv.supabase.co";
export const SUPABASE_KEY = "sb_publishable_TAqzXvJVHGX85oH6vSQnAQ_toa4eAJf";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: "groov:auth",
  },
});
