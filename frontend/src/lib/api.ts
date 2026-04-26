import { getSupabase } from "./supabaseClient";

/**
 * Fetch wrapper that attaches the Supabase JWT when auth is enabled.
 * Use this for every call to /api/* so the backend's auth middleware sees a
 * valid token in multi-user mode. In single-user / dev mode this just falls
 * through to a plain fetch.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const supabase = getSupabase();
  if (!supabase) return fetch(input, init);

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  return fetch(input, { ...init, headers });
}
