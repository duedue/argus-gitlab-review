import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { claimReview, failReview, openDb, releaseStaleRunning, reviewExists, type Db } from "../src/db.ts";
import type { ReviewEngine } from "../src/engine.ts";
import type { GitLab, Mr } from "../src/gitlab.ts";
import { failureNote, sanitizeReason } from "../src/publisher.ts";
import { ReviewQueue } from "../src/queue.ts";
import { pollOnce, reviewMr, type UserRuntime } from "../src/review.ts";
import { createSession } from "../src/sessions.ts";
import { addUser, getUser, type User } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const key = randomBytes(32);
const GL = "https://gl.test";
const dir = mkdtempSync(join(tmpdir(), "retry-"));
const skillPath = join(dir, "SKILL.md");
writeFileSync(skillPath, "x");
const base = { ownerId: 1, projectId: 9, mrId: 700, mrIid: 7, headSha: "deadbeef00", dryRun: false };
const mr: Mr = { id: 700, iid: 7, project_id: 9, title: "t", description: "", sha: "deadbeef00", web_url: `${GL}/g/p/-/merge_requests/7`, target_branch: "main", state: "opened", reviewers: [], diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } };
const prepare = async () => ({ dir: "/x", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await f(); } finally { Object.assign(console, { log, warn, error }); }
};
const row = (db: Db) => db.prepare(`SELECT id, status, attempts, next_retry_at, error FROM reviews`).get() as { id: number; status: string; attempts: number; next_retry_at: number | null; error: string | null };

test("startup releases running rows: none left failed, next claim succeeds", () => {
  const db = openDb(":memory:");
  claimReview(db, base);
  claimReview(db, { ...base, headSha: "other" });
  db.prepare(`UPDATE reviews SET status='done' WHERE head_sha='other'`).run();
  const warns: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try { assert.equal(releaseStaleRunning(db), 1); } finally { console.warn = w; }
  assert.equal(warns.length, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM reviews WHERE status='failed'`).get() as { n: number }).n, 0);
  assert.equal(claimReview(db, base), true);
});

test("retry state machine: backoff 5/15 min, reclaim only when due, final after 3rd", () => {
  const db = openDb(":memory:");
  const t0 = 1_000_000;
  claimReview(db, base, t0);
  assert.deepEqual(failReview(db, 1, 700, "deadbeef00", false, "e", t0), { attempts: 1, final: false });
  assert.equal(row(db).next_retry_at, t0 + 5 * 60_000);
  assert.equal(reviewExists(db, 1, 700, "deadbeef00", false, t0), true);
  assert.equal(claimReview(db, base, t0 + 5 * 60_000 - 1), false, "not before next_retry_at");
  assert.equal(reviewExists(db, 1, 700, "deadbeef00", false, t0 + 5 * 60_000), false, "due rows are not 'already reviewed'");
  assert.equal(claimReview(db, base, t0 + 5 * 60_000), true);
  assert.equal(claimReview(db, base, t0 + 5 * 60_000), false, "atomic: only one winner");
  assert.deepEqual({ s: row(db).status, a: row(db).attempts, n: row(db).next_retry_at }, { s: "running", a: 2, n: null });
  const t1 = t0 + 6 * 60_000;
  assert.deepEqual(failReview(db, 1, 700, "deadbeef00", false, "e", t1), { attempts: 2, final: false });
  assert.equal(row(db).next_retry_at, t1 + 15 * 60_000);
  assert.equal(claimReview(db, base, t1 + 15 * 60_000), true);
  assert.deepEqual(failReview(db, 1, 700, "deadbeef00", false, "e", t1), { attempts: 3, final: true });
  assert.deepEqual({ s: row(db).status, n: row(db).next_retry_at }, { s: "failed", n: null });
  assert.equal(claimReview(db, base, Number.MAX_SAFE_INTEGER), false, "final failure never reclaimed");
});

test("skipped / done rows are never reclaimed", () => {
  const db = openDb(":memory:");
  claimReview(db, base);
  db.prepare(`UPDATE reviews SET status='skipped', next_retry_at=1`).run();
  assert.equal(claimReview(db, base, 10), false);
});

test("sanitizeReason strips urls, credentials, paths, tokens, stack lines; caps length", () => {
  const raw = "clone https://oauth2:glpat-abc123@git.example.com/g/p.git failed at /Users/me/data/repo/x.ts with Bearer abc.def token=sekret0 key AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n    at foo (/app/src/x.ts:1:1)";
  const out = sanitizeReason(raw);
  for (const bad of ["glpat", "oauth2", "git.example.com", "/Users", "abc.def", "sekret0", "AAAAAAAA", "/app"]) assert.ok(!out.includes(bad), `${bad} leaked: ${out}`);
  assert.ok(!out.includes("\n"));
  assert.ok(sanitizeReason("x".repeat(500)).length <= 200);
  assert.equal(sanitizeReason("either/or works"), "either/or works");
  assert.match(failureNote(3, "boom", "zh-TW"), /^🤖 \*\*Argus\*\* · 審查失敗（第 3 次嘗試）：boom。.*重新審查/);
  assert.match(failureNote(3, "boom", "en"), /Review failed \(attempt 3\): boom\./);
});

function harness(dryRun: boolean) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
  const user = getUser(db, "alice")!;
  const notes: string[] = [];
  let postFails = false;
  const gl = {
    getMr: async () => mr,
    getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [],
    listReviewMrs: async () => [mr],
    postNote: async (_p: number, _i: number, b: string) => { if (postFails) throw new Error("note down"); notes.push(b); },
    postDiscussion: async () => {},
  } as unknown as GitLab;
  let fail = true;
  let runs = 0;
  const engine: ReviewEngine = { review: async () => { runs++; if (fail) throw new Error("boom https://u:tok@h/x.git /srv/data/repo"); return { findings: [], resolved: [] }; } };
  const rt: UserRuntime = { token: async () => "t", gl, engine, prepare };
  const cfg = { ...loadConfig({}), dryRun };
  return { db, user, notes, rt, cfg, queue: new ReviewQueue(), setFail: (v: boolean) => (fail = v), setPostFails: (v: boolean) => (postFails = v), runs: () => runs };
}

test("reviewMr: attempts 1-2 retry silently, 3rd posts ONE sanitized note; poll re-reviews a due row", async () => {
  const h = harness(false);
  await quiet(() => reviewMr(h.cfg, h.db, h.user, h.rt, mr));
  assert.deepEqual({ s: row(h.db).status, a: row(h.db).attempts }, { s: "failed", a: 1 });
  assert.ok(row(h.db).next_retry_at! > Date.now());
  await quiet(() => pollOnce(h.cfg, h.db, [h.user], () => h.rt, h.queue)); // not due: nothing runs
  assert.equal(row(h.db).attempts, 1);
  for (const want of [2, 3]) {
    h.db.prepare(`UPDATE reviews SET next_retry_at=1 WHERE next_retry_at IS NOT NULL`).run();
    await quiet(() => pollOnce(h.cfg, h.db, [h.user], () => h.rt, h.queue));
    assert.equal(row(h.db).attempts, want);
  }
  assert.equal(row(h.db).next_retry_at, null);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0]!, /第 3 次嘗試/);
  assert.ok(!/tok|\/srv|https:/.test(h.notes[0]!), h.notes[0]);
  await quiet(() => pollOnce(h.cfg, h.db, [h.user], () => h.rt, h.queue)); // final: no more runs, no more notes
  assert.equal(h.notes.length, 1);
});

test("reviewMr: a retry that succeeds ends done; note-post failure is only logged; dry-run posts nothing", async () => {
  const h = harness(false);
  await quiet(() => reviewMr(h.cfg, h.db, h.user, h.rt, mr));
  h.setFail(false);
  h.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await quiet(() => reviewMr(h.cfg, h.db, h.user, h.rt, mr));
  assert.deepEqual({ s: row(h.db).status, a: row(h.db).attempts }, { s: "done", a: 2 });

  const f = harness(false);
  f.setPostFails(true);
  f.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, attempts) VALUES (1, 9, 700, 7, 'deadbeef00', 0, 'failed', 2)`).run();
  f.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await quiet(() => reviewMr(f.cfg, f.db, f.user, f.rt, mr)); // must not throw
  assert.equal(row(f.db).next_retry_at, null);

  const d = harness(true);
  d.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, attempts) VALUES (1, 9, 700, 7, 'deadbeef00', 1, 'failed', 2)`).run();
  d.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await quiet(() => reviewMr(d.cfg, d.db, d.user, d.rt, mr));
  assert.equal(d.notes.length, 0);
  assert.equal(row(d.db).attempts, 3);
});

// --- manual retry route ---
function web(opts: { state?: string; live?: boolean } = {}) {
  const h = harness(!opts.live);
  const add = (id: number, name: string) => (addUser(h.db, key, { gitlabUserId: id, username: name, token: "t", tokenExpiresAt: null, skillPath, isOwner: false }), getUser(h.db, name)!);
  const other = add(2, "bob");
  const stranger = add(3, "carol");
  const mrNow = { ...mr, state: opts.state ?? "opened", author: { id: 99 } } as Mr;
  const approvals: string[] = [];
  const rt: UserRuntime = { ...h.rt, gl: { ...(h.rt.gl as object), getMr: async () => mrNow, userHasApproved: async () => false, approveMr: async (_p: number, _i: number, sha: string) => { approvals.push(sha); } } as unknown as GitLab };
  h.setFail(false);
  const app = createApp({ cfg: h.cfg, db: h.db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor: async (_u: User) => rt, queue: h.queue });
  const failed = (owner: number, sha = "deadbeef00") => (h.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, attempts, next_retry_at) VALUES (?, 9, 700, 7, ?, 1, 'failed', 3, NULL)`).run(owner, sha).lastInsertRowid as number);
  const s = (id: number) => createSession(h.db, id);
  const post = async (id: number, sess: { id: string; csrf: string }, csrf: string | null = sess.csrf) =>
    app.request(`/reviews/${id}/retry`, { method: "POST", headers: { cookie: `sid=${sess.id}` }, body: new URLSearchParams(csrf === null ? {} : { _csrf: csrf }) });
  return { h, app, failed, s, post, other, stranger, approvals };
}

test("manual retry: auth, CSRF, owner-vs-other, rate limit, enqueues and re-reviews", async () => {
  const w = web();
  const id = w.failed(2);
  assert.equal((await w.app.request(`/reviews/${id}/retry`, { method: "POST" })).status, 302); // no session -> /login
  const bob = w.s(2);
  assert.equal((await w.post(id, bob, "bad")).status, 403);
  assert.equal((await w.post(id, bob, null)).status, 403);
  assert.equal((await w.post(id, w.s(3))).status, 404, "other user cannot see the row");
  assert.equal(row(w.h.db).status, "failed");
  const res = await quiet(() => w.post(id, bob));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /已加入審查佇列/);
  await quiet(() => w.h.queue.idle());
  assert.deepEqual({ s: row(w.h.db).status, a: row(w.h.db).attempts }, { s: "done", a: 1 });
  assert.equal(w.h.runs(), 1);
  const again = w.failed(2, "newsha");
  assert.equal((await w.post(again, bob)).status, 429, "1 per 30s per user");
  assert.equal((await w.post(id, bob, null)).status, 403);
});

test("manual retry: Argus owner may retry another user's row; non-failed rows refused; GET /reviews shows the button", async () => {
  const w = web();
  const id = w.failed(2);
  const page = await (await w.app.request("/reviews", { headers: { cookie: `sid=${w.s(2).id}` } })).text();
  assert.match(page, new RegExp(`action="/reviews/${id}/retry"`));
  assert.match(page, /重新審查/);
  const res = await quiet(() => w.post(id, w.s(1)));
  assert.equal(res.status, 200);
  await quiet(() => w.h.queue.idle());
  const r = w.h.db.prepare(`SELECT status, owner_id FROM reviews WHERE id=? OR status='done' ORDER BY id DESC LIMIT 1`).get(id) as { status: string; owner_id: number };
  assert.deepEqual(r, { status: "done", owner_id: 2 }, "re-reviewed as the row owner, not as the Argus owner");
  assert.equal(w.h.runs(), 1);
  assert.equal((await w.post(row(w.h.db).id, w.s(2))).status, 400, "done row is not retryable");
});

test("manual retry: MR no longer open -> message, row kept; pending retry time is shown", async () => {
  const w = web({ state: "merged" });
  const id = w.failed(2);
  const res = await w.post(id, w.s(2));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /不是 open 狀態/);
  assert.equal(row(w.h.db).status, "failed");
  w.h.db.prepare(`UPDATE reviews SET attempts=1, next_retry_at=?`).run(Date.now() + 300_000);
  const page = await (await w.app.request("/reviews", { headers: { cookie: `sid=${w.s(2).id}` } })).text();
  assert.match(page, /將於 \d\d:\d\d 自動重試/);
});

test("upgrade: failed rows recorded before automatic retry existed (e.g. 'interrupted') become claimable", () => {
  const file = join(mkdtempSync(join(tmpdir(), "legacy-")), "argus.db");
  const old = openDb(file);
  old.exec(`ALTER TABLE reviews DROP COLUMN next_retry_at; ALTER TABLE reviews DROP COLUMN attempts;`); // pre-retry schema
  old.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, error) VALUES (1, 7, 607, 607, 'e957a1e0', 0, 'failed', 'interrupted')`).run();
  old.close();
  const db = openDb(file); // migration adds the columns and schedules the legacy failure
  const r = db.prepare(`SELECT attempts, next_retry_at FROM reviews`).get() as { attempts: number; next_retry_at: number | null };
  assert.equal(r.attempts, 1);
  assert.ok(r.next_retry_at !== null && r.next_retry_at <= Date.now());
  assert.equal(claimReview(db, { ownerId: 1, projectId: 7, mrId: 607, mrIid: 607, headSha: "e957a1e0", dryRun: false }), true);
  db.close();
  assert.equal((openDb(file).prepare(`SELECT status FROM reviews`).get() as { status: string }).status, "running"); // a second open does not reschedule
});

test("manual retry: a refused retry (MR not open) does not use up the rate limit", async () => {
  const w = web({ state: "closed" });
  const bob = w.s(2);
  assert.equal((await w.post(w.failed(2), bob)).status, 400);
  assert.equal((await w.post(w.failed(2, "othersha"), bob)).status, 400, "still a 400 (not a 429): the first refusal was not counted");
});

// --- retry sweep: failed rows the poller never lists (self-reviews, MRs without the user as reviewer) ---
function sweepHarness(self: boolean, mrOver: Partial<Mr> = {}, autoApprove = false) {
  const h = harness(false);
  if (autoApprove) h.db.prepare(`UPDATE users SET auto_approve=1`).run();
  const user = getUser(h.db, "alice")!;
  const cur = { ...mr, author: { id: 99 }, ...mrOver } as Mr;
  const approvals: string[] = [];
  const gl = {
    ...(h.rt.gl as object),
    getMr: async () => cur,
    listReviewMrs: async () => [], // the poller never lists this MR
    userHasApproved: async () => false,
    approveMr: async (_p: number, _i: number, sha: string) => { approvals.push(sha); },
  } as unknown as GitLab;
  const rt: UserRuntime = { ...h.rt, gl };
  const sweep = () => quiet(() => pollOnce(h.cfg, h.db, [user], () => rt, h.queue));
  const fail = async (opts?: { selfReview?: boolean }) => quiet(() => reviewMr(h.cfg, h.db, user, rt, cur, undefined, { selfReview: self, ...opts }));
  return { ...h, rt, user, approvals, sweep, fail };
}

test("sweep: self-review failure is retried only once due, through the 3 attempts, with ONE final note", async () => {
  const s = sweepHarness(true);
  await s.fail();
  assert.equal((s.db.prepare(`SELECT self_review FROM reviews`).get() as { self_review: number }).self_review, 1);
  await s.sweep();
  assert.equal(row(s.db).attempts, 1, "not due: untouched");
  for (const want of [2, 3]) {
    s.db.prepare(`UPDATE reviews SET next_retry_at=1 WHERE next_retry_at IS NOT NULL`).run();
    await s.sweep();
    assert.equal(row(s.db).attempts, want);
  }
  assert.equal(row(s.db).next_retry_at, null);
  assert.equal(s.notes.length, 1);
  await s.sweep();
  assert.equal(s.runs(), 3);
  assert.equal(s.notes.length, 1);
});

test("sweep: selfReview restored from the row, so auto-approve never fires; a normal row still approves", async () => {
  const self = sweepHarness(true, {}, true);
  await self.fail();
  self.setFail(false);
  self.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await self.sweep();
  assert.equal(row(self.db).status, "done");
  assert.deepEqual(self.approvals, []);

  const normal = sweepHarness(false, {}, true);
  await normal.fail();
  normal.setFail(false);
  normal.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await normal.sweep();
  assert.equal(row(normal.db).status, "done");
  assert.deepEqual(normal.approvals, ["deadbeef00"], "control: same flow without self flag approves");
});

test("sweep: closed MR -> row final, no run, no note; moved head -> old sha not retried", async () => {
  for (const over of [{ state: "merged" }, { sha: "newhead" }] as Partial<Mr>[]) {
    const s = sweepHarness(true, over);
    await quiet(() => reviewMr(s.cfg, s.db, s.user, { ...s.rt, gl: { ...(s.rt.gl as object), getMr: async () => mr } as unknown as GitLab }, mr, undefined, { selfReview: true })); // fails at the original head
    s.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
    const before = s.runs();
    await s.sweep();
    assert.equal(s.runs(), before);
    assert.deepEqual({ s: row(s.db).status, a: row(s.db).attempts, n: row(s.db).next_retry_at }, { s: "failed", a: 1, n: null });
    assert.equal(s.notes.length, 0);
  }
});

test("sweep + reviewer-listed path do not double-run a due row", async () => {
  const s = sweepHarness(false);
  await s.fail();
  s.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  const listed = { ...mr, author: { id: 99 } } as Mr;
  const rt: UserRuntime = { ...s.rt, gl: { ...(s.rt.gl as object), listReviewMrs: async () => [listed] } as unknown as GitLab };
  await quiet(() => pollOnce(s.cfg, s.db, [s.user], () => rt, s.queue));
  assert.equal(s.runs(), 2, "1 initial failure + exactly 1 retry");
  assert.equal(row(s.db).attempts, 2);
});

test("sweep: getMr 404/403 (MR gone, access lost) -> row final, no run; a 500 keeps the row for the next cycle", async () => {
  for (const status of [404, 403]) {
    const s = sweepHarness(true);
    await s.fail();
    s.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
    const before = s.runs();
    const rt: UserRuntime = { ...s.rt, gl: { ...(s.rt.gl as object), getMr: async () => { throw Object.assign(new Error("gone"), { status }); } } as unknown as GitLab };
    await pollOnce(s.cfg, s.db, [s.user], () => rt, s.queue);
    assert.equal(s.runs(), before);
    assert.deepEqual({ s: row(s.db).status, n: row(s.db).next_retry_at }, { s: "failed", n: null });
    assert.equal(s.notes.length, 0);
  }
  const s = sweepHarness(true);
  await s.fail();
  s.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  const rt: UserRuntime = { ...s.rt, gl: { ...(s.rt.gl as object), getMr: async () => { throw Object.assign(new Error("oops"), { status: 500 }); } } as unknown as GitLab };
  await quiet(() => pollOnce(s.cfg, s.db, [s.user], () => rt, s.queue));
  assert.equal(row(s.db).next_retry_at, 1, "transient error: row kept, still due");
});

test("sweep: a draft MR is not retried (row kept) unless the row is a self-review; ready again -> retried", async () => {
  const draft = { title: "Draft: t" } as Partial<Mr>;
  const n = sweepHarness(false, draft);
  await n.fail();
  n.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await n.sweep();
  assert.deepEqual({ runs: n.runs(), a: row(n.db).attempts, n: row(n.db).next_retry_at }, { runs: 1, a: 1, n: 1 }, "draft: no run, row still due");
  const sr = sweepHarness(true, draft);
  await sr.fail();
  sr.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await sr.sweep();
  assert.equal(sr.runs(), 2, "self-review runs on a draft");
  const rdy = sweepHarness(false);
  await rdy.fail();
  rdy.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  await rdy.sweep();
  assert.equal(rdy.runs(), 2, "control: non-draft is retried");
});

test("self-review stays non-approving when re-claimed by the poller listing (a) or the manual retry route (b)", async () => {
  // (a) the poller lists this MR (e.g. user is also a reviewer); the retry comes through reviewMr's row fallback
  const s = sweepHarness(true, {}, true);
  await s.fail();
  s.setFail(false);
  s.db.prepare(`UPDATE reviews SET next_retry_at=1`).run();
  const listed = { ...mr, author: { id: 99 } } as Mr;
  const rt: UserRuntime = { ...s.rt, gl: { ...(s.rt.gl as object), listReviewMrs: async () => [listed] } as unknown as GitLab };
  await quiet(() => pollOnce(s.cfg, s.db, [s.user], () => rt, s.queue));
  assert.equal(row(s.db).status, "done");
  assert.deepEqual(s.approvals, []);

  // (b) POST /reviews/:id/retry; controls: the same row without the self flag does approve
  for (const self of [1, 0]) {
    const w = web({ live: true });
    w.h.db.prepare(`UPDATE users SET auto_approve=1`).run();
    const id = w.failed(2);
    w.h.db.prepare(`UPDATE reviews SET dry_run=0, self_review=? WHERE id=?`).run(self, id);
    assert.equal((await quiet(() => w.post(id, w.s(2)))).status, 200);
    await quiet(() => w.h.queue.idle());
    assert.equal(row(w.h.db).status, "done");
    assert.deepEqual(w.approvals, self ? [] : ["deadbeef00"]);
  }
});

test("migration: self_review column is added to a pre-existing DB, default 0", () => {
  const file = join(mkdtempSync(join(tmpdir(), "legacy-")), "argus.db");
  const old = openDb(file);
  old.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status) VALUES (1, 7, 607, 607, 'abc', 0, 'done')`).run();
  old.exec(`ALTER TABLE reviews DROP COLUMN self_review`);
  old.close();
  const db = openDb(file);
  assert.equal((db.prepare(`SELECT self_review FROM reviews`).get() as { self_review: number }).self_review, 0);
});

test("claim records the MR author; a re-claim backfills a missing one but never overwrites", () => {
  const db = openDb(":memory:");
  const t0 = 1_000_000;
  const author = () => (db.prepare(`SELECT mr_author a FROM reviews`).get() as { a: string | null }).a;
  claimReview(db, { ...base, author: "alice" }, t0);
  assert.equal(author(), "alice");
  failReview(db, base.ownerId, base.mrId, base.headSha, base.dryRun, "boom", t0);
  assert.equal(claimReview(db, { ...base, author: "bob" }, t0 + 3_600_000), true);
  assert.equal(author(), "alice", "existing author kept");
  db.prepare(`UPDATE reviews SET mr_author=NULL`).run();
  failReview(db, base.ownerId, base.mrId, base.headSha, base.dryRun, "boom", t0);
  assert.equal(claimReview(db, { ...base, author: "bob" }, t0 + 7_200_000), true);
  assert.equal(author(), "bob", "missing author backfilled");
});

test("reviewMr records the MR author's username on the review row", async () => {
  const h = harness(false);
  h.setFail(false);
  await quiet(() => reviewMr(h.cfg, h.db, h.user, h.rt, { ...mr, author: { id: 42, username: "carol" } }));
  assert.equal((h.db.prepare(`SELECT mr_author a FROM reviews`).get() as { a: string }).a, "carol");
});

test("GET /reviews shows the round of each done review (Nth done review of that MR); other rows show —", async () => {
  const w = web();
  const ins = w.h.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status) VALUES (2, 9, ?, ?, ?, 0, ?)`);
  ins.run(800, 8, "a1a1a1a1ff", "done");
  ins.run(801, 9, "c1c1c1c1ff", "done"); // another MR: its own count
  ins.run(800, 8, "a2a2a2a2ff", "skipped");
  ins.run(800, 8, "a3a3a3a3ff", "done");
  w.h.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status) VALUES (2, 9, 800, 8, 'd1d1d1d1ff', 1, 'done')`).run(); // dry-run counts on its own
  const page = await (await w.app.request("/reviews", { headers: { cookie: `sid=${w.s(2).id}` } })).text();
  const roundOf = (sha: string) => new RegExp(`${sha.slice(0, 8)}</code></td>\\s*<td class="nowrap">([^<]*)<`).exec(page)?.[1];
  assert.equal(roundOf("a3a3a3a3ff"), "第 2 輪");
  assert.equal(roundOf("a1a1a1a1ff"), "第 1 輪");
  assert.equal(roundOf("c1c1c1c1ff"), "第 1 輪");
  assert.equal(roundOf("d1d1d1d1ff"), "第 1 輪", "dry-run rows are counted separately from live ones");
  assert.match(page, /a2a2a2a2<\/code><\/td>\s*<td class="nowrap"><span class="muted" aria-label="不適用">—<\/span>/);
});

test("GET /reviews groups by MR: one <details> per (project, iid), newest group first, summary = latest round + 共 N 筆, failure hint, retry button inside", async () => {
  const w = web();
  const ins = w.h.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, attempts) VALUES (2, 9, ?, ?, ?, 1, ?, 3)`); // dry_run=1 matches the test harness mode, so failed rows are retryable
  ins.run(800, 8, "a1a1a1a1ff", "done"); // MR !8 first ...
  ins.run(801, 9, "b1b1b1b1ff", "done"); // ... then MR !9 ...
  ins.run(800, 8, "a3a3a3a3ff", "done"); // ... then MR !8 again: its group is the newest despite the older first row
  const failedId = (ins.run(800, 8, "a2a2a2a2ff", "failed").lastInsertRowid as number); // failure after the last done -> still flagged
  const page = await (await w.app.request("/reviews", { headers: { cookie: `sid=${w.s(2).id}` } })).text();
  const groups = page.split('<details class="group"').slice(1);
  assert.equal(groups.length, 2, "4 rows of 2 MRs -> 2 groups");
  assert.match(page, /上限 100 筆.*「共 N 筆」只計這 4 筆內的紀錄/, "page says the per-MR count only covers the recent rows");
  assert.match(groups[0]!, /!8/, "newest group first");
  assert.match(groups[1]!, /!9/);
  const sum = /<summary>([\s\S]*?)<\/summary>/.exec(groups[0]!)![1]!;
  assert.match(sum, /共 3 筆／最新第 2 輪/);
  assert.match(sum, /a2a2a2a2/, "summary shows the latest commit");
  assert.doesNotMatch(sum, /a1a1a1a1/);
  assert.match(sum, /有 1 筆失敗/);
  assert.match(groups[1]!, /共 1 筆／最新第 1 輪/);
  assert.doesNotMatch(groups[1]!, /筆失敗/, "no hint on a clean group");
  const body = groups[0]!.slice(groups[0]!.indexOf("</summary>"));
  assert.ok(body.indexOf("a2a2a2a2") < body.indexOf("a3a3a3a3") && body.indexOf("a3a3a3a3") < body.indexOf("a1a1a1a1"), "rows inside a group are newest first");
  assert.equal((body.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr>/g) ?? []).length, 3);
  assert.match(body, new RegExp(`action="/reviews/${failedId}/retry"`), "re-review button stays on the failed row inside the group");
});

test("GET /reviews summary: latest round compares within the latest row's mode; old failures superseded by a later done do not raise badges", async () => {
  const w = web();
  const ins = w.h.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, attempts) VALUES (2, 9, ?, ?, ?, ?, ?, 3)`);
  const summaries = async () => {
    const page = await (await w.app.request("/reviews", { headers: { cookie: `sid=${w.s(2).id}` } })).text();
    return page.split('<details class="group"').slice(1).map((g) => /<summary>([\s\S]*?)<\/summary>/.exec(g)![1]!);
  };
  // MR !8: 5 dry-run rounds, then 2 live rounds (latest is live) -> 第 2 輪, not 第 5 輪
  for (let i = 0; i < 5; i++) ins.run(800, 8, `d${i}d${i}d${i}d${i}ff`, 1, "done");
  ins.run(800, 8, "e1e1e1e1ff", 0, "done");
  ins.run(800, 8, "e2e2e2e2ff", 0, "done");
  // MR !9: failed, then done -> superseded, no badges (the failed row itself still listed inside)
  ins.run(801, 9, "f1f1f1f1ff", 1, "failed");
  ins.run(801, 9, "f2f2f2f2ff", 1, "done");
  // MR !10: done, then failed -> badges
  ins.run(802, 10, "g1g1g1g1ff", 1, "done");
  ins.run(802, 10, "g2g2g2g2ff", 1, "failed");
  // MR !11: never done -> failures count
  ins.run(803, 11, "h1h1h1h1ff", 1, "failed");
  const [m11, m10, m9, m8] = await summaries();
  assert.match(m8!, /共 7 筆／最新第 2 輪/);
  assert.doesNotMatch(m9!, /筆失敗|可重新審查/);
  assert.match(m10!, /有 1 筆失敗/);
  assert.match(m10!, /可重新審查/);
  assert.match(m11!, /有 1 筆失敗/);
  assert.doesNotMatch(m10!, /badge-dryrun">可重新審查/, "re-review hint must not reuse the dry-run badge style");
});

test("GET /reviews: every group summary keeps 7 column cells even when model and findings are missing", async () => {
  const w = web();
  w.h.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, error) VALUES (2, 9, 900, 90, 'e1e1e1e1ff', 0, 'failed', 'boom')`).run();
  const page = await (await w.app.request("/reviews", { headers: { cookie: `sid=${w.s(2).id}` } })).text();
  const g = page.split('<details class="group"').slice(1).find((x) => x.includes("e1e1e1e1"))!;
  const cols = /<span class="g-line g-cols">([\s\S]*?)<\/span>\s*<span class="g-line/.exec(g)?.[1] ?? g;
  assert.match(cols, /<span class="g-model"><\/span>/, "empty model cell kept");
  assert.match(cols, /<span class="g-find nowrap"><\/span>/, "empty findings cell kept");
});
