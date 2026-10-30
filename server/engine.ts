// The organizer. It finds books, proposes what to do with them, and applies
// what's approved:
//
//   Scan      Reads the old per-person folders, the tidy library and the
//             incoming folder, and writes proposals. Changes nothing on disk.
//   Apply     Moves files to library/Author/Title, merging exact duplicates.
//             Every step is recorded so it can be undone, and anything removed
//             goes to a hidden trash folder until you empty it.
//   Sync      Makes Audiobookshelf's tags match who owns each book.
//
// New downloads Shelvarr is sure about are applied on their own. Everything
// else waits on the Review page.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Abs, type AbsItem, type AbsUser } from "./abs.ts";
import { type DB, type Person, type Settings, getSettings, listPeople, logActivity, tx } from "./db.ts";
import { type Op, type OpType, assertInside, folderSize, placeFile, quickHash, removeEmptyUp, sha256, undoOp } from "./files.ts";
import { bookTitle, firstAuthor, nameKey, parseName, safeSegment } from "./naming.ts";
import { type Confidence, type FoundBook, type FoundFile, type TagReader, scanBooks, walkTree } from "./scan.ts";

export const TRASH_DIR = ".shelvarr-trash";

export type Scope = "library" | "incoming";

export interface ProposalRow {
  id: number;
  scope: Scope;
  signature: string;
  source_dir: string;
  files: string;
  author: string | null;
  title: string | null;
  narrator: string | null;
  year: string | null;
  confidence: Confidence;
  why: string;
  size: number;
  kind: "move" | "duplicate" | "conflict";
  target_rel: string | null;
  resolution: "keep_this" | "keep_other" | "keep_both" | null;
  suggestion: string | null;
  owners: string;
  status: "pending" | "applied" | "skipped" | "failed";
  error: string | null;
  dest_rel: string | null;
  batch_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface EngineStatus {
  running: string | null;
  lastScanAt: number | null;
  lastError: string | null;
  nextAt: number | null;
}

/** Where a book belongs: "Author/Title", using the spelling already in the library. */
export function destFor(author: string, title: string, authors: Map<string, string> = new Map()): string {
  const a = authors.get(nameKey(author)) ?? safeSegment(author);
  return `${a}/${safeSegment(title)}`;
}

function signatureOf(book: FoundBook): string {
  const parts = book.files.filter((f) => f.audio).map((f) => `${f.path}\0${f.size}`).sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Audio file sizes, in order: two copies of a book have the same list. */
function sizesOf(files: FoundFile[]): string {
  return files.filter((f) => f.audio).map((f) => f.size).sort((a, b) => a - b).join(",");
}

export class Engine {
  db: DB;
  status: EngineStatus = { running: null, lastScanAt: null, lastError: null, nextAt: null };
  reader?: TagReader;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;

  constructor(db: DB, reader?: TagReader) {
    this.db = db;
    this.reader = reader;
  }

  settings(): Settings {
    return getSettings(this.db);
  }

  abs(s = this.settings()): Abs | null {
    return s.absUrl && s.absToken ? new Abs(s.absUrl, s.absToken) : null;
  }

  destRoot(s = this.settings()): string {
    return path.join(s.libraryRoot, s.destSubdir);
  }

  rootOf(scope: Scope, s = this.settings()): string {
    return scope === "incoming" ? s.incomingDir : s.libraryRoot;
  }

  // --- Scheduling -------------------------------------------------------------

  start() {
    this.schedule(5_000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs?: number) {
    if (this.timer) clearTimeout(this.timer);
    const delay = delayMs ?? Math.max(1, this.settings().scanIntervalMinutes || 5) * 60_000;
    this.status.nextAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.exclusive("Checking for new books", () => this.tick()).catch(() => {}).finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  /** One thing at a time: a scan must never run while files are moving. */
  async exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    while (this.current) await this.current.catch(() => {});
    this.status = { ...this.status, running: label, lastError: null };
    const run = fn();
    this.current = run;
    try {
      return await run;
    } catch (err) {
      this.status.lastError = errorText(err);
      logActivity(this.db, "error", `${label}: ${errorText(err)}`);
      throw err;
    } finally {
      this.current = null;
      this.status.running = null;
    }
  }

  /** The regular pass: pick up new downloads, then bring tags up to date. */
  async tick() {
    const s = this.settings();
    if (s.incomingDir && fs.existsSync(s.incomingDir)) {
      await this.scanIncoming();
      await this.lookupUnsure();
      if (s.autoOrganize) await this.applyProposals(this.autoApplicable(), "New downloads");
    }
    await this.syncAbs();
  }

  // --- Scan -----------------------------------------------------------------------

  private ownerFolders(people: Person[]): Map<string, Person> {
    return new Map(people.filter((p) => p.folder).map((p) => [p.folder!, p]));
  }

  /** The tidy library as it is on disk now. Books sitting exactly at Author/Title. */
  private async readDest(s: Settings): Promise<{ tidy: FoundBook[]; untidy: FoundBook[] }> {
    const root = this.destRoot(s);
    if (!fs.existsSync(root)) return { tidy: [], untidy: [] };
    const found = await scanBooks(root, { reader: this.reader });
    const tidy: FoundBook[] = [];
    const untidy: FoundBook[] = [];
    for (const b of found) (isTidy(b) ? tidy : untidy).push(b);
    this.rememberBooks(tidy);
    return { tidy, untidy };
  }

  private rememberBooks(tidy: FoundBook[]) {
    const upsert = this.db.prepare(`
      INSERT INTO books (rel_path, author, title, size, file_count, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (rel_path) DO UPDATE SET author = excluded.author, title = excluded.title, size = excluded.size, file_count = excluded.file_count
    `);
    tx(this.db, () => {
      const seen = new Set<string>();
      for (const b of tidy) {
        const [author, title] = b.dir.split("/");
        upsert.run(b.dir, author, title, b.size, b.files.length, Date.now());
        seen.add(b.dir);
      }
      for (const row of this.db.prepare("SELECT rel_path FROM books").all() as { rel_path: string }[]) {
        if (!seen.has(row.rel_path)) this.db.prepare("DELETE FROM books WHERE rel_path = ?").run(row.rel_path);
      }
    });
  }

  /** Looks through the old per-person folders and the library for anything to tidy. */
  async scanLibrary(): Promise<number> {
    const s = this.settings();
    const people = listPeople(this.db);
    const { tidy, untidy } = await this.readDest(s);
    const destPrefix = s.destSubdir;
    const found: { book: FoundBook; owners: number[] }[] = untidy.map((book) => ({
      // Paths are relative to the audiobooks folder from here on.
      book: rebase(book, destPrefix),
      owners: [],
    }));
    for (const [folder, person] of this.ownerFolders(people)) {
      if (!fs.existsSync(path.join(s.libraryRoot, folder))) continue;
      for (const book of await scanBooks(s.libraryRoot, { start: folder, reader: this.reader })) {
        found.push({ book, owners: [person.id] });
      }
    }
    const added = this.propose("library", found, tidy, s);
    this.status.lastScanAt = Date.now();
    logActivity(this.db, "scan", added ? `Scanned the library: ${plural(added, "new suggestion")}` : "Scanned the library: nothing new to tidy");
    return added;
  }

  /** Looks for new downloads. Anything still changing is left for the next pass. */
  async scanIncoming(): Promise<number> {
    const s = this.settings();
    const { tidy } = await this.readDest(s);
    const settled = Date.now() - s.settleMinutes * 60_000;
    const found = (await scanBooks(s.incomingDir, { reader: this.reader }))
      .filter((b) => !b.busy && b.newestMtimeMs <= settled)
      .map((book) => ({ book, owners: s.defaultOwners }));
    const added = this.propose("incoming", found, tidy, s);
    this.status.lastScanAt = Date.now();
    return added;
  }

  /**
   * Turns what was found into proposals. A book with the same audio as one we
   * know is a duplicate (to merge); one with the same name but different audio
   * is a conflict (a person chooses); anything else is a plain move.
   */
  private propose(scope: Scope, found: { book: FoundBook; owners: number[] }[], tidy: FoundBook[], s: Settings): number {
    const root = this.rootOf(scope, s);
    const destRoot = this.destRoot(s);
    const authors = new Map<string, string>();
    for (const b of tidy) {
      const a = b.dir.split("/")[0];
      authors.set(nameKey(a), a);
    }
    // Known books: what's in the library now, plus what's already going there.
    const known: { rel: string; key: string; sizes: string; files: { abs: string; audio: boolean; size: number }[] }[] = tidy.map((b) => ({
      rel: b.dir,
      key: bookKey(b.dir),
      sizes: sizesOf(b.files),
      files: b.files.map((f) => ({ abs: path.join(destRoot, f.path), audio: f.audio, size: f.size })),
    }));
    for (const p of this.db.prepare("SELECT * FROM proposals WHERE kind = 'move' AND status = 'pending'").all() as unknown as ProposalRow[]) {
      if (!p.author || !p.title) continue;
      const files = JSON.parse(p.files) as FoundFile[];
      const rel = destFor(p.author, p.title, authors);
      known.push({ rel, key: bookKey(rel), sizes: sizesOf(files), files: files.map((f) => ({ abs: path.join(this.rootOf(p.scope, s), f.path), audio: f.audio, size: f.size })) });
    }
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO proposals (scope, signature, source_dir, files, author, title, narrator, year, confidence, why, size, kind, target_rel, owners, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    // Books already at home in a person's folder sort first, so a copy in
    // one person's folder and another's merge the same way every time.
    for (const { book, owners } of [...found].sort((a, b) => a.book.dir.localeCompare(b.book.dir))) {
      const signature = signatureOf(book);
      const seen = this.db.prepare("SELECT 1 FROM proposals WHERE scope = ? AND signature = ?").get(scope, signature);
      if (seen) continue;
      for (const b of [book]) if (b.author) authors.set(nameKey(b.author), authors.get(nameKey(b.author)) ?? safeSegment(b.author));
      const rel = book.author && book.title ? destFor(book.author, book.title, authors) : null;
      const sizes = sizesOf(book.files);
      // Same audio anywhere is the same book, whatever it's called.
      const twin = known.find((k) => k.sizes === sizes && sameQuick(k.files, book.files, root));
      const namesake = rel ? known.find((k) => k.key === bookKey(rel)) : undefined;
      const kind = twin ? "duplicate" : namesake ? "conflict" : "move";
      const target = twin?.rel ?? namesake?.rel ?? null;
      insert.run(
        scope,
        signature,
        book.dir,
        JSON.stringify(book.files),
        book.author,
        book.title,
        book.narrator,
        book.year,
        book.confidence,
        book.why,
        book.size,
        kind,
        target,
        JSON.stringify(owners),
        Date.now(),
        Date.now(),
      );
      added++;
      if (kind === "move" && rel) {
        known.push({ rel, key: bookKey(rel), sizes, files: book.files.map((f) => ({ abs: path.join(root, f.path), audio: f.audio, size: f.size })) });
      }
    }
    return added;
  }

  /** Candidates for one book from Audiobookshelf's search: Audible first, then Google. */
  async lookup(title: string, author: string): Promise<{ title: string; author: string; narrator?: string; year?: string }[]> {
    const abs = this.abs();
    if (!abs) return [];
    const out: { title: string; author: string; narrator?: string; year?: string }[] = [];
    for (const provider of ["audible", "google"]) {
      const results = await abs.searchBooks(title, author, provider).catch(() => []);
      for (const r of results) {
        const clean = { title: bookTitle(r.title), author: firstAuthor(r.author, r.narrator ? [r.narrator] : []) ?? r.author, narrator: r.narrator, year: r.publishedYear };
        if (!out.some((o) => nameKey(o.title) === nameKey(clean.title) && nameKey(o.author) === nameKey(clean.author))) out.push(clean);
      }
      if (out.length) break;
    }
    return out.slice(0, 6);
  }

  /**
   * A second opinion on books we aren't sure of. It's only a suggestion on the
   * Review page: a lookup can be wrong too, so it never moves anything itself.
   */
  async lookupUnsure(limit = 15) {
    if (!this.abs()) return;
    const rows = this.db
      .prepare("SELECT * FROM proposals WHERE status = 'pending' AND kind = 'move' AND confidence != 'high' AND suggestion IS NULL LIMIT ?")
      .all(limit) as unknown as ProposalRow[];
    for (const row of rows) {
      // The folder may know better than the tags: search for what it says, too.
      const named = parseName(path.posix.basename(row.source_dir) || "");
      // "The Land Of Stories - The Wishing Spell" is series and title: try each part, last first.
      const parts = named.title?.split(/\s+[-–]\s+/).reverse() ?? [];
      const queries = [...new Set([...parts, row.title].filter((q): q is string => !!q))];
      let best: Awaited<ReturnType<Engine["lookup"]>>[number] | null = null;
      for (const q of queries) {
        const found = await this.lookup(q, named.author ?? row.author ?? "");
        const match = found.find((f) => !row.author || nameKey(f.author).includes(nameKey(row.author)) || nameKey(row.author).includes(nameKey(f.author)));
        if (match) {
          best = match;
          break;
        }
      }
      // Remember that we looked, either way, so it's asked once.
      this.db.prepare("UPDATE proposals SET suggestion = ? WHERE id = ?").run(JSON.stringify(best ?? {}), row.id);
    }
  }

  /** Download proposals that can go without asking. */
  private autoApplicable(): number[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, confidence FROM proposals WHERE scope = 'incoming' AND status = 'pending'
         AND ((kind = 'move' AND confidence = 'high') OR kind = 'duplicate')`,
      )
      .all() as { id: number }[];
    return rows.map((r) => r.id);
  }

  // --- Apply ----------------------------------------------------------------------

  /** Carries out proposals. Each one either finishes or is put back as it was. */
  async applyProposals(ids: number[], label: string): Promise<{ ok: number; failed: { id: number; error: string }[]; batchId: number | null }> {
    if (!ids.length) return { ok: 0, failed: [], batchId: null };
    const s = this.settings();
    const marks = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM proposals WHERE id IN (${marks}) AND status IN ('pending', 'failed')`).all(...ids) as unknown as ProposalRow[];
    // Moves first, so a duplicate's target exists by the time it's merged.
    rows.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    const authors = this.knownAuthors();
    const ops: Op[] = [];
    const ownersBefore: unknown[] = [];
    const done: number[] = [];
    const failed: { id: number; error: string }[] = [];
    let moved = 0;
    let merged = 0;
    let freed = 0;

    for (const row of rows) {
      const mine: Op[] = [];
      try {
        const result = await this.applyOne(row, s, authors, mine, ownersBefore);
        ops.push(...mine);
        done.push(row.id);
        if (result.merged) {
          merged++;
          freed += result.freed;
        } else moved++;
      } catch (err) {
        // Put this book back; what's already finished stays finished.
        for (const op of [...mine].reverse()) await undoOp(op).catch(() => {});
        const error = errorText(err);
        failed.push({ id: row.id, error });
        this.db.prepare("UPDATE proposals SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), row.id);
        logActivity(this.db, "error", `Couldn't organize ${row.title ?? row.source_dir}: ${error}`);
      }
    }

    let batchId: number | null = null;
    if (ops.length || done.length) {
      const res = this.db
        .prepare("INSERT INTO batches (at, label, ops, owners_before, proposals) VALUES (?, ?, ?, ?, ?)")
        .run(Date.now(), label, JSON.stringify(ops), JSON.stringify(ownersBefore), JSON.stringify(done));
      batchId = Number(res.lastInsertRowid);
      const mark = this.db.prepare("UPDATE proposals SET batch_id = ? WHERE id = ?");
      for (const id of done) mark.run(batchId, id);
      const parts = [moved && plural(moved, "book") + " organized", merged && `${plural(merged, "duplicate")} merged (${formatBytes(freed)} freed)`].filter(Boolean);
      if (parts.length) logActivity(this.db, "moved", `${label}: ${parts.join(", ")}`);
      await this.readDest(s);
      await this.syncAbs(true).catch((err) => logActivity(this.db, "error", `Audiobookshelf: ${errorText(err)}`));
    }
    return { ok: done.length, failed, batchId };
  }

  private knownAuthors(): Map<string, string> {
    const rows = this.db.prepare("SELECT DISTINCT author FROM books").all() as { author: string }[];
    return new Map(rows.map((r) => [nameKey(r.author), r.author]));
  }

  private async applyOne(row: ProposalRow, s: Settings, authors: Map<string, string>, ops: Op[], ownersBefore: unknown[]): Promise<{ merged: boolean; freed: number }> {
    const root = this.rootOf(row.scope, s);
    const destRoot = this.destRoot(s);
    const files = JSON.parse(row.files) as FoundFile[];
    const owners = JSON.parse(row.owners) as number[];
    const keepOriginal = row.scope === "incoming" && s.incomingMode !== "move";
    const mode: OpType = row.scope === "library" ? "move" : s.incomingMode === "copy" ? "copy" : s.incomingMode === "hardlink" ? "link" : "move";

    // Files changed since the scan? Then this plan is out of date.
    for (const f of files) {
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(root, f.path));
      } catch {
        throw new Error(`${f.path} is no longer there. Scan again.`);
      }
      if (st.size !== f.size) throw new Error(`${f.path} has changed since the scan. Scan again.`);
    }

    const toTrash = async (fileList: FoundFile[], base: string) => {
      for (const f of fileList) {
        const from = path.join(base, f.path);
        const to = path.join(s.libraryRoot, TRASH_DIR, String(row.id), path.relative(s.libraryRoot, from).replace(/^(\.\.[/\\])+/, "incoming/"));
        ops.push(await placeFile("move", from, to));
      }
    };

    const setStatus = (dest: string) =>
      this.db.prepare("UPDATE proposals SET status = 'applied', error = NULL, dest_rel = ?, updated_at = ? WHERE id = ?").run(dest, Date.now(), row.id);

    if (row.kind === "duplicate" || (row.kind === "conflict" && row.resolution === "keep_other")) {
      const target = row.target_rel;
      if (!target) throw new Error("It isn't clear which book this matches");
      const targetDir = path.join(destRoot, target);
      if (!fs.existsSync(targetDir)) throw new Error(`The copy to keep (${target}) isn't in the library yet`);
      if (row.kind === "duplicate") await assertSameAudio(files, root, targetDir);
      this.addOwners(target, owners, row.scope === "incoming" ? "default" : "folder", ownersBefore);
      const audioSize = files.reduce((n, f) => n + f.size, 0);
      if (!keepOriginal) {
        await toTrash(files, root);
        this.tidySource(row, s, ops);
      }
      setStatus(target);
      return { merged: true, freed: keepOriginal ? 0 : audioSize };
    }

    if (row.kind === "conflict" && !row.resolution) throw new Error("Choose which copy to keep");
    // The two copies are compared at the same spot, so the other one must be in place first.
    if (row.kind === "conflict" && row.target_rel && !fs.existsSync(path.join(destRoot, row.target_rel))) {
      throw new Error(`Organize the other copy (${row.target_rel}) first`);
    }
    if (!row.author || !row.title) throw new Error("It needs an author and a title first");

    let rel = destFor(row.author, row.title, authors);
    if (row.kind === "conflict" && row.resolution === "keep_both") rel = freeRel(destRoot, rel);
    const destDir = path.join(destRoot, rel);
    assertInside(destRoot, destDir);

    if (row.kind === "conflict" && row.resolution === "keep_this") {
      // This copy replaces the other one, which goes to the trash.
      const target = row.target_rel ?? rel;
      const targetDir = path.join(destRoot, target);
      if (fs.existsSync(targetDir)) {
        for (const name of listFiles(targetDir)) {
          const from = path.join(targetDir, name);
          const to = path.join(s.libraryRoot, TRASH_DIR, String(row.id), s.destSubdir, target, name);
          ops.push(await placeFile("move", from, to));
        }
        removeEmptyUp(targetDir, destRoot);
      }
      rel = target;
    }

    const finalDir = path.join(destRoot, rel);
    for (const f of files) {
      const to = path.join(finalDir, f.name);
      assertInside(destRoot, to);
      ops.push(await placeFile(f.audio ? mode : keepOriginal ? "copy" : mode, path.join(root, f.path), to));
    }
    this.addOwners(rel, owners, row.scope === "incoming" ? "default" : "folder", ownersBefore);
    if (!keepOriginal) this.tidySource(row, s, ops);
    setStatus(rel);
    authors.set(nameKey(rel.split("/")[0]), rel.split("/")[0]);
    return { merged: false, freed: 0 };
  }

  /** Removes the folders a book left empty. Leftovers (a stale metadata file) keep a folder. */
  private tidySource(row: ProposalRow, s: Settings, _ops: Op[]) {
    const root = this.rootOf(row.scope, s);
    if (!row.source_dir) return;
    // Never remove a person's own folder, or the scan root.
    const stop = row.scope === "library" ? path.join(root, row.source_dir.split("/")[0]) : root;
    removeEmptyUp(path.join(root, row.source_dir), stop);
  }

  private addOwners(rel: string, people: number[], source: string, before: unknown[]) {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO owners (rel_path, person_id, source, created_at) VALUES (?, ?, ?, ?)");
    for (const id of people) {
      const res = stmt.run(rel, id, source, Date.now());
      if (res.changes) before.push({ rel_path: rel, person_id: id });
    }
  }

  /** Reverses a batch: files go back where they were, and it's a suggestion again. */
  async undo(batchId: number): Promise<{ ok: boolean; problems: string[] }> {
    const row = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as
      | { ops: string; owners_before: string; proposals: string; undone_at: number | null; label: string }
      | undefined;
    if (!row) throw new Error("No such change");
    if (row.undone_at) throw new Error("That's already been undone");
    const problems: string[] = [];
    const s = this.settings();
    const dirs = new Set<string>();
    for (const op of (JSON.parse(row.ops) as Op[]).reverse()) {
      try {
        await undoOp(op);
        dirs.add(path.dirname(op.to));
      } catch (err) {
        problems.push(errorText(err));
      }
    }
    for (const d of dirs) {
      if (d.startsWith(this.destRoot(s))) removeEmptyUp(d, this.destRoot(s));
      else removeEmptyUp(d, path.join(s.libraryRoot, TRASH_DIR));
    }
    tx(this.db, () => {
      for (const o of JSON.parse(row.owners_before) as { rel_path: string; person_id: number }[]) {
        this.db.prepare("DELETE FROM owners WHERE rel_path = ? AND person_id = ?").run(o.rel_path, o.person_id);
      }
      const mark = this.db.prepare("UPDATE proposals SET status = 'pending', dest_rel = NULL, batch_id = NULL, updated_at = ? WHERE id = ?");
      for (const id of JSON.parse(row.proposals) as number[]) mark.run(Date.now(), id);
      this.db.prepare("UPDATE batches SET undone_at = ? WHERE id = ?").run(Date.now(), batchId);
    });
    logActivity(this.db, "undo", `Undid “${row.label}”${problems.length ? ` (${plural(problems.length, "problem")})` : ""}`);
    await this.readDest(s);
    return { ok: !problems.length, problems };
  }

  trashSize(s = this.settings()): number {
    return folderSize(path.join(s.libraryRoot, TRASH_DIR));
  }

  /** The only place Shelvarr permanently deletes anything, and only when asked. */
  emptyTrash() {
    const s = this.settings();
    const size = this.trashSize(s);
    fs.rmSync(path.join(s.libraryRoot, TRASH_DIR), { recursive: true, force: true });
    // What was in there can't come back, so those changes can't be undone now.
    const batches = this.db.prepare("SELECT id, ops FROM batches WHERE undone_at IS NULL").all() as { id: number; ops: string }[];
    for (const b of batches) {
      if ((JSON.parse(b.ops) as Op[]).some((op) => op.to.includes(`${path.sep}${TRASH_DIR}${path.sep}`))) {
        this.db.prepare("UPDATE batches SET undone_at = -1 WHERE id = ?").run(b.id);
      }
    }
    logActivity(this.db, "moved", `Emptied the trash (${formatBytes(size)} freed)`);
    return size;
  }

  // --- Audiobookshelf -----------------------------------------------------------

  /** Asks Audiobookshelf to re-read the library, and matches its items to our books. */
  async syncAbs(rescan = false) {
    const s = this.settings();
    const abs = this.abs(s);
    if (!abs || !s.absLibraryId) return;
    if (rescan) await abs.scan(s.absLibraryId).catch(() => {});
    const items = await abs.items(s.absLibraryId);
    const people = listPeople(this.db);
    const prefix = `${path.posix.join(s.absRoot, s.destSubdir)}/`;
    const updates: { id: string; tags: string[] }[] = [];
    const insertOwner = this.db.prepare("INSERT OR IGNORE INTO owners (rel_path, person_id, source, created_at) VALUES (?, ?, 'abs', ?)");
    for (const item of items) {
      if (!item.path?.startsWith(prefix)) continue;
      const rel = item.path.slice(prefix.length);
      const tags = item.media.tags ?? [];
      // A person's tag added in Audiobookshelf itself counts as theirs.
      for (const p of people) if (tags.some((t) => same(t, p.tag))) insertOwner.run(rel, p.id, Date.now());
      const owned = this.ownersOf(rel);
      const want = people.filter((p) => owned.has(p.id)).map((p) => p.tag);
      const missing = want.filter((t) => !tags.some((x) => same(x, t)));
      if (missing.length) updates.push({ id: item.id, tags: [...tags, ...missing] });
      this.db.prepare("UPDATE books SET abs_item_id = ?, abs_tags = ? WHERE rel_path = ?").run(item.id, JSON.stringify([...tags, ...missing]), rel);
    }
    if (updates.length) await abs.setTags(updates);
  }

  ownersOf(rel: string): Set<number> {
    const rows = this.db.prepare("SELECT person_id FROM owners WHERE rel_path = ?").all(rel) as { person_id: number }[];
    return new Set(rows.map((r) => r.person_id));
  }

  /** Who a book is for, set by hand. Updates Audiobookshelf straight away. */
  async changeOwners(rels: string[], add: number[], remove: number[]) {
    const s = this.settings();
    const people = listPeople(this.db);
    const abs = this.abs(s);
    const updates: { id: string; tags: string[] }[] = [];
    const removeTags = people.filter((p) => remove.includes(p.id)).map((p) => p.tag);
    const addTags = people.filter((p) => add.includes(p.id)).map((p) => p.tag);
    for (const rel of rels) {
      tx(this.db, () => {
        for (const id of add) this.db.prepare("INSERT OR IGNORE INTO owners (rel_path, person_id, source, created_at) VALUES (?, ?, 'manual', ?)").run(rel, id, Date.now());
        for (const id of remove) this.db.prepare("DELETE FROM owners WHERE rel_path = ? AND person_id = ?").run(rel, id);
      });
      const book = this.db.prepare("SELECT abs_item_id, abs_tags FROM books WHERE rel_path = ?").get(rel) as { abs_item_id: string | null; abs_tags: string | null } | undefined;
      if (abs && book?.abs_item_id) {
        const now = (JSON.parse(book.abs_tags ?? "[]") as string[]).filter((t) => !removeTags.some((r) => same(r, t)));
        const next = [...now, ...addTags.filter((t) => !now.some((x) => same(x, t)))];
        updates.push({ id: book.abs_item_id, tags: next });
        this.db.prepare("UPDATE books SET abs_tags = ? WHERE rel_path = ?").run(JSON.stringify(next), rel);
      }
    }
    if (abs && updates.length) await abs.setTags(updates);
  }

  // --- Moving to one library ------------------------------------------------------

  /** Saves everyone's listening progress, so it survives the move to one library. */
  async snapshotProgress(): Promise<{ users: number; entries: number }> {
    const abs = this.abs();
    if (!abs) throw new Error("Connect Audiobookshelf first");
    const libraries = await abs.libraries();
    const pathById = new Map<string, AbsItem>();
    for (const lib of libraries) for (const item of await abs.items(lib.id)) pathById.set(item.id, item);
    const users = await abs.users();
    const insert = this.db.prepare(`
      INSERT INTO progress_snapshot (abs_user_id, username, old_path, title, data, taken_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (abs_user_id, old_path) DO UPDATE SET data = excluded.data, taken_at = excluded.taken_at, restored_at = NULL
    `);
    let entries = 0;
    for (const u of users) {
      const full = await abs.user(u.id);
      const byItem = new Map<string, { progress: unknown; bookmarks: unknown[] }>();
      for (const p of full.mediaProgress ?? []) if (!p.episodeId) byItem.set(p.libraryItemId, { progress: p, bookmarks: [] });
      for (const b of full.bookmarks ?? []) {
        const entry = byItem.get(b.libraryItemId) ?? { progress: null, bookmarks: [] };
        entry.bookmarks.push(b);
        byItem.set(b.libraryItemId, entry);
      }
      for (const [itemId, data] of byItem) {
        const item = pathById.get(itemId);
        if (!item) continue;
        insert.run(u.id, u.username, item.path, item.media.metadata?.title ?? null, JSON.stringify(data), Date.now());
        entries++;
      }
    }
    logActivity(this.db, "scan", `Saved listening progress: ${plural(entries, "entry")} for ${plural(users.length, "user")}`);
    return { users: users.length, entries };
  }

  /** Where a book that used to be at this Audiobookshelf path is now. */
  private newRelFor(oldPath: string, s: Settings): string | null {
    const rootPrefix = `${s.absRoot.replace(/\/+$/, "")}/`;
    if (!oldPath.startsWith(rootPrefix)) return null;
    const rel = oldPath.slice(rootPrefix.length);
    for (const p of this.db.prepare("SELECT source_dir, files, dest_rel FROM proposals WHERE scope = 'library' AND status = 'applied'").all() as { source_dir: string; files: string; dest_rel: string }[]) {
      if (p.source_dir === rel) return p.dest_rel;
      if ((JSON.parse(p.files) as FoundFile[]).some((f) => f.path === rel)) return p.dest_rel;
    }
    return null;
  }

  /** Puts saved progress back on the books' new items, newest wins. */
  async restoreProgress(): Promise<{ restored: number; waiting: number; problems: string[] }> {
    const s = this.settings();
    const abs = this.abs(s);
    if (!abs || !s.absLibraryId) throw new Error("Choose the shared Audiobookshelf library first");
    const prefix = `${path.posix.join(s.absRoot, s.destSubdir)}/`;
    const itemByRel = new Map((await abs.items(s.absLibraryId)).filter((i) => i.path?.startsWith(prefix)).map((i) => [i.path.slice(prefix.length), i]));
    const rows = this.db.prepare("SELECT * FROM progress_snapshot WHERE restored_at IS NULL").all() as {
      id: number;
      abs_user_id: string;
      username: string;
      old_path: string;
      title: string | null;
      data: string;
    }[];
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) byUser.set(r.abs_user_id, [...(byUser.get(r.abs_user_id) ?? []), r]);
    let restored = 0;
    let waiting = 0;
    const problems: string[] = [];
    for (const [userId, list] of byUser) {
      // Two old copies of one book: whichever was listened to last.
      const best = new Map<string, { row: (typeof rows)[number]; data: { progress: never; bookmarks: never[] } }>();
      const extras: (typeof rows)[number][] = [];
      for (const row of list) {
        const rel = this.newRelFor(row.old_path, s);
        const item = rel ? itemByRel.get(rel) : undefined;
        if (!item) {
          waiting++;
          continue;
        }
        const data = JSON.parse(row.data);
        const cur = best.get(item.id);
        const at = (d: { progress?: { lastUpdate?: number } | null }) => d.progress?.lastUpdate ?? 0;
        if (!cur || at(data) > at(cur.data)) {
          if (cur) extras.push(cur.row);
          best.set(item.id, { row, data });
        } else extras.push(row);
      }
      if (!best.size) continue;
      try {
        await abs.asUser(userId, async (token) => {
          for (const [itemId, { row, data }] of best) {
            if (data.progress) await abs.setProgress(token, itemId, data.progress);
            for (const b of data.bookmarks) await abs.addBookmark(token, itemId, b).catch(() => {});
            this.db.prepare("UPDATE progress_snapshot SET restored_at = ? WHERE id = ?").run(Date.now(), row.id);
            restored++;
          }
        });
        for (const row of extras) this.db.prepare("UPDATE progress_snapshot SET restored_at = ? WHERE id = ?").run(Date.now(), row.id);
      } catch (err) {
        problems.push(`${list[0].username}: ${errorText(err)}`);
      }
    }
    if (restored) logActivity(this.db, "moved", `Restored listening progress on ${plural(restored, "book")}`);
    return { restored, waiting, problems };
  }

  // --- Helpers --------------------------------------------------------------------

  /** Top-level folders the app can see and what it's doing with them, for the setup page. */
  describeRoot(): { name: string; books: number; size: number; role: "person" | "library" | "ignored" }[] {
    const s = this.settings();
    const people = listPeople(this.db);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(s.libraryRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !/^(?:@eaDir|#recycle)$/.test(e.name))
      .map((e) => {
        const dirs = walkTree(s.libraryRoot, e.name);
        let books = 0;
        let size = 0;
        for (const d of dirs.values()) {
          if (d.audio.length) books++;
          size += [...d.audio, ...d.other].reduce((n, f) => n + f.size, 0);
        }
        const role = e.name === s.destSubdir ? ("library" as const) : people.some((p) => p.folder === e.name) ? ("person" as const) : ("ignored" as const);
        return { name: e.name, books, size, role };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async absUsers(): Promise<AbsUser[]> {
    const abs = this.abs();
    return abs ? abs.users() : [];
  }
}

/** Already at Author/Title, with everything directly inside (or in disc folders)? */
function isTidy(b: FoundBook): boolean {
  const parts = b.dir.split("/");
  if (parts.length !== 2) return false;
  // Two books loose in one folder aren't tidy.
  return b.files.every((f) => !f.audio || f.path === `${b.dir}/${f.name}`);
}

function rebase(book: FoundBook, prefix: string): FoundBook {
  const up = (p: string) => (p ? `${prefix}/${p}` : prefix);
  return { ...book, dir: up(book.dir), files: book.files.map((f) => ({ ...f, path: up(f.path) })) };
}

function bookKey(rel: string): string {
  return rel.split("/").map(nameKey).join("/");
}

function rank(p: ProposalRow): number {
  if (p.kind === "move") return 0;
  if (p.kind === "conflict") return 1;
  return 2;
}

function sameQuick(known: { abs: string; audio: boolean; size: number }[], files: FoundFile[], root: string): boolean {
  const a = known.filter((f) => f.audio);
  const b = files.filter((f) => f.audio);
  if (!a.length || a.length !== b.length) return false;
  const hashes = (paths: string[]) => paths.map(quickSafe).sort().join(",");
  return hashes(a.map((f) => f.abs)) === hashes(b.map((f) => path.join(root, f.path)));
}

function quickSafe(p: string): string {
  try {
    return quickHash(p);
  } catch {
    return `missing:${p}`;
  }
}

/** The check before anything is thrown away: every audio file, byte for byte. */
async function assertSameAudio(files: FoundFile[], root: string, targetDir: string) {
  const audio = (names: string[], base: string) => Promise.all(names.map((n) => sha256(path.join(base, n))));
  const mine = await audio(files.filter((f) => f.audio).map((f) => f.path), root);
  const theirs = await audio(listFiles(targetDir).filter((n) => /\.(mp3|m4b|m4a|m4p|flac|ogg|oga|opus|aac|wav|wma|mp2)$/i.test(n)), targetDir);
  if (mine.sort().join() !== theirs.sort().join()) throw new Error("It looked like a duplicate, but the files aren't identical. Nothing was removed.");
}

/** Files under a folder, relative to it. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(child);
      else if (e.isFile() && e.name !== ".DS_Store") out.push(child);
    }
  };
  visit("");
  return out;
}

function freeRel(destRoot: string, rel: string): string {
  if (!fs.existsSync(path.join(destRoot, rel))) return rel;
  for (let i = 2; ; i++) {
    const next = `${rel} (${i})`;
    if (!fs.existsSync(path.join(destRoot, next))) return next;
  }
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

export function plural(n: number, word: string) {
  if (n === 1) return `1 ${word}`;
  return `${n} ${word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;
}

export function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    const code = (err as NodeJS.ErrnoException).code;
    if (err.name === "TimeoutError") return "timed out";
    if (code === "EACCES" || code === "EPERM") return `No permission to change that file: ${err.message}. Check the container's user (PUID/PGID).`;
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message;
  }
  return String(err);
}
