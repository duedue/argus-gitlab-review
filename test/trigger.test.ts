import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey, findApiKey, getApiKeyInfo } from "../src/apikeys.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { engineFor, warnOwnerEngineTest, type ReviewEngine } from "../src/engine.ts";
import type { GitLab, Mr } from "../src/gitlab.ts";
import { queueKey, ReviewQueue } from "../src/queue.ts";
import { pollOnce, type UserRuntime } from "../src/review.ts";
import { runLoop } from "../src/runtime.ts";
import { createSession } from "../src/sessions.ts";
import { parseMrUrl } from "../src/trigger.ts";
import { addUser, getUser, setUserEnabled, type User } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const key = randomBytes(32);
const GL = "https://gl.test";
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");
const skillPath = join(skillDir, "SKILL.md");
const MR_URL = `${GL}/grp/sub/proj/-/merge_requests/7`;

const mkMr = (over: Partial<Mr> = {}): Mr => ({
  id: 700, iid: 7, project_id: 9, title: "t", description: "", sha: "deadbeef00", web_url: MR_URL, target_branch: "main", state: "opened",
  reviewers: [], diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" }, ...over,
});
const fakeGl = (mr: Mr | Error) =>
  ({
    getMr: async () => { if (mr instanceof Error) throw mr; return mr; },
    getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [],
    postNote: async () => assert.fail("dry-run"),
    postDiscussion: async () => assert.fail("dry-run"),
  }) as unknown as GitLab;
const okEngine: ReviewEngine = { review: async () => ({ findings: [], resolved: [] }) };
const prepare = async () => ({ dir: "/x", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });

function setup(opts: { mr?: Mr | Error; limit?: number; engineFor?: (u: User) => ReviewEngine | undefined } = {}) {
  const cfg = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "t-")), GITLAB_URL: GL }), dryRun: true };
  const db = openDb(":memory:");
  const add = (id: number, name: string, owner = false) => {
    addUser(db, key, { gitlabUserId: id, username: name, token: `pat-${name}`, tokenExpiresAt: null, skillPath, isOwner: owner });
    return getUser(db, name)!;
  };
  const caller = add(1, "caller");
  const mr = opts.mr ?? mkMr();
  const queue = new ReviewQueue();
  const ran: string[] = [];
  const runtimeFor = async (u: User): Promise<UserRuntime> => {
    if (u.username === "badtoken") throw new Error("invalid");
    const eng = opts.engineFor ? opts.engineFor(u) : u.username === "noengine" ? undefined : ({ review: async () => (ran.push(u.username), { findings: [], resolved: [] }) } as ReviewEngine);
    return { token: async () => "t", gl: fakeGl(u.username === "caller" ? mr : mkMr()), engine: eng, prepare };
  };
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor, queue, triggerLimitPerHour: opts.limit });
  const apiKey = createApiKey(db, caller.gitlabUserId);
  const trigger = (body: unknown, auth: string | null = `Bearer ${apiKey}`) =>
    app.request("/api/trigger", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, db, cfg, add, caller, queue, ran, apiKey, trigger };
}

test("api key: only the hash is stored, regenerate invalidates the old key", () => {
  const db = openDb(":memory:");
  const k1 = createApiKey(db, 1);
  assert.match(k1, /^argus_[A-Za-z0-9_-]{43}$/);
  const row = db.prepare(`SELECT * FROM api_keys`).get() as Record<string, string>;
  assert.ok(!Object.values(row).some((v) => String(v).includes(k1)), "plaintext must not be stored");
  assert.equal(row.prefix, k1.slice(0, 10));
  assert.equal(findApiKey(db, k1)?.userId, 1);
  const k2 = createApiKey(db, 1);
  assert.notEqual(k1, k2);
  assert.equal(findApiKey(db, k1), undefined);
  assert.equal(findApiKey(db, k2)?.userId, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM api_keys`).get() as { n: number }).n, 1);
  assert.equal(getApiKeyInfo(db, 1)?.lastUsedAt, null);
});

test("settings: key is shown once after generate, then only the prefix", async () => {
  const t = setup();
  const s = createSession(t.db, t.caller.gitlabUserId);
  const post = () => t.app.request("/settings/api-key", { method: "POST", headers: { cookie: `sid=${s.id}` }, body: new URLSearchParams({ _csrf: s.csrf }) });
  const bad = await t.app.request("/settings/api-key", { method: "POST", headers: { cookie: `sid=${s.id}` }, body: new URLSearchParams({ _csrf: "nope" }) });
  assert.equal(bad.status, 403);
  const html = await (await post()).text();
  const shown = /argus_[A-Za-z0-9_-]{43}/.exec(html)![0];
  assert.equal(findApiKey(t.db, shown)?.userId, t.caller.gitlabUserId);
  assert.equal(findApiKey(t.db, t.apiKey), undefined, "old key is dead");
  const again = await (await t.app.request("/settings", { headers: { cookie: `sid=${s.id}` } })).text();
  assert.ok(!again.includes(shown), "full key never shown again");
  assert.ok(again.includes(shown.slice(0, 10)));
});

test("trigger: 401 for missing/bad/malformed key; no cookies or CSRF involved", async () => {
  const t = setup();
  assert.equal((await t.trigger({ mr_url: MR_URL }, null)).status, 401);
  assert.equal((await t.trigger({ mr_url: MR_URL }, "Bearer argus_" + "a".repeat(43))).status, 401);
  assert.equal((await t.trigger({ mr_url: MR_URL }, "Bearer nope")).status, 401);
  const s = createSession(t.db, 1);
  const cookieOnly = await t.app.request("/api/trigger", { method: "POST", headers: { cookie: `sid=${s.id}`, "content-type": "application/json" }, body: JSON.stringify({ mr_url: MR_URL }) });
  assert.equal(cookieOnly.status, 401);
});

test("trigger: 400 for bad json / urls outside gitlabUrl / non-MR urls", async () => {
  const t = setup();
  for (const body of ["not json", {}, { mr_url: 5 }, { mr_url: "https://evil.test/grp/proj/-/merge_requests/7" }, { mr_url: "https://gl.test.evil.com/g/p/-/merge_requests/7" },
    { mr_url: "http://gl.test/g/p/-/merge_requests/7" }, { mr_url: "https://u:p@gl.test/g/p/-/merge_requests/7" }, { mr_url: `${GL}/g/p/-/issues/7` },
    { mr_url: `${GL}/g/../p/-/merge_requests/7` }, { mr_url: `${GL}/p/-/merge_requests/7` }, { mr_url: `${GL}/g/p/-/merge_requests/x` }]) {
    assert.equal((await t.trigger(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(parseMrUrl(`${GL}/grp/sub/proj/-/merge_requests/7#note_1`, GL), { path: "grp/sub/proj", iid: 7 });
  assert.deepEqual(parseMrUrl(`${GL}/pre/g/p/-/merge_requests/7/`, `${GL}/pre/`), { path: "g/p", iid: 7 });
});

test("trigger: 403 when caller is not approved/enabled; 404 when MR invisible to the caller", async () => {
  const t = setup({ mr: Object.assign(new Error("GitLab GET -> 404"), { status: 404 }) });
  assert.equal((await t.trigger({ mr_url: MR_URL })).status, 404);
  const t2 = setup();
  setUserEnabled(t2.db, 1, false);
  assert.equal((await t2.trigger({ mr_url: MR_URL })).status, 403);
});

test("trigger: regenerating the API key does not reset the per-user limit", async () => {
  const t = setup({ limit: 1 });
  assert.equal((await t.trigger({ mr_url: MR_URL })).status, 202);
  const fresh = createApiKey(t.db, t.caller.gitlabUserId);
  assert.equal((await t.trigger({ mr_url: MR_URL }, `Bearer ${fresh}`)).status, 429);
});

test("trigger: 429 after the per-user limit", async () => {
  const t = setup({ limit: 2 });
  assert.equal((await t.trigger({ mr_url: MR_URL })).status, 202);
  assert.equal((await t.trigger({ mr_url: MR_URL })).status, 202);
  const r = await t.trigger({ mr_url: MR_URL });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"));
});

test("trigger: queues only Argus reviewers with engines, reports skip reasons, runs on the reviewer's engine, updates last_used_at", async () => {
  const mr = mkMr({ reviewers: [[2, "alice"], [3, "noengine"], [4, "badtoken"], [5, "pending"], [6, "off"], [99, "stranger"]].map(([id, username]) => ({ id: id as number, username: username as string })) });
  const t3 = setup({ mr });
  for (const [id, n] of [[2, "alice"], [3, "noengine"], [4, "badtoken"], [5, "pending"], [6, "off"]] as const) t3.add(id, n);
  t3.db.prepare(`UPDATE users SET approved=0, enabled=0 WHERE gitlab_user_id=5`).run();
  t3.db.prepare(`UPDATE users SET enabled=0 WHERE gitlab_user_id=6`).run();
  const res = await t3.trigger({ mr_url: MR_URL });
  assert.equal(res.status, 202);
  const body = await res.json() as { queued: string[]; skipped: { username: string; reason: string }[] };
  assert.deepEqual(body.queued, ["alice"]);
  assert.deepEqual(Object.fromEntries(body.skipped.map((s) => [s.username, s.reason])), {
    noengine: "no Claude token configured (set it on the Argus settings page)", badtoken: "GitLab token unavailable", pending: "user not approved or disabled",
    off: "user not approved or disabled", stranger: "not an Argus user",
  });
  assert.ok(!JSON.stringify(body).includes(t3.apiKey));
  await t3.queue.idle();
  assert.deepEqual(t3.ran, ["alice"]);
  assert.equal((t3.db.prepare(`SELECT status FROM reviews WHERE owner_id=2`).get() as { status: string }).status, "done");
  assert.ok(getApiKeyInfo(t3.db, 1)!.lastUsedAt);
  // same sha again: already reviewed
  const again = await (await t3.trigger({ mr_url: MR_URL })).json() as { queued: string[]; skipped: { reason: string }[] };
  assert.deepEqual(again.queued, []);
  assert.ok(again.skipped.some((s) => s.reason === "already reviewed or in progress"));
});

test("trigger: draft MRs are skipped", async () => {
  const t = setup({ mr: mkMr({ title: "Draft: wip", reviewers: [{ id: 2, username: "alice" }] }) });
  t.add(2, "alice");
  const body = await (await t.trigger({ mr_url: MR_URL })).json() as { queued: string[]; skipped: { reason: string }[] };
  assert.deepEqual(body.queued, []);
  assert.equal(body.skipped[0]!.reason, "draft MR");
});

test("queue: one lane is serial, dedupes queued items by key, key released once finished", async () => {
  const q = new ReviewQueue();
  let active = 0, maxActive = 0;
  const ran: string[] = [];
  const job = (n: string) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    ran.push(n); active--;
  };
  const a = q.enqueue(1, queueKey(1, 10, "s"), job("a"));
  const dup = q.enqueue(1, queueKey(1, 10, "s"), job("dup"));
  const b = q.enqueue(1, queueKey(1, 11, "s"), job("b"));
  const c = q.enqueue(1, queueKey(1, 10, "s2"), job("c"));
  assert.deepEqual([a.queued, dup.queued, b.queued, c.queued], [true, false, true, true]);
  await q.idle();
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.equal(maxActive, 1);
  assert.equal(q.enqueue(1, queueKey(1, 10, "s"), job("again")).queued, true, "key is released once finished");
  await q.idle();
});

test("queue: poller and trigger share it; the same reviewer's reviews never overlap, different reviewers run in parallel", async () => {
  let active = 0, maxActive = 0;
  const engine: ReviewEngine = { review: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 15)); active--; return { findings: [], resolved: [] }; } };
  // Same reviewer (alice): poller lists MR 800 while the trigger queues MR 900 -> serial.
  const t = setup({ mr: mkMr({ reviewers: [{ id: 2, username: "alice" }] }), engineFor: () => engine });
  const alice = t.add(2, "alice");
  const rt = (mr: Mr): UserRuntime => ({ token: async () => "t", gl: Object.assign(fakeGl(mr), { listReviewMrs: async () => [mr] }), engine, prepare });
  await Promise.all([pollOnce(t.cfg, t.db, [alice], () => rt(mkMr({ id: 800, sha: "cafe000000" })), t.queue), t.trigger({ mr_url: MR_URL })]);
  await t.queue.idle();
  assert.equal(maxActive, 1, "one reviewer: serial");
  assert.equal((t.db.prepare(`SELECT COUNT(*) n FROM reviews WHERE status='done'`).get() as { n: number }).n, 2);
  // Different reviewers (bob polled, alice triggered): run at the same time.
  maxActive = 0;
  const t2 = setup({ mr: mkMr({ reviewers: [{ id: 2, username: "alice" }] }), engineFor: () => engine });
  t2.add(2, "alice");
  const bob = t2.add(3, "bob");
  await Promise.all([pollOnce(t2.cfg, t2.db, [bob], () => rt(mkMr({ id: 800, sha: "cafe000000" })), t2.queue), t2.trigger({ mr_url: MR_URL })]);
  await t2.queue.idle();
  assert.equal(maxActive, 2, "two reviewers: parallel");
});

test("polling: cycles never overlap and the default interval is 30s", async () => {
  assert.equal(loadConfig({}).pollIntervalMs, 30_000);
  assert.equal(loadConfig({ POLL_INTERVAL_SEC: "5" }).pollIntervalMs, 5_000);
  assert.equal(loadConfig({ POLL_INTERVAL_SEC: "abc" }).pollIntervalMs, 30_000);
  assert.equal(loadConfig({ POLL_INTERVAL_SEC: "0" }).pollIntervalMs, 30_000);
  let active = 0, maxActive = 0, cycles = 0;
  const ac = new AbortController();
  await runLoop(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 25)); // longer than the 5ms interval
    active--;
    if (++cycles === 3) ac.abort();
  }, 5, ac.signal);
  assert.equal(cycles, 3);
  assert.equal(maxActive, 1);
});

test("owner-engine whitelist: default off; listed non-owner gets an engine, others do not; owner unchanged", () => {
  const bob = { isOwner: false, skillPath, username: "Bob", engine: "claude-cli" as const };
  assert.deepEqual(loadConfig({}).ownerEngineTestUsers, []);
  assert.deepEqual(loadConfig({ OWNER_ENGINE_TEST_USERS: " bob, carol ,," }).ownerEngineTestUsers, ["bob", "carol"]);
  assert.equal(engineFor(bob, "claude"), undefined);
  assert.equal(engineFor(bob, "claude", []), undefined);
  assert.ok(engineFor(bob, "claude", ["bob"]), "case-insensitive match");
  assert.equal(engineFor({ ...bob, username: "mallory" }, "claude", ["bob"]), undefined);
  assert.ok(engineFor({ isOwner: true, skillPath, username: "o", engine: "claude-cli" }, "claude"));
});

test("owner-engine whitelist: startup warning only when non-empty; runs are tagged", async () => {
  const logs: string[] = [];
  assert.equal(warnOwnerEngineTest([], (m) => logs.push(m)), false);
  assert.equal(logs.length, 0);
  assert.equal(warnOwnerEngineTest(["bob", "carol"], (m) => logs.push(m)), true);
  assert.match(logs[0]!, /TEST MODE.*owner's Claude subscription is shared with \[bob, carol\]/);
  const warn = console.warn;
  const seen: string[] = [];
  console.warn = (m: string) => void seen.push(String(m));
  try {
    const eng = engineFor({ isOwner: false, skillPath: "/nonexistent/SKILL.md", username: "bob", engine: "claude-cli" }, "claude", ["bob"])!;
    await eng.review({ cwd: "/", mrTitle: "", mrDescription: "", diff: "", incremental: false, language: "en" }).catch(() => undefined);
  } finally {
    console.warn = warn;
  }
  assert.ok(seen.some((m) => m.startsWith("[owner-engine-test] bob")));
});

test("trigger self: reviews as the caller even when not a reviewer, drafts allowed; default mode still skips the caller", async () => {
  const t = setup({ mr: mkMr({ reviewers: [{ id: 50, username: "william" }], title: "Draft: wip" }) });
  const plain = await (await t.trigger({ mr_url: MR_URL })).json();
  assert.deepEqual(plain, { queued: [], skipped: [{ username: "william", reason: "not an Argus user" }] });
  const self = await (await t.trigger({ mr_url: MR_URL, self: true })).json();
  assert.deepEqual(self, { queued: ["caller"], skipped: [] });
  await t.queue.idle();
  assert.deepEqual(t.ran, ["caller"]);
  const again = await (await t.trigger({ mr_url: MR_URL, self: true })).json();
  assert.equal(again.skipped[0].reason, "already reviewed or in progress");
});

test("trigger self: non-boolean self is rejected", async () => {
  const t = setup();
  assert.equal((await t.trigger({ mr_url: MR_URL, self: "yes" })).status, 400);
});
