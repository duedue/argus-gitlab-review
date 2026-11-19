import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey } from "../src/apikeys.ts";
import { branchQueueKey, getBranchJob, resolveBranch, runBranchReview, validBranchName, validProjectRef } from "../src/branchreview.ts";
import { loadConfig } from "../src/config.ts";
import { activeBranchReview, claimReview, findDoneBranchReview, finishBranchReview, insertBranchReview, listBranchReviews, openDb, releaseStaleRunning, type BranchReviewRow } from "../src/db.ts";
import type { ReviewEngine, ReviewInput } from "../src/engine.ts";
import type { GitLab } from "../src/gitlab.ts";
import { ReviewQueue } from "../src/queue.ts";
import type { UserRuntime } from "../src/review.ts";
import { addUser, getUser, type User } from "../src/users.ts";
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

const forbidden = () => assert.fail("a branch review must not write to GitLab");
function fakeGl(r: ReturnType<typeof repo>, calls: string[] = []) {
  return {
    getProject: async (id: number | string) => { calls.push(`project ${id}`); if (id === "no/such") throw Object.assign(new Error("nf"), { status: 404 }); return { id: 9, http_url_to_repo: r.url, path_with_namespace: "g/p", default_branch: "main" }; },
    getBranchSha: async (_: number, b: string) => { calls.push(`branch ${b}`); if (b === "nope") throw Object.assign(new Error("nf"), { status: 404 }); return r.rev(b); },
    getMergeBase: async (_: number, a: string, b: string) => { calls.push("merge-base"); return r.mergeBase(a, b); },
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

function api(opts: { limit?: number; attempts?: number } = {}) {
  const r = repo();
  const { cfg, db } = setup();
  const seen: ReviewInput[] = [];
  const queue = new ReviewQueue();
  const runtimeFor = async (_u: User) => ({ ...mkRt(r, seen) });
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor, queue, triggerLimitPerHour: opts.limit, branchAttemptsPerHour: opts.attempts });
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
    db.prepare(`UPDATE branch_reviews SET created_at=?, status=? WHERE id=?`).run(at, status, id);
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
