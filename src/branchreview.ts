import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { laneFor, reviewTimeoutMs } from "./engine.ts";
import { deriveVerdict, passesThreshold, type Finding, type Verdict } from "./findings.ts";
import { fetchRequirements } from "./jira.ts";
import { readProjectContext } from "./context.ts";
import { prepareDiff } from "./repo.ts";
import { queueKey, type ReviewQueue } from "./queue.ts";
import type { UserRuntime } from "./review.ts";
import { engineFields, type User } from "./users.ts";

/**
 * Pre-MR review of a branch against its base. Same engine/prompt/skill/limits as an MR review, but the diff comes
 * from the merge-base and the output goes only to the caller: this module imports neither the publisher nor the
 * review-history (dedupe/claim) functions, so it can never post to GitLab or create a row that skips the real MR.
 */
export interface BranchTarget {
  project: string; // numeric id or full path
  branch: string;
  base?: string; // default: the project's default branch
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
}

export class BranchError extends Error {
  constructor(public status: 400 | 401 | 404 | 429 | 502, public code: string, public extra?: { active_id: string }) {
    super(code);
  }
}

const PROJECT_RE = /^(\d{1,12}|\w[\w.-]*(\/\w[\w.-]*){1,10})$/;
/** Conservative subset of git ref names: it is sent to the GitLab API only, never to git or a shell. */
export function validBranchName(s: unknown): s is string {
  return typeof s === "string" && /^[\w.+\/-]{1,255}$/.test(s) && !/^[-\/.]|\.\.|\/\/|\/$|\.lock$|\/\./.test(s);
}
export const validProjectRef = (s: unknown): s is string => typeof s === "string" && s.length <= 255 && PROJECT_RE.test(s);

interface Resolved { projectId: number; repoUrl: string; head: string; base: string; mergeBase: string }

/** Cheap GitLab lookups with the caller's token (also proves they can see the project). Throws BranchError. */
export async function resolveBranch(rt: UserRuntime, t: BranchTarget): Promise<Resolved> {
  const status = (e: unknown) => (e as { status?: number }).status;
  const fail = (e: unknown, code: string): never => {
    const s = status(e);
    if (s === 404 || s === 403) throw new BranchError(404, code);
    if (s === 401) throw new BranchError(401, "caller_token_invalid");
    console.error("[branch-review] GitLab lookup failed:", (e as Error).message);
    throw new BranchError(502, "gitlab_error");
  };
  const project = await rt.gl.getProject(t.project).catch((e) => fail(e, "project_not_found"));
  const base = t.base ?? project.default_branch;
  if (!base) throw new BranchError(400, "base_unknown");
  const head = await rt.gl.getBranchSha(project.id, t.branch).catch((e) => fail(e, "branch_not_found"));
  const baseSha = await rt.gl.getBranchSha(project.id, base).catch((e) => fail(e, "base_not_found"));
  // Never `base..head` from the target tip: target commits merged into the branch would inflate the diff.
  const mergeBase = await rt.gl.getMergeBase(project.id, baseSha, head).catch((e) => fail(e, "merge_base_not_found"));
  return { projectId: project.id, repoUrl: project.http_url_to_repo, head, base, mergeBase };
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
  const { mergeBase, belowThreshold, ...rest } = r;
  return { ...rest, merge_base: mergeBase, below_threshold: belowThreshold };
}

// --- async API jobs (in memory: a result is only useful for the minutes after the run; lost on restart) ---

export interface BranchJob {
  id: string;
  userId: number;
  status: "queued" | "running" | "done" | "failed";
  finishedAt?: number;
  project: string;
  branch: string;
  base: string;
  head: string;
  mergeBase: string;
  createdAt: number;
  result?: BranchResult;
  error?: string;
}

const JOB_TTL_MS = 3_600_000;
const MAX_JOBS = 200;
const jobs = new Map<string, BranchJob>(); // insertion order = age
const active = (j: BranchJob) => j.status === "queued" || j.status === "running";

/** Drops finished jobs older than the TTL, then the oldest finished ones above the cap. Queued/running jobs are never dropped. */
export function sweepBranchJobs(now = Date.now(), ttlMs = JOB_TTL_MS, max = MAX_JOBS): void {
  for (const [id, j] of jobs) if (!active(j) && now - (j.finishedAt ?? j.createdAt) > ttlMs) jobs.delete(id);
  for (const [id, j] of jobs) {
    if (jobs.size <= max) break;
    if (!active(j)) jobs.delete(id);
  }
}

/** Queue dedupe key of one (user, project, head, merge-base) review. */
export const branchQueueKey = (userId: number, projectId: number, head: string, mergeBase: string): string => `branch:${queueKey(userId, projectId, head)}:${mergeBase}`;

export function getBranchJob(id: string, userId: number): BranchJob | undefined {
  const j = jobs.get(id);
  return j && j.userId === userId ? j : undefined; // another user's id looks like a missing one
}

export interface BranchDeps {
  cfg: Config;
  queue: ReviewQueue;
  runtimeFor: (u: User) => Promise<UserRuntime>;
}

/** Validates against GitLab synchronously (fast), then queues the slow review in the caller's lane. */
export async function startBranchReview(d: BranchDeps, caller: User, t: BranchTarget, charge: () => boolean = () => true): Promise<BranchJob> {
  if (!caller.skillPath) throw new BranchError(400, "no_skill_uploaded");
  let rt: UserRuntime;
  try {
    rt = await d.runtimeFor(caller);
  } catch {
    throw new BranchError(401, "caller_token_invalid");
  }
  if (!rt.engine) throw new BranchError(400, "no_review_engine");
  const r = await resolveBranch(rt, t);
  sweepBranchJobs();
  // One active job per user: a queued job occupies the user's lane (the shared-login lane serializes everyone's MR reviews).
  // The same commit pair already in flight is handed back instead of rejected.
  for (const j of jobs.values()) {
    if (j.userId !== caller.gitlabUserId || !active(j)) continue;
    if (j.project === String(r.projectId) && j.head === r.head && j.mergeBase === r.mergeBase) return j;
    throw new BranchError(429, "too_many_active", { active_id: j.id });
  }
  // An identical run still winding down in the queue would never start this job: reject before charging.
  const qkey = branchQueueKey(caller.gitlabUserId, r.projectId, r.head, r.mergeBase);
  if (d.queue.has(qkey)) throw new BranchError(429, "too_many_active");
  if (!charge()) throw new BranchError(429, "rate_limited"); // charged only when a job is really created
  const now = Date.now();
  const job: BranchJob = { id: randomUUID(), userId: caller.gitlabUserId, status: "queued", project: String(r.projectId), branch: t.branch, base: r.base, head: r.head, mergeBase: r.mergeBase, createdAt: now };
  jobs.set(job.id, job);
  d.queue.enqueue(laneFor(engineFields(caller), d.cfg.ownerEngineTestUsers), qkey, async () => {
    job.status = "running";
    try {
      job.result = await runBranchReview(d.cfg, caller, rt, t, r);
      job.status = "done";
    } catch (e) {
      console.error(`[branch-review] ${caller.username} ${t.project}@${t.branch} FAILED: ${(e as Error).message}`);
      job.status = "failed";
      job.error = "review_failed"; // detail (may hold server paths) stays in the log
    }
    job.finishedAt = Date.now();
  });
  console.log(`[branch-review] ${caller.username} ${t.project}@${t.branch} queued (${job.id})`);
  return job;
}
