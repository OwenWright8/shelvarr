// Reads a folder tree and works out which files make up which book, and what
// each book is called. Nothing here changes anything on disk.
import fs from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import { bookTitle, cleanName, firstAuthor, isGenericTitle, looksLikePartName, nameKey, parseName, stripPartNumber } from "./naming.ts";

export const AUDIO = /\.(mp3|m4b|m4a|m4p|flac|ogg|oga|opus|aac|wav|wma|mp2)$/i;
const IN_PROGRESS = /\.(part|tmp|crdownload|download|!qb|aria2|temp|partial)$/i;
const DISC_DIR = /^(?:cd|dis[ck]|part|vol(?:ume)?)[\s._-]*\d+$/i;
const SKIP_DIR = /^(?:@eaDir|#recycle|\.Trash.*|lost\+found)$/;

export interface FileTags {
  album?: string;
  albumartist?: string;
  artist?: string;
  title?: string;
  composer?: string;
  year?: string;
  track?: number | null;
  disc?: number | null;
}

export type TagReader = (file: string) => Promise<FileTags>;

export const readTags: TagReader = async (file) => {
  const { common: c } = await parseFile(file, { duration: false, skipCovers: true });
  return {
    album: c.album,
    albumartist: c.albumartist,
    artist: c.artist,
    title: c.title,
    composer: c.composer?.join(", "),
    year: c.year != null ? String(c.year) : undefined,
    track: c.track?.no ?? null,
    disc: c.disk?.no ?? null,
  };
};

export interface FoundFile {
  /** Relative to the scanned root. */
  path: string;
  /** Where it goes inside the book folder ("Disc 1/01.mp3"). */
  name: string;
  size: number;
  mtimeMs: number;
  ino: number;
  audio: boolean;
}

export type Confidence = "high" | "medium" | "low";

export interface FoundBook {
  /** The folder it's in now, relative to the scanned root ("" for the root). */
  dir: string;
  files: FoundFile[];
  author: string | null;
  title: string | null;
  narrator: string | null;
  year: string | null;
  confidence: Confidence;
  /** Plain words for the review page. */
  why: string;
  size: number;
  newestMtimeMs: number;
  /** Something's still being written here. */
  busy: boolean;
}

interface DirInfo {
  rel: string;
  audio: FoundFile[];
  other: FoundFile[];
  subdirs: string[];
}

/** Lists a tree. Dot-folders and NAS system folders are skipped; symlinks are never followed. */
export function walkTree(root: string, start = ""): Map<string, DirInfo> {
  const dirs = new Map<string, DirInfo>();
  const visit = (rel: string) => {
    const abs = path.join(root, rel);
    const info: DirInfo = { rel, audio: [], other: [], subdirs: [] };
    dirs.set(rel, info);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIR.test(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        info.subdirs.push(e.name);
        visit(childRel);
      } else if (e.isFile()) {
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(root, childRel));
        } catch {
          continue;
        }
        const file: FoundFile = { path: childRel, name: e.name, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, audio: AUDIO.test(e.name) };
        (file.audio ? info.audio : info.other).push(file);
      }
    }
  };
  visit(start);
  return dirs;
}

/** Sorts one folder's audio into books: chapters that belong together, loose books apart. */
function groupByBook(files: FoundFile[], tags: Map<string, FileTags>): FoundFile[][] {
  if (files.length <= 1) return files.length ? [files] : [];
  const groups = new Map<string, FoundFile[]>();
  for (const f of files) {
    const t = tags.get(f.path) ?? {};
    const stem = f.name.replace(/\.[^.]+$/, "");
    const base = stripPartNumber(stem);
    // Same album tag means same book; otherwise the name without its part number.
    const key = t.album ? `album:${nameKey(t.album)}` : looksLikePartName(stem) ? `name:${nameKey(base) || "parts"}` : `file:${nameKey(stem)}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()];
}

async function tagsFor(files: FoundFile[], root: string, reader: TagReader): Promise<Map<string, FileTags>> {
  const out = new Map<string, FileTags>();
  const read = async (f: FoundFile) => {
    try {
      out.set(f.path, await reader(path.join(root, f.path)));
    } catch {
      out.set(f.path, {});
    }
  };
  // A folder of 80 chapters: first, middle and last are enough if they agree.
  if (files.length > 6) {
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const sample = [sorted[0], sorted[sorted.length >> 1], sorted[sorted.length - 1]];
    for (const f of sample) await read(f);
    const albums = new Set(sample.map((f) => nameKey(out.get(f.path)?.album ?? "")));
    if (albums.size === 1) {
      const t = out.get(sample[0].path)!;
      for (const f of files) if (!out.has(f.path)) out.set(f.path, t);
      return out;
    }
  }
  for (const f of files) if (!out.has(f.path)) await read(f);
  return out;
}

function readSidecar(root: string, dir: DirInfo): { title?: string; author?: string; narrator?: string; year?: string } | null {
  const meta = dir.other.find((f) => f.name === "metadata.json");
  if (meta) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, meta.path), "utf8")) as Record<string, unknown>;
      const authors = Array.isArray(j.authors) ? j.authors.map(String) : [];
      const narrators = Array.isArray(j.narrators) ? j.narrators.map(String) : [];
      return {
        title: typeof j.title === "string" ? j.title : undefined,
        author: firstAuthor(authors.join(", "), narrators) ?? undefined,
        narrator: narrators[0],
        year: typeof j.publishedYear === "string" ? j.publishedYear : undefined,
      };
    } catch {
      return null;
    }
  }
  const opf = dir.other.find((f) => /\.opf$/i.test(f.name));
  if (opf) {
    try {
      const xml = fs.readFileSync(path.join(root, opf.path), "utf8");
      const tag = (t: string) => xml.match(new RegExp(`<dc:${t}[^>]*>([^<]+)</dc:${t}>`, "i"))?.[1]?.trim();
      return { title: tag("title"), author: firstAuthor(tag("creator")) ?? undefined };
    } catch {
      return null;
    }
  }
  return null;
}

/** Works out what one book is, from the best evidence available. */
export function identify(input: {
  files: FoundFile[];
  tags: FileTags;
  sidecar: ReturnType<typeof readSidecar>;
  /** The folder holding it, and that folder's parent, when they aren't the scan root. */
  folder: string | null;
  parentFolder: string | null;
  soloInFolder: boolean;
}): Pick<FoundBook, "author" | "title" | "narrator" | "year" | "confidence" | "why"> {
  const { files, tags, folder, parentFolder, soloInFolder } = input;
  const sidecar = soloInFolder ? input.sidecar : null;
  const stem = files[0].name.replace(/\.[^.]+$/, "");
  const fromFile = parseName(files.length > 1 && looksLikePartName(stem) ? stripPartNumber(stem) : stem);
  const fromFolder = folder ? parseName(folder) : {};
  const narrators = [tags.composer, sidecar?.narrator, fromFile.narrator, fromFolder.narrator].filter((n): n is string => !!n);

  // --- Author ---
  const tagAuthor = firstAuthor(tags.albumartist, narrators) ?? firstAuthor(tags.artist, narrators);
  const folderSaysAuthor = parentFolder && (fromFolder.author ? null : parentFolder);
  const author = tagAuthor ?? sidecar?.author ?? fromFile.author ?? fromFolder.author ?? (folderSaysAuthor || null);

  // --- Title: every candidate, cleaned ---
  const raw = [tags.album, files.length === 1 ? tags.title : undefined, sidecar?.title, fromFile.title, fromFolder.title];
  const candidates = raw.filter((c): c is string => !!c && !isGenericTitle(c)).map(bookTitle).filter((c) => c && !isGenericTitle(c));
  let title: string | null = candidates[0] ?? null;
  // A shorter candidate that begins the long one is the real title without its
  // subtitle: "The Kissing Bug: A True Story…" and "The Kissing Bug".
  for (const c of candidates) {
    const a = nameKey(c);
    if (title && a.length >= 3 && a !== nameKey(title) && nameKey(title).startsWith(a + " ")) title = c;
  }
  // "Diary of a Wimpy Kid: Big Shot" inside a folder already called "Big Shot".
  // A tidy folder under an author folder is someone's deliberate choice: keep it.
  const tidyFolder = folder && parentFolder && !fromFolder.author && !isGenericTitle(folder) ? cleanName(folder) : null;
  if (title && tidyFolder) {
    const k = nameKey(tidyFolder);
    const all = raw.filter((c): c is string => !!c).map((c) => nameKey(c));
    if (k && k !== nameKey(author ?? "") && all.some((c) => c === k || c.endsWith(" " + k) || c.includes(" " + k + " ") || c.startsWith(k + " "))) {
      const tail = title.split(/:\s*/).pop()!;
      title = nameKey(tail) === k ? tail : nameKey(title) === k ? title : tidyFolder;
    }
  }
  // "Barbara Kingsolver/Barbara Kingsolver.m4b": the file name is no title.
  if (title && author && nameKey(title) === nameKey(author)) title = candidates.find((c) => nameKey(c) !== nameKey(author)) ?? null;

  // --- How sure are we? ---
  const tagged = !!tagAuthor && !!tags.album && !isGenericTitle(tags.album);
  const sidecarOk = !!sidecar?.title && !!sidecar?.author;
  const names = [folder, stem].filter((n): n is string => !!n);
  const conflict = author && title ? disagreement(author, title, names, fromFolder.author ?? fromFile.author) : null;
  let confidence: Confidence;
  let why: string;
  if (!author || !title) {
    confidence = "low";
    why = !author && !title ? "Couldn't tell the author or the title" : !author ? "Couldn't tell the author" : "Couldn't tell the title";
  } else if (conflict) {
    confidence = "medium";
    why = conflict;
  } else if (tagged || (!!tagAuthor && !!tags.title && files.length === 1)) {
    confidence = "high";
    why = "From the tags in the audio file";
  } else if (sidecarOk) {
    confidence = "high";
    why = "From the metadata file next to it";
  } else {
    confidence = "medium";
    why = fromFile.author || fromFolder.author ? "From the file or folder name" : "From where it's stored";
  }
  return {
    author,
    title,
    narrator: narrators[0] ? (firstAuthor(narrators[0]) ?? narrators[0]) : null,
    year: tags.year?.slice(0, 4) ?? sidecar?.year ?? fromFile.year ?? fromFolder.year ?? null,
    confidence,
    why,
  };
}

/**
 * Tags can be wrong: when the names around a file don't mention this author
 * (if they name one) or most of this title's words, a person should look.
 */
function disagreement(author: string, title: string, names: string[], namedAuthor: string | undefined): string | null {
  const text = names.map(nameKey).join(" ");
  if (namedAuthor && !text.includes(nameKey(author))) return `The tags say ${author}, but the name says ${namedAuthor}`;
  // A file named only after its author says nothing about the title.
  if (!text.replaceAll(nameKey(author), "").trim()) return null;
  const words = nameKey(title).split(" ").filter((w) => !/^(?:the|a|an|of|and|in|on|to)$/.test(w));
  const found = words.filter((w) => text.split(" ").includes(w));
  if (words.length && found.length / words.length < 0.6) return `The tags say “${title}”, but the name doesn't`;
  return null;
}

/** Finds every book under a folder. */
export async function scanBooks(root: string, opts: { start?: string; reader?: TagReader } = {}): Promise<FoundBook[]> {
  const reader = opts.reader ?? readTags;
  const start = opts.start ?? "";
  const dirs = walkTree(root, start);
  const books: FoundBook[] = [];

  for (const info of dirs.values()) {
    const base = path.posix.basename(info.rel);
    // "Book/Disc 1" joins its parent below.
    if (info.rel !== start && DISC_DIR.test(base)) continue;
    const discs = info.subdirs.filter((s) => DISC_DIR.test(s)).map((s) => dirs.get(info.rel ? `${info.rel}/${s}` : s)).filter((d): d is DirInfo => !!d?.audio.length);
    const discFiles = discs.flatMap((d) =>
      [...d.audio, ...d.other].map((f) => ({ ...f, name: `${path.posix.basename(d.rel)}/${f.name}` })),
    );
    const allAudio = [...info.audio, ...discFiles.filter((f) => f.audio)];
    if (!allAudio.length) continue;

    const tags = await tagsFor(allAudio, root, reader);
    // Disc folders are one book by construction.
    const groups = discs.length && !info.audio.length ? [allAudio] : groupByBook(allAudio, tags);
    const sidecar = readSidecar(root, info);
    const inProgress = [...info.other, ...discFiles].some((f) => IN_PROGRESS.test(f.name));
    const atRoot = info.rel === start;
    const folder = atRoot ? null : base;
    const parentRel = path.posix.dirname(info.rel);
    const parentFolder = atRoot || parentRel === "." || parentRel === start ? null : path.posix.basename(parentRel);

    for (const group of groups) {
      const solo = groups.length === 1;
      const t = tags.get(group[0].path) ?? {};
      const id = identify({ files: group, tags: t, sidecar, folder: solo ? folder : null, parentFolder: solo ? parentFolder : folder, soloInFolder: solo && !atRoot });
      // Covers, metadata and the like go with the book, if it's the only one here.
      const sidecars = solo && !atRoot ? [...info.other, ...discFiles.filter((f) => !f.audio)] : matchingSidecars(group, info);
      const files = [...group, ...sidecars];
      books.push({
        dir: info.rel,
        files,
        ...id,
        size: files.reduce((n, f) => n + f.size, 0),
        newestMtimeMs: Math.max(...files.map((f) => f.mtimeMs)),
        busy: inProgress,
      });
    }
  }
  return books;
}

/** With several books in one folder, a sidecar only goes along if it's named after this one. */
function matchingSidecars(group: FoundFile[], info: DirInfo): FoundFile[] {
  const stems = new Set(group.map((f) => f.name.replace(/\.[^.]+$/, "")));
  return info.other.filter((f) => stems.has(f.name.replace(/\.[^.]+$/, "")));
}
