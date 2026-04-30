import { useEffect, useMemo, useRef, useState } from "react";
import type { Goal, PrioritizedTask, Task, UserPrefs } from "@/types/task";
import { prioritize } from "@/lib/prioritize";
import { fetchEvents, type CalendarEvent } from "@/lib/googleCalendar";

type Tab = "focus" | "goals";

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
  const [hyperOpen, setHyperOpen] = useState(false);
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
          {tab === "focus" && (
            <FocusTab {...props} onOpenHyper={() => setHyperOpen(true)} />
          )}
          {tab === "goals" && <GoalsTab {...props} />}
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

      {hyperOpen && (
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
          onClose={() => setHyperOpen(false)}
        />
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
        .hyper-enter { animation: hyperEnter 320ms cubic-bezier(0.32, 0.72, 0, 1); }
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
function FocusTab(p: IosShellProps & { onOpenHyper: () => void }) {
  const stretch = useMemo(() => {
    const eight = prioritize(p.tasks, { prefs: p.prefs, limit: 8, goals: p.goals });
    const topIds = new Set(p.prioritized.map((pt) => pt.task.id));
    return eight.filter((s) => !topIds.has(s.task.id)).slice(0, 5);
  }, [p.tasks, p.prefs, p.goals, p.prioritized]);

  const goalById = useMemo(() => {
    const m = new Map<string, Goal>();
    for (const g of p.goals) m.set(g.id, g);
    return m;
  }, [p.goals]);

  const todayEvents = useTodayEvents(p.calendarConnected);

  return (
    <div className="space-y-5 pt-3">
      <HyperFocusPill onOpen={p.onOpenHyper} />

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
          <SectionHeader title="Stretch" />
          <div className="space-y-1.5">
            {stretch.map((s) => (
              <StretchRow
                key={s.task.id}
                task={s.task}
                tier={s.tier}
                goal={pickGoal(s.task, goalById)}
                onComplete={() => p.onComplete(s.task.id)}
                onEdit={() => p.onEditTask(s.task.id)}
                onSchedule={() => p.onSchedule(s.task.id)}
              />
            ))}
          </div>
        </section>
      )}

      <QuickTray />
    </div>
  );
}

function HyperFocusPill({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left"
      style={{
        background:
          "linear-gradient(135deg, rgba(124, 58, 237, 0.18), rgba(236, 72, 153, 0.14))",
        border: "1px solid rgba(167, 139, 250, 0.32)",
      }}
    >
      <div>
        <div
          className="text-[15px] font-bold"
          style={{ color: "var(--ios-text)" }}
        >
          Enter Hyper Focus
        </div>
        <div
          className="text-[12px]"
          style={{ color: "var(--ios-text-secondary)" }}
        >
          Today's basics, the day's timeline, defer with a tap.
        </div>
      </div>
      <span
        className="flex h-8 w-8 flex-none items-center justify-center rounded-full"
        style={{ background: "rgba(255,255,255,0.08)" }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color: "var(--ios-accent)" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </button>
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
function StretchRow({
  task,
  tier,
  goal,
  onComplete,
  onEdit,
  onSchedule,
}: {
  task: Task;
  tier: 1 | 2 | 3 | 4;
  goal?: Goal;
  onComplete: () => void;
  onEdit: () => void;
  onSchedule: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl px-2.5 py-2"
      style={{
        background: "var(--ios-surface)",
        border: "1px solid var(--ios-border)",
      }}
    >
      <button
        type="button"
        onClick={onComplete}
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full"
        style={{
          border: `1.5px solid ${TIER_COLORS[tier]}`,
        }}
        aria-label="Complete"
      />
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <div
          className="truncate text-[14px] font-medium"
          style={{ color: "var(--ios-text)" }}
        >
          {task.title}
        </div>
        <div className="flex items-center gap-1 text-[11px]" style={{ color: "var(--ios-text-muted)" }}>
          {task.theme && task.theme !== "personal" && <span>{task.theme}</span>}
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
      <button
        type="button"
        onClick={onSchedule}
        className="rounded-md px-2 py-1 text-[11px] font-medium"
        style={{ color: "var(--ios-accent)", background: "var(--ios-accent-soft)" }}
      >
        {task.calendarEventId ? "Re-time" : "Schedule"}
      </button>
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
      <SectionHeader title="Quick log" muted />
      <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {QUICK_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => bump(item.key)}
            className="flex flex-none items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--ios-surface)",
              border: "1px solid var(--ios-border)",
              color: "var(--ios-text-secondary)",
            }}
          >
            <span className="text-[14px]">{item.emoji}</span>
            <span>{item.label}</span>
            {(counts[item.key] ?? 0) > 0 && (
              <span
                className="ml-0.5 rounded-full px-1.5 text-[10px] font-bold"
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
function GoalsTab(p: IosShellProps) {
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
            onCompleteTask={p.onComplete}
            onScheduleTask={p.onSchedule}
            onEditTask={p.onEditTask}
          />
        );
      })}

      {tasksByGoal.unlinked.length > 0 && (
        <UnlinkedCard
          tasks={tasksByGoal.unlinked}
          open={expanded.has("__unlinked")}
          onToggle={() => toggle("__unlinked")}
          onCompleteTask={p.onComplete}
          onScheduleTask={p.onSchedule}
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
  onScheduleTask,
  onEditTask,
}: {
  goal: Goal;
  tasks: Task[];
  doneLast30: number;
  open: boolean;
  onToggle: () => void;
  onCompleteTask: (id: string) => void;
  onScheduleTask: (id: string) => void;
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
                onSchedule={() => onScheduleTask(t.id)}
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
  onScheduleTask,
  onEditTask,
}: {
  tasks: Task[];
  open: boolean;
  onToggle: () => void;
  onCompleteTask: (id: string) => void;
  onScheduleTask: (id: string) => void;
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
              onSchedule={() => onScheduleTask(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GoalTaskRow({
  task,
  onComplete,
  onEdit,
  onSchedule,
}: {
  task: Task;
  onComplete: () => void;
  onEdit: () => void;
  onSchedule: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2 py-1.5"
      style={{ background: "var(--ios-surface-elev)" }}
    >
      <button
        type="button"
        onClick={onComplete}
        className="flex h-5 w-5 flex-none items-center justify-center rounded-full"
        style={{ border: "1.5px solid var(--ios-border-strong)" }}
        aria-label="Complete"
      />
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
        onClick={onSchedule}
        className="rounded px-1.5 py-0.5 text-[10px] font-medium"
        style={{ color: "var(--ios-accent)" }}
      >
        {task.calendarEventId ? "Re-time" : "Schedule"}
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
  onClose: () => void;
}

function HyperFocus(p: HyperFocusProps) {
  const [dayOffset, setDayOffset] = useState(0); // 0 = today, -1 = yesterday, +1 = tomorrow
  const targetDay = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);

  const events = useDayEvents(p.calendarConnected, targetDay);
  const lanes = useMemo(() => assignLanes(events), [events]);

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
      <header className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--ios-border)" }}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDayOffset((d) => d - 1)}
            className="flex h-8 w-8 items-center justify-center rounded-full"
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
            className="rounded-full px-3 py-1 text-[12px] font-medium"
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
            className="flex h-8 w-8 items-center justify-center rounded-full"
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
          className="flex h-8 items-center rounded-full px-3 text-[12px] font-medium"
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

        <DayTimeline
          events={events}
          lanes={lanes}
          isToday={dayOffset === 0}
          calendarConnected={p.calendarConnected}
        />
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
  const items = useMemo(
    () =>
      foundations.filter((f) => {
        if (f.status === "completed") return false;
        if (f.snoozedUntil && new Date(f.snoozedUntil).getTime() > Date.now()) return false;
        return true;
      }),
    [foundations],
  );
  const dropoutCutoffHour = parseHourOf(prefs.workingHoursEnd ?? "22:00") - 1;
  const dropoutSoon = new Date().getHours() >= dropoutCutoffHour;

  if (items.length === 0) {
    return (
      <section>
        <h2 className="text-[20px] font-bold tracking-tight" style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}>
          Today's basics
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--ios-success)" }}>
          All ticked. Quiet day on the foundations front.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-[22px] font-bold tracking-tight" style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}>
        Today's basics
      </h2>
      <p className="mt-0.5 text-[12px]" style={{ color: dropoutSoon ? "var(--ios-warning)" : "var(--ios-text-secondary)" }}>
        {dropoutSoon ? "Late in the day — incomplete basics will drop out tonight" : "Tap to tick. Defer with a swipe-style button."}
      </p>
      <div className="mt-3 space-y-1.5">
        {items.map((f) => (
          <BasicRow
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
    </section>
  );
}

function BasicRow({
  foundation,
  onComplete,
  onDefer,
}: {
  foundation: Task;
  onComplete: () => void;
  onDefer: () => void;
}) {
  const isCounter = !!foundation.counter;
  const counterText =
    isCounter && foundation.counter
      ? `${foundation.counter.count}/${foundation.counter.target}`
      : "";
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-2.5"
      style={{ background: "var(--ios-surface)", border: "1px solid var(--ios-border)" }}
    >
      <button
        type="button"
        onClick={onComplete}
        className="flex h-8 w-8 flex-none items-center justify-center rounded-full"
        style={{ background: "var(--ios-success)", color: "white" }}
        aria-label="Complete"
      >
        {isCounter ? (
          <span className="text-[12px] font-bold">+1</span>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold" style={{ color: "var(--ios-text)" }}>
          {foundation.title}
          {counterText && <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--ios-text-muted)" }}>{counterText}</span>}
        </div>
        <div className="text-[11px]" style={{ color: "var(--ios-text-muted)" }}>
          {foundation.theme && foundation.theme !== "personal" ? foundation.theme : "foundation"}
          {foundation.recurrence && foundation.recurrence !== "none" && ` · ${foundation.recurrence}`}
        </div>
      </div>
      <button
        type="button"
        onClick={onDefer}
        className="flex-none rounded-md px-2 py-1 text-[11px] font-medium"
        style={{ color: "var(--ios-text-secondary)", background: "var(--ios-surface-elev)" }}
      >
        Later
      </button>
    </div>
  );
}

// ─── DAY TIMELINE (with lanes) ───────────────────────────────────────
const PX_PER_MIN = 1.2;
const TIMELINE_START_HOUR = 6;
const TIMELINE_END_HOUR = 23;

function DayTimeline({
  events,
  lanes,
  isToday,
  calendarConnected,
}: {
  events: CalendarEvent[];
  lanes: Map<string, number>;
  isToday: boolean;
  calendarConnected: boolean;
}) {
  const totalMin = (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60;
  const totalHeight = totalMin * PX_PER_MIN;
  const laneCount = Math.max(1, ...Array.from(lanes.values()).map((l) => l + 1));

  const nowOffsetPx = useMemo(() => {
    if (!isToday) return null;
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes() - TIMELINE_START_HOUR * 60;
    if (min < 0 || min > totalMin) return null;
    return min * PX_PER_MIN;
  }, [isToday, totalMin]);

  // Auto-scroll-into-view on mount when looking at today
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (nowOffsetPx == null || !containerRef.current) return;
    const el = containerRef.current;
    el.scrollTop = Math.max(0, nowOffsetPx - 120);
  }, [nowOffsetPx]);

  return (
    <section>
      <h2 className="text-[22px] font-bold tracking-tight" style={{ color: "var(--ios-text)", letterSpacing: "-0.02em" }}>
        Day timeline
      </h2>
      <p className="mt-0.5 text-[12px]" style={{ color: "var(--ios-text-secondary)" }}>
        {!calendarConnected
          ? "Connect Google Calendar on Desktop to populate this."
          : events.length === 0
            ? "Nothing scheduled."
            : `${events.length} event${events.length === 1 ? "" : "s"} · ${laneCount} lane${laneCount === 1 ? "" : "s"}`}
      </p>

      <div
        ref={containerRef}
        className="mt-3 overflow-y-auto rounded-2xl"
        style={{
          background: "var(--ios-surface)",
          border: "1px solid var(--ios-border)",
          maxHeight: "60vh",
        }}
      >
        <div className="relative" style={{ height: `${totalHeight}px` }}>
          {/* Hour grid */}
          {Array.from({ length: TIMELINE_END_HOUR - TIMELINE_START_HOUR + 1 }, (_, i) => {
            const h = TIMELINE_START_HOUR + i;
            return (
              <div
                key={h}
                className="absolute inset-x-0 flex items-center"
                style={{ top: `${i * 60 * PX_PER_MIN}px`, height: 0 }}
              >
                <span
                  className="ml-2 text-[10px] font-medium"
                  style={{ color: "var(--ios-text-muted)" }}
                >
                  {h.toString().padStart(2, "0")}:00
                </span>
                <div
                  className="ml-2 flex-1 border-t"
                  style={{ borderColor: "var(--ios-border)" }}
                />
              </div>
            );
          })}

          {/* Now line */}
          {nowOffsetPx != null && (
            <div
              className="absolute inset-x-0 z-10 flex items-center"
              style={{ top: `${nowOffsetPx}px`, height: 0 }}
            >
              <span
                className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full"
                style={{ background: "var(--ios-danger)" }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              <div
                className="flex-1"
                style={{ borderTop: "1.5px solid var(--ios-danger)" }}
              />
            </div>
          )}

          {/* Events */}
          {events.map((ev) => {
            if (!ev.start || !ev.end || ev.allDay) return null;
            const start = new Date(ev.start);
            const end = new Date(ev.end);
            const startMin = start.getHours() * 60 + start.getMinutes() - TIMELINE_START_HOUR * 60;
            const endMin = end.getHours() * 60 + end.getMinutes() - TIMELINE_START_HOUR * 60;
            if (endMin <= 0 || startMin >= totalMin) return null;
            const top = Math.max(0, startMin) * PX_PER_MIN;
            const height = Math.max(20, (Math.min(endMin, totalMin) - Math.max(0, startMin)) * PX_PER_MIN);
            const lane = lanes.get(ev.id) ?? 0;
            const laneWidth = `calc((100% - 56px) / ${laneCount})`;
            const left = `calc(48px + ${lane} * ${laneWidth})`;
            const accent = ev.calendarColor || "#A78BFA";
            return (
              <div
                key={ev.id}
                className="absolute overflow-hidden rounded-md px-1.5 py-1"
                style={{
                  top: `${top}px`,
                  height: `${height}px`,
                  left,
                  width: laneWidth,
                  marginRight: "8px",
                  background: `${accent}22`,
                  borderLeft: `2px solid ${accent}`,
                }}
              >
                <div
                  className="truncate text-[11px] font-semibold leading-tight"
                  style={{ color: "var(--ios-text)" }}
                >
                  {ev.summary || "(no title)"}
                </div>
                <div className="text-[9px]" style={{ color: "var(--ios-text-muted)" }}>
                  {fmtTime(start)} · {Math.round((end.getTime() - start.getTime()) / 60_000)}m
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
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
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
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

// ─── LANES ───────────────────────────────────────────────────────────
function assignLanes(events: CalendarEvent[]): Map<string, number> {
  const result = new Map<string, number>();
  const sorted = [...events]
    .filter((e) => e.start && e.end && !e.allDay)
    .sort((a, b) => new Date(a.start!).getTime() - new Date(b.start!).getTime());
  const laneEnds: number[] = []; // last end-time per lane
  for (const ev of sorted) {
    const start = new Date(ev.start!).getTime();
    const end = new Date(ev.end!).getTime();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    result.set(ev.id, lane);
  }
  return result;
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
