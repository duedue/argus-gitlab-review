import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey } from "../src/apikeys.ts";
import { extractIssueKeys } from "../src/jira.ts";
import { branchQueueKey, branchReviewTitle, criteriaFor, getBranchJob, resolveBranch, runBranchReview, validBranchName, validProjectRef } from "../src/branchreview.ts";
import { loadConfig } from "../src/config.ts";
import { activeBranchReview, claimReview, failStaleCliBranchReviews, findDoneBranchReview, finishBranchReview, insertBranchReview, listBranchReviews, openDb, releaseStaleRunning, type BranchReviewRow } from "../src/db.ts";
import type { ReviewEngine, ReviewInput } from "../src/engine.ts";
import type { GitLab } from "../src/gitlab.ts";
import { ReviewQueue } from "../src/queue.ts";
import type { UserRuntime } from "../src/review.ts";
import { PUSH_DEBOUNCE_MS, branchStatus } from "../src/pushreview.ts";
import { addUser, getUser, setUser, type User } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const GL = "https://gl.test";
const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");
const skillPath = join(skillDir, "SKILL.md");

/** main: M0 -> M1 (adds big.txt); feat from M0: F (adds f.txt), then merges main. merge-base(main, feat) = M1, not M0. */
function repo() {
  const src = mkdtempSync(join(tmpdir(), "branch-src-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
  const put = (f: string, n: number) => writeFileSync(join(src, f), Array.from({ length: n }, (_, i) => `l${i}`).join("\n") + "\n");
  g("init", "-q", "-b", "main");
  g("config", "uploadpack.allowAnySHA1InWant", "true");
  put("m.txt", 1); g("add", "."); g("commit", "-qm", "M0");
  g("checkout", "-q", "-b", "feat");
  put("f.txt", 5); g("add", "."); g("commit", "-qm", "F");
  g("checkout", "-q", "main");
  put("big.txt", 100); g("add", "."); g("commit", "-qm", "M1");
  const m1 = g("rev-parse", "HEAD");
  g("checkout", "-q", "feat");
  g("merge", "-q", "--no-edit", "main");
  return { url: `file://${src}`, m1, head: g("rev-parse", "HEAD"), rev: (r: string) => g("rev-parse", r), mergeBase: (a: string, b: string) => g("merge-base", a, b) };
}

let openMrs = 0; // open MRs the fake GitLab reports for any branch
let mrsFail = false; // listBranchMrs rejects
const forbidden = () => assert.fail("a branch review must not write to GitLab");
function fakeGl(r: ReturnType<typeof repo>, calls: string[] = []) {
  return {
    getProject: async (id: number | string) => { calls.push(`project ${id}`); if (id === "no/such") throw Object.assign(new Error("nf"), { status: 404 }); return { id: 9, http_url_to_repo: r.url, path_with_namespace: "g/p", default_branch: "main" }; },
    getBranchSha: async (_: number, b: string) => { calls.push(`branch ${b}`); if (b === "nope") throw Object.assign(new Error("nf"), { status: 404 }); return r.rev(b); },
    getMergeBase: async (_: number, a: string, b: string) => { calls.push("merge-base"); return r.mergeBase(a, b); },
    listBranchMrs: async () => { if (mrsFail) throw new Error("gitlab 500"); return Array.from({ length: openMrs }, (_, i) => ({ iid: i + 1 })); },
    postNote: forbidden, postDiscussion: forbidden, replyDiscussion: forbidden, resolveDiscussion: forbidden, approveMr: forbidden, unapproveMr: forbidden,
  } as unknown as GitLab;
}
const mkRt = (r: ReturnType<typeof repo>, seen: ReviewInput[], calls?: string[]): UserRuntime => ({
  token: async () => "t", gl: fakeGl(r, calls),
  engine: { review: async (i) => (seen.push(i), { findings: [{ severity: "major", file: "f.txt", line: 1, title: "t", body: "b", confidence: 0.9 }, { severity: "nit", file: "f.txt", title: "n", body: "b", confidence: 0.9 }], resolved: [] }) } as ReviewEngine,
  requirements: async () => undefined,
});
function setup() {
  const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "t-")), GITLAB_URL: GL });
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "caller", token: "pat", tokenExpiresAt: null, skillPath, isOwner: false });
  return { cfg, db, user: getUser(db, "caller")! };
}

test("branch review diffs from the merge-base, not the base tip (real git)", async () => {
  const r = repo();
  const { cfg, user } = setup();
  const seen: ReviewInput[] = [];
  const rt = mkRt(r, seen);
  const target = { project: "g/p", branch: "feat" };
  const res = await resolveBranch(rt, target);
  assert.equal(res.base, "main", "defaults to the project's default branch");
  assert.equal(res.mergeBase, r.m1, "feat merged main@M1, so the merge-base is M1");
  const out = await runBranchReview(cfg, user, rt, target, res);
  assert.deepEqual(out.files, ["f.txt"], "target-only commits (big.txt) are not in the diff");
  assert.equal(out.lines, 5);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.diff.includes("big.txt"));
  assert.equal(seen[0]!.incremental, false);
  assert.deepEqual(out.findings.map((f) => f.severity), ["major"], "default threshold applies: nit is below it");
  assert.equal(out.belowThreshold.length, 1);
  assert.equal(out.verdict, "request_changes");
});

test("branch review never writes: GitLab write calls throw, no db row, and the real MR is still claimable", async () => {
  const r = repo();
  const { cfg, db, user } = setup();
  const rt = mkRt(r, []);
  await runBranchReview(cfg, user, rt, { project: "g/p", branch: "feat" }, await resolveBranch(rt, { project: "g/p", branch: "feat" }));
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
  assert.equal(claimReview(db, { ownerId: 1, projectId: 9, mrId: 70, mrIid: 7, headSha: r.head, dryRun: false, webUrl: "u", author: "a" }), true, "same sha, MR review still runs");
  // Structural guarantee: the module has no path to the publisher or review history.
  const src = readFileSync(new URL("../src/branchreview.ts", import.meta.url), "utf8");
  assert.ok(!/publisher|approve|claimReview|finishReview/.test(src.replace(/^\s*\*.*$/gm, "")));
});

test("branch review: explicit base, skip reasons, validators", async () => {
  const r = repo();
  const { cfg, user } = setup();
  const rt = mkRt(r, []);
  const same = await resolveBranch(rt, { project: "9", branch: "main", base: "main" });
  assert.equal((await runBranchReview(cfg, user, rt, { project: "9", branch: "main", base: "main" }, same)).skipped, "no reviewable changes");
  const big = await runBranchReview({ ...cfg, maxDiffLines: 2 }, user, rt, { project: "g/p", branch: "feat" }, await resolveBranch(rt, { project: "g/p", branch: "feat" }));
  assert.match(big.skipped!, /diff too large/);
  await assert.rejects(resolveBranch(rt, { project: "g/p", branch: "nope" }), { code: "branch_not_found" });
  await assert.rejects(resolveBranch(rt, { project: "no/such", branch: "feat" }), { code: "project_not_found" });
  for (const ok of ["feat", "fix/PROJ-1-x.y", "a+b_c"]) assert.ok(validBranchName(ok), ok);
  for (const bad of ["", "-x", "a..b", "a b", "a;b", "$(x)", "/a", "a/", "a//b", "x.lock", "a/.b", ".", ".hidden", "a@b", "a#b", "a~1", "é", "a".repeat(256), 5]) assert.ok(!validBranchName(bad), String(bad));
  assert.ok(validProjectRef("12") && validProjectRef("g/sub/p-1.x"));
  for (const bad of ["", "g", "../x", "g/p;rm", "g//p", 5]) assert.ok(!validProjectRef(bad), String(bad));
});

function api(opts: { limit?: number; attempts?: number; status?: number } = {}) {
  const r = repo();
  const { cfg, db } = setup();
  const seen: ReviewInput[] = [];
  const queue = new ReviewQueue();
  const runtimeFor = async (_u: User) => ({ ...mkRt(r, seen) });
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor, queue, triggerLimitPerHour: opts.limit, branchAttemptsPerHour: opts.attempts, branchStatusPerHour: opts.status });
  const apiKey = createApiKey(db, 1);
  const post = (body: unknown, auth: string | null = `Bearer ${apiKey}`) =>
    app.request("/api/review-branch", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = (id: string, auth: string | null = `Bearer ${apiKey}`) => app.request(`/api/review-branch/${id}`, { headers: auth ? { authorization: auth } : {} });
  return { app, db, queue, seen, post, get, r };
}

test("api: auth, validation, 202 + poll to done, ownership, never in review history", async () => {
  const t = api();
  assert.equal((await t.post({ project: "g/p", branch: "feat" }, null)).status, 401);
  assert.equal((await t.post({ project: "g/p", branch: "feat" }, "Bearer argus_bad")).status, 401);
  assert.equal((await t.get("x", null)).status, 401);
  for (const [body, err] of [["not json", "invalid_project"], [{ branch: "feat" }, "invalid_project"], [{ project: "g/p" }, "invalid_branch"], [{ project: "g/p", branch: "a..b" }, "invalid_branch"], [{ project: "g/p", branch: "feat", base: "-x" }, "invalid_base"]] as const) {
    const res = await t.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(((await res.json()) as { error: string }).error, err);
  }
  assert.equal((await t.post({ project: "no/such", branch: "feat" })).status, 404);

  const res = await t.post({ project: "g/p", branch: "feat" });
  assert.equal(res.status, 202);
  const j = (await res.json()) as { id: string; head: string; merge_base: string; base: string };
  assert.equal(j.head, t.r.head);
  assert.equal(j.merge_base, t.r.m1);
  assert.equal(j.base, "main");
  await t.queue.idle();
  const done = (await (await t.get(j.id)).json()) as { status: string; head: string; merge_base: string; findings: unknown[]; verdict: string; error?: string };
  assert.equal(done.status, "done", done.error);
  assert.equal(done.findings.length, 1);
  assert.equal(done.verdict, "request_changes");
  assert.equal((await t.get("nonexistent")).status, 404);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
  // another user cannot read it
  addUser(t.db, key, { gitlabUserId: 2, username: "other", token: "p", tokenExpiresAt: null, skillPath, isOwner: false });
  const other = createApiKey(t.db, 2);
  assert.equal((await t.get(j.id, `Bearer ${other}`)).status, 404);
});

test("api: hourly budget is shared with trigger, charged only when a job is created; polling is free", async () => {
  const t = api({ limit: 1 });
  const res = await t.post({ project: "g/p", branch: "feat" });
  assert.equal(res.status, 202);
  const { id } = (await res.json()) as { id: string };
  for (let i = 0; i < 3; i++) assert.equal((await t.get(id)).status, 200);
  assert.equal((await t.post({ project: "g/p", branch: "feat" })).status, 202, "deduped call is not charged and returns the same job");
  await t.queue.idle();
  const limited = await t.post({ project: "g/p", branch: "feat" });
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: string }).error, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "3600");
});

test("api: one active job per user; a rejected call does not use the budget", async () => {
  const t = api({ limit: 2 });
  const first = (await (await t.post({ project: "g/p", branch: "feat" })).json()) as { id: string };
  const second = await t.post({ project: "g/p", branch: "main", base: "feat" });
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: "too_many_active", active_id: first.id });
  await t.queue.idle();
  assert.equal((await t.post({ project: "g/p", branch: "main", base: "feat" })).status, 202, "allowed again once the first finished (budget: 2 charged, 1 rejected free)");
  assert.equal(((await (await t.get(first.id)).json()) as { status: string }).status, "done");
  await t.queue.idle();
});

test("persistence: GET reads the db (survives a new app), row is complete, MR reviews table untouched", async () => {
  const t = api();
  const { id } = (await (await t.post({ project: "g/p", branch: "feat" })).json()) as { id: string };
  assert.match(((await (await t.get(id)).json()) as { status: string }).status, /^(queued|running)$/);
  await t.queue.idle();
  const row = t.db.prepare(`SELECT * FROM branch_reviews WHERE id=?`).get(id) as BranchReviewRow;
  assert.equal(row.status, "done");
  assert.equal(row.trigger, "api");
  assert.equal(row.project_path, "g/p");
  assert.equal(row.project_id, 9);
  assert.equal(row.head_sha, t.r.head);
  assert.equal(row.verdict, "request_changes");
  assert.ok(row.finished_at);
  const stored = JSON.parse(row.findings_json!) as { findings: unknown[]; belowThreshold: unknown[] };
  assert.equal(stored.findings.length, 1);
  assert.equal(stored.belowThreshold.length, 1, "below-threshold findings are kept");
  const body = (await (await t.get(id)).json()) as { findings: unknown[]; below_threshold: unknown[]; merge_base: string; project: string };
  assert.equal(body.below_threshold.length, 1);
  assert.equal(body.merge_base, t.r.m1);
  assert.equal(body.project, "9");
  assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
  // a restart marks leftover active rows failed (only those), finished rows stay
  insertBranchReview(t.db, { id: "stuck", owner_id: 1, project_id: 9, project_path: "g/p", branch: "x", base: "main", merge_base: "m", head_sha: "h", trigger: "api" });
  releaseStaleRunning(t.db);
  assert.equal((t.db.prepare(`SELECT status, error FROM branch_reviews WHERE id='stuck'`).get() as { status: string; error: string }).error, "interrupted");
  assert.equal(getBranchJob(t.db, id, 1)?.status, "done");
  assert.equal(getBranchJob(t.db, id, 2), undefined, "other owner");
  assert.equal(activeBranchReview(t.db, 1), undefined);
});

test("query helpers: newest-first keyset pagination, owner scoped; find done by (owner, project, head)", () => {
  const db = openDb(":memory:");
  const mk = (id: string, owner: number, head: string, at: number, status: "done" | "failed" = "done") => {
    insertBranchReview(db, { id, owner_id: owner, project_id: 9, project_path: "g/p", branch: "b", base: "main", merge_base: "m", head_sha: head, trigger: "push" });
    db.prepare(`UPDATE branch_reviews SET created_at=?, status=?, verdict='approve' WHERE id=?`).run(at, status, id);
  };
  mk("a", 1, "h1", 100); mk("b", 1, "h2", 200); mk("c", 1, "h2", 200); mk("d", 1, "h3", 300, "failed"); mk("x", 2, "h1", 400);
  assert.deepEqual(listBranchReviews(db, 1).map((r) => r.id), ["d", "c", "b", "a"]);
  const p1 = listBranchReviews(db, 1, { limit: 2 });
  assert.deepEqual(p1.map((r) => r.id), ["d", "c"]);
  const last = p1[1]!;
  assert.deepEqual(listBranchReviews(db, 1, { limit: 2, before: { createdAt: last.created_at, id: last.id } }).map((r) => r.id), ["b", "a"]);
  assert.equal(findDoneBranchReview(db, 1, 9, "h2")?.id, "c", "latest of equal time by id");
  assert.equal(findDoneBranchReview(db, 1, 9, "h3"), undefined, "failed is not done");
  assert.equal(findDoneBranchReview(db, 2, 9, "h2"), undefined, "owner scoped");
  assert.equal(findDoneBranchReview(db, 1, 8, "h1"), undefined, "project scoped");
});

test("branch_reviews is independent of the MR dedupe: claiming the same head still works", () => {
  const db = openDb(":memory:");
  insertBranchReview(db, { id: "j", owner_id: 1, project_id: 9, project_path: "g/p", branch: "b", base: "main", merge_base: "m", head_sha: "h1", trigger: "api" });
  finishBranchReview(db, "j", { verdict: "approve", findingsJson: "{}" });
  assert.ok(claimReview(db, { ownerId: 1, projectId: 9, mrId: 5, mrIid: 1, headSha: "h1", dryRun: false }), "MR claim for the same sha is unaffected");
});

test("api: engine failure returns generic review_failed", async () => {
  const r = repo();
  const { cfg, db } = setup();
  const queue = new ReviewQueue();
  const rt = { ...mkRt(r, []), engine: { review: async () => { throw new Error("spawn /srv/secret/path ENOENT"); } } as ReviewEngine };
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor: async () => rt, queue });
  const h = { authorization: `Bearer ${createApiKey(db, 1)}`, "content-type": "application/json" };
  const { id } = (await (await app.request("/api/review-branch", { method: "POST", headers: h, body: JSON.stringify({ project: "g/p", branch: "feat" }) })).json()) as { id: string };
  await queue.idle();
  const body = await (await app.request(`/api/review-branch/${id}`, { headers: h })).text();
  assert.match(body, /"status":"failed"/);
  assert.match(body, /"error":"review_failed"/);
  assert.ok(!body.includes("/srv/secret"));
});

test("api: a still-pending identical queue key does not leave a job stuck queued", async () => {
  const r = repo();
  const { cfg, db } = setup();
  const queue = new ReviewQueue();
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor: async () => mkRt(r, []), queue });
  let release!: () => void;
  queue.enqueue(0, branchQueueKey(1, 9, r.head, r.m1), () => new Promise<void>((res) => (release = res)));
  const h = { authorization: `Bearer ${createApiKey(db, 1)}`, "content-type": "application/json" };
  const res = await app.request("/api/review-branch", { method: "POST", headers: h, body: JSON.stringify({ project: "g/p", branch: "feat" }) });
  assert.equal(res.status, 429);
  release();
  await queue.idle();
  // the rejected job was removed, so the user is not blocked by it
  assert.equal((await app.request("/api/review-branch", { method: "POST", headers: h, body: JSON.stringify({ project: "g/p", branch: "feat" }) })).status, 202);
  await queue.idle();
});

test("api: a rejected too_many_active (pending key) does not burn the budget", async () => {
  const r = repo();
  const { cfg, db } = setup();
  const queue = new ReviewQueue();
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor: async () => mkRt(r, []), queue, triggerLimitPerHour: 1 });
  let release!: () => void;
  queue.enqueue(0, branchQueueKey(1, 9, r.head, r.m1), () => new Promise<void>((res) => (release = res)));
  const h = { authorization: `Bearer ${createApiKey(db, 1)}`, "content-type": "application/json" };
  const post = () => app.request("/api/review-branch", { method: "POST", headers: h, body: JSON.stringify({ project: "g/p", branch: "feat" }) });
  assert.equal(((await (await post()).json()) as { error: string }).error, "too_many_active");
  release();
  await queue.idle();
  assert.equal((await post()).status, 202, "the single budget unit is still available");
  await queue.idle();
});

test("api: coarse attempt limiter applies before any GitLab work, even to rejected calls", async () => {
  const t = api({ attempts: 2 });
  assert.equal((await t.post({ project: "bad", branch: "feat" })).status, 400);
  assert.equal((await t.post({ project: "no/such", branch: "feat" })).status, 404);
  const third = await t.post({ project: "g/p", branch: "feat" });
  assert.equal(third.status, 429);
  assert.equal(((await third.json()) as { error: string }).error, "rate_limited");
  assert.equal(third.headers.get("retry-after"), "3600");
});

test("api: a leftover CLI running row does not block; an old queued/running API row still counts (the queue always ends it)", async () => {
  const t = api();
  insertBranchReview(t.db, { id: "cli-stuck", owner_id: 1, project_id: 9, project_path: "g/p", branch: "x", base: "main", merge_base: "m", head_sha: "x".repeat(40), trigger: "cli", status: "running" });
  t.db.prepare(`UPDATE branch_reviews SET created_at=?`).run(Date.now() - 3_600_000);
  const res = await t.post({ project: "g/p", branch: "feat" });
  assert.equal(res.status, 202);
  await t.queue.idle();
  insertBranchReview(t.db, { id: "long-queued", owner_id: 1, project_id: 9, project_path: "g/p", branch: "y", base: "main", merge_base: "m", head_sha: "y".repeat(40), trigger: "api", status: "running" });
  t.db.prepare(`UPDATE branch_reviews SET created_at=? WHERE id='long-queued'`).run(Date.now() - 3_600_000);
  assert.equal((await t.post({ project: "g/p", branch: "feat" })).status, 429);
});

test("stale CLI runs are marked failed (interrupted); recent CLI and queue-owned rows are left alone", () => {
  const db = openDb(":memory:");
  const mk = (id: string, trigger: "cli" | "api", ageMin: number) => {
    insertBranchReview(db, { id, owner_id: 1, project_id: 9, project_path: "g/p", branch: "b", base: "main", merge_base: "m", head_sha: id, trigger, status: "running" });
    db.prepare(`UPDATE branch_reviews SET created_at=? WHERE id=?`).run(Date.now() - ageMin * 60_000, id);
  };
  mk("old-cli", "cli", 30); mk("new-cli", "cli", 5); mk("old-api", "api", 30);
  assert.equal(failStaleCliBranchReviews(db), 1);
  const st = Object.fromEntries((db.prepare(`SELECT id, status FROM branch_reviews`).all() as { id: string; status: string }[]).map((r) => [r.id, r.status]));
  assert.deepEqual(st, { "old-cli": "failed", "new-cli": "running", "old-api": "running" });
});

test("api: GET /api/branch-reviews limit=100 gives a next cursor when there are more; fractional limit is safe", async () => {
  const t = api();
  for (let i = 0; i < 101; i++) {
    insertBranchReview(t.db, { id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, owner_id: 1, project_id: 9, project_path: "g/p", branch: "b", base: "main", merge_base: "m", head_sha: "h", trigger: "push" });
    t.db.prepare(`UPDATE branch_reviews SET status='done', created_at=? WHERE head_sha='h' AND created_at>=? AND id LIKE ?`).run(1000 + i, 0, `%${String(i).padStart(12, "0")}`);
  }
  const h = { authorization: `Bearer ${createApiKey(t.db, 1)}` };
  const p = (await (await t.app.request("/api/branch-reviews?limit=100", { headers: h })).json()) as { items: unknown[]; next: string | null };
  assert.equal(p.items.length, 100);
  assert.ok(p.next, "101st row exists -> next");
  const q = await t.app.request("/api/branch-reviews?limit=2.5", { headers: h });
  assert.equal(q.status, 200);
  assert.equal(((await q.json()) as { items: unknown[] }).items.length, 2);
  const end = (await (await t.app.request(`/api/branch-reviews?limit=100&before=${p.next}`, { headers: h })).json()) as { items: unknown[]; next: string | null };
  assert.deepEqual([end.items.length, end.next], [1, null]);
});

test("findDoneBranchReview filters base in SQL: an older row with the right base is found behind a newer one with another base", () => {
  const db = openDb(":memory:");
  for (const [id, base, at] of [["old", "main", 1], ["new", "develop", 2]] as const) {
    insertBranchReview(db, { id, owner_id: 1, project_id: 9, project_path: "g/p", branch: "b", base, merge_base: "m", head_sha: "h", trigger: "api" });
    finishBranchReview(db, id, { verdict: "approve", findingsJson: "{}" });
    db.prepare(`UPDATE branch_reviews SET created_at=? WHERE id=?`).run(at, id);
  }
  assert.equal(findDoneBranchReview(db, 1, 9, "h")?.id, "new");
  assert.equal(findDoneBranchReview(db, 1, 9, "h", "main")?.id, "old");
  assert.equal(findDoneBranchReview(db, 1, 9, "h", "other"), undefined);
});

// --- GET /api/branch-status ---
function statusApi(opts: { attempts?: number; status?: number; settings?: string[] } = {}) {
  openMrs = 0; mrsFail = false;
  const t = api({ attempts: opts.attempts, status: opts.status });
  if (opts.settings) setUser(t.db, "caller", opts.settings);
  const key1 = createApiKey(t.db, 1);
  const get = (q: string, auth: string | null = `Bearer ${key1}`) => t.app.request(`/api/branch-status?${q}`, { headers: auth ? { authorization: auth } : {} });
  const q = "project=g/p&branch=feat";
  const json = async (qs = q) => (await (await get(qs)).json()) as { head: string; base: string; review: { id: string; status: string; trigger: string } | null; push: { opted_in: boolean; handled: boolean; due_at: number; waiting_reason?: string } | null; advice: string };
  const ins = (id: string, status: "queued" | "running" | "done" | "failed", head: string, trigger: "api" | "push" = "api", base = "main") => {
    insertBranchReview(t.db, { id, owner_id: 1, project_id: 9, project_path: "g/p", branch: "feat", base, merge_base: "m", head_sha: head, trigger });
    if (status === "done") finishBranchReview(t.db, id, { verdict: "approve", findingsJson: JSON.stringify({ findings: [1], belowThreshold: [1, 2], skipped: undefined }) });
    else if (status === "failed") finishBranchReview(t.db, id, { error: "review_failed" });
    else if (status === "running") t.db.prepare(`UPDATE branch_reviews SET status='running' WHERE id=?`).run(id);
  };
  const push = (head: string, pushedAt: number, handled: string | null = null) =>
    t.db.prepare(`INSERT OR REPLACE INTO pushed_branches (owner_id, project_id, branch, head_sha, pushed_at, handled_sha) VALUES (1,9,'feat',?,?,?)`).run(head, pushedAt, handled);
  return { ...t, key: key1, get, json, ins, push, q };
}
const OPT = ["review_pushed_branches=1", "review_all_projects=1"];

test("status: auth, validation, 404, no review and not opted in -> submit", async () => {
  const t = statusApi();
  assert.equal((await t.get(t.q, null)).status, 401);
  assert.equal((await t.get(t.q, "Bearer argus_bad")).status, 401);
  for (const [qs, err] of [["branch=feat", "invalid_project"], ["project=g/p", "invalid_branch"], ["project=g/p&branch=a..b", "invalid_branch"], ["project=g/p&branch=feat&base=-x", "invalid_base"]] as const) {
    const res = await t.get(qs);
    assert.equal(res.status, 400, qs);
    assert.equal(((await res.json()) as { error: string }).error, err);
  }
  assert.equal((await t.get("project=no/such&branch=feat")).status, 404);
  assert.equal((await t.get("project=g/p&branch=nope")).status, 404);
  assert.equal((await t.get("project=g/p&branch=feat&base=nope")).status, 404);
  const s = await t.json();
  assert.deepEqual([s.head, s.base, s.review, s.push, s.advice], [t.r.head, "main", null, null, "submit"]);
  assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM branch_reviews`).get() as { n: number }).n, 0, "read-only");
});

test("status: review of this head -> done (done and failed), running (queued/running); other head/base/owner ignored", async () => {
  const t = statusApi();
  t.ins("other-head", "done", "z".repeat(40));
  t.ins("other-base", "done", t.r.head, "api", "feat");
  assert.equal((await t.json()).advice, "submit");
  t.ins("f", "failed", t.r.head);
  assert.equal((await t.json()).advice, "done");
  t.ins("q", "queued", t.r.head);
  t.db.prepare(`UPDATE branch_reviews SET created_at=created_at+10 WHERE id='q'`).run();
  const s = await t.json();
  assert.deepEqual([s.advice, s.review?.id, s.review?.status], ["running", "q", "queued"], "newest row wins");
  t.db.prepare(`DELETE FROM branch_reviews WHERE id IN ('q','f')`).run();
  t.ins("d", "done", t.r.head, "push");
  const done = (await t.json()) as unknown as { advice: string; review: { findings_count: number; below_threshold_count: number; trigger: string } };
  assert.deepEqual([done.advice, done.review.findings_count, done.review.below_threshold_count, done.review.trigger], ["done", 1, 2, "push"]);
  assert.equal((await t.json("project=g/p&branch=feat&base=feat")).advice, "done", "explicit base selects that base's row");
  t.db.prepare(`UPDATE branch_reviews SET owner_id=2`).run();
  assert.equal((await t.json()).advice, "submit", "owner-scoped");
});

test("status: pending_push window, handled, cap, opt-in, stale head", async () => {
  const t = statusApi({ settings: OPT });
  const now = Date.now();
  const poll = loadConfig({ DATA_DIR: "x", GITLAB_URL: GL }).pollIntervalMs;
  const due = (ageMs: number) => t.push(t.r.head, now - ageMs);
  due(60_000); // pushed 1 min ago: debounce running
  let s = await t.json();
  assert.deepEqual([s.advice, s.push?.opted_in, s.push?.handled, s.push?.waiting_reason], ["pending_push", true, false, "debounce"]);
  assert.equal(s.push?.due_at, now - 60_000 + PUSH_DEBOUNCE_MS);
  due(PUSH_DEBOUNCE_MS + poll); // past due, within 2 poll cycles
  s = await t.json();
  assert.deepEqual([s.advice, s.push?.waiting_reason], ["pending_push", "awaiting_poll"]);
  due(PUSH_DEBOUNCE_MS + 2 * poll + 5_000); // poller should have acted
  assert.equal((await t.json()).advice, "submit");
  t.push(t.r.head, now - 60_000, t.r.head); // handled but no row (e.g. skipped): nothing is coming
  s = await t.json();
  assert.deepEqual([s.advice, s.push?.handled], ["submit", true]);
  t.push("z".repeat(40), now - 60_000); // push row is for another head
  assert.equal((await t.json()).advice, "submit");
  due(60_000);
  for (let i = 0; i < 20; i++) t.ins(`c${i}`, "done", `h${i}`, "push"); // cap 20 exhausted (rows for other heads)
  s = await t.json();
  assert.deepEqual([s.advice, s.push?.waiting_reason], ["submit", undefined]);
  t.db.prepare(`DELETE FROM branch_reviews`).run();
  setUser(t.db, "caller", ["review_pushed_branches=0"]);
  s = await t.json();
  assert.deepEqual([s.advice, s.push], ["submit", null], "not opted in: push row ignored");
});

test("status: pending_push only when the poller would take it (default branch, open MR, base, project list)", async () => {
  const t = statusApi({ settings: OPT });
  const now = Date.now();
  t.push(t.r.head, now - 60_000);
  assert.equal((await t.json()).advice, "pending_push");
  openMrs = 1;
  let s = await t.json();
  assert.deepEqual([s.advice, s.push?.waiting_reason], ["submit", undefined], "open MR: the normal MR review owns it");
  openMrs = 0;
  assert.equal((await t.json("project=g/p&branch=feat&base=feat")).advice, "submit", "base is not the default branch");
  setUser(t.db, "caller", ["review_all_projects=0", "review_projects=other/proj"]);
  assert.equal((await t.json()).advice, "submit", "project not in the review list");
  setUser(t.db, "caller", ["review_all_projects=1"]);
  t.db.prepare(`UPDATE pushed_branches SET branch='main', head_sha=?`).run(t.r.rev("main"));
  assert.equal((await t.json("project=g/p&branch=main")).advice, "submit", "default branch is never push-reviewed");
});

test("status: MR lookup failure, missing skill or engine -> submit (never 500, never wait forever)", async () => {
  const t = statusApi({ settings: OPT });
  t.push(t.r.head, Date.now() - 60_000);
  assert.equal((await t.json()).advice, "pending_push");
  mrsFail = true;
  const res = await t.get(t.q);
  assert.equal(res.status, 200);
  const s = (await res.json()) as { advice: string; push: { waiting_reason?: string } };
  assert.deepEqual([s.advice, s.push.waiting_reason], ["submit", undefined]);
  mrsFail = false;
  const u = getUser(t.db, "caller")!;
  const rt = mkRt(t.r, []);
  const tgt = { projectId: 9, projectPath: "g/p", defaultBranch: "main", branch: "feat", base: "main", head: t.r.head };
  assert.equal((await branchStatus(t.db, loadConfig({ DATA_DIR: "x", GITLAB_URL: GL }), u, rt, tgt)).advice, "pending_push");
  assert.equal((await branchStatus(t.db, loadConfig({ DATA_DIR: "x", GITLAB_URL: GL }), { ...u, skillPath: null as unknown as string }, rt, tgt)).advice, "submit", "no skill");
  assert.equal((await branchStatus(t.db, loadConfig({ DATA_DIR: "x", GITLAB_URL: GL }), u, { ...rt, engine: undefined }, tgt)).advice, "submit", "no engine");
});

test("status: only project + head (+ explicit base) are looked up; no merge-base", async () => {
  const t = statusApi();
  const calls: string[] = [];
  const r = t.r;
  const rt = mkRt(r, [], calls);
  const app = createApp({ cfg: loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "t-")), GITLAB_URL: GL }), db: t.db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor: async () => rt, queue: new ReviewQueue() });
  const res = await app.request("/api/branch-status?project=g/p&branch=feat", { headers: { authorization: `Bearer ${t.key}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["project g/p", "branch feat"]);
  calls.length = 0;
  await app.request("/api/branch-status?project=g/p&branch=feat&base=main", { headers: { authorization: `Bearer ${t.key}` } });
  assert.deepEqual(calls, ["project g/p", "branch feat", "branch main"]);
});

test("status: has its own limiter (429 + Retry-After) and never uses up the POST attempt limiter", async () => {
  const t = statusApi({ attempts: 2, status: 2 });
  assert.equal((await t.get(t.q)).status, 200);
  assert.equal((await t.get(t.q)).status, 200);
  const third = await t.get(t.q);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("retry-after"), "3600");
  const post = await t.app.request("/api/review-branch", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` }, body: JSON.stringify({ project: "g/p", branch: "feat" }) });
  assert.equal(post.status, 202, "status polling did not consume the submit budget");
  await t.queue.idle();
});

test("storedSummary tolerates a corrupt findings_json (status and list do not 500)", async () => {
  const t = statusApi();
  t.ins("bad", "done", t.r.head);
  t.db.prepare(`UPDATE branch_reviews SET findings_json='{not json'`).run();
  const s = (await t.json()) as unknown as { advice: string; review: { findings_count: number | null } };
  assert.deepEqual([s.advice, s.review.findings_count], ["done", null]);
  assert.equal((await t.app.request("/api/branch-reviews", { headers: { authorization: `Bearer ${t.key}` } })).status, 200);
});

// --- skillFrom: another user's skill + thresholds, the caller's engine/credentials ---
const rvwSkillDir = mkdtempSync(join(tmpdir(), "skill-reviewer-"));
writeFileSync(join(rvwSkillDir, "SKILL.md"), "REVIEWER-CRITERIA");
const rvwSkill = join(rvwSkillDir, "SKILL.md");
/** Adds reviewer1 (id 294, own engine settings and thresholds that differ from the caller's) and nobody (no usable skill). */
function addReviewer(db: ReturnType<typeof openDb>) {
  addUser(db, key, { gitlabUserId: 294, username: "reviewer1", token: "reviewer-pat", tokenExpiresAt: null, skillPath: rvwSkill, isOwner: false });
  setUser(db, "reviewer1", ["severity_threshold=nit", "confidence_threshold=0.5", "engine=codex-cli", "language=en"]);
  addUser(db, key, { gitlabUserId: 3, username: "noskill", token: "p", tokenExpiresAt: null, skillPath, isOwner: false });
  db.prepare(`UPDATE users SET skill_path='' WHERE username='noskill'`).run();
}

test("ARGUS_SKILL_FROM: default on, off/OFF off, unknown fails closed", () => {
  const c = (v?: string) => loadConfig({ DATA_DIR: "x", ...(v === undefined ? {} : { ARGUS_SKILL_FROM: v }) }).skillFrom;
  const warn = console.warn; console.warn = () => {};
  try {
    assert.deepEqual([c(), c(""), c("on"), c("ON"), c("off"), c(" Off "), c("bogus")], [true, true, true, true, false, false, false]);
  } finally { console.warn = warn; }
});

test("criteriaFor: swaps only the skill and thresholds; errors for unknown user, no skill, disabled, bad name; self = own", () => {
  const { cfg, db, user } = setup();
  addReviewer(db);
  setUser(db, "caller", ["language=ja", "max_diff_lines=500"]);
  const caller = getUser(db, "caller")!;
  assert.deepEqual(criteriaFor(cfg, db, caller, undefined), { user: caller });
  const { user: u, skillFrom } = criteriaFor(cfg, db, caller, "reviewer1");
  assert.equal(skillFrom, "reviewer1");
  assert.deepEqual([u.skillPath, u.severityThreshold, u.confidenceThreshold], [rvwSkill, "nit", 0.5], "the reviewer's criteria");
  assert.deepEqual({ ...u, skillPath: caller.skillPath, severityThreshold: caller.severityThreshold, confidenceThreshold: caller.confidenceThreshold }, caller, "everything else is the caller's (id, tokens, engine, model, language, limits)");
  assert.deepEqual(criteriaFor(cfg, db, caller, "caller"), { user: caller }, "naming yourself = your own skill");
  assert.throws(() => criteriaFor(cfg, db, caller, "ghost"), { status: 404, code: "unknown_user" });
  assert.equal(criteriaFor(cfg, db, caller, "Reviewer1").skillFrom, "reviewer1", "GitLab usernames are case-insensitive");
  db.prepare(`UPDATE users SET enabled=0 WHERE username='reviewer1'`).run();
  assert.throws(() => criteriaFor(cfg, db, caller, "reviewer1"), { status: 404, code: "unknown_user" }, "disabled user: never borrowed");
  db.prepare(`UPDATE users SET enabled=1, approved=0 WHERE username='reviewer1'`).run();
  assert.throws(() => criteriaFor(cfg, db, caller, "reviewer1"), { status: 404, code: "unknown_user" }, "pending sign-up: never borrowed");
  db.prepare(`UPDATE users SET approved=1 WHERE username='reviewer1'`).run();
  assert.throws(() => criteriaFor(cfg, db, caller, "noskill"), { status: 400, code: "no_skill" });
  assert.throws(() => criteriaFor(cfg, db, caller, "a b"), { status: 400, code: "invalid_skill_from" });
  assert.throws(() => criteriaFor({ ...cfg, skillFrom: false }, db, caller, "reviewer1"), { status: 403, code: "skill_from_disabled" });
  void user;
});

/** App whose runtimeFor records who it is built for (the engine echoes the skill file it would load). */
function skillFromApi(env: Record<string, string> = {}) {
  const r = repo();
  const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "t-")), GITLAB_URL: GL, ...env });
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "caller", token: "pat", tokenExpiresAt: null, skillPath, isOwner: false });
  addReviewer(db);
  const built: User[] = [];
  const skills: string[] = [];
  const runtimeFor = async (u: User): Promise<UserRuntime> => {
    built.push(u);
    const rt = mkRt(r, []);
    return { ...rt, engine: { review: async (i) => (skills.push(readFileSync(u.skillPath, "utf8")), rt.engine!.review(i)) } as ReviewEngine };
  };
  const queue = new ReviewQueue();
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor, queue });
  const h = { authorization: `Bearer ${createApiKey(db, 1)}`, "content-type": "application/json" };
  const post = (body: unknown) => app.request("/api/review-branch", { method: "POST", headers: h, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: h });
  return { r, cfg, db, app, queue, built, skills, post, get };
}

test("api skillFrom: caller's runtime with the reviewer's skill + thresholds; recorded on the row and shown in the result", async () => {
  const t = skillFromApi();
  const res = await t.post({ project: "g/p", branch: "feat", skillFrom: "reviewer1" });
  assert.equal(res.status, 202);
  const { id, skill_from } = (await res.json()) as { id: string; skill_from: string };
  assert.equal(skill_from, "reviewer1");
  await t.queue.idle();
  assert.ok(t.built.length > 0);
  for (const u of t.built) {
    assert.equal(u.gitlabUserId, 1, "runtime (GitLab token, Claude token, engine) is only ever built for the caller");
    assert.equal(u.engine, "claude-cli", "caller's engine, not the reviewer's codex-cli");
    assert.equal(u.language, "zh-TW", "caller's language");
  }
  assert.deepEqual(t.skills, ["REVIEWER-CRITERIA"], "the engine loads the reviewer's skill");
  const done = (await (await t.get(`/api/review-branch/${id}`)).json()) as { status: string; skill_from: string; findings: { severity: string }[]; below_threshold: unknown[] };
  assert.equal(done.status, "done");
  assert.equal(done.skill_from, "reviewer1");
  assert.deepEqual(done.findings.map((f) => f.severity), ["major", "nit"], "the reviewer's nit threshold: the nit is blocking too");
  assert.equal(done.below_threshold.length, 0);
  const row = t.db.prepare(`SELECT skill_from, owner_id FROM branch_reviews WHERE id=?`).get(id) as { skill_from: string; owner_id: number };
  assert.deepEqual(row, { skill_from: "reviewer1", owner_id: 1 }, "owned by the caller");
  const list = (await (await t.get("/api/branch-reviews")).json()) as { items: { skill_from: string | null }[] };
  assert.equal(list.items[0]!.skill_from, "reviewer1");
  // without skillFrom: own skill, own thresholds, skill_from null
  const own = (await (await t.post({ project: "g/p", branch: "feat" })).json()) as { id: string; skill_from: string | null };
  assert.notEqual(own.id, id, "a review with own criteria is a new job, not the borrowed one");
  assert.equal(own.skill_from, null);
  await t.queue.idle();
  const ownDone = (await (await t.get(`/api/review-branch/${own.id}`)).json()) as { findings: unknown[]; skill_from: string | null };
  assert.deepEqual([ownDone.findings.length, ownDone.skill_from], [1, null]);
});

test("api skillFrom: unknown_user 404, no_skill 400, non-string 400, disabled 403; nothing queued or charged", async () => {
  const t = skillFromApi();
  for (const [skillFrom, status, error] of [["ghost", 404, "unknown_user"], ["noskill", 400, "no_skill"], [5, 400, "invalid_skill_from"], ["a;b", 400, "invalid_skill_from"]] as const) {
    const res = await t.post({ project: "g/p", branch: "feat", skillFrom });
    assert.equal(res.status, status, String(skillFrom));
    assert.equal(((await res.json()) as { error: string }).error, error);
  }
  const off = skillFromApi({ ARGUS_SKILL_FROM: "off" });
  const res = await off.post({ project: "g/p", branch: "feat", skillFrom: "reviewer1" });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "skill_from_disabled");
  assert.equal((await off.get("/api/branch-status?project=g/p&branch=feat&skill_from=reviewer1")).status, 403);
  assert.equal((await off.post({ project: "g/p", branch: "feat" })).status, 202, "own-skill reviews are unaffected");
  await off.queue.idle();
  for (const x of [t, off]) assert.equal((x.db.prepare(`SELECT COUNT(*) n FROM branch_reviews WHERE skill_from IS NOT NULL`).get() as { n: number }).n, 0);
});

test("dedupe: borrowed and own reviews of the same head never stand in for each other (active job, queue key, branch-status)", async () => {
  const t = skillFromApi();
  const own = (await (await t.post({ project: "g/p", branch: "feat" })).json()) as { id: string };
  const borrowed = await t.post({ project: "g/p", branch: "feat", skillFrom: "reviewer1" });
  assert.equal(borrowed.status, 429, "the active own-skill job is not handed back for a borrowed request (one active job per user still applies)");
  assert.deepEqual(await borrowed.json(), { error: "too_many_active", active_id: own.id });
  assert.equal(((await (await t.post({ project: "g/p", branch: "feat" })).json()) as { id: string }).id, own.id, "same criteria: handed back");
  await t.queue.idle();
  assert.notEqual(branchQueueKey(1, 9, "h", "m"), branchQueueKey(1, 9, "h", "m", "reviewer1"));
  const status = async (q: string) => (await (await t.get(`/api/branch-status?project=g/p&branch=feat${q}`)).json()) as { advice: string; skill_from: string | null; review: { id: string; skill_from: string | null } | null };
  assert.deepEqual([(await status("")).advice, (await status("")).review?.id], ["done", own.id]);
  const b = await status("&skill_from=reviewer1");
  assert.deepEqual([b.advice, b.review, b.skill_from], ["submit", null, "reviewer1"], "own review does not count for the reviewer's criteria");
  const bj = (await (await t.post({ project: "g/p", branch: "feat", skillFrom: "reviewer1" })).json()) as { id: string };
  await t.queue.idle();
  const b2 = await status("&skill_from=reviewer1");
  assert.deepEqual([b2.advice, b2.review?.id, b2.review?.skill_from], ["done", bj.id, "reviewer1"]);
  t.db.prepare(`DELETE FROM branch_reviews WHERE id=?`).run(own.id);
  assert.equal((await status("")).advice, "submit", "and the borrowed one does not count for own criteria");
  assert.equal((await status("&skill_from=caller")).review, null, "naming yourself = own criteria");
  assert.equal((await t.get("/api/branch-status?project=g/p&branch=feat&skill_from=ghost")).status, 404);
});

test("status: skill_from never reports pending_push (the push trigger only reviews with the owner's own skill)", async () => {
  const t = statusApi({ settings: OPT });
  addReviewer(t.db);
  t.push(t.r.head, Date.now() - 60_000);
  assert.equal((await t.json()).advice, "pending_push");
  assert.equal((await t.json(`${t.q}&skill_from=reviewer1`)).advice, "submit");
});

test("branchReviewTitle: lower-case ticket keys in the branch name are appended in upper case; versions are not keys", async () => {
  assert.equal(branchReviewTitle("fix/proj-720-payload-no-tests", "main"), "Branch fix/proj-720-payload-no-tests (pre-MR review against main) [PROJ-720]");
  assert.equal(branchReviewTitle("docs/PROJ-7-x", "main"), "Branch docs/PROJ-7-x (pre-MR review against main) [PROJ-7]");
  assert.equal(branchReviewTitle("docs/version-history-0.13.5", "main"), "Branch docs/version-history-0.13.5 (pre-MR review against main)");
  assert.equal(branchReviewTitle("feat/skill-from", "main"), "Branch feat/skill-from (pre-MR review against main)");
  // only at the start of a path segment: ordinary words further in are not keys
  for (const b of ["feat/upgrade-node-22", "chore/bump-python3-12", "fix/retry-step-2"]) assert.equal(branchReviewTitle(b, "main"), `Branch ${b} (pre-MR review against main)`, b);
  assert.equal(branchReviewTitle("feature/proj-720_add-tests", "main"), "Branch feature/proj-720_add-tests (pre-MR review against main) [PROJ-720]", "_ may follow the key");
  // known limit: a key-shaped segment start is taken (it cannot be told apart from a ticket key); Jira just finds no such issue
  assert.equal(branchReviewTitle("fix/api-2-timeout", "main"), "Branch fix/api-2-timeout (pre-MR review against main) [API-2]");
  assert.equal(branchReviewTitle("proj-5-x", "main"), "Branch proj-5-x (pre-MR review against main) [PROJ-5]", "bare branch");
  assert.deepEqual(extractIssueKeys(branchReviewTitle("fix/proj-720-a/proj-721-b", "main")), ["PROJ-720", "PROJ-721"], "what fetchRequirements sees");
  // end to end: the requirements lookup gets a title from which the ticket key is extracted
  const r = repo();
  const { cfg, user } = setup();
  const titles: string[] = [];
  const rt = { ...mkRt(r, []), requirements: async (_c: unknown, title: string) => (titles.push(title), undefined) } as UserRuntime;
  // the SHAs come from "feat"; only the branch name in the target carries the key
  await runBranchReview(cfg, user, rt, { project: "g/p", branch: "fix/proj-9-x" }, await resolveBranch(rt, { project: "g/p", branch: "feat" }));
  assert.equal(titles.length, 1);
  assert.deepEqual(extractIssueKeys(titles[0]!), ["PROJ-9"]);
});
