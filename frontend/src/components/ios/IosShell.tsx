import { Fragment, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { Goal, PrioritizedTask, Task, Theme, UserPrefs } from "@/types/task";
import { prioritize } from "@/lib/prioritize";
import { fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";
import { inferTaskKind, isActionable, kindGlyph, kindLabel } from "@/lib/taskKind";
import { wasCompletedToday } from "@/lib/recurrence";
import { SuggestedGoalLinks } from "@/components/SuggestedGoalLinks";
import { UnmappedTasks } from "@/components/UnmappedTasks";
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
  /** Update arbitrary user prefs — used by the theme toggle. */
  onUpdatePrefs: (patch: Partial<UserPrefs>) => void;
  /** Returns the freshly-created Goal so callers (e.g. the goal-picker
   *  sheet's "+ New goal" path) can immediately link a task to it. */
  onAddGoal: (input: Omit<Goal, "id" | "createdAt" | "updatedAt" | "source">) => Goal;
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
  // Most-recent completion — drives the post-tick "Add note · Add follow-up"
  // toast that floats above the FAB nav. Auto-dismisses after 9s; explicit
  // close clears it. Doesn't BLOCK the tick — completion fires immediately.
  const [recentlyCompleted, setRecentlyCompleted] = useState<{
    taskId: string;
    title: string;
    at: number;
  } | null>(null);
  // Most-recent defer (down-arrow on a Goals row). Captures the BEFORE
  // patch so Undo can restore exactly what changed — usually
  // snoozedUntil for recurring, scheduledFor / dueDate for one-offs.
  const [recentlyDeferred, setRecentlyDeferred] = useState<{
    taskId: string;
    title: string;
    before: Partial<Task>;
    at: number;
  } | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const completingTask = useMemo(
    () => (completingId ? props.tasks.find((t) => t.id === completingId) : null),
    [completingId, props.tasks],
  );

  // Auto-dismiss the post-tick toast after 9 seconds.
  useEffect(() => {
    if (!recentlyCompleted) return;
    const timer = setTimeout(() => setRecentlyCompleted(null), 9000);
    return () => clearTimeout(timer);
  }, [recentlyCompleted]);

  // Auto-dismiss the post-defer toast after 9 seconds (matches Done toast).
  useEffect(() => {
    if (!recentlyDeferred) return;
    const timer = setTimeout(() => setRecentlyDeferred(null), 9000);
    return () => clearTimeout(timer);
  }, [recentlyDeferred]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => setScrolled(el.scrollTop > 16);
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [tab]);

  return (
    <div
      className="ios-root flex h-screen flex-col"
      data-theme={props.prefs.theme === "light" ? "light" : "dark"}
    >
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
              onClick={() =>
                props.onUpdatePrefs({
                  theme: props.prefs.theme === "light" ? "dark" : "light",
                })
              }
              className="flex h-8 w-8 items-center justify-center rounded-md"
              style={{
                color: "var(--ios-text-secondary)",
                background: "var(--ios-surface)",
                border: "1px solid var(--ios-border)",
              }}
              title={props.prefs.theme === "light" ? "Switch to dark" : "Switch to light"}
              aria-label="Toggle theme"
            >
              {props.prefs.theme === "light" ? (
                /* Moon */
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              ) : (
                /* Sun */
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              )}
            </button>
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
              onAskComplete={(id) => {
              const task = props.tasks.find((t) => t.id === id);
              props.onToggleTask(id);
              // Surface a non-blocking note + follow-up toast for first-time
              // completions (skip if the task was already completed and we're
              // un-ticking).
              if (task && task.status !== "completed") {
                setRecentlyCompleted({
                  taskId: id,
                  title: task.title,
                  at: Date.now(),
                });
              }
            }}
            />
          )}
          {tab === "goals" && (
            <GoalsTab
              {...props}
              onAskComplete={(id) => {
                const task = props.tasks.find((t) => t.id === id);
                props.onToggleTask(id);
                // Surface a non-blocking note + follow-up toast for first-time
                // completions (skip if the task was already completed and we're
                // un-ticking).
                if (task && task.status !== "completed") {
                  setRecentlyCompleted({
                    taskId: id,
                    title: task.title,
                    at: Date.now(),
                  });
                }
              }}
            />
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
          prioritized={props.prioritized}
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
          onSchedule={props.onSchedule}
          onClose={() => setHyperState("closed")}
        />
      )}

      {recentlyDeferred && (
        <DeferredToast
          title={recentlyDeferred.title}
          onClose={() => setRecentlyDeferred(null)}
          onUndo={() => {
            // Restore exactly the fields we changed at defer-time.
            props.onUpdateTask(recentlyDeferred.taskId, recentlyDeferred.before);
            setRecentlyDeferred(null);
          }}
        />
      )}

      {recentlyCompleted && (
        <CompletedToast
          taskId={recentlyCompleted.taskId}
          title={recentlyCompleted.title}
          onClose={() => setRecentlyCompleted(null)}
          onUndo={() => {
            // Un-tick: flips status back to open. The toggle handler is
            // idempotent on status so calling onToggleTask again reverses
            // the previous tick. Also clears any resolution side-effects
            // the user may have saved via Note before clicking Undo.
            const t = props.tasks.find((x) => x.id === recentlyCompleted.taskId);
            if (t && t.status === "completed") {
              props.onToggleTask(recentlyCompleted.taskId);
              if (t.resolution || t.resolutionNote || t.resolutionAt) {
                props.onUpdateTask(recentlyCompleted.taskId, {
                  resolution: undefined,
                  resolutionNote: undefined,
                  resolutionAt: undefined,
                });
              }
            }
            setRecentlyCompleted(null);
          }}
          onSaveNote={(note) => {
            const t = props.tasks.find((x) => x.id === recentlyCompleted.taskId);
            if (t) {
              props.onUpdateTask(t.id, {
                resolution: "achieved",
                resolutionNote: note,
                resolutionAt: new Date().toISOString(),
              });
            }
            setRecentlyCompleted(null);
          }}
          onAddFollowUp={(followUpTitle) => {
            const original = props.tasks.find((x) => x.id === recentlyCompleted.taskId);
            // Use onAddTask via the onUpdateTask path… we don't have direct
            // addTask access here. Reuse the brain-dump entry by setting a
            // marker; for a focused MVP, just open the new-task form pre-
            // filled. Simpler: call onAddTask if available — fall back to
            // a no-op + warn.
            if (props.onAddTask) {
              // Stash the prefill in localStorage so the next NewTask
              // form picks it up. Lightweight; no plumbing required.
              try {
                localStorage.setItem(
                  "focus3:newTaskPrefill",
                  JSON.stringify({
                    title: followUpTitle,
                    followUpToTaskId: original?.id,
                    goalIds: original?.goalIds,
                    theme: original?.theme,
                  }),
                );
              } catch {
                /* noop */
              }
              props.onAddTask();
            }
            setRecentlyCompleted(null);
          }}
        />
      )}

      <style>{`
        .ios-root {
          /* Dark theme — default. Light theme overrides via [data-theme="light"]. */
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
          /* Hyperfocus brand — cyan glow on dark, deeper teal on light. */
          --hyper-bg-from: #0B0E13;
          --hyper-bg-to: #131520;
          --hyper-brand: #7CFFFF;
          --hyper-brand-glow: 0 0 12px rgba(0, 220, 255, 0.6);
          --hyper-brand-soft: rgba(0, 229, 255, 0.18);
          --hyper-button-bg: linear-gradient(135deg, rgba(0, 229, 255, 0.16), rgba(0, 119, 255, 0.16));
          --hyper-button-border: rgba(0, 229, 255, 0.55);
          --hyper-button-shadow: 0 0 8px rgba(0, 229, 255, 0.55);
          --hyper-countdown-bg: radial-gradient(ellipse at center, #001932 0%, #0B0E13 80%);
          --hyper-supporting: #A8D5FF;
          background: var(--ios-bg);
          color: var(--ios-text);
        }
        .ios-root[data-theme="light"] {
          --ios-bg: #F5F6FA;
          --ios-bg-elev: #FFFFFF;
          --ios-surface: #FFFFFF;
          --ios-surface-elev: #F1F3F8;
          --ios-text: #0F172A;
          --ios-text-secondary: #475569;
          --ios-text-muted: #64748B;
          --ios-border: rgba(15, 23, 42, 0.08);
          --ios-border-strong: rgba(15, 23, 42, 0.18);
          --ios-accent: #6D28D9;
          --ios-accent-soft: rgba(124, 58, 237, 0.10);
          --ios-accent-grad-from: #7C3AED;
          --ios-accent-grad-to: #EC4899;
          --ios-success: #059669;
          --ios-warning: #D97706;
          --ios-danger: #DC2626;
          /* Hyperfocus brand on light — deeper teal so the cyan signature
             stays recognisable but isn't blinding-white-on-white. */
          --hyper-bg-from: #F0FBFE;
          --hyper-bg-to: #E0F2FE;
          --hyper-brand: #0891B2;
          --hyper-brand-glow: 0 0 6px rgba(8, 145, 178, 0.25);
          --hyper-brand-soft: rgba(8, 145, 178, 0.12);
          --hyper-button-bg: linear-gradient(135deg, rgba(6, 182, 212, 0.12), rgba(8, 145, 178, 0.16));
          --hyper-button-border: rgba(8, 145, 178, 0.45);
          --hyper-button-shadow: 0 0 6px rgba(8, 145, 178, 0.30);
          --hyper-countdown-bg: radial-gradient(ellipse at center, #DBF4FB 0%, #F5F6FA 80%);
          --hyper-supporting: #0E7490;
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

      {/* Quick Log used to live inline at the bottom of the Focus tab,
          so it scrolled away. The user wants it pinned: render an empty
          spacer here so the page-content height accounts for the
          fixed-position tray below — no overlap with the last task. */}
      <div aria-hidden style={{ height: 96 }} />
      <FixedQuickTray enabled={p.prefs.quickLogItems} />
    </div>
  );
}

/** Quick Log fixed above the FAB nav. Positioned at bottom + 88px (the
 *  FAB nav height) so it sits exactly between content and the tab bar.
 *  Has its own blurred surface so it reads against scrolling content. */
function FixedQuickTray({ enabled }: { enabled?: string[] }) {
  return (
    <div
      className="fixed inset-x-0 z-20 px-5 pt-2"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0) + 88px)",
        background:
          "linear-gradient(to top, rgba(15, 18, 24, 0.95) 60%, rgba(15, 18, 24, 0))",
        backdropFilter: "saturate(180%) blur(18px)",
        WebkitBackdropFilter: "saturate(180%) blur(18px)",
        pointerEvents: "none",
      }}
    >
      <div className="mx-auto max-w-md" style={{ pointerEvents: "auto" }}>
        <QuickTray enabled={enabled} />
      </div>
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
        background: "var(--hyper-button-bg)",
        color: "var(--hyper-button-text, var(--hyper-brand))",
        border: "1px solid var(--hyper-button-border)",
        letterSpacing: "0.18em",
        textShadow: "var(--hyper-button-shadow)",
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
        background: "var(--hyper-countdown-bg)",
        paddingTop: "env(safe-area-inset-top, 0)",
      }}
    >
      <button
        type="button"
        onClick={onCancel}
        className="absolute right-5 top-5 rounded-md px-3 py-1.5 text-[12px] font-medium"
        style={{
          background: "var(--ios-surface-elev)",
          color: "var(--ios-text-secondary)",
          border: "1px solid var(--ios-border)",
        }}
      >
        Cancel
      </button>

      <div className="text-center">
        <div
          className="mb-4 text-[14px] font-black"
          style={{
            color: "var(--hyper-brand)",
            letterSpacing: "0.32em",
            textShadow: "var(--hyper-brand-glow)",
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
            color: "var(--hyper-brand)",
            letterSpacing: "-0.04em",
            textShadow: "var(--hyper-brand-glow)",
          }}
        >
          {n > 0 ? n : "GO"}
        </div>
        <div
          className="mt-6 text-[18px] font-semibold"
          style={{ color: "var(--hyper-supporting)", letterSpacing: "-0.01em" }}
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
            background: "var(--ios-surface-elev)",
            color: "var(--ios-text-muted)",
            border: "1px solid var(--ios-border)",
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
// Extended catalogue of trackables; the user picks which to show via
// prefs.quickLogItems (Settings → Quick Log). Default set keeps it neutral
// (water + walk) so users tracking different things — vices, hydration,
// movement — opt INTO what's surfaced rather than seeing a "Med" prompt
// out of the box. Walk hooks into device step count later; for now it's
// a tap counter same as the rest.
type QuickIconKey =
  | "water"
  | "coffee"
  | "snack"
  | "step"
  | "med"
  | "smoke"
  | "drink"
  | "sugar"
  | "screen";

const QUICK_CATALOGUE: { key: QuickIconKey; label: string }[] = [
  { key: "water", label: "Water" },
  { key: "step", label: "Walk" },
  { key: "coffee", label: "Coffee" },
  { key: "snack", label: "Snack" },
  { key: "smoke", label: "Smoke" },
  { key: "drink", label: "Drink" },
  { key: "sugar", label: "Sugar" },
  { key: "screen", label: "Screen" },
  { key: "med", label: "Med" },
];

const DEFAULT_QUICK_KEYS: QuickIconKey[] = ["water", "step"];

/** Outline SVG icons for the Quick log — replacing the previous emoji.
 *  Single colour, 1.6 stroke, 18×18, scaled by parent. Designed to read
 *  cleanly at small size and align to the same baseline as the labels. */
function QuickIcon({ kind }: { kind: QuickIconKey }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24" as const,
    fill: "none" as const,
    stroke: "currentColor" as const,
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "water":
      return (
        <svg {...common}>
          <path d="M12 3.5C12 3.5 6 10 6 14a6 6 0 0 0 12 0c0-4-6-10.5-6-10.5Z" />
        </svg>
      );
    case "coffee":
      return (
        <svg {...common}>
          <path d="M4 8h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Z" />
          <path d="M16 9h2a3 3 0 0 1 0 6h-2" />
          <path d="M8 4v2M11 4v2M14 4v2" />
        </svg>
      );
    case "snack":
      return (
        <svg {...common}>
          <path d="M12 5a7 7 0 0 0-7 7v1a7 7 0 0 0 14 0v-1a7 7 0 0 0-7-7Z" />
          <path d="M14 4c0 1.5-1 2.5-2.5 2.5" />
          <path d="M9.5 4.5c0 1 0.5 1.5 1.5 1.5" />
        </svg>
      );
    case "step":
      return (
        <svg {...common}>
          <path d="M7 17l-1 4M14 18l1 3" />
          <path d="M9 14l-2-3 4-2 3 3-2 3-3-1Z" />
          <circle cx="13" cy="6" r="2" />
        </svg>
      );
    case "med":
      return (
        <svg {...common}>
          <rect x="4" y="9" width="16" height="6" rx="3" transform="rotate(-30 12 12)" />
          <path d="M9.5 7l5 9" transform="rotate(-30 12 12)" />
        </svg>
      );
    case "smoke":
      return (
        <svg {...common}>
          {/* cigarette */}
          <rect x="3" y="13" width="14" height="3" rx="0.5" />
          <path d="M14 13v3" />
          <path d="M19 9c0-1.5-1-2-1-3.5" />
        </svg>
      );
    case "drink":
      return (
        <svg {...common}>
          {/* wine glass */}
          <path d="M7 4h10c0 4-2 7-5 7s-5-3-5-7Z" />
          <path d="M12 11v8M9 19h6" />
        </svg>
      );
    case "sugar":
      return (
        <svg {...common}>
          {/* sugar cube */}
          <rect x="5" y="5" width="14" height="14" rx="2" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
      );
    case "screen":
      return (
        <svg {...common}>
          {/* phone */}
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M11 18h2" />
        </svg>
      );
  }
}

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

function QuickTray({ enabled }: { enabled?: string[] } = {}) {
  const [counts, setCounts] = useState<Record<string, number>>(() => readQuick());

  function bump(key: string) {
    setCounts((prev) => {
      const next = { ...prev, [key]: (prev[key] ?? 0) + 1 };
      writeQuick(next);
      return next;
    });
  }

  // Resolve which items to show: explicit prefs.quickLogItems OR sensible
  // default. Filters the catalogue so the tiles render in catalogue order
  // (so e.g. "Water" stays leftmost regardless of what else is enabled).
  const enabledSet = new Set<string>(
    enabled && enabled.length > 0 ? enabled : DEFAULT_QUICK_KEYS,
  );
  const items = QUICK_CATALOGUE.filter((it) => enabledSet.has(it.key));
  if (items.length === 0) return null;

  return (
    <section>
      <h3
        className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.16em]"
        style={{ color: "var(--ios-text-muted)" }}
      >
        Quick log
      </h3>
      <div className="flex w-full items-center justify-center gap-1">
        {items.map((item) => (
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
            <QuickIcon kind={item.key} />
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
/**
 * Goals tab — tabbed view across goals + uncategorized + create-new.
 * Tab bar at top scrolls horizontally on mobile. Selected tab shows
 * its task list with bigger fonts than before. Each task row has a
 * ⋯ menu opening MoveToGoalSheet for quick goal assignment.
 *
 * Tasks are sorted to prioritise the goal-linked ones (with due dates
 * weighted) so the user sees what's most important per goal up top.
 *
 * "+ New" tab opens NewGoalForm (modal) — title + horizon. The new
 * goal becomes the selected tab afterwards.
 */
function GoalsTab(
  p: IosShellProps & {
    onAskComplete: (id: string) => void;
  },
) {

  // Selected tab: "all" | goal id | "none" (uncategorised)
  type Tab = "all" | "none" | string; // a goal id
  const [tab, setTab] = useState<Tab>("all");
  const [showNewGoal, setShowNewGoal] = useState(false);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  // Theme bucket filter — top-level pill row above the per-goal tab bar.
  // null = all themes show. Filtering by theme constrains BOTH the goal
  // tabs (only goals of this theme appear) and the All/None defaults
  // (tasks are filtered to ones whose theme matches).
  const [themeFilter, setThemeFilter] = useState<Theme | null>(null);

  const themeCounts = useMemo(() => {
    const m = new Map<Theme, number>();
    for (const g of p.goals) m.set(g.theme, (m.get(g.theme) ?? 0) + 1);
    return m;
  }, [p.goals]);
  const visibleGoals = themeFilter
    ? p.goals.filter((g) => g.theme === themeFilter)
    : p.goals;

  const ignoredEvents = useMemo(
    () => new Set(p.prefs.ignoredEventIds ?? []),
    [p.prefs.ignoredEventIds],
  );

  const visibleTasks = useMemo(() => {
    return p.tasks.filter((t) => {
      if (t.status === "completed") return false;
      if (t.calendarEventId && ignoredEvents.has(t.calendarEventId)) return false;
      if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) return false;
      return true;
    });
  }, [p.tasks, ignoredEvents]);

  const sortByPriority = (list: Task[]) => {
    return [...list].sort((a, b) => {
      // Goal-linked → first (in case "all" tab mixes both)
      const ag = (a.goalIds ?? []).length > 0 ? 0 : 1;
      const bg = (b.goalIds ?? []).length > 0 ? 0 : 1;
      if (ag !== bg) return ag - bg;
      // Then by due date
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      if (da !== db) return da - db;
      // Then by urgency
      const order: Record<string, number> = {
        critical: 0, high: 1, normal: 2, low: 3,
      };
      return (order[a.urgency] ?? 4) - (order[b.urgency] ?? 4);
    });
  };

  const tasksForTab = useMemo(() => {
    // Theme filter narrows the task list to ones whose theme matches —
    // applied BEFORE the All / None / per-goal slice so the counts
    // beneath stay coherent.
    let pool = visibleTasks;
    if (themeFilter) {
      pool = pool.filter((t) => t.theme === themeFilter);
    }
    if (tab === "all") return sortByPriority(pool);
    if (tab === "none") {
      return sortByPriority(
        pool.filter((t) => (t.goalIds ?? []).length === 0),
      );
    }
    return sortByPriority(pool.filter((t) => (t.goalIds ?? []).includes(tab)));
  }, [tab, visibleTasks, themeFilter]);

  const counts = useMemo(() => {
    const byGoal = new Map<string, number>();
    let none = 0;
    for (const t of visibleTasks) {
      const ids = t.goalIds ?? [];
      if (ids.length === 0) none += 1;
      for (const gid of ids) byGoal.set(gid, (byGoal.get(gid) ?? 0) + 1);
    }
    return { byGoal, none, all: visibleTasks.length };
  }, [visibleTasks]);

  const handleMoveTask = (taskId: string, goalId: string | null) => {
    const task = p.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const newGoalIds = goalId ? [goalId] : [];
    p.onUpdateTask(taskId, { goalIds: newGoalIds });
    setMovingTaskId(null);
  };

  return (
    <div className="space-y-3 pt-2">
      {/* Theme bucket pills — top-level filter row above the per-goal
          tab bar. Only renders when there are 2+ goal themes; single-
          theme users don't need redundant chrome. */}
      {themeCounts.size >= 2 && (
        <div className="-mx-1 flex flex-nowrap gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setThemeFilter(null)}
            className="flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold"
            style={{
              background:
                themeFilter === null
                  ? "var(--ios-text)"
                  : "var(--ios-surface-elev)",
              color:
                themeFilter === null
                  ? "var(--ios-bg)"
                  : "var(--ios-text-secondary)",
              border: `1px solid ${themeFilter === null ? "var(--ios-text)" : "var(--ios-border)"}`,
            }}
          >
            All · {p.goals.length}
          </button>
          {Array.from(themeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([th, count]) => {
              const active = themeFilter === th;
              return (
                <button
                  key={th}
                  type="button"
                  onClick={() => setThemeFilter(active ? null : th)}
                  className="flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold"
                  style={{
                    background: active
                      ? "var(--ios-text)"
                      : "var(--ios-surface-elev)",
                    color: active
                      ? "var(--ios-bg)"
                      : "var(--ios-text-secondary)",
                    border: `1px solid ${active ? "var(--ios-text)" : "var(--ios-border)"}`,
                  }}
                >
                  {th} · {count}
                </button>
              );
            })}
        </div>
      )}
      <GoalsTabBar
        tab={tab}
        goals={visibleGoals}
        counts={counts}
        onSelect={setTab}
        onNew={() => setShowNewGoal(true)}
      />

      {/* Auto-suggest panel — uses the same component the desktop renders.
          Empty result returns null so this is a no-op when there's nothing
          to bucket. Calendar appointments are excluded inside the
          component (already-known-about). */}
      <SuggestedGoalLinks
        tasks={p.tasks}
        goals={p.goals}
        dismissedTaskIds={p.prefs.dismissedGoalSuggestions ?? []}
        onLink={(taskId, goalId) => {
          const t = p.tasks.find((x) => x.id === taskId);
          if (!t) return;
          const cur = t.goalIds ?? [];
          if (cur.includes(goalId)) return;
          p.onUpdateTask(taskId, { goalIds: [...cur, goalId] });
        }}
        onDismiss={(taskId) => {
          const cur = p.prefs.dismissedGoalSuggestions ?? [];
          if (cur.includes(taskId)) return;
          p.onUpdatePrefs({ dismissedGoalSuggestions: [...cur, taskId] });
        }}
      />
      <UnmappedTasks
        tasks={p.tasks}
        goals={p.goals}
        dismissedTaskIds={p.prefs.dismissedGoalSuggestions ?? []}
        onLink={(taskId, goalId) => {
          const t = p.tasks.find((x) => x.id === taskId);
          if (!t) return;
          const cur = t.goalIds ?? [];
          if (cur.includes(goalId)) return;
          p.onUpdateTask(taskId, { goalIds: [...cur, goalId] });
        }}
        onDismiss={(taskId) => {
          const cur = p.prefs.dismissedGoalSuggestions ?? [];
          if (cur.includes(taskId)) return;
          p.onUpdatePrefs({ dismissedGoalSuggestions: [...cur, taskId] });
        }}
      />

      {p.goals.length === 0 && counts.all === 0 ? (
        <Empty
          title="No goals or tasks yet"
          body="Tap + New to add a goal, or use the FAB to add a task. Anything you add can be moved into a goal later."
        />
      ) : tasksForTab.length === 0 ? (
        <p className="px-2 py-4 text-center text-[13px]" style={{ color: "var(--ios-text-muted)" }}>
          {tab === "none"
            ? "No drifting tasks — every open task is laddered up to a goal."
            : tab === "all"
              ? "Nothing open."
              : "Nothing open under this goal — well done."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {tasksForTab.map((t) => (
            <GoalTaskRow
              key={t.id}
              task={t}
              goal={p.goals.find((g) => (t.goalIds ?? []).includes(g.id))}
              onComplete={() => p.onAskComplete(t.id)}
              onEdit={() => p.onEditTask(t.id)}
              onMove={() => setMovingTaskId(t.id)}
            />
          ))}
        </div>
      )}

      {showNewGoal && (
        <NewGoalForm
          onClose={() => setShowNewGoal(false)}
          onCreate={(input) => {
            p.onAddGoal(input);
            setShowNewGoal(false);
          }}
        />
      )}

      {movingTaskId && (
        <MoveToGoalSheet
          task={p.tasks.find((t) => t.id === movingTaskId)!}
          goals={p.goals}
          onClose={() => setMovingTaskId(null)}
          onMove={(goalId) => handleMoveTask(movingTaskId, goalId)}
          onCreateAndAssign={(title, theme) => {
            // Synchronously create the goal (default 1y horizon — user
            // can re-tier it later in Desktop Goals view) and assign
            // the in-progress task to it.
            const fresh = p.onAddGoal({
              title,
              horizon: "1y",
              theme,
              notes: "",
            });
            handleMoveTask(movingTaskId, fresh.id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Horizontal scrolling tab bar. Pills for All / each goal / Uncategorized
 * / + New. The active tab is filled; others sit muted. Counts on each pill
 * tell the user how many open tasks live under each.
 */
function GoalsTabBar({
  tab,
  goals,
  counts,
  onSelect,
  onNew,
}: {
  tab: "all" | "none" | string;
  goals: Goal[];
  counts: { byGoal: Map<string, number>; none: number; all: number };
  onSelect: (tab: "all" | "none" | string) => void;
  onNew: () => void;
}) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" style={{ scrollbarWidth: "none" }}>
      <GoalsTabPill active={tab === "all"} onClick={() => onSelect("all")}>
        All <span style={{ opacity: 0.6, marginLeft: 4 }}>{counts.all}</span>
      </GoalsTabPill>
      {goals.map((g) => (
        <GoalsTabPill
          key={g.id}
          active={tab === g.id}
          onClick={() => onSelect(g.id)}
        >
          {g.title}
          <span style={{ opacity: 0.6, marginLeft: 4 }}>
            {counts.byGoal.get(g.id) ?? 0}
          </span>
        </GoalsTabPill>
      ))}
      {counts.none > 0 && (
        <GoalsTabPill
          active={tab === "none"}
          onClick={() => onSelect("none")}
          tone="warning"
        >
          No goal <span style={{ opacity: 0.6, marginLeft: 4 }}>{counts.none}</span>
        </GoalsTabPill>
      )}
      <GoalsTabPill onClick={onNew} tone="accent">
        + New
      </GoalsTabPill>
    </div>
  );
}

function GoalsTabPill({
  active,
  onClick,
  children,
  tone = "default",
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "warning" | "accent";
}) {
  const colours = active
    ? {
        bg: "var(--ios-text)",
        fg: "var(--ios-bg)",
        border: "var(--ios-text)",
      }
    : tone === "warning"
      ? {
          bg: "rgba(245, 158, 11, 0.10)",
          fg: "var(--ios-warning)",
          border: "rgba(245, 158, 11, 0.32)",
        }
      : tone === "accent"
        ? {
            bg: "var(--ios-accent-soft)",
            fg: "var(--ios-accent)",
            border: "rgba(167, 139, 250, 0.40)",
          }
        : {
            bg: "var(--ios-surface)",
            fg: "var(--ios-text-secondary)",
            border: "var(--ios-border)",
          };
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-none items-center rounded-md px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap"
      style={{
        background: colours.bg,
        color: colours.fg,
        border: `1px solid ${colours.border}`,
      }}
    >
      {children}
    </button>
  );
}

/**
 * Inline modal to create a new goal. Title + horizon (6m / 1y / 5y / 10y).
 * Theme defaults to "personal" — the user can refine on Desktop where the
 * full goal editor lives.
 */
function NewGoalForm({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: Omit<Goal, "id" | "createdAt" | "updatedAt" | "source">) => void;
}) {
  const [title, setTitle] = useState("");
  const [horizon, setHorizon] = useState<Goal["horizon"]>("1y");

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
        <div className="mb-3 px-1 text-[16px] font-bold" style={{ color: "var(--ios-text)" }}>
          New goal
        </div>
        <input
          type="text"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Run a sub-22 5k"
          className="mb-3 w-full rounded-xl px-3 py-3 text-[15px] outline-none"
          style={{
            background: "var(--ios-surface-elev)",
            color: "var(--ios-text)",
            border: "1px solid var(--ios-border)",
          }}
        />
        <div
          className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--ios-text-secondary)" }}
        >
          Horizon
        </div>
        <div className="mb-4 flex gap-1.5">
          {(["6m", "1y", "5y", "10y"] as const).map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHorizon(h)}
              className="flex-1 rounded-md px-2 py-2 text-[12px] font-semibold"
              style={{
                background: horizon === h ? "var(--ios-text)" : "var(--ios-surface-elev)",
                color: horizon === h ? "var(--ios-bg)" : "var(--ios-text-secondary)",
                border: `1px solid ${horizon === h ? "var(--ios-text)" : "var(--ios-border)"}`,
              }}
            >
              {h}
            </button>
          ))}
        </div>
        <SheetButton
          variant="primary"
          onClick={() => {
            const t = title.trim();
            if (!t) return;
            onCreate({
              title: t,
              horizon,
              theme: "personal",
            });
          }}
          title="Create goal"
        />
        <SheetButton variant="cancel" onClick={onClose} title="Cancel" />
      </div>
    </div>
  );
}

/**
 * Bottom sheet to assign a task to a goal. Lists each goal as a tappable
 * row (with current selection check), plus "Remove from any goal" at the
 * bottom for unlinking. Single-tap selects + closes.
 */
function MoveToGoalSheet({
  task,
  goals,
  onClose,
  onMove,
  onCreateAndAssign,
}: {
  task: Task;
  goals: Goal[];
  onClose: () => void;
  onMove: (goalId: string | null) => void;
  /** Create a new goal AND assign this task to it in one atomic step.
   *  Theme inherits from the task — goals naturally bucket by theme so
   *  this keeps the new goal aligned with the task's category. */
  onCreateAndAssign: (title: string, theme: Theme) => void;
}) {
  const currentGoalIds = new Set(task.goalIds ?? []);
  const [newGoalTitle, setNewGoalTitle] = useState("");
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
        <div className="mx-auto mb-3 h-1 w-10 rounded-full" style={{ background: "var(--ios-border-strong)" }} />
        <div className="mb-3 px-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--ios-text-secondary)" }}>
            Set goal
          </div>
          <div className="mt-0.5 text-[15px] font-bold leading-snug" style={{ color: "var(--ios-text)" }}>
            {task.title}
          </div>
        </div>

        {/* Inline "add new goal" — type a title, hit Enter (or +) and the
            goal is created with the task's theme + assigned in one step. */}
        <div
          className="mb-3 flex items-center gap-2 rounded-md px-3 py-2"
          style={{
            background: "var(--ios-surface-elev)",
            border: "1px dashed var(--ios-border-strong)",
          }}
        >
          <span className="text-[14px]" style={{ color: "var(--ios-text-muted)" }}>+</span>
          <input
            type="text"
            value={newGoalTitle}
            onChange={(e) => setNewGoalTitle(e.target.value)}
            placeholder={`New goal (theme: ${task.theme})`}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
            style={{ color: "var(--ios-text)" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newGoalTitle.trim()) {
                onCreateAndAssign(newGoalTitle.trim(), task.theme);
              }
            }}
          />
          <button
            type="button"
            disabled={!newGoalTitle.trim()}
            onClick={() => {
              if (newGoalTitle.trim()) {
                onCreateAndAssign(newGoalTitle.trim(), task.theme);
              }
            }}
            className="flex-none rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-30"
            style={{
              background: "var(--ios-accent-soft)",
              color: "var(--ios-accent)",
              border: "1px solid rgba(167, 139, 250, 0.4)",
            }}
          >
            Add
          </button>
        </div>

        {goals.length === 0 ? (
          <div className="px-1 py-2 text-center text-[12px]" style={{ color: "var(--ios-text-muted)" }}>
            No existing goals — type a title above to create your first one.
          </div>
        ) : (
          <div className="mb-2 space-y-1">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--ios-text-muted)" }}>
              Or pick existing
            </div>
            {goals.map((g) => {
              const selected = currentGoalIds.has(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onMove(g.id)}
                  className="flex w-full items-center justify-between rounded-md px-3 py-3 text-left"
                  style={{
                    background: selected ? "var(--ios-accent-soft)" : "var(--ios-surface-elev)",
                    color: "var(--ios-text)",
                    border: `1px solid ${selected ? "rgba(167, 139, 250, 0.32)" : "var(--ios-border)"}`,
                  }}
                >
                  <span className="text-[14px] font-semibold">{g.title}</span>
                  {selected && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--ios-accent)" }}>
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <SheetButton variant="secondary" onClick={() => onMove(null)} title="Remove from any goal" />
        <SheetButton variant="cancel" onClick={onClose} title="Cancel" />
      </div>
    </div>
  );
}

/**
 * GoalTaskRow — bigger fonts, full-width row with goal pill, "set goal" +
 * tick on the right.
 *
 * The down-chevron used to defer (which made the item disappear with no
 * obvious reason). It now opens the goal-picker sheet — the more useful
 * action on the Goals tab where the user is actively organising. Defer
 * behaviour is still reachable from elsewhere (Hyper Focus, manual edit).
 *
 * Tick gets the standard CompletedToast with Undo so an accidental tap
 * is recoverable. Title is 16px so the row reads like a real list item.
 */
function GoalTaskRow({
  task,
  goal,
  onComplete,
  onEdit,
  onMove,
}: {
  task: Task;
  goal?: Goal;
  onComplete: () => void;
  onEdit: () => void;
  /** Open goal-picker sheet — pick existing or create new. */
  onMove: () => void;
}) {
  const done = task.status === "completed";
  return (
    <div
      className="flex items-center gap-2 rounded-xl px-3 py-2.5 transition-shadow duration-200"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
        opacity: done ? 0.45 : 1,
        boxShadow: done ? "none" : "0 0 12px rgba(255, 255, 255, 0.10)",
      }}
    >
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[16px] font-bold leading-tight" style={{ color: "var(--ios-text)", letterSpacing: "-0.01em" }}>
          {task.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: "var(--ios-text-muted)" }}>
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
            <span
              className="rounded px-1.5 py-0.5"
              style={{ background: "var(--ios-accent-soft)", color: "var(--ios-accent)" }}
            >
              {goal.title.length > 14 ? goal.title.slice(0, 12) + "…" : goal.title}
            </span>
          )}
        </div>
      </button>
      <div className="flex flex-none items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMove();
          }}
          className="flex h-[22px] flex-none items-center justify-center gap-1 rounded-md px-1.5"
          style={{
            background: "var(--ios-surface-elev)",
            border: "1px solid var(--ios-border)",
            color: "var(--ios-text-secondary)",
          }}
          title="Set goal — pick existing or add new"
          aria-label="Set goal"
        >
          {/* Target icon — concentric circles. Reads as 'aim / goal'
              rather than the old chevron which suggested defer. */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          <span className="text-[10px] font-semibold">Goal</span>
        </button>
        <button
          type="button"
          onClick={onComplete}
          className="flex h-6 w-6 flex-none items-center justify-center rounded-[5px]"
          style={{
            background: done ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.04)",
            border: done
              ? "1px solid rgba(255, 255, 255, 0.95)"
              : "1.5px solid rgba(255, 255, 255, 0.65)",
            color: done ? "#0B0E13" : "var(--ios-text)",
            boxShadow: done
              ? "0 0 12px rgba(255, 255, 255, 0.55)"
              : "0 0 8px rgba(255, 255, 255, 0.32)",
          }}
          aria-label={done ? "Done" : "Tick off"}
        >
          {done && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5L20 7" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── HYPER FOCUS OVERLAY ─────────────────────────────────────────────
interface HyperFocusProps {
  tasks: Task[];
  foundations: Task[];
  goals: Goal[];
  /** Top-three priority tasks — used to suggest slotting them into
   *  empty gaps on the day plan. */
  prioritized: PrioritizedTask[];
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
  /** Open the schedule picker for a task — used by the Plan section. */
  onSchedule: (taskId: string) => void;
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

  // Last auto-reschedule outcome — drives a banner above the timeline so
  // the user knows what happened. Without this, clicking Auto Schedule
  // when nothing can fit fails silently.
  const [autoOutcome, setAutoOutcome] = useState<{
    placed: number;
    unplaced: Array<{ taskId: string; title: string; reason: string }>;
    at: number;
  } | null>(null);

  function handleAutoReschedule() {
    const now = new Date();
    const { updates, unplaced } = autoReschedule({
      day: targetDay,
      from: now,
      prefs: p.prefs,
      items,
      unscheduled,
    });
    for (const u of updates) {
      p.onSetScheduledFor(u.taskId, u.newScheduledForIso);
    }
    setAutoOutcome({
      placed: updates.length,
      unplaced: unplaced.map((u) => ({
        taskId: u.taskId,
        title:
          p.tasks.find((t) => t.id === u.taskId)?.title ??
          unscheduled.find((s) => s.task.id === u.taskId)?.title ??
          "(unknown)",
        reason: u.reason,
      })),
      at: Date.now(),
    });
  }

  /** Push an unplaced task forward by N days at the start of the
   *  working day. Used by the auto-schedule outcome banner ("3 didn't
   *  fit — push to tomorrow"). */
  function pushTaskByDays(taskId: string, days: number) {
    const target = new Date();
    target.setDate(target.getDate() + days);
    const { h, m } = (() => {
      const s = (p.prefs.workingHoursStart ?? "09:00").match(/^(\d{1,2}):(\d{2})$/);
      return s ? { h: parseInt(s[1], 10), m: parseInt(s[2], 10) } : { h: 9, m: 0 };
    })();
    target.setHours(h, m, 0, 0);
    p.onSetScheduledFor(taskId, target.toISOString());
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
    handleDeferToDate(t, tomorrow.toISOString());
  }

  /** Generic "push this task to a specific date" — same routing logic as
   *  handleSnoozeTomorrow but with a caller-supplied target. Recurring
   *  patterns snooze through to the day before the target so the natural
   *  next instance lands on / after that date; one-offs move scheduledFor
   *  (or dueDate). Used by the DeferSheet's "specific day" picker. */
  function handleDeferToDate(t: Task, targetIso: string) {
    const isRecurring = t.recurrence && t.recurrence !== "none";
    if (isRecurring) {
      // Snooze until the day BEFORE the target so the recurrence engine
      // emits the next instance on the chosen day. (snoozedUntil is
      // exclusive — task wakes up the moment now() passes it.)
      const target = new Date(targetIso);
      const wakeAt = new Date(target);
      wakeAt.setDate(wakeAt.getDate() - 1);
      wakeAt.setHours(23, 59, 59, 999);
      p.onSnooze(t.id, wakeAt.toISOString());
      return;
    }
    const patch: Partial<Task> = { snoozedUntil: undefined };
    if (t.scheduledFor) {
      patch.scheduledFor = targetIso;
    } else if (t.dueDate) {
      patch.dueDate = targetIso;
    } else {
      patch.scheduledFor = targetIso;
    }
    p.onUpdateTask(t.id, patch);
  }

  /**
   * Remove the item from view permanently. For tasks: delete (the user
   * explicitly said this shouldn't be there). For Google events: mute
   * (we can't delete from the user's calendar without permission, but
   * we can hide it from Focus3).
   */
  /**
   * Ignore an item. NOT a delete — that destructive action stays
   * desktop-only. For tasks we set snoozedUntil to a far-future date
   * so it disappears from every iOS surface but the data stays
   * intact (un-ignore on Desktop). For calendar events we mute via
   * prefs.ignoredEventIds (same channel as before).
   */
  function handleRemove(item: DayItem) {
    if (item.source === "calendar" && item.event) {
      p.onMuteEvent(item.event.id);
      return;
    }
    if (item.task) {
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 50);
      p.onSnooze(item.task.id, farFuture.toISOString());
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
        background:
          "linear-gradient(180deg, var(--hyper-bg-from) 0%, var(--hyper-bg-to) 100%)",
        paddingTop: "env(safe-area-inset-top, 0)",
        paddingBottom: "env(safe-area-inset-bottom, 0)",
      }}
    >
      {/* HYPERFOCUS top brand — bigger, presence-y, no oval container, the
          letter-spacing + glow does the work. */}
      <div
        className="flex items-center justify-center px-5 py-3"
        style={{
          background: "var(--hyper-brand-soft)",
          borderBottom: "1px solid var(--hyper-button-border)",
        }}
      >
        <span
          className="hyper-ribbon-pulse text-[18px] font-black"
          style={{
            color: "var(--hyper-brand)",
            letterSpacing: "0.36em",
            textShadow: "var(--hyper-brand-glow)",
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
          // Top-3 candidates for slotting into open gaps. Filter out the
          // ones already on today's plan so we only suggest tasks that
          // genuinely need a home.
          slotCandidates={p.prioritized
            .filter((pt) => {
              if (pt.task.scheduledFor) {
                const d = new Date(pt.task.scheduledFor);
                if (!Number.isNaN(d.getTime()) && sameYearMonthDay(d, targetDay)) {
                  return false;
                }
              }
              return !pt.task.calendarEventId;
            })
            .map((pt) => pt.task)}
          onAdjust={handleAdjustTime}
          onAutoReschedule={handleAutoReschedule}
          autoOutcome={autoOutcome}
          onPushUnplaced={pushTaskByDays}
          onDismissAutoOutcome={() => setAutoOutcome(null)}
          onComplete={(taskId) => p.onComplete(taskId)}
          onReschedule={handleReschedule}
          onExtendDuration={handleExtendDuration}
          onDefer={(item) => setDeferingItem(item)}
          onSlotIntoGap={(taskId, startIso) => {
            p.onSetScheduledFor(taskId, startIso);
          }}
          onDeferCandidate={(taskId) => {
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
          }}
        />

        {dayOffset === 0 && (
          <TomorrowPreview
            tasks={p.tasks}
            foundations={p.foundations}
            prefs={p.prefs}
            calendarConnected={p.calendarConnected}
            onDefer={(taskId) => {
              // Push tomorrow's item further forward — to the day after.
              const t = p.tasks.find((x) => x.id === taskId);
              if (!t) return;
              const target = new Date();
              target.setDate(target.getDate() + 2);
              target.setHours(9, 0, 0, 0);
              const patch: Partial<Task> = { snoozedUntil: undefined };
              if (t.companyHouseNumber) {
                patch.scheduledFor = target.toISOString();
              } else if (t.scheduledFor) {
                patch.scheduledFor = target.toISOString();
              } else {
                patch.dueDate = target.toISOString();
              }
              p.onUpdateTask(taskId, patch);
            }}
            onSchedule={(taskId) => {
              // Reuse the desktop schedule picker via the existing
              // IosShell prop chain (props.onSchedule handles opening).
              p.onSchedule(taskId);
            }}
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
        <QuickTray enabled={p.prefs.quickLogItems} />
      </div>

      {deferingItem && (
        <DeferSheet
          item={deferingItem}
          onClose={() => setDeferingItem(null)}
          onSnoozeTomorrow={() => {
            handleSnoozeTomorrow(deferingItem);
            setDeferingItem(null);
          }}
          onSnoozeUntilDate={(iso) => {
            // Calendar events skip the day picker (they show only the
            // mute option), so item.task is set here.
            if (deferingItem.task) handleDeferToDate(deferingItem.task, iso);
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
/**
 * Post-tick toast — non-blocking. Slides up from the bottom over the FAB
 * nav after a task is marked complete. Offers two follow-on actions
 * without standing in the way: add a quick note (saved to
 * task.resolutionNote) or spawn a follow-up task pre-filled with the
 * original's context. Auto-dismisses; explicit close clears.
 */
/**
 * Slim toast that appears after a Goals defer (down-arrow). Same vertical
 * slot as CompletedToast — we only ever show one at a time, and the post-
 * defer flow rarely overlaps a tick. Single Undo button + dismiss.
 */
function DeferredToast({
  title,
  onClose,
  onUndo,
}: {
  title: string;
  onClose: () => void;
  onUndo: () => void;
}) {
  return (
    <div
      className="fixed inset-x-0 z-[55] flex justify-center px-4"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0) + 88px)",
        pointerEvents: "none",
      }}
    >
      <div
        className="ios-sheet pointer-events-auto w-full max-w-md rounded-2xl px-3 py-2.5"
        style={{
          background: "var(--ios-surface-elev)",
          border: "1px solid var(--ios-border-strong)",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04)",
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="flex h-7 w-7 flex-none items-center justify-center rounded-full"
            style={{ background: "var(--ios-accent-soft)", color: "var(--ios-accent)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold leading-tight" style={{ color: "var(--ios-text)" }}>
              Deferred to tomorrow ·{" "}
              <span style={{ color: "var(--ios-text-secondary)" }}>{title}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onUndo}
            className="flex-none rounded-md px-2 py-1 text-[11px] font-semibold"
            style={{
              background: "var(--ios-surface)",
              color: "var(--ios-text)",
              border: "1px solid var(--ios-border-strong)",
            }}
            title="Restore — keep on today's list"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded-md px-1.5 py-1 text-[11px]"
            style={{ color: "var(--ios-text-muted)" }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function CompletedToast({
  title,
  onClose,
  onUndo,
  onSaveNote,
  onAddFollowUp,
}: {
  taskId: string;
  title: string;
  onClose: () => void;
  /** Reverts the tick — most-recent-action undo. Replaces the toast in
   *  user attention before they Note / Follow-up since "I didn't mean to
   *  tick that" is the most common follow-on intent. */
  onUndo: () => void;
  onSaveNote: (note: string) => void;
  onAddFollowUp: (title: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "note" | "followup">("idle");
  const [text, setText] = useState("");

  return (
    <div
      className="fixed inset-x-0 z-[55] flex justify-center px-4"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0) + 88px)",
        pointerEvents: "none",
      }}
    >
      <div
        className="ios-sheet pointer-events-auto w-full max-w-md rounded-2xl px-3 py-2.5"
        style={{
          background: "var(--ios-surface-elev)",
          border: "1px solid var(--ios-border-strong)",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04)",
        }}
      >
        {mode === "idle" && (
          <div className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 flex-none items-center justify-center rounded-full"
              style={{ background: "var(--ios-success)", color: "white" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5L20 7" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold leading-tight" style={{ color: "var(--ios-text)" }}>
                Done · <span style={{ color: "var(--ios-text-secondary)" }}>{title}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onUndo}
              className="flex-none rounded-md px-2 py-1 text-[11px] font-semibold"
              style={{
                background: "var(--ios-surface)",
                color: "var(--ios-text)",
                border: "1px solid var(--ios-border-strong)",
              }}
              title="Untick — restore as open"
            >
              ↶ Undo
            </button>
            <button
              type="button"
              onClick={() => setMode("note")}
              className="flex-none rounded-md px-2 py-1 text-[11px] font-semibold"
              style={{
                background: "var(--ios-surface)",
                color: "var(--ios-text-secondary)",
                border: "1px solid var(--ios-border)",
              }}
            >
              Note
            </button>
            <button
              type="button"
              onClick={() => setMode("followup")}
              className="flex-none rounded-md px-2 py-1 text-[11px] font-semibold"
              style={{
                background: "var(--ios-accent-soft)",
                color: "var(--ios-accent)",
                border: "1px solid rgba(167, 139, 250, 0.4)",
              }}
            >
              + Follow-up
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-none rounded-md px-1.5 py-1 text-[11px]"
              style={{ color: "var(--ios-text-muted)" }}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {mode === "note" && (
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em]" style={{ color: "var(--ios-text-secondary)" }}>
              Add a note
            </div>
            <input
              type="text"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What happened? (optional)"
              className="mb-2 w-full rounded-md px-3 py-2 text-[13px] outline-none"
              style={{
                background: "var(--ios-surface)",
                color: "var(--ios-text)",
                border: "1px solid var(--ios-border)",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveNote(text.trim());
                if (e.key === "Escape") setMode("idle");
              }}
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setMode("idle")}
                className="rounded-md px-2 py-1 text-[11px]"
                style={{ color: "var(--ios-text-secondary)" }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => onSaveNote(text.trim())}
                className="rounded-md px-2 py-1 text-[11px] font-bold"
                style={{
                  background:
                    "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
                  color: "white",
                }}
              >
                Save
              </button>
            </div>
          </div>
        )}

        {mode === "followup" && (
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em]" style={{ color: "var(--ios-accent)" }}>
              Follow-up task
            </div>
            <input
              type="text"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Follow-up to "${title.length > 30 ? title.slice(0, 28) + "…" : title}"`}
              className="mb-2 w-full rounded-md px-3 py-2 text-[13px] outline-none"
              style={{
                background: "var(--ios-surface)",
                color: "var(--ios-text)",
                border: "1px solid var(--ios-border)",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim()) onAddFollowUp(text.trim());
                if (e.key === "Escape") setMode("idle");
              }}
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setMode("idle")}
                className="rounded-md px-2 py-1 text-[11px]"
                style={{ color: "var(--ios-text-secondary)" }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => text.trim() && onAddFollowUp(text.trim())}
                disabled={!text.trim()}
                className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                style={{
                  background:
                    "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
                  color: "white",
                }}
              >
                Create
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DeferSheet({
  item,
  onClose,
  onSnoozeTomorrow,
  onSnoozeUntilDate,
  onRemove,
}: {
  item: DayItem;
  onClose: () => void;
  onSnoozeTomorrow: () => void;
  /** Push the task to a specific weekday picked by the user. ISO is the
   *  resolved date — caller decides whether that's snoozedUntil or
   *  scheduledFor based on task type, mirroring onSnoozeTomorrow. */
  onSnoozeUntilDate: (iso: string) => void;
  onRemove: () => void;
}) {
  const isCalendar = item.source === "calendar";
  const t = item.task;
  const isRecurring = !!(t?.recurrence && t.recurrence !== "none");
  const [showDayPicker, setShowDayPicker] = useState(false);

  // Build the next 7 day options starting tomorrow. Today gets dropped
  // because the user is deferring AWAY from today. Each option resolves
  // to a 09:00 local timestamp (or the working-hours-start if you'd
  // prefer — the parent decides the time of day for now).
  const dayOptions = useMemo(() => {
    const out: Array<{ label: string; iso: string }> = [];
    const base = new Date();
    base.setHours(9, 0, 0, 0);
    for (let i = 1; i <= 7; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      const isTomorrow = i === 1;
      const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
      const dateNum = d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      out.push({
        label: `${isTomorrow ? "Tomorrow" : weekday} · ${dateNum}`,
        iso: d.toISOString(),
      });
    }
    return out;
  }, []);

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
        {!showDayPicker ? (
          <>
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
            {!isCalendar && (
              <SheetButton
                variant="secondary"
                onClick={() => setShowDayPicker(true)}
                title="Defer to a specific day"
                subtitle="Pick Tuesday, Wednesday, … up to a week away"
              />
            )}
            <SheetButton
              variant="secondary"
              onClick={onRemove}
              title={isCalendar ? "Ignore event" : "Ignore task"}
              subtitle={
                isCalendar
                  ? "Hides this event in Focus3. Permanent delete must happen in Google Calendar."
                  : "Hides this task. Permanent delete is on Desktop only."
              }
            />
            <SheetButton variant="cancel" onClick={onClose} title="Cancel" />
          </>
        ) : (
          <>
            <div
              className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: "var(--ios-text-secondary)" }}
            >
              Pick a day
            </div>
            <div className="mb-2 space-y-1.5">
              {dayOptions.map((opt) => (
                <button
                  key={opt.iso}
                  type="button"
                  onClick={() => onSnoozeUntilDate(opt.iso)}
                  className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left"
                  style={{
                    background: "var(--ios-surface-elev)",
                    border: "1px solid var(--ios-border)",
                    color: "var(--ios-text)",
                  }}
                >
                  <span className="text-[14px] font-semibold">{opt.label}</span>
                  <span className="text-[11px]" style={{ color: "var(--ios-text-muted)" }}>
                    9:00
                  </span>
                </button>
              ))}
            </div>
            <SheetButton
              variant="cancel"
              onClick={() => setShowDayPicker(false)}
              title="Back"
            />
          </>
        )}
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
    const nowD = new Date();
    const isFoundationDone = (f: Task) =>
      f.status === "completed" ||
      (f.counter ? f.counter.count >= f.counter.target : false) ||
      wasCompletedToday(f, nowD);
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
      // Empty — a misleading tick used to live here. The tick-in-box at
      // the corner is the real "is it done?" signal; the glyph is
      // category, not state.
      return "";
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
  // Recurring foundations don't keep status:"completed" forever — they
  // reset for the next instance. Use wasCompletedToday so the dim +
  // tick reflects today's truth, not a stale flag.
  const done = isCounter
    ? count >= target
    : foundation.status === "completed"
      ? true
      : wasCompletedToday(foundation, new Date());

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

      {/* Tick-in-box — sits top-right. EMPTY box when pending; filled
          white box with a check when done. The user explicitly asked
          for this exact behaviour: no tick at rest, only when ticked. */}
      <span
        className="pointer-events-none absolute right-2 top-2 z-10 flex h-[16px] w-[16px] items-center justify-center rounded-[3px]"
        style={{
          background: done ? "rgba(255, 255, 255, 0.95)" : "transparent",
          border: done
            ? "1px solid rgba(255, 255, 255, 0.95)"
            : "1px solid rgba(255, 255, 255, 0.40)",
          color: "#0B0E13",
          boxShadow: done ? "0 0 8px rgba(255, 255, 255, 0.45)" : "none",
        }}
        aria-hidden
      >
        {done && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        )}
      </span>

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
  slotCandidates,
  onAdjust,
  onAutoReschedule,
  autoOutcome,
  onPushUnplaced,
  onDismissAutoOutcome,
  onComplete,
  onReschedule,
  onExtendDuration,
  onDefer,
  onSlotIntoGap,
  onDeferCandidate,
}: {
  items: DayItem[];
  unscheduled: UnscheduledItem[];
  isToday: boolean;
  calendarConnected: boolean;
  /** Top-3 tasks the user might slot into open gaps. */
  slotCandidates: Task[];
  onAdjust: (item: DayItem, deltaMin: number) => void;
  onAutoReschedule: () => void;
  /** Most-recent Auto-Schedule outcome — drives the feedback banner so
   *  users know what got placed and what couldn't fit. */
  autoOutcome:
    | {
        placed: number;
        unplaced: Array<{ taskId: string; title: string; reason: string }>;
      }
    | null;
  /** Push an unplaced task forward by N days. Used by the banner's
   *  "Push to tomorrow / next week" actions. */
  onPushUnplaced: (taskId: string, days: number) => void;
  onDismissAutoOutcome: () => void;
  onComplete: (taskId: string) => void;
  onReschedule: (item: DayItem) => void;
  onExtendDuration: (item: DayItem, deltaMin: number) => void;
  onDefer: (item: DayItem) => void;
  /** Place this candidate task at startIso. */
  onSlotIntoGap: (taskId: string, startIso: string) => void;
  /** Defer this candidate task to tomorrow. */
  onDeferCandidate: (taskId: string) => void;
}) {
  const groups = useMemo(() => groupConcurrent(items), [items]);

  // Slot top-3 candidates into open gaps between groups. Walk the gaps in
  // chronological order; if a gap is 30-180 min and we still have a
  // candidate to place, attach it to that gap. Each candidate appears
  // exactly once.
  const gapSlots = useMemo(() => {
    const out = new Map<number, Task>();
    let ci = 0;
    for (let i = 0; i < groups.length - 1; i++) {
      if (ci >= slotCandidates.length) break;
      const gapMin =
        (groups[i + 1].start.getTime() - groups[i].end.getTime()) / 60_000;
      if (gapMin >= 30 && gapMin <= 180) {
        out.set(i, slotCandidates[ci]);
        ci += 1;
      }
    }
    return out;
  }, [groups, slotCandidates]);

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
        {/* Auto-schedule — ALWAYS visible on today so it's discoverable.
            Disabled state when nothing actually needs slotting / nudging
            so the button shows but doesn't fire a no-op. */}
        {isToday && (
          <button
            type="button"
            onClick={onAutoReschedule}
            disabled={unscheduled.length === 0 && overdue === 0}
            className="absolute right-0 top-0 rounded-md px-3 py-1.5 text-[11px] font-bold disabled:cursor-not-allowed"
            style={{
              background:
                unscheduled.length === 0 && overdue === 0
                  ? "var(--ios-surface-elev)"
                  : "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
              color:
                unscheduled.length === 0 && overdue === 0
                  ? "var(--ios-text-muted)"
                  : "white",
              border:
                unscheduled.length === 0 && overdue === 0
                  ? "1px solid var(--ios-border)"
                  : "none",
              opacity: unscheduled.length === 0 && overdue === 0 ? 0.7 : 1,
            }}
            title={
              unscheduled.length === 0 && overdue === 0
                ? "Nothing to slot — add a task without a time, or mark something done first"
                : "Slot pending tasks into open gaps"
            }
          >
            Auto-schedule
          </button>
        )}
      </div>

      {autoOutcome && (
        <div
          className="mt-3 rounded-xl p-2.5"
          style={{
            background:
              autoOutcome.unplaced.length === 0
                ? "rgba(16, 185, 129, 0.10)"
                : "rgba(245, 158, 11, 0.10)",
            border:
              autoOutcome.unplaced.length === 0
                ? "1px solid rgba(16, 185, 129, 0.28)"
                : "1px solid rgba(245, 158, 11, 0.28)",
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div
                className="text-[12px] font-bold"
                style={{
                  color:
                    autoOutcome.unplaced.length === 0
                      ? "var(--ios-success)"
                      : "var(--ios-warning)",
                }}
              >
                {autoOutcome.placed > 0
                  ? `Placed ${autoOutcome.placed} task${autoOutcome.placed === 1 ? "" : "s"}`
                  : autoOutcome.unplaced.length > 0
                    ? "Couldn't slot anything today"
                    : "Nothing to slot"}
                {autoOutcome.unplaced.length > 0
                  ? ` · ${autoOutcome.unplaced.length} didn't fit`
                  : ""}
              </div>
              {autoOutcome.unplaced.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {autoOutcome.unplaced.map((u) => (
                    <li
                      key={u.taskId}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1"
                      style={{
                        background: "var(--ios-surface)",
                        border: "1px solid var(--ios-border)",
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div
                          className="truncate text-[12px] font-medium"
                          style={{ color: "var(--ios-text)" }}
                        >
                          {u.title}
                        </div>
                        <div
                          className="text-[10px]"
                          style={{ color: "var(--ios-text-muted)" }}
                        >
                          {u.reason}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onPushUnplaced(u.taskId, 1)}
                        className="flex-none rounded-md px-2 py-0.5 text-[10px] font-semibold"
                        style={{
                          background: "var(--ios-accent-soft)",
                          color: "var(--ios-accent)",
                          border: "1px solid rgba(167, 139, 250, 0.4)",
                        }}
                      >
                        → Tomorrow
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              onClick={onDismissAutoOutcome}
              className="flex-none text-[11px]"
              style={{ color: "var(--ios-text-muted)" }}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

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
                      <>
                        <RiverConnector
                          from={group.end}
                          to={groups[idx + 1].start}
                        />
                        {gapSlots.has(idx) && (
                          <SlotSuggestion
                            task={gapSlots.get(idx)!}
                            suggestedStart={snapTo15Forward(group.end)}
                            onSlot={(taskId, iso) => onSlotIntoGap(taskId, iso)}
                            onDefer={(taskId) => onDeferCandidate(taskId)}
                          />
                        )}
                      </>
                    )}
                    {showNowAfter && nowDate && idx === groups.length - 1 && (
                      <NowBeam now={nowDate} ref={nowRef} />
                    )}
                  </Fragment>
                );
              })}
              {/* End-of-day annotation, bottom-right. Shows when the last
                  scheduled item finishes so the user knows where their
                  day "lands". */}
              {groups.length > 0 && (
                <div
                  className="mt-3 flex items-center justify-end pr-1 text-[11px]"
                  style={{ color: "var(--ios-text-muted)" }}
                >
                  <span>
                    Day ends · <span style={{ color: "var(--ios-text-secondary)" }}>{fmtTime(groups[groups.length - 1].end)}</span>
                  </span>
                </div>
              )}
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
  onDefer,
  onSchedule,
}: {
  tasks: Task[];
  foundations: Task[];
  prefs: UserPrefs;
  calendarConnected: boolean;
  /** Push the task to the day after tomorrow (or further). */
  onDefer: (taskId: string) => void;
  /** Open the schedule picker for this task. */
  onSchedule: (taskId: string) => void;
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
      {/* Same weight + tracking as the "Focus" header on the day plan
          so this section reads as the natural continuation, not a
          subtitle. */}
      <h2
        className="mb-2 text-center text-[22px] font-bold tracking-tight"
        style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}
      >
        Plan
      </h2>
      <p
        className="mb-2 text-center text-[12px]"
        style={{ color: "var(--ios-text-secondary)" }}
      >
        Tomorrow's first three. Defer or schedule from here.
      </p>
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
            className="flex items-center justify-between gap-2 py-1.5"
            style={{
              borderTop: i === 0 ? undefined : "1px solid var(--ios-border)",
            }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="flex-none text-[11px] font-bold tabular-nums"
                style={{ color: "var(--ios-text-secondary)" }}
              >
                {fmtTime(item.start)}
              </span>
              <span
                className="truncate text-[12px]"
                style={{ color: "var(--ios-text)" }}
              >
                {item.title}
              </span>
              {item.fixed && (
                <span
                  className="flex-none text-[9px]"
                  style={{ color: "var(--ios-text-muted)" }}
                >
                  fixed
                </span>
              )}
            </div>
            {!item.fixed && item.task && (
              <div className="flex flex-none items-center gap-1">
                <button
                  type="button"
                  onClick={() => onDefer(item.task!.id)}
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: "rgba(245, 158, 11, 0.18)",
                    color: "var(--ios-warning)",
                    border: "1px solid rgba(245, 158, 11, 0.32)",
                  }}
                  title="Defer further"
                >
                  Defer
                </button>
                <button
                  type="button"
                  onClick={() => onSchedule(item.task!.id)}
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: "var(--ios-accent-soft)",
                    color: "var(--ios-accent)",
                    border: "1px solid rgba(167, 139, 250, 0.32)",
                  }}
                  title="Schedule a time"
                >
                  Schedule
                </button>
              </div>
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
/** Snap forward to the next 15-min boundary. Used when slotting a top-3
 *  candidate into an open gap so it lands on a clean quarter-hour. */
function snapTo15Forward(d: Date): Date {
  const out = new Date(d);
  const min = out.getMinutes();
  const snapped = Math.ceil(min / 15) * 15;
  out.setMinutes(snapped, 0, 0);
  return out;
}

/** Inline gap-slot suggestion. Renders inside an empty stretch on the day
 *  river: "Slot [Task] at HH:MM" with Slot + Defer actions. Tap Slot to
 *  schedule it; tap Defer to push it to tomorrow. */
function SlotSuggestion({
  task,
  suggestedStart,
  onSlot,
  onDefer,
}: {
  task: Task;
  suggestedStart: Date;
  onSlot: (taskId: string, iso: string) => void;
  onDefer: (taskId: string) => void;
}) {
  return (
    <div
      className="my-2 mx-1 flex items-center gap-2 rounded-xl px-3 py-2"
      style={{
        background:
          "linear-gradient(135deg, rgba(167,139,250,0.10), rgba(167,139,250,0.04))",
        border: "1px dashed rgba(167, 139, 250, 0.45)",
      }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="text-[10px] font-bold uppercase tracking-[0.08em]"
          style={{ color: "var(--ios-accent)" }}
        >
          Top three · slot here?
        </div>
        <div
          className="mt-0.5 truncate text-[13px] font-bold"
          style={{ color: "var(--ios-text)" }}
        >
          {task.title}
        </div>
        <div className="text-[10px]" style={{ color: "var(--ios-text-secondary)" }}>
          would land at {fmtTime(suggestedStart)}
        </div>
      </div>
      <div className="flex flex-none items-center gap-1">
        <button
          type="button"
          onClick={() => onDefer(task.id)}
          className="rounded-md px-2 py-1 text-[10px] font-bold"
          style={{
            background: "rgba(245, 158, 11, 0.18)",
            color: "var(--ios-warning)",
            border: "1px solid rgba(245, 158, 11, 0.32)",
          }}
        >
          Defer
        </button>
        <button
          type="button"
          onClick={() => onSlot(task.id, suggestedStart.toISOString())}
          className="rounded-md px-2 py-1 text-[10px] font-bold"
          style={{
            background:
              "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
            color: "white",
          }}
        >
          Slot it
        </button>
      </div>
    </div>
  );
}

function RiverConnector({ from, to }: { from: Date; to: Date }) {
  const gapMin = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  const big = gapMin >= 120;
  // Every gap gets a label now — even tight 5-minute ones — so the
  // user can see exactly how much breathing room sits between items.
  const label =
    gapMin >= 60
      ? `${Math.round(gapMin / 60)}h gap`
      : gapMin > 0
        ? `${gapMin}m gap`
        : null;
  return (
    <div
      className="relative flex items-center justify-center"
      style={{ height: big ? 28 : 20 }}
    >
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

/**
 * Vertical shift track — Design C from the picker.
 *
 * Sits down the side opposite the centre spine. Top half is "earlier",
 * bottom half is "later" — tap once for ±15, hold for ±60. The
 * direction of movement matches the spatial intuition of the timeline:
 * tap up to push the card up (earlier), tap down to push it down
 * (later in the day).
 *
 * Long-press detection: pointerdown starts a 400ms timer that fires
 * the ±60 shift; pointerup before the timer fires the ±15 shift; if
 * the user drags off the button (pointerleave) we cancel without
 * firing anything.
 */
function ShiftTrack({
  side,
  onShift,
}: {
  side: "left" | "right";
  onShift: (deltaMin: number) => void;
}) {
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedLongRef = useRef(false);

  // Drag-handle state — refs (not state) to avoid re-binding handlers and
  // breaking pointer capture. Each pointer move computes a snapped 15-min
  // delta and only fires onShift when crossing a new boundary, so the
  // cascade engine sees discrete jumps rather than per-pixel noise.
  const dragStartYRef = useRef(0);
  const dragLastDelta15Ref = useRef(0);
  const draggingRef = useRef(false);
  const [dragHover, setDragHover] = useState(false);

  function bind(deltaShort: number, deltaLong: number) {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        e.stopPropagation();
        firedLongRef.current = false;
        longPressRef.current = setTimeout(() => {
          firedLongRef.current = true;
          onShift(deltaLong);
          longPressRef.current = null;
        }, 400);
      },
      onPointerUp: (e: React.PointerEvent) => {
        e.stopPropagation();
        if (longPressRef.current) {
          clearTimeout(longPressRef.current);
          longPressRef.current = null;
          if (!firedLongRef.current) onShift(deltaShort);
        }
      },
      onPointerLeave: () => {
        if (longPressRef.current) {
          clearTimeout(longPressRef.current);
          longPressRef.current = null;
        }
      },
      onPointerCancel: () => {
        if (longPressRef.current) {
          clearTimeout(longPressRef.current);
          longPressRef.current = null;
        }
      },
    };
  }

  // 1 pixel ≈ 0.5 minute → ~30px to cross one 15-min boundary. Comfortable
  // drag distance on phone + desktop without being twitchy.
  const PX_PER_MIN = 0.5;

  const dragBindings = {
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers throw if capture fails — we just lose precision,
        // not behaviour.
      }
      dragStartYRef.current = e.clientY;
      dragLastDelta15Ref.current = 0;
      draggingRef.current = true;
      setDragHover(true);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const deltaPx = e.clientY - dragStartYRef.current;
      const deltaMin = deltaPx * PX_PER_MIN;
      const delta15 = Math.round(deltaMin / 15) * 15;
      if (delta15 !== dragLastDelta15Ref.current) {
        const stepDelta = delta15 - dragLastDelta15Ref.current;
        onShift(stepDelta);
        dragLastDelta15Ref.current = delta15;
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      draggingRef.current = false;
      setDragHover(false);
    },
    onPointerCancel: () => {
      draggingRef.current = false;
      setDragHover(false);
    },
  };

  return (
    <div
      className="pointer-events-none absolute bottom-3 top-1.5 flex flex-col"
      style={{
        [side]: 2,
        width: 18,
      }}
    >
      <button
        type="button"
        {...bind(-15, -60)}
        className="pointer-events-auto flex flex-1 items-start justify-center pt-0.5"
        style={{
          color: "var(--ios-text-secondary)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.0))",
          borderRadius: "6px 6px 0 0",
        }}
        aria-label="Earlier — tap −15, hold for −60"
        title="Earlier · tap −15 · hold −60"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 15l6-6 6 6" />
        </svg>
      </button>
      {/* Drag handle — center grab zone. Press + drag up/down to slide
          the item earlier / later, snapped to 15-min boundaries. Distinct
          from the tap-target arrows so they don't fire while dragging. */}
      <div
        {...dragBindings}
        className="pointer-events-auto flex h-[18px] cursor-grab items-center justify-center active:cursor-grabbing"
        style={{
          color: dragHover ? "var(--ios-text)" : "var(--ios-text-muted)",
          background: dragHover
            ? "rgba(255, 255, 255, 0.12)"
            : "rgba(255, 255, 255, 0.04)",
          touchAction: "none",
        }}
        aria-label="Drag to move (snaps to 15 min)"
        title="Drag up = earlier · drag down = later"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.4" />
          <circle cx="15" cy="6" r="1.4" />
          <circle cx="9" cy="12" r="1.4" />
          <circle cx="15" cy="12" r="1.4" />
          <circle cx="9" cy="18" r="1.4" />
          <circle cx="15" cy="18" r="1.4" />
        </svg>
      </div>
      <button
        type="button"
        {...bind(15, 60)}
        className="pointer-events-auto flex flex-1 items-end justify-center pb-0.5"
        style={{
          color: "var(--ios-text-secondary)",
          background:
            "linear-gradient(0deg, rgba(255,255,255,0.06), rgba(255,255,255,0.0))",
          borderRadius: "0 0 6px 6px",
        }}
        aria-label="Later — tap +15, hold for +60"
        title="Later · tap +15 · hold +60"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
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
  // Vertical shift track sits OPPOSITE the centre spine so it doesn't
  // crowd the timeline. Left-of-spine cards (align=right) get a track
  // on the LEFT edge; right-of-spine cards (align=left) on the RIGHT.
  // Centred / fixed cards default to the right edge.
  const trackSide: "left" | "right" = align === "right" ? "left" : "right";

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
        // Side padding leaves room for the vertical shift track.
        paddingLeft: showShiftControls && trackSide === "left" ? 20 : 0,
        paddingRight: showShiftControls && trackSide === "right" ? 20 : 0,
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
            {item.source === "calendar" && item.event && (() => {
              // Pull the venue phone (📞 +44 …) out of the description if
              // the location-enrichment writer added it. Falls back to
              // null when no recognisable phone is in the text.
              const phone = extractVenuePhone(item.event.description);
              return (
                <>
                  {phone && (
                    <a
                      href={`tel:${phone.replace(/\s+/g, "")}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[4px]"
                      style={{
                        background: "rgba(16, 185, 129, 0.18)",
                        border: "1px solid rgba(16, 185, 129, 0.45)",
                        color: "var(--ios-success)",
                      }}
                      title={`Call venue · ${phone}`}
                      aria-label={`Call venue at ${phone}`}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
                      </svg>
                    </a>
                  )}
                  {item.event.htmlLink && (
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
                </>
              );
            })()}
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
      </div>

      {/* Vertical shift track — design C. Top half = move start earlier
          (card visually rises on the timeline). Bottom half = move
          later (card drops). Tap = ±15, hold ≥400ms = ±60. Sits on
          the side opposite the centre spine. */}
      {showShiftControls && (
        <ShiftTrack side={trackSide} onShift={onAdjust} />
      )}

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

/**
 * Extract a venue phone number from an event description. Looks for the
 * 📞 prefix the location-enrichment writer adds, then falls back to a
 * generic E.164 / international pattern. Returns null when nothing
 * recognisable is found.
 */
function extractVenuePhone(description: string | null | undefined): string | null {
  if (!description) return null;
  // Preferred — phone explicitly tagged with the 📞 emoji we wrote
  const tagged = /📞\s*(\+?[\d\s().-]{6,})/.exec(description);
  if (tagged) return tagged[1].trim();
  // Fallback — first plausible international/long phone number in the text
  const generic = /(\+\d[\d\s().-]{6,}\d)/.exec(description);
  return generic ? generic[1].trim() : null;
}

function sameYearMonthDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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
