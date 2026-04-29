import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase, isAuthEnabled } from "./supabaseClient";
import { logEvent } from "./metrics";

export interface AuthState {
  /** True when Supabase is configured (env vars present). */
  enabled: boolean;
  /** True until the initial getSession() resolves. */
  loading: boolean;
  user: User | null;
  signInWithMagicLink: (email: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

export function useAuth(): AuthState {
  const enabled = isAuthEnabled();
  const supabase = getSupabase();
  const [loading, setLoading] = useState(enabled);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      // Log fresh sign-ins (magic-link redemption, password sign-in). Skip
      // TOKEN_REFRESHED / INITIAL_SESSION so we don't double-count returning
      // tabs as "new sessions".
      if (event === "SIGNED_IN" && session?.user) {
        logEvent("session_signed_in");
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  const signInWithMagicLink = async (email: string) => {
    if (!supabase) return { error: "Supabase not configured" };
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    return error ? { error: error.message } : {};
  };

  const signOut = async () => {
    await supabase?.auth.signOut();
  };

  return { enabled, loading, user, signInWithMagicLink, signOut };
}
