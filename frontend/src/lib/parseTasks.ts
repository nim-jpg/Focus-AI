import {
  PRIVACY_LEVELS,
  RECURRENCE_PATTERNS,
  THEMES,
  URGENCY_LEVELS,
  type Privacy,
  type Recurrence,
  type Theme,
  type Urgency,
} from "@/types/task";
import type { NewTaskInput } from "./useTasks";
import { apiFetch } from "./api";

export class ParseUnavailableError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ParseUnavailableError";
  }
}

interface RawTask {
  title?: unknown;
  description?: unknown;
  theme?: unknown;
  urgency?: unknown;
  privacy?: unknown;
  recurrence?: unknown;
  isWork?: unknown;
  isBlocker?: unknown;
  estimatedMinutes?: unknown;
  dueDate?: unknown;
}

const THEME_SET = new Set<string>(THEMES);
const URGENCY_SET = new Set<string>(URGENCY_LEVELS);
const PRIVACY_SET = new Set<string>(PRIVACY_LEVELS);
const RECURRENCE_SET = new Set<string>(RECURRENCE_PATTERNS);

function asTheme(v: unknown): Theme {
  return typeof v === "string" && THEME_SET.has(v) ? (v as Theme) : "personal";
}
function asUrgency(v: unknown): Urgency {
  return typeof v === "string" && URGENCY_SET.has(v) ? (v as Urgency) : "normal";
}
function asPrivacy(v: unknown): Privacy {
  return typeof v === "string" && PRIVACY_SET.has(v) ? (v as Privacy) : "private";
}
function asRecurrence(v: unknown): Recurrence {
  return typeof v === "string" && RECURRENCE_SET.has(v) ? (v as Recurrence) : "none";
}

function asDueDate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function asMinutes(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 30;
  return Math.min(480, Math.max(5, Math.round(n)));
}

function normalizeRaw(raw: RawTask): NewTaskInput | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;

  const theme = asTheme(raw.theme);
  return {
    title: title.slice(0, 80),
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : undefined,
    theme,
    urgency: asUrgency(raw.urgency),
    privacy: asPrivacy(raw.privacy),
    recurrence: asRecurrence(raw.recurrence),
    isWork: typeof raw.isWork === "boolean" ? raw.isWork : theme === "work",
    isBlocker: raw.isBlocker === true,
    blockedBy: [],
    estimatedMinutes: asMinutes(raw.estimatedMinutes),
    dueDate: asDueDate(raw.dueDate),
  };
}

export async function parseBrainDump(text: string): Promise<NewTaskInput[]> {
  let res: Response;
  try {
    res = await apiFetch("/api/parse-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    throw new ParseUnavailableError(
      err instanceof Error ? err.message : "network_error",
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ParseUnavailableError(
      body.message ?? body.error ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  const data = (await res.json()) as { tasks?: RawTask[] };
  if (!Array.isArray(data.tasks)) return [];

  return data.tasks
    .map(normalizeRaw)
    .filter((t): t is NewTaskInput => t !== null);
}
