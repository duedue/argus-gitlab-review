import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { insertBranchReview, openDb } from "../src/db.ts";
import type { GitLab, PushEvent } from "../src/gitlab.ts";
import { PUSH_DEBOUNCE_MS, pollPushedBranches } from "../src/pushreview.ts";
import { ReviewQueue } from "../src/queue.ts";
import type { UserRuntime } from "../src/review.ts";
import { addUser, getUser, setUser } from "../src/users.ts";

const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");
const NOW = Date.parse("2026-11-06T12:00:00Z");
const ev = (branch: string, sha: string, minsAgo: number, over: Partial<PushEvent["push_data"]> = {}, project = 9): PushEvent => ({
  project_id: project, created_at: new Date(NOW - minsAgo * 60_000).toISOString(), push_data: { ref: branch, ref_type: "branch", action: "pushed", commit_to: sha, ...over },
});

function setup(o: { settings?: string[]; events?: PushEvent[]; mrs?: Record<string, number>; path?: string; tips?: Record<string, string>; engineHold?: boolean } = {}) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: false });
  setUser(db, "alice", o.settings ?? ["review_pushed_branches=1", "review_all_projects=1"]);
  const u = getUser(db, "alice")!;
  let events = o.events ?? [];
  const tips: Record<string, string> = { main: "9".repeat(40), ...o.tips };
  const calls: string[] = [];
  const gl = {
    listPushEvents: async () => (calls.push("events"), events),
    getProject: async (id: number | string) => ({ id: Number(id), http_url_to_repo: "x", path_with_namespace: o.path ?? "g/p", default_branch: "main" }),
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
  return { db, u, poll, rows, calls, engineRuns: () => engineRuns, setEvents: (e: PushEvent[]) => (events = e), tips };
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
