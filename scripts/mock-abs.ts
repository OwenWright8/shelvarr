// A fake Audiobookshelf for development and the tests: only what Shelvarr uses,
// with the same shapes as the real API. Its "scan" really reads a folder, and
// like the real thing it knows an item by its inode, so renames keep an item.
//
//   npm run dev:mock    # also creates a messy demo library under ./demo
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ABS_TOKEN = "abs-admin-token";

interface MockItem {
  id: string;
  libraryId: string;
  ino: number;
  path: string;
  relPath: string;
  tags: string[];
  title: string;
}

interface MockUser {
  id: string;
  username: string;
  type: string;
  permissions: Record<string, unknown>;
  itemTagsSelected: string[];
  librariesAccessible: string[];
  mediaProgress: Record<string, unknown>[];
  bookmarks: Record<string, unknown>[];
}

export interface AbsMock {
  url: string;
  users: MockUser[];
  items: Map<string, MockItem>;
  libraries: { id: string; name: string; mediaType: string; folders: { id: string; fullPath: string }[] }[];
  apiKeys: Map<string, string>;
  addLibrary(name: string, fullPath: string): string;
  scan(libraryId: string): void;
  close(): Promise<void>;
}

/** Audiobookshelf's grouping, simplified: a folder holding audio is one item. */
function findItems(root: string): { dir: string; ino: number }[] {
  const out: { dir: string; ino: number }[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== root && entries.some((e) => e.isFile() && /\.(mp3|m4b|m4a|flac)$/i.test(e.name))) {
      out.push({ dir, ino: fs.statSync(dir).ino });
      return;
    }
    for (const e of entries) {
      if (!e.name.startsWith(".") && e.isDirectory()) visit(path.join(dir, e.name));
      else if (dir === root && e.isFile() && /\.(mp3|m4b|m4a|flac)$/i.test(e.name)) out.push({ dir: path.join(dir, e.name), ino: fs.statSync(path.join(dir, e.name)).ino });
    }
  };
  visit(root);
  return out;
}

export async function startAbsMock(): Promise<AbsMock> {
  let counter = 1;
  const id = (prefix: string) => `${prefix}-${String(counter++).padStart(8, "0")}`;
  const items = new Map<string, MockItem>();
  const apiKeys = new Map<string, string>();
  const user = (name: string, type: string): MockUser => ({
    id: `user-${name}`,
    username: name,
    type,
    permissions: { accessAllLibraries: false, accessAllTags: true, selectedTagsNotAccessible: false, download: true },
    itemTagsSelected: [],
    librariesAccessible: [],
    mediaProgress: [],
    bookmarks: [],
  });
  const users = [user("root", "root"), user("owen", "admin"), user("alex", "user"), user("jamie", "user")];
  const libraries: AbsMock["libraries"] = [];

  const scan = (libraryId: string) => {
    const lib = libraries.find((l) => l.id === libraryId);
    if (!lib) return;
    const root = lib.folders[0].fullPath;
    const found = findItems(root);
    const seen = new Set<string>();
    for (const f of found) {
      const existing = [...items.values()].find((i) => i.libraryId === libraryId && i.ino === f.ino);
      if (existing) {
        existing.path = f.dir;
        existing.relPath = path.relative(root, f.dir);
        seen.add(existing.id);
      } else {
        const item: MockItem = { id: id("item"), libraryId, ino: f.ino, path: f.dir, relPath: path.relative(root, f.dir), tags: [], title: path.basename(f.dir) };
        items.set(item.id, item);
        seen.add(item.id);
      }
    }
    for (const i of [...items.values()]) if (i.libraryId === libraryId && !seen.has(i.id)) items.delete(i.id);
  };

  const addLibrary = (name: string, fullPath: string) => {
    const lib = { id: id("lib"), name, mediaType: "book", folders: [{ id: id("fol"), fullPath }] };
    libraries.push(lib);
    scan(lib.id);
    return lib.id;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (url.pathname === "/status") return send(200, { serverVersion: "2.37.2" });
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
    const me = bearer === ABS_TOKEN ? users[0] : users.find((u) => u.id === apiKeys.get(bearer));
    if (!me) return send(401, { error: "Unauthorized" });
    const body = await new Promise<string>((resolve) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => resolve(d));
    });
    const json = body ? JSON.parse(body) : {};
    const p = url.pathname;
    const m = req.method;

    if (p === "/api/me") return send(200, me);
    if (p === "/api/libraries" && m === "GET") return send(200, { libraries });
    if (p === "/api/libraries" && m === "POST") {
      const lib = { id: id("lib"), name: json.name, mediaType: json.mediaType, folders: json.folders.map((f: { fullPath: string }) => ({ id: id("fol"), fullPath: f.fullPath })) };
      if (!fs.existsSync(lib.folders[0].fullPath)) return send(400, { error: "Folder doesn't exist" });
      libraries.push(lib);
      return send(200, lib);
    }
    let r = p.match(/^\/api\/libraries\/([^/]+)\/scan$/);
    if (r) {
      scan(r[1]);
      return send(200, "OK");
    }
    r = p.match(/^\/api\/libraries\/([^/]+)\/items$/);
    if (r) {
      const libId = r[1];
      const all = [...items.values()].filter((i) => i.libraryId === libId);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const page = Number(url.searchParams.get("page") ?? 0);
      return send(200, {
        total: all.length,
        results: all.slice(page * limit, (page + 1) * limit).map((i) => ({ id: i.id, libraryId: i.libraryId, path: i.path, relPath: i.relPath, media: { tags: i.tags, metadata: { title: i.title } } })),
      });
    }
    if (p === "/api/items/batch/update" && m === "POST") {
      for (const u of json) {
        const item = items.get(u.id);
        if (item) item.tags = u.mediaPayload.tags;
      }
      return send(200, { success: true });
    }
    if (p === "/api/users") return send(200, { users: users.map(({ mediaProgress: _m, bookmarks: _b, ...u }) => u) });
    r = p.match(/^\/api\/users\/([^/]+)$/);
    if (r) {
      const u = users.find((x) => x.id === r![1]);
      if (!u) return send(404);
      if (m === "PATCH") {
        if (json.permissions) u.permissions = { ...u.permissions, ...json.permissions };
        if (json.itemTagsSelected) u.itemTagsSelected = json.itemTagsSelected;
        if (json.librariesAccessible) u.librariesAccessible = json.librariesAccessible;
      }
      return send(200, u);
    }
    if (p === "/api/api-keys" && m === "POST") {
      const key = `key-${id("k")}`;
      apiKeys.set(key, json.userId);
      return send(200, { apiKey: { id: key, apiKey: key, userId: json.userId } });
    }
    r = p.match(/^\/api\/api-keys\/([^/]+)$/);
    if (r && m === "DELETE") {
      apiKeys.delete(r[1]);
      return send(200);
    }
    r = p.match(/^\/api\/me\/progress\/([^/]+)$/);
    if (r && m === "PATCH") {
      me.mediaProgress = me.mediaProgress.filter((x) => x.libraryItemId !== r![1]);
      me.mediaProgress.push({ libraryItemId: r[1], ...json });
      return send(200);
    }
    r = p.match(/^\/api\/me\/item\/([^/]+)\/bookmark$/);
    if (r && m === "POST") {
      me.bookmarks.push({ libraryItemId: r[1], ...json });
      return send(200, {});
    }
    if (p === "/api/search/books") {
      const q = (url.searchParams.get("title") ?? "").toLowerCase();
      const provider = url.searchParams.get("provider");
      const catalog = [{ title: "The Wishing Spell: The Land of Stories, Book 1", author: "Chris Colfer", narrator: "Chris Colfer", publishedYear: "2012" }];
      return send(200, provider === "audible" ? catalog.filter((c) => c.title.toLowerCase().includes(q)) : []);
    }
    r = p.match(/^\/api\/items\/([^/]+)\/cover$/);
    if (r) return send(404);
    if (p === "/api/tags/rename" && m === "POST") {
      for (const i of items.values()) i.tags = i.tags.map((t) => (t === json.tag ? json.newTag : t));
      return send(200);
    }
    send(404, { error: "not implemented in mock" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    users,
    items,
    libraries,
    apiKeys,
    addLibrary,
    scan,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

// --- A messy library, from real file names -----------------------------------------------

/** Files with their tags, written as real (tiny) MP3s so the real tag reader runs. */
function id3(tags: Record<string, string>): Buffer {
  const frames = Object.entries(tags).map(([id, value]) => {
    const text = Buffer.from([1, 0xff, 0xfe, ...Buffer.from(value, "utf16le")]);
    const head = Buffer.alloc(10);
    head.write(id, 0, "latin1");
    head.writeUInt32BE(text.length, 4);
    return Buffer.concat([head, text]);
  });
  const body = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "latin1");
  header[3] = 3;
  const n = body.length;
  header[6] = (n >> 21) & 0x7f;
  header[7] = (n >> 14) & 0x7f;
  header[8] = (n >> 7) & 0x7f;
  header[9] = n & 0x7f;
  return Buffer.concat([header, body]);
}

export function writeBook(file: string, tags: { album?: string; artist?: string; albumartist?: string; title?: string; composer?: string }, bytes = 2048, seed = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const map: Record<string, string> = {};
  if (tags.album) map.TALB = tags.album;
  if (tags.artist) map.TPE1 = tags.artist;
  if (tags.albumartist) map.TPE2 = tags.albumartist;
  if (tags.title) map.TIT2 = tags.title;
  if (tags.composer) map.TCOM = tags.composer;
  const frame = Buffer.alloc(bytes, (seed * 31 + 7) & 0xff);
  // A real MPEG frame header, so it parses as audio.
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  fs.writeFileSync(file, Buffer.concat([id3(map), frame]));
  const old = new Date(Date.now() - 86_400_000);
  fs.utimesSync(file, old, old);
}

/** The shape of a real three-person library, before any tidying. */
export function writeMessyLibrary(root: string) {
  const owen = "audiobooks-Owen";
  const alex = "audiobooks-Alex";
  const jamie = "audiobooks-Jamie";
  const phm = { album: "Project Hail Mary", artist: "Andy Weir", title: "Project Hail Mary", composer: "Ray Porter" };
  // Three real copies of one book, in three different shapes.
  writeBook(`${root}/${owen}/Andy Weir/Project Hail Mary/Andy Weir - Project Hail Mary  - Project Hail Mary.mp3`, phm, 9000, 1);
  writeBook(`${root}/${alex}/Andy Weir/Andy Weir - Project Hail Mary  - Project Hail Mary.mp3`, phm, 9000, 1);
  writeBook(`${root}/${jamie}/Andy Weir/Project Hail Mary/Andy Weir - Project Hail Mary  - Project Hail Mary.mp3`, phm, 9000, 1);
  fs.writeFileSync(`${root}/${owen}/Andy Weir/Project Hail Mary/metadata.json`, JSON.stringify({ title: "Project Hail Mary", authors: ["Andy Weir"], narrators: ["Ray Porter"] }));
  // A stale metadata file left in an author folder, describing some other book.
  writeBook(`${root}/${jamie}/Andy Weir/The Martian/Andy Weir - The Martian  - The Martian.mp3`, { album: "The Martian", albumartist: "Andy Weir", artist: "Andy Weir", title: "The Martian" }, 7000, 2);
  fs.writeFileSync(`${root}/${jamie}/Andy Weir/metadata.json`, JSON.stringify({ title: "The Martian", authors: ["Andy Weir"] }));
  // Loose in the person's folder.
  const hg = { album: "Hunger Games #2: Catching Fire", albumartist: "Suzanne Collins", artist: "Suzanne Collins", title: "Catching Fire", composer: "Carolyn McCormick" };
  writeBook(`${root}/${owen}/Suzanne Collins - Catching Fire.mp3`, hg, 8000, 3);
  writeBook(`${root}/${alex}/Suzanne Collins - Catching Fire.mp3`, hg, 8000, 3);
  writeBook(`${root}/${owen}/Michael Crichton - Airframe.mp3`, { album: "Airframe: A Novel", artist: "Michael Crichton", title: "Airframe: A Novel" }, 3000, 4);
  // Chapter files loose in an author folder.
  for (let i = 1; i <= 4; i++) {
    const n = String(i).padStart(2, "0");
    writeBook(`${root}/${owen}/Bonnie Jo Campbell/Once Upon a River (2011) - pt${n}.mp3`, { album: "Once Upon a River", albumartist: "Bonnie Jo Campbell", artist: "Bonnie Jo Campbell, Susan Bennett", title: `Once Upon A River - Part ${n}`, composer: "Susan Bennett" }, 1500 + i, 10 + i);
  }
  fs.writeFileSync(`${root}/${owen}/Bonnie Jo Campbell/metadata.json`, JSON.stringify({ title: "Once Upon a River", authors: ["Bonnie Jo Campbell", "Susan Bennett"], narrators: ["Susan Bennett"] }));
  // A file named after its author; only the tags know the title.
  writeBook(`${root}/${owen}/Barbara Kingsolver/Barbara Kingsolver.mp3`, { album: "Prodigal Summer", albumartist: "Barbara Kingsolver", artist: "Barbara Kingsolver", title: "Prodigal Summer", composer: "Barbara Kingsolver" }, 2500, 5);
  // Two different files of one book, side by side.
  writeBook(`${root}/${owen}/Andy Weir/Artemis/Andy Weir - Artemis  - Artemis.mp3`, { album: "Artemis", albumartist: "Andy Weir", artist: "Andy Weir", title: "Artemis" }, 6000, 6);
  writeBook(`${root}/${owen}/Andy Weir/Artemis/Andy Weir - Artemis (Unabridged)  - Artemis (Unabridged).mp3`, { album: "Artemis (Unabridged)", artist: "Andy Weir", title: "Artemis (Unabridged)" }, 3000, 7);
  // Series tags, and a folder name that's better than the tags.
  writeBook(`${root}/${alex}/Jeff Kinney/The Third Wheel/Jeff Kinney - Diary of a Wimpy Kid 07 - Diary of a Wimpy Kid_ The Thrid Wheel  - Diary Of A Wimpy Kid_The Third Wheel.mp3`, { album: "Diary of a Wimpy Kid 07 - Diary of a Wimpy Kid: The Thrid Wheel", albumartist: "Jeff Kinney", artist: "Jeff Kinney", title: "Diary Of A Wimpy Kid_The Third Wheel" }, 4000, 8);
  // Not books, and not ours to touch.
  fs.mkdirSync(`${root}/podcasts/Some Show`, { recursive: true });
  writeBook(`${root}/podcasts/Some Show/episode 1.mp3`, { album: "Some Show", artist: "Some Host", title: "Episode 1" }, 1000, 9);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve("demo/audiobooks");
  const incoming = path.resolve("demo/downloads");
  fs.rmSync(path.resolve("demo"), { recursive: true, force: true });
  writeMessyLibrary(root);
  writeBook(`${incoming}/The Thursday Murder Club by Richard Osman.mp3`, { album: "The Thursday Murder Club: The Thursday Murder Club, Book 1", artist: "Richard Osman", title: "The Thursday Murder Club" }, 5000, 20);
  const s = await startAbsMock();
  for (const name of ["Owen", "Alex", "Jamie"]) s.addLibrary(`${name}'s Audiobooks`, path.join(root, `audiobooks-${name}`));
  console.log(`Fake Audiobookshelf: ${s.url}  (API token: ${ABS_TOKEN})`);
  console.log(`Audiobooks folder:   ${root}`);
  console.log(`Downloads folder:    ${incoming}`);
}
