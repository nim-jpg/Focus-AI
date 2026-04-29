import { useEffect, useMemo, useRef, useState } from "react";
import type { Goal, Task, UserPrefs } from "@/types/task";
import type { PrioritizedTask } from "@/types/task";
import {
  counterCountToday,
  isCounter,
  wasCompletedToday,
} from "@/lib/recurrence";

type Tab = "today" | "tasks" | "timeline" | "insights" | "goals";

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
 * Dark iOS shell — bespoke views (not just wrapped desktop primitives).
 * Data flows through props; presentation is built fresh for thumb-first
 * use. Palette: near-black surfaces with electric-violet accent.
 */
export function IosShell(props: IosShellProps) {
  const [tab, setTab] = useState<Tab>("today");
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
      {/* Header — large iOS title that compresses on scroll */}
      <header
        className="sticky top-0 z-20 transition-all"
        style={{
          paddingTop: "max(env(safe-area-inset-top, 0), 8px)",
          background: scrolled ? "rgba(11, 14, 19, 0.7)" : "transparent",
          backdropFilter: scrolled ? "saturate(180%) blur(24px)" : "none",
          WebkitBackdropFilter: scrolled ? "saturate(180%) blur(24px)" : "none",
        }}
      >
        <div className="flex items-end justify-between px-5 pb-4 pt-2">
          <div className="min-w-0 flex-1">
            <h1
              className="font-bold tracking-tight transition-all"
              style={{
                fontSize: scrolled ? "20px" : "40px",
                lineHeight: scrolled ? "24px" : "44px",
                letterSpacing: scrolled ? "-0.01em" : "-0.03em",
                color: "var(--ios-text)",
              }}
            >
              {TAB_TITLES[tab]}
            </h1>
            {!scrolled && (
              <p
                className="mt-1 text-[14px] font-medium"
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
        className="flex-1 overflow-y-auto px-5"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0) + 110px)" }}
      >
        <div key={tab} className="ios-fade-in">
          {tab === "today" && <TodayTab {...props} />}
          {tab === "tasks" && <TasksTab {...props} />}
          {tab === "timeline" && <TimelineTab {...props} />}
          {tab === "insights" && <InsightsTab {...props} />}
          {tab === "goals" && <GoalsTab {...props} setTab={setTab} />}
        </div>
      </main>

      {/* Tab bar */}
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
        <div className="mx-auto grid max-w-md grid-cols-5 items-end px-2 pt-1">
          <TabButton label="Today" icon={IconToday} active={tab === "today"} onClick={() => setTab("today")} />
          <TabButton label="Tasks" icon={IconTasks} active={tab === "tasks"} onClick={() => setTab("tasks")} />
          {/* Timeline sits in the middle slot, with the FAB floating above */}
          <div className="flex flex-col items-center">
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
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setTab("timeline")}
              className="-mt-1 flex flex-col items-center gap-0.5 px-1 pb-2 transition-transform active:scale-95"
              style={{ color: tab === "timeline" ? "var(--ios-accent)" : "var(--ios-text-secondary)" }}
            >
              <span className="text-[10px] tracking-tight" style={{ fontWeight: tab === "timeline" ? 600 : 500 }}>
                Timeline
              </span>
            </button>
          </div>
          <TabButton label="Insights" icon={IconInsights} active={tab === "insights"} onClick={() => setTab("insights")} />
          <TabButton label="Goals" icon={IconGoals} active={tab === "goals"} onClick={() => setTab("goals")} />
        </div>
      </nav>

      {/* Action sheet */}
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
            <div className="mx-auto mb-3 h-1 w-10 rounded-full" style={{ background: "var(--ios-border-strong)" }} />
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

      {/* Scoped palette + animations */}
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
  today: "Today",
  tasks: "Tasks",
  timeline: "Timeline",
  insights: "Insights",
  goals: "Goals",
};
const TAB_SUBTITLES: Record<Tab, string> = {
  today: "Three things, plus your foundations.",
  tasks: "Everything in your queue.",
  timeline: "Your week at a glance.",
  insights: "Where the work sits.",
  goals: "What it ladders up to.",
};

// ─── TODAY ───────────────────────────────────────────────────────────
function TodayTab(p: IosShellProps) {
  const allOpen = useMemo(
    () => p.tasks.filter((t) => t.status !== "completed"),
    [p.tasks],
  );
  const allDoneToday = useMemo(
    () =>
      p.tasks.filter((t) => {
        if (t.recurrence === "none") {
          return t.status === "completed" && isToday(t.updatedAt);
        }
        return wasCompletedToday(t);
      }).length,
    [p.tasks],
  );
  const fdnDoneCount = useMemo(
    () => p.foundations.filter((t) => wasCompletedToday(t)).length,
    [p.foundations],
  );
  const totalTracked = allOpen.length + allDoneToday;
  const progressPct = totalTracked > 0
    ? Math.round((allDoneToday / totalTracked) * 100)
    : 0;
  const dueWeek = useMemo(
    () =>
      p.tasks.filter((t) => {
        if (t.status === "completed" || !t.dueDate) return false;
        const ms = new Date(t.dueDate).getTime() - Date.now();
        return ms > 0 && ms < 7 * 86400000;
      }).length,
    [p.tasks],
  );

  return (
    <div className="space-y-4 pt-2">
      {/* Daily Progress hero — gradient card with a circular progress ring
          on the right. The big number on the left is "today's done /
          today's open", which is the user's actual progress count. */}
      <div
        className="overflow-hidden rounded-3xl px-5 py-5"
        style={{
          background:
            "linear-gradient(135deg, #1A1D29 0%, #2D2440 60%, #4A1D5C 100%)",
          border: "1px solid var(--ios-border)",
          boxShadow: "0 12px 32px -8px rgba(124, 58, 237, 0.35)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p
              className="text-[22px] font-bold leading-tight"
              style={{ color: "white", letterSpacing: "-0.02em" }}
            >
              Daily Progress
            </p>
            <p
              className="mt-1 text-[13px] font-medium"
              style={{ color: "rgba(255,255,255,0.65)" }}
            >
              Today's task completion
            </p>
            <p
              className="mt-3 text-[44px] font-bold tabular-nums leading-none"
              style={{ color: "white", letterSpacing: "-0.04em" }}
            >
              {allDoneToday}
              <span
                className="text-[22px] font-semibold"
                style={{ color: "rgba(255,255,255,0.55)" }}
              >
                /{totalTracked || allOpen.length}
              </span>
            </p>
          </div>
          <ProgressRing
            value={progressPct}
            size={84}
            stroke={7}
            color="#A78BFA"
            track="rgba(255,255,255,0.12)"
            label={`${progressPct}%`}
            labelColor="white"
          />
        </div>
      </div>

      {/* Today's Tasks — hero icon tile (priority count) + 3 priority rows */}
      <div
        className="rounded-3xl p-4"
        style={{
          background: "var(--ios-surface)",
          border: "1px solid var(--ios-border)",
        }}
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2
            className="text-[22px] font-bold"
            style={{ letterSpacing: "-0.02em" }}
          >
            Today's tasks
          </h2>
          <button
            type="button"
            onClick={p.onRefreshAi}
            disabled={p.aiBusy}
            className="rounded-full px-3 py-1 text-[12px] font-semibold"
            style={{
              color: "var(--ios-accent)",
              background: "var(--ios-accent-soft)",
            }}
          >
            {p.aiBusy ? "Asking…" : "Refresh AI"}
          </button>
        </div>
        <div className="flex items-stretch gap-3">
          {/* Big icon tile with the count */}
          <button
            type="button"
            onClick={p.onAddTask}
            className="flex flex-col items-center justify-center rounded-2xl p-3 text-white transition-transform active:scale-95"
            style={{
              background: "linear-gradient(135deg, #DC2626, #EF4444)",
              minWidth: "108px",
              boxShadow: "0 8px 24px -6px rgba(239, 68, 68, 0.5)",
            }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <p
              className="mt-3 text-[26px] font-bold tabular-nums leading-none"
              style={{ letterSpacing: "-0.03em" }}
            >
              {allDoneToday}
              <span className="text-[14px] font-semibold opacity-70">
                /{totalTracked}
              </span>
            </p>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-wider opacity-90">
              Today
            </p>
          </button>

          {/* Priority rows */}
          <div className="flex min-w-0 flex-1 flex-col justify-between">
            {p.prioritized.length === 0 && (
              <p className="text-[13px]" style={{ color: "var(--ios-text-secondary)" }}>
                Nothing surfaced — tap + to add a task.
              </p>
            )}
            {p.prioritized.slice(0, 3).map((pt) => (
              <PriorityRow
                key={pt.task.id}
                task={pt.task}
                tier={pt.tier}
                onComplete={() => p.onComplete(pt.task.id)}
                onSchedule={() => p.onSchedule(pt.task.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Overall status — two stat cards with rings */}
      <div>
        <div className="mb-3 flex items-baseline justify-between px-1">
          <h2
            className="text-[22px] font-bold"
            style={{ letterSpacing: "-0.02em" }}
          >
            Overall status
          </h2>
          <button
            type="button"
            onClick={() => undefined}
            className="text-[12px] font-semibold"
            style={{ color: "var(--ios-accent)" }}
          >
            See more ›
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            iconBg="linear-gradient(135deg, #FACC15, #F59E0B)"
            icon={
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5 9-9" />
              </svg>
            }
            title="Tasks completed"
            sub={`${allDoneToday} done today`}
            ring={progressPct}
            ringColor="#F59E0B"
          />
          <StatCard
            iconBg="linear-gradient(135deg, #FB7185, #EF4444)"
            icon={
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            }
            title="Due this week"
            sub={dueWeek === 0 ? "All clear" : `${dueWeek} approaching`}
            ring={Math.min(100, dueWeek * 14)}
            ringColor="#EF4444"
          />
        </div>
      </div>

      {/* Foundations strip — habit chips */}
      {p.foundations.length > 0 && (
        <Section
          title="Foundations"
          right={
            <span className="text-[12px]" style={{ color: "var(--ios-text-secondary)" }}>
              {fdnDoneCount}/{p.foundations.length}
            </span>
          }
        >
          <div className="flex flex-wrap gap-2">
            {p.foundations.map((t) => (
              <FoundationChip
                key={t.id}
                task={t}
                onComplete={() => p.onComplete(t.id)}
                onIncrement={(d) => p.onIncrementCounter(t.id, d)}
                onDefer={
                  t.recurrence !== "daily"
                    ? () => p.onDeferFoundation(t.id)
                    : undefined
                }
              />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function isToday(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const t = new Date();
  return d.toDateString() === t.toDateString();
}

function ProgressRing({
  value,
  size,
  stroke,
  color,
  track,
  label,
  labelColor,
}: {
  value: number;
  size: number;
  stroke: number;
  color: string;
  track: string;
  label?: string;
  labelColor?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, value)) / 100) * c;
  return (
    <div className="relative flex flex-none items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          fill="none"
          style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.32, 0.72, 0, 1)" }}
        />
      </svg>
      {label && (
        <span
          className="absolute text-[12px] font-bold tabular-nums"
          style={{ color: labelColor ?? "var(--ios-text)" }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

const PRIORITY_BAR_COLORS: Record<1 | 2 | 3 | 4, string> = {
  1: "#EF4444", // red
  2: "#A78BFA", // violet
  3: "#FBBF24", // amber
  4: "#94A3B8", // slate
};

function PriorityRow({
  task,
  tier,
  onComplete,
  onSchedule,
}: {
  task: Task;
  tier: 1 | 2 | 3 | 4;
  onComplete: () => void;
  onSchedule: () => void;
}) {
  const dueLabel = task.dueDate ? fmtDate(task.dueDate) : "";
  const recurLabel = task.recurrence !== "none" ? task.recurrence : "";
  const log = task.completionLog ?? [];
  const stat =
    task.recurrence === "none"
      ? `${task.status === "completed" ? 1 : 0}/1`
      : `${log.length}`;
  // Three explicit click targets: checkbox (complete), middle (schedule),
  // stat (informational). No nested-button confusion.
  return (
    <div className="flex w-full items-center gap-2.5 py-2">
      <span
        className="h-10 w-[4px] flex-none rounded-full"
        style={{ background: PRIORITY_BAR_COLORS[tier] }}
      />
      <button
        type="button"
        onClick={onComplete}
        aria-label={`Mark ${task.title} done`}
        className="flex h-7 w-7 flex-none items-center justify-center rounded-full transition-transform active:scale-90"
        style={{
          border: `2px solid ${PRIORITY_BAR_COLORS[tier]}40`,
          background: "transparent",
        }}
      >
        <span style={{ color: PRIORITY_BAR_COLORS[tier], fontSize: "10px" }}>
          ●
        </span>
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
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: PRIORITY_BAR_COLORS[tier] }}
        >
          {TIER_LABELS[tier]} priority
          {recurLabel ? ` · ${recurLabel}` : ""}
          {dueLabel ? ` · ${dueLabel}` : ""}
        </span>
      </button>
      <span
        className="flex-none text-right text-[14px] font-bold tabular-nums"
        style={{ color: "var(--ios-text-secondary)" }}
      >
        {stat}
      </span>
    </div>
  );
}

function StatCard({
  iconBg,
  icon,
  title,
  sub,
  ring,
  ringColor,
}: {
  iconBg: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  ring: number;
  ringColor: string;
}) {
  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className="flex h-11 w-11 flex-none items-center justify-center rounded-2xl"
          style={{ background: iconBg }}
        >
          {icon}
        </div>
        <ProgressRing
          value={ring}
          size={44}
          stroke={4}
          color={ringColor}
          track="rgba(255,255,255,0.08)"
          label={`${ring}%`}
          labelColor="var(--ios-text)"
        />
      </div>
      <p
        className="mt-3 text-[16px] font-bold leading-tight"
        style={{ letterSpacing: "-0.01em" }}
      >
        {title}
      </p>
      <p className="mt-0.5 text-[12px] font-medium" style={{ color: "var(--ios-text-secondary)" }}>
        {sub}
      </p>
    </div>
  );
}


function FoundationChip({
  task,
  onComplete,
  onIncrement,
  onDefer,
}: {
  task: Task;
  onComplete: () => void;
  onIncrement: (delta: number) => void;
  onDefer?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const done = wasCompletedToday(task);
  const counter = isCounter(task);
  const count = counter ? counterCountToday(task) : 0;
  const target = task.counter?.target ?? 0;

  if (counter) {
    return (
      <div
        className="flex items-center gap-2 rounded-full pl-1 pr-1.5 py-1"
        style={{
          background: done ? "rgba(16, 185, 129, 0.16)" : "var(--ios-surface)",
          border: `1px solid ${done ? "rgba(16, 185, 129, 0.4)" : "var(--ios-border)"}`,
          color: done ? "var(--ios-success)" : "var(--ios-text)",
        }}
      >
        <button
          type="button"
          onClick={() => onIncrement(-1)}
          disabled={count === 0}
          className="flex h-6 w-6 items-center justify-center rounded-full text-[14px]"
          style={{ background: "rgba(255,255,255,0.06)", color: "var(--ios-text)" }}
        >
          −
        </button>
        <span className="text-[13px] font-semibold tabular-nums">
          {count}/{target}
        </span>
        <span className="text-[13px]">{task.title}</span>
        <button
          type="button"
          onClick={() => onIncrement(1)}
          className="flex h-6 w-6 items-center justify-center rounded-full text-[14px] text-white"
          style={{
            background:
              "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
          }}
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] transition-colors"
        style={{
          background: done ? "rgba(16, 185, 129, 0.16)" : "var(--ios-surface)",
          border: `1px solid ${done ? "rgba(16, 185, 129, 0.4)" : "var(--ios-border)"}`,
          color: done ? "var(--ios-success)" : "var(--ios-text)",
        }}
      >
        <span>{done ? "✓" : "○"}</span>
        <span className={done ? "line-through opacity-70" : ""}>{task.title}</span>
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-10 mt-1 flex flex-col gap-0.5 rounded-xl p-1"
          style={{
            background: "var(--ios-surface-elev)",
            border: "1px solid var(--ios-border-strong)",
            boxShadow: "0 12px 24px rgba(0,0,0,0.4)",
            minWidth: "140px",
          }}
        >
          <DropdownItem
            onClick={() => {
              onComplete();
              setOpen(false);
            }}
          >
            {done ? "Mark not done" : "Mark done"}
          </DropdownItem>
          {onDefer && (
            <DropdownItem
              onClick={() => {
                onDefer();
                setOpen(false);
              }}
            >
              Defer 1 day
            </DropdownItem>
          )}
        </div>
      )}
    </div>
  );
}

// ─── TASKS ───────────────────────────────────────────────────────────
function TasksTab(p: IosShellProps) {
  const [filter, setFilter] = useState<"open" | "completed" | "all">("open");
  const [themeFilter, setThemeFilter] = useState<string | "all">("all");

  const ignoredEvents = useMemo(
    () => new Set(p.prefs.ignoredEventIds ?? []),
    [p.prefs.ignoredEventIds],
  );
  const visible = useMemo(() => {
    return p.tasks.filter((t) => {
      if (t.calendarEventId && ignoredEvents.has(t.calendarEventId)) return false;
      if (filter === "open" && t.status === "completed") return false;
      if (filter === "completed" && t.status !== "completed") return false;
      if (themeFilter !== "all" && t.theme !== themeFilter) return false;
      return true;
    });
  }, [p.tasks, filter, themeFilter, ignoredEvents]);

  const themesPresent = useMemo(() => {
    const set = new Set(p.tasks.map((t) => t.theme));
    return Array.from(set);
  }, [p.tasks]);

  return (
    <div className="space-y-3 pt-2">
      {/* Segmented filter */}
      <div
        className="flex rounded-2xl p-1"
        style={{ background: "var(--ios-surface)", border: "1px solid var(--ios-border)" }}
      >
        {(["open", "completed", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className="flex-1 rounded-xl py-1.5 text-[12px] font-medium capitalize transition-colors"
            style={{
              background: filter === f ? "var(--ios-accent-soft)" : "transparent",
              color: filter === f ? "var(--ios-accent)" : "var(--ios-text-secondary)",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Theme dropdown */}
      <ThemeDropdown
        value={themeFilter}
        themes={themesPresent}
        onChange={setThemeFilter}
      />

      <div className="space-y-2">
        {visible.length === 0 && (
          <p className="py-8 text-center text-[13px]" style={{ color: "var(--ios-text-secondary)" }}>
            Nothing matches.
          </p>
        )}
        {visible.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            tier={p.aiTierMap?.get(t.id)}
            onToggle={() => p.onToggleTask(t.id)}
            onEdit={() => p.onEditTask(t.id)}
            onSchedule={() => p.onSchedule(t.id)}
            onUnsnooze={() => p.onUnsnooze(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  tier,
  onToggle,
  onEdit,
  onSchedule,
  onUnsnooze,
}: {
  task: Task;
  tier?: 1 | 2 | 3 | 4;
  onToggle: () => void;
  onEdit: () => void;
  onSchedule: () => void;
  onUnsnooze: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const done = task.status === "completed";
  const snoozed =
    task.snoozedUntil && new Date(task.snoozedUntil).getTime() > Date.now();

  return (
    <div
      className="rounded-2xl"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
        opacity: done ? 0.55 : 1,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <span
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-label={done ? "Mark incomplete" : "Mark complete"}
          className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full"
          style={{
            border: `1.5px solid ${done ? "var(--ios-success)" : "var(--ios-border-strong)"}`,
            background: done ? "var(--ios-success)" : "transparent",
            color: done ? "white" : "var(--ios-text-muted)",
            cursor: "pointer",
          }}
        >
          {done ? "✓" : ""}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {tier && <TierDot tier={tier} />}
            <p
              className={`truncate text-[15px] font-medium ${done ? "line-through" : ""}`}
              style={{ color: "var(--ios-text)" }}
            >
              {task.title}
            </p>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Tag size="sm">{task.theme}</Tag>
            {task.recurrence !== "none" && <Tag size="sm">{task.recurrence}</Tag>}
            {task.dueDate && <Tag size="sm">{fmtDate(task.dueDate)}</Tag>}
            {task.calendarEventId && <Tag size="sm" tone="accent">in calendar</Tag>}
            {snoozed && <Tag size="sm" tone="muted">snoozed</Tag>}
          </div>
        </div>
        <span
          className="mt-1 text-[10px]"
          style={{
            color: "var(--ios-text-muted)",
            transform: expanded ? "rotate(90deg)" : "rotate(0)",
            transition: "transform 200ms",
          }}
        >
          ›
        </span>
      </button>
      {expanded && (
        <div
          className="grid grid-cols-3 gap-1.5 border-t px-3 py-2"
          style={{ borderColor: "var(--ios-border)" }}
        >
          <RowAction onClick={onEdit}>Edit</RowAction>
          <RowAction onClick={onSchedule}>
            {task.calendarEventId ? "Re-time" : "Schedule"}
          </RowAction>
          {snoozed ? (
            <RowAction onClick={onUnsnooze}>Wake</RowAction>
          ) : (
            <div />
          )}
        </div>
      )}
    </div>
  );
}

function ThemeDropdown({
  value,
  themes,
  onChange,
}: {
  value: string;
  themes: string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-2xl px-3 py-2.5 text-[13px]"
        style={{
          background: "var(--ios-surface)",
          border: "1px solid var(--ios-border)",
          color: "var(--ios-text)",
        }}
      >
        <span>
          <span style={{ color: "var(--ios-text-secondary)" }}>Theme · </span>
          {value === "all" ? "All themes" : value}
        </span>
        <span style={{ color: "var(--ios-text-muted)" }}>▾</span>
      </button>
      {open && (
        <div
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-xl p-1"
          style={{
            background: "var(--ios-surface-elev)",
            border: "1px solid var(--ios-border-strong)",
            boxShadow: "0 12px 24px rgba(0,0,0,0.4)",
          }}
        >
          <DropdownItem
            onClick={() => {
              onChange("all");
              setOpen(false);
            }}
            active={value === "all"}
          >
            All themes
          </DropdownItem>
          {themes.map((t) => (
            <DropdownItem
              key={t}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
              active={value === t}
            >
              {t}
            </DropdownItem>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── INSIGHTS ────────────────────────────────────────────────────────
// ─── TIMELINE (Gantt-style) ───────────────────────────────────────────
function TimelineTab(p: IosShellProps) {
  // Show next 14 days. Each row is a task with a date; bar spans from
  // start (scheduledFor or dueDate) for estimatedMinutes (or 1 day if no
  // duration is meaningful). Hover/tap a bar → quick complete.
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const DAY_MS = 86400000;
  const DAYS = 14;
  const days = useMemo(
    () =>
      Array.from({ length: DAYS }, (_, i) => {
        const d = new Date(today.getTime() + i * DAY_MS);
        return {
          date: d,
          label: d.toLocaleDateString(undefined, {
            weekday: "short",
            day: "numeric",
          }),
          isToday: i === 0,
          isWeekend: d.getDay() === 0 || d.getDay() === 6,
        };
      }),
    [today],
  );

  const dated = useMemo(() => {
    return p.tasks
      .filter((t) => {
        if (t.status === "completed") return false;
        const start = t.scheduledFor ?? t.dueDate;
        if (!start) return false;
        const ms = new Date(start).getTime();
        return ms >= today.getTime() && ms < today.getTime() + DAYS * DAY_MS;
      })
      .sort(
        (a, b) =>
          new Date(a.scheduledFor ?? a.dueDate ?? 0).getTime() -
          new Date(b.scheduledFor ?? b.dueDate ?? 0).getTime(),
      );
  }, [p.tasks, today]);

  const undated = useMemo(
    () =>
      p.tasks.filter(
        (t) => t.status !== "completed" && !t.scheduledFor && !t.dueDate,
      ),
    [p.tasks],
  );

  // Width per day cell on mobile — keeps the chart legible while still
  // fitting 14 days in a horizontal scroll container.
  const COL_W = 56;
  const ROW_H = 44;

  return (
    <div className="space-y-4 pt-2">
      <div
        className="rounded-3xl p-3"
        style={{
          background: "var(--ios-surface)",
          border: "1px solid var(--ios-border)",
        }}
      >
        <div className="mb-3 flex items-baseline justify-between px-2">
          <h2 className="text-[20px] font-bold tracking-tight">Next 14 days</h2>
          <span
            className="text-[12px] font-medium"
            style={{ color: "var(--ios-text-secondary)" }}
          >
            {dated.length} scheduled
          </span>
        </div>

        <div className="overflow-x-auto -mx-3">
          <div className="px-3" style={{ minWidth: `${COL_W * DAYS}px` }}>
            {/* Day header */}
            <div className="grid pb-2" style={{ gridTemplateColumns: `repeat(${DAYS}, ${COL_W}px)` }}>
              {days.map((d, i) => (
                <div
                  key={i}
                  className="flex flex-col items-center"
                  style={{ width: COL_W }}
                >
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider"
                    style={{
                      color: d.isToday
                        ? "var(--ios-accent)"
                        : d.isWeekend
                          ? "var(--ios-text-muted)"
                          : "var(--ios-text-secondary)",
                    }}
                  >
                    {d.date.toLocaleDateString(undefined, { weekday: "short" })}
                  </span>
                  <span
                    className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-bold ${
                      d.isToday ? "text-white" : ""
                    }`}
                    style={{
                      background: d.isToday
                        ? "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))"
                        : "transparent",
                      color: d.isToday ? "white" : "var(--ios-text)",
                    }}
                  >
                    {d.date.getDate()}
                  </span>
                </div>
              ))}
            </div>

            {/* Bar grid — each row a task */}
            <div className="space-y-1.5">
              {dated.length === 0 && (
                <p
                  className="px-2 py-6 text-center text-[13px]"
                  style={{ color: "var(--ios-text-secondary)" }}
                >
                  No scheduled work in the next two weeks.
                </p>
              )}
              {dated.map((t) => {
                const start = new Date(t.scheduledFor ?? t.dueDate ?? "");
                start.setHours(0, 0, 0, 0);
                const dayIdx = Math.floor(
                  (start.getTime() - today.getTime()) / DAY_MS,
                );
                if (dayIdx < 0 || dayIdx >= DAYS) return null;
                const tier = p.aiTierMap?.get(t.id) ?? 4;
                const barColor =
                  tier === 1
                    ? "linear-gradient(90deg, #DC2626, #EF4444)"
                    : tier === 2
                      ? "linear-gradient(90deg, #7C3AED, #A78BFA)"
                      : tier === 3
                        ? "linear-gradient(90deg, #D97706, #FBBF24)"
                        : "linear-gradient(90deg, #475569, #94A3B8)";
                // Width: estimatedMinutes ≥ 60 → 1 day; else half a day.
                // For multi-day if the user has a multi-day window → all
                // those days. Simple approximation.
                const widthDays = Math.max(
                  1,
                  Math.min(DAYS - dayIdx, Math.ceil((t.estimatedMinutes ?? 30) / 240)),
                );
                return (
                  <div
                    key={t.id}
                    className="relative"
                    style={{ height: ROW_H }}
                  >
                    {/* Day grid background */}
                    <div
                      className="absolute inset-0 grid"
                      style={{ gridTemplateColumns: `repeat(${DAYS}, ${COL_W}px)` }}
                    >
                      {days.map((d, i) => (
                        <div
                          key={i}
                          className="border-r"
                          style={{
                            borderColor: "var(--ios-border)",
                            background: d.isWeekend
                              ? "rgba(255,255,255,0.02)"
                              : d.isToday
                                ? "rgba(167, 139, 250, 0.05)"
                                : "transparent",
                          }}
                        />
                      ))}
                    </div>
                    {/* Bar */}
                    <button
                      type="button"
                      onClick={() => p.onEditTask(t.id)}
                      className="absolute flex items-center gap-1.5 overflow-hidden rounded-lg px-2 text-left transition-transform active:scale-[0.97]"
                      style={{
                        left: `${dayIdx * COL_W + 4}px`,
                        width: `${widthDays * COL_W - 8}px`,
                        top: 6,
                        bottom: 6,
                        background: barColor,
                        boxShadow: "0 2px 8px -2px rgba(0,0,0,0.4)",
                      }}
                    >
                      <span
                        className="truncate text-[12px] font-semibold text-white"
                        style={{ textShadow: "0 1px 2px rgba(0,0,0,0.25)" }}
                      >
                        {t.title}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Undated bucket — tasks without a date */}
      {undated.length > 0 && (
        <div
          className="rounded-3xl p-4"
          style={{
            background: "var(--ios-surface)",
            border: "1px solid var(--ios-border)",
          }}
        >
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[20px] font-bold tracking-tight">Undated</h2>
            <span
              className="text-[12px] font-medium"
              style={{ color: "var(--ios-text-secondary)" }}
            >
              {undated.length} backlog
            </span>
          </div>
          <div className="space-y-2">
            {undated.slice(0, 8).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => p.onSchedule(t.id)}
                className="flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left transition-transform active:scale-[0.99]"
                style={{
                  background: "var(--ios-bg-elev)",
                  border: "1px solid var(--ios-border)",
                }}
              >
                <span className="truncate text-[14px] font-semibold">
                  {t.title}
                </span>
                <span
                  className="ml-2 flex-none rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{
                    background: "var(--ios-accent-soft)",
                    color: "var(--ios-accent)",
                  }}
                >
                  Schedule
                </span>
              </button>
            ))}
            {undated.length > 8 && (
              <p
                className="pt-1 text-center text-[11px]"
                style={{ color: "var(--ios-text-muted)" }}
              >
                + {undated.length - 8} more
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InsightsTab(p: IosShellProps) {
  const open = p.tasks.filter((t) => t.status !== "completed").length;
  const dueWeek = p.tasks.filter((t) => {
    if (t.status === "completed" || !t.dueDate) return false;
    const ms = new Date(t.dueDate).getTime() - Date.now();
    return ms > 0 && ms < 7 * 86400000;
  }).length;
  const overdue = p.tasks.filter((t) => {
    if (t.status === "completed" || !t.dueDate) return false;
    return new Date(t.dueDate).getTime() < Date.now();
  }).length;
  const themeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of p.tasks) {
      if (t.status === "completed") continue;
      m.set(t.theme, (m.get(t.theme) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [p.tasks]);

  return (
    <div className="space-y-3 pt-2">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Open" value={open} />
        <Stat label="Due this week" value={dueWeek} tone="accent" />
        <Stat label="Overdue" value={overdue} tone="warning" />
      </div>

      <div
        className="rounded-2xl p-4"
        style={{
          background: "var(--ios-surface)",
          border: "1px solid var(--ios-border)",
        }}
      >
        <p className="text-[12px] font-medium uppercase tracking-wider" style={{ color: "var(--ios-text-secondary)" }}>
          Open by theme
        </p>
        <div className="mt-3 space-y-2">
          {themeCounts.map(([theme, count]) => {
            const max = themeCounts[0]?.[1] ?? 1;
            const pct = Math.max(8, (count / max) * 100);
            return (
              <div key={theme} className="flex items-center gap-2">
                <span className="w-20 text-[12px] capitalize" style={{ color: "var(--ios-text)" }}>
                  {theme}
                </span>
                <div
                  className="h-2 flex-1 overflow-hidden rounded-full"
                  style={{ background: "var(--ios-border)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      background:
                        "linear-gradient(90deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
                    }}
                  />
                </div>
                <span
                  className="w-6 text-right text-[12px] tabular-nums"
                  style={{ color: "var(--ios-text-secondary)" }}
                >
                  {count}
                </span>
              </div>
            );
          })}
          {themeCounts.length === 0 && (
            <p className="text-[12px]" style={{ color: "var(--ios-text-secondary)" }}>
              Nothing open right now.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "accent" | "warning";
}) {
  const accent =
    tone === "accent"
      ? "var(--ios-accent)"
      : tone === "warning"
        ? "var(--ios-warning)"
        : "var(--ios-text)";
  return (
    <div
      className="rounded-2xl p-3"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <p
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: "var(--ios-text-secondary)" }}
      >
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums" style={{ color: accent }}>
        {value}
      </p>
    </div>
  );
}

// ─── GOALS ───────────────────────────────────────────────────────────
function GoalsTab(p: IosShellProps & { setTab: (t: Tab) => void }) {
  const [adding, setAdding] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  return (
    <div className="space-y-3 pt-2">
      {p.goals.length === 0 && !adding && (
        <div
          className="rounded-2xl p-6 text-center"
          style={{
            background: "var(--ios-surface)",
            border: "1px solid var(--ios-border)",
          }}
        >
          <p className="text-base font-semibold">No goals yet</p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ios-text-secondary)" }}>
            Goals are the long-term targets your tasks ladder up to.
          </p>
        </div>
      )}

      {p.goals.map((g) => {
        const taskCount = p.taskCountByGoal.get(g.id) ?? 0;
        const progress = p.goalProgress.get(g.id);
        return (
          <div
            key={g.id}
            className="rounded-2xl p-4"
            style={{
              background: "var(--ios-surface)",
              border: "1px solid var(--ios-border)",
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold">{g.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Tag size="sm">{g.horizon}</Tag>
                  <Tag size="sm">{g.theme}</Tag>
                  <Tag size="sm" tone="accent">
                    {taskCount} task{taskCount === 1 ? "" : "s"}
                  </Tag>
                  {progress && progress.doneLast30 > 0 && (
                    <Tag size="sm" tone="success">
                      {progress.doneLast30} done · 30d
                    </Tag>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => p.onRemoveGoal(g.id)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[12px]"
                style={{
                  background: "transparent",
                  color: "var(--ios-text-muted)",
                }}
                aria-label={`Remove ${g.title}`}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}

      {adding ? (
        <div
          className="rounded-2xl p-3"
          style={{
            background: "var(--ios-surface)",
            border: "1px solid var(--ios-border-strong)",
          }}
        >
          <input
            autoFocus
            type="text"
            value={draftTitle}
            placeholder="Goal title (e.g. ship Focus3 v1)"
            onChange={(e) => setDraftTitle(e.target.value)}
            className="w-full bg-transparent text-[15px] outline-none"
            style={{ color: "var(--ios-text)" }}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (draftTitle.trim()) {
                  p.onAddGoal({
                    title: draftTitle.trim(),
                    horizon: "1y",
                    theme: "personal",
                  });
                  setDraftTitle("");
                  setAdding(false);
                }
              }}
              className="flex-1 rounded-xl py-2.5 text-[13px] font-semibold text-white"
              style={{
                background:
                  "linear-gradient(135deg, var(--ios-accent-grad-from), var(--ios-accent-grad-to))",
              }}
            >
              Add goal
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setDraftTitle("");
              }}
              className="rounded-xl px-4 py-2.5 text-[13px]"
              style={{
                background: "rgba(255,255,255,0.06)",
                color: "var(--ios-text)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full rounded-2xl py-3 text-[14px] font-medium"
          style={{
            background: "var(--ios-accent-soft)",
            color: "var(--ios-accent)",
            border: "1px dashed var(--ios-accent)",
          }}
        >
          + Add a goal
        </button>
      )}
    </div>
  );
}

// ─── PRIMITIVES ──────────────────────────────────────────────────────
function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2
          className="text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--ios-text-secondary)" }}
        >
          {title}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Tag({
  children,
  size = "default",
  tone = "default",
}: {
  children: React.ReactNode;
  size?: "default" | "sm";
  tone?: "default" | "accent" | "muted" | "success";
}) {
  const bg =
    tone === "accent"
      ? "var(--ios-accent-soft)"
      : tone === "success"
        ? "rgba(16, 185, 129, 0.16)"
        : tone === "muted"
          ? "rgba(255,255,255,0.04)"
          : "rgba(255,255,255,0.05)";
  const color =
    tone === "accent"
      ? "var(--ios-accent)"
      : tone === "success"
        ? "var(--ios-success)"
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

function TierDot({ tier }: { tier: 1 | 2 | 3 | 4 }) {
  const colors: Record<1 | 2 | 3 | 4, string> = {
    1: "#EF4444", // red — now
    2: "#A78BFA", // violet — soon
    3: "#FBBF24", // amber — balance
    4: "#94A3B8", // slate — later
  };
  return (
    <span
      className="inline-block h-1.5 w-1.5 flex-none rounded-full"
      style={{
        background: colors[tier],
        boxShadow: `0 0 0 2px ${colors[tier]}25`,
      }}
    />
  );
}

const TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Now",
  2: "Soon",
  3: "Balance",
  4: "Later",
};

function DropdownItem({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] capitalize"
      style={{
        background: active ? "var(--ios-accent-soft)" : "transparent",
        color: active ? "var(--ios-accent)" : "var(--ios-text)",
      }}
    >
      {children}
      {active && <span className="text-[12px]">✓</span>}
    </button>
  );
}

function RowAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl py-2 text-[12px] font-medium transition-transform active:scale-95"
      style={{
        background: "rgba(255,255,255,0.04)",
        color: "var(--ios-text)",
      }}
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
        className="text-[10px] tracking-tight"
        style={{ fontWeight: active ? 600 : 500 }}
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
      className="mt-2 flex w-full flex-col items-center gap-0.5 rounded-2xl px-4 py-3 transition-transform active:scale-[0.98]"
      style={styles}
    >
      <span className="text-[15px] font-semibold">{title}</span>
      {subtitle && (
        <span
          className="text-[11px]"
          style={{
            color: variant === "primary" ? "rgba(255,255,255,0.75)" : "var(--ios-text-secondary)",
          }}
        >
          {subtitle}
        </span>
      )}
    </button>
  );
}


function fmtDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Icons
function IconToday() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <circle cx="12" cy="15" r="1.5" fill="currentColor" />
    </svg>
  );
}
function IconTasks() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1.2" fill="currentColor" />
    </svg>
  );
}
function IconInsights() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5M4 19h16" />
      <path d="M8 14v3M12 9v8M16 12v5" />
    </svg>
  );
}
function IconGoals() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
