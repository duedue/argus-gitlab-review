import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey } from "../src/apikeys.ts";
import { loadConfig } from "../src/config.ts";
import { BRANCH_REVIEW_RETENTION_MS, finishBranchReview, insertBranchReview, openDb, pruneBranchReviews } from "../src/db.ts";
import type { Finding } from "../src/findings.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { reviewMr, type UserRuntime } from "../src/review.ts";
import { addUser, getUser, setUser } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";
import { ReviewQueue } from "../src/queue.ts";

const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");
const HEAD = "a".repeat(40);
const f = (o: Partial<Finding> = {}): Finding => ({ severity: "major", file: "a.ts", line: 3, title: "t", body: "B", confidence: 0.9, ...o });

function setup(o: { authorId?: number; target?: string } = {}) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: true });
  setUser(db, "alice", ["auto_approve=1"]);
  const user = getUser(db, "alice")!;
  const calls: string[] = [];
  const notes: string[] = [];
  let engineRuns = 0;
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
    prepare: async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false }),
  };
  const cfg = { ...loadConfig({}), dryRun: false };
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
  return { db, calls, notes, stored, review, engineRuns: () => engineRuns, rows: () => db.prepare(`SELECT head_sha, status FROM reviews ORDER BY id`).all() as { head_sha: string; status: string }[] };
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
