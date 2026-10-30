// SQLite storage (Node's built-in node:sqlite, so there is no native module to
// build for each architecture). One file in the data folder holds everything:
// settings, people, who owns which book, proposals and the undo history.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type DB = DatabaseSync;

// Each entry runs once, in order, inside a transaction. Append only: never
// edit a migration that has shipped.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE widget_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  -- A person is a tag in Audiobookshelf. "folder" is their old per-person
  -- folder, if they had one: books found there are theirs.
  CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT NOT NULL,
    abs_user_id TEXT,
    folder TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX people_tag ON people (lower(tag));

  -- What Shelvarr wants to do with a book it found. Nothing moves until a
  -- proposal is applied. A row stays after it's done, so a file left in the
  -- incoming folder (for seeding) is never imported twice.
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,                -- library | incoming
    signature TEXT NOT NULL,            -- what was found (paths + sizes)
    source_dir TEXT NOT NULL,           -- relative to the scope's root
    files TEXT NOT NULL,                -- JSON: FoundFile[]
    author TEXT,
    title TEXT,
    narrator TEXT,
    year TEXT,
    confidence TEXT NOT NULL,           -- high | medium | low
    why TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- move | duplicate | conflict
    target_rel TEXT,                    -- duplicate/conflict: the book it matches
    resolution TEXT,                    -- conflict: keep_this | keep_other | keep_both
    suggestion TEXT,                    -- JSON: what an online lookup thinks it is
    owners TEXT NOT NULL DEFAULT '[]',  -- JSON: person ids
    status TEXT NOT NULL DEFAULT 'pending', -- pending | applied | skipped | failed
    error TEXT,
    dest_rel TEXT,                      -- where it ended up
    batch_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (scope, signature)
  );
  CREATE INDEX proposals_status ON proposals (status);

  -- Who a book belongs to, by its folder in the library ("Author/Title").
  CREATE TABLE owners (
    rel_path TEXT NOT NULL,
    person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    source TEXT NOT NULL,               -- folder | default | manual | abs
    created_at INTEGER NOT NULL,
    PRIMARY KEY (rel_path, person_id)
  );

  -- The tidy library as last read from disk, and its Audiobookshelf item.
  CREATE TABLE books (
    rel_path TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    title TEXT NOT NULL,
    size INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    abs_item_id TEXT,
    abs_tags TEXT,                      -- JSON, null until matched
    created_at INTEGER NOT NULL
  );

  -- Undo history: every file operation of one "apply".
  CREATE TABLE batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    label TEXT NOT NULL,
    ops TEXT NOT NULL,                  -- JSON: Op[]
    owners_before TEXT NOT NULL,        -- JSON: owner rows it replaced
    proposals TEXT NOT NULL,            -- JSON: proposal ids
    undone_at INTEGER
  );

  -- Listening progress saved before moving to one library.
  CREATE TABLE progress_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    abs_user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    old_path TEXT NOT NULL,             -- the item's folder or file, as Audiobookshelf saw it
    title TEXT,
    data TEXT NOT NULL,                 -- JSON: { progress, bookmarks }
    taken_at INTEGER NOT NULL,
    restored_at INTEGER,
    UNIQUE (abs_user_id, old_path)
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- moved | duplicate | owner | scan | access | undo | error
    message TEXT NOT NULL
  );
  CREATE INDEX activity_at ON activity (at DESC);
  `,
  `
  -- Which series a book seems to be in, waiting for approval. "none" means we
  -- looked and found nothing, so it isn't looked up on every pass.
  CREATE TABLE series_suggestions (
    rel_path TEXT PRIMARY KEY,
    series TEXT,
    sequence TEXT,
    source TEXT NOT NULL,               -- tags | metadata | title | online | you
    status TEXT NOT NULL DEFAULT 'pending', -- pending | applied | skipped | none
    updated_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// --- Settings ------------------------------------------------------------------

export interface Settings {
  absUrl: string;
  absToken: string;
  /** The one shared Audiobookshelf library. */
  absLibraryId: string;
  /** The audiobooks folder, as this container sees it. */
  libraryRoot: string;
  /** The same folder, as Audiobookshelf sees it. */
  absRoot: string;
  /** Tidy books go in this subfolder of the audiobooks folder. */
  destSubdir: string;
  /** Where downloads land (Shelfmark's audiobook destination). Empty: not watched. */
  incomingDir: string;
  /** What importing does to the download: hardlink/copy keep it (for seeding). */
  incomingMode: "hardlink" | "copy" | "move";
  /** Organize new downloads on their own when sure what they are. */
  autoOrganize: boolean;
  /** New downloads belong to these people until you add others. */
  defaultOwners: number[];
  scanIntervalMinutes: number;
  /** A download is left alone until nothing has changed for this long. */
  settleMinutes: number;
  accessReminderDismissed: string[];
  adminUsername: string;
  adminPasswordHash: string;
  setupComplete: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  absUrl: "",
  absToken: "",
  absLibraryId: "",
  libraryRoot: process.env.AUDIOBOOKS_DIR || "/audiobooks",
  absRoot: process.env.AUDIOBOOKS_DIR || "/audiobooks",
  destSubdir: "library",
  incomingDir: process.env.INCOMING_DIR || "",
  incomingMode: "hardlink",
  autoOrganize: true,
  defaultOwners: [],
  scanIntervalMinutes: 5,
  settleMinutes: 2,
  accessReminderDismissed: [],
  adminUsername: "",
  adminPasswordHash: "",
  setupComplete: false,
};

export function getSettings(db: DB): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) if (row.key in DEFAULT_SETTINGS) out[row.key] = JSON.parse(row.value);
  return out as unknown as Settings;
}

export function saveSettings(db: DB, patch: Partial<Settings>) {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  tx(db, () => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      stmt.run(key, JSON.stringify(value));
    }
  });
}

// --- Rows ----------------------------------------------------------------------

export interface Person {
  id: number;
  name: string;
  tag: string;
  color: string;
  abs_user_id: string | null;
  folder: string | null;
  created_at: number;
}

export function listPeople(db: DB): Person[] {
  return db.prepare("SELECT * FROM people ORDER BY created_at, id").all() as unknown as Person[];
}

export function logActivity(db: DB, kind: string, message: string) {
  // The same failure on every scan would bury everything else.
  if (kind === "error") {
    const recent = db.prepare("SELECT 1 FROM activity WHERE kind = 'error' AND message = ? AND at > ? LIMIT 1").get(message, Date.now() - 6 * 3_600_000);
    if (recent) return;
  }
  db.prepare("INSERT INTO activity (at, kind, message) VALUES (?, ?, ?)").run(Date.now(), kind, message);
  db.prepare("DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET 2000)").run();
}
