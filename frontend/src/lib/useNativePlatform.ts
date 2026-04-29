import { Capacitor } from "@capacitor/core";

/**
 * Returns the runtime platform Focus3 is running on. Use to branch UI
 * decisions ("am I in the iOS app?", "am I a PWA on Android?").
 *
 * - "ios" / "android": running inside the Capacitor native shell.
 * - "web": browser tab, including PWAs installed to the home screen
 *   (Capacitor doesn't differentiate those from regular browser tabs).
 *
 * For UI decisions prefer this over a manual user toggle — the
 * platform answer is unambiguous and stays correct as the user moves
 * between web and app.
 */
export type NativePlatform = "ios" | "android" | "web";

export function getNativePlatform(): NativePlatform {
  const p = Capacitor.getPlatform();
  if (p === "ios" || p === "android") return p;
  return "web";
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

/** Pure constants — Capacitor's getPlatform() never changes within a session
 * so a hook isn't needed. Components can call these directly. */
export const NATIVE_PLATFORM: NativePlatform = getNativePlatform();
export const IS_NATIVE: boolean = isNativeApp();
