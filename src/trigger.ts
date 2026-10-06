import type { Config } from "./config.ts";
import { reviewExists, type Db } from "./db.ts";
import { isDraft } from "./gitlab.ts";
import { queueKey, type ReviewQueue } from "./queue.ts";
import { reviewMr, type UserRuntime } from "./review.ts";
import { engineFields, listUsers, type User } from "./users.ts";
import { chooseEngine, laneFor, type SkipReason } from "./engine.ts";

/** Machine-readable skip reasons for the trigger response (the UI/history shows the zh-TW text from SKIP_REASONS). */
const NO_ENGINE_CODE: Record<SkipReason, string> = {
  no_token: "no Claude token configured (set it on the Argus settings page)",
  token_invalid: "Claude token invalid (generate a new one with claude setup-token)",
  engine_unavailable: "no review engine available",
};

export const TRIGGER_LIMIT_PER_HOUR = 30;

export class TriggerError extends Error {
  constructor(public status: 400 | 401 | 404 | 502, public code: string) {
    super(code);
  }
}

// group[/subgroup...]/project/-/merge_requests/<iid>; segments are conservative GitLab path chars, no "." / ".." segments.
const SEG = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.][A-Za-z0-9_.-]*";
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

/** In-memory fixed-window limiter per key (resets on restart; fine for a single-process service). */
export function makeRateLimiter(max: number, windowMs = 3_600_000, now = () => Date.now()) {
  const hits = new Map<string, number[]>();
  return (id: string): boolean => {
    const t = now();
    const recent = (hits.get(id) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      hits.set(id, recent);
      return false;
    }
    recent.push(t);
    hits.set(id, recent);
    return true;
  };
}

export interface TriggerDeps {
  cfg: Config;
  db: Db;
  queue: ReviewQueue;
  runtimeFor: (u: User) => Promise<UserRuntime>;
}
export interface TriggerResult {
  queued: string[];
  skipped: { username: string; reason: string }[];
}

/**
 * The caller's own GitLab token fetches the MR (proves they can see it); each Argus reviewer with an engine is
 * then queued with THAT reviewer's runtime. Reviews run in the background; the response only reports what was queued.
 * `self`: author self-review — review as the caller (own skill/engine) regardless of the MR's reviewers; drafts allowed.
 */
export async function triggerReviews(d: TriggerDeps, caller: User, ref: { path: string; iid: number }, opts: { self?: boolean } = {}): Promise<TriggerResult> {
  const status = (e: unknown) => (e as { status?: number }).status;
  let crt: UserRuntime;
  try {
    crt = await d.runtimeFor(caller);
  } catch {
    throw new TriggerError(401, "caller_token_invalid");
  }
  let mr;
  try {
    mr = await crt.gl.getMr(encodeURIComponent(ref.path), ref.iid);
  } catch (e) {
    const s = status(e);
    if (s === 404 || s === 403) throw new TriggerError(404, "mr_not_found");
    if (s === 401) throw new TriggerError(401, "caller_token_invalid");
    console.error("[trigger] GitLab lookup failed:", (e as Error).message);
    throw new TriggerError(502, "gitlab_error");
  }
  if (mr.state !== "opened") throw new TriggerError(400, "mr_not_open");

  const draft = isDraft(mr);
  const byId = new Map(listUsers(d.db).map((u) => [u.gitlabUserId, u]));
  const out: TriggerResult = { queued: [], skipped: [] };
  const skip = (username: string, reason: string) => out.skipped.push({ username, reason });
  // Self mode targets only the caller (already proven approved+enabled by the route); otherwise the MR's reviewers.
  const targets: { username: string; user?: User }[] = opts.self
    ? [{ username: caller.username, user: caller }]
    : (mr.reviewers ?? []).map((r) => ({ username: r.username, user: byId.get(r.id) }));
  for (const { username, user: u } of targets) {
    if (!u) skip(username, "not an Argus user");
    else if (!u.approved || !u.enabled) skip(u.username, "user not approved or disabled");
    else if (draft && !opts.self) skip(u.username, "draft MR");
    else if (!u.skillPath) skip(u.username, "no skill uploaded");
    else if (reviewExists(d.db, u.gitlabUserId, mr.id, mr.sha, d.cfg.dryRun)) skip(u.username, "already reviewed or in progress");
    else {
      let rt: UserRuntime;
      try {
        rt = u.gitlabUserId === caller.gitlabUserId ? crt : await d.runtimeFor(u);
      } catch {
        skip(u.username, "GitLab token unavailable");
        continue;
      }
      if (!rt.engine) {
        const c = chooseEngine(engineFields(u), d.cfg.ownerEngineTestUsers);
        skip(u.username, c.kind === "none" ? NO_ENGINE_CODE[c.reason] : "no review engine available");
      } else if (d.queue.enqueue(laneFor(engineFields(u), d.cfg.ownerEngineTestUsers), queueKey(u.gitlabUserId, mr.id, mr.sha), () => reviewMr(d.cfg, d.db, u, rt, mr, undefined, { selfReview: opts.self === true })).queued) out.queued.push(u.username);
      else skip(u.username, "already queued");
    }
  }
  console.log(`[trigger] ${caller.username} ${ref.path}!${ref.iid}${opts.self ? " (self)" : ""}: queued ${out.queued.length}, skipped ${out.skipped.length}`);
  return out;
}
