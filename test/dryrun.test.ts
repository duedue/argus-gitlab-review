import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb, reviewExists, type Db } from "../src/db.ts";
import type { ReviewEngine } from "../src/engine.ts";
import type { GitLab, Mr } from "../src/gitlab.ts";
import type { OAuthCtx } from "../src/oauth.ts";
import { reviewMr, type UserRuntime } from "../src/review.ts";
import { createSession } from "../src/sessions.ts";
import { applyStoredSettings, getSetting, setDryRun } from "../src/setup.ts";
import { addUser, getUser } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const key = randomBytes(32);
const dir = mkdtempSync(join(tmpdir(), "dryrun-"));
const skillPath = join(dir, "SKILL.md");
writeFileSync(skillPath, "x");
const mr: Mr = { id: 700, iid: 7, project_id: 9, title: "t", description: "", sha: "deadbeef00", web_url: "https://gl.test/g/p/-/merge_requests/7", target_branch: "main", state: "opened", reviewers: [], diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } };
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await f(); } finally { Object.assign(console, { log, warn, error }); }
};

function boot(env: Record<string, string> = {}) {
  const cfg = loadConfig({ DATA_DIR: dir, GITLAB_URL: "https://gl.test", ...env });
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "owner", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
  addUser(db, key, { gitlabUserId: 2, username: "bob", token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  applyStoredSettings(cfg, db, key);
  const oauth: OAuthCtx = { gitlabUrl: "https://gl.test", redirectUri: "http://localhost:3000/auth/callback", clientId: "c", clientSecret: "s" };
  const app = createApp({ cfg, db, key, oauth });
  const login = (id: number) => { const s = createSession(db, id); return { cookie: `sid=${s.id}`, csrf: s.csrf }; };
  return { cfg, db, app, login };
}
type S = { cookie: string; csrf: string };
const toggle = async (h: ReturnType<typeof boot>, s: S, fields: Record<string, string>, csrf: string | null = s.csrf): Promise<Response> =>
  h.app.request("/admin/dry-run", { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ ...(csrf === null ? {} : { _csrf: csrf }), ...fields }) });

test("precedence: env set -> locked (value from env); env unset -> DB; neither -> dry-run ON", () => {
  const db = openDb(":memory:");
  for (const [env, want, locked] of [[{}, true, false], [{ DRY_RUN: "0" }, false, true], [{ DRY_RUN: "1" }, true, true], [{ DRY_RUN: "x" }, true, true], [{ DRY_RUN: "" }, true, false]] as const) {
    const cfg = loadConfig({ ...env });
    applyStoredSettings(cfg, db, key);
    assert.deepEqual([cfg.dryRun, cfg.dryRunLocked], [want, locked], JSON.stringify(env));
  }
  // DB says live: honoured only when env is unset; a locked env ignores it
  const open = loadConfig({});
  assert.equal(setDryRun(open, db, key, false), true);
  assert.equal(open.dryRun, false);
  const fresh = loadConfig({});
  applyStoredSettings(fresh, db, key); // simulates a restart
  assert.equal(fresh.dryRun, false);
  const locked = loadConfig({ DRY_RUN: "1" });
  applyStoredSettings(locked, db, key);
  assert.equal(locked.dryRun, true);
  assert.equal(setDryRun(locked, db, key, false), false);
  assert.equal(locked.dryRun, true);
  assert.equal(getSetting(db, key, "dry_run"), "0"); // the refused write left the stored value alone
});

test("toggle route: owner only, CSRF, confirm needed for live, rejected when env-locked", async () => {
  const h = boot();
  const owner = h.login(1);
  const bob = h.login(2);
  assert.equal((await toggle(h, bob, { mode: "live", confirm: "1" })).status, 403);
  assert.equal((await toggle(h, owner, { mode: "live", confirm: "1" }, null)).status, 403);
  assert.equal((await toggle(h, owner, { mode: "live", confirm: "1" }, "wrong")).status, 403);
  assert.equal((await toggle(h, owner, { mode: "live" })).status, 400); // no confirm
  assert.equal((await toggle(h, owner, { mode: "bogus", confirm: "1" })).status, 400);
  assert.equal(h.cfg.dryRun, true);
  await quiet(async () => assert.equal((await toggle(h, owner, { mode: "live", confirm: "1" })).status, 302));
  assert.equal(h.cfg.dryRun, false);
  assert.equal(getSetting(h.db, key, "dry_run"), "0");
  assert.match(await (await h.app.request("/admin", { headers: { cookie: owner.cookie } })).text(), /正式：會發 comment/);
  await quiet(async () => assert.equal((await toggle(h, owner, { mode: "dry" })).status, 302)); // back to dry-run needs no confirm
  assert.equal(h.cfg.dryRun, true);

  const l = boot({ DRY_RUN: "0" });
  const lo = l.login(1);
  assert.equal((await toggle(l, lo, { mode: "dry" })).status, 400);
  assert.equal(l.cfg.dryRun, false);
  const html = await (await l.app.request("/admin", { headers: { cookie: lo.cookie } })).text();
  assert.match(html, /\.env 鎖定/);
  assert.match(html, /<code>\.env<\/code>/);
  assert.match(html, /<button[^>]*disabled/);
});

function reviewHarness(h: ReturnType<typeof boot>) {
  const posts: string[] = [];
  const gl = {
    getMr: async () => mr,
    getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [],
    postNote: async (_p: number, _i: number, b: string) => { posts.push(b); },
    postDiscussion: async (_p: number, _i: number, b: string) => { posts.push(b); },
  } as unknown as GitLab;
  const engine: ReviewEngine = { review: async () => ({ findings: [], resolved: [] }) };
  const rt: UserRuntime = { token: async () => "t", gl, engine, prepare: async () => ({ dir: "/x", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false }) };
  return { posts, rt, user: getUser(h.db, "owner")! };
}
const rows = (db: Db) => db.prepare(`SELECT head_sha, dry_run, status FROM reviews ORDER BY id`).all() as { head_sha: string; dry_run: number; status: string }[];

test("toggling takes effect on the next review; dedupe is keyed by the mode at claim time", async () => {
  const h = boot();
  const r = reviewHarness(h);
  const owner = h.login(1);
  await quiet(() => reviewMr(h.cfg, h.db, r.user, r.rt, mr));
  assert.equal(r.posts.length, 0); // default: dry-run posts nothing
  assert.equal(reviewExists(h.db, 1, mr.id, mr.sha, true), true);
  assert.equal(reviewExists(h.db, 1, mr.id, mr.sha, false), false);

  await quiet(() => toggle(h, owner, { mode: "live", confirm: "1" }));
  await quiet(() => reviewMr(h.cfg, h.db, r.user, r.rt, mr)); // same sha: the dry-run row must not block the live run
  assert.ok(r.posts.length > 0, "live review posts via the fake gl");
  assert.deepEqual(rows(h.db).map((x) => x.dry_run), [1, 0]);
  const n = r.posts.length;
  await quiet(() => reviewMr(h.cfg, h.db, r.user, r.rt, mr)); // live row now exists: deduped
  assert.equal(r.posts.length, n);

  await quiet(() => toggle(h, owner, { mode: "dry" }));
  assert.equal(reviewExists(h.db, 1, mr.id, mr.sha, h.cfg.dryRun), true); // dry-run row is still found when back in dry-run
  await quiet(() => reviewMr(h.cfg, h.db, r.user, r.rt, mr));
  assert.equal(r.posts.length, n);
  assert.equal(rows(h.db).length, 2);
});

test("switching mode finalizes pending retries of the mode being left", async () => {
  const { openDb } = await import("../src/db.ts");
  const { setDryRun } = await import("../src/setup.ts");
  const { loadConfig } = await import("../src/config.ts");
  const { randomBytes } = await import("node:crypto");
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({}), dryRun: false, dryRunLocked: false };
  const ins = db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, attempts, next_retry_at) VALUES (1, 7, ?, 1, 'a', ?, 'failed', 1, ?)`);
  ins.run(10, 0, Date.now() + 60_000); // live, pending
  ins.run(11, 1, Date.now() + 60_000); // dry, pending — not the mode being left
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(setDryRun(cfg, db, randomBytes(32), true), true);
  } finally {
    console.log = log;
  }
  const rows = db.prepare(`SELECT mr_id, next_retry_at FROM reviews ORDER BY mr_id`).all() as { mr_id: number; next_retry_at: number | null }[];
  assert.equal(rows[0]!.next_retry_at, null, "live retry finalized when leaving live");
  assert.notEqual(rows[1]!.next_retry_at, null, "dry retry untouched");
});
