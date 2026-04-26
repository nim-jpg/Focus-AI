import type { Goal, Task, UserPrefs } from "@/types/task";

export interface BackupBundle {
  schema: "focus3-backup";
  version: 1;
  exportedAt: string;
  tasks: Task[];
  goals: Goal[];
  prefs: UserPrefs;
}

/** Pull current localStorage state into a BackupBundle and download it. */
export function downloadBackup(
  tasks: Task[],
  goals: Goal[],
  prefs: UserPrefs,
): void {
  const bundle: BackupBundle = {
    schema: "focus3-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks,
    goals,
    prefs,
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `focus3-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export class BackupError extends Error {}

export async function readBackupFile(file: File): Promise<BackupBundle> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError("File isn't valid JSON.");
  }
  const obj = parsed as Partial<BackupBundle>;
  if (
    !obj ||
    obj.schema !== "focus3-backup" ||
    !Array.isArray(obj.tasks) ||
    !Array.isArray(obj.goals) ||
    !obj.prefs
  ) {
    throw new BackupError("Not a Focus3 backup file (schema mismatch).");
  }
  return obj as BackupBundle;
}
