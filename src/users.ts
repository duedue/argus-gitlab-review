import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { decrypt, encrypt } from "./crypto.ts";
import type { Db } from "./db.ts";
import { SEVERITIES, type Severity } from "./findings.ts";

export interface User {
  gitlabUserId: number;
  username: string;
  tokenEnc: Buffer;
  tokenExpiresAt: string | null; // YYYY-MM-DD
  skillPath: string; // path to SKILL.md
  severityThreshold: Severity;
  confidenceThreshold: number;
  language: string;
  enabled: boolean;
  isOwner: boolean;
  createdAt: string;
  tokenType: "pat" | "oauth";
  refreshTokenEnc: Buffer | null;
  accessExpiresAt: number | null; // epoch ms, oauth only
  tokenInvalid: boolean; // oauth refresh was rejected; the user must log in again
  autoApprove: boolean; // opt-in: approve clean MRs under the user's own name
  reviewAssigned: boolean; // opt-in: also review MRs where the user is only the assignee
  approved: boolean; // false = web sign-up awaiting the owner's approval
  model: Model | null; // claude --model alias; null = CLI default (claude-cli engine only)
  engine: Engine; // explicit, owner-chosen; engineFor() switches on it with no fallback
  claudeTokenEnc: Buffer | null; // personal `claude setup-token` OAuth token, AES-GCM like token_enc; never shown again
  claudeTokenSetAt: string | null; // UTC "YYYY-MM-DD HH:MM:SS" when it was saved (expiry is estimated from it)
  claudeTokenInvalid: boolean; // the CLI rejected it (401); the user must paste a new one
  maxDiffLines: number | null; // diff size above which this reviewer's reviews are skipped; null = cfg.maxDiffLines
}

export const MIN_DIFF_LINES = 500;
export const MAX_DIFF_LINES = 8000;

export const ENGINES = ["claude-cli", "codex-cli"] as const;
export type Engine = (typeof ENGINES)[number];

/** `claude --model` aliases offered to users (the CLI resolves each to the latest model of that family). */
export const MODELS = ["opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

export type UserStatus = "pending" | "active" | "disabled";
export const userStatus = (u: Pick<User, "approved" | "enabled">): UserStatus => (!u.approved ? "pending" : u.enabled ? "active" : "disabled");

export const DEFAULT_LANGUAGE = "zh-TW";
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/; // BCP-47-ish; it is interpolated into the agent prompt

const toUser = (r: Record<string, unknown>): User => ({
  gitlabUserId: r.gitlab_user_id as number,
  username: r.username as string,
  tokenEnc: r.token_enc as Buffer,
  tokenExpiresAt: (r.token_expires_at as string | null) ?? null,
  skillPath: r.skill_path as string,
  severityThreshold: r.severity_threshold as Severity,
  confidenceThreshold: r.confidence_threshold as number,
  language: r.language as string,
  enabled: r.enabled === 1,
  isOwner: r.is_owner === 1,
  createdAt: r.created_at as string,
  tokenType: r.token_type as "pat" | "oauth",
  refreshTokenEnc: (r.refresh_token_enc as Buffer | null) ?? null,
  accessExpiresAt: (r.access_expires_at as number | null) ?? null,
  tokenInvalid: r.token_invalid === 1,
  approved: r.approved === 1,
  autoApprove: r.auto_approve === 1,
  reviewAssigned: r.review_assigned === 1,
  engine: r.engine as Engine,
  model: (r.model as Model | null) ?? null,
  claudeTokenEnc: (r.claude_token_enc as Buffer | null) ?? null,
  claudeTokenSetAt: (r.claude_token_set_at as string | null) ?? null,
  claudeTokenInvalid: r.claude_token_invalid === 1,
  maxDiffLines: (r.max_diff_lines as number | null) ?? null,
});

/** What the engine rule (engine.ts chooseEngine) needs to know about the Claude token: whether one is stored, not its value. */
export const engineFields = (u: User) => ({ ...u, hasClaudeToken: !!u.claudeTokenEnc });

/** Accepts a skill folder or a SKILL.md file; returns the absolute SKILL.md path. Throws if missing. */
export function resolveSkillPath(p: string): string {
  const abs = resolve(p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const file = existsSync(abs) && statSync(abs).isDirectory() ? join(abs, "SKILL.md") : abs;
  if (!existsSync(file)) throw new Error(`skill not found: ${file}`);
  return file;
}

export function addUser(
  db: Db,
  key: Buffer,
  u: { gitlabUserId: number; username: string; token: string; tokenExpiresAt: string | null; skillPath: string; isOwner: boolean },
): void {
  if (u.isOwner) {
    const other = db.prepare(`SELECT username FROM users WHERE is_owner=1 AND gitlab_user_id<>?`).get(u.gitlabUserId) as { username: string } | undefined;
    // The CLI engine runs on the owner's own subscription, so exactly one owner may exist.
    if (other) throw new Error(`owner already exists (${other.username}); remove it first`);
  }
  // Upsert so re-running `user add` rotates the token; thresholds/language/enabled are preserved, ownership never silently dropped.
  db.prepare(
    `INSERT INTO users (gitlab_user_id, username, token_enc, token_expires_at, skill_path, is_owner)
     VALUES (@id, @username, @tok, @exp, @skill, @owner)
     ON CONFLICT(gitlab_user_id) DO UPDATE SET username=@username, token_enc=@tok, token_expires_at=@exp,
       skill_path=@skill, is_owner=MAX(is_owner, @owner),
       token_type='pat', refresh_token_enc=NULL, access_expires_at=NULL, token_invalid=0,
       approved=1`, // CLI is owner-only, so adding via CLI approves a pending web sign-up
  ).run({ id: u.gitlabUserId, username: u.username, tok: encrypt(key, u.token), exp: u.tokenExpiresAt, skill: u.skillPath, owner: u.isOwner ? 1 : 0 });
}

export const listUsers = (db: Db): User[] =>
  (db.prepare(`SELECT * FROM users ORDER BY gitlab_user_id`).all() as Record<string, unknown>[]).map(toUser);

export function getUserById(db: Db, id: number): User | undefined {
  const r = db.prepare(`SELECT * FROM users WHERE gitlab_user_id=?`).get(id) as Record<string, unknown> | undefined;
  return r && toUser(r);
}

export function getUser(db: Db, username: string): User | undefined {
  const r = db.prepare(`SELECT * FROM users WHERE username=?`).get(username) as Record<string, unknown> | undefined;
  return r && toUser(r);
}

export const userToken = (key: Buffer, u: User): string => decrypt(key, u.tokenEnc);

// --- personal Claude token (`claude setup-token`). Only written through setClaudeToken / clearClaudeToken / markClaudeTokenRejected. ---

/** `claude setup-token` tokens: valid for 1 year (Claude Code docs, "Generate a long-lived token"). */
export const CLAUDE_TOKEN_TTL_DAYS = 365;
export const CLAUDE_TOKEN_WARN_DAYS = 30;
// The CLI itself recognises OAuth tokens by this prefix (isAnthropicOAuthToken: startsWith("sk-ant-oat")).
const CLAUDE_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/;

/** Validates a pasted Claude token. Errors never echo the input. Returns the trimmed token. */
export function validateClaudeToken(raw: string): string {
  const t = raw.trim();
  if (!t) throw new Error("請貼上 Claude token。");
  if (/^sk-ant-api/.test(t)) throw new Error("這是 Anthropic API key，不是 Claude token；請在自己電腦執行 claude setup-token 產生。");
  if (!CLAUDE_TOKEN_RE.test(t)) throw new Error("Claude token 格式不符：應以 sk-ant-oat01- 開頭，請完整複製 claude setup-token 印出的那一行。");
  return t;
}

/** Set or replace: encrypts, stamps the date, clears the invalid flag. Validates first; nothing is written on error. */
export function setClaudeToken(db: Db, key: Buffer, id: number, raw: string): void {
  const t = validateClaudeToken(raw);
  db.prepare(`UPDATE users SET claude_token_enc=?, claude_token_set_at=datetime('now'), claude_token_invalid=0 WHERE gitlab_user_id=?`).run(encrypt(key, t), id);
}

export function clearClaudeToken(db: Db, id: number): void {
  db.prepare(`UPDATE users SET claude_token_enc=NULL, claude_token_set_at=NULL, claude_token_invalid=0 WHERE gitlab_user_id=?`).run(id);
}

/** Flags the token the CLI rejected. Keyed by the exact ciphertext used, so a token replaced meanwhile is never flagged. */
export function markClaudeTokenRejected(db: Db, id: number, usedEnc: Buffer): void {
  db.prepare(`UPDATE users SET claude_token_invalid=1 WHERE gitlab_user_id=? AND claude_token_enc=?`).run(id, usedEnc);
}

/** Estimated days left (set date + 1 year); undefined without a token. */
export function claudeTokenDaysLeft(u: Pick<User, "claudeTokenSetAt">, now = new Date()): number | undefined {
  if (!u.claudeTokenSetAt) return undefined;
  const set = Date.parse(`${u.claudeTokenSetAt.replace(" ", "T")}Z`);
  return Number.isNaN(set) ? undefined : Math.floor((set + CLAUDE_TOKEN_TTL_DAYS * 86_400_000 - now.getTime()) / 86_400_000);
}

const SETTABLE = {
  skill_path: (v: string) => resolveSkillPath(v),
  severity_threshold: (v: string) => {
    if (!(SEVERITIES as readonly string[]).includes(v)) throw new Error(`severity_threshold 必須是 ${SEVERITIES.join("|")} 其中之一`);
    return v;
  },
  confidence_threshold: (v: string) => {
    const n = Number(v);
    if (v.trim() === "" || !(n >= 0 && n <= 1)) throw new Error("confidence_threshold 必須介於 0 到 1");
    return n;
  },
  language: (v: string) => {
    if (!LANG_RE.test(v)) throw new Error("language 格式須像 zh-TW / en / ja");
    return v;
  },
  enabled: (v: string) => {
    if (v !== "0" && v !== "1") throw new Error("enabled must be 0 or 1");
    return Number(v);
  },
  engine: (v: string) => {
    if (!(ENGINES as readonly string[]).includes(v)) throw new Error(`engine 必須是 ${ENGINES.join("|")} 其中之一`);
    return v;
  },
  model: (v: string) => {
    if (v === "") return null; // CLI default
    if (!(MODELS as readonly string[]).includes(v)) throw new Error(`model 必須是 ${MODELS.join("|")} 其中之一，或留空使用 CLI 預設`);
    return v;
  },
  max_diff_lines: (v: string) => {
    if (v.trim() === "") return null; // global default
    const n = Number(v);
    if (!Number.isInteger(n) || n < MIN_DIFF_LINES || n > MAX_DIFF_LINES) throw new Error(`max_diff_lines 必須是 ${MIN_DIFF_LINES} 到 ${MAX_DIFF_LINES} 的整數，或留空使用預設`);
    return n;
  },
  auto_approve: (v: string) => {
    if (v !== "0" && v !== "1") throw new Error("auto_approve must be 0 or 1");
    return Number(v);
  },
  review_assigned: (v: string) => {
    if (v !== "0" && v !== "1") throw new Error("review_assigned must be 0 or 1");
    return Number(v);
  },
} as const;

/** Parses and validates `key=value` pairs against SETTABLE; throws before anything is written. */
export function parseSettings(pairs: string[]): [string, string | number | null][] {
  const updates: [string, string | number | null][] = [];
  for (const p of pairs) {
    const i = p.indexOf("=");
    const k = p.slice(0, i) as keyof typeof SETTABLE;
    if (i < 1 || !(k in SETTABLE)) throw new Error(`bad setting "${p.slice(0, i < 1 ? undefined : i)}"; allowed: ${Object.keys(SETTABLE).join(", ")}`);
    updates.push([k, SETTABLE[k](p.slice(i + 1))]);
  }
  if (!updates.length) throw new Error("nothing to set");
  return updates;
}

/** `user set <username> key=value ...`; keys are column names. Validates everything before writing. */
export function setUser(db: Db, username: string, pairs: string[]): void {
  if (!getUser(db, username)) throw new Error(`no such user: ${username}`);
  const updates = parseSettings(pairs);
  const tx = db.transaction(() => {
    for (const [k, v] of updates) db.prepare(`UPDATE users SET ${k}=? WHERE username=?`).run(v, username); // k is whitelisted above
  });
  tx();
}

/** Owner approves (enables) or disables a user. The owner row itself is never touched. */
export function setUserEnabled(db: Db, id: number, enabled: boolean): void {
  const u = getUserById(db, id);
  if (!u) throw new Error("no such user");
  if (u.isOwner) throw new Error("the owner cannot be approved/disabled");
  db.prepare(`UPDATE users SET enabled=?, approved=1 WHERE gitlab_user_id=?`).run(enabled ? 1 : 0, id);
}

/**
 * Records an OAuth login. Unknown user -> new row, pending (approved=0, enabled=0, not owner, no skill yet).
 * Existing PAT user -> row untouched (their PAT is never overwritten). Existing OAuth user -> tokens rotated, invalid flag cleared.
 */
export function upsertOAuthUser(
  db: Db,
  key: Buffer,
  u: { gitlabUserId: number; username: string; accessToken: string; refreshToken: string; accessExpiresAt: number },
): User {
  const existing = getUserById(db, u.gitlabUserId);
  if (!existing) {
    db.prepare(
      `INSERT INTO users (gitlab_user_id, username, token_enc, skill_path, enabled, is_owner, token_type, refresh_token_enc, access_expires_at, approved)
       VALUES (?, ?, ?, '', 0, 0, 'oauth', ?, ?, 0)`,
    ).run(u.gitlabUserId, u.username, encrypt(key, u.accessToken), encrypt(key, u.refreshToken), u.accessExpiresAt);
  } else if (existing.tokenType === "oauth") {
    db.prepare(
      `UPDATE users SET username=?, token_enc=?, refresh_token_enc=?, access_expires_at=?, token_invalid=0 WHERE gitlab_user_id=?`,
    ).run(u.username, encrypt(key, u.accessToken), encrypt(key, u.refreshToken), u.accessExpiresAt, u.gitlabUserId);
  }
  return getUserById(db, u.gitlabUserId)!;
}

export const hasOwner = (db: Db): boolean => !!db.prepare(`SELECT 1 FROM users WHERE is_owner=1`).get();

/**
 * Fresh-install bootstrap (env ARGUS_OWNER = GitLab user id, all digits, preferred; or username, case-insensitive): after an OAuth login, the matching user
 * becomes the approved+enabled owner, but only while no owner exists. Never promotes anyone else; there is no "first login wins".
 */
export function bootstrapOwner(db: Db, u: User, ownerName: string | undefined, warn: (m: string) => void = console.warn): User {
  // All digits = GitLab user id (immutable, preferred); otherwise a username (renamable: only safe until the owner logs in).
  const matches = /^\d+$/.test(ownerName ?? "") ? u.gitlabUserId === Number(ownerName) : u.username.toLowerCase() === ownerName?.toLowerCase();
  if (!ownerName || u.isOwner || !matches) return u;
  const owner = db.prepare(`SELECT username FROM users WHERE is_owner=1`).get() as { username: string } | undefined;
  if (owner) {
    warn(`[bootstrap] ARGUS_OWNER=${ownerName} ignored: owner ${owner.username} already exists`);
    return u;
  }
  db.prepare(`UPDATE users SET is_owner=1, approved=1, enabled=1 WHERE gitlab_user_id=?`).run(u.gitlabUserId);
  console.log(`[bootstrap] ${u.username} promoted to owner via ARGUS_OWNER`);
  return getUserById(db, u.gitlabUserId)!;
}

export function removeUser(db: Db, username: string): boolean {
  const u = getUser(db, username);
  if (u) db.prepare(`DELETE FROM api_keys WHERE user_id=?`).run(u.gitlabUserId);
  return db.prepare(`DELETE FROM users WHERE username=?`).run(username).changes === 1;
}

/** Days until the token expires (negative = already expired); undefined if it never expires. */
export function daysUntilExpiry(u: Pick<User, "tokenExpiresAt">, now = new Date()): number | undefined {
  if (!u.tokenExpiresAt) return undefined;
  return Math.floor((Date.parse(`${u.tokenExpiresAt}T00:00:00Z`) - now.getTime()) / 86_400_000);
}
