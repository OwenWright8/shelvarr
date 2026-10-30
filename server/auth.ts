// One admin account (created on the first visit), password hashed with scrypt,
// sessions as random tokens whose hashes are stored in the database.
import crypto from "node:crypto";
import type { DB } from "./db.ts";

const SESSION_DAYS = 30;
export const SESSION_COOKIE = "shelvarr_session";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function createSession(db: DB): { token: string; maxAge: number } {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const maxAge = SESSION_DAYS * 86_400;
  db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(sha256(token), now, now + maxAge * 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  return { token, maxAge };
}

export function validSession(db: DB, token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(sha256(token)) as
    | { expires_at: number }
    | undefined;
  return !!row && row.expires_at > Date.now();
}

export function deleteSession(db: DB, token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function deleteAllSessions(db: DB) {
  db.exec("DELETE FROM sessions");
}

export function randomSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Sign-in attempts per client address: 10 failures per 15 minutes. */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  private windowMs = 15 * 60_000;
  private max = 10;

  blocked(ip: string): boolean {
    return this.recent(ip).length >= this.max;
  }

  fail(ip: string) {
    const list = this.recent(ip);
    list.push(Date.now());
    this.failures.set(ip, list);
  }

  reset(ip: string) {
    this.failures.delete(ip);
  }

  private recent(ip: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(ip, list);
    else this.failures.delete(ip);
    return list;
  }
}

// --- Widget keys (read-only stats for dashboards like Homepage) ---------------

export function createWidgetKey(db: DB, label: string): { id: number; key: string } {
  const key = `shv_${crypto.randomBytes(24).toString("base64url")}`;
  const res = db
    .prepare("INSERT INTO widget_keys (label, key_hash, created_at) VALUES (?, ?, ?)")
    .run(label, sha256(key), Date.now());
  return { id: Number(res.lastInsertRowid), key };
}

/** True for a live key; records when it was last used. */
export function useWidgetKey(db: DB, key: string | undefined): boolean {
  if (!key) return false;
  const res = db.prepare("UPDATE widget_keys SET last_used_at = ? WHERE key_hash = ?").run(Date.now(), sha256(key));
  return res.changes > 0;
}
