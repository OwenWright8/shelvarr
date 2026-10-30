// Every change Shelvarr makes on disk goes through here. The rules: never
// overwrite anything, verify before removing an original, and record each step
// so it can be undone.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";

export type OpType = "move" | "copy" | "link";

export interface Op {
  type: OpType;
  from: string;
  to: string;
  /** Set when this renamed a whole book: its folder in the library, before and after. */
  book?: { from: string; to: string };
}

export function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  return pipeline(fs.createReadStream(file), hash).then(() => hash.digest("hex"));
}

/** A cheap check of a big file: its size, start and end. Good for finding candidates, not for deleting. */
export function quickHash(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const hash = createHash("sha256").update(String(size));
    const chunk = Buffer.alloc(Math.min(256 * 1024, size));
    fs.readSync(fd, chunk, 0, chunk.length, 0);
    hash.update(chunk);
    fs.readSync(fd, chunk, 0, chunk.length, Math.max(0, size - chunk.length));
    hash.update(chunk);
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function assertInside(root: string, target: string) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Refusing to touch a path outside ${root}: ${target}`);
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function copyVerified(from: string, to: string) {
  await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  try {
    if ((await sha256(from)) !== (await sha256(to))) throw new Error(`The copy of ${path.basename(from)} didn't match the original`);
    const st = fs.statSync(from);
    fs.utimesSync(to, st.atime, st.mtime);
  } catch (err) {
    fs.rmSync(to, { force: true });
    throw err;
  }
}

/** Puts a file somewhere new. Throws rather than overwrite. Returns what actually happened. */
export async function placeFile(mode: OpType, from: string, to: string): Promise<Op> {
  if (exists(to)) throw new Error(`Something is already at ${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (mode === "copy") {
    await copyVerified(from, to);
    return { type: "copy", from, to };
  }
  if (mode === "link") {
    try {
      fs.linkSync(from, to);
      return { type: "link", from, to };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Different mounts, or a filesystem without hardlinks: a verified copy instead.
      if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw err;
      await copyVerified(from, to);
      return { type: "copy", from, to };
    }
  }
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyVerified(from, to);
    fs.unlinkSync(from);
  }
  return { type: "move", from, to };
}

/** Reverses one step. Copies and links are removed only if the original is still there. */
export async function undoOp(op: Op) {
  if (op.type === "move") {
    if (!exists(op.to)) throw new Error(`${op.to} is gone`);
    await placeFile("move", op.to, op.from);
    return;
  }
  if (!exists(op.from)) throw new Error(`The original of ${op.to} is gone, so it's been kept`);
  fs.rmSync(op.to, { force: true });
}

/** Removes empty folders from `dir` upward, stopping at (and keeping) `stop`. */
export function removeEmptyUp(dir: string, stop: string) {
  let cur = dir;
  while (cur !== stop && cur.startsWith(stop + path.sep)) {
    try {
      const left = fs.readdirSync(cur).filter((n) => n !== ".DS_Store" && n !== "@eaDir");
      if (left.length) return;
      fs.rmSync(cur, { recursive: true, force: true });
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

export function folderSize(dir: string): number {
  let total = 0;
  const visit = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          // Gone since listing it.
        }
      }
    }
  };
  visit(dir);
  return total;
}
