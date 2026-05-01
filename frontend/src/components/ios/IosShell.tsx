import { Fragment, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { Goal, PrioritizedTask, Task, UserPrefs } from "@/types/task";
import { prioritize } from "@/lib/prioritize";
import { fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import { inferTaskKind, isActionable, kindGlyph, kindLabel } from "@/lib/taskKind";
import {
  autoReschedule,
  cascadeShift,
  collectDayItems,
  type DayItem,
  type UnscheduledItem,
} from "@/lib/dayPlan";

type Tab = "focus" | "goals";

interface IosShellProps {
  tasks: Task[];
  goals: Goal[];
  prefs: UserPrefs;
  prioritized: PrioritizedTask[];
  foundations: Task[];
  aiTierMap?: Map<string, 1 | 2 | 3 | 4>;
  onComplete: (id: string) => void;
  /** Outcome-aware close. Called from the Completion sheet on iOS:
   *   - "achieved"          → outcome matched intent
   *   - "course-corrected"  → outcome diverged; spawn followUp.title as a follow-up task
   *   - "accepted"          → outcome diverged but the user chose to move on
   * Implemented in App.tsx — sets resolution fields on the closed task and
   * (for course-correct) creates the follow-up linked back to the original. */
  onResolve: (
    id: string,
    resolution: "achieved" | "course-corrected" | "accepted",
    opts?: { note?: string; followUp?: { title: string } },
  ) => void;
  onToggleTask: (id: string) => void;
  onRemoveTask: (id: string) => void;
  onEditTask: (id: string) => void;
  onSchedule: (id: string) => void;
  onUnsnooze: (id: string) => void;
  onSnooze: (id: string, untilIso: string) => void;
  onIncrementCounter: (id: string, delta: number) => void;
  onDeferFoundation: (id: string) => void;
  /** Set scheduledFor on a task — used by Hyper Focus ±15/±60 + auto-reschedule. */
  onSetScheduledFor: (taskId: string, iso: string) => void;
  /** Update estimatedMinutes on a task — used by the ±5 duration chip on lane cards. */
  onUpdateEstimatedMinutes: (taskId: string, minutes: number) => void;
  /** Generic patch on a task — used by smart-snooze to move scheduledFor
   *  on one-off tasks (one event, no duplication). */
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  /** Mute a Google calendar event (adds to prefs.ignoredEventIds). */
  onMuteEvent: (eventId: string) => void;
  onAddGoal: (input: Omit<Goal, "id" | "createdAt" | "updatedAt" | "source">) => void;
  onUpdateGoal: (id: string, patch: Partial<Goal>) => void;
  onRemoveGoal: (id: string) => void;
  onAddTask: () => void;
  onBrainDump: () => void;
  taskCountByGoal: Map<string, number>;
  goalProgress: Map<string, { doneLast30: number; lastActivityIso?: string }>;
  calendarConnected: boolean;
  onRefreshAi: () => void;
  aiBusy: boolean;
  aiRefreshTick: number;
  onExitIosLayout: () => void;
}

/**
 * iOS shell — the "do things now" companion to the desktop app.
 *
 * Two surfaces:
 *  - Focus → today's calendar strip + compact top-3 + stretch + Quick+ tray.
 *           A "Hyper Focus" pill opens a full-screen mode for heads-down work.
 *  - Goals → tasks grouped by goal (read-only goals; create/edit lives on
 *           desktop). Tap a goal card to expand its tasks and tick them off.
 *
 * Hyper Focus overlay = today's foundations + a day timeline with lanes for
 * concurrent events, scroll-through-day controls, and a persistent Quick+
 * tray. Designed to be left open during the day or popped open ad-hoc.
 *
 * The desktop view stays the configurator (goal CRUD, AI mapping, settings,
 * backup/restore, calendar connect). iOS reads from the same backend.
 */
export function IosShell(props: IosShellProps) {
  const [tab, setTab] = useState<Tab>("focus");
  const [fabOpen, setFabOpen] = useState(false);
  // Hyper Focus is a 3-state machine: closed → countdown ("grab your
  // coffee...") → open. The countdown is a deliberate ritual — gives the
  // user a moment to land in their seat before the day plan takes over.
  const [hyperState, setHyperState] = useState<"closed" | "countdown" | "open">("closed");
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const completingTask = useMemo(
    () => (completingId ? props.tasks.find((t) => t.id === completingId) : null),
    [completingId, props.tasks],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => setScrolled(el.scrollTop > 16);
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [tab]);

  return (
    <div className="ios-root flex h-screen flex-col">
      <header
        className="sticky top-0 z-20 transition-all"
        style={{
          paddingTop: "max(env(safe-area-inset-top, 0), 8px)",
          background: scrolled ? "rgba(11, 14, 19, 0.78)" : "transparent",
          backdropFilter: scrolled ? "saturate(180%) blur(24px)" : "none",
          WebkitBackdropFilter: scrolled ? "saturate(180%) blur(24px)" : "none",
        }}
      >
        <div className="flex items-end justify-between gap-3 px-6 pb-4 pt-2">
          <div className="min-w-0 flex-1">
            <h1
              className="font-bold tracking-tight transition-all"
              style={{
                fontSize: scrolled ? "20px" : "40px",
                lineHeight: scrolled ? "24px" : "44px",
                letterSpacing: "-0.035em",
                color: "var(--ios-text)",
              }}
            >
              {TAB_TITLES[tab]}
            </h1>
            {!scrolled && (
              <p
                className="mt-1 text-[15px] font-medium"
                style={{ color: "var(--ios-text-secondary)" }}
              >
                {TAB_SUBTITLES[tab]}
              </p>
            )}
          </div>
          <div className="flex flex-none items-center gap-2">
            <HyperLaunchButton onClick={() => setHyperState("countdown")} />
            <button
              type="button"
              onClick={props.onExitIosLayout}
              className="-mr-1 inline-flex h-8 items-center rounded-md px-3 text-[12px] font-medium"
              style={{
                color: "var(--ios-accent)",
                background: "var(--ios-accent-soft)",
              }}
            >
              Desktop
            </button>
          </div>
        </div>
      </header>

      <main
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0) + 116px)" }}
      >
        <div key={tab} className="ios-fade-in">
          {tab === "focus" && (
            <FocusTab
              {...props}
              onAskComplete={(id) => props.onToggleTask(id)}
            />
          )}
          {tab === "goals" && (
            <GoalsTab {...props} onAskComplete={(id) => props.onToggleTask(id)} />
          )}
        </div>
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t"
        style={{
          paddingBottom: "env(safe-area-inset-bottom, 0)",
          background: "rgba(15, 18, 24, 0.85)",
          backdropFilter: "saturate(180%) blur(24px)",
          WebkitBackdropFilter: "saturate(180%) blur(24px)",
          borderColor: "var(--ios-border)",
        }}
      >
        <div className="mx-auto grid max-w-md grid-cols-3 items-end px-2 pt-1">
          <TabButton
            label="Focus"
            icon={IconFocus}
            active={tab === "focus"}
            onClick={() => setTab("focus")}
          />
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setFabOpen(true)}
              className="ios-fab -mt-7 flex h-14 w-14 items-center justify-center rounded-full text-white"
              style={{
                background:
                  "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
                boxShadow:
                  "0 12px 28px -8px rgba(124, 58, 237, 0.7), 0 0 0 1px rgba(255,255,255,0.05)",
              }}
              aria-label="Add"
            >
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <TabButton
            label="Goals"
            icon={IconGoals}
            active={tab === "goals"}
            onClick={() => setTab("goals")}
          />
        </div>
      </nav>

      {fabOpen && (
        <div
          className="ios-sheet-backdrop fixed inset-0 z-40 flex items-end"
          onClick={() => setFabOpen(false)}
          style={{ background: "rgba(0, 0, 0, 0.6)" }}
        >
          <div
            className="ios-sheet w-full"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--ios-surface)",
              borderTopLeftRadius: "24px",
              borderTopRightRadius: "24px",
              padding: "12px 16px calc(env(safe-area-inset-bottom, 0) + 16px)",
              borderTop: "1px solid var(--ios-border)",
            }}
          >
            <div
              className="mx-auto mb-4 h-1 w-10 rounded-full"
              style={{ background: "var(--ios-border-strong)" }}
            />
            <SheetButton
              variant="primary"
              onClick={() => {
                setFabOpen(false);
                props.onAddTask();
              }}
              title="New task"
              subtitle="Title, theme, due date"
            />
            <SheetButton
              variant="secondary"
              onClick={() => {
                setFabOpen(false);
                props.onBrainDump();
              }}
              title="✨ Brain dump"
              subtitle="Paste a list — Claude infers everything"
            />
            <SheetButton
              variant="cancel"
              onClick={() => setFabOpen(false)}
              title="Cancel"
            />
          </div>
        </div>
      )}

      {completingTask && (
        <CompletionSheet
          task={completingTask}
          onClose={() => setCompletingId(null)}
          onResolve={(resolution, opts) => {
            props.onResolve(completingTask.id, resolution, opts);
            setCompletingId(null);
          }}
        />
      )}

      {hyperState === "countdown" && (
        <HyperCountdown
          onDone={() => setHyperState("open")}
          onCancel={() => setHyperState("closed")}
        />
      )}

      {hyperState === "open" && (
        <HyperFocus
          tasks={props.tasks}
          foundations={props.foundations}
          goals={props.goals}
          prefs={props.prefs}
          calendarConnected={props.calendarConnected}
          onComplete={props.onComplete}
          onToggleTask={props.onToggleTask}
          onDeferFoundation={props.onDeferFoundation}
          onIncrementCounter={props.onIncrementCounter}
          onSnooze={props.onSnooze}
          onUpdateTask={props.onUpdateTask}
          onRemoveTask={props.onRemoveTask}
          onSetScheduledFor={props.onSetScheduledFor}
          onUpdateEstimatedMinutes={props.onUpdateEstimatedMinutes}
          onMuteEvent={props.onMuteEvent}
          onClose={() => setHyperState("closed")}
        />
      )}

      <style>{`
        .ios-root {
          --ios-bg: #0B0E13;
          --ios-bg-elev: #0F1218;
          --ios-surface: #16181F;
          --ios-surface-elev: #1C1F27;
          --ios-text: #F5F5F7;
          --ios-text-secondary: #B0B6C2;
          --ios-text-muted: #8089A0;
          --ios-border: rgba(255, 255, 255, 0.06);
          --ios-border-strong: rgba(255, 255, 255, 0.14);
          --ios-accent: #A78BFA;
          --ios-accent-soft: rgba(167, 139, 250, 0.14);
          --ios-accent-grad-from: #7C3AED;
          --ios-accent-grad-to: #EC4899;
          --ios-success: #10B981;
          --ios-warning: #F59E0B;
          --ios-danger: #EF4444;
          background: var(--ios-bg);
          color: var(--ios-text);
        }
        .ios-fade-in { animation: iosFade 220ms cubic-bezier(0.32, 0.72, 0, 1); }
        .ios-sheet { animation: iosSheet 280ms cubic-bezier(0.32, 0.72, 0, 1); }
        .ios-sheet-backdrop { animation: iosBack 200ms cubic-bezier(0.32, 0.72, 0, 1); }
        .ios-fab { transition: transform 120ms cubic-bezier(0.32, 0.72, 0, 1); }
        .ios-fab:active { transform: scale(0.92); }
        .hyper-enter { animation: hyperEnter 320ms cubic-bezier(0.32, 0.72, 0, 1); }
        .hyper-launch {
          animation: hyperLaunchPulse 2.6s cubic-bezier(0.4, 0, 0.6, 1) infinite;
          transition: transform 120ms cubic-bezier(0.32, 0.72, 0, 1);
        }
        .hyper-launch:active { transform: scale(0.94); }
        .fine-tune { transition: color 100ms ease, transform 100ms ease; }
        .fine-tune:active { color: white !important; transform: scale(1.1); }
        .hyper-tick {
          animation: hyperTick 320ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes hyperLaunchPulse {
          0%, 100% {
            box-shadow:
              0 0 10px rgba(0, 200, 255, 0.35),
              inset 0 0 6px rgba(0, 200, 255, 0.10);
          }
          50% {
            box-shadow:
              0 0 18px rgba(0, 220, 255, 0.65),
              0 0 36px rgba(0, 140, 255, 0.30),
              inset 0 0 10px rgba(0, 220, 255, 0.20);
          }
        }
        @keyframes hyperTick {
          0% { opacity: 0; transform: scale(1.4); filter: blur(8px); }
          40% { opacity: 1; filter: blur(0); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes iosNowPulse {
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
          70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
        .now-pulse { animation: nowOpacity 1.8s ease-in-out infinite; }
        @keyframes centreDotPulse {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          50% { transform: translate(-50%, -50%) scale(1.35); opacity: 0.7; }
        }
        .card-live { animation: liveCardPulse 1.8s ease-in-out infinite; }
        .card-live-fixed { animation: liveFixedPulse 1.6s ease-in-out infinite; }
        @keyframes liveCardPulse {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.18) saturate(1.1); }
        }
        @keyframes liveFixedPulse {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.32) saturate(1.18); }
        }
        @keyframes nowOpacity {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
        .hyper-ribbon-pulse { animation: hyperRibbon 2.6s ease-in-out infinite; }
        @keyframes hyperRibbon {
          0%, 100% {
            text-shadow:
              0 0 14px rgba(0, 220, 255, 0.7),
              0 0 28px rgba(0, 140, 255, 0.35);
          }
          50% {
            text-shadow:
              0 0 22px rgba(0, 220, 255, 1),
              0 0 44px rgba(0, 140, 255, 0.6);
          }
        }
        @keyframes iosFade {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes iosSheet {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @keyframes iosBack {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes hyperEnter {
          from { opacity: 0; transform: scale(1.04); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

const TAB_TITLES: Record<Tab, string> = {
  focus: "Focus",
  goals: "Goals",
};
const TAB_SUBTITLES: Record<Tab, string> = {
  focus: "Today, distilled.",
  goals: "What it all ladders up to.",
};

const TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Now",
  2: "Soon",
  3: "Balance",
  4: "Later",
};
const TIER_COLORS: Record<1 | 2 | 3 | 4, string> = {
  1: "#EF4444",
  2: "#A78BFA",
  3: "#F59E0B",
  4: "#64748B",
};

// ─── FOCUS ───────────────────────────────────────────────────────────
function FocusTab(p: IosShellProps & { onAskComplete: (taskId: string) => void }) {
  // Shared "defer to tomorrow" helper — called from any list row in the
  // iOS app. Picks the right semantic:
  //   - Recurring task → snoozedUntil = end of today (tomorrow's instance
  //     surfaces naturally via recurrence).
  //   - One-off task   → MOVE scheduledFor (or dueDate) to tomorrow 9am
  //     and clear snoozedUntil. Same task forward, no duplicates.
  // Identical to HyperFocus.handleSnoozeTomorrow; lifted here for re-use.
  const deferTaskToTomorrow = (task: Task) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const isRecurring = task.recurrence && task.recurrence !== "none";
    if (isRecurring) {
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      p.onSnooze(task.id, endOfToday.toISOString());
      return;
    }
    const patch: Partial<Task> = { snoozedUntil: undefined };
    if (task.scheduledFor) patch.scheduledFor = tomorrow.toISOString();
    else if (task.dueDate) patch.dueDate = tomorrow.toISOString();
    else patch.scheduledFor = tomorrow.toISOString();
    p.onUpdateTask(task.id, patch);
  };

  // Stretch = "doable work" by kind (action / follow-up / errand / decision /
  // communication). Appointments and habits drop out — appointments are
  // already booked (showing up IS the work), habits live in Hyper Focus
  // basics. Goal-link is informative for sort order but NOT a filter; a
  // goal-less call to mum is still actionable, just less weighty.
  const stretch = useMemo(() => {
    const eight = prioritize(p.tasks, { prefs: p.prefs, limit: 8, goals: p.goals });
    const topIds = new Set(p.prioritized.map((pt) => pt.task.id));
    return eight
      .filter((s) => !topIds.has(s.task.id))
      .filter((s) => isActionable(s.task))
      .sort((a, b) => {
        // goal-aligned first within the stretch list
        const ga = (a.task.goalIds ?? []).length > 0 ? 0 : 1;
        const gb = (b.task.goalIds ?? []).length > 0 ? 0 : 1;
        return ga - gb;
      })
      .slice(0, 5);
  }, [p.tasks, p.prefs, p.goals, p.prioritized]);

  const goalById = useMemo(() => {
    const m = new Map<string, Goal>();
    for (const g of p.goals) m.set(g.id, g);
    return m;
  }, [p.goals]);

  const todayEvents = useTodayEvents(p.calendarConnected);

  return (
    <div className="space-y-5 pt-3">
      {p.calendarConnected && (
        <CalendarStrip events={todayEvents} />
      )}

      {p.prioritized.length === 0 ? (
        <Empty
          title="A clear plate"
          body="Nothing surfaced. Tap + to add a task or brain-dump a list."
        />
      ) : (
        <section>
          <SectionHeader title="Top three" />
          <div className="space-y-2">
            {p.prioritized.slice(0, 3).map((pt, idx) => (
              <CompactTopCard
                key={pt.task.id}
                rank={idx + 1}
                task={pt.task}
                tier={pt.tier}
                goal={pickGoal(pt.task, goalById)}
                onComplete={() => p.onAskComplete(pt.task.id)}
                onSchedule={() => p.onSchedule(pt.task.id)}
                onEdit={() => p.onEditTask(pt.task.id)}
              />
            ))}
          </div>
        </section>
      )}

      {stretch.length > 0 && (
        <section>
          <SectionHeader title="Stretch" />
          <div className="space-y-1.5">
            {stretch.map((s) => (
              <StretchRow
                key={s.task.id}
                task={s.task}
                tier={s.tier}
                goal={pickGoal(s.task, goalById)}
                onComplete={() => p.onAskComplete(s.task.id)}
                onEdit={() => p.onEditTask(s.task.id)}
                onDefer={() => deferTaskToTomorrow(s.task)}
              />
            ))}
          </div>
        </section>
      )}

      <QuickTray />
    </div>
  );
}

/**
 * Header trigger for Hyper Focus — text-led pill reading "HYPER" in
 * electric cyan, sat top-right next to the Desktop button. Wide letter-
 * spacing + soft pulse on the glow makes it feel like a system-mode toggle
 * rather than a content link. Tapping launches the countdown ritual which
 * brands the mode as HYPERFOCUS.
 */
function HyperLaunchButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Launch Hyperfocus"
      className="hyper-launch inline-flex h-8 items-center rounded-md px-3 text-[11px] font-black"
      style={{
        background:
          "linear-gradient(135deg, rgba(0, 229, 255, 0.16), rgba(0, 119, 255, 0.16))",
        color: "#7CFFFF",
        border: "1px solid rgba(0, 229, 255, 0.55)",
        letterSpacing: "0.18em",
        textShadow: "0 0 8px rgba(0, 229, 255, 0.55)",
      }}
    >
      HYPER
    </button>
  );
}

/**
 * Pre-Hyper-Focus ritual: a 5..0 countdown with a soft prompt to grab a
 * coffee. Slows the user down by ~6 seconds so they enter the day plan
 * intentionally, not by accident. Each digit cross-fades + scales via the
 * `key`-changes-on-each-tick trick.
 */
function HyperCountdown({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [n, setN] = useState(5);
  useEffect(() => {
    if (n < 0) {
      const t = setTimeout(onDone, 350);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setN((v) => v - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center px-6"
      style={{
        background:
          "radial-gradient(ellipse at center, #001932 0%, #0B0E13 80%)",
        paddingTop: "env(safe-area-inset-top, 0)",
      }}
    >
      <button
        type="button"
        onClick={onCancel}
        className="absolute right-5 top-5 rounded-md px-3 py-1.5 text-[12px] font-medium"
        style={{
          background: "rgba(255,255,255,0.08)",
          color: "var(--ios-text-secondary)",
        }}
      >
        Cancel
      </button>

      <div className="text-center">
        <div
          className="mb-4 text-[14px] font-black"
          style={{
            color: "#7CFFFF",
            letterSpacing: "0.32em",
            textShadow: "0 0 12px rgba(0, 220, 255, 0.6)",
          }}
        >
          HYPERFOCUS
        </div>
        <div
          key={n}
          className="hyper-tick"
          style={{
            fontSize: n >= 0 ? "220px" : "120px",
            fontWeight: 900,
            lineHeight: 1,
            color: "#7CFFFF",
            letterSpacing: "-0.04em",
            textShadow:
              "0 0 40px rgba(0, 220, 255, 0.85), 0 0 80px rgba(0, 140, 255, 0.55)",
          }}
        >
          {n > 0 ? n : "GO"}
        </div>
        <div
          className="mt-6 text-[18px] font-semibold"
          style={{ color: "#A8D5FF", letterSpacing: "-0.01em" }}
        >
          Engaging…
        </div>
        <div
          className="mt-1.5 text-[14px]"
          style={{ color: "var(--ios-text-secondary)" }}
        >
          Grab your coffee — get ready.
        </div>
        <div
          className="mt-5 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px]"
          style={{
            background: "rgba(255, 255, 255, 0.04)",
            color: "var(--ios-text-muted)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          🔇 swipe down → Focus / Do Not Disturb
        </div>
      </div>
    </div>
  );
}

// ─── CALENDAR STRIP ──────────────────────────────────────────────────
function CalendarStrip({ events }: { events: CalendarEvent[] }) {
  const upcoming = useMemo(() => {
    const now = Date.now();
    return events
      .filter((e) => {
        if (!e.start || e.allDay) return false;
        const end = e.end ? new Date(e.end).getTime() : new Date(e.start).getTime() + 60 * 60_000;
        return end > now;
      })
      .sort((a, b) => new Date(a.start!).getTime() - new Date(b.start!).getTime())
      .slice(0, 4);
  }, [events]);

  if (events.length === 0) return null;

  return (
    <section>
      <SectionHeader title={upcoming.length > 0 ? "Up next" : "Today"} />
      {upcoming.length === 0 ? (
        <p className="text-[13px]" style={{ color: "var(--ios-text-muted)" }}>
          Nothing left on the calendar today.
        </p>
      ) : (
        <div className="space-y-1.5">
          {upcoming.map((ev) => (
            <EventRow key={ev.id} event={ev} />
          ))}
        </div>
      )}
    </section>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const start = event.start ? new Date(event.start) : null;
  const end = event.end ? new Date(event.end) : null;
  const earlyMorning = start && start.getHours() < 9;
  const startingSoon = start && start.getTime() - Date.now() < 60 * 60_000 && start.getTime() > Date.now();
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl px-3 py-2.5"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <div
        className="flex w-12 flex-none flex-col items-center"
        style={{
          color: startingSoon
            ? "var(--ios-warning)"
            : earlyMorning
              ? "var(--ios-accent)"
              : "var(--ios-text)",
        }}
      >
        <span className="text-[14px] font-bold leading-none">
          {start ? fmtTime(start) : "—"}
        </span>
        {end && start && (
          <span className="mt-0.5 text-[10px]" style={{ color: "var(--ios-text-muted)" }}>
            {Math.round((end.getTime() - start.getTime()) / 60_000)}m
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[14px] font-semibold"
          style={{ color: "var(--ios-text)" }}
        >
          {event.summary || "(no title)"}
        </div>
        {(earlyMorning || startingSoon) && (
          <div className="mt-0.5 text-[11px]" style={{ color: startingSoon ? "var(--ios-warning)" : "var(--ios-accent)" }}>
            {startingSoon ? "Starts within an hour — prep now" : "Early morning — prep tonight"}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── COMPACT TOP CARD ────────────────────────────────────────────────
function CompactTopCard({
  rank,
  task,
  tier,
  goal,
  onComplete,
  onSchedule,
  onEdit,
}: {
  rank: number;
  task: Task;
  tier: 1 | 2 | 3 | 4;
  goal?: Goal;
  onComplete: () => void;
  onSchedule: () => void;
  onEdit: () => void;
}) {
  const tierColor = TIER_COLORS[tier];
  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <div
        className="absolute left-0 top-0 h-full w-1"
        style={{ background: tierColor }}
      />
      <div className="flex items-center gap-3 pl-4 pr-2 py-3">
        <button
          type="button"
          onClick={onComplete}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-white"
          style={{
            background: `linear-gradient(135deg, ${tierColor}, ${tierColor}cc)`,
          }}
          aria-label="Complete"
        >
          <span className="text-[11px] font-bold">{rank}</span>
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left"
        >
          <div
            className="truncate text-[16px] font-semibold leading-snug"
            style={{ color: "var(--ios-text)" }}
          >
            {task.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <Tag>{TIER_LABELS[tier]}</Tag>
            <KindTag task={task} />
            {task.theme && task.theme !== "personal" && (
              <Tag tone="muted">{task.theme}</Tag>
            )}
            {task.dueDate && (
              <Tag tone={isOverdue(task.dueDate) ? "danger" : "muted"}>
                {fmtDate(task.dueDate)}
              </Tag>
            )}
            {goal && <Tag tone="accent">{shortGoalLabel(goal)}</Tag>}
          </div>
        </button>
        <div className="flex flex-none items-center gap-1">
          <IconButton onClick={onSchedule} title="Schedule">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M3 10h18M8 3v4M16 3v4" />
            </svg>
          </IconButton>
          <IconButton onClick={onComplete} title="Complete" tone="success">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5L20 7" />
            </svg>
          </IconButton>
        </div>
      </div>
    </div>
  );
}

// ─── STRETCH ROW ─────────────────────────────────────────────────────
/**
 * StretchRow — same design language as HyperFocus lane cards. White glow on
 * pending, dims on done, square white-bordered tick box, down-arrow defer.
 * No more separate "Schedule" pill (low-impact for stretch items; the
 * Hyper day plan is where scheduling lives).
 */
function StretchRow({
  task,
  tier,
  goal,
  onComplete,
  onEdit,
  onDefer,
}: {
  task: Task;
  tier: 1 | 2 | 3 | 4;
  goal?: Goal;
  onComplete: () => void;
  onEdit: () => void;
  onDefer: () => void;
}) {
  const done = task.status === "completed";
  const accent = TIER_COLORS[tier];
  return (
    <div
      className="flex items-center gap-2 rounded-xl px-2.5 py-2 transition-shadow duration-200"
      style={{
        background: `linear-gradient(135deg, ${accent}14, ${accent}04), var(--ios-surface)`,
        border: `1px solid ${accent}30`,
        opacity: done ? 0.45 : 1,
        boxShadow: done ? "none" : "0 0 12px rgba(255, 255, 255, 0.14)",
      }}
    >
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <div
          className="truncate text-[14px] font-medium"
          style={{ color: "var(--ios-text)" }}
        >
          {task.title}
        </div>
        <div className="flex items-center gap-1 text-[11px]" style={{ color: "var(--ios-text-muted)" }}>
          <span>{kindGlyph(inferTaskKind(task))} {kindLabel(inferTaskKind(task))}</span>
          {task.theme && task.theme !== "personal" && (
            <>
              <span>·</span>
              <span>{task.theme}</span>
            </>
          )}
          {task.dueDate && (
            <>
              <span>·</span>
              <span style={{ color: isOverdue(task.dueDate) ? "var(--ios-danger)" : undefined }}>
                {fmtDate(task.dueDate)}
              </span>
            </>
          )}
          {goal && (
            <>
              <span>·</span>
              <span style={{ color: "var(--ios-accent)" }}>{shortGoalLabel(goal)}</span>
            </>
          )}
        </div>
      </button>
      <div className="flex flex-none items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDefer();
          }}
          className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[4px]"
          style={{
            background: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.18)",
            color: "var(--ios-text-secondary)",
          }}
          title="Defer to tomorrow"
          aria-label="Defer to tomorrow"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onComplete}
          className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[4px]"
          style={{
            background: done ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.04)",
            border: done
              ? "1px solid rgba(255, 255, 255, 0.95)"
              : "1px solid rgba(255, 255, 255, 0.55)",
            color: done ? "#0B0E13" : "var(--ios-text)",
            boxShadow: done
              ? "0 0 10px rgba(255, 255, 255, 0.45)"
              : "0 0 6px rgba(255, 255, 255, 0.32)",
          }}
          aria-label={done ? "Done — tap to undo" : "Tick off"}
        >
          {done && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5L20 7" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── QUICK TRAY ──────────────────────────────────────────────────────
const QUICK_ITEMS: { key: string; label: string; emoji: string }[] = [
  { key: "water", label: "Water", emoji: "💧" },
  { key: "coffee", label: "Coffee", emoji: "☕" },
  { key: "snack", label: "Snack", emoji: "🍎" },
  { key: "step", label: "Walk", emoji: "🚶" },
  { key: "med", label: "Med", emoji: "💊" },
];

function quickKey() {
  const d = new Date();
  return `focus3:quick:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readQuick(): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(quickKey());
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeQuick(state: Record<string, number>) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(quickKey(), JSON.stringify(state));
  } catch {
    // localStorage full — ignore.
  }
}

function QuickTray() {
  const [counts, setCounts] = useState<Record<string, number>>(() => readQuick());

  function bump(key: string) {
    setCounts((prev) => {
      const next = { ...prev, [key]: (prev[key] ?? 0) + 1 };
      writeQuick(next);
      return next;
    });
  }

  return (
    <section>
      <h3
        className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.16em]"
        style={{ color: "var(--ios-text-muted)" }}
      >
        Quick log
      </h3>
      <div className="flex w-full items-center justify-center gap-1">
        {QUICK_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => bump(item.key)}
            className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] font-medium"
            style={{
              background: "var(--ios-surface)",
              border: "1px solid var(--ios-border)",
              color: "var(--ios-text-secondary)",
            }}
          >
            <span className="text-[16px] leading-none">{item.emoji}</span>
            <span className="truncate">{item.label}</span>
            {(counts[item.key] ?? 0) > 0 && (
              <span
                className="rounded px-1 text-[9px] font-bold leading-none"
                style={{ background: "var(--ios-accent-soft)", color: "var(--ios-accent)" }}
              >
                {counts[item.key]}
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

// ─── GOALS TAB ───────────────────────────────────────────────────────
function GoalsTab(p: IosShellProps & { onAskComplete: (id: string) => void }) {
  // Same smart-defer helper as FocusTab. Recurring → snoozedUntil tonight;
  // one-off → move scheduledFor / dueDate to tomorrow 9am. Single source
  // of truth for "defer to tomorrow" behaviour across all iOS surfaces.
  const deferTaskToTomorrow = (taskId: string) => {
    const task = p.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const isRecurring = task.recurrence && task.recurrence !== "none";
    if (isRecurring) {
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      p.onSnooze(task.id, endOfToday.toISOString());
      return;
    }
    const patch: Partial<Task> = { snoozedUntil: undefined };
    if (task.scheduledFor) patch.scheduledFor = tomorrow.toISOString();
    else if (task.dueDate) patch.dueDate = tomorrow.toISOString();
    else patch.scheduledFor = tomorrow.toISOString();
    p.onUpdateTask(task.id, patch);
  };

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ignoredEvents = useMemo(
    () => new Set(p.prefs.ignoredEventIds ?? []),
    [p.prefs.ignoredEventIds],
  );

  const tasksByGoal = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const g of p.goals) m.set(g.id, []);
    const unlinked: Task[] = [];
    for (const t of p.tasks) {
      if (t.status === "completed") continue;
      if (t.calendarEventId && ignoredEvents.has(t.calendarEventId)) continue;
      if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) continue;
      const ids = t.goalIds ?? [];
      if (ids.length === 0) {
        unlinked.push(t);
        continue;
      }
      for (const gid of ids) {
        if (m.has(gid)) m.get(gid)!.push(t);
      }
    }
    for (const [, list] of m) {
      list.sort((a, b) => {
        const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        return da - db;
      });
    }
    unlinked.sort((a, b) => {
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return da - db;
    });
    return { byGoal: m, unlinked };
  }, [p.tasks, p.goals, ignoredEvents]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (p.goals.length === 0 && tasksByGoal.unlinked.length === 0) {
    return (
      <div className="pt-3">
        <Empty
          title="No goals yet"
          body="Open Desktop to set up goals — iOS reads from there. Once goals exist, every task can ladder up."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-3">
      {p.goals.map((g) => {
        const tasks = tasksByGoal.byGoal.get(g.id) ?? [];
        const open = expanded.has(g.id);
        const progress = p.goalProgress.get(g.id);
        return (
          <GoalCard
            key={g.id}
            goal={g}
            tasks={tasks}
            doneLast30={progress?.doneLast30 ?? 0}
            open={open}
            onToggle={() => toggle(g.id)}
            onCompleteTask={p.onAskComplete}
            onDeferTask={deferTaskToTomorrow}
            onEditTask={p.onEditTask}
          />
        );
      })}

      {tasksByGoal.unlinked.length > 0 && (
        <UnlinkedCard
          tasks={tasksByGoal.unlinked}
          open={expanded.has("__unlinked")}
          onToggle={() => toggle("__unlinked")}
          onCompleteTask={p.onAskComplete}
          onDeferTask={deferTaskToTomorrow}
          onEditTask={p.onEditTask}
        />
      )}
    </div>
  );
}

function GoalCard({
  goal,
  tasks,
  doneLast30,
  open,
  onToggle,
  onCompleteTask,
  onDeferTask,
  onEditTask,
}: {
  goal: Goal;
  tasks: Task[];
  doneLast30: number;
  open: boolean;
  onToggle: () => void;
  onCompleteTask: (id: string) => void;
  onDeferTask: (id: string) => void;
  onEditTask: (id: string) => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-2xl"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
      >
        <div
          className="flex h-10 w-10 flex-none items-center justify-center rounded-xl text-[16px]"
          style={{
            background: "var(--ios-accent-soft)",
            color: "var(--ios-accent)",
          }}
        >
          {goalEmoji(goal)}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[18px] font-bold leading-tight"
            style={{ color: "var(--ios-text)", letterSpacing: "-0.01em" }}
          >
            {goal.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: "var(--ios-text-secondary)" }}>
            <span>{tasks.length} open</span>
            {doneLast30 > 0 && (
              <>
                <span>·</span>
                <span style={{ color: "var(--ios-success)" }}>{doneLast30} done in 30d</span>
              </>
            )}
            {goal.horizon && (
              <>
                <span>·</span>
                <span>{goal.horizon}</span>
              </>
            )}
          </div>
        </div>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          style={{
            color: "var(--ios-text-muted)",
            transform: open ? "rotate(90deg)" : "rotate(0)",
            transition: "transform 180ms cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <div className="border-t px-3 pb-3 pt-2 space-y-1.5" style={{ borderColor: "var(--ios-border)" }}>
          {tasks.length === 0 ? (
            <p className="px-1 py-2 text-[12px] italic" style={{ color: "var(--ios-text-muted)" }}>
              Nothing open under this goal — well done.
            </p>
          ) : (
            tasks.map((t) => (
              <GoalTaskRow
                key={t.id}
                task={t}
                onComplete={() => onCompleteTask(t.id)}
                onEdit={() => onEditTask(t.id)}
                onDefer={() => onDeferTask(t.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function UnlinkedCard({
  tasks,
  open,
  onToggle,
  onCompleteTask,
  onDeferTask,
  onEditTask,
}: {
  tasks: Task[];
  open: boolean;
  onToggle: () => void;
  onCompleteTask: (id: string) => void;
  onDeferTask: (id: string) => void;
  onEditTask: (id: string) => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-2xl"
      style={{
        background: "rgba(245, 158, 11, 0.08)",
        border: "1px solid rgba(245, 158, 11, 0.24)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <div
          className="flex h-9 w-9 flex-none items-center justify-center rounded-xl text-[16px]"
          style={{ background: "rgba(245, 158, 11, 0.18)" }}
        >
          🌀
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[15px] font-bold"
            style={{ color: "var(--ios-warning)" }}
          >
            Not linked to a goal
          </div>
          <div className="text-[12px]" style={{ color: "var(--ios-text-secondary)" }}>
            {tasks.length} task{tasks.length === 1 ? "" : "s"} drifting — tap one to add a goal on Desktop
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: "var(--ios-warning)", transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 180ms" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <div className="border-t px-3 pb-3 pt-2 space-y-1.5" style={{ borderColor: "rgba(245, 158, 11, 0.24)" }}>
          {tasks.map((t) => (
            <GoalTaskRow
              key={t.id}
              task={t}
              onComplete={() => onCompleteTask(t.id)}
              onEdit={() => onEditTask(t.id)}
              onDefer={() => onDeferTask(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * GoalTaskRow — same design language as HyperFocus / StretchRow. Soft white
 * glow on pending; dim + filled tick on done. Down-arrow defer + square
 * tick box action cluster on the right. The Schedule pill is gone — Hyper
 * is where time-blocking happens.
 */
function GoalTaskRow({
  task,
  onComplete,
  onEdit,
  onDefer,
}: {
  task: Task;
  onComplete: () => void;
  onEdit: () => void;
  onDefer: () => void;
}) {
  const done = task.status === "completed";
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-shadow duration-200"
      style={{
        background: "var(--ios-surface-elev)",
        opacity: done ? 0.45 : 1,
        boxShadow: done ? "none" : "0 0 10px rgba(255, 255, 255, 0.10)",
      }}
    >
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[13px] font-medium" style={{ color: "var(--ios-text)" }}>
          {task.title}
        </div>
        {task.dueDate && (
          <div
            className="text-[10px]"
            style={{
              color: isOverdue(task.dueDate)
                ? "var(--ios-danger)"
                : "var(--ios-text-muted)",
            }}
          >
            {fmtDate(task.dueDate)}
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDefer();
        }}
        className="flex h-[16px] w-[16px] flex-none items-center justify-center rounded-[3px]"
        style={{
          background: "rgba(255, 255, 255, 0.04)",
          border: "1px solid rgba(255, 255, 255, 0.18)",
          color: "var(--ios-text-secondary)",
        }}
        title="Defer to tomorrow"
        aria-label="Defer to tomorrow"
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onComplete}
        className="flex h-[16px] w-[16px] flex-none items-center justify-center rounded-[3px]"
        style={{
          background: done ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.04)",
          border: done
            ? "1px solid rgba(255, 255, 255, 0.95)"
            : "1px solid rgba(255, 255, 255, 0.55)",
          color: done ? "#0B0E13" : "var(--ios-text)",
          boxShadow: done
            ? "0 0 8px rgba(255, 255, 255, 0.45)"
            : "0 0 4px rgba(255, 255, 255, 0.28)",
        }}
        aria-label={done ? "Done" : "Tick off"}
      >
        {done && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        )}
      </button>
    </div>
  );
}

// ─── HYPER FOCUS OVERLAY ─────────────────────────────────────────────
interface HyperFocusProps {
  tasks: Task[];
  foundations: Task[];
  goals: Goal[];
  prefs: UserPrefs;
  calendarConnected: boolean;
  onComplete: (id: string) => void;
  onToggleTask: (id: string) => void;
  onDeferFoundation: (id: string) => void;
  onIncrementCounter: (id: string, delta: number) => void;
  /** Snooze a task until iso. Used by the down-arrow defer on lane cards. */
  onSnooze: (id: string, untilIso: string) => void;
  /** Update arbitrary task fields. Used by smart-snooze to shift scheduledFor
   *  for one-off tasks (one event, no duplication). */
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
  /** Delete a task entirely. Used by the Remove action on the defer sheet. */
  onRemoveTask: (id: string) => void;
  /** Set the scheduledFor timestamp on a task. Used by ±15/±60 buttons and
   *  by auto-reschedule. The caller (App.tsx) routes this to updateTask. */
  onSetScheduledFor: (taskId: string, iso: string) => void;
  /** Update task duration (estimatedMinutes). Used by the ±5 chip. */
  onUpdateEstimatedMinutes: (taskId: string, minutes: number) => void;
  /** Mute a Google calendar event id (adds to prefs.ignoredEventIds). Mirrors
   *  what desktop's WeekSchedule context-menu does — single source of truth.
   *  Once muted on either surface, the event vanishes from both. */
  onMuteEvent: (eventId: string) => void;
  onClose: () => void;
}

function HyperFocus(p: HyperFocusProps) {
  const [dayOffset, setDayOffset] = useState(0); // 0 = today, -1 = yesterday, +1 = tomorrow
  // The item the user tapped the down-arrow on. Drives the DeferSheet —
  // active when non-null, dismissed by clearing.
  const [deferingItem, setDeferingItem] = useState<DayItem | null>(null);
  const targetDay = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);

  // Wake Lock — best we can do from a web app on iOS. We CAN'T trigger
  // DND / Focus mode programmatically (no API exposes that on Safari) so
  // the countdown nudge tells the user to swipe down themselves. Wake
  // Lock at least keeps the screen on while they're working through the
  // day plan. iOS Safari 16.4+ supports it; older versions silently fail.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    (async () => {
      try {
        const wl = (navigator as Navigator & {
          wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
        }).wakeLock;
        if (wl?.request) lock = await wl.request("screen");
      } catch {
        // No Wake Lock support, or denied — silent fail; not critical.
      }
    })();
    return () => {
      void lock?.release().catch(() => undefined);
    };
  }, []);

  const events = useDayEvents(p.calendarConnected, targetDay);
  // Collect EVERYTHING that should appear on the day plan — Google
  // appointments + Focus3 tasks (scheduledFor today, sessionTimes today) +
  // foundations with specificTime. Tasks with dueDate today but no slot go
  // into the "Needs a slot" bucket above the timeline.
  const { items, unscheduled } = useMemo(
    () =>
      collectDayItems({
        day: targetDay,
        tasks: p.tasks,
        foundations: p.foundations,
        events,
        prefs: p.prefs,
      }),
    [targetDay, p.tasks, p.foundations, events, p.prefs],
  );

  function handleAutoReschedule() {
    const now = new Date();
    const { updates } = autoReschedule({
      day: targetDay,
      from: now,
      prefs: p.prefs,
      items,
      unscheduled,
    });
    for (const u of updates) {
      p.onSetScheduledFor(u.taskId, u.newScheduledForIso);
    }
  }

  function handleAdjustTime(item: DayItem, deltaMin: number) {
    if (item.fixed || !item.task) return;
    // Cascade subsequent movable items if pushing this one later would
    // overlap them. Stops cold at fixed appointments. Pulling earlier
    // doesn't cascade — that would yank items the user hasn't asked to
    // move.
    const updates = cascadeShift({ items, targetItemId: item.id, deltaMin });
    for (const u of updates) {
      p.onSetScheduledFor(u.taskId, u.newScheduledForIso);
    }
  }

  /** Push an overdue item to the next 15-min boundary from now, cascading
   *  anything that would overlap. The user's "I missed this — do it now". */
  function handleReschedule(item: DayItem) {
    if (item.fixed || !item.task) return;
    const now = Date.now();
    const next = new Date(Math.ceil(now / (15 * 60_000)) * 15 * 60_000);
    const deltaMin = Math.round(
      (next.getTime() - item.start.getTime()) / 60_000,
    );
    const updates = cascadeShift({ items, targetItemId: item.id, deltaMin });
    for (const u of updates) {
      p.onSetScheduledFor(u.taskId, u.newScheduledForIso);
    }
  }

  /** Stretch / shrink the slot duration by deltaMin (typically ±5). Min 5,
   *  max 480 minutes. Doesn't move the start; just lengthens the slot. */
  function handleExtendDuration(item: DayItem, deltaMin: number) {
    if (!item.task) return;
    const current = item.task.estimatedMinutes ?? 30;
    const next = Math.max(5, Math.min(480, current + deltaMin));
    if (next === current) return;
    p.onUpdateEstimatedMinutes(item.task.id, next);
  }

  /**
   * Smart snooze. Two semantics depending on task shape, picked to keep
   * exactly ONE event on the calendar — never duplicates:
   *
   *   - Recurring task (daily/weekly/etc.): set snoozedUntil = end of today.
   *     The recurrence engine surfaces tomorrow's instance naturally; we
   *     just hide today's. No new event spawns.
   *
   *   - One-off task (no recurrence): MOVE scheduledFor (or dueDate) to
   *     tomorrow morning. The same task carries forward; no second instance
   *     gets created. snoozedUntil is cleared so the moved item shows up
   *     on tomorrow's day plan as expected.
   *
   *   - Calendar event: mute via prefs.ignoredEventIds (mirrors desktop).
   *     Single-occurrence muting on Google's side requires the per-instance
   *     API which we don't fetch yet; muting the whole event is the
   *     pragmatic fallback.
   */
  function handleSnoozeTomorrow(item: DayItem) {
    if (item.source === "calendar" && item.event) {
      p.onMuteEvent(item.event.id);
      return;
    }
    if (!item.task) return;
    const t = item.task;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const isRecurring = t.recurrence && t.recurrence !== "none";
    if (isRecurring) {
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      p.onSnooze(t.id, endOfToday.toISOString());
      return;
    }
    // One-off: move it forward; clear any old snooze so the moved
    // instance appears on tomorrow's plan, not hidden.
    const patch: Partial<Task> = { snoozedUntil: undefined };
    if (t.scheduledFor) {
      patch.scheduledFor = tomorrow.toISOString();
    } else if (t.dueDate) {
      patch.dueDate = tomorrow.toISOString();
    } else {
      patch.scheduledFor = tomorrow.toISOString();
    }
    p.onUpdateTask(t.id, patch);
  }

  /**
   * Remove the item from view permanently. For tasks: delete (the user
   * explicitly said this shouldn't be there). For Google events: mute
   * (we can't delete from the user's calendar without permission, but
   * we can hide it from Focus3).
   */
  function handleRemove(item: DayItem) {
    if (item.source === "calendar" && item.event) {
      p.onMuteEvent(item.event.id);
      return;
    }
    if (item.task) {
      p.onRemoveTask(item.task.id);
    }
  }

  const dayLabel = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000);
    if (diffDays === 0) return "Today";
    if (diffDays === -1) return "Yesterday";
    if (diffDays === 1) return "Tomorrow";
    return targetDay.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }, [targetDay]);

  return (
    <div
      className="hyper-enter fixed inset-0 z-50 flex flex-col"
      style={{
        background: "linear-gradient(180deg, #0B0E13 0%, #131520 100%)",
        paddingTop: "env(safe-area-inset-top, 0)",
        paddingBottom: "env(safe-area-inset-bottom, 0)",
      }}
    >
      {/* HYPERFOCUS top brand — bigger, presence-y, no oval container, the
          letter-spacing + glow does the work. */}
      <div
        className="flex items-center justify-center px-5 py-3"
        style={{
          background:
            "linear-gradient(90deg, rgba(0, 229, 255, 0.04), rgba(0, 119, 255, 0.10), rgba(0, 229, 255, 0.04))",
          borderBottom: "1px solid rgba(0, 229, 255, 0.18)",
        }}
      >
        <span
          className="hyper-ribbon-pulse text-[18px] font-black"
          style={{
            color: "#7CFFFF",
            letterSpacing: "0.36em",
          }}
        >
          HYPERFOCUS
        </span>
      </div>
      <header
        className="relative px-5 py-3"
        style={{ borderBottom: "1px solid var(--ios-border)" }}
      >
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setDayOffset((d) => d - 1)}
            className="flex h-8 w-8 items-center justify-center rounded-md"
            style={{ background: "var(--ios-surface)" }}
            aria-label="Previous day"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: "var(--ios-text-secondary)" }}>
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setDayOffset(0)}
            className="rounded-md px-3 py-1 text-[12px] font-semibold"
            style={{
              background: dayOffset === 0 ? "var(--ios-accent-soft)" : "var(--ios-surface)",
              color: dayOffset === 0 ? "var(--ios-accent)" : "var(--ios-text-secondary)",
            }}
          >
            {dayLabel}
          </button>
          <button
            type="button"
            onClick={() => setDayOffset((d) => d + 1)}
            className="flex h-8 w-8 items-center justify-center rounded-md"
            style={{ background: "var(--ios-surface)" }}
            aria-label="Next day"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: "var(--ios-text-secondary)" }}>
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
        <button
          type="button"
          onClick={p.onClose}
          className="absolute right-5 top-1/2 -translate-y-1/2 flex h-8 items-center rounded-md px-3 text-[12px] font-medium"
          style={{ background: "var(--ios-surface)", color: "var(--ios-text)" }}
        >
          Done
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {dayOffset === 0 && p.foundations.length > 0 && (
          <BasicsSection
            foundations={p.foundations}
            prefs={p.prefs}
            onComplete={p.onComplete}
            onDeferFoundation={p.onDeferFoundation}
            onIncrementCounter={p.onIncrementCounter}
          />
        )}

        <DayRiver
          items={items}
          unscheduled={unscheduled}
          isToday={dayOffset === 0}
          calendarConnected={p.calendarConnected}
          onAdjust={handleAdjustTime}
          onAutoReschedule={handleAutoReschedule}
          onComplete={(taskId) => p.onComplete(taskId)}
          onReschedule={handleReschedule}
          onExtendDuration={handleExtendDuration}
          onDefer={(item) => setDeferingItem(item)}
        />

        {dayOffset === 0 && (
          <TomorrowPreview
            tasks={p.tasks}
            foundations={p.foundations}
            prefs={p.prefs}
            calendarConnected={p.calendarConnected}
          />
        )}
      </div>

      <div
        className="border-t px-5 py-3"
        style={{
          borderColor: "var(--ios-border)",
          background: "rgba(15, 18, 24, 0.85)",
          backdropFilter: "saturate(180%) blur(18px)",
          WebkitBackdropFilter: "saturate(180%) blur(18px)",
        }}
      >
        <QuickTray />
      </div>

      {deferingItem && (
        <DeferSheet
          item={deferingItem}
          onClose={() => setDeferingItem(null)}
          onSnoozeTomorrow={() => {
            handleSnoozeTomorrow(deferingItem);
            setDeferingItem(null);
          }}
          onRemove={() => {
            handleRemove(deferingItem);
            setDeferingItem(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Action sheet that opens when the user taps the down-arrow on a lane card.
 * Two clear choices — snooze the item to tomorrow, or remove it. Smart
 * routing happens in the parent (recurring → snoozedUntil tonight; one-off
 * → scheduledFor moves; calendar event → mute via prefs).
 *
 * Cancel by tapping the backdrop or the explicit Cancel button.
 */
function DeferSheet({
  item,
  onClose,
  onSnoozeTomorrow,
  onRemove,
}: {
  item: DayItem;
  onClose: () => void;
  onSnoozeTomorrow: () => void;
  onRemove: () => void;
}) {
  const isCalendar = item.source === "calendar";
  const t = item.task;
  const isRecurring = !!(t?.recurrence && t.recurrence !== "none");
  return (
    <div
      className="ios-sheet-backdrop fixed inset-0 z-[55] flex items-end"
      onClick={onClose}
      style={{ background: "rgba(0, 0, 0, 0.6)" }}
    >
      <div
        className="ios-sheet w-full"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--ios-surface)",
          borderTopLeftRadius: "24px",
          borderTopRightRadius: "24px",
          padding: "12px 16px calc(env(safe-area-inset-bottom, 0) + 16px)",
          borderTop: "1px solid var(--ios-border)",
        }}
      >
        <div
          className="mx-auto mb-3 h-1 w-10 rounded-full"
          style={{ background: "var(--ios-border-strong)" }}
        />
        <div className="mb-3 px-1">
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: "var(--ios-text-secondary)" }}
          >
            What to do with this?
          </div>
          <div className="mt-0.5 text-[15px] font-bold leading-snug" style={{ color: "var(--ios-text)" }}>
            {item.title}
          </div>
        </div>
        <SheetButton
          variant="primary"
          onClick={onSnoozeTomorrow}
          title={
            isCalendar
              ? "Mute on calendar"
              : isRecurring
                ? "Defer today (back tomorrow)"
                : "Defer to tomorrow"
          }
          subtitle={
            isCalendar
              ? "Hides the event everywhere; un-mute on Desktop"
              : isRecurring
                ? "Daily / weekly pattern keeps going as normal"
                : "Moves the same task forward — no duplicates"
          }
        />
        <SheetButton
          variant="secondary"
          onClick={onRemove}
          title={isCalendar ? "Mute event" : "Remove task"}
          subtitle={
            isCalendar
              ? "Same as above — calendar events can't be deleted from here"
              : "Deletes the task entirely (not just today)"
          }
        />
        <SheetButton variant="cancel" onClick={onClose} title="Cancel" />
      </div>
    </div>
  );
}

function BasicsSection({
  foundations,
  prefs,
  onComplete,
  onDeferFoundation,
  onIncrementCounter,
}: {
  foundations: Task[];
  prefs: UserPrefs;
  onComplete: (id: string) => void;
  onDeferFoundation: (id: string) => void;
  onIncrementCounter: (id: string, delta: number) => void;
}) {
  // Foundations: keep ticked items visible too — completed ones drop their
  // glow, the box fills, but they stay on the grid so the user can see the
  // day's progress. If there are >4 we show only the first 4 by priority
  // (specificTime asc → theme weight) and a "+N more" label below.
  const allActive = useMemo(
    () =>
      foundations.filter((f) => {
        if (f.snoozedUntil && new Date(f.snoozedUntil).getTime() > Date.now()) return false;
        return true;
      }),
    [foundations],
  );
  const items = useMemo(() => {
    const themeWeight = (theme: string) => {
      const order = ["medication", "fitness", "diet", "household", "finance", "work", "school", "development", "projects", "personal"];
      const i = order.indexOf(theme);
      return i === -1 ? order.length : i;
    };
    const isFoundationDone = (f: Task) =>
      f.status === "completed" ||
      (f.counter ? f.counter.count >= f.counter.target : false);
    return [...allActive].sort((a, b) => {
      // Done items sink to the bottom
      const aDone = isFoundationDone(a) ? 1 : 0;
      const bDone = isFoundationDone(b) ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      // Then by specificTime asc (items with a time go first)
      if (a.specificTime && b.specificTime) return a.specificTime.localeCompare(b.specificTime);
      if (a.specificTime) return -1;
      if (b.specificTime) return 1;
      // Then by theme weight (medication > fitness > diet > ...)
      return themeWeight(a.theme) - themeWeight(b.theme);
    });
  }, [allActive]);
  const visibleItems = items.slice(0, 4);
  const overflowCount = Math.max(0, items.length - visibleItems.length);
  const dropoutCutoffHour = parseHourOf(prefs.workingHoursEnd ?? "22:00") - 1;
  const dropoutSoon = new Date().getHours() >= dropoutCutoffHour;

  if (items.length === 0) {
    return (
      <section className="text-center">
        <h2 className="text-[20px] font-bold tracking-tight" style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}>
          Foundation
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--ios-success)" }}>
          All ticked. Quiet day on the foundations front.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2
        className="text-center text-[22px] font-bold tracking-tight"
        style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}
      >
        Foundation
      </h2>
      <p
        className="mt-0.5 text-center text-[12px]"
        style={{ color: dropoutSoon ? "var(--ios-warning)" : "var(--ios-text-secondary)" }}
      >
        {dropoutSoon ? "Late in the day — incomplete foundations will drop out tonight" : "Quick wins. Tap a tile, deeper outcomes happen on the timeline below."}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {visibleItems.map((f) => (
          <BasicTile
            key={f.id}
            foundation={f}
            onComplete={() => {
              if (f.counter) {
                onIncrementCounter(f.id, 1);
              } else {
                onComplete(f.id);
              }
            }}
            onDefer={() => onDeferFoundation(f.id)}
          />
        ))}
      </div>
      {overflowCount > 0 && (
        <p className="mt-2 text-center text-[11px]" style={{ color: "var(--ios-text-muted)" }}>
          +{overflowCount} more · Focus is managing the order
        </p>
      )}
    </section>
  );
}

/** Glyph picked for the foundation's theme — used as the tile's headline
 *  visual. Falls back to ✓ for the "personal" / unthemed case. */
function basicTileGlyph(t: Task): string {
  switch (t.theme) {
    case "medication":
      return "💊";
    case "fitness":
      return "💪";
    case "diet":
      return "🥗";
    case "household":
      return "🏠";
    case "finance":
      return "💰";
    case "work":
      return "💼";
    case "school":
      return "📚";
    case "development":
      return "🚀";
    case "projects":
      return "🎯";
    default:
      return "✓";
  }
}

/** Theme-tinted accent — sets the tile gradient + ring colour. Picked to
 *  feel "trendy" without being loud; muted on dark, with a single coloured
 *  edge. */
function basicTileAccent(t: Task): string {
  switch (t.theme) {
    case "medication":
      return "#EC4899";
    case "fitness":
      return "#10B981";
    case "diet":
      return "#34D399";
    case "household":
      return "#F59E0B";
    case "finance":
      return "#FACC15";
    case "work":
      return "#A78BFA";
    case "school":
      return "#60A5FA";
    case "development":
      return "#F472B6";
    case "projects":
      return "#818CF8";
    default:
      return "#A78BFA";
  }
}

/**
 * Compact foundation tile. Glyph + title + meta in a single row, with a
 * tick box on the right and a tiny "Later" defer in the corner.
 *
 * Pending = soft white glow (tile says "this still wants doing").
 * Done    = glow drops, tile dims to ~50%, tick box fills white. The
 *           item stays on the grid so the user sees today's progress
 *           rather than the slot vanishing on tap.
 */
function BasicTile({
  foundation,
  onComplete,
  onDefer,
}: {
  foundation: Task;
  onComplete: () => void;
  onDefer: () => void;
}) {
  const isCounter = !!foundation.counter;
  const target = foundation.counter?.target ?? 0;
  const count = foundation.counter?.count ?? 0;
  const pct = isCounter && target > 0 ? Math.min(100, Math.round((count / target) * 100)) : 0;
  const accent = basicTileAccent(foundation);
  const glyph = basicTileGlyph(foundation);
  const done = isCounter ? count >= target : foundation.status === "completed";

  return (
    <div
      className="relative overflow-hidden rounded-xl transition-shadow duration-200"
      style={{
        background: done
          ? `linear-gradient(135deg, ${accent}10 0%, ${accent}04 100%)`
          : `linear-gradient(135deg, ${accent}1F 0%, ${accent}08 100%)`,
        border: `1px solid ${accent}${done ? "20" : "40"}`,
        opacity: done ? 0.5 : 1,
        boxShadow: done ? "none" : "0 0 14px rgba(255, 255, 255, 0.16)",
      }}
    >
      {/* Counter progress fill — climbs from the bottom as count rises. */}
      {isCounter && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{
            height: `${pct}%`,
            background: `linear-gradient(180deg, ${accent}10 0%, ${accent}30 100%)`,
            transition: "height 280ms cubic-bezier(0.32,0.72,0,1)",
          }}
        />
      )}

      {/* Whole tile is the tap target — completes the foundation or +1's
          the counter. No separate tick box: the visual feedback is the
          tile dimming and the counter fill rising. The user said they'll
          tick foundations themselves through interaction; cleaner without
          the explicit checkbox affordance. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onComplete();
        }}
        className="relative z-0 flex w-full items-center gap-2 px-2.5 py-2 pr-9 text-left"
        aria-label={done ? "Done" : isCounter ? "Add one" : "Mark done"}
      >
        <span className="flex-none text-[20px] leading-none">{glyph}</span>
        <div className="min-w-0 flex-1">
          <div
            className="line-clamp-2 text-[12px] font-bold leading-tight"
            style={{ color: "var(--ios-text)" }}
          >
            {foundation.title}
          </div>
          <div
            className="mt-0.5 flex items-center gap-1 text-[9px] leading-tight"
            style={{ color: "var(--ios-text-muted)" }}
          >
            {isCounter ? (
              <span>{count}/{target}</span>
            ) : (
              <span>{foundation.theme && foundation.theme !== "personal" ? foundation.theme : "foundation"}</span>
            )}
            {foundation.recurrence && foundation.recurrence !== "none" && (
              <>
                <span>·</span>
                <span>{foundation.recurrence}</span>
              </>
            )}
          </div>
        </div>
      </button>

      {/* Defer — tiny corner chip. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDefer();
        }}
        className="absolute bottom-1.5 right-2 z-10 text-[9px] font-medium"
        style={{ color: "var(--ios-text-muted)" }}
      >
        later →
      </button>
    </div>
  );
}

// ─── DAY RIVER (the day plan) ────────────────────────────────────────
/**
 * The day plan as a chronological river of cards — NOT an hour grid.
 * Drops the calendar-grid metaphor entirely: items stack one after the
 * other in time order, sized by content not by their duration in pixels.
 * Gaps become small connectors with optional "2h gap" labels rather than
 * vast empty space. Concurrent items group together visually so a busy
 * collision reads as "two things at once" not "two separate hours".
 *
 * NOW is a glowing red beam inserted at its proper chronological position
 * — between the last past item and the first future item — and auto-
 * scrolls into view. Past items dim. Fixed (Google) items lock with a
 * padlock; movable items get the ±15/±60 + complete cluster.
 *
 * Pure presentation — all data prep happens in lib/dayPlan.ts.
 */

interface DayItemGroup {
  /** Items overlapping in time. Sorted by start within the group. */
  items: DayItem[];
  /** Earliest start across the group. */
  start: Date;
  /** Latest end across the group. */
  end: Date;
}

/** Walk sorted items and bundle anything that overlaps in time. Two items
 *  with start/end ranges that touch but don't intersect are still distinct
 *  groups (back-to-back, not concurrent). */
function groupConcurrent(items: DayItem[]): DayItemGroup[] {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime());
  const groups: DayItemGroup[] = [];
  let cur: DayItemGroup | null = null;
  for (const item of sorted) {
    if (!cur || item.start.getTime() >= cur.end.getTime()) {
      if (cur) groups.push(cur);
      cur = { items: [item], start: item.start, end: item.end };
    } else {
      cur.items.push(item);
      if (item.end.getTime() > cur.end.getTime()) cur.end = item.end;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

function DayRiver({
  items,
  unscheduled,
  isToday,
  calendarConnected,
  onAdjust,
  onAutoReschedule,
  onComplete,
  onReschedule,
  onExtendDuration,
  onDefer,
}: {
  items: DayItem[];
  unscheduled: UnscheduledItem[];
  isToday: boolean;
  calendarConnected: boolean;
  onAdjust: (item: DayItem, deltaMin: number) => void;
  onAutoReschedule: () => void;
  onComplete: (taskId: string) => void;
  onReschedule: (item: DayItem) => void;
  onExtendDuration: (item: DayItem, deltaMin: number) => void;
  onDefer: (item: DayItem) => void;
}) {
  const groups = useMemo(() => groupConcurrent(items), [items]);

  // Live ticker — re-evaluates "now" every minute so the NOW beam and
  // current-group highlights update without a refresh. Cheap (one render
  // per minute), worth the always-fresh feel.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Find where to slot the NOW beam in the chronological river:
  //   - Index of the first group whose start is in the future
  //   - If a current group brackets NOW, the beam renders inside that group
  //   - If everything is in the past, beam goes at the end
  const nowDate = isToday ? new Date(nowTick) : null;
  const nowMs = nowDate?.getTime() ?? null;
  const nowSlot = useMemo(() => {
    if (nowMs == null) return { kind: "none" as const };
    const insideIdx = groups.findIndex(
      (g) => g.start.getTime() <= nowMs && g.end.getTime() > nowMs,
    );
    if (insideIdx !== -1) return { kind: "inside" as const, index: insideIdx };
    const futureIdx = groups.findIndex((g) => g.start.getTime() > nowMs);
    if (futureIdx !== -1) return { kind: "before" as const, index: futureIdx };
    return { kind: "after" as const };
  }, [groups, nowMs]);

  // Auto-scroll the NOW beam into view on FIRST mount only. Once the user
  // is interacting (ticking, ±15/±60), every state update would otherwise
  // re-scroll and yank focus away from the cell they just touched. So we
  // latch on a ref after the first successful scroll and never run again.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nowRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToNowRef = useRef(false);
  useEffect(() => {
    if (hasScrolledToNowRef.current) return;
    const c = containerRef.current;
    const n = nowRef.current;
    if (!c || !n) return;
    const cRect = c.getBoundingClientRect();
    const nRect = n.getBoundingClientRect();
    c.scrollTop += nRect.top - cRect.top - 80;
    hasScrolledToNowRef.current = true;
  }, [groups, nowSlot]);

  const fixedCount = items.filter((i) => i.fixed).length;
  const movableCount = items.length - fixedCount;
  const overdue = useMemo(() => {
    if (!isToday || nowMs == null) return 0;
    return items.filter(
      (i) => !i.fixed && i.task && i.end.getTime() < nowMs && i.task.status !== "completed",
    ).length;
  }, [items, isToday, nowMs]);

  return (
    <section>
      <div className="relative">
        <div className="text-center">
          <h2
            className="text-[22px] font-bold tracking-tight"
            style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}
          >
            Focus
          </h2>
          <p
            className="mt-0.5 text-[12px]"
            style={{ color: "var(--ios-text-secondary)" }}
          >
            {items.length === 0 && unscheduled.length === 0
              ? calendarConnected
                ? "Nothing on the day yet."
                : "Schedule something on Desktop, or connect Calendar for appointments."
              : `${fixedCount} fixed · ${movableCount} movable${unscheduled.length ? ` · ${unscheduled.length} need a slot` : ""}${overdue ? ` · ${overdue} overdue` : ""}`}
          </p>
        </div>
        {(unscheduled.length > 0 || overdue > 0) && isToday && (
          <button
            type="button"
            onClick={onAutoReschedule}
            className="absolute right-0 top-0 rounded-md px-3 py-1.5 text-[11px] font-bold"
            style={{
              background:
                "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
              color: "white",
            }}
          >
            Auto-reschedule
          </button>
        )}
      </div>

      {unscheduled.length > 0 && (
        <div
          className="mt-3 rounded-xl p-2.5"
          style={{
            background: "rgba(245, 158, 11, 0.08)",
            border: "1px solid rgba(245, 158, 11, 0.24)",
          }}
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: "var(--ios-warning)" }}>
            Needs a slot · {unscheduled.length}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {unscheduled.map((u) => (
              <span
                key={u.id}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]"
                style={{
                  background: "var(--ios-surface)",
                  color: "var(--ios-text)",
                  border: "1px solid var(--ios-border)",
                }}
              >
                {u.title}
                <span style={{ color: "var(--ios-text-muted)" }}>· {u.estimatedMinutes}m</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* The river itself — a vertical stream of cards with a soft gradient
          spine on the left. No hour grid, no fixed pixel-per-minute mapping;
          the cards take their natural height and connectors carry the
          chronological signal. */}
      <div
        ref={containerRef}
        className="mt-3 overflow-y-auto rounded-2xl"
        style={{
          background: "var(--ios-surface)",
          border: "1px solid var(--ios-border)",
          maxHeight: "60vh",
        }}
      >
        <div className="relative px-4 py-4">
          <RiverSpine />
          {groups.length === 0 ? (
            <div className="py-10 text-center text-[13px]" style={{ color: "var(--ios-text-muted)" }}>
              {calendarConnected ? "Nothing on the day yet." : "Connect Calendar or schedule something on Desktop."}
            </div>
          ) : (
            <>
              {nowSlot.kind === "before" && nowSlot.index === 0 && nowDate && (
                <NowBeam now={nowDate} ref={nowRef} />
              )}
              {groups.map((group, idx) => {
                const isCurrentGroup =
                  nowSlot.kind === "inside" && nowSlot.index === idx;
                const showNowBefore =
                  nowSlot.kind === "before" && nowSlot.index === idx && idx !== 0;
                const showNowAfter =
                  nowSlot.kind === "after" && idx === groups.length - 1;
                return (
                  <Fragment key={group.items[0].id}>
                    {showNowBefore && nowDate && <NowBeam now={nowDate} ref={nowRef} />}
                    {isCurrentGroup && nowDate && (
                      <NowBeam now={nowDate} ref={nowRef} variant="inside" />
                    )}
                    <RiverGroup
                      group={group}
                      index={idx}
                      onAdjust={onAdjust}
                      onComplete={onComplete}
                      onReschedule={onReschedule}
                      onExtendDuration={onExtendDuration}
                      onDefer={onDefer}
                      isCurrent={isCurrentGroup}
                    />
                    {idx < groups.length - 1 && (
                      <RiverConnector
                        from={group.end}
                        to={groups[idx + 1].start}
                      />
                    )}
                    {showNowAfter && nowDate && idx === groups.length - 1 && (
                      <NowBeam now={nowDate} ref={nowRef} />
                    )}
                  </Fragment>
                );
              })}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * "Tomorrow morning" preview. Sits below today's day plan so the user can
 * see what's coming first thing tomorrow — useful at end of day when
 * planning is mostly closing out, not starting things. Shows the first
 * 3 items of tomorrow by start time. Read-only: no controls, just the
 * heads-up.
 *
 * Conditional render: only shows after 16:00 local time (when "end of
 * day" starts to feel meaningful), and only if tomorrow has any items.
 */
function TomorrowPreview({
  tasks,
  foundations,
  prefs,
  calendarConnected,
}: {
  tasks: Task[];
  foundations: Task[];
  prefs: UserPrefs;
  calendarConnected: boolean;
}) {
  const tomorrow = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() + 1);
    return t;
  }, []);
  const events = useDayEvents(calendarConnected, tomorrow);
  const { items } = useMemo(
    () =>
      collectDayItems({
        day: tomorrow,
        tasks,
        foundations,
        events,
        prefs,
      }),
    [tomorrow, tasks, foundations, events, prefs],
  );
  const previewItems = useMemo(
    () => [...items].sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, 3),
    [items],
  );

  // Always show when there's something to glimpse — sits at the bottom
  // of today so the user can prep mentally before tomorrow lands.
  if (previewItems.length === 0) return null;

  return (
    <section className="mt-5">
      <h3
        className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.16em]"
        style={{ color: "var(--ios-text-muted)" }}
      >
        Head Start
      </h3>
      <div
        className="rounded-xl px-3 py-2.5"
        style={{
          background: "rgba(255, 255, 255, 0.02)",
          border: "1px solid rgba(255, 255, 255, 0.06)",
        }}
      >
        {previewItems.map((item, i) => (
          <div
            key={item.id}
            className="flex items-center justify-center gap-2 py-1"
            style={{
              borderTop: i === 0 ? undefined : "1px solid var(--ios-border)",
            }}
          >
            <span
              className="text-[11px] font-bold tabular-nums"
              style={{ color: "var(--ios-text-secondary)" }}
            >
              {fmtTime(item.start)}
            </span>
            <span
              className="text-[12px]"
              style={{ color: "var(--ios-text)" }}
            >
              {item.title}
            </span>
            {item.fixed && (
              <span
                className="text-[9px]"
                style={{ color: "var(--ios-text-muted)" }}
              >
                fixed
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Decorative gradient spine running down the river's left edge. Pure
 *  visual — adds the "flowing path" feel without carrying data. */
/** Vertical spine running down the centre of the river. Single items
 *  hang off it left/right alternating; concurrent groups split into
 *  parallel lanes either side. */
function RiverSpine() {
  return (
    <div
      className="pointer-events-none absolute bottom-4 top-4 w-[2px] rounded-full"
      style={{
        left: "calc(50% - 1px)",
        background:
          "linear-gradient(180deg, rgba(167,139,250,0.0) 0%, rgba(167,139,250,0.28) 12%, rgba(124,58,237,0.32) 50%, rgba(0,200,255,0.16) 100%)",
      }}
    />
  );
}

/** Connector between two groups — sits over the centre spine. Shows a
 *  "Nh gap" pill if the spread is meaningful (>30 min). */
function RiverConnector({ from, to }: { from: Date; to: Date }) {
  const gapMin = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  const tight = gapMin < 30;
  const big = gapMin >= 120;
  const label =
    gapMin >= 60
      ? `${Math.round(gapMin / 60)}h gap`
      : gapMin >= 30
        ? `${gapMin}m gap`
        : null;
  return (
    <div className="relative flex items-center justify-center" style={{ height: tight ? 12 : big ? 28 : 20 }}>
      {label && (
        <span
          className="relative z-10 rounded-md px-2 py-0.5 text-[10px] font-medium"
          style={{
            background: "var(--ios-surface-elev)",
            color: "var(--ios-text-muted)",
            border: "1px solid var(--ios-border)",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

/** NOW marker — pure glow, no pill / no border. The time itself reads as
 *  the headline; "NOW" sits underneath as a wide-spaced caption. Centred
 *  horizontally; pulses red so a glance in the user's peripheral vision
 *  catches it. The radial halo behind the type does the visual heavy
 *  lifting — text-shadow + background blur, no contained box. */
const NowBeam = forwardRef<HTMLDivElement, { now: Date; variant?: "between" | "inside" }>(
  function NowBeam({ now, variant = "between" }, ref) {
    const inside = variant === "inside";
    return (
      <div ref={ref} className="relative my-3 flex justify-center">
        <div
          className="pointer-events-none absolute"
          style={{
            top: "-12px",
            bottom: "-12px",
            left: "10%",
            right: "10%",
            background:
              "radial-gradient(ellipse at center, rgba(239, 68, 68, 0.32) 0%, transparent 70%)",
          }}
        />
        <div className="now-pulse relative flex flex-col items-center px-4">
          <span
            className="text-[20px] font-black tabular-nums leading-none"
            style={{
              color: "#FCA5A5",
              letterSpacing: "-0.02em",
              textShadow:
                "0 0 14px rgba(239, 68, 68, 0.95), 0 0 28px rgba(239, 68, 68, 0.55)",
            }}
          >
            {fmtTime(now)}
          </span>
          <span
            className="mt-0.5 text-[8px] font-black"
            style={{
              color: "#FCA5A5",
              letterSpacing: "0.32em",
              textShadow: "0 0 10px rgba(239, 68, 68, 0.6)",
            }}
          >
            {inside ? "NOW · IN PROGRESS" : "NOW"}
          </span>
        </div>
      </div>
    );
  },
);

/** A group of items at one chronological "moment". Single-item groups
 *  alternate left/right of the centre spine for visual rhythm; multi-
 *  item groups (concurrent) render as parallel lanes side-by-side so
 *  the overlap reads at a glance. */
function RiverGroup({
  group,
  index,
  onAdjust,
  onComplete,
  onReschedule,
  onExtendDuration,
  onDefer,
  isCurrent,
}: {
  group: DayItemGroup;
  /** Index in the river — drives left/right alternation for singles. */
  index: number;
  onAdjust: (item: DayItem, deltaMin: number) => void;
  onComplete: (taskId: string) => void;
  onReschedule: (item: DayItem) => void;
  onExtendDuration: (item: DayItem, deltaMin: number) => void;
  onDefer: (item: DayItem) => void;
  isCurrent: boolean;
}) {
  // Concurrent — render as flush side-by-side lanes. Cards touch each
  // other so the row reads as one coordinated trio (instead of three
  // disconnected items with the spine showing through gaps). Stagger
  // is dialled down: items still drop slightly below their earlier
  // siblings to convey time-offset, but a 60-min stagger only descends
  // ~24px so the row stays compact and the heights remain comparable.
  // The stretch align makes all cards in the row the same height as
  // the tallest, which kills the "uneven top-edges" look that read
  // as "left-clustered with gaps".
  if (group.items.length > 1) {
    const STAGGER_PX_PER_MIN = 0.6;
    const groupStartMs = group.start.getTime();
    const total = group.items.length;
    // Lane → align mapping: leftmost lanes lean RIGHT (toward centre
    // spine), rightmost lanes lean LEFT, middle lanes centre. So the
    // time labels gravitate toward the timeline running down the
    // middle of the river.
    const alignFor = (i: number): "right" | "centre" | "left" => {
      if (total === 1) return "centre";
      if (i === 0) return "right";
      if (i === total - 1) return "left";
      return "centre";
    };
    return (
      <div className="relative my-1.5 flex items-stretch px-1">
        {group.items.map((item, i) => {
          const offsetMin = Math.max(
            0,
            (item.start.getTime() - groupStartMs) / 60_000,
          );
          const offsetPx = offsetMin * STAGGER_PX_PER_MIN;
          return (
            <div
              key={item.id}
              className="flex-1 min-w-0"
              style={{
                marginTop: `${offsetPx}px`,
                marginLeft: i === 0 ? 0 : "1px",
              }}
            >
              <LaneCard
                item={item}
                isCurrent={isCurrent}
                onAdjust={(delta) => onAdjust(item, delta)}
                onComplete={() => item.task && onComplete(item.task.id)}
                onReschedule={() => onReschedule(item)}
                onExtendDuration={(delta) => onExtendDuration(item, delta)}
                onDefer={() => onDefer(item)}
                align={alignFor(i)}
              />
            </div>
          );
        })}
      </div>
    );
  }

  // Single item. Two layouts:
  //   - Fixed (3rd-party appointment) → centred full-width, anchored on
  //     the spine so it visually "anchors" the day. The user can't move
  //     it, so it acts as a structural beam everything else flows around.
  //   - Movable → alternate left/right of the spine for visual rhythm.
  //     Left-side cards lean their content RIGHT (toward spine);
  //     right-side cards lean their content LEFT (toward spine).
  const item = group.items[0];
  if (item.fixed) {
    return (
      <div className="relative my-1.5 px-1">
        <LaneCard
          item={item}
          isCurrent={isCurrent}
          onAdjust={(delta) => onAdjust(item, delta)}
          onComplete={() => item.task && onComplete(item.task.id)}
          onReschedule={() => onReschedule(item)}
          onExtendDuration={(delta) => onExtendDuration(item, delta)}
          onDefer={() => onDefer(item)}
          align="centre"
        />
      </div>
    );
  }
  const right = index % 2 === 1;
  return (
    <div className="relative my-1.5 flex items-stretch px-1">
      {right && <div className="flex-1" aria-hidden />}
      <div className="flex-1 min-w-0">
        <LaneCard
          item={item}
          isCurrent={isCurrent}
          onAdjust={(delta) => onAdjust(item, delta)}
          onComplete={() => item.task && onComplete(item.task.id)}
          onReschedule={() => onReschedule(item)}
          onExtendDuration={(delta) => onExtendDuration(item, delta)}
          onDefer={() => onDefer(item)}
          align={right ? "left" : "right"}
        />
      </div>
      {!right && <div className="flex-1" aria-hidden />}
    </div>
  );
}

/** A card sat in its lane (left, right, or one of N concurrents). Lean,
 *  half-width-ish since we run two columns. The complete tick is the
 *  loudest control — ticking off is the primary action. ±15/±60 do the
 *  shifting (with cascade); fixed items show a padlock and no controls. */
function LaneCard({
  item,
  onAdjust,
  onComplete,
  onReschedule,
  onExtendDuration,
  onDefer,
  isCurrent,
  align = "centre",
}: {
  item: DayItem;
  onAdjust: (deltaMin: number) => void;
  onComplete: () => void;
  /** Push this item to NOW (snapped to next 15-min). Cascade pushes
   *  anything in the way. Visible only on past-not-done movables. */
  onReschedule: () => void;
  /** Adjust the slot's duration in minutes (±5). Min 5, max 480. */
  onExtendDuration: (deltaMin: number) => void;
  /** Hide / defer this item. Calendar events get muted via prefs (mirrors
   *  desktop). Tasks get snoozed until tomorrow morning. */
  onDefer: () => void;
  isCurrent: boolean;
  /** Where the card sits relative to the centre spine. Drives the
   *  internal layout so the TIME label always lives close to the spine:
   *    - "right" → card on the LEFT of spine, content right-aligned
   *    - "left"  → card on the RIGHT of spine, content left-aligned
   *    - "centre"→ centred / fixed full-width / single concurrent
   */
  align?: "right" | "centre" | "left";
}) {
  const accent = item.accent || (item.fixed ? "#94A3B8" : "#A78BFA");
  const past = item.end.getTime() < Date.now();
  const done = item.done === true;
  const durationMin = Math.max(
    1,
    Math.round((item.end.getTime() - item.start.getTime()) / 60_000),
  );

  // Pending cards carry a soft white glow — "this still wants doing".
  // Once ticked the glow drops, the card dims, and the box fills.
  //
  // Live cards (now happening) get a pulsing accent glow on the border
  // — extra strong for fixed-live (a meeting in progress is the
  // loudest signal of all). The pulse animation is driven by the
  // `card-live` / `card-live-fixed` classes; the static box-shadow is
  // the resting glow.
  const cardOpacity = done ? 0.45 : past ? 0.7 : 1;
  const liveClass = isCurrent
    ? item.fixed
      ? "card-live-fixed"
      : "card-live"
    : "";
  const cardGlow = done
    ? "none"
    : isCurrent
      ? item.fixed
        ? `0 0 22px ${accent}cc, 0 0 44px ${accent}55, inset 0 0 12px ${accent}40`
        : `0 0 18px ${accent}80, 0 4px 22px ${accent}40, inset 0 0 8px ${accent}25`
      : "0 0 14px rgba(255, 255, 255, 0.16)";

  // Fixed (meeting / appointment) cards get a clearly solid white-ish
  // border — signals "you can't shuffle this". Live fixed items dial
  // it up: a thicker, accent-coloured border so the user can see at a
  // glance "this is happening right now".
  const cardBorder = item.fixed
    ? isCurrent
      ? `2px solid ${accent}`
      : "1.5px solid rgba(255, 255, 255, 0.55)"
    : isCurrent
      ? `1.5px solid ${accent}`
      : `1px solid ${accent}30`;

  // Where the time/title content sits horizontally inside the card —
  // pulls toward the centre spine so the "now line" reads cleanly.
  const justify =
    align === "right"
      ? "flex-end"
      : align === "left"
        ? "flex-start"
        : "center";
  const textAlign =
    align === "right" ? "right" : align === "left" ? "left" : "center";
  const showShiftControls = !item.fixed && item.task && !(past && !done);

  return (
    <div
      className={`relative rounded-xl transition-shadow duration-200 ${liveClass}`}
      style={{
        background: item.fixed
          ? `linear-gradient(135deg, ${accent}10, ${accent}04), var(--ios-surface)`
          : `linear-gradient(135deg, ${accent}22, ${accent}0A), var(--ios-surface)`,
        border: cardBorder,
        opacity: cardOpacity,
        // Bottom padding leaves room for the protruding ±5 duration chip.
        paddingBottom: !item.fixed && item.task && item.source !== "foundation" ? 14 : 0,
        boxShadow: cardGlow,
      }}
    >
      <div className="px-2.5 pb-2 pt-1.5">
        {/* TIME row — time, kind glyph, action cluster (defer / pencil /
            fixed pill). The TICK is NOT here; it lives next to the title. */}
        <div className="flex items-center gap-1.5">
          <span
            className="text-[11px] font-bold tabular-nums"
            style={{ color: "var(--ios-text)" }}
          >
            {fmtTime(item.start)}
          </span>
          {item.source === "calendar" && (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: "var(--ios-text-secondary)" }}
            >
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDefer();
              }}
              className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[4px]"
              style={{
                background: "rgba(255, 255, 255, 0.04)",
                border: "1px solid rgba(255, 255, 255, 0.28)",
                color: "var(--ios-text-secondary)",
              }}
              title={item.source === "calendar" ? "Mute event" : "Defer / remove"}
              aria-label={item.source === "calendar" ? "Mute event" : "Defer / remove"}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {item.source === "calendar" && item.event?.htmlLink && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(item.event!.htmlLink!, "_blank", "noopener,noreferrer");
                }}
                className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[4px]"
                style={{
                  background: "rgba(255, 255, 255, 0.04)",
                  border: "1px solid rgba(255, 255, 255, 0.28)",
                  color: "var(--ios-text-secondary)",
                }}
                title="Edit in Google Calendar"
                aria-label="Edit in Google Calendar"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            )}
            {item.fixed && (
              <span
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-[0.08em]"
                style={{
                  background: "rgba(148, 163, 184, 0.18)",
                  color: "var(--ios-text-secondary)",
                }}
                title="Meeting / appointment — managed externally"
              >
                <svg width="7" height="7" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 8V6a3 3 0 1 1 6 0v3H9Z" />
                </svg>
                fixed
              </span>
            )}
          </div>
        </div>

        {/* TITLE row — title on the left, BIG TICK BOX on the right.
            The tick is the primary action; sized 24x24 so it's
            unambiguously a tap target. */}
        <div className="mt-1 flex items-start gap-2">
          <div
            className="min-w-0 flex-1 text-[13px] font-bold leading-snug"
            style={{ color: "var(--ios-text)", letterSpacing: "-0.01em", textAlign }}
          >
            {item.title}
          </div>
          {!item.fixed && item.task && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onComplete();
              }}
              className="flex h-6 w-6 flex-none items-center justify-center rounded-[5px]"
              style={{
                background: done ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.04)",
                border: done
                  ? "1px solid rgba(255, 255, 255, 0.95)"
                  : "1.5px solid rgba(255, 255, 255, 0.65)",
                color: done ? "#0B0E13" : "var(--ios-text)",
                boxShadow: done
                  ? "0 0 12px rgba(255, 255, 255, 0.55)"
                  : "0 0 8px rgba(255, 255, 255, 0.32), inset 0 0 4px rgba(255, 255, 255, 0.08)",
              }}
              aria-label={done ? "Done — tap to undo" : "Tick off"}
            >
              {done && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l5 5L20 7" />
                </svg>
              )}
            </button>
          )}
        </div>

        {/* SHIFT row — minus on left (earlier), plus on right (later/delay).
            Single row with opposite ends. Past + not done shows a
            "Reschedule → now" pill instead. */}
        {!item.fixed && past && !done && (
          <div className="mt-1.5 flex" style={{ justifyContent: justify }}>
            <button
              type="button"
              onClick={onReschedule}
              className="rounded-md px-2 py-0.5 text-[10px] font-bold"
              style={{
                background: "rgba(245, 158, 11, 0.18)",
                color: "var(--ios-warning)",
                border: "1px solid rgba(245, 158, 11, 0.4)",
              }}
            >
              Reschedule → now
            </button>
          </div>
        )}
        {showShiftControls && (
          <div className="mt-1.5 flex items-center gap-0.5">
            <FineTuneButton onClick={() => onAdjust(-60)} label="−60" />
            <FineTuneButton onClick={() => onAdjust(-15)} label="−15" />
            <span className="flex-1" />
            <FineTuneButton onClick={() => onAdjust(15)} label="+15" />
            <FineTuneButton onClick={() => onAdjust(60)} label="+60" />
          </div>
        )}
      </div>

      {/* ±5 duration chip — half-protruding outside the bottom-centre
          border. Duration label sits BETWEEN the −5 and +5 buttons so
          the duration reads as the centre of its own adjuster. */}
      {!item.fixed && item.task && item.source !== "foundation" && (
        <div
          className="absolute bottom-0 left-1/2 z-10 flex -translate-x-1/2 translate-y-1/2 items-center overflow-hidden rounded-md"
          style={{
            background: "var(--ios-bg)",
            border: "1px solid rgba(255, 255, 255, 0.22)",
            boxShadow: "0 0 6px rgba(0, 0, 0, 0.7)",
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExtendDuration(-5);
            }}
            className="px-1.5 py-0.5 text-[10px] font-bold leading-none"
            style={{ color: "var(--ios-text-secondary)" }}
            aria-label="Shorten by 5 minutes"
          >
            −5
          </button>
          <span
            className="px-2 py-0.5 text-[10px] font-bold tabular-nums leading-none"
            style={{
              color: "var(--ios-text)",
              borderLeft: "1px solid rgba(255,255,255,0.12)",
              borderRight: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            {durationMin}m
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExtendDuration(5);
            }}
            className="px-1.5 py-0.5 text-[10px] font-bold leading-none"
            style={{ color: "var(--ios-text-secondary)" }}
            aria-label="Extend by 5 minutes"
          >
            +5
          </button>
        </div>
      )}
    </div>
  );
}

function FineTuneButton({ onClick, label }: { onClick: () => void; label: string }) {
  // Lower-weight inline control — feels like a text adjuster, not a button.
  // Rests muted; lights up on tap. No background, no border.
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="fine-tune px-1 text-[10px] font-semibold tabular-nums leading-none"
      style={{ color: "rgba(255, 255, 255, 0.45)" }}
    >
      {label}
    </button>
  );
}

// ─── HELPERS / PRIMITIVES ────────────────────────────────────────────
function SectionHeader({ title, muted = false }: { title: string; muted?: boolean }) {
  return (
    <h3
      className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]"
      style={{ color: muted ? "var(--ios-text-muted)" : "var(--ios-text-secondary)" }}
    >
      {title}
    </h3>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded-2xl px-5 py-7 text-center"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <div className="text-[16px] font-bold" style={{ color: "var(--ios-text)" }}>
        {title}
      </div>
      <div className="mt-1 text-[13px]" style={{ color: "var(--ios-text-secondary)" }}>
        {body}
      </div>
    </div>
  );
}

// ─── COMPLETION SHEET ────────────────────────────────────────────────
//
// Three closes per task — three button paths. Visible by design: the user
// has to make a small judgement on every close, which is what makes this
// more than tick-the-box. We keep the inputs lightweight (one optional
// note, one optional follow-up title) so it stays a 2-tap close in the
// common case.
function CompletionSheet({
  task,
  onClose,
  onResolve,
}: {
  task: Task;
  onClose: () => void;
  onResolve: (
    resolution: "achieved" | "course-corrected" | "accepted",
    opts?: { note?: string; followUp?: { title: string } },
  ) => void;
}) {
  const [mode, setMode] = useState<"choose" | "course" | "accept">("choose");
  const [followUp, setFollowUp] = useState("");
  const [note, setNote] = useState("");

  return (
    <div
      className="ios-sheet-backdrop fixed inset-0 z-40 flex items-end"
      onClick={onClose}
      style={{ background: "rgba(0, 0, 0, 0.6)" }}
    >
      <div
        className="ios-sheet w-full"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--ios-surface)",
          borderTopLeftRadius: "24px",
          borderTopRightRadius: "24px",
          padding: "12px 16px calc(env(safe-area-inset-bottom, 0) + 16px)",
          borderTop: "1px solid var(--ios-border)",
        }}
      >
        <div
          className="mx-auto mb-3 h-1 w-10 rounded-full"
          style={{ background: "var(--ios-border-strong)" }}
        />
        <div className="mb-3 px-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--ios-text-secondary)" }}>
            Closing
          </div>
          <div className="mt-0.5 text-[15px] font-bold leading-snug" style={{ color: "var(--ios-text)" }}>
            {task.title}
          </div>
          {task.intendedOutcome && (
            <div className="mt-1.5 rounded-lg px-2.5 py-1.5 text-[12px]" style={{ background: "var(--ios-surface-elev)", color: "var(--ios-text-secondary)" }}>
              <span style={{ color: "var(--ios-text-muted)" }}>Intended outcome: </span>
              {task.intendedOutcome}
            </div>
          )}
        </div>

        {mode === "choose" && (
          <>
            <SheetButton
              variant="primary"
              onClick={() => onResolve("achieved")}
              title="✅ Done — outcome as planned"
              subtitle="Close clean. Counts towards goal momentum."
            />
            <SheetButton
              variant="secondary"
              onClick={() => setMode("course")}
              title="↻ Course-correct"
              subtitle="Outcome diverged — set a follow-up to get back on track"
            />
            <SheetButton
              variant="secondary"
              onClick={() => setMode("accept")}
              title="🤝 Accept & close"
              subtitle="Diverged but not worth chasing — note why & move on"
            />
            <SheetButton variant="cancel" onClick={onClose} title="Cancel" />
          </>
        )}

        {mode === "course" && (
          <>
            <p className="mb-2 px-1 text-[12px]" style={{ color: "var(--ios-text-secondary)" }}>
              What's the next attempt? Keep it concrete — one line is enough.
            </p>
            <input
              type="text"
              autoFocus
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              placeholder="e.g. Re-draft proposal with revised pricing"
              className="mb-3 w-full rounded-xl px-3 py-3 text-[15px] outline-none"
              style={{
                background: "var(--ios-surface-elev)",
                color: "var(--ios-text)",
                border: "1px solid var(--ios-border)",
              }}
            />
            <SheetButton
              variant="primary"
              onClick={() => {
                const t = followUp.trim();
                if (!t) return;
                onResolve("course-corrected", { followUp: { title: t } });
              }}
              title="Create follow-up & close this"
            />
            <SheetButton variant="cancel" onClick={() => setMode("choose")} title="Back" />
          </>
        )}

        {mode === "accept" && (
          <>
            <p className="mb-2 px-1 text-[12px]" style={{ color: "var(--ios-text-secondary)" }}>
              One line on what happened — not punishment, just memory. Skippable.
            </p>
            <input
              type="text"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Client moved on; not worth pursuing"
              className="mb-3 w-full rounded-xl px-3 py-3 text-[15px] outline-none"
              style={{
                background: "var(--ios-surface-elev)",
                color: "var(--ios-text)",
                border: "1px solid var(--ios-border)",
              }}
            />
            <SheetButton
              variant="primary"
              onClick={() =>
                onResolve("accepted", { note: note.trim() || undefined })
              }
              title="Accept & close"
            />
            <SheetButton variant="cancel" onClick={() => setMode("choose")} title="Back" />
          </>
        )}
      </div>
    </div>
  );
}

function KindTag({ task }: { task: Task }) {
  const kind = inferTaskKind(task);
  // follow-ups are the "course-corrected before" signal — make them visible
  // so the user can see at a glance which items are second-attempts.
  const tone = kind === "follow-up" ? "accent" : kind === "appointment" ? "muted" : "default";
  return (
    <Tag tone={tone}>
      <span style={{ marginRight: 3 }}>{kindGlyph(kind)}</span>
      {kindLabel(kind)}
    </Tag>
  );
}

function Tag({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "accent" | "muted" | "danger" | "success";
}) {
  const styles: Record<typeof tone, { bg: string; fg: string }> = {
    default: { bg: "rgba(255,255,255,0.06)", fg: "var(--ios-text-secondary)" },
    accent: { bg: "var(--ios-accent-soft)", fg: "var(--ios-accent)" },
    muted: { bg: "rgba(255,255,255,0.04)", fg: "var(--ios-text-muted)" },
    danger: { bg: "rgba(239, 68, 68, 0.16)", fg: "var(--ios-danger)" },
    success: { bg: "rgba(16, 185, 129, 0.16)", fg: "var(--ios-success)" },
  };
  const s = styles[tone];
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ background: s.bg, color: s.fg }}
    >
      {children}
    </span>
  );
}

function IconButton({
  children,
  onClick,
  title,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  tone?: "default" | "success";
}) {
  const fg = tone === "success" ? "var(--ios-success)" : "var(--ios-text-secondary)";
  const bg = tone === "success" ? "rgba(16, 185, 129, 0.14)" : "rgba(255,255,255,0.05)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-8 w-8 items-center justify-center rounded-full"
      style={{ background: bg, color: fg }}
    >
      {children}
    </button>
  );
}

function TabButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: (props: { active: boolean }) => JSX.Element;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-0.5 py-1.5"
      style={{ color: active ? "var(--ios-accent)" : "var(--ios-text-muted)" }}
    >
      <Icon active={active} />
      <span className="text-[10px] font-semibold">{label}</span>
    </button>
  );
}

function SheetButton({
  variant,
  title,
  subtitle,
  onClick,
}: {
  variant: "primary" | "secondary" | "cancel";
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  if (variant === "cancel") {
    return (
      <button
        type="button"
        onClick={onClick}
        className="mt-2 w-full rounded-xl py-3.5 text-[15px] font-semibold"
        style={{ background: "var(--ios-surface-elev)", color: "var(--ios-text-secondary)" }}
      >
        {title}
      </button>
    );
  }
  const isPrimary = variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-2 flex w-full flex-col items-start rounded-xl px-4 py-3 text-left"
      style={{
        background: isPrimary
          ? "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))"
          : "var(--ios-surface-elev)",
        color: isPrimary ? "white" : "var(--ios-text)",
      }}
    >
      <span className="text-[15px] font-bold">{title}</span>
      {subtitle && (
        <span className="text-[12px]" style={{ opacity: 0.8 }}>
          {subtitle}
        </span>
      )}
    </button>
  );
}

function IconFocus({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function IconGoals({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21V5a2 2 0 0 1 2-2h7l1 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-1-2H5" />
    </svg>
  );
}

// ─── DATA HOOKS ──────────────────────────────────────────────────────
function useTodayEvents(connected: boolean): CalendarEvent[] {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (!connected) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    fetchEvents(start, end)
      .then((list) => {
        if (!cancelled) setEvents(list);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);
  return events;
}

function useDayEvents(connected: boolean, day: Date): CalendarEvent[] {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const dayKey = day.toISOString().slice(0, 10);
  useEffect(() => {
    if (!connected) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(day);
    end.setHours(23, 59, 59, 999);
    fetchEvents(start, end)
      .then((list) => {
        if (!cancelled) setEvents(list);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, dayKey]);
  return events;
}


// ─── PURE HELPERS ────────────────────────────────────────────────────
function pickGoal(task: Task, goalById: Map<string, Goal>): Goal | undefined {
  const ids = task.goalIds ?? [];
  for (const id of ids) {
    const g = goalById.get(id);
    if (g) return g;
  }
  return undefined;
}

function shortGoalLabel(g: Goal): string {
  if (g.title.length <= 18) return g.title;
  return g.title.slice(0, 16) + "…";
}

function goalEmoji(g: Goal): string {
  const t = (g.theme ?? "").toLowerCase();
  if (t === "fitness" || t === "health" || t === "medication") return "💪";
  if (t === "finance") return "💰";
  if (t === "work" || t === "career") return "💼";
  if (t === "school" || t === "development") return "📚";
  if (t === "projects") return "🎯";
  if (t === "family") return "👨‍👩‍👧";
  return "⭐";
}

function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  if (diffDays < 0) return `${-diffDays}d late`;
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isOverdue(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function parseHourOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return 22;
  const h = parseInt(m[1], 10);
  return Number.isFinite(h) ? Math.max(0, Math.min(23, h)) : 22;
}
