import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wraps the same Vite-built React app as native iOS / Android
 * shells. The web build (`dist/`) is bundled into the app at sync time;
 * native plugins (Preferences, App, etc.) are exposed via JS bridge so
 * useNativePlatform() can pick the right behaviour at runtime.
 *
 * `server.androidScheme = "https"` keeps localStorage scoped to the same
 * origin in WebView as it would be in the browser, so a user's signed-in
 * session and cached data carry over if the URL ever changes.
 */
const config: CapacitorConfig = {
  appId: "com.focus3.app",
  appName: "Focus3",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  ios: {
    contentInset: "automatic",
  },
};

export default config;
