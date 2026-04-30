import { useState } from "react";
import type { AuthState } from "@/lib/useAuth";

interface Props {
  auth: AuthState;
}

export function Login({ auth }: Props) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await auth.signInWithMagicLink(email.trim());
    setBusy(false);
    if (res.error) setErr(res.error);
    else setMsg(`Check ${email} for a sign-in link.`);
  };

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight">Focus3</h1>
      <p className="mt-1 text-sm text-slate-600">
        Three things, every day. Your non-negotiables, surfaced.
      </p>

      <form onSubmit={handleSubmit} className="card mt-6 space-y-3">
        <h2 className="text-base font-semibold">Sign in</h2>
        <p className="text-xs text-slate-500">
          We'll email you a one-tap sign-in link. No password.
        </p>
        <div>
          <label className="text-xs font-medium text-slate-700">Email</label>
          <input
            type="email"
            className="input mt-1"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <button
          type="submit"
          className="btn-primary w-full"
          disabled={busy || !email.trim()}
        >
          {busy ? "Sending…" : "Send sign-in link"}
        </button>
        {msg && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            {msg}
          </div>
        )}
        {err && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {err}
          </div>
        )}
      </form>
    </div>
  );
}
