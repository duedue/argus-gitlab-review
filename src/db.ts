import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SKIP_REASONS } from "./engine.ts";

export type Db = Database.Database;
export type ReviewStatus = "running" | "done" | "failed" | "skipped";

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrateReviewsUnique(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL,            -- GitLab user id of the reviewer (multi-user seam)
      project_id INTEGER NOT NULL,
      mr_id INTEGER NOT NULL,               -- global MR id
      mr_iid INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      dry_run INTEGER NOT NULL,             -- dry-run rows never block a live run
      status TEXT NOT NULL,
      error TEXT,
      findings_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      mr_url TEXT,                          -- GitLab web_url, for the history page (null on pre-M3 rows)
      UNIQUE (owner_id, mr_id, head_sha, dry_run)
    );
    -- Pre-MR branch reviews (src/branchreview.ts). Deliberately NOT the reviews table: that one is the per-MR claim/dedupe.
    CREATE TABLE IF NOT EXISTS branch_reviews (
      id TEXT PRIMARY KEY,                  -- job uuid (the API id)
      owner_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      project_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base TEXT NOT NULL,
      merge_base TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL,                 -- queued | running | done | failed
      verdict TEXT,
      findings_json TEXT,                   -- {findings, belowThreshold, lines, files, model, skipped}
      summary TEXT,
      error TEXT,
      trigger TEXT NOT NULL,                -- api | cli | push
      created_at INTEGER NOT NULL,          -- epoch ms
      finished_at INTEGER
    );
    -- Latest push seen per (owner, project, branch) for the push trigger's debounce; handled_sha = last head acted on.
    CREATE TABLE IF NOT EXISTS pushed_branches (
      owner_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      pushed_at INTEGER NOT NULL,           -- epoch ms of the push event
      handled_sha TEXT,
      PRIMARY KEY (owner_id, project_id, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_owner ON branch_reviews (owner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_head ON branch_reviews (owner_id, project_id, head_sha);
    CREATE TABLE IF NOT EXISTS users (
      gitlab_user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      token_enc BLOB NOT NULL,              -- AES-256-GCM: iv | tag | ciphertext
      token_expires_at TEXT,                -- YYYY-MM-DD, null = no expiry
      skill_path TEXT NOT NULL,
      severity_threshold TEXT NOT NULL DEFAULT 'minor',
      confidence_threshold REAL NOT NULL DEFAULT 0.7,
      language TEXT NOT NULL DEFAULT 'zh-TW',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_owner INTEGER NOT NULL DEFAULT 0,  -- only owners may use the subscription-backed claude CLI engine
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      token_type TEXT NOT NULL DEFAULT 'pat',   -- 'pat' | 'oauth'
      refresh_token_enc BLOB,                   -- oauth only; same layout as token_enc
      access_expires_at INTEGER,                -- oauth only; epoch ms
      token_invalid INTEGER NOT NULL DEFAULT 0, -- refresh was rejected: user must log in again
      approved INTEGER NOT NULL DEFAULT 1       -- web sign-ups start at 0 (pending); CLI-added users are approved
    );
    -- MRs the poller skipped for a user (project not allowed): the "pending decision" block on /reviews. Replaced wholesale each successful poll. Never read by the review path.
    CREATE TABLE IF NOT EXISTS seen_mrs (
      gitlab_user_id INTEGER NOT NULL,
      mr_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      mr_iid INTEGER NOT NULL,
      project_path TEXT NOT NULL,               -- lowercased
      title TEXT NOT NULL,
      web_url TEXT NOT NULL,
      author TEXT,
      last_seen_at TEXT NOT NULL,               -- UTC "YYYY-MM-DD HH:MM:SS"
      PRIMARY KEY (gitlab_user_id, mr_id)
    );
    -- Single MRs a user allowed with one click ("review only this one"); read by reviewAllowed(). Rows are tiny, never cleaned up.
    CREATE TABLE IF NOT EXISTS allowed_mrs (
      gitlab_user_id INTEGER NOT NULL,
      mr_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      mr_iid INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (gitlab_user_id, mr_id)
    );
    DROP TABLE IF EXISTS seen_projects;       -- superseded by seen_mrs (0.3.x only; held nothing the review path needed)
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,                 -- sha256 of the cookie value
      user_id INTEGER NOT NULL,
      csrf TEXT NOT NULL,
      expires_at INTEGER NOT NULL               -- epoch ms
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      user_id INTEGER PRIMARY KEY,              -- one active key per user; regenerate replaces it
      key_hash TEXT NOT NULL UNIQUE,            -- sha256 hex; the plaintext key is never stored
      prefix TEXT NOT NULL,                     -- first chars, display only
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    -- Approvals Argus itself made (auto-approve); only these may ever be revoked by Argus.
    CREATE TABLE IF NOT EXISTS auto_approvals (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      mr_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      mr_iid INTEGER NOT NULL,
      sha TEXT NOT NULL,                        -- head sha that was approved
      approved_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      revoked_by TEXT                           -- argus | human | push (approval reset by a new push)
    );
    -- First-run setup (src/setup.ts): OAuth/Jira values are AES-GCM blobs, owner_ref / setup_code_hash are plain.
    CREATE TABLE IF NOT EXISTS settings (
      name TEXT PRIMARY KEY,
      value BLOB NOT NULL
    );
    -- Human verdicts: the reviewer accepted a finding as-is (/argus accept). Kept apart from the AI output
    -- (reviews.findings_json is never rewritten); later rounds subtract these from what the AI reports.
    CREATE TABLE IF NOT EXISTS accepted_findings (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL,                -- reviewer whose review row the finding belongs to
      mr_id INTEGER NOT NULL,
      dry_run INTEGER NOT NULL,                 -- keyed by mode like reviews rows
      sentinel TEXT NOT NULL,                   -- 12-hex finding fingerprint
      reason TEXT NOT NULL,
      accepted_by INTEGER NOT NULL,             -- GitLab author id of the command note (owner_id; the MR author/assignee for source 'ai-reply')
      note_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      announced INTEGER NOT NULL DEFAULT 0,     -- 1 once its effect is published (verdict note, or a later review round)
      source TEXT NOT NULL DEFAULT 'reviewer',  -- reviewer (/argus accept) | ai-reply (minor/nit the AI accepted on the author's /argus reply)
      UNIQUE (owner_id, mr_id, sentinel, dry_run)
    );
    -- /argus accept and /argus reply notes already answered (accepted, judged or refused): each command is handled once, across restarts.
    CREATE TABLE IF NOT EXISTS accept_notes (
      owner_id INTEGER NOT NULL,
      note_id INTEGER NOT NULL,
      dry_run INTEGER NOT NULL,
      PRIMARY KEY (owner_id, note_id, dry_run)
    );
    -- Reserved seam (unused): per-user project_pattern -> skill mapping.
    CREATE TABLE IF NOT EXISTS skill_bindings (
      owner_id INTEGER NOT NULL,
      project_pattern TEXT NOT NULL DEFAULT '*',
      skill_path TEXT NOT NULL,
      PRIMARY KEY (owner_id, project_pattern)
    );
  `);
  addMissingColumns(db);
  // After the columns exist (an older DB gets attached_review_id from addMissingColumns).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_branch_reviews_unattached ON branch_reviews (owner_id, created_at) WHERE status='done' AND attached_review_id IS NULL`);
  return db;
}

/** Pre-M3 DBs: add the columns CREATE TABLE IF NOT EXISTS would not. Existing users stay approved PAT users. */
function addMissingColumns(db: Db): void {
  const want: Record<string, [string, string][]> = {
    users: [
      ["token_type", "TEXT NOT NULL DEFAULT 'pat'"],
      ["refresh_token_enc", "BLOB"],
      ["access_expires_at", "INTEGER"],
      ["token_invalid", "INTEGER NOT NULL DEFAULT 0"],
      ["approved", "INTEGER NOT NULL DEFAULT 1"],
      ["auto_approve", "INTEGER NOT NULL DEFAULT 0"], // opt-in: Argus approves clean MRs under the user's name
      ["branch_daily_cap", "INTEGER NOT NULL DEFAULT 20"], // max push-triggered branch reviews per rolling 24h; 0 = push trigger off
      ["review_pushed_branches", "INTEGER NOT NULL DEFAULT 0"], // opt-in: review the user's pushed branches that have no MR yet
      ["review_assigned", "INTEGER NOT NULL DEFAULT 0"], // opt-in: also poll MRs where the user is the assignee (not only reviewer)
      ["engine", "TEXT NOT NULL DEFAULT 'claude-cli'"], // which review engine runs for this user; chosen explicitly by the owner, never inferred
      ["model", "TEXT"], // claude --model alias chosen by the user; NULL = CLI default
      ["claude_token_enc", "BLOB"], // personal `claude setup-token` OAuth token (AES-GCM); NULL = none
      ["claude_token_set_at", "TEXT"], // UTC datetime it was saved; the 1-year expiry is estimated from it
      ["claude_token_invalid", "INTEGER NOT NULL DEFAULT 0"], // the CLI rejected it (401): user must paste a new one
      ["max_diff_lines", "INTEGER"], // per-user diff size limit; NULL = the global default (cfg.maxDiffLines)
      ["review_projects", "TEXT"], // newline-separated normalized project paths/group prefixes to auto-review (strict: empty = none unless review_all_projects)
      ["review_all_projects", "INTEGER NOT NULL DEFAULT 0"], // 1 = auto-review every assigned MR regardless of review_projects; new users start at 0
    ],
    reviews: [
      ["mr_url", "TEXT"],
      ["model", "TEXT"], // model the CLI reported it actually used (fact, never inferred); NULL = unknown
      ["attempts", "INTEGER NOT NULL DEFAULT 1"], // review attempts made for this head (automatic retry of failures)
      ["next_retry_at", "INTEGER"], // epoch ms; set while a failed review awaits its automatic retry, NULL = none/final
      ["self_review", "INTEGER NOT NULL DEFAULT 0"], // claimed via the author self-review trigger: any retry must stay a self-review (never auto-approves)
      ["base_sha", "TEXT"], // diff_refs.base_sha this review diffed against; a change means the target was merged into the MR (NULL on older rows)
      ["mr_author", "TEXT"], // GitLab username of the MR author, for the history page; NULL on older rows
    ],
    branch_reviews: [["attached_review_id", "INTEGER"]], // reviews.id of the MR review this branch review was attached to (NULL = not attached)
    pushed_branches: [["attempts", "INTEGER NOT NULL DEFAULT 0"]], // transient failures on the current head (push trigger)
    auto_approvals: [["revoked_by", "TEXT"]],
    accepted_findings: [["announced", "INTEGER NOT NULL DEFAULT 0"], ["source", "TEXT NOT NULL DEFAULT 'reviewer'"]],
  };
  // One transaction: the new column doubles as the "already migrated" marker, so it must not be committed
  // before the data fix-up below (a crash in between would leave legacy failures stuck forever).
  db.transaction(() => {
    const added = new Set<string>();
    for (const [table, cols] of Object.entries(want)) {
      const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const [name, def] of cols) {
        if (have.has(name)) continue;
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        added.add(`${table}.${name}`);
      }
    }
    // Failures recorded before automatic retry existed (e.g. "interrupted" by a restart) would otherwise keep
    // next_retry_at NULL forever: schedule them once, right now, when the column first appears.
    if (added.has("reviews.next_retry_at")) {
      db.prepare(`UPDATE reviews SET next_retry_at=? WHERE status='failed' AND attempts<3`).run(Date.now());
    }
    // Strict allowlist (review_all_projects) arrived after active users were already reviewing everything: keep them on 1, once.
    // Pending (unapproved) users never got reviews, so they start strict like any new sign-up.
    if (added.has("users.review_all_projects")) db.prepare(`UPDATE users SET review_all_projects=1 WHERE approved=1`).run();
  })();
}

/** MVP DBs had UNIQUE (mr_id, head_sha, dry_run); with several reviewers the key must include owner_id. */
function migrateReviewsUnique(db: Db): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='reviews'`).get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("UNIQUE (mr_id, head_sha, dry_run)")) return;
  // One transaction (SQLite DDL is transactional): a crash mid-migration must not orphan the old rows.
  db.transaction(() => {
    db.exec(`ALTER TABLE reviews RENAME TO reviews_old`);
    db.exec(row.sql.replace("UNIQUE (mr_id, head_sha, dry_run)", "UNIQUE (owner_id, mr_id, head_sha, dry_run)"));
    db.exec(`INSERT INTO reviews SELECT * FROM reviews_old; DROP TABLE reviews_old;`);
  })();
}

/** Undo a claim that never started real work (e.g. GitLab still computing the MR diff), so a later cycle retries. */
export function releaseClaim(db: Db, ownerId: number, mrId: number, headSha: string, dryRun: boolean): void {
  db.prepare(`DELETE FROM reviews WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=? AND status='running'`).run(ownerId, mrId, headSha, dryRun ? 1 : 0);
}

/** Errors of rows skipped only because the user had no engine (no/invalid Claude token): re-claimable once one exists. */
const NO_ENGINE = Object.values(SKIP_REASONS);
const NO_ENGINE_SQL = `status='skipped' AND error IN (${NO_ENGINE.map(() => "?").join(",")})`;

/**
 * Records "skipped: no engine" for this head once (re-polling the same head does not add rows); a later no-engine reason
 * (no token -> invalid token) updates it. Never touches a row that is done/failed/running.
 */
export function recordSkip(
  db: Db,
  r: { ownerId: number; projectId: number; mrId: number; mrIid: number; headSha: string; dryRun: boolean; webUrl?: string; author?: string },
  error: string,
): void {
  db.prepare(
    `INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, error, mr_url, mr_author)
     VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?)
     ON CONFLICT (owner_id, mr_id, head_sha, dry_run) DO UPDATE SET error=excluded.error WHERE ${NO_ENGINE_SQL}`,
  ).run(r.ownerId, r.projectId, r.mrId, r.mrIid, r.headSha, r.dryRun ? 1 : 0, error, r.webUrl ?? null, r.author ?? null, ...NO_ENGINE);
}

export const MAX_ATTEMPTS = 3;
/** Delay before retry after the Nth failed attempt: 5 min, then 15 min. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000];

/**
 * Dedupe: claim (mr_id, head_sha). Returns false if already claimed by any earlier attempt, except a failed row whose
 * automatic retry is due (re-claimed atomically, attempts+1) or a row skipped for lack of an engine. The latter is
 * replaced (DELETE + INSERT) so the claimed row is a new, latest row with a fresh created_at: history order, the
 * "latest review" on /admin (MAX(id)) and the accept watch's 30-day window all see it as the newest review.
 * One transaction, so exactly one caller wins.
 */
export function claimReview(
  db: Db,
  r: { ownerId: number; projectId: number; mrId: number; mrIid: number; headSha: string; dryRun: boolean; webUrl?: string; selfReview?: boolean; author?: string },
  now = Date.now(),
): boolean {
  const k = [r.ownerId, r.mrId, r.headSha, r.dryRun ? 1 : 0] as const;
  return db.transaction(() => {
    db.prepare(`DELETE FROM reviews WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=? AND ${NO_ENGINE_SQL}`).run(...k, ...NO_ENGINE);
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, mr_url, self_review, mr_author)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(r.ownerId, r.projectId, r.mrId, r.mrIid, r.headSha, r.dryRun ? 1 : 0, r.webUrl ?? null, r.selfReview ? 1 : 0, r.author ?? null);
    if (res.changes === 1) return true;
    return (
      db
        .prepare(
          `UPDATE reviews SET status='running', attempts=attempts+1, next_retry_at=NULL, self_review=MAX(self_review, ?), mr_author=COALESCE(mr_author, ?)
           WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=? AND status='failed' AND attempts<? AND next_retry_at<=?`,
        )
        .run(r.selfReview ? 1 : 0, r.author ?? null, ...k, MAX_ATTEMPTS, now).changes === 1
    );
  })();
}

/**
 * Record a failed attempt. Below MAX_ATTEMPTS it schedules the automatic retry (status stays 'failed' with
 * next_retry_at); at the last attempt the failure is final (next_retry_at NULL). Returns what happened.
 */
export function failReview(db: Db, ownerId: number, mrId: number, headSha: string, dryRun: boolean, error: string, now = Date.now()): { attempts: number; final: boolean } {
  const row = db.prepare(`SELECT attempts FROM reviews WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=?`).get(ownerId, mrId, headSha, dryRun ? 1 : 0) as { attempts: number } | undefined;
  const attempts = row?.attempts ?? 1;
  const final = attempts >= MAX_ATTEMPTS;
  const next = final ? null : now + RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]!;
  db.prepare(`UPDATE reviews SET status='failed', error=?, next_retry_at=? WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=?`).run(error, next, ownerId, mrId, headSha, dryRun ? 1 : 0);
  return { attempts, final };
}

/** True when this head's row was claimed as an author self-review (restored on every retry path). */
export function isSelfReview(db: Db, ownerId: number, mrId: number, headSha: string, dryRun: boolean): boolean {
  return !!db.prepare(`SELECT 1 FROM reviews WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=? AND self_review=1`).get(ownerId, mrId, headSha, dryRun ? 1 : 0);
}

export interface DueRetry { id: number; project_id: number; mr_iid: number; head_sha: string; self_review: number }

/** Failed rows of this owner whose automatic retry is due (the sweep's work list; claimReview stays the gate). */
export function dueRetries(db: Db, ownerId: number, dryRun: boolean, now = Date.now()): DueRetry[] {
  return db
    .prepare(`SELECT id, project_id, mr_iid, head_sha, self_review FROM reviews WHERE owner_id=? AND dry_run=? AND status='failed' AND attempts<? AND next_retry_at<=?`)
    .all(ownerId, dryRun ? 1 : 0, MAX_ATTEMPTS, now) as DueRetry[];
}

/** Give up the automatic retry of a failed row (MR closed or head moved): the row stays as final history, no note. */
export function clearRetry(db: Db, id: number): void {
  db.prepare(`UPDATE reviews SET next_retry_at=NULL WHERE id=? AND status='failed'`).run(id);
}

/** Manual retry: drop a failed row (any attempt count) so the head can be claimed afresh with attempts=1. */
export function resetFailed(db: Db, id: number, ownerId: number): boolean {
  return db.prepare(`DELETE FROM reviews WHERE id=? AND owner_id=? AND status='failed'`).run(id, ownerId).changes === 1;
}

export interface SeenMr { mrId: number; projectId: number; mrIid: number; path: string; title: string; url: string; author: string | null; lastSeenAt: string }

/** Replace the user's pending-decision MRs with this poll's skipped set (call only after a successful list). */
export function replaceSeenMrs(db: Db, userId: number, rows: Omit<SeenMr, "lastSeenAt">[]): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM seen_mrs WHERE gitlab_user_id=?`).run(userId);
    const ins = db.prepare(`INSERT OR REPLACE INTO seen_mrs (gitlab_user_id, mr_id, project_id, mr_iid, project_path, title, web_url, author, last_seen_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`);
    for (const r of rows) ins.run(userId, r.mrId, r.projectId, r.mrIid, r.path.toLowerCase(), r.title, r.url, r.author);
  })();
}

const toSeen = (r: Record<string, unknown>): SeenMr => ({ mrId: r.mr_id as number, projectId: r.project_id as number, mrIid: r.mr_iid as number, path: r.project_path as string, title: r.title as string, url: r.web_url as string, author: (r.author as string | null) ?? null, lastSeenAt: r.last_seen_at as string });

export const listSeenMrs = (db: Db, userId: number): SeenMr[] =>
  (db.prepare(`SELECT * FROM seen_mrs WHERE gitlab_user_id=? ORDER BY last_seen_at DESC, project_path, mr_iid`).all(userId) as Record<string, unknown>[]).map(toSeen);

export const getSeenMr = (db: Db, userId: number, mrId: number): SeenMr | undefined => {
  const r = db.prepare(`SELECT * FROM seen_mrs WHERE gitlab_user_id=? AND mr_id=?`).get(userId, mrId) as Record<string, unknown> | undefined;
  return r && toSeen(r);
};

export const deleteSeenMr = (db: Db, userId: number, mrId: number): void => void db.prepare(`DELETE FROM seen_mrs WHERE gitlab_user_id=? AND mr_id=?`).run(userId, mrId);

/** "Review only this MR": allowed on every later push until it closes. */
export const allowMr = (db: Db, userId: number, m: { mrId: number; projectId: number; mrIid: number }): void =>
  void db.prepare(`INSERT OR IGNORE INTO allowed_mrs (gitlab_user_id, mr_id, project_id, mr_iid) VALUES (?,?,?,?)`).run(userId, m.mrId, m.projectId, m.mrIid);

export const isMrAllowed = (db: Db, userId: number, mrId: number): boolean =>
  !!db.prepare(`SELECT 1 FROM allowed_mrs WHERE gitlab_user_id=? AND mr_id=?`).get(userId, mrId);

/** True when the head is claimed and not re-claimable (a due automatic retry or a no-engine skip may be claimed again). */
export function reviewExists(db: Db, ownerId: number, mrId: number, headSha: string, dryRun: boolean, now = Date.now()): boolean {
  return !!db
    .prepare(`SELECT 1 FROM reviews WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=? AND NOT (status='failed' AND attempts<? AND next_retry_at<=?) AND NOT (${NO_ENGINE_SQL})`)
    .get(ownerId, mrId, headSha, dryRun ? 1 : 0, MAX_ATTEMPTS, now, ...NO_ENGINE);
}

export function finishReview(
  db: Db,
  ownerId: number,
  mrId: number,
  headSha: string,
  dryRun: boolean,
  status: ReviewStatus,
  extra: { error?: string; findings?: unknown; model?: string } = {},
): void {
  db.prepare(`UPDATE reviews SET status=?, error=?, findings_json=?, model=? WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=?`).run(
    status,
    extra.error ?? null,
    extra.findings === undefined ? null : JSON.stringify(extra.findings),
    extra.model ?? null,
    ownerId,
    mrId,
    headSha,
    dryRun ? 1 : 0,
  );
}

/** Model reported by the CLI for the user's latest review that recorded one (settings page). */
export function lastModelUsed(db: Db, ownerId: number): string | undefined {
  const r = db.prepare(`SELECT model FROM reviews WHERE owner_id=? AND model IS NOT NULL ORDER BY id DESC LIMIT 1`).get(ownerId) as { model: string } | undefined;
  return r?.model;
}

/** Head sha of the most recent successfully reviewed revision, for incremental diffs. */
export function lastReviewedSha(db: Db, ownerId: number, mrId: number, dryRun: boolean): string | undefined {
  const row = db
    .prepare(`SELECT head_sha FROM reviews WHERE owner_id=? AND mr_id=? AND dry_run=? AND status='done' ORDER BY id DESC LIMIT 1`)
    .get(ownerId, mrId, dryRun ? 1 : 0) as { head_sha: string } | undefined;
  return row?.head_sha;
}

/** Remember which merge-base a review of this head used (see prepareDiff: a moved base voids the incremental diff). */
export function recordBaseSha(db: Db, ownerId: number, mrId: number, headSha: string, dryRun: boolean, baseSha: string): void {
  db.prepare(`UPDATE reviews SET base_sha=? WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=?`).run(baseSha, ownerId, mrId, headSha, dryRun ? 1 : 0);
}

/** merge-base the latest done review used; undefined for older rows that never recorded it. */
export function lastReviewedBaseSha(db: Db, ownerId: number, mrId: number, dryRun: boolean): string | undefined {
  const row = db
    .prepare(`SELECT base_sha FROM reviews WHERE owner_id=? AND mr_id=? AND dry_run=? AND status='done' ORDER BY id DESC LIMIT 1`)
    .get(ownerId, mrId, dryRun ? 1 : 0) as { base_sha: string | null } | undefined;
  return row?.base_sha ?? undefined;
}

/** Review round of the next review of this MR = completed reviews so far + 1 (per owner and dry-run flag). */
export function nextRound(db: Db, ownerId: number, mrId: number, dryRun: boolean): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE owner_id=? AND mr_id=? AND dry_run=? AND status='done'`).get(ownerId, mrId, dryRun ? 1 : 0) as { n: number };
  return row.n + 1;
}

/** Summary-only items still open after the latest done review (stored in its findings_json.summaryOpen). */
export function carriedSummaryItems(db: Db, ownerId: number, mrId: number, dryRun: boolean): { id: string; file: string; line?: number; title: string }[] {
  const row = db
    .prepare(`SELECT findings_json FROM reviews WHERE owner_id=? AND mr_id=? AND dry_run=? AND status='done' ORDER BY id DESC LIMIT 1`)
    .get(ownerId, mrId, dryRun ? 1 : 0) as { findings_json: string | null } | undefined;
  try {
    const open = JSON.parse(row?.findings_json ?? "null")?.summaryOpen;
    return Array.isArray(open) ? open : [];
  } catch {
    return [];
  }
}

/** Fingerprints the reviewer accepted on this MR (subtracted from every later round). */
export function acceptedIds(db: Db, ownerId: number, mrId: number, dryRun: boolean): Set<string> {
  const rows = db.prepare(`SELECT sentinel FROM accepted_findings WHERE owner_id=? AND mr_id=? AND dry_run=?`).all(ownerId, mrId, dryRun ? 1 : 0) as { sentinel: string }[];
  return new Set(rows.map((r) => r.sentinel));
}

export type AcceptSource = "reviewer" | "ai-reply";

/** Claim a command note (true = first time) and, for an accept, record it in the same transaction. */
export function handleNote(db: Db, r: { ownerId: number; noteId: number; dryRun: boolean }, accept?: { mrId: number; sentinel: string; reason: string; by: number }): boolean {
  return db.transaction(() => {
    if (db.prepare(`INSERT OR IGNORE INTO accept_notes (owner_id, note_id, dry_run) VALUES (?, ?, ?)`).run(r.ownerId, r.noteId, r.dryRun ? 1 : 0).changes !== 1) return false;
    if (accept) recordAccept(db, r, accept);
    return true;
  })();
}

/** Whether a command note was already answered (no claim). */
export const noteHandled = (db: Db, ownerId: number, noteId: number, dryRun: boolean): boolean =>
  db.prepare(`SELECT 1 FROM accept_notes WHERE owner_id=? AND note_id=? AND dry_run=?`).get(ownerId, noteId, dryRun ? 1 : 0) !== undefined;

/** Records an accepted finding (first accept of an id wins). `/argus reply` calls it after the note was claimed and the AI judged. */
export function recordAccept(db: Db, r: { ownerId: number; noteId: number; dryRun: boolean }, a: { mrId: number; sentinel: string; reason: string; by: number; source?: AcceptSource }): void {
  db.prepare(`INSERT OR IGNORE INTO accepted_findings (owner_id, mr_id, dry_run, sentinel, reason, accepted_by, note_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.ownerId, a.mrId, r.dryRun ? 1 : 0, a.sentinel, a.reason, a.by, r.noteId, a.source ?? "reviewer");
}

/** Accepted findings of this MR with the reviewer's reason (oldest first). */
export function acceptedFindings(db: Db, ownerId: number, mrId: number, dryRun: boolean): { sentinel: string; reason: string; source: AcceptSource }[] {
  return db.prepare(`SELECT sentinel, reason, source FROM accepted_findings WHERE owner_id=? AND mr_id=? AND dry_run=? ORDER BY id`).all(ownerId, mrId, dryRun ? 1 : 0) as { sentinel: string; reason: string; source: AcceptSource }[];
}

/** findings_json of every done review of this MR, newest first (to look up what an accepted id was). */
export function doneFindingsJson(db: Db, ownerId: number, mrId: number, dryRun: boolean): string[] {
  const rows = db.prepare(`SELECT findings_json FROM reviews WHERE owner_id=? AND mr_id=? AND dry_run=? AND status='done' AND findings_json IS NOT NULL ORDER BY id DESC`).all(ownerId, mrId, dryRun ? 1 : 0) as { findings_json: string }[];
  return rows.map((r) => r.findings_json);
}

/** Accepts whose verdict update has not been published yet (crash/failed note between accept and note). */
export function unannouncedAccepts(db: Db, ownerId: number, mrId: number, dryRun: boolean): string[] {
  const rows = db.prepare(`SELECT sentinel FROM accepted_findings WHERE owner_id=? AND mr_id=? AND dry_run=? AND announced=0`).all(ownerId, mrId, dryRun ? 1 : 0) as { sentinel: string }[];
  return rows.map((r) => r.sentinel);
}

export function markAnnounced(db: Db, ownerId: number, mrId: number, dryRun: boolean, sentinels: Iterable<string>): void {
  const st = db.prepare(`UPDATE accepted_findings SET announced=1 WHERE owner_id=? AND mr_id=? AND dry_run=? AND sentinel=?`);
  db.transaction(() => { for (const s of sentinels) st.run(ownerId, mrId, dryRun ? 1 : 0, s); })();
}

/** Latest done review row of this MR (current mode), re-read inside the queued accept job. */
export function latestDone(db: Db, ownerId: number, mrId: number, dryRun: boolean): WatchRow | undefined {
  return db
    .prepare(`SELECT id, mr_id, project_id, mr_iid, head_sha, findings_json, self_review FROM reviews WHERE owner_id=? AND mr_id=? AND dry_run=? AND status='done' ORDER BY id DESC LIMIT 1`)
    .get(ownerId, mrId, dryRun ? 1 : 0) as WatchRow | undefined;
}

export interface WatchRow { id: number; mr_id: number; project_id: number; mr_iid: number; head_sha: string; findings_json: string | null; self_review: number }

/**
 * Latest done review per MR of this owner (current mode), reviewed within the last 30 days: the accept-watch work
 * list. The window bounds the per-cycle cost; an older MR is picked up again by its next review round.
 */
export function watchCandidates(db: Db, ownerId: number, dryRun: boolean): WatchRow[] {
  return db
    .prepare(
      `SELECT id, mr_id, project_id, mr_iid, head_sha, findings_json, self_review FROM reviews r
       WHERE owner_id=? AND dry_run=? AND status='done' AND created_at >= datetime('now', '-30 days')
         AND id = (SELECT MAX(id) FROM reviews WHERE owner_id=r.owner_id AND mr_id=r.mr_id AND dry_run=r.dry_run AND status='done')`,
    )
    .all(ownerId, dryRun ? 1 : 0) as WatchRow[];
}

export interface AutoApproval { id: number; sha: string }

/** The still-active approval Argus made on this MR for this owner, if any. */
export function activeAutoApproval(db: Db, ownerId: number, mrId: number): AutoApproval | undefined {
  return db.prepare(`SELECT id, sha FROM auto_approvals WHERE owner_id=? AND mr_id=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`).get(ownerId, mrId) as AutoApproval | undefined;
}

export function recordAutoApproval(db: Db, r: { ownerId: number; mrId: number; projectId: number; mrIid: number; sha: string }): void {
  db.prepare(`INSERT INTO auto_approvals (owner_id, mr_id, project_id, mr_iid, sha) VALUES (?, ?, ?, ?, ?)`).run(r.ownerId, r.mrId, r.projectId, r.mrIid, r.sha);
}

export type RevokedBy = "argus" | "human" | "push";

export function markAutoApprovalRevoked(db: Db, id: number, by: RevokedBy): void {
  db.prepare(`UPDATE auto_approvals SET revoked_at=datetime('now'), revoked_by=? WHERE id=?`).run(by, id);
}

/** A human removed an Argus approval on this MR: Argus stays out of approving it from then on. */
export const humanRevokedAutoApproval = (db: Db, ownerId: number, mrId: number): boolean =>
  !!db.prepare(`SELECT 1 FROM auto_approvals WHERE owner_id=? AND mr_id=? AND revoked_by='human' LIMIT 1`).get(ownerId, mrId);

/**
 * Rows left 'running' by a restart/crash would block dedupe forever. They never finished, so release (delete) them:
 * the next poll/trigger claims the head again. Logs one line per released row; returns how many.
 */
export function releaseStaleRunning(db: Db): number {
  return db.transaction(() => {
    // Branch reviews are not retried: the in-memory queue is gone, so mark them failed instead of leaving them active forever.
    db.prepare(`UPDATE branch_reviews SET status='failed', error='interrupted', finished_at=? WHERE status IN ('queued','running')`).run(Date.now());
    const rows = db.prepare(`SELECT owner_id, project_id, mr_iid, head_sha FROM reviews WHERE status='running'`).all() as { owner_id: number; project_id: number; mr_iid: number; head_sha: string }[];
    db.prepare(`DELETE FROM reviews WHERE status='running'`).run();
    for (const r of rows) console.warn(`[startup] released interrupted review: owner ${r.owner_id} project ${r.project_id}!${r.mr_iid}@${r.head_sha.slice(0, 8)}; will be retried`);
    return rows.length;
  })();
}

// --- branch reviews (separate from `reviews`; see branchreview.ts) ---

export type BranchReviewTrigger = "api" | "cli" | "push";
export interface BranchReviewRow {
  id: string; owner_id: number; project_id: number; project_path: string; branch: string; base: string; merge_base: string; head_sha: string;
  status: "queued" | "running" | "done" | "failed"; verdict: string | null; findings_json: string | null; summary: string | null; error: string | null;
  trigger: BranchReviewTrigger; created_at: number; finished_at: number | null;
}

export function insertBranchReview(db: Db, r: Pick<BranchReviewRow, "id" | "owner_id" | "project_id" | "project_path" | "branch" | "base" | "merge_base" | "head_sha" | "trigger"> & { status?: "queued" | "running" }): void {
  db.prepare(`INSERT INTO branch_reviews (id, owner_id, project_id, project_path, branch, base, merge_base, head_sha, status, trigger, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.owner_id, r.project_id, r.project_path, r.branch, r.base, r.merge_base, r.head_sha, r.status ?? "queued", r.trigger, Date.now());
}

export const setBranchReviewRunning = (db: Db, id: string): void => void db.prepare(`UPDATE branch_reviews SET status='running' WHERE id=?`).run(id);

export function finishBranchReview(db: Db, id: string, r: { error: string } | { verdict?: string; summary?: string; findingsJson: string }): void {
  if ("error" in r) db.prepare(`UPDATE branch_reviews SET status='failed', error=?, finished_at=? WHERE id=?`).run(r.error, Date.now(), id);
  else db.prepare(`UPDATE branch_reviews SET status='done', verdict=?, summary=?, findings_json=?, finished_at=? WHERE id=?`).run(r.verdict ?? null, r.summary ?? null, r.findingsJson, Date.now(), id);
}

/** Owner-scoped: another user's id looks like a missing one. */
export const getBranchReview = (db: Db, ownerId: number, id: string): BranchReviewRow | undefined =>
  db.prepare(`SELECT * FROM branch_reviews WHERE id=? AND owner_id=?`).get(id, ownerId) as BranchReviewRow | undefined;

/**
 * The owner's active queued job, for the single-active rule. CLI runs never count: they bypass the queue, so a killed
 * run would leave a 'running' row nobody ends (failStaleCliBranchReviews cleans those up). Queued rows always get
 * finished by the queue, and a restart marks leftovers interrupted, so no age bound applies.
 */
export const activeBranchReview = (db: Db, ownerId: number): BranchReviewRow | undefined =>
  db.prepare(`SELECT * FROM branch_reviews WHERE owner_id=? AND status IN ('queued','running') AND trigger != 'cli' ORDER BY created_at LIMIT 1`).get(ownerId) as BranchReviewRow | undefined;

/** The owner's branch reviews, newest first. Keyset pagination: pass the last row's `created_at`+`id` as `before` for the next page. */
export function listBranchReviews(db: Db, ownerId: number, opts: { limit?: number; before?: { createdAt: number; id: string } } = {}): BranchReviewRow[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), 101); // 101 = the API pages of 100 plus one to detect "has more"
  const b = opts.before;
  return db.prepare(`SELECT * FROM branch_reviews WHERE owner_id=? ${b ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...(b ? [ownerId, b.createdAt, b.createdAt, b.id, limit] : [ownerId, limit])) as BranchReviewRow[];
}

/** One branch review by id, any owner (callers enforce access). */
export const getBranchReviewById = (db: Db, id: string): BranchReviewRow | undefined =>
  db.prepare(`SELECT * FROM branch_reviews WHERE id=?`).get(id) as BranchReviewRow | undefined;

/** Attached MR review of each given branch review (branch_reviews.attached_review_id -> reviews), keyed by branch review id; one indexed query for a page. */
export function attachedMrs(db: Db, ownerId: number, ids: string[]): Map<string, { mr_iid: number; mr_url: string | null }> {
  const out = new Map<string, { mr_iid: number; mr_url: string | null }>();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT b.id AS bid, r.mr_iid, r.mr_url FROM branch_reviews b JOIN reviews r ON r.id=b.attached_review_id WHERE b.owner_id=? AND b.id IN (${ids.map(() => "?").join(",")})`).all(ownerId, ...ids) as { bid: string; mr_iid: number; mr_url: string | null }[];
  for (const r of rows) out.set(r.bid, { mr_iid: r.mr_iid, mr_url: r.mr_url });
  return out;
}
export const findAttachedMr = (db: Db, ownerId: number, branchReviewId: string) => attachedMrs(db, ownerId, [branchReviewId]).get(branchReviewId);

/** Records that this branch review was posted as the review of the MR row (owner, mr, head). Not for dry-run rows (nothing was posted: a later live run must still attach). Call right after that row is finished. */
export const markBranchReviewAttached = (db: Db, branchReviewId: string, ownerId: number, mrId: number, headSha: string): void =>
  void db.prepare(`UPDATE branch_reviews SET attached_review_id=(SELECT id FROM reviews WHERE owner_id=? AND mr_id=? AND head_sha=? AND dry_run=0) WHERE id=?`).run(ownerId, mrId, headSha, branchReviewId);

/**
 * created_at (epoch ms) of the oldest done, attachable (it has a verdict: skipped runs have none) branch review that no MR
 * has picked up yet and is at most 14 days old; undefined = nothing left to attach. Plain lookup on the partial index idx_branch_reviews_unattached.
 */
export const ATTACH_MAX_LOOKBACK_MS = 14 * 86_400_000; // older reviews no longer open the gate (nor widen the authored-MR list)
export function oldestUnattachedBranchReviewAt(db: Db, ownerId: number, now = Date.now()): number | undefined {
  const r = db.prepare(`SELECT MIN(created_at) AS at FROM branch_reviews WHERE owner_id=? AND status='done' AND attached_review_id IS NULL AND verdict IS NOT NULL AND created_at > ?`).get(ownerId, now - ATTACH_MAX_LOOKBACK_MS) as { at: number | null };
  return r.at ?? undefined;
}

export const CLI_RUN_STALE_MS = 20 * 60_000; // longest engine run (15 min) + slack
/** A CLI run still 'running' after this long was killed: show it as failed instead of running forever. */
export const failStaleCliBranchReviews = (db: Db, now = Date.now()): number =>
  db.prepare(`UPDATE branch_reviews SET status='failed', error='interrupted', finished_at=? WHERE trigger='cli' AND status IN ('queued','running') AND created_at < ?`).run(now, now - CLI_RUN_STALE_MS).changes;

export const BRANCH_REVIEW_RETENTION_MS = 90 * 24 * 3_600_000;
/** Deletes finished branch reviews older than the retention window (queued/running rows are never touched). Returns the count. */
export const pruneBranchReviews = (db: Db, now = Date.now()): number =>
  db.prepare(`DELETE FROM branch_reviews WHERE status IN ('done','failed') AND COALESCE(finished_at, created_at) < ?`).run(now - BRANCH_REVIEW_RETENTION_MS).changes;

/** Latest done, attachable (has a verdict: a skipped run has none and must neither attach nor shadow a valid one) branch review of exactly this commit. */
export const findDoneBranchReview = (db: Db, ownerId: number, projectId: number, headSha: string, base?: string): BranchReviewRow | undefined =>
  db.prepare(`SELECT * FROM branch_reviews WHERE owner_id=? AND project_id=? AND head_sha=? AND status='done' AND verdict IS NOT NULL ${base === undefined ? "" : "AND base=?"} ORDER BY created_at DESC, id DESC LIMIT 1`).get(...(base === undefined ? [ownerId, projectId, headSha] : [ownerId, projectId, headSha, base])) as BranchReviewRow | undefined;
