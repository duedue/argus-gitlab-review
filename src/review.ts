import type { Config } from "./config.ts";
import { acceptedIds, markAnnounced, carriedSummaryItems, claimReview, recordSkip, clearRetry, dueRetries, isSelfReview, failReview, releaseClaim, finishReview, lastReviewedBaseSha, lastReviewedSha, nextRound, recordBaseSha, type Db } from "./db.ts";
import { fetchRequirements } from "./jira.ts";
import { deriveVerdict } from "./findings.ts";
import { chooseEngine, laneFor, reviewTimeoutMs, SKIP_REASONS, type ReviewEngine } from "./engine.ts";
import { GitLab, isDraft, type MrSummary } from "./gitlab.ts";
import { syncApproval } from "./approve.ts";
import { acceptedItems, afterAccept, resolveAccepted, watchAccepts } from "./accept.ts";
import { claimedFixed, failureNote, fp, openAiThreads, publish, resolveThreads, threadsToResolve } from "./publisher.ts";
import { queueKey, reviewQueue, type ReviewQueue } from "./queue.ts";
import { readProjectContext } from "./context.ts";
import { prepareDiff } from "./repo.ts";
import { daysUntilExpiry, engineFields, type User } from "./users.ts";

/** Everything one user's review needs. `engine` is undefined when the subscription guard denies this user. */
export interface UserRuntime {
  token: () => Promise<string>; // resolved per MR: OAuth tokens may be refreshed mid-cycle
  gl: GitLab;
  engine?: ReviewEngine;
  prepare?: typeof prepareDiff; // injectable for tests
  requirements?: typeof fetchRequirements; // injectable for tests
}

export const DIFF_REFS_RETRIES = 6;
export let DIFF_REFS_WAIT_MS = 5_000;
/** Tests only: shorten the diff_refs wait. */
export const setDiffRefsWait = (ms: number) => (DIFF_REFS_WAIT_MS = ms);

export const EXPIRY_WARN_DAYS = 7;

/** The "please split" note an MR author sees instead of a review: the numbers, why, and where the rules are. */
export function tooLargeNote(lines: number, limit: number, baseUrl: string): string {
  return [
    `這次變更共 **${lines} 行**（新增＋刪除，已排除 lock、翻譯、產生檔），超過審查者的上限 ${limit} 行，因此本輪不做審查。`,
    "",
    "請拆成較小的 MR 後再送（例如：機械性改名／格式化、基礎建設、功能本體、UI 分開）。上限的原因、計算方式與拆分建議見 " +
      `[MR 作者須知](${baseUrl}/docs/mr)。`,
  ].join("\n");
}

/**
 * One poll cycle over all enabled users. Users run in parallel (their jobs share the queue's global cap); within one user
 * everything stays sequential: list -> each review awaited -> retry sweep -> accept watch, all in that user's queue lane.
 * Each user is fully isolated: a failure (bad token, GitLab error, undecryptable secret) is logged and the others still run.
 * `runtimeFor` may throw (e.g. decrypt failure). Resolves when every user's work for this cycle is done.
 */
export async function pollOnce(cfg: Config, db: Db, users: User[], runtimeFor: (u: User) => UserRuntime | Promise<UserRuntime>, queue: ReviewQueue = reviewQueue): Promise<void> {
  await Promise.all(users.filter((x) => x.enabled).map((u) => pollUser(cfg, db, u, runtimeFor, queue)));
}

async function pollUser(cfg: Config, db: Db, u: User, runtimeFor: (u: User) => UserRuntime | Promise<UserRuntime>, queue: ReviewQueue): Promise<void> {
  try {
    if (!u.skillPath) throw new Error("no skill uploaded yet; skipping");
    const days = daysUntilExpiry(u);
    if (days !== undefined && days < 0) throw new Error(`token expired on ${u.tokenExpiresAt}; re-run \`user add\``);
    if (days !== undefined && days <= EXPIRY_WARN_DAYS) console.warn(`[poll] ${u.username}: token expires in ${days} day(s) (${u.tokenExpiresAt})`);
    const rt = await runtimeFor(u);
    const mrs = [...(await rt.gl.listReviewMrs(u.gitlabUserId))];
    if (u.reviewAssigned) {
      // Own MRs listed only because the user is their own assignee are not reviews; self-review has its own trigger.
      // The optional list failing must not stop this cycle's reviewer MRs or the retry sweep.
      const seen = new Set(mrs.map((m) => m.id));
      try {
        for (const m of await rt.gl.listAssignedMrs(u.gitlabUserId)) {
          if (seen.has(m.id) || m.author?.id === u.gitlabUserId) continue;
          seen.add(m.id);
          mrs.push(m);
        }
      } catch (e) {
        console.error(`[poll] ${u.username}: assignee list failed:`, (e as Error).message);
      }
    }
    console.log(`[poll] ${u.username}: ${mrs.length} open MR(s) as reviewer${u.reviewAssigned ? "/assignee" : ""} (dryRun=${cfg.dryRun})`);
    for (const s of mrs) {
      if (isDraft(s)) continue;
      // The user's cycle waits for its reviews, so a long review delays (never overlaps) that user's next step.
      await queue.enqueue(laneFor(engineFields(u), cfg.ownerEngineTestUsers), queueKey(u.gitlabUserId, s.id, s.sha), () => reviewMr(cfg, db, u, rt, s)).done;
    }
    await sweepRetries(cfg, db, u, rt, queue);
    try {
      await watchAccepts(cfg, db, u, rt, mrs, queue); // `/argus accept` commands usually arrive without a new commit
    } catch (e) {
      console.error(`[poll] ${u.username}: accept watch failed:`, (e as Error).message);
    }
  } catch (e) {
    console.error(`[poll] ${u.username} failed:`, (e as Error).message);
  }
}

/**
 * Retry sweep: failed rows whose automatic retry is due but that the listing above never re-claims (author self-reviews,
 * MRs without the user as reviewer). Closed MR or moved head -> the row becomes final (no retry, no note); otherwise it is
 * queued like any review, with selfReview restored from the row by reviewMr. claimReview remains the atomic gate.
 */
async function sweepRetries(cfg: Config, db: Db, u: User, rt: UserRuntime, queue: ReviewQueue): Promise<void> {
  if (!rt.engine) return;
  for (const row of dueRetries(db, u.gitlabUserId, cfg.dryRun)) {
    try {
      const mr = await rt.gl.getMr(row.project_id, row.mr_iid);
      if (mr.state !== "opened" || mr.sha !== row.head_sha) {
        clearRetry(db, row.id);
        console.log(`[retry] ${u.username} ${row.project_id}!${row.mr_iid}@${row.head_sha.slice(0, 8)}: ${mr.state !== "opened" ? "MR not open" : "head moved"}; retry dropped`);
        continue;
      }
      if (row.self_review !== 1 && isDraft(mr)) continue; // like the poller: a draft is skipped, the row is kept until the MR is ready
      await queue.enqueue(laneFor(engineFields(u), cfg.ownerEngineTestUsers), queueKey(u.gitlabUserId, mr.id, mr.sha), () => reviewMr(cfg, db, u, rt, mr, undefined, { selfReview: row.self_review === 1 })).done;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 403) { // MR/project deleted or access lost: never coming back, so stop retrying (final, no note)
        clearRetry(db, row.id);
        console.log(`[retry] ${u.username} ${row.project_id}!${row.mr_iid}: GitLab ${status}; retry dropped`);
        continue;
      }
      console.error(`[retry] ${u.username} ${row.project_id}!${row.mr_iid} sweep failed (row kept for the next cycle):`, (e as Error).message); // e.g. transient GitLab error
    }
  }
}

/** Dev aid input check: a full 40-hex commit id (short ids cannot be fetched by sha). */
export function parseHeadSha(v: string | undefined): string {
  if (!v || !/^[0-9a-f]{40}$/i.test(v)) throw new Error("--head needs a full 40-hex commit sha");
  return v.toLowerCase();
}

/**
 * Review a single MR as `user`. Never throws; failures are recorded in the DB.
 * `headOverride` (dev aid, dry-run only): review the MR as of that commit instead of its current head.
 */
export async function reviewMr(cfg: Config, db: Db, user: User, rt: UserRuntime, s: MrSummary, headOverride?: string, opts: { selfReview?: boolean } = {}): Promise<void> {
  const dryRun = cfg.dryRun; // snapshot: a web toggle mid-review must not split one review across both modes
  if (headOverride) {
    if (!dryRun) return void console.error("[review] headOverride is dry-run only; refusing");
    s = { ...s, sha: headOverride };
  }
  const tag = `${user.username} ${s.project_id}!${s.iid}@${s.sha.slice(0, 8)}`;
  const me = user.gitlabUserId;
  // No engine (engine.ts chooseEngine): record a visible "skipped" row with the reason. That row is re-claimable by
  // claimReview, so the MR is reviewed as soon as an engine exists (e.g. the user pastes a Claude token), no new push needed.
  const engine = rt.engine;
  if (!engine) {
    const c = chooseEngine(engineFields(user), cfg.ownerEngineTestUsers);
    const reason = c.kind === "none" ? c.reason : "engine_unavailable";
    console.log(`[review] ${tag} skipped: no engine (${reason})`);
    if (!headOverride) recordSkip(db, { ownerId: me, projectId: s.project_id, mrId: s.id, mrIid: s.iid, headSha: s.sha, dryRun, webUrl: s.web_url, author: s.author?.username }, SKIP_REASONS[reason]);
    return;
  }
  // `--head` is a dev replay: it must not touch review history (no dedupe row, no incremental base, no rounds).
  const persist = !headOverride;
  const finish: typeof finishReview = (...a) => { if (persist) finishReview(...a); };
  // claimReview is the atomic dedupe gate.
  if (persist && !claimReview(db, { ownerId: me, projectId: s.project_id, mrId: s.id, mrIid: s.iid, headSha: s.sha, dryRun, webUrl: s.web_url, selfReview: opts.selfReview, author: s.author?.username })) {
    console.log(`[review] ${tag} already reviewed, skipping`);
    return;
  }
  // A retry of a self-review row stays a self-review whichever path re-claimed it (poller, sweep, manual).
  const selfReview = opts.selfReview === true || (persist && isSelfReview(db, me, s.id, s.sha, dryRun));
  console.log(`[review] ${tag} ${s.title}`);
  try {
    // Right after an MR is created GitLab computes its diff asynchronously and diff_refs is null for a few seconds.
    let mr = await rt.gl.getMr(s.project_id, s.iid);
    for (let i = 0; !mr.diff_refs && i < DIFF_REFS_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, DIFF_REFS_WAIT_MS));
      mr = await rt.gl.getMr(s.project_id, s.iid);
    }
    if (!mr.diff_refs) {
      console.log(`[review] ${tag} diff not ready yet; will retry next cycle`);
      if (persist) releaseClaim(db, me, s.id, s.sha, dryRun);
      return;
    }
    if (headOverride) Object.assign(mr, { sha: headOverride, diff_refs: { ...mr.diff_refs, head_sha: headOverride } });
    const project = await rt.gl.getProject(s.project_id);
    if (persist) recordBaseSha(db, me, s.id, s.sha, dryRun, mr.diff_refs.base_sha);
    const prepOpts = {
      dataDir: cfg.dataDir,
      ownerId: me,
      token: await rt.token(),
      repoUrl: project.http_url_to_repo,
      projectId: s.project_id,
      iid: s.iid,
      baseSha: mr.diff_refs.base_sha,
      headSha: mr.sha,
      lastReviewedSha: persist ? lastReviewedSha(db, me, s.id, dryRun) : undefined,
      lastReviewedBaseSha: persist ? lastReviewedBaseSha(db, me, s.id, dryRun) : undefined,
      excludeGlobs: cfg.excludeGlobs,
    };
    const maxLines = user.maxDiffLines ?? cfg.maxDiffLines;
    let prep = await (rt.prepare ?? prepareDiff)(prepOpts);
    // Rounds recorded before base_sha existed cannot tell a target merge apart; if that incremental diff is over the
    // limit, judge the whole MR diff instead (it may well be the target's commits inflating it).
    if (prep.incremental && !prepOpts.lastReviewedBaseSha && prep.lines > maxLines) {
      console.log(`[review] ${tag} incremental diff over limit with no recorded base; retrying with the whole MR diff`);
      prep = await (rt.prepare ?? prepareDiff)({ ...prepOpts, lastReviewedSha: undefined });
    }
    const pub = { dryRun, minSeverity: user.severityThreshold, minConfidence: user.confidenceThreshold, hint: { reviewer: user.username, baseUrl: cfg.web.baseUrl, language: user.language } };

    if (!prep.diff.trim()) {
      finish(db, me, s.id, s.sha, dryRun, "skipped", { error: "no reviewable changes" });
      return;
    }
    if (prep.lines > maxLines) {
      await publish(rt.gl, mr, [], pub, tooLargeNote(prep.lines, maxLines, cfg.web.baseUrl));
      finish(db, me, s.id, s.sha, dryRun, "skipped", { error: "diff too large" });
      return;
    }

    // Items the reviewer accepted (`/argus accept`) are no longer tracked, and the AI re-reporting them is dropped.
    const accepted = persist ? acceptedIds(db, me, s.id, dryRun) : new Set<string>();
    const discussions = await rt.gl.listDiscussions(s.project_id, s.iid);
    const allThreads = openAiThreads(discussions, me);
    await resolveAccepted(rt.gl, s.project_id, s.iid, allThreads, accepted, dryRun); // retry of a resolve that failed at accept time
    const threads = allThreads.filter((t) => !accepted.has(t.id));
    const round = persist ? nextRound(db, me, s.id, dryRun) : 1;
    // Previous open items: our open inline threads + summary-only items carried from earlier done reviews.
    const threadIds = new Set(threads.map((t) => t.id));
    const prev = [
      ...threads.map(({ discussionId: _, ...t }) => t),
      ...(round > 1 ? carriedSummaryItems(db, me, s.id, dryRun).filter((t) => !threadIds.has(t.id) && !accepted.has(t.id)) : []),
    ];
    const requirements = await (rt.requirements ?? fetchRequirements)(cfg, mr.title, mr.description ?? "").catch(() => undefined);
    const input = {
      timeoutMs: reviewTimeoutMs(prep.lines),
      cwd: prep.dir, mrTitle: mr.title, mrDescription: mr.description ?? "", diff: prep.diff, incremental: prep.incremental,
      language: user.language, requirements, openThreads: prev,
      accepted: persist ? acceptedItems(db, me, s.id, dryRun, discussions) : [], // told to the AI; the fingerprint filter below is the second line
      projectContext: readProjectContext(prep.dir, mr.diff_refs.base_sha, mr.sha),
    };
    // One engine call per attempt; failures are retried by the automatic attempts (max 3, see failReview).
    const result = await engine.review(input);
    if (dryRun) console.log(`[DRY_RUN] raw agent result: ${JSON.stringify(result)}`); // pre-dedupe, for evaluating the agent
    const findings = result.findings.filter((f) => !accepted.has(fp(f)));
    let verdict = result.verdict;
    if (!verdict) {
      verdict = deriveVerdict(findings);
      console.log(`[review] ${tag} verdict derived from findings (agent gave none): ${verdict}`);
    }
    const fixed = new Set(claimedFixed(prev, result.resolved, findings).map((t) => t.id));
    const unfixedPrev = prev.filter((t) => !fixed.has(t.id)).map((t) => t.id);
    // The AI re-reported only accepted items: same lift rule as an accept between rounds.
    if (findings.length < result.findings.length) verdict = afterAccept(findings, unfixedPrev, accepted, verdict).verdict;
    const ctx = { round, sha: mr.sha, language: user.language, verdict, summary: result.summary, checked: result.checked ?? [], focus: result.focus, track: round > 1 ? { prev, fixed } : undefined, model: result.model, accepted: accepted.size };
    const summaryOnly = await publish(rt.gl, mr, findings, pub, undefined, ctx);
    const toResolve = threadsToResolve(threads, result.resolved, findings);
    const resolvedCount = await resolveThreads(rt.gl, mr, toResolve, { dryRun, language: user.language });
    // Open summary-only items for the next round: carried ones not fixed + this round's new ones (resolved ids never come back).
    const summaryOpen = [
      ...prev.filter((t) => !threadIds.has(t.id) && !fixed.has(t.id)),
      ...summaryOnly.map((f) => ({ id: fp(f), file: f.file, line: f.line, title: f.title })),
      // Dry-run posts nothing, so "inline" findings have no thread to track next round: carry them too.
      ...(dryRun ? findings.filter((f) => !summaryOnly.includes(f)).map((f) => ({ id: fp(f), file: f.file, line: f.line, title: f.title })) : []),
    ].filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i);
    finish(db, me, s.id, s.sha, dryRun, "done", { findings: { findings, verdict, summaryOpen, unfixedPrev }, model: result.model });
    if (persist) markAnnounced(db, me, s.id, dryRun, accepted); // this round's summary already reflects them
    await syncApproval(rt.gl, db, mr, round, user.language, {
      autoApprove: user.autoApprove, dryRun, replay: !persist, selfReview, verdict, findings,
      unfixedPrev: unfixedPrev.length, authorId: mr.author?.id, userId: me,
    });
    console.log(`[review] ${tag} done (round ${round}, ${verdict}), ${findings.length} finding(s), ${resolvedCount}/${threads.length} open thread(s) resolved`);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[review] ${tag} FAILED: ${msg}`);
    if (!persist) return;
    const { attempts, final } = failReview(db, me, s.id, s.sha, dryRun, msg);
    if (!final) return console.log(`[review] ${tag} attempt ${attempts} failed; automatic retry scheduled`);
    // Final failure: tell the MR (best-effort, never in dry-run) so it is not silently stuck.
    if (dryRun) return;
    try {
      await rt.gl.postNote(s.project_id, s.iid, failureNote(attempts, msg, user.language));
    } catch (e2) {
      console.error(`[review] ${tag} could not post failure note: ${(e2 as Error).message}`);
    }
  }
}
