import { getSupabase, isMultiUser } from "../db.js";

/**
 * Server-side metrics logger. Fire-and-forget — never blocks the user-facing
 * response, never throws if the table is missing or RLS misconfigured.
 *
 * Privacy contract:
 *  - NEVER pass task titles, descriptions, or any content here.
 *  - `metadata` should be limited to non-content context (route name, status,
 *    whether the call succeeded, etc.).
 *  - For AI calls, model + token counts are the ONLY cost-bearing data we
 *    retain; the prompt + completion themselves are not stored.
 */
export interface MetricsEventInput {
  userId: string | undefined;
  eventType: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export async function logMetricsEvent(ev: MetricsEventInput): Promise<void> {
  if (!isMultiUser()) return;
  if (!ev.userId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from("metrics_events").insert({
      user_id: ev.userId,
      event_type: ev.eventType,
      model: ev.model ?? null,
      input_tokens: ev.inputTokens ?? null,
      output_tokens: ev.outputTokens ?? null,
      metadata: ev.metadata ?? null,
    });
  } catch {
    // Don't crash request handlers on metrics failures.
  }
}

/**
 * Fire-and-forget convenience for AI route handlers. Pulls token counts off
 * the Anthropic SDK's response shape if available; otherwise records the
 * call without cost data so the count still aggregates.
 */
export function logAiUsage(
  userId: string | undefined,
  routeName: string,
  completion: {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null,
  ok: boolean,
): void {
  void logMetricsEvent({
    userId,
    eventType: `ai_${routeName}`,
    model: completion?.model,
    inputTokens: completion?.usage?.input_tokens,
    outputTokens: completion?.usage?.output_tokens,
    metadata: { ok },
  });
}
