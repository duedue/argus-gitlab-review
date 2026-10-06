import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";

export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const hash = (id: string) => createHash("sha256").update(id).digest("hex");

/** The cookie value is random and only its sha256 is stored, so a DB leak cannot be replayed as a session. */
export function createSession(db: Db, userId: number, now = Date.now()): { id: string; csrf: string } {
  const id = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  db.prepare(`INSERT INTO sessions (id_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)`).run(hash(id), userId, csrf, now + SESSION_TTL_MS);
  return { id, csrf };
}

export function getSession(db: Db, id: string | undefined, now = Date.now()): { userId: number; csrf: string } | undefined {
  if (!id) return undefined;
  const r = db.prepare(`SELECT user_id, csrf, expires_at FROM sessions WHERE id_hash=?`).get(hash(id)) as { user_id: number; csrf: string; expires_at: number } | undefined;
  if (!r) return undefined;
  if (r.expires_at < now) {
    deleteSession(db, id);
    return undefined;
  }
  return { userId: r.user_id, csrf: r.csrf };
}

export const deleteSession = (db: Db, id: string): void => void db.prepare(`DELETE FROM sessions WHERE id_hash=?`).run(hash(id));

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
