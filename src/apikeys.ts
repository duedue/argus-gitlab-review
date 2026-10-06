import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

export interface ApiKeyInfo {
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const API_KEY_RE = /^argus_[A-Za-z0-9_-]{32,128}$/;
const hash = (k: string) => createHash("sha256").update(k).digest("hex");

/** Replaces the user's key immediately. The plaintext is returned once and never stored. */
export function createApiKey(db: Db, userId: number): string {
  const key = `argus_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO api_keys (user_id, key_hash, prefix, created_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET key_hash=excluded.key_hash, prefix=excluded.prefix, created_at=excluded.created_at, last_used_at=NULL`,
  ).run(userId, hash(key), key.slice(0, 10));
  return key;
}

export function getApiKeyInfo(db: Db, userId: number): ApiKeyInfo | undefined {
  const r = db.prepare(`SELECT prefix, created_at, last_used_at FROM api_keys WHERE user_id=?`).get(userId) as
    | { prefix: string; created_at: string; last_used_at: string | null } | undefined;
  return r && { prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at };
}

/** Lookup by sha256 (no plaintext comparison, so nothing to time). Returns the owning user and the hash for rate limiting. */
export function findApiKey(db: Db, key: string): { userId: number; hash: string } | undefined {
  if (!API_KEY_RE.test(key)) return undefined;
  const h = hash(key);
  const r = db.prepare(`SELECT user_id FROM api_keys WHERE key_hash=?`).get(h) as { user_id: number } | undefined;
  return r && { userId: r.user_id, hash: h };
}

export const touchApiKey = (db: Db, h: string): void => void db.prepare(`UPDATE api_keys SET last_used_at=datetime('now') WHERE key_hash=?`).run(h);
