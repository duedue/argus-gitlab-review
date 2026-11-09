// Per-user allowlist of GitLab projects for automatic reviews. Single source of truth: every entry point (poller,
// retry sweep, trigger) calls reviewAllowed(); the settings page and `user set` call parseProjectList().
import { isMrAllowed, type Db } from "./db.ts";
import type { User } from "./users.ts";

// group[/subgroup...]/project path segment: conservative GitLab path chars, no "." / ".." segments.
export const SEG = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.][A-Za-z0-9_.-]*";
const ENTRY_RE = new RegExp(`^${SEG}(?:/${SEG})*$`);

export const MAX_PROJECT_ENTRIES = 100;
export const MAX_PROJECT_ENTRY_LEN = 255;

/**
 * Parses newline- or comma-separated entries into the normalized list (trim, strip leading/trailing "/", lowercase,
 * dedupe). Empty input = []. Throws a zh-TW message on an invalid entry; nothing partial is returned.
 */
export function parseProjectList(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\n,]/)) {
    const e = raw.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!e) continue;
    if (e.length > MAX_PROJECT_ENTRY_LEN) throw new Error(`審查專案清單的每一條不可超過 ${MAX_PROJECT_ENTRY_LEN} 字元`);
    if (!ENTRY_RE.test(e)) throw new Error(`審查專案清單含不合法的路徑「${e.slice(0, 60)}」；請填 group/project 或 group/subgroup（一行一個）`);
    out.add(e);
  }
  if (out.size > MAX_PROJECT_ENTRIES) throw new Error(`審查專案清單最多 ${MAX_PROJECT_ENTRIES} 條`);
  return [...out];
}

/**
 * Strict allowlist: `allowAll` (users.review_all_projects) passes everything; otherwise only a list match passes, so an
 * empty list reviews nothing. Entry `a/b` matches project `a/b` and `a/b/**` (segment boundary: `a/bc` does not),
 * case-insensitive. An unknown path fails closed.
 */
export function projectAllowed(path: string | undefined, list: readonly string[], allowAll: boolean): boolean {
  if (allowAll) return true;
  if (!path) return false;
  const p = path.toLowerCase();
  return list.some((e) => p === e || p.startsWith(`${e}/`));
}

/**
 * Should `user` get an automatic review of this MR? Own MRs (the user is the author and assigned themselves as reviewer)
 * always pass; otherwise the project allowlist / allow-all, or a single MR the user allowed with one click.
 */
export function reviewAllowed(db: Db, user: Pick<User, "gitlabUserId" | "reviewProjects" | "reviewAllProjects">, path: string | undefined, mrId: number, authorId?: number): boolean {
  return authorId === user.gitlabUserId || projectAllowed(path, user.reviewProjects, user.reviewAllProjects) || isMrAllowed(db, user.gitlabUserId, mrId);
}

const MR_PATH_RE = new RegExp(`^/((?:${SEG}/)+${SEG})/-/merge_requests/(\\d{1,9})/?$`);

/** Strict parse of a GitLab MR web URL that lives under `gitlabUrl`. Returns undefined for anything else. */
export function parseMrUrl(raw: unknown, gitlabUrl: string): { path: string; iid: number } | undefined {
  if (typeof raw !== "string" || raw.length > 512) return undefined;
  let u: URL, base: URL;
  try {
    u = new URL(raw);
    base = new URL(gitlabUrl);
  } catch {
    return undefined;
  }
  if (u.origin !== base.origin || u.username || u.password) return undefined;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (!u.pathname.startsWith(`${prefix}/`)) return undefined;
  const m = MR_PATH_RE.exec(u.pathname.slice(prefix.length));
  return m ? { path: m[1]!, iid: Number(m[2]) } : undefined;
}
