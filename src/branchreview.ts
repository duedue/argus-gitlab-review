import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Config } from "./config.ts";
import { laneFor, reviewTimeoutMs } from "./engine.ts";
import { activeBranchReview, finishBranchReview, getBranchReview, insertBranchReview, setBranchReviewRunning, type BranchReviewRow, type BranchReviewTrigger, type Db } from "./db.ts";
import { deriveVerdict, passesThreshold, type Finding, type Verdict } from "./findings.ts";
import { fetchRequirements } from "./jira.ts";
import { readProjectContext } from "./context.ts";
import { prepareDiff } from "./repo.ts";
import { queueKey, type ReviewQueue } from "./queue.ts";
import type { UserRuntime } from "./review.ts";
import { engineFields, getActiveUserNoCase, type User } from "./users.ts";

/**
 * Pre-MR review of a branch against its base. Same engine/prompt/skill/limits as an MR review, but the diff comes
 * from the merge-base and the output goes only to the caller: this module imports neither the publisher nor the
 * review-history (dedupe/claim) functions, so it can never post to GitLab or create a row that skips the real MR.
 */
export interface BranchTarget {
  project: string; // numeric id or full path
  branch: string;
  base?: string; // default: the project's default branch
  skillFrom?: string; // username whose skill + thresholds to review with (see criteriaFor); unset = the caller's own
}

export interface BranchResult {
  head: string;
  base: string; // base branch name
  mergeBase: string; // diff is mergeBase..head (what the MR "Changes" tab will show)
  lines: number;
  files: string[];
  verdict?: Verdict;
  summary?: string;
  findings: Finding[]; // pass the user's severity/confidence thresholds
  belowThreshold: Finding[]; // the rest (an MR review lists these in its summary only)
  model?: string;
  skipped?: string; // set when no engine ran: "no reviewable changes" | "diff too large (N > M lines)"
  skillFrom?: string; // borrowed criteria (branch_reviews.skill_from); unset = the owner's own skill
}

export class BranchError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 429 | 502, public code: string, public extra?: { active_id: string }) {
    super(code);
  }
}

const PROJECT_RE = /^(\d{1,12}|\w[\w.-]*(\/\w[\w.-]*){1,10})$/;
/** Conservative subset of git ref names: it is sent to the GitLab API only, never to git or a shell. */
export function validBranchName(s: unknown): s is string {
  return typeof s === "string" && /^[\w.+\/-]{1,255}$/.test(s) && !/^[-\/.]|\.\.|\/\/|\/$|\.lock$|\/\./.test(s);
}
export const validProjectRef = (s: unknown): s is string => typeof s === "string" && s.length <= 255 && PROJECT_RE.test(s);

/**
 * Who the engine reviews as. Without `skillFrom`: the caller. With it: still the caller (same id, engine, model, Claude/GitLab
 * credentials, language, diff limit, queue lane, DB ownership) with ONLY the named user's skill file and severity/confidence
 * thresholds swapped in, so `findings` match what that user's MR review would treat as blocking. The named user's runtime,
 * engine and tokens are never touched: the runtime is built from the returned user, whose gitlabUserId is the caller's.
 * The name matches case-insensitively (GitLab usernames do). Only active users can be named (getActiveUserNoCase): a pending
 * sign-up or a disabled user is reported as unknown_user, so their skill is never borrowed and their existence is not revealed.
 * Naming yourself is the same as naming nobody. Throws BranchError (403 skill_from_disabled / 400 invalid_skill_from /
 * 404 unknown_user / 400 no_skill).
 */
export function criteriaFor(cfg: Pick<Config, "skillFrom">, db: Db, caller: User, skillFrom: string | undefined): { user: User; skillFrom?: string } {
  if (skillFrom === undefined) return { user: caller };
  if (!cfg.skillFrom) throw new BranchError(403, "skill_from_disabled");
  if (!/^[\w.-]{1,255}$/.test(skillFrom)) throw new BranchError(400, "invalid_skill_from");
  const from = getActiveUserNoCase(db, skillFrom);
  if (!from) throw new BranchError(404, "unknown_user");
  if (from.gitlabUserId === caller.gitlabUserId) return { user: caller };
  if (!from.skillPath || !existsSync(from.skillPath)) throw new BranchError(400, "no_skill");
  return {
    user: { ...caller, skillPath: from.skillPath, severityThreshold: from.severityThreshold, confidenceThreshold: from.confidenceThreshold },
    skillFrom: from.username,
  };
}

interface Resolved { projectId: number; projectPath: string; repoUrl: string; head: string; base: string; mergeBase: string }

const glFail = (e: unknown, code: string): never => {
  const s = (e as { status?: number }).status;
  if (s === 404 || s === 403) throw new BranchError(404, code);
  if (s === 401) throw new BranchError(401, "caller_token_invalid");
  console.error("[branch-review] GitLab lookup failed:", (e as Error).message);
  throw new BranchError(502, "gitlab_error");
};

/** Project + branch head with the caller's token (also proves they can see the project); no merge-base. Throws BranchError. */
export async function resolveHead(rt: UserRuntime, t: BranchTarget, verifyExplicitBase = false) {
  const project = await rt.gl.getProject(t.project).catch((e) => glFail(e, "project_not_found"));
  const base = t.base ?? project.default_branch;
  if (!base) throw new BranchError(400, "base_unknown");
  const head = await rt.gl.getBranchSha(project.id, t.branch).catch((e) => glFail(e, "branch_not_found"));
  if (verifyExplicitBase && t.base) await rt.gl.getBranchSha(project.id, t.base).catch((e) => glFail(e, "base_not_found"));
  return { project, base, head };
}

/** Cheap GitLab lookups with the caller's token. Throws BranchError. */
export async function resolveBranch(rt: UserRuntime, t: BranchTarget): Promise<Resolved> {
  const { project, base, head } = await resolveHead(rt, t);
  const baseSha = await rt.gl.getBranchSha(project.id, base).catch((e) => glFail(e, "base_not_found"));
  // Never `base..head` from the target tip: target commits merged into the branch would inflate the diff.
  const mergeBase = await rt.gl.getMergeBase(project.id, baseSha, head).catch((e) => glFail(e, "merge_base_not_found"));
  return { projectId: project.id, projectPath: project.path_with_namespace, repoUrl: project.http_url_to_repo, head, base, mergeBase };
}

/** Counts and skip reason of a stored findings_json; tolerant of a corrupt or missing row. */
export function storedSummary(json: string | null): { findings_count: number | null; below_threshold_count: number | null; skipped: string | null } {
  try {
    const s = json ? (JSON.parse(json) as { findings?: unknown[]; belowThreshold?: unknown[]; skipped?: string }) : undefined;
    return { findings_count: s?.findings?.length ?? null, below_threshold_count: s?.belowThreshold?.length ?? null, skipped: s?.skipped ?? null };
  } catch {
    return { findings_count: null, below_threshold_count: null, skipped: null };
  }
}

/** Runs the review of an already-resolved target. Writes nothing to GitLab or the database. */
export async function runBranchReview(cfg: Config, user: User, rt: UserRuntime, t: BranchTarget, r: Resolved): Promise<BranchResult> {
  const engine = rt.engine;
  if (!engine) throw new Error("no review engine available (see the Argus settings page)");
  const prep = await (rt.prepare ?? prepareDiff)({
    dataDir: cfg.dataDir, ownerId: user.gitlabUserId, token: await rt.token(), repoUrl: r.repoUrl, projectId: r.projectId,
    baseSha: r.mergeBase, headSha: r.head, excludeGlobs: cfg.excludeGlobs,
  });
  const out: BranchResult = { head: r.head, base: r.base, mergeBase: r.mergeBase, lines: prep.lines, files: prep.files, findings: [], belowThreshold: [] };
  const maxLines = user.maxDiffLines ?? cfg.maxDiffLines;
  if (!prep.diff.trim()) return { ...out, skipped: "no reviewable changes" };
  if (prep.lines > maxLines) return { ...out, skipped: `diff too large (${prep.lines} > ${maxLines} lines)` };

  const title = `Branch ${t.branch} (pre-MR review against ${r.base})`;
  const requirements = await (rt.requirements ?? fetchRequirements)(cfg, title, "").catch(() => undefined);
  const result = await engine.review({
    timeoutMs: reviewTimeoutMs(prep.lines), cwd: prep.dir, mrTitle: title, mrDescription: "", diff: prep.diff, incremental: false,
    language: user.language, requirements, openThreads: [], accepted: [], projectContext: readProjectContext(prep.dir, r.mergeBase, r.head),
  });
  const pass = (f: Finding) => passesThreshold(f, user.severityThreshold, user.confidenceThreshold);
  return {
    ...out, verdict: result.verdict ?? deriveVerdict(result.findings), summary: result.summary, model: result.model,
    findings: result.findings.filter(pass), belowThreshold: result.findings.filter((f) => !pass(f)),
  };
}

/** The wire shape shared by the API and `--json`: snake_case keys. */
export function branchResultJson(r: BranchResult) {
  const { mergeBase, belowThreshold, skillFrom, ...rest } = r;
  return { ...rest, merge_base: mergeBase, below_threshold: belowThreshold, skill_from: skillFrom ?? null };
}

// --- async API jobs (rows of branch_reviews; survive restarts; never touch the MR `reviews` table) ---

export interface BranchJob {
  id: string;
  userId: number;
  status: "queued" | "running" | "done" | "failed";
  finishedAt?: number;
  project: string; // numeric project id
  branch: string;
  base: string;
  head: string;
  mergeBase: string;
  createdAt: number;
  skillFrom?: string;
  result?: BranchResult;
  error?: string;
}

/** Persists a finished run (shared by the API job and the CLI). */
export function saveBranchResult(db: Db, id: string, r: BranchResult): void {
  const { verdict, summary, head: _h, base: _b, mergeBase: _m, skillFrom: _s, ...rest } = r; // skill_from has its own column
  finishBranchReview(db, id, { verdict, summary, findingsJson: JSON.stringify(rest) });
}

/** Records a run that is executing right now outside the queue (CLI). Returns the row id. */
export function startBranchRun(db: Db, ownerId: number, r: Resolved, t: BranchTarget, trigger: BranchReviewTrigger, skillFrom?: string): string {
  const id = randomUUID();
  insertBranchReview(db, { id, owner_id: ownerId, project_id: r.projectId, project_path: r.projectPath, branch: t.branch, base: r.base, merge_base: r.mergeBase, head_sha: r.head, trigger, status: "running", skill_from: skillFrom });
  return id;
}

function jobFromRow(r: BranchReviewRow): BranchJob {
  const stored = r.findings_json ? (JSON.parse(r.findings_json) as Omit<BranchResult, "head" | "base" | "mergeBase" | "verdict" | "summary">) : undefined;
  return {
    id: r.id, userId: r.owner_id, status: r.status, finishedAt: r.finished_at ?? undefined, project: String(r.project_id), branch: r.branch, base: r.base,
    head: r.head_sha, mergeBase: r.merge_base, createdAt: r.created_at, error: r.error ?? undefined, skillFrom: r.skill_from ?? undefined,
    result: stored && { ...stored, head: r.head_sha, base: r.base, mergeBase: r.merge_base, verdict: (r.verdict as Verdict | null) ?? undefined, summary: r.summary ?? undefined, skillFrom: r.skill_from ?? undefined },
  };
}

/** Queue dedupe key of one (user, project, head, merge-base, borrowed criteria) review. */
export const branchQueueKey = (userId: number, projectId: number, head: string, mergeBase: string, skillFrom?: string): string =>
  `branch:${queueKey(userId, projectId, head)}:${mergeBase}${skillFrom ? `:skill-from:${skillFrom}` : ""}`;

export function getBranchJob(db: Db, id: string, userId: number): BranchJob | undefined {
  const r = getBranchReview(db, userId, id); // another user's id looks like a missing one
  return r && jobFromRow(r);
}

export interface BranchDeps {
  cfg: Config;
  db: Db;
  queue: ReviewQueue;
  runtimeFor: (u: User) => Promise<UserRuntime>;
}

/** Validates against GitLab synchronously (fast), then queues the slow review in the caller's lane. */
export async function startBranchReview(d: BranchDeps, caller: User, t: BranchTarget, charge: () => boolean = () => true, trigger: BranchReviewTrigger = "api"): Promise<BranchJob> {
  const { user: runUser, skillFrom } = criteriaFor(d.cfg, d.db, caller, t.skillFrom);
  if (!runUser.skillPath) throw new BranchError(400, "no_skill_uploaded");
  let rt: UserRuntime;
  try {
    rt = await d.runtimeFor(runUser); // the caller's runtime (credentials keyed on the caller's id), see criteriaFor
  } catch {
    throw new BranchError(401, "caller_token_invalid");
  }
  if (!rt.engine) throw new BranchError(400, "no_review_engine");
  const r = await resolveBranch(rt, t);
  // One active job per user: a queued job occupies the user's lane (the shared-login lane serializes everyone's MR reviews).
  // The same commit pair already in flight is handed back instead of rejected.
  const act = activeBranchReview(d.db, caller.gitlabUserId);
  if (act) {
    if (act.project_id === r.projectId && act.head_sha === r.head && act.merge_base === r.mergeBase && act.skill_from === (skillFrom ?? null)) return jobFromRow(act);
    throw new BranchError(429, "too_many_active", { active_id: act.id });
  }
  // An identical run still winding down in the queue would never start this job: reject before charging.
  const qkey = branchQueueKey(caller.gitlabUserId, r.projectId, r.head, r.mergeBase, skillFrom);
  if (d.queue.has(qkey)) throw new BranchError(429, "too_many_active");
  if (!charge()) throw new BranchError(429, "rate_limited"); // charged only when a job is really created
  const id = randomUUID();
  insertBranchReview(d.db, { id, owner_id: caller.gitlabUserId, project_id: r.projectId, project_path: r.projectPath, branch: t.branch, base: r.base, merge_base: r.mergeBase, head_sha: r.head, trigger, skill_from: skillFrom });
  d.queue.enqueue(laneFor(engineFields(caller), d.cfg.ownerEngineTestUsers), qkey, async () => {
    setBranchReviewRunning(d.db, id);
    try {
      saveBranchResult(d.db, id, await runBranchReview(d.cfg, runUser, rt, t, r));
    } catch (e) {
      console.error(`[branch-review] ${caller.username} ${t.project}@${t.branch} FAILED: ${(e as Error).message}`);
      finishBranchReview(d.db, id, { error: "review_failed" }); // detail (may hold server paths) stays in the log
    }
  });
  console.log(`[branch-review] ${caller.username} ${t.project}@${t.branch} queued (${id})${skillFrom ? ` with ${skillFrom}'s criteria` : ""}`);
  return jobFromRow(getBranchReview(d.db, caller.gitlabUserId, id)!);
}
