import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneFor } from "../src/engine.ts";
import { loadConfig } from "../src/config.ts";
import { insertBranchReview, oldestUnattachedBranchReviewAt, openDb } from "../src/db.ts";
import type { GitLab, PushEvent } from "../src/gitlab.ts";
import Database from "better-sqlite3";
import { pollOnce } from "../src/review.ts";
import { PUSH_DEBOUNCE_MS, pollPushedBranches } from "../src/pushreview.ts";
import { ReviewQueue } from "../src/queue.ts";
import type { UserRuntime } from "../src/review.ts";
import { addUser, engineFields, getUser, setUser } from "../src/users.ts";

const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");
const NOW = Date.parse("2026-11-06T12:00:00Z");
const ev = (branch: string, sha: string, minsAgo: number, over: Partial<PushEvent["push_data"]> = {}, project = 9): PushEvent => ({
  project_id: project, created_at: new Date(NOW - minsAgo * 60_000).toISOString(), push_data: { ref: branch, ref_type: "branch", action: "pushed", commit_to: sha, ...over },
});

function setup(o: { projectFail?: () => Error | undefined; settings?: string[]; events?: PushEvent[]; mrs?: Record<string, number>; path?: string; tips?: Record<string, string>; engineHold?: boolean } = {}) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: false });
  setUser(db, "alice", o.settings ?? ["review_pushed_branches=1", "review_all_projects=1"]);
  const u = getUser(db, "alice")!;
  let events = o.events ?? [];
  const tips: Record<string, string> = { main: "9".repeat(40), ...o.tips };
  const calls: string[] = [];
  const gl = {
    listPushEvents: async () => (calls.push("events"), events),
    getProject: async (id: number | string) => { const err = o.projectFail?.(); if (err) throw err; return { id: Number(id), http_url_to_repo: "x", path_with_namespace: o.path ?? "g/p", default_branch: "main" }; },
    listBranchMrs: async (_p: number, b: string) => Array.from({ length: o.mrs?.[b] ?? 0 }, (_, i) => ({ iid: i + 1 })),
    getBranchSha: async (_p: number, b: string) => { if (!(b in tips)) throw Object.assign(new Error("nf"), { status: 404 }); return tips[b]!; },
    getMergeBase: async () => "m".repeat(40),
  } as unknown as GitLab;
  let engineRuns = 0;
  const rt: UserRuntime = {
    token: async () => "t", gl,
    engine: { review: async () => (engineRuns++, { findings: [], resolved: [], verdict: "approve" as const }) },
    prepare: async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false }),
    requirements: async () => undefined,
  };
  const queue = new ReviewQueue();
  const deps = { cfg: loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "t-")), GITLAB_URL: "https://gl.test" }), db, queue, runtimeFor: async () => rt };
  const poll = async (now = NOW, user = u) => { const l = console.log; console.log = () => {}; try { await pollPushedBranches(deps, user, rt, now); await queue.idle(); } finally { console.log = l; } };
  const rows = () => db.prepare(`SELECT branch, head_sha, trigger, status FROM branch_reviews ORDER BY created_at, id`).all() as { branch: string; head_sha: string; trigger: string; status: string }[];
  return { db, u, deps, rt, queue, poll, rows, calls, engineRuns: () => engineRuns, setEvents: (e: PushEvent[]) => (events = e), tips };
}
const S = "s".repeat(40);

test("push: reviewed after the debounce, stored with trigger=push, nothing else", async () => {
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  await t.poll();
  assert.deepEqual(t.rows().map((r) => [r.branch, r.head_sha, r.trigger, r.status]), [["feat", S, "push", "done"]]);
  assert.equal(t.engineRuns(), 1);
});

test("push: debounce - a push within 5 minutes waits; a newer push resets the clock", async () => {
  const t = setup({ events: [ev("feat", S, 4)], tips: { feat: S } });
  await t.poll();
  assert.equal(t.rows().length, 0, "4 min: too early");
  const T2 = "t".repeat(40);
  t.setEvents([ev("feat", T2, 1)]); // a new push arrived 1 min before NOW; the old head is superseded
  t.tips.feat = T2;
  await t.poll(NOW + 60_000);
  assert.equal(t.rows().length, 0, "new head resets the debounce");
  await t.poll(NOW + 4 * 60_000 + 1000);
  assert.deepEqual(t.rows().map((r) => r.head_sha), [T2], "reviewed once 5 min passed since the last push; the old head never was");
});

test("push: after the quiet period the newest head is the one reviewed (not the intermediate pushes)", async () => {
  const T2 = "t".repeat(40);
  const t = setup({ events: [ev("feat", T2, 6), ev("feat", S, 20)], tips: { feat: T2 } });
  await t.poll();
  assert.deepEqual(t.rows().map((r) => r.head_sha), [T2]);
});

test("push: skips default branch, branches with an open MR, deleted/removed branches, tags, moved tip", async () => {
  const t = setup({
    events: [ev("main", S, 10), ev("hasmr", S, 10), ev("gone", S, 10), ev("rm", S, 10, { action: "removed" }), ev("v1", S, 10, { ref_type: "tag" }), ev("moved", S, 10)],
    mrs: { hasmr: 1 }, tips: { hasmr: S, main: S, moved: "z".repeat(40) },
  });
  for (let i = 0; i < 6; i++) await t.poll();
  assert.equal(t.rows().length, 0);
  assert.equal(t.engineRuns(), 0);
});

test("push: project allowlist - outside the list is skipped, inside is reviewed", async () => {
  const out = setup({ settings: ["review_pushed_branches=1", "review_all_projects=0", "review_projects=other/team"], events: [ev("feat", S, 10)], tips: { feat: S } });
  await out.poll();
  assert.equal(out.rows().length, 0);
  const inn = setup({ settings: ["review_pushed_branches=1", "review_all_projects=0", "review_projects=g"], events: [ev("feat", S, 10)], tips: { feat: S } });
  await inn.poll();
  assert.equal(inn.rows().length, 1);
  const none = setup({ settings: ["review_pushed_branches=1", "review_all_projects=0"], events: [ev("feat", S, 10)], tips: { feat: S } }); // strict: empty list = nothing
  await none.poll();
  assert.equal(none.rows().length, 0);
});

test("push: dedupe by (owner, project, head) against branch_reviews, any trigger; same head is never reviewed twice", async () => {
  const t = setup({ events: [ev("feat", S, 10), ev("other", S, 10)], tips: { feat: S, other: S } });
  insertBranchReview(t.db, { id: "api-run", owner_id: 1, project_id: 9, project_path: "g/p", branch: "feat", base: "main", merge_base: "m", head_sha: S, trigger: "api" });
  await t.poll(); // feat deduped by the API run (handled), then...
  await t.poll(); // ...other has the same sha in the same project: deduped too
  assert.equal(t.rows().length, 1, "only the pre-existing api row");
  const t2 = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  await t2.poll();
  await t2.poll();
  await t2.poll();
  assert.equal(t2.rows().length, 1);
});

test("push: opt-in off or cap 0 = nothing, not even a GitLab call", async () => {
  const off = setup({ settings: ["review_all_projects=1"], events: [ev("feat", S, 10)], tips: { feat: S } });
  await off.poll();
  assert.deepEqual([off.rows().length, off.calls.length], [0, 0]);
  const zero = setup({ settings: ["review_pushed_branches=1", "review_all_projects=1", "branch_daily_cap=0"], events: [ev("feat", S, 10)], tips: { feat: S } });
  await zero.poll();
  assert.deepEqual([zero.rows().length, zero.calls.length], [0, 0]);
});

test("push: daily cap counts push-triggered reviews in the last 24h; waits, then proceeds when the window frees", async () => {
  const t = setup({ settings: ["review_pushed_branches=1", "review_all_projects=1", "branch_daily_cap=2"], events: [ev("a", S, 10), ev("b", "b".repeat(40), 10), ev("c", "c".repeat(40), 10)], tips: { a: S, b: "b".repeat(40), c: "c".repeat(40) } });
  for (let i = 0; i < 5; i++) await t.poll();
  assert.equal(t.rows().length, 2, "cap 2 reached");
  // api-triggered reviews do not count towards the push cap
  insertBranchReview(t.db, { id: "api2", owner_id: 1, project_id: 9, project_path: "g/p", branch: "z", base: "main", merge_base: "m", head_sha: "z".repeat(40), trigger: "api" });
  t.db.prepare(`UPDATE branch_reviews SET status='done'`).run();
  await t.poll();
  assert.equal(t.rows().filter((r) => r.trigger === "push").length, 2);
  t.db.prepare(`UPDATE branch_reviews SET created_at=? WHERE trigger='push'`).run(NOW - 25 * 3_600_000); // rows are stamped with the real clock; poll() uses NOW
  await t.poll();
  assert.equal(t.rows().filter((r) => r.trigger === "push").length, 3, "window freed");
});

test("push: busy user (an active branch review) is retried next cycle, not dropped", async () => {
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  insertBranchReview(t.db, { id: "busy", owner_id: 1, project_id: 9, project_path: "g/p", branch: "x", base: "main", merge_base: "m", head_sha: "x".repeat(40), trigger: "api" });
  await t.poll();
  assert.equal(t.rows().filter((r) => r.trigger === "push").length, 0);
  t.db.prepare(`UPDATE branch_reviews SET status='done' WHERE id='busy'`).run();
  await t.poll();
  assert.equal(t.rows().filter((r) => r.trigger === "push").length, 1);
});

test("review_pushed_branches setting: 0/1 only, default off", () => {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: false });
  assert.equal(getUser(db, "alice")!.reviewPushedBranches, false);
  setUser(db, "alice", ["review_pushed_branches=1"]);
  assert.equal(getUser(db, "alice")!.reviewPushedBranches, true);
  assert.throws(() => setUser(db, "alice", ["review_pushed_branches=2"]), /review_pushed_branches/);
});

test("push: lane busy (someone's MR review queued/running) -> wait, then proceed; never queued behind MR work", async () => {
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  let release!: () => void;
  t.queue.enqueue(laneFor(engineFields(t.u), t.deps.cfg.ownerEngineTestUsers), "mr-review", () => new Promise<void>((r) => (release = r)));
  await pollPushedBranches(t.deps, t.u, t.rt, NOW); // not t.poll(): that waits for the (blocked) queue to go idle
  assert.equal(t.rows().length, 0);
  assert.equal(t.queue.laneBusy(laneFor(engineFields(t.u), t.deps.cfg.ownerEngineTestUsers)), true);
  release();
  await t.queue.idle();
  await t.poll();
  assert.equal(t.rows().length, 1);
});

test("push: transient failures retry (3 attempts then give up with a log line); definitive ones drop at once", async () => {
  let fail: Error | undefined = Object.assign(new Error("502 bad gateway"), { status: 502 });
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S }, projectFail: () => fail });
  await t.poll(); await t.poll();
  fail = undefined;
  await t.poll();
  assert.equal(t.rows().length, 1, "2 transient failures then success: still reviewed");

  fail = Object.assign(new Error("502"), { status: 502 });
  const g = setup({ events: [ev("feat", S, 10)], tips: { feat: S }, projectFail: () => fail });
  const logs: string[] = [];
  const l = console.log; console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try { for (let i = 0; i < 3; i++) await pollPushedBranches(g.deps, g.u, g.rt, NOW); } finally { console.log = l; }
  assert.ok(logs.some((x) => /gave up after 3 attempts/.test(x)));
  fail = undefined;
  await g.poll();
  assert.equal(g.rows().length, 0, "given up: handled");

  const nf = setup({ events: [ev("feat", S, 10)], tips: { feat: S }, projectFail: () => Object.assign(new Error("nf"), { status: 404 }) });
  await nf.poll();
  assert.equal((nf.db.prepare(`SELECT handled_sha FROM pushed_branches`).get() as { handled_sha: string }).handled_sha, S, "404 is definitive");
});

test("push: a changed head resets the attempt counter", async () => {
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S }, projectFail: () => Object.assign(new Error("x"), { status: 500 }) });
  await t.poll(); await t.poll();
  const T2 = "t".repeat(40);
  t.setEvents([ev("feat", T2, 9)]);
  await t.poll();
  assert.equal((t.db.prepare(`SELECT attempts FROM pushed_branches`).get() as { attempts: number }).attempts, 1);
});

test("push: a stuck CLI 'running' row does not block the push trigger", async () => {
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  insertBranchReview(t.db, { id: "cli-stuck", owner_id: 1, project_id: 9, project_path: "g/p", branch: "x", base: "main", merge_base: "m", head_sha: "x".repeat(40), trigger: "cli", status: "running" });
  await t.poll();
  assert.equal(t.rows().filter((r) => r.trigger === "push").length, 1);
});

test("push: config problems (401) wait without using attempts and log once; the head is reviewed once fixed", async () => {
  let fail: Error | undefined = Object.assign(new Error("401 Unauthorized"), { status: 401 });
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S }, projectFail: () => fail });
  const logs: string[] = [];
  const l = console.log; console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try { for (let i = 0; i < 5; i++) await pollPushedBranches(t.deps, t.u, t.rt, NOW); } finally { console.log = l; }
  assert.equal((t.db.prepare(`SELECT attempts FROM pushed_branches`).get() as { attempts: number }).attempts, 0);
  assert.equal(logs.filter((x) => /waiting/.test(x)).length, 1, "logged once");
  fail = undefined;
  await t.poll();
  assert.equal(t.rows().length, 1);
});

test("push: a 401 on a GitLab lookup ends the cycle instead of trying every due branch", async () => {
  let calls = 0;
  const t = setup({ events: [ev("feat", S, 10), ev("feat2", S, 10)], tips: { feat: S, feat2: S }, projectFail: () => { calls++; return Object.assign(new Error("401 Unauthorized"), { status: 401 }); } });
  const l = console.log; console.log = () => {};
  try { await pollPushedBranches(t.deps, t.u, t.rt, NOW); } finally { console.log = l; }
  assert.equal(calls, 1, "stopped after the first 401");
  assert.equal(t.rows().length, 0);
});

test("push: dedupe includes the base: a manual review of this head against another base does not block the default-base push review", async () => {
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  insertBranchReview(t.db, { id: "manual", owner_id: 1, project_id: 9, project_path: "g/p", branch: "feat", base: "develop", merge_base: "m", head_sha: S, trigger: "api" });
  t.db.prepare(`UPDATE branch_reviews SET status='done'`).run();
  await t.poll();
  assert.deepEqual(t.rows().filter((r) => r.trigger === "push").length, 1);
  const same = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  insertBranchReview(same.db, { id: "manual2", owner_id: 1, project_id: 9, project_path: "g/p", branch: "feat", base: "main", merge_base: "m", head_sha: S, trigger: "api" });
  same.db.prepare(`UPDATE branch_reviews SET status='done'`).run();
  await same.poll();
  assert.equal(same.rows().filter((r) => r.trigger === "push").length, 0, "same base still dedupes");
});

test("push: dedupe ignores a review with another user's skill (borrowed criteria never stand in for the owner's own)", async () => {
  const t = setup({ events: [ev("feat", S, 10)], tips: { feat: S } });
  insertBranchReview(t.db, { id: "borrowed", owner_id: 1, project_id: 9, project_path: "g/p", branch: "feat", base: "main", merge_base: "m", head_sha: S, trigger: "api", skill_from: "reviewer1" });
  t.db.prepare(`UPDATE branch_reviews SET status='done'`).run();
  await t.poll();
  assert.equal(t.rows().filter((r) => r.trigger === "push").length, 1);
  assert.equal((t.db.prepare(`SELECT skill_from s FROM branch_reviews WHERE trigger='push'`).get() as { s: string | null }).s, null, "the push trigger uses the owner's own skill");
});

test("pollOnce wires the push trigger: opted-in user gets a trigger='push' branch review after the debounce; opted-out gets none", async () => {
  for (const [optIn, want] of [[true, 1], [false, 0]] as const) {
    const t = setup({ settings: [`review_pushed_branches=${optIn ? 1 : 0}`, "review_all_projects=1"], events: [{ ...ev("feat", S, 0), created_at: new Date(Date.now() - 10 * 60_000).toISOString() }], tips: { feat: S } });
    const gl = { ...(t.rt.gl as object), listReviewMrs: async () => [], listAssignedMrs: async () => [], listNotes: async () => [] } as unknown as GitLab;
    const l = console.log; console.log = () => {};
    try { await pollOnce(t.deps.cfg, t.db, [getUser(t.db, "alice")!], () => ({ ...t.rt, gl }), t.queue); await t.queue.idle(); } finally { console.log = l; }
    assert.equal(t.rows().filter((r) => r.trigger === "push").length, want, `opt-in ${optIn}`);
  }
});

test("migration: a dev DB with pushed_branches from the earlier revision (no attempts column) opens and works", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mig-")), "t.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE pushed_branches (owner_id INTEGER NOT NULL, project_id INTEGER NOT NULL, branch TEXT NOT NULL, head_sha TEXT NOT NULL, pushed_at INTEGER NOT NULL, handled_sha TEXT, PRIMARY KEY (owner_id, project_id, branch));
    INSERT INTO pushed_branches VALUES (1, 9, 'b', 'h', 1, NULL);`);
  old.close();
  const db = openDb(path);
  assert.equal((db.prepare(`SELECT attempts FROM pushed_branches`).get() as { attempts: number }).attempts, 0);
});

test("migration: an older branch_reviews table without attached_review_id opens and works", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mig2-")), "t.db");
  const RECENT = Date.now() - 1000;
  const old = new Database(path);
  old.exec(`CREATE TABLE branch_reviews (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, project_id INTEGER NOT NULL, project_path TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, merge_base TEXT NOT NULL, head_sha TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT, findings_json TEXT, summary TEXT, error TEXT, trigger TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER);
    INSERT INTO branch_reviews (id, owner_id, project_id, project_path, branch, base, merge_base, head_sha, status, verdict, trigger, created_at) VALUES ('a', 1, 9, 'g/p', 'b', 'main', 'm', 'h', 'done', 'approve', 'api', ${RECENT});`);
  old.close();
  const db = openDb(path);
  assert.equal((db.prepare(`SELECT attached_review_id a FROM branch_reviews`).get() as { a: number | null }).a, null);
  assert.equal((db.prepare(`SELECT skill_from s FROM branch_reviews`).get() as { s: string | null }).s, null, "skill_from added as NULL = own skill");
  assert.equal(oldestUnattachedBranchReviewAt(db, 1), RECENT);
});
