// Per-user Claude token (0.2.0): engine rule, env-only token passing, per-user config/clone dirs, auth-failure flagging,
// no-engine skips that become reviewable, the settings/admin pages, and the per-user parallel queue.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { claimReview, openDb, recordSkip, reviewExists, finishReview, watchCandidates, type Db } from "../src/db.ts";
import { agentEnv, chooseEngine, ClaudeCliEngine, CLAUDE_TOKEN_REJECTED, engineFor, laneFor, SHARED_LOGIN_LANE, SKIP_REASONS, type ReviewEngine } from "../src/engine.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { concurrencyFrom, queueKey, ReviewQueue } from "../src/queue.ts";
import { cloneDir } from "../src/repo.ts";
import { pollOnce, reviewMr, type UserRuntime } from "../src/review.ts";
import { claudeAuthFor, claudeConfigDir } from "../src/runtime.ts";
import { createSession } from "../src/sessions.ts";
import { addUser, claudeTokenDaysLeft, engineFields, getUserById, setClaudeToken, validateClaudeToken, type User } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";
import { createApiKey } from "../src/apikeys.ts";
import { watchAccepts } from "../src/accept.ts";
import { triggerReviews } from "../src/trigger.ts";
import type { ConnectionTest } from "../src/engine-status.ts";

const key = randomBytes(32);
const tmp = (p = "peruser-") => mkdtempSync(join(tmpdir(), p));
const skillPath = join(tmp(), "SKILL.md");
writeFileSync(skillPath, "SKILL");
const TOKEN = `sk-ant-oat01-${"A1b2_C3d-".repeat(10)}AA`;
const TOKEN2 = `sk-ant-oat01-${"Z9y8_X7w-".repeat(10)}BB`;

const mkUser = (db: Db, id: number, name: string, isOwner: boolean): User => {
  addUser(db, key, { gitlabUserId: id, username: name, token: `gl-${name}`, tokenExpiresAt: null, skillPath, isOwner });
  return getUserById(db, id)!;
};
const base = (o: Partial<Parameters<typeof chooseEngine>[0]> = {}) => ({ isOwner: false, skillPath, username: "bob", engine: "claude-cli" as const, ...o });

// --- the engine rule ---

test("engine rule: owner/non-owner x token/no token, whitelist, invalid token; codex unchanged", () => {
  assert.deepEqual(chooseEngine(base({ isOwner: true, hasClaudeToken: true })), { kind: "claude-token" }, "owner with token -> token first");
  assert.deepEqual(chooseEngine(base({ isOwner: true })), { kind: "claude-owner-login", test: false }, "owner without token -> container login");
  assert.deepEqual(chooseEngine(base({ hasClaudeToken: true })), { kind: "claude-token" }, "non-owner with token");
  assert.deepEqual(chooseEngine(base()), { kind: "none", reason: "no_token" }, "non-owner without token -> skip");
  assert.deepEqual(chooseEngine(base({ username: "Bob" }), ["bob"]), { kind: "claude-owner-login", test: true }, "whitelist keeps the owner-login exception");
  assert.deepEqual(chooseEngine(base({ hasClaudeToken: true }), ["bob"]), { kind: "claude-token" }, "whitelisted user with own token uses it");
  assert.deepEqual(chooseEngine(base({ hasClaudeToken: true, claudeTokenInvalid: true }), ["bob"]), { kind: "none", reason: "token_invalid" }, "invalid token never falls back");
  assert.deepEqual(chooseEngine(base({ isOwner: true, hasClaudeToken: true, claudeTokenInvalid: true })), { kind: "none", reason: "token_invalid" }, "owner too: no silent fallback");
  assert.deepEqual(chooseEngine(base({ engine: "codex-cli", hasClaudeToken: true })), { kind: "none", reason: "engine_unavailable" });
  assert.deepEqual(chooseEngine(base({ engine: "codex-cli", isOwner: true })), { kind: "codex-owner-login", test: false });
});

test("engineFor: non-owner without token gets NO engine (never the owner's); token engine needs its credentials", () => {
  assert.equal(engineFor(base(), "claude"), undefined);
  assert.ok(engineFor(base({ isOwner: true }), "claude"));
  assert.throws(() => engineFor(base({ hasClaudeToken: true }), "claude"), /needs its credentials/);
  assert.ok(engineFor(base({ hasClaudeToken: true }), "claude", [], undefined, { token: () => TOKEN, configDir: tmp() }) instanceof ClaudeCliEngine);
});

// --- token only via env, isolated config dir, auth failure ---

/** Fake claude: records argv/env into `out`, prints `stdout`, exits `code`; stderr echoes the token env (worst case). */
function fakeClaude(o: { stdout: string; code?: number }) {
  const dir = tmp("fakeclaude-");
  const bin = join(dir, "claude");
  writeFileSync(join(dir, "stdout.json"), o.stdout);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\nenv > '${dir}/env'\ncat > /dev/null\ncat '${dir}/stdout.json'\necho "debug token=$CLAUDE_CODE_OAUTH_TOKEN" >&2\nexit ${o.code ?? 0}\n`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => readFileSync(join(dir, "argv"), "utf8"), env: () => readFileSync(join(dir, "env"), "utf8") };
}
const OK = JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ findings: [], resolved: [] }), modelUsage: { "claude-x": { outputTokens: 1 } } });
const REJECTED = JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." });
const input = { cwd: tmpdir(), mrTitle: "t", mrDescription: "", diff: "+x", incremental: false, language: "en" };

test("token reaches the claude child ONLY via env; argv/log clean; isolation flags kept; per-user CLAUDE_CONFIG_DIR + HOME", async () => {
  const fc = fakeClaude({ stdout: OK });
  const dataDir = tmp();
  const cfgDir = claudeConfigDir(dataDir, 2);
  const logs: string[] = [];
  const { log, warn, error } = console;
  console.log = console.warn = console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  const prev = { g: process.env.GITLAB_TOKEN, o: process.env.CLAUDE_CODE_OAUTH_TOKEN, k: process.env.ANTHROPIC_API_KEY };
  Object.assign(process.env, { GITLAB_TOKEN: "gl-secret", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-PARENTPROCESS", ANTHROPIC_API_KEY: "sk-ant-api03-x" });
  try {
    await new ClaudeCliEngine({ claudeBin: fc.bin, skillPath, auth: { token: () => TOKEN, configDir: cfgDir } }).review(input);
    const env = fc.env(), argv = fc.argv();
    assert.match(env, new RegExp(`^CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}$`, "m"));
    assert.match(env, new RegExp(`^CLAUDE_CONFIG_DIR=${cfgDir}$`, "m"));
    assert.match(env, new RegExp(`^HOME=${cfgDir}$`, "m"));
    assert.doesNotMatch(env, /GITLAB_TOKEN|ANTHROPIC_API_KEY|PARENTPROCESS/);
    assert.ok(!argv.includes(TOKEN), "never in argv");
    for (const f of ["--strict-mcp-config", "--setting-sources", "--no-session-persistence"]) assert.ok(argv.split("\n").includes(f), f);
    assert.equal(statSync(cfgDir).mode & 0o777, 0o700);
    assert.equal(cfgDir, join(dataDir, "engines", "2", "claude"));
    assert.notEqual(claudeConfigDir(dataDir, 3), cfgDir, "each user has their own dir");
    // Owner-login engine: no token at all (the parent's CLAUDE_CODE_OAUTH_TOKEN is not inherited), owner's env untouched.
    await new ClaudeCliEngine({ claudeBin: fc.bin, skillPath }).review(input);
    assert.doesNotMatch(fc.env(), /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.equal(agentEnv({ CLAUDE_CODE_OAUTH_TOKEN: "x", PATH: "/b" }).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    Object.assign(console, { log, warn, error });
    for (const [k, v] of [["GITLAB_TOKEN", prev.g], ["CLAUDE_CODE_OAUTH_TOKEN", prev.o], ["ANTHROPIC_API_KEY", prev.k]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  assert.ok(!logs.join("\n").includes(TOKEN), "never logged");
});

test("other CLI failures: the token is scrubbed from the error even if the CLI echoes it", async () => {
  const fc = fakeClaude({ stdout: "not json", code: 2 });
  const err = await new ClaudeCliEngine({ claudeBin: fc.bin, skillPath, auth: { token: () => TOKEN, configDir: tmp() } }).review(input).catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /exited 2/);
  assert.ok(!err.message.includes(TOKEN));
  assert.match(err.message, /token=\*\*\*/);
});

test("401 from the CLI: token flagged invalid (only the exact token used), review fails with a fixed message, next cycle skips", async () => {
  const fc = fakeClaude({ stdout: REJECTED, code: 1 });
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({ DATA_DIR: tmp(), CLAUDE_BIN: fc.bin }), dryRun: true };
  mkUser(db, 2, "bob", false);
  setClaudeToken(db, key, 2, TOKEN);
  const bob = getUserById(db, 2)!;
  const prepareReal = async () => ({ ...(await prepare()), dir: tmpdir() }); // the CLI is really spawned here
  const rt = (u: User): UserRuntime => ({ token: async () => "t", gl: fakeGl(mr(1)), prepare: prepareReal, engine: engineFor(engineFields(u), fc.bin, [], undefined, claudeAuthFor(cfg, db, key, u)) });
  const logs = await quiet(() => pollOnce(cfg, db, [bob], rt));
  assert.equal(getUserById(db, 2)!.claudeTokenInvalid, true);
  const row = db.prepare(`SELECT status, error FROM reviews`).get() as { status: string; error: string };
  assert.deepEqual(row, { status: "failed", error: CLAUDE_TOKEN_REJECTED });
  assert.ok(!logs.includes(TOKEN));
  // Invalid -> no engine, never the owner's; replacing the token clears the flag.
  assert.equal(rt(getUserById(db, 2)!).engine, undefined);
  setClaudeToken(db, key, 2, TOKEN2);
  assert.equal(getUserById(db, 2)!.claudeTokenInvalid, false);
  // A 401 for the OLD token arriving after the replacement must not flag the new one.
  claudeAuthFor(cfg, db, key, bob)!.onRejected!();
  assert.equal(getUserById(db, 2)!.claudeTokenInvalid, false);
});

// --- skipped rows: visible, once, and reviewable as soon as an engine exists ---

const mr = (id: number, sha = "deadbeef00"): MrSummary => ({ id, iid: id, project_id: 7, title: "t", description: "", sha, web_url: "u", target_branch: "main" });
function fakeGl(m: MrSummary) {
  return {
    listReviewMrs: async () => [m],
    getMr: async () => ({ ...m, state: "opened", diff_refs: { base_sha: "b", start_sha: "b", head_sha: m.sha } }),
    getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [],
  } as unknown as GitLab;
}
const prepare = async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });
async function quiet(fn: () => Promise<unknown>): Promise<string> {
  const out: string[] = [];
  const { log, warn, error } = console;
  console.log = console.warn = console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try { await fn(); } finally { Object.assign(console, { log, warn, error }); }
  return out.join("\n");
}

test("no token: skipped row with the reason; setting a token makes the same head reviewable (poll and trigger dedupe)", async () => {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({}), dryRun: true };
  const bob = mkUser(db, 2, "bob", false);
  let ran = 0;
  const engine: ReviewEngine = { review: async () => (ran++, { findings: [], resolved: [] }) };
  await quiet(() => pollOnce(cfg, db, [bob], () => ({ token: async () => "t", gl: fakeGl(mr(1)), prepare })));
  assert.deepEqual(db.prepare(`SELECT status, error FROM reviews`).all(), [{ status: "skipped", error: SKIP_REASONS.no_token }]);
  assert.equal(reviewExists(db, 2, 1, "deadbeef00", true), false, "trigger may queue it");
  setClaudeToken(db, key, 2, TOKEN);
  await quiet(() => pollOnce(cfg, db, [getUserById(db, 2)!], () => ({ token: async () => "t", gl: fakeGl(mr(1)), prepare, engine })));
  assert.equal(ran, 1);
  assert.deepEqual(db.prepare(`SELECT status, attempts FROM reviews`).all(), [{ status: "done", attempts: 1 }]);
  await quiet(() => pollOnce(cfg, db, [getUserById(db, 2)!], () => ({ token: async () => "t", gl: fakeGl(mr(1)), prepare, engine })));
  assert.equal(ran, 1, "done row: dedupe holds");
});

test("claimReview: only no-engine skips are re-claimable, exactly once; other skips and done rows stay final", () => {
  const db = openDb(":memory:");
  const r = (mrId: number) => ({ ownerId: 1, projectId: 7, mrId, mrIid: mrId, headSha: "s", dryRun: true });
  recordSkip(db, r(1), SKIP_REASONS.no_token);
  recordSkip(db, r(1), SKIP_REASONS.token_invalid);
  assert.equal((db.prepare(`SELECT error FROM reviews WHERE mr_id=1`).get() as { error: string }).error, SKIP_REASONS.token_invalid, "reason updated, still one row");
  assert.equal(claimReview(db, r(1)), true);
  assert.equal(claimReview(db, r(1)), false, "second claimer loses");
  claimReview(db, r(2));
  finishReview(db, 1, 2, "s", true, "skipped", { error: "diff too large" });
  assert.equal(claimReview(db, r(2)), false);
  assert.equal(reviewExists(db, 1, 2, "s", true), true);
  recordSkip(db, r(2), SKIP_REASONS.no_token);
  assert.equal((db.prepare(`SELECT error FROM reviews WHERE mr_id=2`).get() as { error: string }).error, "diff too large", "never overwrites a real result");
});

// --- clones per user (a checkout is the agent's cwd for the whole review) ---

test("clone dir is per reviewer, and reviewMr passes the reviewer to prepareDiff", async () => {
  assert.notEqual(cloneDir("/d", 1, 7), cloneDir("/d", 2, 7));
  assert.equal(cloneDir("/d", 1, 7), join("/d", "clones", "u1", "7"));
  const db = openDb(":memory:");
  const u = mkUser(db, 5, "alice", true);
  let owner: number | undefined;
  await quiet(() => reviewMr({ ...loadConfig({}), dryRun: true }, db, u, { token: async () => "t", gl: fakeGl(mr(1)), engine: { review: async () => ({ findings: [], resolved: [] }) }, prepare: async (o) => ((owner = o.ownerId), prepare()) }, mr(1)));
  assert.equal(owner, 5);
});

// --- token format ---

test("Claude token format: oat accepted (trimmed); API key and junk rejected without echoing the input", () => {
  assert.equal(validateClaudeToken(`  ${TOKEN}\n`), TOKEN);
  const apiKey = "sk-ant-api03-SECRETVALUE1234567890abcdef";
  assert.throws(() => validateClaudeToken(apiKey), (e: Error) => /Anthropic API key，不是 Claude token/.test(e.message) && !e.message.includes("SECRETVALUE"));
  for (const bad of ["", "hello", "sk-ant-oat01-short", `sk-ant-oat01-${"a".repeat(30)} x`, `Bearer ${TOKEN}`, "sk-ant-admin01-xxxxxxxxxxxxxxxxxxxxxxxxx"]) {
    assert.throws(() => validateClaudeToken(bad), (e: Error) => !bad.trim() || !e.message.includes(bad.trim()), JSON.stringify(bad));
  }
  const db = openDb(":memory:");
  mkUser(db, 1, "a", false);
  assert.throws(() => setClaudeToken(db, key, 1, "nope"));
  assert.equal(getUserById(db, 1)!.claudeTokenEnc, null, "nothing written on error");
  setClaudeToken(db, key, 1, TOKEN);
  const u = getUserById(db, 1)!;
  assert.ok(!u.claudeTokenEnc!.includes(TOKEN), "stored encrypted");
  assert.ok(u.claudeTokenSetAt);
  assert.equal(claudeTokenDaysLeft({ claudeTokenSetAt: "2026-01-01 00:00:00" }, new Date("2026-12-02T00:00:00Z")), 30);
});

// --- web: settings (own token only) and /admin (status only) ---

function web(verify: (u: User, t: string) => Promise<ConnectionTest> = async () => ({ ok: true })) {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({ DATA_DIR: tmp(), GITLAB_URL: "https://gl.test", CLAUDE_BIN: "/nonexistent/claude" }), dryRun: true };
  const verified: string[] = [];
  const app = createApp({
    cfg, db, key, oauth: { gitlabUrl: "https://gl.test", redirectUri: "http://x/cb", clientId: "c", clientSecret: "s" },
    verifyClaudeToken: (u, t) => (verified.push(t), verify(u, t)),
  });
  const login = (id: number) => { const s = createSession(db, id); return { cookie: `sid=${s.id}`, csrf: s.csrf }; };
  const post = (path: string, s: { cookie: string; csrf: string }, fields: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ _csrf: s.csrf, ...fields }) });
  const get = async (path: string, s: { cookie: string }) => (await app.request(path, { headers: { cookie: s.cookie } })).text();
  return { db, app, login, post, get, verified };
}

test("settings: set / replace / delete own Claude token; never echoed; CSRF required; status shown", async () => {
  const w = web();
  mkUser(w.db, 2, "bob", false);
  const s = w.login(2);
  let html = await w.get("/settings", s);
  assert.match(html, /未設定/);
  assert.match(html, /目前不會審查/, "prominent notice without a token");
  assert.match(html, /加密存放在 Argus 伺服器/);
  assert.match(html, /你自己的<\/strong> Claude 訂閱/);
  assert.equal((await w.app.request("/settings/claude-token", { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ claude_token: TOKEN }) })).status, 403);
  assert.equal(getUserById(w.db, 2)!.claudeTokenEnc, null);
  const set = await w.post("/settings/claude-token", s, { claude_token: TOKEN });
  html = await set.text();
  assert.equal(set.status, 200);
  assert.ok(!html.includes(TOKEN), "not echoed after save");
  assert.match(html, /已設定（\d{4}-\d{2}-\d{2}）/);
  assert.deepEqual(w.verified, [TOKEN], "verified once before saving");
  const first = getUserById(w.db, 2)!.claudeTokenEnc!;
  html = await w.get("/settings", s);
  assert.ok(!html.includes(TOKEN));
  assert.match(html, /驗證並取代/);
  // replace (rate limit: one verify per 30 s)
  assert.equal((await w.post("/settings/claude-token", s, { claude_token: TOKEN2 })).status, 429);
  const w2 = web();
  mkUser(w2.db, 2, "bob", false);
  setClaudeToken(w2.db, key, 2, TOKEN);
  const s2 = w2.login(2);
  const before = getUserById(w2.db, 2)!.claudeTokenEnc!;
  const rep = await w2.post("/settings/claude-token", s2, { claude_token: TOKEN2 });
  assert.ok(!(await rep.text()).includes(TOKEN2));
  assert.ok(!getUserById(w2.db, 2)!.claudeTokenEnc!.equals(before), "replaced");
  // delete
  const del = await w.post("/settings/claude-token/delete", s);
  assert.equal(del.status, 200);
  assert.equal(getUserById(w.db, 2)!.claudeTokenEnc, null);
  assert.ok(first.length > 0);
});

test("settings: bad formats and a rejected token are not saved; errors never echo the input", async () => {
  const w = web(async () => ({ ok: false, rejected: true, error: "x" }));
  mkUser(w.db, 2, "bob", false);
  const s = w.login(2);
  const api = "sk-ant-api03-SECRETVALUE1234567890abcdef";
  const r1 = await (await w.post("/settings/claude-token", s, { claude_token: api })).text();
  assert.match(r1, /Anthropic API key，不是 Claude token/);
  assert.ok(!r1.includes("SECRETVALUE"));
  const r2 = await (await w.post("/settings/claude-token", s, { claude_token: "garbage-value-xyz" })).text();
  assert.match(r2, /格式不符/);
  assert.ok(!r2.includes("garbage-value-xyz"));
  assert.deepEqual(w.verified, [], "format errors never cost a model call");
  const r3 = await w.post("/settings/claude-token", s, { claude_token: TOKEN });
  assert.equal(r3.status, 400);
  assert.match(await r3.text(), /拒絕/);
  assert.equal(getUserById(w.db, 2)!.claudeTokenEnc, null);
});

test("settings: owner without token uses the container login; the page says so", async () => {
  const w = web();
  mkUser(w.db, 1, "boss", true);
  const html = await w.get("/settings", w.login(1));
  assert.match(html, /使用 owner 容器登入/);
  assert.doesNotMatch(html, /目前不會審查/);
});

test("/admin: per-user Claude token status + latest review (one row per user), no token/key strings, no Argus API key column", async () => {
  const w = web();
  mkUser(w.db, 1, "boss", true); // no token -> owner login
  mkUser(w.db, 2, "set", false);
  setClaudeToken(w.db, key, 2, TOKEN);
  mkUser(w.db, 3, "bad", false);
  setClaudeToken(w.db, key, 3, TOKEN2);
  w.db.prepare(`UPDATE users SET claude_token_invalid=1 WHERE gitlab_user_id=3`).run();
  mkUser(w.db, 4, "none", false);
  mkUser(w.db, 5, "old", false);
  setClaudeToken(w.db, key, 5, TOKEN);
  w.db.prepare(`UPDATE users SET claude_token_set_at=datetime('now', '-350 days') WHERE gitlab_user_id=5`).run();
  const argusKey = createApiKey(w.db, 2);
  // history: user 4 skipped (no token) after an older done row; user 2 done; user 3 failed
  const row = (owner: number, mrId: number, status: string, error: string | null) =>
    w.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, error) VALUES (?, 7, ?, 1, 's', 1, ?, ?)`).run(owner, mrId, status, error);
  row(4, 1, "done", null);
  row(4, 2, "skipped", SKIP_REASONS.no_token);
  row(2, 3, "done", null);
  row(3, 4, "failed", CLAUDE_TOKEN_REJECTED);
  const html = await w.get("/admin", w.login(1));
  const rowOf = (name: string) => html.match(new RegExp(`<tr><td>${name}</td>[\\s\\S]*?</tr>`))![0];
  assert.match(rowOf("boss"), /使用 owner 容器登入/);
  assert.match(rowOf("boss"), /尚無紀錄/);
  assert.match(rowOf("set"), /已設定（\d{4}-\d{2}-\d{2}）/);
  assert.match(rowOf("set"), /完成/);
  assert.match(rowOf("bad"), /失效/);
  assert.match(rowOf("bad"), /失敗/);
  assert.match(rowOf("none"), /badge-skipped">未設定</);
  assert.doesNotMatch(rowOf("none"), /owner 容器登入/);
  assert.match(rowOf("none"), /略過<\/span>（未設定 token）/);
  assert.doesNotMatch(rowOf("none"), /完成/, "latest row only");
  assert.match(rowOf("old"), /約 1[45] 天後到期/);
  assert.doesNotMatch(html, /Argus API key/, "no Argus API key column");
  for (const secret of [TOKEN, TOKEN2, argusKey, "gl-set", "gl-boss"]) assert.ok(!html.includes(secret), "no secret in /admin");
  // non-owner cannot see it
  assert.equal((await w.app.request("/admin", { headers: { cookie: w.login(2).cookie } })).status, 403);
});

// --- queue: per-user lanes, global cap, dedupe, accept vs review ordering ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("queue: global cap across lanes; each lane serial and in order; env REVIEW_CONCURRENCY", async () => {
  const q = new ReviewQueue(2);
  let active = 0, maxActive = 0;
  const perLane = new Map<number, number>();
  const order: string[] = [];
  const job = (lane: number, n: string) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    perLane.set(lane, (perLane.get(lane) ?? 0) + 1);
    assert.equal(perLane.get(lane), 1, `lane ${lane} overlapped`);
    await sleep(10);
    order.push(n);
    perLane.set(lane, perLane.get(lane)! - 1);
    active--;
  };
  for (let lane = 1; lane <= 4; lane++) for (const n of ["a", "b"]) q.enqueue(lane, `${lane}${n}`, job(lane, `${lane}${n}`));
  await q.idle();
  assert.equal(maxActive, 2, "global cap");
  assert.equal(order.length, 8);
  for (let lane = 1; lane <= 4; lane++) assert.ok(order.indexOf(`${lane}a`) < order.indexOf(`${lane}b`), "lane order");
  assert.equal(concurrencyFrom({}), 3);
  assert.equal(concurrencyFrom({ REVIEW_CONCURRENCY: "5" }), 5);
  for (const bad of ["0", "-1", "2.5", "x"]) assert.equal(concurrencyFrom({ REVIEW_CONCURRENCY: bad }), 3);
  assert.throws(() => new ReviewQueue(0));
});

test("queue: a failing job releases its slot and its lane continues", { timeout: 3000 }, async () => {
  const q = new ReviewQueue(1);
  const ran: string[] = [];
  const err = console.error;
  console.error = () => {};
  try {
    q.enqueue(1, "x", async () => { throw new Error("boom"); });
    q.enqueue(1, "y", async () => void ran.push("y"));
    q.enqueue(2, "z", async () => void ran.push("z"));
    await q.idle();
  } finally {
    console.error = err;
  }
  assert.deepEqual(ran.sort(), ["y", "z"]);
});

test("queue: an accept job of the same reviewer waits for that reviewer's running review; another reviewer is not blocked", async () => {
  const q = new ReviewQueue(3);
  const ev: string[] = [];
  q.enqueue(1, queueKey(1, 10, "s"), async () => { ev.push("review1:start"); await sleep(20); ev.push("review1:end"); });
  q.enqueue(1, "accept:1:10:1", async () => void ev.push("accept1"));
  q.enqueue(2, queueKey(2, 10, "s"), async () => { ev.push("review2:start"); await sleep(5); ev.push("review2:end"); });
  await q.idle();
  assert.ok(ev.indexOf("accept1") > ev.indexOf("review1:end"), "same reviewer: accept after review");
  assert.ok(ev.indexOf("review2:end") < ev.indexOf("review1:end"), "other reviewer ran in parallel");
});

test("lane rule: everyone on the owner's shared login shares ONE lane; personal-token and no-engine users get their own", () => {
  const L = (o: Partial<Parameters<typeof chooseEngine>[0]>, t: string[] = []) => laneFor({ ...base(o), gitlabUserId: 42 }, t);
  assert.equal(L({ isOwner: true }), SHARED_LOGIN_LANE, "owner on container login");
  assert.equal(L({ username: "bob" }, ["bob"]), SHARED_LOGIN_LANE, "whitelisted user borrowing the owner login");
  assert.equal(L({ isOwner: true, engine: "codex-cli" }), SHARED_LOGIN_LANE, "codex shares the owner's auth.json");
  assert.equal(L({ engine: "codex-cli" }, ["bob"]), SHARED_LOGIN_LANE);
  assert.equal(L({ isOwner: true, hasClaudeToken: true }), 42, "owner with own token");
  assert.equal(L({ hasClaudeToken: true }, ["bob"]), 42, "whitelisted user with own token");
  assert.equal(L({}), 42, "no engine: own lane (only records a skip)");
  assert.notEqual(SHARED_LOGIN_LANE, 1, "never collides with a GitLab user id");
});

test("accept watch queues its job in the same lane as the reviewer's reviews (shared lane on the owner login, else own)", async () => {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({}), dryRun: true };
  const run = async (u: User) => {
    claimReview(db, { ownerId: u.gitlabUserId, projectId: 7, mrId: 1, mrIid: 1, headSha: "deadbeef00", dryRun: true });
    finishReview(db, u.gitlabUserId, 1, "deadbeef00", true, "done", { findings: { findings: [{ severity: "major", file: "a.ts", title: "t", body: "b", confidence: 1 }], verdict: "request_changes", summaryOpen: [], unfixedPrev: [] } });
    const lanes: number[] = [];
    const spy = { enqueue: (lane: number) => (lanes.push(lane), { queued: true, done: Promise.resolve() }) } as unknown as ReviewQueue;
    await watchAccepts(cfg, db, u, { token: async () => "t", gl: fakeGl(mr(1)) }, [{ ...mr(1), user_notes_count: 1, updated_at: "x" } as MrSummary], spy, new Map());
    return lanes;
  };
  const owner = mkUser(db, 9, "boss", true);
  assert.deepEqual(await run(owner), [SHARED_LOGIN_LANE]);
  mkUser(db, 8, "bob", false);
  setClaudeToken(db, key, 8, TOKEN);
  assert.deepEqual(await run(getUserById(db, 8)!), [8]);
});

test("pollOnce: owner-login users never run at once (shared login); a personal-token user runs beside them", async () => {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({}), dryRun: true, ownerEngineTestUsers: ["tess"] };
  mkUser(db, 1, "boss", true);
  mkUser(db, 2, "tess", false);
  mkUser(db, 3, "tok", false);
  setClaudeToken(db, key, 3, TOKEN);
  let shared = 0, sharedMax = 0;
  const ev: string[] = [];
  const eng = (n: string, isShared: boolean): ReviewEngine => ({ review: async () => {
    if (isShared) { shared++; sharedMax = Math.max(sharedMax, shared); }
    ev.push(`${n}:start`); await sleep(15); ev.push(`${n}:end`);
    if (isShared) shared--;
    return { findings: [], resolved: [] };
  } });
  const users = [1, 2, 3].map((id) => getUserById(db, id)!);
  await quiet(() => pollOnce(cfg, db, users, (u) => ({ token: async () => "t", gl: fakeGl(mr(u.gitlabUserId)), prepare, engine: eng(u.username, u.gitlabUserId !== 3) }), new ReviewQueue(3)));
  assert.equal(sharedMax, 1, "owner + whitelisted user on the owner login: serial");
  assert.ok(ev.indexOf("tok:start") < Math.max(ev.indexOf("boss:end"), ev.indexOf("tess:end")), `token user not held back: ${ev}`);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM reviews WHERE status='done'`).get() as { n: number }).n, 3);
});

test("claimReview of a no-engine skip creates a NEW latest row (new id, fresh created_at): history, /admin and accept watch see it", () => {
  const db = openDb(":memory:");
  const r = (mrId: number) => ({ ownerId: 1, projectId: 7, mrId, mrIid: mrId, headSha: "s", dryRun: true });
  recordSkip(db, r(1), SKIP_REASONS.no_token);
  db.prepare(`UPDATE reviews SET created_at=datetime('now', '-40 days')`).run();
  const oldId = (db.prepare(`SELECT id FROM reviews`).get() as { id: number }).id;
  claimReview(db, r(2)); // a later review of another MR
  finishReview(db, 1, 2, "s", true, "done", { findings: { findings: [] } });
  assert.equal(claimReview(db, r(1)), true);
  const row = db.prepare(`SELECT id, status, error, created_at >= datetime('now', '-1 minute') AS fresh FROM reviews WHERE mr_id=1`).get() as { id: number; status: string; error: string | null; fresh: number };
  assert.deepEqual({ status: row.status, error: row.error, fresh: row.fresh }, { status: "running", error: null, fresh: 1 });
  assert.ok(row.id > oldId, "new id");
  assert.equal((db.prepare(`SELECT MAX(id) m FROM reviews WHERE owner_id=1`).get() as { m: number }).m, row.id, "/admin latest = this row");
  finishReview(db, 1, 1, "s", true, "done", { findings: { findings: [{ severity: "major", file: "a", title: "t", body: "b", confidence: 1 }] } });
  assert.ok(watchCandidates(db, 1, true).some((w) => w.mr_id === 1), "inside the accept watch's 30-day window");
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM reviews WHERE mr_id=1`).get() as { n: number }).n, 1, "replaced, not duplicated");
});

test("claim of a no-engine skip is atomic: if the INSERT fails, the DELETE is rolled back (the skip row survives)", () => {
  const db = openDb(":memory:");
  const r = { ownerId: 1, projectId: 7, mrId: 1, mrIid: 1, headSha: "s", dryRun: true };
  recordSkip(db, r, SKIP_REASONS.no_token);
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON reviews WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  assert.throws(() => claimReview(db, r), /boom/);
  assert.deepEqual(db.prepare(`SELECT status, error FROM reviews`).all(), [{ status: "skipped", error: SKIP_REASONS.no_token }]);
});

test("trigger queues an owner-login reviewer on the shared lane and a token reviewer on their own", async () => {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({}), dryRun: true };
  const boss = mkUser(db, 1, "boss", true);
  mkUser(db, 2, "tok", false);
  setClaudeToken(db, key, 2, TOKEN);
  const m = { ...mr(1), reviewers: [{ id: 1, username: "boss" }, { id: 2, username: "tok" }] } as MrSummary;
  const lanes: number[] = [];
  const spy = { enqueue: (lane: number) => (lanes.push(lane), { queued: true, done: Promise.resolve() }) } as unknown as ReviewQueue;
  const engine: ReviewEngine = { review: async () => ({ findings: [], resolved: [] }) };
  await quiet(() => triggerReviews({ cfg, db, queue: spy, runtimeFor: async () => ({ token: async () => "t", gl: fakeGl(m), engine }) }, boss, { path: "g/p", iid: 1 }));
  assert.deepEqual(lanes, [SHARED_LOGIN_LANE, 2]);
});

test("claimReview stays the gate even when the in-memory dedupe is bypassed (two queues): a head is reviewed once", async () => {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({}), dryRun: true };
  const u = mkUser(db, 1, "alice", true);
  let ran = 0;
  const rt: UserRuntime = { token: async () => "t", gl: fakeGl(mr(1)), prepare, engine: { review: async () => (ran++, await sleep(10), { findings: [], resolved: [] }) } };
  const q1 = new ReviewQueue(), q2 = new ReviewQueue();
  await quiet(async () => {
    q1.enqueue(1, queueKey(1, 1, "deadbeef00"), () => reviewMr(cfg, db, u, rt, mr(1)));
    q2.enqueue(1, queueKey(1, 1, "deadbeef00"), () => reviewMr(cfg, db, u, rt, mr(1)));
    await Promise.all([q1.idle(), q2.idle()]);
  });
  assert.equal(ran, 1, "claimReview is the atomic gate");
});

test("pollOnce: users run in parallel; a slow user does not hold back another's reviews", async () => {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({}), dryRun: true };
  const a = mkUser(db, 1, "alice", true), b = mkUser(db, 2, "bob", false);
  setClaudeToken(db, key, 2, TOKEN);
  const ev: string[] = [];
  const eng = (n: string, ms: number): ReviewEngine => ({ review: async () => { ev.push(`${n}:start`); await sleep(ms); ev.push(`${n}:end`); return { findings: [], resolved: [] }; } });
  await quiet(() => pollOnce(cfg, db, [a, getUserById(db, 2)!], (u) => ({ token: async () => "t", gl: fakeGl(mr(u.gitlabUserId)), prepare, engine: u.gitlabUserId === 1 ? eng("a", 30) : eng("b", 5) }), new ReviewQueue(3)));
  assert.ok(ev.indexOf("b:start") < ev.indexOf("a:end"), JSON.stringify(ev));
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM reviews WHERE status='done'`).get() as { n: number }).n, 2);
  assert.equal(b.gitlabUserId, 2);
});
