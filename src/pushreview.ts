import { laneFor } from "./engine.ts";
import type { Config } from "./config.ts";
import { startBranchReview, storedSummary, BranchError } from "./branchreview.ts";
import type { BranchReviewRow, Db } from "./db.ts";
import type { ReviewQueue } from "./queue.ts";
import { projectAllowed } from "./projects.ts";
import type { UserRuntime } from "./review.ts";
import { engineFields, type User } from "./users.ts";

/** A branch is reviewed only after this long without a new push to it. */
export const PUSH_DEBOUNCE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const DAY_MS = 86_400_000;
const EVENT_LOOKBACK_DAYS = 2; // `after` is an exclusive date: with 2 it returns yesterday and today (1-2 days); older pushes are not picked up (e.g. after long downtime)
const waitLogged = new Set<string>();
const capLogged = new Set<string>(); // "owner:YYYY-MM-DD": log the cap once per day

interface Deps { cfg: Config; db: Db; queue: ReviewQueue; runtimeFor: (u: User) => Promise<UserRuntime> }

export type BranchAdvice = "done" | "running" | "pending_push" | "submit";
/**
 * Read-only answer to "does this head already have (or is about to get) a branch review?", for agents that just pushed.
 * Deterministic: done/failed row for (owner, project, head, base) -> done; queued/running -> running; else pending_push when the
 * user is opted in with cap > 0, the push row is for this head and not handled, the 24h push cap is not exhausted, now is before
 * due_at + 2 poll cycles (past that the poller should have acted and did not), and the poller would really take it (base is the
 * default branch, branch is not, project is in the user's list, no open MR, the user has a skill and an engine); otherwise submit.
 * Ceiling: a push whose event the poller has not read yet has no row, so it reads "submit" until the next poll cycle.
 */
export async function branchStatus(
  db: Db, cfg: Config, u: User, rt: UserRuntime,
  t: { projectId: number; projectPath: string; defaultBranch?: string; branch: string; base: string; head: string; skillFrom?: string }, now = Date.now(),
) {
  const me = u.gitlabUserId;
  // Criteria are part of the key: a review with another user's skill never stands in for one with the owner's own, nor vice versa.
  const review = db.prepare(`SELECT * FROM branch_reviews WHERE owner_id=? AND project_id=? AND head_sha=? AND base=? AND skill_from IS ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(me, t.projectId, t.head, t.base, t.skillFrom ?? null) as BranchReviewRow | undefined;
  const optedIn = u.reviewPushedBranches && u.branchDailyCap > 0;
  const row = optedIn ? db.prepare(`SELECT head_sha, pushed_at, handled_sha FROM pushed_branches WHERE owner_id=? AND project_id=? AND branch=?`)
    .get(me, t.projectId, t.branch) as { head_sha: string; pushed_at: number; handled_sha: string | null } | undefined : undefined;
  const dueAt = row ? row.pushed_at + PUSH_DEBOUNCE_MS : null;
  const handled = row ? row.handled_sha === t.head : false;
  const used = optedIn ? (db.prepare(`SELECT COUNT(*) n FROM branch_reviews WHERE owner_id=? AND trigger='push' AND created_at > ?`).get(me, now - DAY_MS) as { n: number }).n : 0;
  const capped = optedIn && used >= u.branchDailyCap;
  let advice: BranchAdvice = "submit";
  let waiting: string | undefined;
  if (review) advice = review.status === "queued" || review.status === "running" ? "running" : "done";
  // The push trigger only ever reviews with the owner's own skill: a borrowed-criteria status never waits for it.
  else if (!t.skillFrom && row && dueAt !== null && row.head_sha === t.head && !handled && now < dueAt + 2 * cfg.pollIntervalMs
    // The poller only reviews: non-default branches, against the default base, in the user's project list, with no open MR.
    && u.skillPath && rt.engine // the poller waits forever on a missing skill/engine (startBranchReview: no_skill_uploaded / no_review_engine)
    && t.defaultBranch !== undefined && t.base === t.defaultBranch && t.branch !== t.defaultBranch
    && projectAllowed(t.projectPath.toLowerCase(), u.reviewProjects, u.reviewAllProjects)) {
    if (!capped) { // capped: not coming until the 24h window frees
      const mrs = await rt.gl.listBranchMrs(t.projectId, t.branch).catch(() => undefined); // GitLab error: do not promise a review
      if (mrs && !mrs.length) { advice = "pending_push"; waiting = now < dueAt ? "debounce" : "awaiting_poll"; }
    }
  }
  return {
    review: review ? {
      id: review.id, status: review.status, trigger: review.trigger, verdict: review.verdict, skill_from: review.skill_from, ...storedSummary(review.findings_json),
      created_at: review.created_at, finished_at: review.finished_at,
    } : null,
    push: optedIn ? {
      opted_in: true, last_push_head: row?.head_sha ?? null, last_push_at: row?.pushed_at ?? null, due_at: dueAt, handled,
      ...(waiting ? { waiting_reason: waiting } : {}),
    } : null,
    advice,
  };
}

/**
 * Push trigger (opt-in users.review_pushed_branches): review the user's pushed branches that have no MR yet, store the
 * result only (it is posted to GitLab when the MR is opened, see the attach path in reviewMr). One candidate per cycle:
 * the shared single-active rule would reject a second one anyway, and MR reviews keep their place in the lane.
 */
export async function pollPushedBranches(d: Deps, u: User, rt: UserRuntime, now = Date.now()): Promise<void> {
  if (!u.reviewPushedBranches || u.branchDailyCap <= 0) return; // opt-in off, or cap 0 = off: no GitLab call at all
  const me = u.gitlabUserId;
  const after = new Date(now - EVENT_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const seen = new Set<string>();
  for (const e of await rt.gl.listPushEvents(me, after)) { // newest first: the first event per branch is its latest push
    const p = e.push_data;
    if (p?.ref_type !== "branch" || !p.ref || p.action === "removed" || !p.commit_to) continue;
    const k = `${e.project_id}\n${p.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const at = Date.parse(e.created_at);
    if (!Number.isFinite(at)) continue;
    d.db.prepare(`INSERT INTO pushed_branches (owner_id, project_id, branch, head_sha, pushed_at) VALUES (?,?,?,?,?)
      ON CONFLICT(owner_id, project_id, branch) DO UPDATE SET head_sha=excluded.head_sha, pushed_at=excluded.pushed_at, attempts=0 WHERE head_sha != excluded.head_sha`)
      .run(me, e.project_id, p.ref, p.commit_to, at);
  }
  d.db.prepare(`DELETE FROM pushed_branches WHERE owner_id=? AND pushed_at < ?`).run(me, now - EVENT_LOOKBACK_DAYS * DAY_MS * 2);
  const today = new Date(now).toISOString().slice(0, 10);
  for (const k of capLogged) if (!k.endsWith(today)) capLogged.delete(k);

  const due = d.db.prepare(`SELECT project_id, branch, head_sha, attempts FROM pushed_branches WHERE owner_id=? AND pushed_at <= ? AND (handled_sha IS NULL OR handled_sha != head_sha) ORDER BY pushed_at`)
    .all(me, now - PUSH_DEBOUNCE_MS) as { project_id: number; branch: string; head_sha: string; attempts: number }[];
  if (!due.length) return;
  // Lane 0 (the shared login) serializes everyone: never queue a push review behind, or in front of, someone's MR review.
  // Ceiling: under constant MR traffic on a shared lane push reviews wait (they are never dropped, the cap/debounce still apply).
  if (d.queue.laneBusy(laneFor(engineFields(u), d.cfg.ownerEngineTestUsers))) return;
  const tag = (r: { project_id: number; branch: string }) => `${u.username} ${r.project_id}@${r.branch}`;
  // Definitive outcome: the head is not looked at again (logged once). Transient failure: retried next cycle, given up after MAX_ATTEMPTS.
  const skip = (r: { project_id: number; branch: string; head_sha: string }, why: string) => {
    d.db.prepare(`UPDATE pushed_branches SET handled_sha=? WHERE owner_id=? AND project_id=? AND branch=?`).run(r.head_sha, me, r.project_id, r.branch);
    console.log(`[push-review] ${tag(r)} skipped: ${why}`);
  };
  const retry = (r: { project_id: number; branch: string; head_sha: string; attempts: number }, why: string) => {
    const n = r.attempts + 1;
    if (n >= MAX_ATTEMPTS) return skip(r, `${why} (gave up after ${n} attempts)`);
    d.db.prepare(`UPDATE pushed_branches SET attempts=? WHERE owner_id=? AND project_id=? AND branch=?`).run(n, me, r.project_id, r.branch);
    console.log(`[push-review] ${tag(r)} will retry: ${why} (attempt ${n})`);
  };
  // Config problems (token, engine, skill) are for the user to fix: wait without counting attempts, log once per head+reason.
  const waiting = (e: unknown) => (e as { status?: number }).status === 401 || (e instanceof BranchError && ["caller_token_invalid", "no_review_engine", "no_skill_uploaded"].includes(e.code));
  const wait = (r: { project_id: number; branch: string; head_sha: string }, why: string) => {
    const k = `${me}\n${r.project_id}\n${r.branch}\n${r.head_sha}\n${why}`;
    if (waitLogged.has(k)) return;
    if (waitLogged.size > 500) waitLogged.clear();
    waitLogged.add(k);
    console.log(`[push-review] ${tag(r)} waiting: ${why}`);
  };
  // Returns true when the error is a config problem (e.g. 401): it is the same for every branch, so the caller stops this cycle.
  const fail = (r: { project_id: number; branch: string; head_sha: string; attempts: number }, e: unknown, what: string): boolean => {
    if (waiting(e)) { wait(r, `${what}: ${(e as Error).message}`); return true; }
    retry(r, `${what}: ${(e as Error).message}`);
    return false;
  };
  const gone = (e: unknown) => [403, 404].includes((e as { status?: number }).status ?? 0);

  for (const r of due) {
    // Cheapest checks first.
    const used = (d.db.prepare(`SELECT COUNT(*) n FROM branch_reviews WHERE owner_id=? AND trigger='push' AND created_at > ?`).get(me, now - DAY_MS) as { n: number }).n;
    if (used >= u.branchDailyCap) {
      const day = `${me}:${today}`;
      if (!capLogged.has(day)) { capLogged.add(day); console.log(`[push-review] ${u.username}: daily cap ${u.branchDailyCap} reached; pushed branches wait until the 24h window frees`); }
      return; // not handled: picked up when the window frees
    }
    let project;
    try { project = await rt.gl.getProject(r.project_id); } catch (e) { if (gone(e)) skip(r, "project not visible"); else if (fail(r, e, "project lookup")) return; continue; }
    if (!projectAllowed(project.path_with_namespace.toLowerCase(), u.reviewProjects, u.reviewAllProjects)) { skip(r, "project not in the review list"); continue; }
    if (r.branch === project.default_branch) { skip(r, "default branch"); continue; }
    // Dedupe on (owner, project, head, base, own skill): a manual review against another base, or with another user's skill, does not stand in for this one. Any trigger, any status (failed ones are not auto-retried).
    if (d.db.prepare(`SELECT 1 FROM branch_reviews WHERE owner_id=? AND project_id=? AND head_sha=? AND base=? AND skill_from IS NULL`).get(me, r.project_id, r.head_sha, project.default_branch)) { skip(r, "already has a branch review of this head"); continue; }
    let mrs;
    try { mrs = await rt.gl.listBranchMrs(r.project_id, r.branch); } catch (e) { if (fail(r, e, "MR lookup")) return; continue; }
    if (mrs.length) { skip(r, "branch has an open MR"); continue; } // the normal MR review owns it
    let tip: string;
    try { tip = await rt.gl.getBranchSha(r.project_id, r.branch); } catch (e) { if (gone(e)) skip(r, "branch gone"); else if (fail(r, e, "branch lookup")) return; continue; }
    if (tip !== r.head_sha) { skip(r, "branch moved since the push event"); continue; } // a newer push event supersedes this row
    try {
      await startBranchReview(d, u, { project: String(r.project_id), branch: r.branch }, () => true, "push");
      d.db.prepare(`UPDATE pushed_branches SET handled_sha=? WHERE owner_id=? AND project_id=? AND branch=?`).run(r.head_sha, me, r.project_id, r.branch);
      console.log(`[push-review] ${tag(r)} queued`);
    } catch (e) {
      if (e instanceof BranchError && e.code === "too_many_active") return; // busy: retry next cycle, not counted
      if (e instanceof BranchError && e.status === 404) skip(r, e.code);
      else if (waiting(e)) { wait(r, (e as BranchError).code ?? (e as Error).message); return; } // same for every branch: stop this cycle
      else retry(r, e instanceof BranchError ? e.code : (e as Error).message);
      continue;
    }
    return; // one per cycle
  }
}
