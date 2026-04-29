import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

interface PerUser {
  userId: string;
  counts: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface AdminPayload {
  windowDays: number;
  totalEvents: number;
  totalUsers: number;
  global: {
    counts: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  perUser: PerUser[];
}

interface MePayload {
  windowDays: number;
  totalEvents: number;
  counts: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Two-mode metrics panel.
 *  - "me": every signed-in user can see their own usage transparency.
 *  - "admin": only emails in backend's ADMIN_EMAILS env var get the global
 *    cross-user view. The route returns 403 for everyone else.
 *
 * The component tries the admin route first; if that 403s, it silently falls
 * back to the per-user view. Cleaner UX than asking the user "are you admin"
 * up front.
 */
export function AdminMetrics() {
  const [days, setDays] = useState(30);
  const [admin, setAdmin] = useState<AdminPayload | null>(null);
  const [me, setMe] = useState<MePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      const adminRes = await apiFetch(`/api/metrics/admin?daysBack=${days}`);
      if (adminRes.ok) {
        const data = (await adminRes.json()) as AdminPayload;
        setAdmin(data);
        setMe(null);
      } else {
        // Fall back to per-user usage view.
        const meRes = await apiFetch(`/api/metrics/me?daysBack=${days}`);
        if (!meRes.ok) {
          throw new Error(`HTTP ${meRes.status}`);
        }
        const data = (await meRes.json()) as MePayload;
        setMe(data);
        setAdmin(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const fmtUsd = (n: number) =>
    n < 0.01 ? `<$0.01` : `$${n.toFixed(2)}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-600">Window:</label>
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              days === d
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
            }`}
          >
            {d}d
          </button>
        ))}
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ml-auto btn-secondary text-xs"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}

      {admin && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white p-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                Users
              </div>
              <div className="text-lg font-semibold">{admin.totalUsers}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                Events
              </div>
              <div className="text-lg font-semibold">{admin.totalEvents}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                Tokens (in/out)
              </div>
              <div className="text-sm font-semibold">
                {admin.global.inputTokens.toLocaleString()} /{" "}
                {admin.global.outputTokens.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2">
              <div className="text-[10px] uppercase tracking-wide text-emerald-700">
                Est. cost
              </div>
              <div className="text-lg font-semibold text-emerald-900">
                {fmtUsd(admin.global.estimatedCostUsd)}
              </div>
            </div>
          </div>

          <div>
            <h6 className="mb-1 text-xs font-semibold text-slate-700">
              Events by type
            </h6>
            <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {Object.entries(admin.global.counts)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => (
                  <li
                    key={type}
                    className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1"
                  >
                    <span className="font-mono text-[11px] text-slate-700">
                      {type}
                    </span>
                    <span className="font-semibold">{count}</span>
                  </li>
                ))}
            </ul>
          </div>

          <div>
            <h6 className="mb-1 text-xs font-semibold text-slate-700">
              Per-user (sorted by est. cost)
            </h6>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-1 pr-2">user_id (anon)</th>
                    <th className="py-1 pr-2">events</th>
                    <th className="py-1 pr-2">tokens</th>
                    <th className="py-1">est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {admin.perUser.map((u) => {
                    const eventTotal = Object.values(u.counts).reduce(
                      (a, b) => a + b,
                      0,
                    );
                    return (
                      <tr key={u.userId} className="border-b border-slate-100">
                        <td className="py-1 pr-2 font-mono text-[10px] text-slate-600">
                          {u.userId.slice(0, 8)}…
                        </td>
                        <td className="py-1 pr-2">{eventTotal}</td>
                        <td className="py-1 pr-2 text-slate-600">
                          {(u.inputTokens + u.outputTokens).toLocaleString()}
                        </td>
                        <td className="py-1 font-semibold">
                          {fmtUsd(u.estimatedCostUsd)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {me && (
        <>
          <p className="text-xs text-slate-500">
            Your own usage in the last {me.windowDays} days.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-slate-200 bg-white p-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                Events
              </div>
              <div className="text-lg font-semibold">{me.totalEvents}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2">
              <div className="text-[10px] uppercase tracking-wide text-emerald-700">
                Est. cost
              </div>
              <div className="text-lg font-semibold text-emerald-900">
                {fmtUsd(me.estimatedCostUsd)}
              </div>
            </div>
          </div>
          <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {Object.entries(me.counts)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <li
                  key={type}
                  className="flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1"
                >
                  <span className="font-mono text-[11px] text-slate-700">
                    {type}
                  </span>
                  <span className="font-semibold">{count}</span>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
