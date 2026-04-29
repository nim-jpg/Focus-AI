import { useMemo } from "react";
import type { Goal, Task } from "@/types/task";
import { isFoundation, streakDays, wasCompletedToday } from "@/lib/recurrence";
import { ThemeBadge } from "./ThemeBadge";

interface Props {
  tasks: Task[];
  goals: Goal[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Achievements({ tasks, goals }: Props) {
  const stats = useMemo(() => {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const weekAgo = today.getTime() - 7 * DAY_MS;

    // Completed (one-shot) tasks in the last 7 days
    const completedThisWeek = tasks.filter(
      (t) =>
        t.recurrence === "none" &&
        t.status === "completed" &&
        new Date(t.updatedAt).getTime() >= weekAgo,
    );

    // Foundations done today
    const foundations = tasks.filter((t) => isFoundation(t));
    const foundationsDoneToday = foundations.filter((t) =>
      wasCompletedToday(t, now),
    );

    // Top streaks
    const topStreaks = foundations
      .map((t) => ({ task: t, streak: streakDays(t, now) }))
      .filter((s) => s.streak > 0)
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 5);

    // Daily completion sparkline — last 14 days
    const dayBuckets: number[] = [];
    for (let d = 13; d >= 0; d--) {
      const dayStart = today.getTime() - d * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      const oneShots = tasks.filter(
        (t) =>
          t.recurrence === "none" &&
          t.status === "completed" &&
          new Date(t.updatedAt).getTime() >= dayStart &&
          new Date(t.updatedAt).getTime() < dayEnd,
      ).length;
      const habits = foundations.filter((t) =>
        (t.completionLog ?? []).includes(isoDate(new Date(dayStart))),
      ).length;
      dayBuckets.push(oneShots + habits);
    }
    const maxBucket = Math.max(1, ...dayBuckets);

    // Goals: how many touched in the last 7 days
    const goalsTouchedThisWeek = goals.filter((g) =>
      tasks.some(
        (t) =>
          (t.goalIds ?? []).includes(g.id) &&
          ((t.lastCompletedAt &&
            new Date(t.lastCompletedAt).getTime() >= weekAgo) ||
            (t.status === "completed" &&
              new Date(t.updatedAt).getTime() >= weekAgo)),
      ),
    );

    return {
      completedThisWeek,
      foundationsDoneToday,
      foundationsTotal: foundations.length,
      topStreaks,
      dayBuckets,
      maxBucket,
      goalsTouchedThisWeek,
    };
  }, [tasks, goals]);

  return (
    <section>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">This week's wins</h2>
        <p className="text-xs text-slate-500">
          A snapshot of momentum — what you've actually moved forward.
        </p>
      </div>

      {/* Headline number cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-2xl font-bold text-emerald-900">
            {stats.completedThisWeek.length}
          </p>
          <p className="text-xs text-emerald-800">tasks completed (7d)</p>
        </div>
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
          <p className="text-2xl font-bold text-blue-900">
            {stats.foundationsDoneToday.length}/{stats.foundationsTotal}
          </p>
          <p className="text-xs text-blue-800">foundations done today</p>
        </div>
        <div className="rounded-md border border-orange-200 bg-orange-50 p-3">
          <p className="text-2xl font-bold text-orange-900">
            {stats.topStreaks[0]?.streak ?? 0}
            <span className="text-sm font-normal"> 🔥</span>
          </p>
          <p className="text-xs text-orange-800">
            longest active streak (days)
          </p>
        </div>
        <div className="rounded-md border border-purple-200 bg-purple-50 p-3">
          <p className="text-2xl font-bold text-purple-900">
            {stats.goalsTouchedThisWeek.length}/{goals.length}
          </p>
          <p className="text-xs text-purple-800">goals touched (7d)</p>
        </div>
      </div>

      {/* Sparkline of last 14 days */}
      <div className="mt-4 rounded-md border border-slate-200 bg-white p-3">
        <p className="mb-2 text-xs font-medium text-slate-700">
          Last 14 days — actions per day
        </p>
        <div className="flex h-20 items-end gap-1">
          {stats.dayBuckets.map((count, i) => {
            const height = `${(count / stats.maxBucket) * 100}%`;
            const isToday = i === stats.dayBuckets.length - 1;
            return (
              <div
                key={i}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${count} actions`}
              >
                <div className="flex w-full flex-1 items-end">
                  <div
                    className={`w-full rounded-t ${
                      isToday ? "bg-emerald-500" : "bg-slate-300"
                    }`}
                    style={{ height: count > 0 ? height : "2px" }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top streaks */}
      {stats.topStreaks.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-slate-700">
            Active streaks
          </p>
          <ul className="space-y-1">
            {stats.topStreaks.map((s) => (
              <li
                key={s.task.id}
                className="flex items-center justify-between rounded-md border border-orange-100 bg-orange-50/40 px-3 py-1.5 text-sm"
              >
                <span className="flex items-center gap-2">
                  <span>🔥</span>
                  <span className="font-medium text-slate-800">
                    {s.task.title}
                  </span>
                  <ThemeBadge theme={s.task.theme} />
                </span>
                <span className="font-mono text-orange-800">
                  {s.streak} day{s.streak === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recently completed */}
      {stats.completedThisWeek.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-slate-700">
            Recently completed
          </p>
          <ul className="space-y-1 text-sm">
            {stats.completedThisWeek
              .slice(0, 6)
              .sort(
                (a, b) =>
                  new Date(b.updatedAt).getTime() -
                  new Date(a.updatedAt).getTime(),
              )
              .map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-emerald-100 bg-emerald-50/40 px-3 py-1.5"
                >
                  <span className="flex items-center gap-2">
                    <span>✓</span>
                    <span className="font-medium text-slate-800 line-through">
                      {t.title}
                    </span>
                    <ThemeBadge theme={t.theme} />
                  </span>
                  <span className="text-xs text-slate-500">
                    {new Date(t.updatedAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
