import { execFile } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { isExcluded } from "./exclude.ts";

const run = promisify(execFile);

/**
 * Added + removed lines of a unified diff (what GitLab shows as +/-). Only lines inside hunks count: file headers
 * are skipped structurally, so content such as a removed `-- comment` (diffed as `--- comment`) is still counted.
 */
export function changedLines(diff: string): number {
  let n = 0;
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) inHunk = false;
    else if (l.startsWith("@@")) inHunk = true;
    else if (inHunk && (l[0] === "+" || l[0] === "-")) n++;
  }
  return n;
}

export interface PreparedDiff {
  dir: string;
  diff: string; // unified diff of non-excluded files
  lines: number;
  files: string[]; // non-excluded changed files
  incremental: boolean;
}

/**
 * Token is injected per command via GIT_CONFIG_* env (http.extraHeader): never written to .git/config,
 * never in argv (so not visible in `ps`). The fetch URL is passed explicitly and has no credentials.
 */
function gitEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`oauth2:${token}`).toString("base64");
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

async function git(dir: string, args: string[], token: string): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: dir, env: gitEnv(token), maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    // execFile errors embed argv+stderr; neither contains the token (it is only in env).
    throw new Error(`git ${args[0]} failed: ${(e as Error).message.slice(0, 400)}`);
  }
}

export const cloneDir = (dataDir: string, ownerId: number, projectId: number): string => join(dataDir, "clones", `u${ownerId}`, String(projectId));

export const CLONE_MAX_IDLE_MS = 14 * 24 * 3600_000;
export const CLONE_MAX_PACK_BYTES = 1024 ** 3;
export const CLONE_CLEANUP_INTERVAL_MS = 3600_000;
const STAMP = ".argus-last-used";

/** Marks the clone as used now (idle time is measured from this file's mtime). */
function touchClone(dir: string): void {
  const f = join(dir, STAMP);
  const now = new Date();
  if (existsSync(f)) utimesSync(f, now, now);
  else writeFileSync(f, "");
}

/** Sum of file sizes in .git/objects/pack (0 when absent). */
export function packBytes(dir: string): number {
  const p = join(dir, ".git", "objects", "pack");
  try {
    return readdirSync(p).reduce((n, f) => n + statSync(join(p, f)).size, 0);
  } catch {
    return 0;
  }
}

const fmtMiB = (n: number) => `${(n / 1024 ** 2).toFixed(0)} MiB`;
const USER_DIR = /^u(\d+)$/;
const PROJECT_DIR = /^\d+$/;

// Throttle state: at most one cleanup per key (user id / "orphans") per CLONE_CLEANUP_INTERVAL_MS.
const lastCleanup = new Map<string, number>();
export const resetCleanupThrottle = (): void => lastCleanup.clear();
export function cleanupDue(key: string, now = Date.now()): boolean {
  const last = lastCleanup.get(key);
  if (last !== undefined && now - last < CLONE_CLEANUP_INTERVAL_MS) return false;
  lastCleanup.set(key, now);
  return true;
}

export interface PruneOpts {
  now?: number;
  maxIdleMs?: number;
  maxPackBytes?: number;
  size?: (dir: string) => number; // injectable for tests
}

/**
 * Best-effort: removes one user's idle (> maxIdleMs since last use) or oversized (pack bytes > maxPackBytes) clones.
 * Caller MUST run this inside the user's queue lane so no review of that user is using a clone. A clone without a stamp
 * (made before this existed) is stamped now, i.e. gets a full idle period of grace. Never throws.
 */
export function pruneUserClones(dataDir: string, userId: number, o: PruneOpts = {}): void {
  const { now = Date.now(), maxIdleMs = CLONE_MAX_IDLE_MS, maxPackBytes = CLONE_MAX_PACK_BYTES, size = packBytes } = o;
  const udir = join(dataDir, "clones", `u${userId}`);
  try {
    for (const name of readdirSync(udir)) {
      const dir = join(udir, name);
      if (!PROJECT_DIR.test(name)) { console.log(`[cleanup] ignoring unknown entry ${dir}`); continue; }
      try {
        const bytes = size(dir);
        let idleMs = 0;
        try { idleMs = now - statSync(join(dir, STAMP)).mtimeMs; } catch { touchClone(dir); }
        const reason = idleMs > maxIdleMs ? `idle ${Math.floor(idleMs / 86_400_000)} d` : bytes > maxPackBytes ? "pack size over limit" : undefined;
        if (!reason) continue;
        rmSync(dir, { recursive: true, force: true });
        console.log(`[cleanup] removed ${dir}: ${reason}, packs ${fmtMiB(bytes)}`);
      } catch (e) {
        console.error(`[cleanup] ${dir} failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[cleanup] u${userId} failed:`, (e as Error).message);
  }
}

/** Ids of `clones/u<id>` dirs on disk; anything else in clones/ is logged and left alone. Never throws. */
export function cloneUserIds(dataDir: string): number[] {
  const root = join(dataDir, "clones");
  const ids: number[] = [];
  try {
    for (const name of readdirSync(root)) {
      const m = USER_DIR.exec(name);
      if (m) ids.push(Number(m[1]));
      else console.log(`[cleanup] ignoring unknown entry ${join(root, name)}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[cleanup] listing clones failed:", (e as Error).message);
  }
  return ids;
}

/** Removes a deleted user's whole clone dir. Caller must have drained that user's lane(s) first. Never throws. */
export function removeUserClones(dataDir: string, userId: number): void {
  const dir = join(dataDir, "clones", `u${userId}`);
  try {
    const bytes = readdirSync(dir).reduce((n, f) => (PROJECT_DIR.test(f) ? n + packBytes(join(dir, f)) : n), 0);
    rmSync(dir, { recursive: true, force: true });
    console.log(`[cleanup] removed ${dir}: user no longer exists, packs ${fmtMiB(bytes)}`);
  } catch (e) {
    console.error(`[cleanup] ${dir} failed:`, (e as Error).message);
  }
}

export async function prepareDiff(opts: {
  dataDir: string;
  ownerId: number; // reviewer: each has its own clone, since reviews of different users run in parallel
  token: string;
  repoUrl: string; // http_url_to_repo, no credentials
  projectId: number;
  iid: number;
  baseSha: string;
  headSha: string;
  lastReviewedSha?: string;
  lastReviewedBaseSha?: string; // merge-base of that review; undefined (old rows) keeps the incremental diff
  excludeGlobs: string[];
}): Promise<PreparedDiff> {
  // The checkout is the agent's cwd for the whole review, so it must never be shared across queue lanes (= users).
  // One user's jobs are sequential, so one clone per (user, project) is never used by two reviews at once.
  const dir = cloneDir(opts.dataDir, opts.ownerId, opts.projectId);
  mkdirSync(dir, { recursive: true });
  touchClone(dir);
  if (!existsSync(join(dir, ".git"))) await git(dir, ["init", "-q"], opts.token);

  const fetch = (ref: string) => git(dir, ["fetch", "-q", "--depth=1", "--no-tags", opts.repoUrl, ref], opts.token);
  const fetchStart = Date.now();
  await fetch(`refs/merge-requests/${opts.iid}/head`);
  await fetch(opts.baseSha);
  // A pinned head (dev `--head`) may predate the MR ref's tip: fetch it by sha when missing.
  await git(dir, ["cat-file", "-e", `${opts.headSha}^{commit}`], opts.token).catch(() => fetch(opts.headSha));

  let from = opts.baseSha;
  let incremental = false;
  // A moved merge-base means the target branch was merged into the MR: lastReviewedSha..head would drag in the
  // target's commits, so review the whole MR diff (== GitLab "Changes") instead.
  const baseMoved = !!opts.lastReviewedBaseSha && opts.lastReviewedBaseSha !== opts.baseSha;
  if (baseMoved && opts.lastReviewedSha) console.log(`[repo] !${opts.iid} merge base moved since last review; reviewing the full MR diff`);
  if (opts.lastReviewedSha && opts.lastReviewedSha !== opts.headSha && !baseMoved) {
    try {
      await fetch(opts.lastReviewedSha);
      from = opts.lastReviewedSha;
      incremental = true;
    } catch {
      // last reviewed commit gone (force push / gc): fall back to full MR diff
    }
  }
  console.log(`[repo] u${opts.ownerId}/${opts.projectId} !${opts.iid}: fetch phase ${Date.now() - fetchStart} ms`);
  await git(dir, ["checkout", "-q", "--force", "--detach", opts.headSha], opts.token);

  const names = (await git(dir, ["diff", "--name-only", "-z", from, opts.headSha], opts.token))
    .split("\0")
    .filter(Boolean);
  const files = names.filter((f) => !isExcluded(f, opts.excludeGlobs));
  if (files.length === 0) return { dir, diff: "", lines: 0, files, incremental };
  // Pathspec also carries rename sources (listed only with --no-renames), so a moved file diffs as a rename
  // instead of a whole-file add.
  const paths = (await git(dir, ["diff", "--name-only", "--no-renames", "-z", from, opts.headSha], opts.token))
    .split("\0")
    .filter((f) => f && !isExcluded(f, opts.excludeGlobs));
  // Literal pathspecs so filenames with glob chars are not reinterpreted.
  const diff = await git(
    dir,
    ["--literal-pathspecs", "diff", "--no-color", "-M", from, opts.headSha, "--", ...paths],
    opts.token,
  );
  return { dir, diff, lines: changedLines(diff), files, incremental };
}

