/**
 * Returns the runtime platform Focus3 is running on. Use to branch UI
 * decisions ("am I in the iOS app?", "am I a PWA on Android?").
 *
 * Stub — when we actually integrate Capacitor for App Store / Play Store
 * distribution, swap this to delegate to `Capacitor.getPlatform()` and
 * `Capacitor.isNativePlatform()`. Until then everyone runs on the web,
 * including the iOS-styled `?ui=ios` shell which is just a different
 * React tree, not a different platform.
 */
export type NativePlatform = "ios" | "android" | "web";

export function getNativePlatform(): NativePlatform {
  return "web";
}

export function isNativeApp(): boolean {
  return false;
}

export const NATIVE_PLATFORM: NativePlatform = getNativePlatform();
export const IS_NATIVE: boolean = isNativeApp();
