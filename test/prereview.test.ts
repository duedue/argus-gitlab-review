import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey } from "../src/apikeys.ts";
import { loadConfig } from "../src/config.ts";
import { BRANCH_REVIEW_RETENTION_MS, findAttachedMr, findDoneBranchReview, oldestUnattachedBranchReviewAt, finishBranchReview, insertBranchReview, openDb, pruneBranchReviews } from "../src/db.ts";
import type { Finding } from "../src/findings.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { pollOnce, reviewMr, type UserRuntime } from "../src/review.ts";
import { addUser, getUser, setUser } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";
import { ReviewQueue } from "../src/queue.ts";

const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");
const HEAD = "a".repeat(40);
const f = (o: Partial<Finding> = {}): Finding => ({ severity: "major", file: "a.ts", line: 3, title: "t", body: "B", confidence: 0.9, ...o });

function setup(o: { authorId?: number; target?: string; dryRun?: boolean } = {}) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: true });
  setUser(db, "alice", ["auto_approve=1"]);
  const user = getUser(db, "alice")!;
  const calls: string[] = [];
  const notes: string[] = [];
  let engineRuns = 0;
  const preps: { lastReviewedSha?: string; lastReviewedBaseSha?: string; baseSha: string }[] = [];
  let sha = HEAD;
  const base: MrSummary = { id: 100, iid: 5, project_id: 9, title: "t", description: "", sha, web_url: "u", target_branch: o.target ?? "main" };
  const gl = {
    getMr: async () => ({ ...base, sha, author: { id: o.authorId ?? 1 }, diff_refs: { base_sha: "b", start_sha: "b", head_sha: sha } }),
    getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [],
    postNote: async (_p: number, _i: number, body: string) => void notes.push(body),
    postDiscussion: async () => void calls.push("inline"),
    userHasApproved: async () => false, resetsApprovalsOnPush: async () => false,
    approveMr: async () => void calls.push("approve"), unapproveMr: async () => void calls.push("unapprove"),
  } as unknown as GitLab;
  const rt: UserRuntime = {
    token: async () => "t", gl,
    engine: { review: async () => (engineRuns++, { findings: [], resolved: [], verdict: "approve" as const }) },
    prepare: async (opts) => (preps.push(opts), { dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false }),
  };
  const cfg = { ...loadConfig({}), dryRun: o.dryRun === true };
  const stored = (over: { base?: string; head?: string; owner?: number; skipped?: string; status?: "done" | "failed" } = {}) => {
    const id = `br-${Math.random()}`;
    insertBranchReview(db, { id, owner_id: over.owner ?? 1, project_id: 9, project_path: "g/p", branch: "feat", base: over.base ?? "main", merge_base: "m".repeat(40), head_sha: over.head ?? HEAD, trigger: "api" });
    if (over.status === "failed") finishBranchReview(db, id, { error: "review_failed" });
    else finishBranchReview(db, id, { verdict: "approve", summary: "SUMMARY-TEXT", findingsJson: JSON.stringify({ findings: [f()], belowThreshold: [f({ severity: "nit", title: "n", line: undefined })], lines: 1, files: ["a.ts"], skipped: over.skipped }) });
    return id;
  };
  const review = async (newSha = sha) => {
    sha = newSha;
    const log = console.log; console.log = () => {};
    try { await reviewMr(cfg, db, user, rt, { ...base, sha, author: { id: o.authorId ?? 1 } }); } finally { console.log = log; }
  };
  return { db, cfg, preps, calls, notes, stored, review, engineRuns: () => engineRuns, rows: () => db.prepare(`SELECT head_sha, status FROM reviews ORDER BY id`).all() as { head_sha: string; status: string }[] };
}

test("attach: stored branch review is posted summary-only with the pre-MR label, no engine run, no inline, no approve", async () => {
  const t = setup();
  t.stored();
  await t.review();
  assert.equal(t.engineRuns(), 0);
  assert.deepEqual(t.calls, [], "no inline thread, no approve/unapprove");
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /Pre-MR branch review|開 MR 前的 branch review/);
  assert.match(t.notes[0]!, new RegExp(HEAD.slice(0, 8)));
  assert.match(t.notes[0]!, /mmmmmmmm/, "merge-base shown");
  assert.match(t.notes[0]!, /SUMMARY-TEXT/);
  assert.match(t.notes[0]!, /\*\*major\*\*/, "above-threshold finding listed in the summary");
  assert.match(t.notes[0]!, /nit/, "below-threshold finding listed too");
  assert.deepEqual(t.rows(), [{ head_sha: HEAD, status: "done" }]);
});

test("attach: the same head is not reviewed again; a new head after attach reviews normally", async () => {
  const t = setup();
  t.stored();
  await t.review();
  await t.review(); // poller sees the same sha again
  assert.equal(t.engineRuns(), 0);
  assert.equal(t.notes.length, 1, "claimed row blocks a second post");
  await t.review("b".repeat(40));
  assert.equal(t.engineRuns(), 1, "new head -> normal engine review");
  assert.equal(t.rows().length, 2);
});

test("attach: no match -> normal review (target != base, other head, other owner's review, failed, skipped, MR author is someone else)", async () => {
  for (const [name, setupOpt, stored] of [
    ["target != base", {}, { base: "develop" }],
    ["different head", {}, { head: "c".repeat(40) }],
    ["other owner", {}, { owner: 2 }],
    ["failed review", {}, { status: "failed" as const }],
    ["skipped review", {}, { skipped: "diff too large" }],
    ["author is not the user", { authorId: 5 }, {}],
  ] as const) {
    const t = setup(setupOpt);
    t.stored(stored);
    await t.review();
    assert.equal(t.engineRuns(), 1, name);
    assert.ok(!t.notes.some((n) => /Pre-MR branch review/.test(n)), name);
  }
});

test("retention: finished rows older than 90 days are swept; fresh and active rows stay", () => {
  const db = openDb(":memory:");
  const mk = (id: string, fin: "done" | "failed" | null, at: number) => {
    insertBranchReview(db, { id, owner_id: 1, project_id: 9, project_path: "g/p", branch: "b", base: "main", merge_base: "m", head_sha: id, trigger: "api" });
    if (fin === "done") finishBranchReview(db, id, { findingsJson: "{}" }); else if (fin) finishBranchReview(db, id, { error: "x" });
    db.prepare(`UPDATE branch_reviews SET created_at=?, finished_at=CASE WHEN finished_at IS NULL THEN NULL ELSE ? END WHERE id=?`).run(at, at, id);
  };
  const now = Date.now();
  const old = now - BRANCH_REVIEW_RETENTION_MS - 1000;
  mk("old-done", "done", old); mk("old-failed", "failed", old); mk("old-active", null, old); mk("fresh", "done", now - 1000);
  assert.equal(pruneBranchReviews(db, now), 2);
  assert.deepEqual((db.prepare(`SELECT id FROM branch_reviews ORDER BY id`).all() as { id: string }[]).map((r) => r.id), ["fresh", "old-active"]);
});

test("branch_daily_cap: default 20, settable 0-1000, validated", () => {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: true });
  assert.equal(getUser(db, "alice")!.branchDailyCap, 20);
  setUser(db, "alice", ["branch_daily_cap=5"]);
  assert.equal(getUser(db, "alice")!.branchDailyCap, 5);
  for (const bad of ["-1", "1.5", "x", "1001", ""]) assert.throws(() => setUser(db, "alice", [`branch_daily_cap=${bad}`]), /branch_daily_cap/, bad);
});

test("GET /api/branch-reviews: caller's rows newest first, cursor pagination, no result bodies, bad cursor 400", async () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "t-")), GITLAB_URL: "https://gl.test" });
  addUser(db, key, { gitlabUserId: 1, username: "caller", token: "pat", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: false });
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: "https://gl.test", redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor: async () => ({}) as UserRuntime, queue: new ReviewQueue() });
  const h = { authorization: `Bearer ${createApiKey(db, 1)}` };
  for (const [id, owner, at] of [["00000000-0000-0000-0000-000000000001", 1, 100], ["00000000-0000-0000-0000-000000000002", 1, 200], ["00000000-0000-0000-0000-000000000003", 1, 300], ["00000000-0000-0000-0000-000000000009", 2, 400]] as const) {
    insertBranchReview(db, { id, owner_id: owner, project_id: 9, project_path: "g/p", branch: "b", base: "main", merge_base: "m", head_sha: "h", trigger: "push" });
    finishBranchReview(db, id, { verdict: "approve", findingsJson: JSON.stringify({ findings: [f()], belowThreshold: [] }) });
    db.prepare(`UPDATE branch_reviews SET created_at=? WHERE id=?`).run(at, id);
  }
  assert.equal((await app.request("/api/branch-reviews")).status, 401);
  const p1 = (await (await app.request("/api/branch-reviews?limit=2", { headers: h })).json()) as { items: { id: string; findings_count: number; trigger: string; project_path: string }[]; next: string | null };
  assert.deepEqual(p1.items.map((i) => i.id.slice(-1)), ["3", "2"]);
  assert.equal(p1.items[0]!.findings_count, 1);
  assert.equal(p1.items[0]!.trigger, "push");
  assert.ok(p1.next);
  assert.ok(!("findings" in p1.items[0]!), "list carries counts, not bodies");
  const p2 = (await (await app.request(`/api/branch-reviews?limit=2&before=${p1.next}`, { headers: h })).json()) as { items: { id: string }[]; next: string | null };
  assert.deepEqual(p2.items.map((i) => i.id.slice(-1)), ["1"]);
  assert.equal(p2.next, null);
  assert.equal((await app.request("/api/branch-reviews?before=nope", { headers: h })).status, 400);
});

test("attach guard: an MR that already has review history is reviewed normally, not reset to round 1", async () => {
  const t = setup();
  t.stored();
  t.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status) VALUES (1, 9, 100, 5, 'older', 0, 'done')`).run();
  await t.review();
  assert.equal(t.engineRuns(), 1, "normal engine review");
  assert.ok(!t.notes.some((n) => /Pre-MR branch review/.test(n)));
});

test("attach is recorded explicitly (branch_reviews.attached_review_id) and found by findAttachedMr only for that branch review and owner", async () => {
  const t = setup();
  const id = t.stored();
  await t.review();
  assert.equal(findAttachedMr(t.db, 1, id)?.mr_iid, 5);
  assert.equal(findAttachedMr(t.db, 2, id), undefined, "owner scoped");
  assert.equal(findAttachedMr(t.db, 1, "other-id"), undefined);
});

function pollSetup(o: { noteFails?: boolean; mrUpdatedAt?: string; getMrSha?: string; all?: boolean; list?: string; authorId?: number; target?: string } = {}) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: false });
  setUser(db, "alice", [`review_all_projects=${o.all === false ? 0 : 1}`, ...(o.list ? [`review_projects=${o.list}`] : [])]);
  const notes: string[] = [];
  let engineRuns = 0, authoredCalls = 0, getMrCalls = 0, noteFails = o.noteFails === true;
  const afters: (string | undefined)[] = [];
  let noteCalls = 0;
  const mr: MrSummary = { id: 100, iid: 5, project_id: 9, title: "t", description: "", sha: HEAD, web_url: "https://gl.test/g/p/-/merge_requests/5", target_branch: o.target ?? "main", author: { id: o.authorId ?? 1 } };
  const gl = {
    listReviewMrs: async () => [], listAssignedMrs: async () => [], listNotes: async () => [],
    listAuthoredMrs: async (_u: number, after?: string) => (authoredCalls++, afters.push(after), o.mrUpdatedAt && after && o.mrUpdatedAt < after ? [] : [mr]), // GitLab updated_after filter
    getMr: async () => (getMrCalls++, { ...mr, sha: o.getMrSha ?? HEAD, diff_refs: { base_sha: "b", start_sha: "b", head_sha: HEAD } }),
    getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [], postNote: async (_p: number, _i: number, b: string) => { noteCalls++; if (noteFails) throw new Error("GitLab 502"); notes.push(b); }, postDiscussion: async () => {},
    userHasApproved: async () => false, resetsApprovalsOnPush: async () => false, approveMr: async () => {}, unapproveMr: async () => {},
  } as unknown as GitLab;
  const rt: UserRuntime = { token: async () => "t", gl, engine: { review: async () => (engineRuns++, { findings: [], resolved: [] }) }, prepare: async () => ({ dir: "/x", diff: "+x\n", lines: 1, files: ["a"], incremental: false }) };
  const cfg = { ...loadConfig({ GITLAB_URL: "https://gl.test", DATA_DIR: mkdtempSync(join(tmpdir(), "t-")) }), dryRun: false };
  const stored = (base = "main") => {
    insertBranchReview(db, { id: `b-${Math.random()}`, owner_id: 1, project_id: 9, project_path: "g/p", branch: "feat", base, merge_base: "m".repeat(40), head_sha: HEAD, trigger: "api" });
    db.prepare(`UPDATE branch_reviews SET status='done', verdict='approve', findings_json=?`).run(JSON.stringify({ findings: [f()], belowThreshold: [] }));
  };
  const poll = async () => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { await pollOnce(cfg, db, [getUser(db, "alice")!], () => rt, new ReviewQueue()); } finally { Object.assign(console, { log: l, error: e }); } };
  return { db, notes, poll, stored, afters, engineRuns: () => engineRuns, authoredCalls: () => authoredCalls, getMrCalls: () => getMrCalls, setNoteFails: (v: boolean) => (noteFails = v), noteCalls: () => noteCalls };
}

test("poller: the author's own open MR gets the stored branch review attached (attach-only), once", async () => {
  const t = pollSetup();
  await t.poll();
  assert.equal(t.authoredCalls(), 0, "no branch review yet: the authored list is not even fetched");
  t.stored();
  await t.poll();
  assert.equal(t.authoredCalls(), 1);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /Pre-MR branch review|開 MR 前的 branch review/);
  assert.equal(t.engineRuns(), 0);
  await t.poll();
  assert.equal(t.notes.length, 1, "same head is not posted again");
  assert.equal(t.authoredCalls(), 1, "everything attached: the authored list is no longer fetched");
});

test("poller: the authored list is narrowed with updated_after = the oldest unattached review, and a skipped/failed review does not open the gate", async () => {
  const t = pollSetup();
  t.stored();
  await t.poll();
  const created = (t.db.prepare(`SELECT created_at c FROM branch_reviews`).get() as { c: number }).c;
  assert.equal(t.afters[0], new Date(created - 10 * 60_000).toISOString(), "review START minus the 10 min slack, not its finish");
  const sk = pollSetup();
  sk.stored();
  sk.db.prepare(`UPDATE branch_reviews SET findings_json=?, verdict=NULL`).run(JSON.stringify({ findings: [], belowThreshold: [], skipped: "diff too large" })); // a skipped run has no verdict
  await sk.poll();
  assert.equal(sk.authoredCalls(), 0);
});

test("poller: a failed attach leaves no row (no retry sweep, no failure note, no engine); the next poll attaches", async () => {
  const t = pollSetup({ noteFails: true });
  t.stored();
  await t.poll();
  await t.poll(); // would be the retry-sweep path if a failed row existed
  assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
  assert.deepEqual([t.notes.length, t.engineRuns()], [0, 0]);
  t.setNoteFails(false);
  await t.poll();
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /Pre-MR branch review|開 MR 前的 branch review/);
  assert.equal(t.engineRuns(), 0);
});

test("poller: a head that already has a skipped/failed row is not claimed again (no getMr call)", async () => {
  const t = pollSetup();
  t.stored();
  t.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, error) VALUES (1, 9, 100, 5, ?, 0, 'skipped', 'diff too large')`).run(HEAD);
  await t.poll();
  assert.deepEqual([t.getMrCalls(), t.notes.length], [0, 0]);
});

test("poller: attach-only never starts a normal review of an authored MR (target != base, outside the list, no match)", async () => {
  const wrongBase = pollSetup(); wrongBase.stored("develop");
  await wrongBase.poll();
  const outside = pollSetup({ all: false, list: "other/team" }); outside.stored();
  await outside.poll();
  for (const [name, t] of [["target != base", wrongBase], ["outside the project list", outside]] as const) {
    assert.deepEqual([t.notes.length, t.engineRuns()], [0, 0], name);
    assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0, `${name}: no reviews row, so a later match can still attach`);
  }
  const history = pollSetup(); history.stored();
  history.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status) VALUES (1, 9, 100, 5, 'older', 0, 'done')`).run();
  await history.poll();
  assert.deepEqual([history.notes.length, history.engineRuns()], [0, 0], "MR with history: nothing, not a review");
});

test("poller: an MR opened while the branch review was still running (updated before it finished) is still attached", async () => {
  const startedAt = Date.now() - 60 * 60_000;
  const t = pollSetup({ mrUpdatedAt: new Date(startedAt + 2 * 60_000).toISOString() }); // updated 2 min after the review started, 5 min before it finished
  t.stored();
  t.db.prepare(`UPDATE branch_reviews SET created_at=?, finished_at=?`).run(startedAt, startedAt + 7 * 60_000);
  await t.poll();
  assert.equal(t.notes.length, 1);
});

test("poller: a branch review older than 14 days no longer opens the gate (no authored list call); a 13-day-old one does", async () => {
  const old = pollSetup();
  old.stored();
  old.db.prepare(`UPDATE branch_reviews SET created_at=?`).run(Date.now() - 15 * 86_400_000);
  await old.poll();
  assert.equal(old.authoredCalls(), 0);
  assert.equal(oldestUnattachedBranchReviewAt(old.db, 1), undefined);
  const recent = pollSetup();
  recent.stored();
  recent.db.prepare(`UPDATE branch_reviews SET created_at=?`).run(Date.now() - 13 * 86_400_000);
  await recent.poll();
  assert.equal(recent.authoredCalls(), 1);
  assert.equal(Date.parse(recent.afters[0]!) < Date.now() - 13 * 86_400_000, true, "since = start minus slack");
});

test("attach lookup ignores skipped runs: a head with only a skipped review is never claimed; a newer skipped row does not shadow an older valid one", async () => {
  const only = pollSetup();
  only.stored();
  only.db.prepare(`UPDATE branch_reviews SET verdict=NULL, findings_json=?`).run(JSON.stringify({ findings: [], belowThreshold: [], skipped: "diff too large" }));
  await only.poll();
  assert.deepEqual([only.getMrCalls(), only.notes.length], [0, 0], "no claim/getMr/release churn");
  const both = setup();
  const valid = both.stored();
  const skipped = both.stored({ skipped: "diff too large" });
  both.db.prepare(`UPDATE branch_reviews SET verdict=NULL WHERE id=?`).run(skipped);
  both.db.prepare(`UPDATE branch_reviews SET created_at=created_at+1000 WHERE id=?`).run(skipped); // newer
  assert.equal(findDoneBranchReview(both.db, 1, 9, HEAD, "main")?.id, valid);
  await both.review();
  assert.equal(both.engineRuns(), 0, "the valid one attached");
  assert.equal(findAttachedMr(both.db, 1, valid)?.mr_iid, 5);
});

test("poller: a permanent attach failure is given up after 3 tries (until the head changes or a restart)", async () => {
  const t = pollSetup({ noteFails: true });
  t.stored();
  for (let i = 0; i < 6; i++) await t.poll();
  assert.equal(t.noteCalls(), 3);
  assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
});

test("poller: MR head moved between the listing and getMr -> no attach (one sha throughout)", async () => {
  const t = pollSetup({ getMrSha: "f".repeat(40) });
  t.stored();
  await t.poll();
  assert.deepEqual([t.notes.length, t.engineRuns()], [0, 0]);
  assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
});

test("poller: a failing attach step never breaks the rest of pollUser (caught inside attachAuthoredMrs)", async () => {
  const t = pollSetup();
  t.db.exec(`ALTER TABLE branch_reviews RENAME TO branch_reviews_gone`);
  const errs: string[] = [];
  const e = console.error, l = console.log; console.error = (...a: unknown[]) => void errs.push(a.join(" ")); console.log = () => {};
  try { await pollOnce({ ...loadConfig({ GITLAB_URL: "https://gl.test" }), dryRun: false }, t.db, [getUser(t.db, "alice")!], () => ({ token: async () => "t", gl: { listReviewMrs: async () => [], listAssignedMrs: async () => [] } as unknown as GitLab }), new ReviewQueue()); } finally { Object.assign(console, { error: e, log: l }); }
  assert.ok(errs.some((x) => /attaching branch reviews failed/.test(x)));
  assert.ok(!errs.some((x) => /\[poll\] alice failed/.test(x)));
});

test("unattached lookup is an indexed plain query (uses idx_branch_reviews_unattached)", () => {
  const db = openDb(":memory:");
  const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT MIN(created_at) FROM branch_reviews WHERE owner_id=1 AND status='done' AND attached_review_id IS NULL AND verdict IS NOT NULL`).all() as { detail: string }[]).map((r) => r.detail).join(" ");
  assert.match(plan, /idx_branch_reviews_unattached/);
});

test("attach records the base sha: the next round gets the attached round's merge-base (a moved base then means a full diff)", async () => {
  const t = setup();
  t.stored();
  await t.review();
  assert.equal((t.db.prepare(`SELECT base_sha b FROM reviews WHERE head_sha=?`).get(HEAD) as { b: string }).b, "b");
  await t.review("b".repeat(40)); // author pushes again; normal incremental round
  assert.equal(t.preps[0]!.lastReviewedSha, HEAD);
  assert.equal(t.preps[0]!.lastReviewedBaseSha, "b", "prepareDiff compares it with the new base and reviews the full diff when it moved (see mergebase.test.ts)");
});

test("dry-run attach does not mark the branch review attached, so a later live run still attaches", async () => {
  const t = setup({ dryRun: true });
  const id = t.stored();
  await t.review();
  assert.equal(t.notes.length, 0, "dry-run posts nothing");
  assert.equal(findAttachedMr(t.db, 1, id), undefined);
  assert.equal(oldestUnattachedBranchReviewAt(t.db, 1) !== undefined, true, "gate still open");
  t.cfg.dryRun = false; // switched to live
  await t.review();
  assert.equal(t.notes.length, 1);
  assert.equal(findAttachedMr(t.db, 1, id)?.mr_iid, 5);
});
