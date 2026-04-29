import { useEffect, useRef, useState } from "react";
import type { Goal, Task, UserPrefs } from "@/types/task";
import type { PrioritizedTask } from "@/types/task";
import { TopThree } from "@/components/TopThree";
import { TaskList } from "@/components/TaskList";
import { Goals } from "@/components/Goals";
import { PriorityMatrix } from "@/components/PriorityMatrix";
import { Foundations } from "@/components/Foundations";

type Tab = "today" | "tasks" | "insights" | "goals";

interface IosShellProps {
  // Data
  tasks: Task[];
  goals: Goal[];
  prefs: UserPrefs;
  prioritized: PrioritizedTask[];
  foundations: Task[];
  aiTierMap?: Map<string, 1 | 2 | 3 | 4>;
  // Task lifecycle
  onComplete: (id: string) => void;
  onToggleTask: (id: string) => void;
  onRemoveTask: (id: string) => void;
  onEditTask: (id: string) => void;
  onSchedule: (id: string) => void;
  onUnsnooze: (id: string) => void;
  onSnooze: (id: string, untilIso: string) => void;
  onIncrementCounter: (id: string, delta: number) => void;
  onDeferFoundation: (id: string) => void;
  // Goal lifecycle
  onAddGoal: (input: Omit<Goal, "id" | "createdAt" | "updatedAt" | "source">) => void;
  onUpdateGoal: (id: string, patch: Partial<Goal>) => void;
  onRemoveGoal: (id: string) => void;
  // FAB actions
  onAddTask: () => void;
  onBrainDump: () => void;
  // Misc
  taskCountByGoal: Map<string, number>;
  goalProgress: Map<string, { doneLast30: number; lastActivityIso?: string }>;
  calendarConnected: boolean;
  onRefreshAi: () => void;
  aiBusy: boolean;
  aiRefreshTick: number;
  /** Switch back to the desktop layout. */
  onExitIosLayout: () => void;
}

/**
 * iOS-style shell. Inspired by neobank apps (Starling / Revolut) — bold
 * large titles, generous whitespace, vibrant accent gradient, frosted-glass
 * surfaces, big tactile FAB, smooth tab transitions.
 *
 * The colour palette is deliberately scoped here (not in app-wide CSS) so
 * the desktop layout stays untouched. Accent: violet → fuchsia gradient.
 * Surface: warm off-white. Text: near-black. Cards: white with soft
 * shadow.
 */
export function IosShell(props: IosShellProps) {
  const [tab, setTab] = useState<Tab>("today");
  const [fabOpen, setFabOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Track scroll past 24px to flip the header into compact mode (smaller
  // title, frosted background, subtle shadow). Same trick iOS uses to
  // collapse navigation titles into the top bar.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => setScrolled(el.scrollTop > 24);
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);

  return (
    <div
      className="ios-root flex h-screen flex-col"
      // Scoped CSS variables so this palette doesn't leak to the desktop
      // layout. All `accent` references below resolve through these.
      style={{
        // @ts-expect-error - CSS custom props
        "--ios-bg": "#F4F4F7",
        "--ios-surface": "#FFFFFF",
        "--ios-surface-elev": "#FFFFFF",
        "--ios-text": "#0B0E11",
        "--ios-text-secondary": "#6B7280",
        "--ios-border": "rgba(0, 0, 0, 0.08)",
        "--ios-accent": "#7B3FE4",
        "--ios-accent-soft": "#F3EAFF",
        "--ios-accent-grad-from": "#9333EA",
        "--ios-accent-grad-to": "#EC4899",
        background: "var(--ios-bg)",
        color: "var(--ios-text)",
      }}
    >
      {/* Header — large iOS-style title that compresses on scroll. */}
      <header
        className="sticky top-0 z-20 transition-all duration-200"
        style={{
          paddingTop: "max(env(safe-area-inset-top, 0), 8px)",
          background: scrolled
            ? "rgba(244, 244, 247, 0.85)"
            : "var(--ios-bg)",
          backdropFilter: scrolled ? "saturate(180%) blur(20px)" : "none",
          WebkitBackdropFilter: scrolled ? "saturate(180%) blur(20px)" : "none",
          boxShadow: scrolled
            ? "0 1px 0 rgba(0,0,0,0.04)"
            : "none",
        }}
      >
        <div
          className="flex items-end justify-between gap-3 px-5 pb-3 pt-2 transition-all"
          style={{
            paddingTop: scrolled ? "8px" : "12px",
          }}
        >
          <div className="min-w-0 flex-1">
            <h1
              className="font-bold tracking-tight transition-all"
              style={{
                fontSize: scrolled ? "17px" : "32px",
                lineHeight: scrolled ? "22px" : "38px",
                fontWeight: scrolled ? 600 : 700,
              }}
            >
              {TAB_TITLES[tab]}
            </h1>
            {!scrolled && (
              <p
                className="mt-0.5 text-sm"
                style={{ color: "var(--ios-text-secondary)" }}
              >
                {TAB_SUBTITLES[tab]}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={props.onExitIosLayout}
            className="-mr-1 inline-flex h-8 items-center rounded-full px-3 text-[12px] font-medium transition-colors"
            style={{
              color: "var(--ios-accent)",
              background: "var(--ios-accent-soft)",
            }}
          >
            Desktop ›
          </button>
        </div>
      </header>

      {/* Content — scrollable, padding-bottom reserves space for the
          tab bar so nothing slides under it. */}
      <main
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 pt-2"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0) + 96px)" }}
      >
        <div
          key={tab}
          className="ios-fade-in space-y-4"
        >
          {tab === "today" && (
            <>
              {props.foundations.length > 0 && (
                <IosCard padding="tight">
                  <Foundations
                    tasks={props.foundations}
                    onComplete={props.onComplete}
                    onIncrement={props.onIncrementCounter}
                    onEdit={props.onEditTask}
                    onDefer={props.onDeferFoundation}
                  />
                </IosCard>
              )}
              {props.prioritized.length > 0 ? (
                <TopThree
                  prioritized={props.prioritized}
                  goals={props.goals}
                  calendarConnected={props.calendarConnected}
                  onComplete={props.onComplete}
                  onSchedule={props.onSchedule}
                  onSnooze={props.onSnooze}
                  onOpenGoal={() => setTab("goals")}
                />
              ) : (
                <IosCard>
                  <p className="text-base font-semibold text-slate-900">
                    Nothing surfaced yet
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Tap the + button below — Focus3 will rank what you add.
                  </p>
                </IosCard>
              )}
            </>
          )}

          {tab === "tasks" && (
            <IosCard padding="tight">
              <TaskList
                tasks={props.tasks}
                onToggle={props.onToggleTask}
                onRemove={props.onRemoveTask}
                onEdit={props.onEditTask}
                onUnsnooze={props.onUnsnooze}
                onSchedule={props.onSchedule}
                aiTierById={props.aiTierMap}
                mode={props.prefs.mode}
                userType={props.prefs.userType}
                ignoredEventIds={props.prefs.ignoredEventIds}
                onRefreshAi={props.onRefreshAi}
                aiBusy={props.aiBusy}
                aiRefreshTick={props.aiRefreshTick}
              />
            </IosCard>
          )}

          {tab === "insights" && (
            <IosCard>
              <PriorityMatrix
                tasks={props.tasks}
                prefs={props.prefs}
                onEdit={props.onEditTask}
                compact
              />
            </IosCard>
          )}

          {tab === "goals" && (
            <IosCard>
              <Goals
                goals={props.goals}
                tasks={props.tasks}
                taskCountByGoal={props.taskCountByGoal}
                progressByGoal={props.goalProgress}
                onAdd={props.onAddGoal}
                onUpdate={props.onUpdateGoal}
                onRemove={props.onRemoveGoal}
                onAddTaskForGoal={() => props.onAddTask()}
                compact
              />
            </IosCard>
          )}
        </div>
      </main>

      {/* Tab bar — frosted glass, sits above content. Centre cell holds
          the FAB which floats above the bar. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t"
        style={{
          paddingBottom: "env(safe-area-inset-bottom, 0)",
          background: "rgba(255, 255, 255, 0.85)",
          backdropFilter: "saturate(180%) blur(20px)",
          WebkitBackdropFilter: "saturate(180%) blur(20px)",
          borderColor: "var(--ios-border)",
        }}
      >
        <div className="mx-auto grid max-w-md grid-cols-5 items-end px-2">
          <TabButton
            label="Today"
            icon={IconToday}
            active={tab === "today"}
            onClick={() => setTab("today")}
          />
          <TabButton
            label="Tasks"
            icon={IconTasks}
            active={tab === "tasks"}
            onClick={() => setTab("tasks")}
          />

          {/* FAB — vivid gradient, sits up out of the bar */}
          <div className="relative -mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setFabOpen((v) => !v)}
              className="ios-fab flex h-14 w-14 items-center justify-center rounded-full text-white transition-transform active:scale-90"
              style={{
                background:
                  "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
                boxShadow:
                  "0 10px 24px -6px rgba(147, 51, 234, 0.55), 0 4px 8px -2px rgba(236, 72, 153, 0.4)",
              }}
              aria-label="Add"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>

          <TabButton
            label="Insights"
            icon={IconInsights}
            active={tab === "insights"}
            onClick={() => setTab("insights")}
          />
          <TabButton
            label="Goals"
            icon={IconGoals}
            active={tab === "goals"}
            onClick={() => setTab("goals")}
          />
        </div>
      </nav>

      {/* Action sheet (slides up from the bottom) */}
      {fabOpen && (
        <div
          className="ios-sheet-backdrop fixed inset-0 z-40 flex items-end"
          onClick={() => setFabOpen(false)}
          style={{ background: "rgba(15, 23, 42, 0.45)" }}
        >
          <div
            className="ios-sheet w-full"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--ios-surface)",
              borderTopLeftRadius: "20px",
              borderTopRightRadius: "20px",
              padding: "12px 16px calc(env(safe-area-inset-bottom, 0) + 16px)",
              boxShadow: "0 -8px 32px rgba(0,0,0,0.18)",
            }}
          >
            <div
              className="mx-auto mb-3 h-1 w-10 rounded-full"
              style={{ background: "var(--ios-border)" }}
            />
            <SheetButton
              variant="primary"
              onClick={() => {
                setFabOpen(false);
                props.onAddTask();
              }}
            >
              <span className="text-base font-semibold">Add a task</span>
              <span
                className="text-xs"
                style={{ color: "rgba(255,255,255,0.7)" }}
              >
                Title, theme, due date
              </span>
            </SheetButton>
            <SheetButton
              variant="secondary"
              onClick={() => {
                setFabOpen(false);
                props.onBrainDump();
              }}
            >
              <span className="text-base font-semibold">✨ Brain dump</span>
              <span
                className="text-xs"
                style={{ color: "var(--ios-text-secondary)" }}
              >
                Paste a list — Claude infers the rest
              </span>
            </SheetButton>
            <SheetButton
              variant="cancel"
              onClick={() => setFabOpen(false)}
            >
              Cancel
            </SheetButton>
          </div>
        </div>
      )}

      {/* Component-scoped CSS — keeps animations + iOS specifics out of
          the global stylesheet. */}
      <style>{`
        .ios-root .ios-fade-in {
          animation: ios-fade-in 200ms cubic-bezier(0.32, 0.72, 0, 1);
        }
        @keyframes ios-fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .ios-root .ios-sheet {
          animation: ios-sheet-up 280ms cubic-bezier(0.32, 0.72, 0, 1);
        }
        @keyframes ios-sheet-up {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }
        .ios-root .ios-sheet-backdrop {
          animation: ios-fade 200ms cubic-bezier(0.32, 0.72, 0, 1);
        }
        @keyframes ios-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .ios-root .ios-fab {
          transition: transform 120ms cubic-bezier(0.32, 0.72, 0, 1);
        }
      `}</style>
    </div>
  );
}

const TAB_TITLES: Record<Tab, string> = {
  today: "Today",
  tasks: "All tasks",
  insights: "Insights",
  goals: "Goals",
};

const TAB_SUBTITLES: Record<Tab, string> = {
  today: "Your three things, plus the foundations.",
  tasks: "Everything in your queue.",
  insights: "Where your time is going.",
  goals: "What it all ladders up to.",
};

function IosCard({
  children,
  padding = "default",
}: {
  children: React.ReactNode;
  padding?: "default" | "tight";
}) {
  return (
    <div
      style={{
        background: "var(--ios-surface)",
        borderRadius: "20px",
        padding: padding === "tight" ? "12px" : "20px",
        boxShadow:
          "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -12px rgba(0,0,0,0.08)",
      }}
    >
      {children}
    </div>
  );
}

function TabButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: () => React.JSX.Element;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 px-1 pb-2 pt-2 transition-all active:scale-95"
      style={{
        color: active ? "var(--ios-accent)" : "var(--ios-text-secondary)",
      }}
    >
      <Icon />
      <span
        className="text-[10px] tracking-tight"
        style={{ fontWeight: active ? 600 : 500 }}
      >
        {label}
      </span>
    </button>
  );
}

function SheetButton({
  children,
  onClick,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "secondary" | "cancel";
}) {
  const styles =
    variant === "primary"
      ? {
          background:
            "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
          color: "white",
          boxShadow:
            "0 6px 16px -4px rgba(147, 51, 234, 0.4)",
        }
      : variant === "secondary"
        ? {
            background: "var(--ios-bg)",
            color: "var(--ios-text)",
          }
        : {
            background: "var(--ios-bg)",
            color: "var(--ios-text-secondary)",
          };
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 flex w-full flex-col items-center gap-0.5 rounded-2xl px-4 py-3 text-center transition-transform active:scale-[0.98]"
      style={styles}
    >
      {children}
    </button>
  );
}

function IconToday() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <circle cx="12" cy="15" r="1.5" fill="currentColor" />
    </svg>
  );
}
function IconTasks() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1.2" fill="currentColor" />
    </svg>
  );
}
function IconInsights() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19V5M4 19h16" />
      <path d="M8 14v3M12 9v8M16 12v5" />
    </svg>
  );
}
function IconGoals() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
