import { useEffect, useState } from "react";

/**
 * Reactive media-query hook. Returns true when the query matches and
 * re-renders on viewport change. SSR-safe (returns false on the server).
 *
 * Usage: const isMobile = useMediaQuery("(max-width: 639px)");
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

/** Tailwind's `sm` breakpoint is 640px — under that we treat as phone. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 639px)");
}
