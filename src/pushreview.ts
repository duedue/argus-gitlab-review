import type { Config } from "./config.ts";
import { startBranchReview, BranchError } from "./branchreview.ts";
import type { Db } from "./db.ts";
import type { ReviewQueue } from "./queue.ts";
import { projectAllowed } from "./projects.ts";
import type { UserRuntime } from "./review.ts";
import type { User } from "./users.ts";

/** A branch is reviewed only after this long without a new push to it. */
export const PUSH_DEBOUNCE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const EVENT_LOOKBACK_DAYS = 2; // events API filters by date; older pushes are not picked up (e.g. after long downtime)
const capLogged = new Set<string>(); // "owner:YYYY-MM-DD": log the cap once per day

interface Deps { cfg: Config; db: Db; queue: ReviewQueue; runtimeFor: (u: User) => Promise<UserRuntime> }

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
      ON CONFLICT(owner_id, project_id, branch) DO UPDATE SET head_sha=excluded.head_sha, pushed_at=excluded.pushed_at WHERE head_sha != excluded.head_sha`)
      .run(me, e.project_id, p.ref, p.commit_to, at);
  }
  d.db.prepare(`DELETE FROM pushed_branches WHERE owner_id=? AND pushed_at < ?`).run(me, now - EVENT_LOOKBACK_DAYS * DAY_MS * 2);

  const due = d.db.prepare(`SELECT project_id, branch, head_sha FROM pushed_branches WHERE owner_id=? AND pushed_at <= ? AND (handled_sha IS NULL OR handled_sha != head_sha) ORDER BY pushed_at`)
    .all(me, now - PUSH_DEBOUNCE_MS) as { project_id: number; branch: string; head_sha: string }[];
  const handle = (r: { project_id: number; branch: string; head_sha: string }) =>
    d.db.prepare(`UPDATE pushed_branches SET handled_sha=? WHERE owner_id=? AND project_id=? AND branch=?`).run(r.head_sha, me, r.project_id, r.branch);

  for (const r of due) {
    // Cheapest checks first; every verdict except "retry later" marks the head handled so it is not re-examined each cycle.
    if (d.db.prepare(`SELECT 1 FROM branch_reviews WHERE owner_id=? AND project_id=? AND head_sha=?`).get(me, r.project_id, r.head_sha)) { handle(r); continue; } // dedupe: any trigger, any status (failed ones are not auto-retried)
    const used = (d.db.prepare(`SELECT COUNT(*) n FROM branch_reviews WHERE owner_id=? AND trigger='push' AND created_at > ?`).get(me, now - DAY_MS) as { n: number }).n;
    if (used >= u.branchDailyCap) {
      const day = `${me}:${new Date(now).toISOString().slice(0, 10)}`;
      if (!capLogged.has(day)) { capLogged.add(day); console.log(`[push-review] ${u.username}: daily cap ${u.branchDailyCap} reached; pushed branches wait until the 24h window frees`); }
      return; // not handled: picked up when the window frees
    }
    const project = await rt.gl.getProject(r.project_id).catch(() => undefined);
    if (!project || !projectAllowed(project.path_with_namespace.toLowerCase(), u.reviewProjects, u.reviewAllProjects)) { handle(r); continue; }
    if (r.branch === project.default_branch) { handle(r); continue; }
    if ((await rt.gl.listBranchMrs(r.project_id, r.branch)).length) { handle(r); continue; } // has an MR: the normal MR review owns it
    const tip = await rt.gl.getBranchSha(r.project_id, r.branch).catch(() => undefined); // deleted branch -> undefined
    if (tip !== r.head_sha) { handle(r); continue; } // moved or gone: a newer push event supersedes this row
    try {
      await startBranchReview(d, u, { project: String(r.project_id), branch: r.branch }, () => true, "push");
      handle(r);
      console.log(`[push-review] ${u.username} ${project.path_with_namespace}@${r.branch} queued`);
    } catch (e) {
      if (e instanceof BranchError && e.code === "too_many_active") return; // busy: retry next cycle
      console.error(`[push-review] ${u.username} ${project.path_with_namespace}@${r.branch}: ${(e as Error).message}`);
      handle(r);
    }
    return; // one per cycle
  }
}
