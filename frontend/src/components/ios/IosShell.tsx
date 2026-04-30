import { useEffect, useMemo, useRef, useState } from "react";
import type { Goal, PrioritizedTask, Task, UserPrefs } from "@/types/task";
import { prioritize } from "@/lib/prioritize";

type Tab = "focus" | "pending";

interface IosShellProps {
  tasks: Task[];
  goals: Goal[];
  prefs: UserPrefs;
  prioritized: PrioritizedTask[];
  foundations: Task[];
  aiTierMap?: Map<string, 1 | 2 | 3 | 4>;
  onComplete: (id: string) => void;
  onToggleTask: (id: string) => void;
  onRemoveTask: (id: string) => void;
  onEditTask: (id: string) => void;
  onSchedule: (id: string) => void;
  onUnsnooze: (id: string) => void;
  onSnooze: (id: string, untilIso: string) => void;
  onIncrementCounter: (id: string, delta: number) => void;
  onDeferFoundation: (id: string) => void;
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
 * Stripped-back iOS shell. Two tabs:
 *  - Focus  → top 3 + stretch tasks. Big and bold; calm whitespace.
 *  - Pending → backlog with goal filter + Schedule action per row.
 *
 * The FAB sheet still offers Add task + Brain dump. Goals don't have their
 * own tab; they appear as filter chips on Pending and as ladder-up tags
 * inline on each task — pushing the user toward "every task ladders up to
 * a goal" without making goals a destination.
 */
export function IosShell(props: IosShellProps) {
  const [tab, setTab] = useState<Tab>("focus");
  const [fabOpen, setFabOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
        <div className="flex items-end justify-between px-6 pb-4 pt-2">
          <div className="min-w-0 flex-1">
            <h1
              className="font-bold tracking-tight transition-all"
              style={{
                fontSize: scrolled ? "20px" : "44px",
                lineHeight: scrolled ? "24px" : "48px",
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
          <button
            type="button"
            onClick={props.onExitIosLayout}
            className="-mr-1 inline-flex h-8 items-center rounded-full px-3 text-[12px] font-medium"
            style={{
              color: "var(--ios-accent)",
              background: "var(--ios-accent-soft)",
            }}
          >
            Desktop
          </button>
        </div>
      </header>

      <main
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0) + 116px)" }}
      >
        <div key={tab} className="ios-fade-in">
          {tab === "focus" && <FocusTab {...props} />}
          {tab === "pending" && <PendingTab {...props} />}
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
            label="Pending"
            icon={IconList}
            active={tab === "pending"}
            onClick={() => setTab("pending")}
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

      <style>{`
        .ios-root {
          --ios-bg: #0B0E13;
          --ios-bg-elev: #0F1218;
          --ios-surface: #16181F;
          --ios-surface-elev: #1C1F27;
          --ios-text: #F5F5F7;
          --ios-text-secondary: #8B92A0;
          --ios-text-muted: #5A6173;
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
      `}</style>
    </div>
  );
}

const TAB_TITLES: Record<Tab, string> = {
  focus: "Focus",
  pending: "Pending",
};
const TAB_SUBTITLES: Record<Tab, string> = {
  focus: "Three things, plus a stretch.",
  pending: "Schedule what's left, by goal.",
};

// ─── FOCUS ───────────────────────────────────────────────────────────
function FocusTab(p: IosShellProps) {
  // Top three + stretch (next ~5). Reuses prioritize() so we get the same
  // engine the desktop view uses.
  const stretch = useMemo(() => {
    const eight = prioritize(p.tasks, { prefs: p.prefs, limit: 8, goals: p.goals });
    const topIds = new Set(p.prioritized.map((pt) => pt.task.id));
    return eight.filter((s) => !topIds.has(s.task.id));
  }, [p.tasks, p.prefs, p.goals, p.prioritized]);

  const goalById = useMemo(() => {
    const m = new Map<string, Goal>();
    for (const g of p.goals) m.set(g.id, g);
    return m;
  }, [p.goals]);

  return (
    <div className="space-y-6 pt-3">
      {p.prioritized.length === 0 ? (
        <Empty
          title="A clear plate"
          body="Nothing surfaced. Tap + to add a task or brain-dump a list."
        />
      ) : (
        <section>
          <SectionHeader title="Your three" />
          <div className="space-y-3">
            {p.prioritized.slice(0, 3).map((pt, idx) => (
              <FocusCard
                key={pt.task.id}
                rank={idx + 1}
                task={pt.task}
                tier={pt.tier}
                reasoning={pt.reasoning}
                goal={pickGoal(pt.task, goalById)}
                onComplete={() => p.onComplete(pt.task.id)}
                onSchedule={() => p.onSchedule(pt.task.id)}
                onEdit={() => p.onEditTask(pt.task.id)}
              />
            ))}
          </div>
        </section>
      )}

      {stretch.length > 0 && (
        <section>
          <SectionHeader
            title="Stretch"
            sub={`${stretch.length} more if today's flowing`}
          />
          <div className="space-y-2">
            {stretch.map((s) => (
              <StretchRow
                key={s.task.id}
                task={s.task}
                tier={s.tier}
                goal={pickGoal(s.task, goalById)}
                onComplete={() => p.onComplete(s.task.id)}
                onSchedule={() => p.onSchedule(s.task.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function FocusCard({
  rank,
  task,
  tier,
  reasoning,
  goal,
  onComplete,
  onSchedule,
  onEdit,
}: {
  rank: number;
  task: Task;
  tier: 1 | 2 | 3 | 4;
  reasoning: string;
  goal?: Goal;
  onComplete: () => void;
  onSchedule: () => void;
  onEdit: () => void;
}) {
  const colour = PRIORITY_BAR_COLORS[tier];
  return (
    <div
      className="overflow-hidden rounded-3xl"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
        boxShadow: "0 8px 24px -12px rgba(0,0,0,0.4)",
      }}
    >
      <div className="flex items-stretch">
        <div
          className="flex w-1.5 flex-none"
          style={{ background: colour }}
        />
        <div className="min-w-0 flex-1 px-4 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-bold"
              style={{
                background: `${colour}1F`,
                color: colour,
              }}
            >
              {rank}
            </span>
            <span
              className="text-[11px] font-bold uppercase tracking-wider"
              style={{ color: colour }}
            >
              {TIER_LABELS[tier]}
            </span>
          </div>
          <button
            type="button"
            onClick={onEdit}
            className="block w-full text-left"
          >
            <h3
              className="text-[20px] font-bold leading-tight"
              style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}
            >
              {task.title}
            </h3>
            {reasoning && (
              <p
                className="mt-1.5 line-clamp-2 text-[13px]"
                style={{ color: "var(--ios-text-secondary)" }}
              >
                {reasoning}
              </p>
            )}
          </button>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Tag>{task.theme}</Tag>
            <Tag>{task.estimatedMinutes ?? 30}m</Tag>
            {task.dueDate && <Tag>due {fmtDate(task.dueDate)}</Tag>}
            {goal && (
              <Tag tone="accent">
                <span className="opacity-70">↑ </span>
                {shortGoalLabel(goal.title)}
              </Tag>
            )}
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onComplete}
              className="flex-1 rounded-2xl py-3 text-[14px] font-semibold text-white transition-transform active:scale-95"
              style={{
                background:
                  "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
                boxShadow: "0 6px 16px -4px rgba(124, 58, 237, 0.4)",
              }}
            >
              Done
            </button>
            <button
              type="button"
              onClick={onSchedule}
              className="rounded-2xl px-5 py-3 text-[14px] font-semibold transition-transform active:scale-95"
              style={{
                background: "rgba(255,255,255,0.06)",
                color: "var(--ios-text)",
                border: "1px solid var(--ios-border)",
              }}
            >
              {task.calendarEventId ? "Re-time" : "Schedule"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StretchRow({
  task,
  tier,
  goal,
  onComplete,
  onSchedule,
}: {
  task: Task;
  tier: 1 | 2 | 3 | 4;
  goal?: Goal;
  onComplete: () => void;
  onSchedule: () => void;
}) {
  const colour = PRIORITY_BAR_COLORS[tier];
  return (
    <div
      className="flex items-center gap-3 rounded-2xl px-3 py-3"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <button
        type="button"
        onClick={onComplete}
        aria-label={`Mark ${task.title} done`}
        className="flex h-7 w-7 flex-none items-center justify-center rounded-full transition-transform active:scale-90"
        style={{
          border: `2px solid ${colour}55`,
          background: "transparent",
        }}
      >
        <span
          className="block h-2 w-2 rounded-full"
          style={{ background: colour }}
        />
      </button>
      <button
        type="button"
        onClick={onSchedule}
        className="flex min-w-0 flex-1 flex-col items-start text-left transition-transform active:scale-[0.99]"
      >
        <span
          className="truncate text-[15px] font-bold leading-tight"
          style={{ color: "var(--ios-text)", letterSpacing: "-0.01em" }}
        >
          {task.title}
        </span>
        <span
          className="mt-0.5 truncate text-[11px]"
          style={{ color: "var(--ios-text-secondary)" }}
        >
          {task.theme}
          {task.dueDate ? ` · due ${fmtDate(task.dueDate)}` : ""}
          {goal ? ` · ${shortGoalLabel(goal.title)}` : ""}
        </span>
      </button>
      <span
        className="flex-none rounded-full px-2 py-1 text-[11px] font-semibold"
        style={{
          background: "var(--ios-accent-soft)",
          color: "var(--ios-accent)",
        }}
      >
        {task.calendarEventId ? "Timed" : "Schedule"}
      </span>
    </div>
  );
}

// ─── PENDING ─────────────────────────────────────────────────────────
function PendingTab(p: IosShellProps) {
  const [goalFilter, setGoalFilter] = useState<string>("all");
  // "all" = every pending task; "none" = unlinked tasks; goalId = linked.

  const goalById = useMemo(() => {
    const m = new Map<string, Goal>();
    for (const g of p.goals) m.set(g.id, g);
    return m;
  }, [p.goals]);

  const ignoredEvents = useMemo(
    () => new Set(p.prefs.ignoredEventIds ?? []),
    [p.prefs.ignoredEventIds],
  );

  const visible = useMemo(() => {
    return p.tasks
      .filter((t) => {
        if (t.status === "completed") return false;
        if (
          t.calendarEventId &&
          ignoredEvents.has(t.calendarEventId)
        ) {
          return false;
        }
        if (
          t.snoozedUntil &&
          new Date(t.snoozedUntil).getTime() > Date.now()
        ) {
          return false;
        }
        if (goalFilter === "all") return true;
        if (goalFilter === "none") return (t.goalIds ?? []).length === 0;
        return (t.goalIds ?? []).includes(goalFilter);
      })
      .sort((a, b) => {
        const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        return da - db;
      });
  }, [p.tasks, goalFilter, ignoredEvents]);

  const totalUnlinked = useMemo(
    () =>
      p.tasks.filter(
        (t) =>
          t.status !== "completed" && (t.goalIds ?? []).length === 0,
      ).length,
    [p.tasks],
  );

  return (
    <div className="space-y-4 pt-3">
      {/* Goal filter — horizontal scroll of chips */}
      <div className="-mx-6 overflow-x-auto px-6">
        <div className="flex gap-2 pb-1">
          <FilterChip
            active={goalFilter === "all"}
            onClick={() => setGoalFilter("all")}
            label="All"
            count={p.tasks.filter((t) => t.status !== "completed").length}
          />
          {totalUnlinked > 0 && (
            <FilterChip
              active={goalFilter === "none"}
              onClick={() => setGoalFilter("none")}
              label="No goal"
              count={totalUnlinked}
              tone="warn"
            />
          )}
          {p.goals.map((g) => {
            const c = p.taskCountByGoal.get(g.id) ?? 0;
            if (c === 0 && goalFilter !== g.id) return null;
            return (
              <FilterChip
                key={g.id}
                active={goalFilter === g.id}
                onClick={() => setGoalFilter(g.id)}
                label={shortGoalLabel(g.title)}
                count={c}
              />
            );
          })}
        </div>
      </div>

      {/* "No goal" gentle nudge — visible only when on the no-goal filter
          AND tasks exist. Encourages the user to link tasks to goals
          gradually, without nagging on every screen. */}
      {goalFilter === "none" && visible.length > 0 && (
        <div
          className="rounded-2xl px-4 py-3 text-[13px]"
          style={{
            background: "rgba(245, 158, 11, 0.08)",
            border: "1px solid rgba(245, 158, 11, 0.2)",
            color: "var(--ios-text-secondary)",
          }}
        >
          <p className="font-semibold" style={{ color: "var(--ios-warning)" }}>
            {visible.length} task{visible.length === 1 ? "" : "s"} not yet
            linked to a goal
          </p>
          <p className="mt-1">
            Tap a row to open it, then add a goal — it tends to make the rest
            quieter when everything ladders up to something.
          </p>
        </div>
      )}

      {visible.length === 0 && (
        <Empty
          title={goalFilter === "all" ? "Inbox zero" : "Nothing here"}
          body={
            goalFilter === "all"
              ? "No pending tasks. Add one with the + button."
              : "No tasks match this filter."
          }
        />
      )}

      <div className="space-y-2">
        {visible.map((t) => {
          const goal = pickGoal(t, goalById);
          return (
            <PendingRow
              key={t.id}
              task={t}
              goal={goal}
              onComplete={() => p.onToggleTask(t.id)}
              onSchedule={() => p.onSchedule(t.id)}
              onEdit={() => p.onEditTask(t.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function PendingRow({
  task,
  goal,
  onComplete,
  onSchedule,
  onEdit,
}: {
  task: Task;
  goal?: Goal;
  onComplete: () => void;
  onSchedule: () => void;
  onEdit: () => void;
}) {
  const overdue =
    task.dueDate && new Date(task.dueDate).getTime() < Date.now();
  return (
    <div
      className="rounded-2xl"
      style={{
        background: "var(--ios-surface)",
        border: `1px solid ${overdue ? "rgba(239, 68, 68, 0.25)" : "var(--ios-border)"}`,
      }}
    >
      <div className="flex items-start gap-3 p-3">
        <button
          type="button"
          onClick={onComplete}
          aria-label={`Complete ${task.title}`}
          className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full transition-transform active:scale-90"
          style={{
            border: "2px solid var(--ios-border-strong)",
            background: "transparent",
          }}
        />
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left"
        >
          <p
            className="truncate text-[16px] font-bold leading-tight"
            style={{ color: "var(--ios-text)", letterSpacing: "-0.01em" }}
          >
            {task.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Tag size="sm">{task.theme}</Tag>
            {task.dueDate && (
              <Tag size="sm" tone={overdue ? "danger" : "default"}>
                {overdue ? "overdue · " : "due "}
                {fmtDate(task.dueDate)}
              </Tag>
            )}
            {goal ? (
              <Tag size="sm" tone="accent">
                ↑ {shortGoalLabel(goal.title)}
              </Tag>
            ) : (
              <Tag size="sm" tone="muted">no goal</Tag>
            )}
          </div>
        </button>
        <button
          type="button"
          onClick={onSchedule}
          className="flex-none rounded-full px-3 py-1.5 text-[12px] font-semibold transition-transform active:scale-95"
          style={{
            background: "var(--ios-accent-soft)",
            color: "var(--ios-accent)",
          }}
        >
          {task.calendarEventId ? "Re-time" : "Schedule"}
        </button>
      </div>
    </div>
  );
}

// ─── PRIMITIVES ──────────────────────────────────────────────────────
function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3 px-1">
      <h2
        className="text-[15px] font-bold uppercase tracking-wider"
        style={{ color: "var(--ios-text-secondary)" }}
      >
        {title}
      </h2>
      {sub && (
        <p
          className="mt-0.5 text-[12px] font-medium"
          style={{ color: "var(--ios-text-muted)" }}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded-3xl px-6 py-12 text-center"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <p
        className="text-[20px] font-bold"
        style={{ color: "var(--ios-text)", letterSpacing: "-0.01em" }}
      >
        {title}
      </p>
      <p
        className="mt-1.5 text-[14px]"
        style={{ color: "var(--ios-text-secondary)" }}
      >
        {body}
      </p>
    </div>
  );
}

function Tag({
  children,
  size = "default",
  tone = "default",
}: {
  children: React.ReactNode;
  size?: "default" | "sm";
  tone?: "default" | "accent" | "muted" | "danger" | "success";
}) {
  const bg =
    tone === "accent"
      ? "var(--ios-accent-soft)"
      : tone === "success"
        ? "rgba(16, 185, 129, 0.16)"
        : tone === "danger"
          ? "rgba(239, 68, 68, 0.14)"
          : tone === "muted"
            ? "rgba(255,255,255,0.04)"
            : "rgba(255,255,255,0.05)";
  const color =
    tone === "accent"
      ? "var(--ios-accent)"
      : tone === "success"
        ? "var(--ios-success)"
        : tone === "danger"
          ? "var(--ios-danger)"
          : tone === "muted"
            ? "var(--ios-text-muted)"
            : "var(--ios-text-secondary)";
  return (
    <span
      className={`rounded-full font-medium ${
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-[11px]"
      }`}
      style={{
        background: bg,
        color,
        border: "1px solid var(--ios-border)",
      }}
    >
      {children}
    </span>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "warn";
}) {
  const accent = tone === "warn" ? "var(--ios-warning)" : "var(--ios-accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-none items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition-transform active:scale-95"
      style={{
        background: active
          ? tone === "warn"
            ? "rgba(245, 158, 11, 0.16)"
            : "var(--ios-accent-soft)"
          : "var(--ios-surface)",
        color: active ? accent : "var(--ios-text-secondary)",
        border: `1px solid ${active ? accent + "55" : "var(--ios-border)"}`,
      }}
    >
      <span>{label}</span>
      <span
        className="rounded-full px-1.5 py-0 text-[10px] tabular-nums"
        style={{
          background: active
            ? "rgba(255,255,255,0.08)"
            : "rgba(255,255,255,0.04)",
          color: active ? accent : "var(--ios-text-muted)",
        }}
      >
        {count}
      </span>
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
  icon: () => React.JSX.Element;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 px-1 pb-2 pt-2 transition-transform active:scale-95"
      style={{
        color: active ? "var(--ios-accent)" : "var(--ios-text-secondary)",
      }}
    >
      <Icon />
      <span
        className="text-[11px] tracking-tight"
        style={{ fontWeight: active ? 700 : 500 }}
      >
        {label}
      </span>
    </button>
  );
}

function SheetButton({
  variant,
  onClick,
  title,
  subtitle,
}: {
  variant: "primary" | "secondary" | "cancel";
  onClick: () => void;
  title: string;
  subtitle?: string;
}) {
  const styles =
    variant === "primary"
      ? {
          background:
            "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
          color: "white",
        }
      : variant === "secondary"
        ? {
            background: "var(--ios-bg-elev)",
            color: "var(--ios-text)",
            border: "1px solid var(--ios-border)",
          }
        : {
            background: "var(--ios-bg-elev)",
            color: "var(--ios-text-secondary)",
            border: "1px solid var(--ios-border)",
          };
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 flex w-full flex-col items-center gap-0.5 rounded-2xl px-4 py-4 transition-transform active:scale-[0.98]"
      style={styles}
    >
      <span className="text-[16px] font-bold">{title}</span>
      {subtitle && (
        <span
          className="text-[11px]"
          style={{
            color:
              variant === "primary"
                ? "rgba(255,255,255,0.75)"
                : "var(--ios-text-secondary)",
          }}
        >
          {subtitle}
        </span>
      )}
    </button>
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────────
const PRIORITY_BAR_COLORS: Record<1 | 2 | 3 | 4, string> = {
  1: "#EF4444",
  2: "#A78BFA",
  3: "#FBBF24",
  4: "#94A3B8",
};

const TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Now",
  2: "Soon",
  3: "Balance",
  4: "Later",
};

function pickGoal(task: Task, goalById: Map<string, Goal>): Goal | undefined {
  const ids = task.goalIds ?? [];
  for (const id of ids) {
    const g = goalById.get(id);
    if (g) return g;
  }
  return undefined;
}

function shortGoalLabel(title: string): string {
  const filler = new Set([
    "get",
    "to",
    "a",
    "an",
    "the",
    "my",
    "be",
    "more",
    "less",
    "of",
    "for",
    "with",
    "and",
    "or",
    "make",
    "do",
    "have",
    "build",
    "become",
  ]);
  const words = title
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\w-]/g, ""))
    .filter(Boolean);
  const meaningful = words.filter((w) => !filler.has(w.toLowerCase()));
  if (meaningful.length === 0) return (words[0] ?? title).slice(0, 16);
  const first = meaningful[0];
  if (first.length < 5 && meaningful[1]) {
    const phrase = `${first} ${meaningful[1]}`;
    if (phrase.length <= 16) return phrase.toLowerCase();
  }
  return first.toLowerCase().slice(0, 16);
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function IconFocus() {
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
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
function IconList() {
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
