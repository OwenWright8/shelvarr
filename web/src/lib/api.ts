// Typed access to the server's /api. Errors carry the server's message.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/account")) {
      window.dispatchEvent(new Event("shelvarr:signed-out"));
    }
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);

// --- Shapes ----------------------------------------------------------------------

export interface Session {
  authenticated: boolean;
  needsAccount: boolean;
  setupComplete: boolean;
  version: string;
}

export interface Person {
  id: number;
  name: string;
  tag: string;
  color: string;
  absUserId: string | null;
  folder: string | null;
  count?: number;
  onlyCount?: number;
}

export interface Proposal {
  id: number;
  scope: "library" | "incoming";
  sourceDir: string;
  fileCount: number;
  audioCount: number;
  files: string[];
  author: string | null;
  title: string | null;
  narrator: string | null;
  year: string | null;
  confidence: "high" | "medium" | "low";
  why: string;
  size: number;
  kind: "move" | "duplicate" | "conflict";
  targetRel: string | null;
  resolution: "keep_this" | "keep_other" | "keep_both" | null;
  suggestion: { title: string; author: string } | null;
  owners: number[];
  status: "pending" | "applied" | "skipped" | "failed";
  error: string | null;
  dest: string | null;
  batchId: number | null;
  updatedAt: number;
}

export interface Book {
  rel: string;
  author: string;
  title: string;
  size: number;
  fileCount: number;
  itemId: string | null;
  owners: number[];
}

export interface SeriesSuggestion {
  rel: string;
  series: string;
  sequence: string | null;
  source: "tags" | "metadata" | "title" | "online" | "you";
  author: string;
  title: string;
  itemId: string | null;
}

export interface EngineStatus {
  running: string | null;
  lastScanAt: number | null;
  lastError: string | null;
  nextAt: number | null;
}

export interface Activity {
  id: number;
  at: number;
  kind: "moved" | "duplicate" | "owner" | "scan" | "access" | "undo" | "error";
  message: string;
}

export interface Batch {
  id: number;
  at: number;
  label: string;
  books: number;
  files: number;
  undone: boolean;
  canUndo: boolean;
}

export interface Overview {
  connections: { abs: boolean; library: boolean; incoming: boolean };
  totals: { books: number; authors: number; size: number; unowned: number; shared: number; toReview: number; duplicateSize: number; trashSize: number };
  people: (Person & { count: number; onlyCount: number })[];
  activity: Activity[];
  status: EngineStatus;
}

export interface SettingsData {
  absUrl: string;
  absTokenSet: boolean;
  absLibraryId: string;
  libraryRoot: string;
  absRoot: string;
  destSubdir: string;
  incomingDir: string;
  incomingMode: "hardlink" | "copy" | "move";
  autoOrganize: boolean;
  defaultOwners: number[];
  scanIntervalMinutes: number;
  settleMinutes: number;
  accessReminderDismissed: string[];
  adminUsername: string;
  setupComplete: boolean;
}

export interface AbsLibrary {
  id: string;
  name: string;
  path: string | null;
}

export interface AccessUser {
  id: string;
  name: string;
  isAdmin: boolean;
  allowedTags: string[];
  personId: number | null;
  meantToSeeAll: boolean;
}

export interface Folders {
  library: { path: string; exists: boolean; writable: boolean };
  incoming: { path: string; exists: boolean; writable: boolean };
  folders: { name: string; books: number; size: number; role: "person" | "library" | "ignored" }[];
}

export interface MigrateState {
  libraries: AbsLibrary[];
  sharedLibraryId: string;
  sharedPath: string;
  snapshot: { entries: number; restored: number };
  pending: number;
  applied: number;
}

export interface About {
  version: string;
  repo: string;
  update: { enabled: boolean; latest: string | null; url: string | null; notes: string | null; publishedAt: string | null; checkedAt: number | null };
  updateAvailable: boolean;
}

export function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
