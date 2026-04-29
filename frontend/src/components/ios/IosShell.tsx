import { useState } from "react";
import type { Goal, Task, UserPrefs } from "@/types/task";
import type { PrioritizedTask } from "@/types/task";
import { TopThree } from "@/components/TopThree";
import { TaskList } from "@/components/TaskList";
import { Goals } from "@/components/Goals";
import { PriorityMatrix } from "@/components/PriorityMatrix";
import { Foundations } from "@/components/Foundations";

type Tab = "today" | "tasks" | "insights" | "goals";

interface IosShellProps {
  // ── Data ───────────────────────────────────────────────────────────
  tasks: Task[];
  goals: Goal[];
  prefs: UserPrefs;
  prioritized: PrioritizedTask[];
  foundations: Task[];
  aiTierMap?: Map<string, 1 | 2 | 3 | 4>;
  // ── Task lifecycle ─────────────────────────────────────────────────
  onComplete: (id: string) => void;
  onToggleTask: (id: string) => void;
  onRemoveTask: (id: string) => void;
  onEditTask: (id: string) => void;
  onSchedule: (id: string) => void;
  onUnsnooze: (id: string) => void;
  onSnooze: (id: string, untilIso: string) => void;
  onIncrementCounter: (id: string, delta: number) => void;
  onDeferFoundation: (id: string) => void;
  // ── Goal lifecycle ─────────────────────────────────────────────────
  onAddGoal: (input: Omit<Goal, "id" | "createdAt" | "updatedAt" | "source">) => void;
  onUpdateGoal: (id: string, patch: Partial<Goal>) => void;
  onRemoveGoal: (id: string) => void;
  // ── Quick-add affordances triggered by the FAB ─────────────────────
  onAddTask: () => void;
  onBrainDump: () => void;
  // ── Misc ───────────────────────────────────────────────────────────
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
 * iPhone-suitable layout — bottom tab bar, scrollable content area,
 * central + FAB. The data hooks + backend are unchanged; this component
 * just composes existing primitives (TopThree, TaskList, Goals, etc.) in
 * a layout designed for one-thumb use on a small screen.
 *
 * Opt-in via prefs.iosLayout. Auto-applied when running inside the
 * Capacitor native shell.
 */
export function IosShell(props: IosShellProps) {
  const [tab, setTab] = useState<Tab>("today");
  const [fabOpen, setFabOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* Header — simple iOS-style title bar with safe-area top padding
          inherited from body padding-top: env(safe-area-inset-top). */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">
            {TAB_TITLES[tab]}
          </h1>
          <button
            type="button"
            onClick={props.onExitIosLayout}
            className="text-xs text-slate-500 hover:text-slate-900"
            title="Switch back to the desktop layout"
          >
            Desktop ›
          </button>
        </div>
      </header>

      {/* Content — scrollable, padding-bottom reserves space for the
          tab bar so nothing slides under it. */}
      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-3">
        {tab === "today" && (
          <div className="space-y-4">
            <Foundations
              tasks={props.foundations}
              onComplete={props.onComplete}
              onIncrement={props.onIncrementCounter}
              onEdit={props.onEditTask}
              onDefer={props.onDeferFoundation}
            />
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
              <EmptyState
                title="Nothing surfaced yet"
                body="Add a task with the + button below — Focus3 will rank it for you."
              />
            )}
          </div>
        )}

        {tab === "tasks" && (
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
        )}

        {tab === "insights" && (
          <PriorityMatrix
            tasks={props.tasks}
            prefs={props.prefs}
            onEdit={props.onEditTask}
          />
        )}

        {tab === "goals" && (
          <Goals
            goals={props.goals}
            tasks={props.tasks}
            taskCountByGoal={props.taskCountByGoal}
            progressByGoal={props.goalProgress}
            onAdd={props.onAddGoal}
            onUpdate={props.onUpdateGoal}
            onRemove={props.onRemoveGoal}
            onAddTaskForGoal={() => props.onAddTask()}
          />
        )}
      </main>

      {/* Tab bar — fixed at the bottom, safe-area aware. Centre slot is
          empty; the FAB sits over it. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0)" }}
      >
        <div className="mx-auto grid max-w-md grid-cols-5 items-end">
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
          {/* Centre: FAB. Pushes up out of the tab bar. */}
          <div className="relative -translate-y-3 flex justify-center">
            <button
              type="button"
              onClick={() => setFabOpen((v) => !v)}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-slate-800 to-slate-950 text-white shadow-lg shadow-slate-900/30 transition-transform active:scale-95"
              aria-label="Add"
            >
              <span className="text-2xl leading-none">＋</span>
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

      {/* Action sheet that slides up when the FAB is tapped. Two
          options for now (Add task, Brain dump). Tap-outside dismisses. */}
      {fabOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-slate-900/40"
          onClick={() => setFabOpen(false)}
        >
          <div
            className="w-full rounded-t-2xl bg-white p-4 shadow-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0) + 16px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
            <button
              type="button"
              onClick={() => {
                setFabOpen(false);
                props.onAddTask();
              }}
              className="block w-full rounded-xl bg-slate-900 px-4 py-3 text-center text-sm font-medium text-white"
            >
              + Add a task
            </button>
            <button
              type="button"
              onClick={() => {
                setFabOpen(false);
                props.onBrainDump();
              }}
              className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-medium text-slate-800"
            >
              ✨ Brain dump (paste a list)
            </button>
            <button
              type="button"
              onClick={() => setFabOpen(false)}
              className="mt-2 block w-full rounded-xl bg-slate-100 px-4 py-3 text-center text-sm font-medium text-slate-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const TAB_TITLES: Record<Tab, string> = {
  today: "Today",
  tasks: "Tasks",
  insights: "Insights",
  goals: "Goals",
};

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
      className={`flex flex-col items-center gap-0.5 px-2 pb-2 pt-2 ${
        active ? "text-slate-900" : "text-slate-500"
      }`}
    >
      <Icon />
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <p className="mt-1 text-xs text-slate-500">{body}</p>
    </div>
  );
}

// Tiny inline SVG icons — keeps bundle clean (no icon library) and gives
// the bar an iOS-feeling stroke vocabulary.
function IconToday() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconTasks() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}
function IconInsights() {
  return (
    <svg
      width="20"
      height="20"
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
      width="20"
      height="20"
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
