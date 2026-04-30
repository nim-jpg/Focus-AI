# Focus3 — Mobile & Native App Runbook

This covers two things:
1. **Mobile-responsive web** — how Focus3 behaves on phones in the browser.
2. **Native iOS / Android apps** — how to build and run them via Capacitor.

## 1. Mobile-responsive web

The same Vite + React build at `https://focus3-ai.vercel.app` adapts to phone
viewports automatically. No separate URL or build.

What changes under 640px width (Tailwind `sm:` breakpoint):
- Header collapses (subtitle hides; sign-out becomes a power icon).
- Tab bar wraps; action buttons collapse to icon-only (📥, ✨, +).
- WeekSchedule defaults to 1-day view (was 7); user can flip to 3 / 7 with
  manual horizontal scroll.
- Modals (Settings, TaskForm) become full-screen sheets.
- TopThree row stacks: number/title above, Schedule/Done/Snooze below.
- All buttons get a 40px minimum tap height; inputs force 16px font on mobile
  to stop iOS Safari's auto-zoom-on-focus.

If you spot something still cramped, check `frontend/src/lib/useMediaQuery.ts`
for the `useIsMobile()` hook and add a `sm:` Tailwind breakpoint.

## 2. Native iOS / Android via Capacitor

Capacitor wraps the same web build in a native shell — same React code, same
state, same Supabase backend. No separate UI codebase.

### Prerequisites

- **Node ≥ 20**, npm.
- **For iOS**: macOS + Xcode 15+ + a free Apple ID (CocoaPods auto-installs).
- **For Android**: Android Studio + an Android SDK (the Studio installer
  bundles it). Set `ANDROID_HOME` env var pointing at the SDK location.

You only need iOS if you're a Mac user planning to ship to App Store; Android
works on any OS.

### Run on a simulator

```bash
cd frontend
npm run cap:run:ios       # spins up iOS Simulator
# or
npm run cap:run:android   # spins up Android Emulator
```

`cap:sync` runs first — it builds the React app and copies the new `dist/`
into the native projects. The simulator boots and shows the Focus3 app.

### Run on a physical device

```bash
npm run cap:ios       # opens the project in Xcode
# or
npm run cap:android   # opens the project in Android Studio
```

In Xcode: pick your iPhone from the top device dropdown → click ▶ Run.
First run requires you to trust your developer profile on the device:
**Settings → General → VPN & Device Management → Developer App → Trust**.

In Android Studio: enable USB debugging on the phone (Settings → About →
tap Build Number 7 times → Developer Options → USB Debugging), plug in,
pick the device → click ▶ Run.

### After making code changes

```bash
npm run cap:sync          # rebuild + copy to native projects
```

Then re-run from Xcode / Android Studio. You don't need to re-`cap add`.

### What's already wired

- `@capacitor/preferences` — encrypted key-value store available if you
  ever want to migrate localStorage off the WebView's storage. Currently
  the WebView's localStorage is used as-is (works because Capacitor sandboxes
  it per-app).
- `@capacitor/app` — exposes the back-button event for Android. Currently
  not handled; pressing back closes the app. To intercept, see the snippet
  at the bottom of this file.
- `useNativePlatform()` — `frontend/src/lib/useNativePlatform.ts` exposes
  `IS_NATIVE` (true inside the Capacitor shell) and `NATIVE_PLATFORM`
  ("ios" | "android" | "web") so components can branch where needed.

### App Store / Play Store distribution

Out of scope for the runbook; broad strokes:
- **iOS App Store**: Apple Developer Program ($99/yr), App Store Connect
  metadata, app icon set (multiple sizes), screenshots for each device size,
  privacy policy URL, age rating, signed IPA upload.
- **Google Play**: Developer account ($25 one-time), Play Console listing,
  signed AAB upload, content rating questionnaire, store listing graphics.

For an internal-tester-only path that avoids App Store review:
- iOS: TestFlight (still requires the $99/yr developer membership, but no
  store review for internal testers — invite up to 100 by email).
- Android: just hand testers the signed APK, or use Play Internal Testing
  ($25 one-time, no review).

### Android back-button (when you want it)

Add to `App.tsx` near the other top-level effects:

```tsx
import { App as CapApp } from "@capacitor/app";
import { IS_NATIVE } from "@/lib/useNativePlatform";

useEffect(() => {
  if (!IS_NATIVE) return;
  const sub = CapApp.addListener("backButton", ({ canGoBack }) => {
    if (showSettings) { setShowSettings(false); return; }
    if (showBrainDump) { setShowBrainDump(false); return; }
    if (showPlannerScan) { setShowPlannerScan(false); return; }
    // No modal open — let the OS handle it (exit app or system back).
    if (!canGoBack) void CapApp.exitApp();
  });
  return () => { void sub.then((s) => s.remove()); };
}, [showSettings, showBrainDump, showPlannerScan]);
```

### Push notifications (when you want them)

The web `Notification` API works in PWAs but not on iOS by default until iOS
16.4+ for installed PWAs. For reliable push on both platforms, install the
`@capacitor/push-notifications` plugin and configure FCM (Android) + APNs
(iOS). Out of scope for the initial wrap.
