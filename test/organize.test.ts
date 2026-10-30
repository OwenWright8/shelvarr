// End to end: the real app, real files on disk and the real tag reader, against
// a fake Audiobookshelf (scripts/mock-abs.ts), driven through the API like the UI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDb, type DB } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import type { Engine } from "../server/engine.ts";
import { ABS_TOKEN, startAbsMock, writeBook, writeMessyLibrary, type AbsMock } from "../scripts/mock-abs.ts";

let abs: AbsMock;
let app: FastifyInstance;
let engine: Engine;
let db: DB;
let tmp: string;
let root: string;
let incoming: string;
let cookie = "";
const ids: Record<string, number> = {};

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0];
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

/** Every file under a folder, for before/after comparisons. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else out.push(path.relative(dir, p));
    }
  };
  visit(dir);
  return out.sort();
}

const lib = (rel: string) => path.join(root, "library", rel);
const proposals = async () => (await api("GET", "/api/proposals")).json as any[];
const scan = async (scope = "library") => {
  await api("POST", "/api/scan", { scope });
  while (engine.status.running) await new Promise((r) => setTimeout(r, 10));
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shelvarr-test-"));
  root = path.join(tmp, "audiobooks");
  incoming = path.join(tmp, "downloads");
  fs.mkdirSync(incoming, { recursive: true });
  writeMessyLibrary(root);
  abs = await startAbsMock();
  for (const name of ["Owen", "Alex", "Jamie"]) abs.addLibrary(`${name}'s Audiobooks`, path.join(root, `audiobooks-${name}`));
  db = openDb(":memory:");
  ({ app, engine } = await buildApp({ db, version: "v1.0.0", repo: "x/y", updateCheck: false }));
  await api("POST", "/api/account/create", { username: "owen", password: "correct horse" });
  await api("PUT", "/api/settings", { absUrl: abs.url, absToken: ABS_TOKEN, libraryRoot: root, absRoot: root, incomingDir: incoming, settleMinutes: 0, setupComplete: true });
  ids.owen = (await api("POST", "/api/people", { name: "Owen", tag: "Owen", absUserId: "user-owen", folder: "audiobooks-Owen" })).json.id;
  ids.alex = (await api("POST", "/api/people", { name: "Alex", tag: "Alex", absUserId: "user-alex", folder: "audiobooks-Alex" })).json.id;
  ids.jamie = (await api("POST", "/api/people", { name: "Jamie", tag: "Jamie", absUserId: "user-jamie", folder: "audiobooks-Jamie" })).json.id;
});

after(async () => {
  engine.stop();
  await app.close();
  await abs.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the API needs a session, and bad tokens are explained", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api("GET", "/api/proposals")).status, 401);
  cookie = saved;
  const bad = await api("POST", "/api/test/abs", { url: abs.url, token: "wrong" });
  assert.equal(bad.status, 502);
  assert.match(bad.json.error, /rejected the API token/);
  const good = await api("POST", "/api/test/abs", { url: abs.url, token: ABS_TOKEN });
  assert.equal(good.json.libraries.length, 3);
});

test("a scan only proposes: nothing on disk changes", async () => {
  const before = tree(root);
  await scan();
  assert.deepEqual(tree(root), before);
  assert.ok((await proposals()).length > 0);
  // Podcasts aren't anyone's folder, so they aren't looked at.
  assert.ok(!(await proposals()).some((p) => p.sourceDir.startsWith("podcasts")));
});

test("it works out each book, the way a person would", async () => {
  const all = await proposals();
  const find = (t: string) => all.filter((p) => p.title === t);
  // Chapter files in an author folder become one book, with their metadata.
  const river = find("Once Upon a River")[0];
  assert.equal(river.author, "Bonnie Jo Campbell");
  assert.equal(river.audioCount, 4);
  assert.equal(river.fileCount, 5);
  assert.equal(river.dest, "Bonnie Jo Campbell/Once Upon a River");
  // A file named after its author, with the title only in the tags.
  assert.equal(find("Prodigal Summer")[0].dest, "Barbara Kingsolver/Prodigal Summer");
  // Tag noise goes; a good folder name beats a typo in the tags.
  assert.equal(find("Airframe")[0].dest, "Michael Crichton/Airframe");
  assert.equal(find("Catching Fire")[0].dest, "Suzanne Collins/Catching Fire");
  assert.equal(find("The Third Wheel")[0].dest, "Jeff Kinney/The Third Wheel");
  // A stale metadata file in an author folder doesn't get attached to anything.
  const martian = find("The Martian")[0];
  assert.equal(martian.fileCount, 1);
  assert.ok(all.every((p) => p.confidence === "high"), JSON.stringify(all.filter((p) => p.confidence !== "high").map((p) => [p.title, p.why])));
});

test("identical copies are found, and different files with one name need a person", async () => {
  const all = await proposals();
  const phm = all.filter((p) => p.title === "Project Hail Mary");
  assert.equal(phm.length, 3);
  assert.equal(phm.filter((p) => p.kind === "move").length, 1);
  assert.equal(phm.filter((p) => p.kind === "duplicate").length, 2);
  assert.ok(phm.filter((p) => p.kind === "duplicate").every((p) => p.targetRel === "Andy Weir/Project Hail Mary"));
  const artemis = all.filter((p) => p.title === "Artemis");
  assert.deepEqual(artemis.map((p) => p.kind).sort(), ["conflict", "move"]);
  // Unresolved, a conflict won't go ahead.
  const conflict = artemis.find((p) => p.kind === "conflict");
  const res = await api("POST", "/api/proposals/apply", { ids: [conflict.id] });
  assert.equal(res.json.ok, 0);
  assert.match(res.json.failed[0].error, /Choose which copy/);
});

test("applying sorts the library into Author/Book, and everyone owns what they had", async () => {
  const before = tree(path.join(root, "podcasts"));
  const all = await proposals();
  const artemis = all.find((p) => p.title === "Artemis" && p.kind === "conflict");
  await api("PATCH", `/api/proposals/${artemis.id}`, { resolution: "keep_both" });
  // Not before the first copy is in place, or both would land in one folder.
  const early = await api("POST", "/api/proposals/apply", { ids: [artemis.id] });
  assert.match(early.json.failed[0].error, /Organize the other copy/);
  const res = await api("POST", "/api/proposals/apply", { ids: all.map((p) => p.id), label: "First clean-up" });
  assert.deepEqual(res.json.failed, []);

  assert.deepEqual(
    tree(path.join(root, "library")).filter((f) => !f.endsWith(".json")).map((f) => f.split("/").slice(0, 2).join("/")).filter((v, i, a) => a.indexOf(v) === i).sort(),
    [
      "Andy Weir/Artemis",
      "Andy Weir/Artemis (2)",
      "Andy Weir/Project Hail Mary",
      "Andy Weir/The Martian",
      "Barbara Kingsolver/Prodigal Summer",
      "Bonnie Jo Campbell/Once Upon a River",
      "Jeff Kinney/The Third Wheel",
      "Michael Crichton/Airframe",
      "Suzanne Collins/Catching Fire",
    ],
  );
  // Chapters stay together in their own book folder.
  assert.equal(tree(lib("Bonnie Jo Campbell/Once Upon a River")).filter((f) => f.endsWith(".mp3")).length, 4);
  // One copy kept; the others are in the trash, not gone.
  assert.equal(tree(lib("Andy Weir/Project Hail Mary")).filter((f) => f.endsWith(".mp3")).length, 1);
  const trash = (await api("GET", "/api/trash")).json;
  assert.ok(trash.size > 0);
  assert.ok(tree(path.join(root, ".shelvarr-trash")).some((f) => f.includes("audiobooks-Owen")));
  // Podcasts are exactly as they were.
  assert.deepEqual(tree(path.join(root, "podcasts")), before);

  const books = (await api("GET", "/api/books")).json as any[];
  const ownersOf = (rel: string) => books.find((b) => b.rel === rel).owners.sort();
  assert.deepEqual(ownersOf("Andy Weir/Project Hail Mary"), [ids.owen, ids.alex, ids.jamie].sort());
  assert.deepEqual(ownersOf("Suzanne Collins/Catching Fire"), [ids.owen, ids.alex].sort());
  assert.deepEqual(ownersOf("Andy Weir/The Martian"), [ids.jamie]);
  assert.deepEqual(ownersOf("Jeff Kinney/The Third Wheel"), [ids.alex]);
  // Nothing left to do, and a second scan doesn't suggest it all again.
  assert.equal((await proposals()).length, 0);
  await scan();
  assert.equal((await proposals()).length, 0);
});

test("undo puts every file back", async () => {
  const batches = (await api("GET", "/api/batches")).json as any[];
  const first = batches.find((b) => b.label === "First clean-up");
  assert.ok(first.canUndo);
  const res = await api("POST", `/api/batches/${first.id}/undo`, {});
  assert.deepEqual(res.json.problems, []);
  assert.ok(fs.existsSync(path.join(root, "audiobooks-Alex/Andy Weir/Andy Weir - Project Hail Mary  - Project Hail Mary.mp3")));
  assert.ok(fs.existsSync(path.join(root, "audiobooks-Owen/Suzanne Collins - Catching Fire.mp3")));
  assert.equal(tree(path.join(root, "library")).length, 0);
  assert.ok(!fs.existsSync(path.join(root, ".shelvarr-trash")) || tree(path.join(root, ".shelvarr-trash")).length === 0);
  assert.ok((await proposals()).length > 0);
  assert.equal((await api("POST", `/api/batches/${first.id}/undo`, {})).status, 400);
});

test("nothing is overwritten, and a duplicate that isn't identical is never removed", async () => {
  const all = await proposals();
  // Something's appeared where a book was going.
  const river = all.find((p) => p.title === "Once Upon a River");
  fs.mkdirSync(lib("Bonnie Jo Campbell/Once Upon a River"), { recursive: true });
  const blocker = lib("Bonnie Jo Campbell/Once Upon a River/Once Upon a River (2011) - pt02.mp3");
  fs.writeFileSync(blocker, "already here");
  const res = await api("POST", "/api/proposals/apply", { ids: [river.id] });
  assert.equal(res.json.ok, 0);
  assert.match(res.json.failed[0].error, /already at/);
  assert.equal(fs.readFileSync(blocker, "utf8"), "already here");
  // The whole book went back where it was.
  assert.equal(tree(path.join(root, "audiobooks-Owen/Bonnie Jo Campbell")).length, 5);
  fs.rmSync(path.join(root, "library"), { recursive: true });

  // A "duplicate" whose file changed since the scan.
  const dup = (await proposals()).find((p) => p.kind === "duplicate" && p.title === "Project Hail Mary");
  const move = (await proposals()).find((p) => p.kind === "move" && p.title === "Project Hail Mary");
  await api("POST", "/api/proposals/apply", { ids: [move.id] });
  const kept = tree(lib("Andy Weir/Project Hail Mary")).find((f) => f.endsWith(".mp3"))!;
  const file = lib(`Andy Weir/Project Hail Mary/${kept}`);
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 0xff; // Same size, different content.
  fs.writeFileSync(file, bytes);
  const merged = await api("POST", "/api/proposals/apply", { ids: [dup.id] });
  assert.equal(merged.json.ok, 0);
  assert.match(merged.json.failed[0].error, /aren't identical/);
  assert.ok(fs.existsSync(path.join(root, dup.files[0])));
  // Put it right, and finish the job.
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(file, bytes);
  const rest = (await proposals()).filter((p) => !(p.kind === "conflict" && !p.resolution));
  const final = await api("POST", "/api/proposals/apply", { ids: rest.map((p) => p.id) });
  assert.deepEqual(final.json.failed, []);
  const conflict = (await proposals()).find((p) => p.kind === "conflict");
  if (conflict) {
    await api("PATCH", `/api/proposals/${conflict.id}`, { resolution: "keep_both" });
    await api("POST", "/api/proposals/apply", { ids: [conflict.id] });
  }
  assert.equal((await proposals()).length, 0);
});

test("a new download goes to the default owner, and the original stays for seeding", async () => {
  await api("PUT", "/api/settings", { defaultOwners: [ids.owen], incomingMode: "hardlink" });
  const file = path.join(incoming, "The Thursday Murder Club by Richard Osman.mp3");
  writeBook(file, { album: "The Thursday Murder Club: The Thursday Murder Club, Book 1", artist: "Richard Osman", title: "The Thursday Murder Club" }, 5000, 20);
  // Until setup is finished, nothing happens on its own.
  await api("PUT", "/api/settings", { setupComplete: false });
  await engine.tick();
  assert.ok(!fs.existsSync(lib("Richard Osman")));
  await api("PUT", "/api/settings", { setupComplete: true });
  await engine.tick();
  const placed = lib("Richard Osman/The Thursday Murder Club/The Thursday Murder Club by Richard Osman.mp3");
  assert.ok(fs.existsSync(placed));
  // Still there, and the same file on disk: no space used twice.
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).ino, fs.statSync(placed).ino);
  const book = ((await api("GET", "/api/books")).json as any[]).find((b) => b.title === "The Thursday Murder Club");
  assert.deepEqual(book.owners, [ids.owen]);
  // The next check doesn't import it again.
  await engine.tick();
  assert.equal(tree(lib("Richard Osman/The Thursday Murder Club")).length, 1);
});

test("a download we already have only adds an owner; one we're unsure of waits", async () => {
  // The same audio as a book in the library, under a messy name.
  const existing = tree(lib("Suzanne Collins/Catching Fire")).find((f) => f.endsWith(".mp3"))!;
  const copy = path.join(incoming, "Suzanne Collins - The Hunger Games 02 - Catching Fire/01 Catching Fire.mp3");
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(lib(`Suzanne Collins/Catching Fire/${existing}`), copy);
  fs.utimesSync(copy, new Date(0), new Date(0));
  await engine.tick();
  assert.ok(fs.existsSync(copy));
  assert.equal(tree(lib("Suzanne Collins/Catching Fire")).filter((f) => f.endsWith(".mp3")).length, 1);

  // Bad tags: the folder says something else, so a person decides.
  writeBook(path.join(incoming, "The Land Of Stories - The Wishing Spell/01 Prologue.mp3"), { album: "The Wishing Well", albumartist: "Chris Colfer", artist: "Chris Colfer", title: "Prologue" }, 3000, 30);
  await engine.tick();
  const review = (await proposals()).find((p) => p.scope === "incoming");
  assert.equal(review.confidence, "medium");
  // An online lookup, searching for what the folder says, offers the fix.
  assert.deepEqual(review.suggestion && [review.suggestion.author, review.suggestion.title], ["Chris Colfer", "The Wishing Spell"]);
  assert.equal((await api("GET", "/api/lookup?title=wishing+spell")).json[0].title, "The Wishing Spell");
  assert.ok(!fs.existsSync(lib("Chris Colfer")));
  // Fixed by hand, it goes.
  await api("PATCH", `/api/proposals/${review.id}`, { title: "The Wishing Spell" });
  await api("POST", "/api/proposals/apply", { ids: [review.id] });
  assert.ok(fs.existsSync(lib("Chris Colfer/The Wishing Spell/01 Prologue.mp3")));
});

test("a download still being written is left alone", async () => {
  await api("PUT", "/api/settings", { settleMinutes: 10 });
  const file = path.join(incoming, "Yann Martel - Life of Pi.mp3");
  writeBook(file, { album: "Life Of Pi", artist: "Yann Martel", title: "Life Of Pi" }, 2000, 40);
  fs.utimesSync(file, new Date(), new Date());
  await engine.tick();
  assert.ok(!fs.existsSync(lib("Yann Martel")));
  await api("PUT", "/api/settings", { settleMinutes: 0 });
  await engine.tick();
  assert.ok(fs.existsSync(lib("Yann Martel/Life Of Pi")));
});

test("moving to one library: progress is carried over, tags and access follow", async () => {
  // Everyone's listening progress, on the old per-person library items... which
  // were moved already in this test, so take it from a fresh pair of books.
  const owenLib = abs.libraries.find((l) => l.name === "Owen's Audiobooks")!;
  const lilLib = abs.libraries.find((l) => l.name === "Alex's Audiobooks")!;
  writeBook(path.join(root, "audiobooks-Owen/Delia Owens/Where the Crawdads Sing/Crawdads.mp3"), { album: "Where the Crawdads Sing (Unabridged)", albumartist: "Delia Owens", artist: "Delia Owens", title: "Where the Crawdads Sing" }, 2200, 50);
  writeBook(path.join(root, "audiobooks-Alex/Delia Owens - Where the Crawdads Sing.mp3"), { album: "Where the Crawdads Sing (Unabridged)", albumartist: "Delia Owens", artist: "Delia Owens", title: "Where the Crawdads Sing" }, 2200, 50);
  abs.scan(owenLib.id);
  abs.scan(lilLib.id);
  const itemIn = (libId: string) => [...abs.items.values()].find((i) => i.libraryId === libId && /Crawdads/.test(i.path))!;
  const owenUser = abs.users.find((u) => u.username === "owen")!;
  const lilUser = abs.users.find((u) => u.username === "alex")!;
  owenUser.mediaProgress.push({ libraryItemId: itemIn(owenLib.id).id, currentTime: 1000, progress: 0.25, duration: 4000, isFinished: false, lastUpdate: 5 });
  owenUser.bookmarks.push({ libraryItemId: itemIn(owenLib.id).id, time: 900, title: "Good part" });
  lilUser.mediaProgress.push({ libraryItemId: itemIn(lilLib.id).id, currentTime: 4000, progress: 1, duration: 4000, isFinished: true, lastUpdate: 9 });

  const snap = await api("POST", "/api/migrate/snapshot", {});
  assert.equal(snap.json.entries, 2);
  await scan();
  await api("POST", "/api/proposals/apply", { ids: (await proposals()).filter((p) => p.title === "Where the Crawdads Sing").map((p) => p.id) });
  // One copy survives; which one doesn't matter, they're identical.
  assert.equal(tree(lib("Delia Owens/Where the Crawdads Sing")).length, 1);

  // A wrong path for Audiobookshelf's view is corrected from its own libraries.
  await api("PUT", "/api/settings", { absRoot: "/media/audiobooks" });
  const made = await api("POST", "/api/migrate/library", { name: "Audiobooks" });
  assert.equal((await api("GET", "/api/settings")).json.absRoot, root);
  assert.equal(made.status, 200);
  assert.equal(abs.libraries.find((l) => l.id === made.json.id)?.folders[0].fullPath, path.join(root, "library"));
  // Linked users can reach it; the admin already can.
  assert.ok(lilUser.librariesAccessible.includes(made.json.id));

  const restored = await api("POST", "/api/migrate/restore", {});
  assert.deepEqual(restored.json.problems, []);
  assert.equal(restored.json.restored, 2);
  const item = [...abs.items.values()].find((i) => i.libraryId === made.json.id && i.path.endsWith("Where the Crawdads Sing"))!;
  // Each person's own progress, on the one shared copy.
  assert.equal((owenUser.mediaProgress.find((p) => p.libraryItemId === item.id) as any).currentTime, 1000);
  assert.equal((lilUser.mediaProgress.find((p) => p.libraryItemId === item.id) as any).isFinished, true);
  assert.equal((owenUser.bookmarks.find((b) => b.libraryItemId === item.id) as any).title, "Good part");
  // The temporary keys are gone.
  assert.equal(abs.apiKeys.size, 0);
  // Tags went on in Audiobookshelf.
  assert.deepEqual([...item.tags].sort(), ["Alex", "Owen"]);
});

test("owners and access are set from the app", async () => {
  const shared = abs.libraries.find((l) => l.name === "Audiobooks")!;
  await engine.syncAbs(true);
  const item = [...abs.items.values()].find((i) => i.libraryId === shared.id && i.path.endsWith("The Martian"))!;
  assert.deepEqual(item.tags, ["Jamie"]);
  await api("POST", "/api/books/owners", { rels: ["Andy Weir/The Martian"], add: [ids.alex] });
  assert.deepEqual([...item.tags].sort(), ["Alex", "Jamie"]);
  await api("POST", "/api/books/owners", { rels: ["Andy Weir/The Martian"], remove: [ids.jamie] });
  assert.deepEqual(item.tags, ["Alex"]);
  // It stays off after the next sync.
  await engine.syncAbs(true);
  assert.deepEqual(item.tags, ["Alex"]);

  // Alex and Jamie can still see everything; the admin doesn't count.
  let reminders = (await api("GET", "/api/access/reminders")).json as any[];
  assert.deepEqual(reminders.map((r) => r.personName).sort(), ["Alex", "Jamie"]);
  await api("POST", "/api/access/user-alex", { allowedTags: ["Alex"] });
  const lil = abs.users.find((u) => u.username === "alex")!;
  assert.equal(lil.permissions.accessAllTags, false);
  assert.deepEqual(lil.itemTagsSelected, ["Alex"]);
  // The rest of their permissions are untouched.
  assert.equal(lil.permissions.download, true);
  reminders = (await api("GET", "/api/access/reminders")).json as any[];
  assert.deepEqual(reminders.map((r) => r.personName), ["Jamie"]);
});

test("emptying the trash is the only real delete, and only when asked", async () => {
  const before = (await api("GET", "/api/trash")).json.size;
  assert.ok(before > 0);
  await engine.tick();
  assert.equal((await api("GET", "/api/trash")).json.size, before);
  const res = await api("POST", "/api/trash/empty", {});
  assert.equal(res.json.freed, before);
  assert.equal((await api("GET", "/api/trash")).json.size, 0);
  // What used the trash can't be undone any more, and the app says so.
  const batches = (await api("GET", "/api/batches")).json as any[];
  assert.ok(batches.some((b) => !b.canUndo && !b.undone));
});

test("the folders check says what's what", async () => {
  const f = (await api("GET", "/api/folders")).json;
  assert.equal(f.library.writable, true);
  const roles = Object.fromEntries(f.folders.map((x: any) => [x.name, x.role]));
  assert.equal(roles["audiobooks-Owen"], "person");
  assert.equal(roles.library, "library");
  assert.equal(roles.podcasts, "ignored");
});
