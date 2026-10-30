// HTTP API and static frontend.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { Abs } from "./abs.ts";
import {
  LoginLimiter,
  SESSION_COOKIE,
  createSession,
  createWidgetKey,
  deleteAllSessions,
  deleteSession,
  hashPassword,
  useWidgetKey,
  validSession,
  verifyPassword,
} from "./auth.ts";
import { type DB, type Person, type Settings, getSettings, listPeople, logActivity, saveSettings } from "./db.ts";
import { Engine, type ProposalRow, TRASH_DIR, destFor, errorText, formatBytes } from "./engine.ts";
import { nameKey } from "./naming.ts";
import type { FoundFile, TagReader } from "./scan.ts";
import { UpdateChecker, isNewer } from "./update-check.ts";

export interface AppOptions {
  db: DB;
  version: string;
  repo: string;
  updateCheck: boolean;
  updateApiBase?: string;
  webRoot?: string;
  logger?: boolean;
  reader?: TagReader;
}

export const PERSON_COLORS = ["#7c5cbf", "#d9677e", "#3f8f84", "#d08a3a", "#4f7cc0", "#8a9a3b", "#b4589f", "#5c6b7a"];

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; engine: Engine; updates: UpdateChecker }> {
  const { db } = opts;
  const engine = new Engine(db, opts.reader);
  const updates = new UpdateChecker(opts.updateCheck, opts.repo, opts.updateApiBase);
  const limiter = new LoginLimiter();

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(cookie);

  const isAuthed = (req: FastifyRequest) => validSession(db, req.cookies[SESSION_COOKIE]);
  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply) => {
    const { token, maxAge } = createSession(db);
    reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: req.protocol === "https", maxAge });
  };

  // Everything under /api needs a session except these.
  const PUBLIC = new Set(["/api/health", "/api/session", "/api/login", "/api/account/create", "/api/widget"]);
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/") || PUBLIC.has(url)) return;
    if (!isAuthed(req)) return reply.code(401).send({ error: "Sign in first" });
  });

  // JSON only, which also stops other sites posting forms at the API.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, _body, done) => {
    const err = new Error("Send JSON") as Error & { statusCode: number };
    err.statusCode = 415;
    done(err, undefined);
  });

  // --- Session & account ---------------------------------------------------------

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/session", async (req) => {
    const s = getSettings(db);
    return { authenticated: isAuthed(req), needsAccount: !s.adminPasswordHash, setupComplete: s.setupComplete, version: opts.version };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/account/create", async (req, reply) => {
    const s = getSettings(db);
    if (s.adminPasswordHash) return reply.code(409).send({ error: "An account already exists. Sign in instead." });
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!username) return reply.code(400).send({ error: "Choose a username" });
    if (password.length < 8) return reply.code(400).send({ error: "Use at least 8 characters for the password" });
    saveSettings(db, { adminUsername: username, adminPasswordHash: hashPassword(password) });
    setSessionCookie(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/login", async (req, reply) => {
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a few minutes." });
    const s = getSettings(db);
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const ok = !!s.adminPasswordHash && username.toLowerCase() === s.adminUsername.toLowerCase() && verifyPassword(password, s.adminPasswordHash);
    if (!ok) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: "Wrong username or password" });
    }
    limiter.reset(req.ip);
    setSessionCookie(req, reply);
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    deleteSession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post<{ Body: { current?: string; next?: string } }>("/api/account/password", async (req, reply) => {
    const s = getSettings(db);
    if (!verifyPassword(String(req.body?.current ?? ""), s.adminPasswordHash)) return reply.code(400).send({ error: "The current password is wrong" });
    const next = String(req.body?.next ?? "");
    if (next.length < 8) return reply.code(400).send({ error: "Use at least 8 characters for the password" });
    saveSettings(db, { adminPasswordHash: hashPassword(next) });
    deleteAllSessions(db);
    setSessionCookie(req, reply);
    return { ok: true };
  });

  const about = () => ({ version: opts.version, repo: opts.repo, update: updates.info, updateAvailable: isNewer(updates.info.latest, opts.version) });
  app.get("/api/about", async () => about());
  app.post("/api/about/check", async (_req, reply) => {
    if (!updates.info.enabled) return reply.code(400).send({ error: "The update check is turned off (UPDATE_CHECK=off)" });
    try {
      if (!(await updates.checkNow())) return reply.code(502).send({ error: "GitHub didn't answer. Try again later." });
    } catch (err) {
      return reply.code(502).send({ error: `Couldn't reach GitHub: ${errorText(err)}` });
    }
    return about();
  });

  // --- Overview --------------------------------------------------------------------

  const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;

  function totals() {
    const s = getSettings(db);
    const sum = (sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;
    return {
      books: count("SELECT count(*) AS n FROM books"),
      authors: count("SELECT count(DISTINCT author) AS n FROM books"),
      size: sum("SELECT sum(size) AS n FROM books"),
      unowned: count("SELECT count(*) AS n FROM books b WHERE NOT EXISTS (SELECT 1 FROM owners o WHERE o.rel_path = b.rel_path)"),
      shared: count("SELECT count(*) AS n FROM (SELECT rel_path FROM owners GROUP BY rel_path HAVING count(*) > 1)"),
      toReview: count("SELECT count(*) AS n FROM proposals WHERE status IN ('pending', 'failed')"),
      duplicateSize: sum("SELECT sum(size) AS n FROM proposals WHERE status = 'pending' AND kind = 'duplicate' AND scope = 'library'"),
      trashSize: s.libraryRoot ? engine.trashSize(s) : 0,
    };
  }

  app.get("/api/overview", async () => {
    const s = getSettings(db);
    const people = listPeople(db).map((p) => ({
      ...publicPerson(p),
      count: count("SELECT count(*) AS n FROM owners o JOIN books b ON b.rel_path = o.rel_path WHERE o.person_id = ?", p.id),
      onlyCount: count(
        "SELECT count(*) AS n FROM owners o JOIN books b ON b.rel_path = o.rel_path WHERE o.person_id = ? AND (SELECT count(*) FROM owners x WHERE x.rel_path = o.rel_path) = 1",
        p.id,
      ),
    }));
    return {
      connections: { abs: !!(s.absUrl && s.absToken), library: !!s.absLibraryId, incoming: !!s.incomingDir },
      totals: totals(),
      people,
      activity: db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 12").all(),
      status: engine.status,
    };
  });

  app.get("/api/status", async () => engine.status);
  app.get("/api/activity", async () => db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 300").all());

  // --- Homepage widget -------------------------------------------------------------

  app.get("/api/widget", async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (!useWidgetKey(db, Array.isArray(key) ? key[0] : key)) return reply.code(401).send({ error: "Missing or unknown X-Api-Key" });
    const t = totals();
    return {
      books: t.books,
      authors: t.authors,
      to_review: t.toReview,
      unowned: t.unowned,
      shared: t.shared,
      size_bytes: t.size,
      last_scan: engine.status.lastScanAt ? new Date(engine.status.lastScanAt).toISOString() : null,
    };
  });
  app.get("/api/widget-keys", async () => db.prepare("SELECT id, label, created_at, last_used_at FROM widget_keys ORDER BY id").all());
  app.post<{ Body: { label?: string } }>("/api/widget-keys", async (req) => createWidgetKey(db, String(req.body?.label ?? "").trim().slice(0, 60) || "Homepage"));
  app.delete<{ Params: { id: string } }>("/api/widget-keys/:id", async (req) => {
    db.prepare("DELETE FROM widget_keys WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });

  // --- Scanning and proposals ------------------------------------------------------

  /** Long work runs in the background; the page watches /api/status. */
  const background = (label: string, fn: () => Promise<unknown>) => {
    engine.exclusive(label, fn).catch(() => {});
    return { started: true };
  };

  app.post<{ Body: { scope?: string } }>("/api/scan", async (req) =>
    background("Scanning", async () => {
      if (req.body?.scope !== "incoming") await engine.scanLibrary();
      const s = getSettings(db);
      if (req.body?.scope !== "library" && s.incomingDir && fs.existsSync(s.incomingDir)) await engine.scanIncoming();
      await engine.lookupUnsure();
    }),
  );

  function publicProposal(p: ProposalRow) {
    const files = JSON.parse(p.files) as FoundFile[];
    const authors = new Map((db.prepare("SELECT DISTINCT author FROM books").all() as { author: string }[]).map((r) => [nameKey(r.author), r.author]));
    return {
      id: p.id,
      scope: p.scope,
      sourceDir: p.source_dir,
      fileCount: files.length,
      audioCount: files.filter((f) => f.audio).length,
      files: files.slice(0, 40).map((f) => f.path),
      author: p.author,
      title: p.title,
      narrator: p.narrator,
      year: p.year,
      confidence: p.confidence,
      why: p.why,
      size: p.size,
      kind: p.kind,
      targetRel: p.target_rel,
      resolution: p.resolution,
      suggestion: p.suggestion && p.suggestion !== "{}" ? (JSON.parse(p.suggestion) as { title: string; author: string }) : null,
      owners: JSON.parse(p.owners) as number[],
      status: p.status,
      error: p.error,
      dest: p.dest_rel ?? (p.author && p.title ? destFor(p.author, p.title, authors) : null),
      batchId: p.batch_id,
      updatedAt: p.updated_at,
    };
  }

  app.get<{ Querystring: { status?: string } }>("/api/proposals", async (req) => {
    const status = req.query.status === "done" ? "'applied', 'skipped'" : "'pending', 'failed'";
    const rows = db.prepare(`SELECT * FROM proposals WHERE status IN (${status}) ORDER BY lower(coalesce(author, 'zzz')), lower(coalesce(title, 'zzz')), id LIMIT 3000`).all() as unknown as ProposalRow[];
    return rows.map(publicProposal);
  });

  app.patch<{ Params: { id: string }; Body: { author?: string; title?: string; owners?: number[]; resolution?: string | null } }>("/api/proposals/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(Number(req.params.id)) as unknown as ProposalRow | undefined;
    if (!row) return reply.code(404).send({ error: "No such suggestion" });
    const b = req.body ?? {};
    const author = b.author !== undefined ? String(b.author).trim().slice(0, 200) || null : row.author;
    const title = b.title !== undefined ? String(b.title).trim().slice(0, 200) || null : row.title;
    const edited = author !== row.author || title !== row.title;
    const resolution = b.resolution !== undefined ? (["keep_this", "keep_other", "keep_both"].includes(String(b.resolution)) ? String(b.resolution) : null) : row.resolution;
    const known = new Set(listPeople(db).map((p) => p.id));
    const owners = b.owners !== undefined ? arrayOf(b.owners, "number").filter((id) => known.has(id)) : (JSON.parse(row.owners) as number[]);
    // Checked by a person now, so it no longer needs flagging.
    const confidence = edited && author && title ? "high" : row.confidence;
    const why = edited && author && title ? "Set by you" : row.why;
    db.prepare("UPDATE proposals SET author = ?, title = ?, resolution = ?, owners = ?, confidence = ?, why = ?, status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END, error = NULL, updated_at = ? WHERE id = ?").run(
      author,
      title,
      resolution,
      JSON.stringify(owners),
      confidence,
      why,
      Date.now(),
      row.id,
    );
    return publicProposal(db.prepare("SELECT * FROM proposals WHERE id = ?").get(row.id) as unknown as ProposalRow);
  });

  app.get<{ Querystring: { title?: string; author?: string } }>("/api/lookup", async (req) => {
    const title = String(req.query.title ?? "").trim();
    return title ? engine.lookup(title, String(req.query.author ?? "").trim()) : [];
  });

  app.post<{ Body: { ids?: number[]; label?: string } }>("/api/proposals/apply", async (req, reply) => {
    const ids = arrayOf(req.body?.ids, "number");
    if (!ids.length) return reply.code(400).send({ error: "Nothing selected" });
    try {
      return await engine.exclusive("Organizing books", () => engine.applyProposals(ids, String(req.body?.label ?? "Organized books").slice(0, 80)));
    } catch (err) {
      return reply.code(500).send({ error: errorText(err) });
    }
  });

  /** "Leave it": it won't be suggested again, and nothing happens to the files. */
  app.post<{ Body: { ids?: number[] } }>("/api/proposals/skip", async (req) => {
    const stmt = db.prepare("UPDATE proposals SET status = 'skipped', updated_at = ? WHERE id = ?");
    for (const id of arrayOf(req.body?.ids, "number")) stmt.run(Date.now(), id);
    return { ok: true };
  });

  app.post<{ Body: { ids?: number[] } }>("/api/proposals/restore", async (req) => {
    const stmt = db.prepare("UPDATE proposals SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'skipped'");
    for (const id of arrayOf(req.body?.ids, "number")) stmt.run(Date.now(), id);
    return { ok: true };
  });

  /** Everything in the download folder now counts as dealt with: only new arrivals get suggested. */
  app.post("/api/incoming/ignore-existing", async () => {
    const s = getSettings(db);
    if (!s.incomingDir) return { skipped: 0 };
    await engine.exclusive("Checking downloads", () => engine.scanIncoming());
    // Files still settling are picked up on a later pass and aren't "existing"; that's fine.
    const res = db.prepare("UPDATE proposals SET status = 'skipped', updated_at = ? WHERE scope = 'incoming' AND status IN ('pending', 'failed')").run(Date.now());
    logActivity(db, "scan", `Left ${res.changes} existing downloads as they are`);
    return { skipped: Number(res.changes) };
  });

  // --- History & trash ---------------------------------------------------------------

  app.get("/api/batches", async () => {
    const rows = db.prepare("SELECT id, at, label, ops, proposals, undone_at FROM batches ORDER BY id DESC LIMIT 50").all() as {
      id: number;
      at: number;
      label: string;
      ops: string;
      proposals: string;
      undone_at: number | null;
    }[];
    return rows.map((b) => ({
      id: b.id,
      at: b.at,
      label: b.label,
      books: (JSON.parse(b.proposals) as number[]).length,
      files: (JSON.parse(b.ops) as unknown[]).length,
      undone: b.undone_at != null && b.undone_at > 0,
      canUndo: b.undone_at == null,
    }));
  });

  app.post<{ Params: { id: string } }>("/api/batches/:id/undo", async (req, reply) => {
    try {
      return await engine.exclusive("Undoing", () => engine.undo(Number(req.params.id)));
    } catch (err) {
      return reply.code(400).send({ error: errorText(err) });
    }
  });

  app.get("/api/trash", async () => {
    const size = engine.trashSize();
    return { size, label: formatBytes(size), path: path.join(getSettings(db).libraryRoot, TRASH_DIR) };
  });

  app.post("/api/trash/empty", async () => ({ freed: await engine.exclusive("Emptying the trash", async () => engine.emptyTrash()) }));

  // --- Library ---------------------------------------------------------------------

  app.get("/api/books", async () => {
    const rows = db.prepare("SELECT * FROM books ORDER BY lower(author), lower(title)").all() as {
      rel_path: string;
      author: string;
      title: string;
      size: number;
      file_count: number;
      abs_item_id: string | null;
    }[];
    const owners = db.prepare("SELECT rel_path, person_id FROM owners").all() as { rel_path: string; person_id: number }[];
    const byRel = new Map<string, number[]>();
    for (const o of owners) byRel.set(o.rel_path, [...(byRel.get(o.rel_path) ?? []), o.person_id]);
    return rows.map((b) => ({ rel: b.rel_path, author: b.author, title: b.title, size: b.size, fileCount: b.file_count, hasCover: !!b.abs_item_id, itemId: b.abs_item_id, owners: byRel.get(b.rel_path) ?? [] }));
  });

  app.get<{ Params: { id: string } }>("/api/items/:id/cover", async (req, reply) => {
    const abs = engine.abs();
    if (!abs || !/^[\w-]{8,64}$/.test(req.params.id)) return reply.code(404).send();
    try {
      const res = await abs.cover(req.params.id);
      if (!res.ok) return reply.code(404).send();
      reply.header("Content-Type", res.headers.get("content-type") ?? "image/jpeg");
      reply.header("Cache-Control", "private, max-age=86400");
      return reply.send(Buffer.from(await res.arrayBuffer()));
    } catch {
      return reply.code(502).send();
    }
  });

  app.post<{ Body: { rel?: string; author?: string; title?: string } }>("/api/books/rename", async (req, reply) => {
    try {
      const rel = await engine.exclusive("Renaming", () => engine.renameBook(String(req.body?.rel ?? ""), String(req.body?.author ?? ""), String(req.body?.title ?? "")));
      return { rel };
    } catch (err) {
      return reply.code(400).send({ error: errorText(err) });
    }
  });

  app.post<{ Body: { rels?: string[]; add?: number[]; remove?: number[] } }>("/api/books/owners", async (req, reply) => {
    const rels = arrayOf(req.body?.rels, "string").slice(0, 5000);
    const add = arrayOf(req.body?.add, "number");
    const remove = arrayOf(req.body?.remove, "number").filter((id) => !add.includes(id));
    if (!rels.length || (!add.length && !remove.length)) return reply.code(400).send({ error: "Nothing to change" });
    try {
      await engine.changeOwners(rels, add, remove);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  // --- People ------------------------------------------------------------------------

  const getPerson = (id: number) => db.prepare("SELECT * FROM people WHERE id = ?").get(id) as unknown as Person | undefined;

  app.get("/api/people", async () =>
    listPeople(db).map((p) => ({
      ...publicPerson(p),
      count: count("SELECT count(*) AS n FROM owners WHERE person_id = ?", p.id),
    })),
  );

  function checkPerson(name: string, tag: string, selfId: number | null): string | null {
    if (!name) return "Give them a name";
    if (!tag) return "Choose a tag";
    if (tag.length > 100) return "That tag is too long";
    const clash = listPeople(db).find((p) => p.id !== selfId && p.tag.toLowerCase() === tag.toLowerCase());
    return clash ? `${clash.name} already uses the tag “${clash.tag}”` : null;
  }

  function checkFolder(folder: string | null): string | null {
    if (folder && (folder.includes("/") || folder.includes("\\") || folder.startsWith("."))) return "Use just the folder's name";
    return null;
  }

  app.post<{ Body: PersonBody }>("/api/people", async (req, reply) => {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    const tag = String(b.tag ?? name).trim();
    const folder = strOrNull(b.folder);
    const problem = checkPerson(name, tag, null) ?? checkFolder(folder);
    if (problem) return reply.code(400).send({ error: problem });
    const used = new Set(listPeople(db).map((p) => p.color));
    const color = PERSON_COLORS.find((c) => !used.has(c)) ?? PERSON_COLORS[0];
    const res = db.prepare("INSERT INTO people (name, tag, color, abs_user_id, folder, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(name, tag, color, strOrNull(b.absUserId), folder, Date.now());
    logActivity(db, "access", `Added ${name}`);
    return { id: Number(res.lastInsertRowid) };
  });

  app.patch<{ Params: { id: string }; Body: PersonBody }>("/api/people/:id", async (req, reply) => {
    const person = getPerson(Number(req.params.id));
    if (!person) return reply.code(404).send({ error: "No such person" });
    const b = req.body ?? {};
    const name = b.name !== undefined ? String(b.name).trim() : person.name;
    const tag = b.tag !== undefined ? String(b.tag).trim() : person.tag;
    const folder = b.folder !== undefined ? strOrNull(b.folder) : person.folder;
    const problem = checkPerson(name, tag, person.id) ?? checkFolder(folder);
    if (problem) return reply.code(400).send({ error: problem });
    if (tag !== person.tag) {
      const abs = engine.abs();
      try {
        if (abs) await abs.renameTag(person.tag, tag);
      } catch (err) {
        return reply.code(502).send({ error: `Couldn't rename the tag in Audiobookshelf: ${errorText(err)}` });
      }
    }
    db.prepare("UPDATE people SET name = ?, tag = ?, abs_user_id = ?, folder = ? WHERE id = ?").run(name, tag, b.absUserId !== undefined ? strOrNull(b.absUserId) : person.abs_user_id, folder, person.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/people/:id", async (req, reply) => {
    const person = getPerson(Number(req.params.id));
    if (!person) return reply.code(404).send({ error: "No such person" });
    db.prepare("DELETE FROM people WHERE id = ?").run(person.id);
    const s = getSettings(db);
    saveSettings(db, { defaultOwners: s.defaultOwners.filter((id) => id !== person.id) });
    logActivity(db, "access", `Removed ${person.name}`);
    return { ok: true };
  });

  // --- Access ------------------------------------------------------------------------
  // Audiobookshelf can limit a user to items with certain tags, per user. With
  // one shared library that's what keeps everyone's shelf their own.

  app.get("/api/access", async (_req, reply) => {
    const abs = engine.abs();
    if (!abs) return { users: [] };
    try {
      const people = listPeople(db);
      const dismissed = new Set(getSettings(db).accessReminderDismissed);
      return {
        users: (await abs.users()).map((u) => ({
          id: u.id,
          name: u.username,
          isAdmin: u.type === "admin" || u.type === "root",
          allowedTags: u.permissions?.accessAllTags === false ? (u.itemTagsSelected ?? []) : [],
          personId: people.find((p) => p.abs_user_id === u.id)?.id ?? null,
          meantToSeeAll: dismissed.has(u.id),
        })),
      };
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  app.post<{ Params: { userId: string }; Body: { allowedTags?: string[] } }>("/api/access/:userId", async (req, reply) => {
    const abs = engine.abs();
    if (!abs) return reply.code(400).send({ error: "Audiobookshelf isn't connected" });
    const tags = arrayOf(req.body?.allowedTags, "string").map((t) => t.trim()).filter(Boolean);
    try {
      const user = await abs.user(req.params.userId);
      await abs.setAllowedTags(user, tags);
      logActivity(db, "access", tags.length ? `${user.username} now sees books tagged ${tags.map((t) => `“${t}”`).join(" or ")}` : `${user.username} now sees everything`);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  app.get("/api/access/reminders", async () => {
    const abs = engine.abs();
    if (!abs) return [];
    let users;
    try {
      users = await abs.users();
    } catch {
      return [];
    }
    const dismissed = new Set(getSettings(db).accessReminderDismissed);
    const out: { userId: string; personName: string }[] = [];
    for (const p of listPeople(db)) {
      const u = users.find((x) => x.id === p.abs_user_id);
      if (!u || u.type === "admin" || u.type === "root" || dismissed.has(u.id) || u.permissions?.accessAllTags === false) continue;
      out.push({ userId: u.id, personName: p.name });
    }
    return out;
  });

  app.post<{ Body: { userIds?: string[] } }>("/api/access/reminders/dismiss", async (req) => {
    const s = getSettings(db);
    saveSettings(db, { accessReminderDismissed: [...new Set([...s.accessReminderDismissed, ...arrayOf(req.body?.userIds, "string")])] });
    return { ok: true };
  });

  // --- Moving to one library ----------------------------------------------------------

  app.get("/api/migrate", async (_req, reply) => {
    const s = getSettings(db);
    const abs = engine.abs(s);
    let libraries: { id: string; name: string; path: string | null }[] = [];
    if (abs) {
      try {
        libraries = (await abs.libraries()).map((l) => ({ id: l.id, name: l.name, path: l.folders[0]?.fullPath ?? null }));
      } catch (err) {
        return reply.code(502).send({ error: errorText(err) });
      }
    }
    return {
      libraries,
      sharedLibraryId: s.absLibraryId,
      sharedPath: path.posix.join(s.absRoot, s.destSubdir),
      snapshot: {
        entries: count("SELECT count(*) AS n FROM progress_snapshot"),
        restored: count("SELECT count(*) AS n FROM progress_snapshot WHERE restored_at IS NOT NULL"),
      },
      pending: count("SELECT count(*) AS n FROM proposals WHERE scope = 'library' AND status IN ('pending', 'failed')"),
      applied: count("SELECT count(*) AS n FROM proposals WHERE scope = 'library' AND status = 'applied'"),
    };
  });

  app.post("/api/migrate/snapshot", async (_req, reply) => {
    try {
      return await engine.exclusive("Saving listening progress", () => engine.snapshotProgress());
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  /** Makes the shared library in Audiobookshelf and gives everyone linked access to it. */
  app.post<{ Body: { name?: string } }>("/api/migrate/library", async (req, reply) => {
    const s = getSettings(db);
    const abs = engine.abs(s);
    if (!abs) return reply.code(400).send({ error: "Connect Audiobookshelf first" });
    try {
      // Audiobookshelf's own libraries show where it really sees the audiobooks
      // folder ("/audiobooks/audiobooks-Owen" means "/audiobooks"), which beats
      // a setting that's easy to get wrong.
      const allLibraries = await abs.libraries();
      for (const p of listPeople(db)) {
        const seen = p.folder ? allLibraries.flatMap((l) => l.folders.map((f) => f.fullPath)).find((f) => path.posix.basename(f) === p.folder) : null;
        const root = seen ? path.posix.dirname(seen) : null;
        if (root && root !== s.absRoot) {
          logActivity(db, "access", `Audiobookshelf sees the audiobooks folder at ${root}, not ${s.absRoot}: corrected`);
          saveSettings(db, { absRoot: root });
          s.absRoot = root;
        }
        if (root) break;
      }
      const folder = path.posix.join(s.absRoot, s.destSubdir);
      // It has to exist before Audiobookshelf will accept it.
      fs.mkdirSync(engine.destRoot(s), { recursive: true });
      const existing = allLibraries.find((l) => l.folders.some((f) => f.fullPath === folder));
      const lib = existing ?? (await abs.createLibrary(String(req.body?.name ?? "").trim() || "Audiobooks", folder));
      saveSettings(db, { absLibraryId: lib.id });
      await abs.scan(lib.id).catch(() => {});
      for (const p of listPeople(db)) {
        if (!p.abs_user_id) continue;
        const u = await abs.user(p.abs_user_id);
        if (u.type === "admin" || u.type === "root" || u.permissions?.accessAllLibraries) continue;
        await abs.setLibraryAccess(u, [...new Set([...(u.librariesAccessible ?? []), lib.id])]);
      }
      logActivity(db, "access", `Using “${lib.name}” as the shared library`);
      return { id: lib.id, name: lib.name };
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  app.post("/api/migrate/restore", async (_req, reply) => {
    try {
      return await engine.exclusive("Restoring listening progress", async () => {
        await engine.syncAbs(true);
        return engine.restoreProgress();
      });
    } catch (err) {
      return reply.code(502).send({ error: errorText(err) });
    }
  });

  // --- Settings ------------------------------------------------------------------------

  app.get("/api/settings", async () => {
    const s = getSettings(db);
    return {
      absUrl: s.absUrl,
      absTokenSet: !!s.absToken,
      absLibraryId: s.absLibraryId,
      libraryRoot: s.libraryRoot,
      absRoot: s.absRoot,
      destSubdir: s.destSubdir,
      incomingDir: s.incomingDir,
      incomingMode: s.incomingMode,
      autoOrganize: s.autoOrganize,
      defaultOwners: s.defaultOwners,
      scanIntervalMinutes: s.scanIntervalMinutes,
      settleMinutes: s.settleMinutes,
      accessReminderDismissed: s.accessReminderDismissed,
      adminUsername: s.adminUsername,
      setupComplete: s.setupComplete,
    };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/settings", async (req, reply) => {
    const b = req.body ?? {};
    const patch: Partial<Settings> = {};
    if (b.absUrl !== undefined) {
      const url = String(b.absUrl).trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return reply.code(400).send({ error: "The Audiobookshelf address must start with http:// or https://" });
      patch.absUrl = url;
    }
    if (typeof b.absToken === "string" && b.absToken) patch.absToken = b.absToken.trim();
    if (b.absToken === null) patch.absToken = "";
    if (typeof b.absLibraryId === "string") patch.absLibraryId = b.absLibraryId;
    for (const key of ["libraryRoot", "absRoot", "incomingDir"] as const) {
      if (b[key] === undefined) continue;
      const v = String(b[key]).trim().replace(/(.)\/+$/, "$1");
      if (v && !v.startsWith("/")) return reply.code(400).send({ error: "Folders must be full paths, starting with /" });
      patch[key] = v;
    }
    if (b.destSubdir !== undefined) {
      const v = String(b.destSubdir).trim();
      if (!v || /[/\\]/.test(v) || v.startsWith(".")) return reply.code(400).send({ error: "The library folder must be a single folder name" });
      patch.destSubdir = v;
    }
    if (b.incomingMode === "hardlink" || b.incomingMode === "copy" || b.incomingMode === "move") patch.incomingMode = b.incomingMode;
    if (typeof b.autoOrganize === "boolean") patch.autoOrganize = b.autoOrganize;
    if (Array.isArray(b.defaultOwners)) patch.defaultOwners = b.defaultOwners.map(Number).filter(Number.isInteger);
    if (b.scanIntervalMinutes !== undefined) {
      const n = Number(b.scanIntervalMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 1440) return reply.code(400).send({ error: "Check every 1–1440 minutes" });
      patch.scanIntervalMinutes = Math.round(n);
    }
    if (b.settleMinutes !== undefined) {
      const n = Number(b.settleMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 1440) return reply.code(400).send({ error: "Wait 0–1440 minutes" });
      patch.settleMinutes = n;
    }
    if (Array.isArray(b.accessReminderDismissed)) patch.accessReminderDismissed = [...new Set(b.accessReminderDismissed.map(String))];
    if (typeof b.setupComplete === "boolean") patch.setupComplete = b.setupComplete;
    saveSettings(db, patch);
    return { ok: true };
  });

  app.post<{ Body: { url?: string; token?: string } }>("/api/test/abs", async (req, reply) => {
    const s = getSettings(db);
    const url = String(req.body?.url ?? s.absUrl).trim();
    const token = String(req.body?.token || s.absToken);
    if (!url || !token) return reply.code(400).send({ error: "Enter the address and an API token" });
    try {
      const res = await new Abs(url, token).test();
      return { ok: true, username: res.username, version: res.version, libraries: res.libraries.map((l) => ({ id: l.id, name: l.name, path: l.folders[0]?.fullPath ?? null })) };
    } catch (err) {
      return reply.code(502).send({ error: friendlyError(err) });
    }
  });

  /** Can this container see and change the folders? Asked before anything moves. */
  app.get("/api/folders", async () => {
    const s = getSettings(db);
    const probe = (dir: string) => {
      if (!dir) return { path: dir, exists: false, writable: false };
      const exists = fs.existsSync(dir);
      let writable = false;
      if (exists) {
        const file = path.join(dir, `.shelvarr-write-test-${process.pid}`);
        try {
          fs.writeFileSync(file, "");
          fs.rmSync(file);
          writable = true;
        } catch {
          // Reported below.
        }
      }
      return { path: dir, exists, writable };
    };
    return { library: probe(s.libraryRoot), incoming: probe(s.incomingDir), folders: engine.describeRoot() };
  });

  // --- Frontend ----------------------------------------------------------------------------

  const webRoot = opts.webRoot;
  if (webRoot && fs.existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, maxAge: "1h" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  }

  return { app, engine, updates };
}

interface PersonBody {
  name?: string;
  tag?: string;
  absUserId?: string | null;
  folder?: string | null;
}

function publicPerson(p: Person) {
  return { id: p.id, name: p.name, tag: p.tag, color: p.color, absUserId: p.abs_user_id, folder: p.folder };
}

function arrayOf(value: unknown, type: "string"): string[];
function arrayOf(value: unknown, type: "number"): number[];
function arrayOf(value: unknown, type: "string" | "number"): (string | number)[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === type) : [];
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function friendlyError(err: unknown): string {
  const text = errorText(err);
  if (/→ 401|→ 403/.test(text)) return "Audiobookshelf rejected the API token";
  if (/ECONNREFUSED/.test(text)) return "Nothing answered at that address (connection refused). Check the host and port.";
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return "That host name doesn't resolve from the Shelvarr container.";
  if (/timed out/.test(text)) return "Audiobookshelf didn't answer in time";
  if (/→ 404/.test(text)) return "That address answered, but doesn't look like Audiobookshelf.";
  return text;
}
