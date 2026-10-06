import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.ts";
import { lastModelUsed, openDb, type Db } from "../src/db.ts";
import { parseClaudeAuth, claudeAuthStatus, claudeTestConnection, codexLoginStatus, ttlCache } from "../src/engine-status.ts";
import { ClaudeCliEngine, engineFor, extractModel, type ReviewEngine, type ReviewInput } from "../src/engine.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { reviewMr, type UserRuntime } from "../src/review.ts";
import { createSession } from "../src/sessions.ts";
import { addUser, bootstrapOwner, getUser, setUser, upsertOAuthUser } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const key = randomBytes(32);
const tmp = () => mkdtempSync(join(tmpdir(), "model-"));
const skillPath = join(tmp(), "SKILL.md");
writeFileSync(skillPath, "SKILL-CRITERIA");

const RESULT = (model: Record<string, number> = { "claude-opus-5-5": 50 }) =>
  JSON.stringify({ type: "result", is_error: false, result: '{"findings":[],"resolved":[]}', modelUsage: Object.fromEntries(Object.entries(model).map(([k, o]) => [k, { outputTokens: o }])) });

/** Fake `claude`: `auth status` prints auth.out and exits auth.rc; anything else records its args and prints run.out. */
function fakeClaude(o: { auth?: string; rc?: number; run?: string } = {}) {
  const dir = tmp();
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nD=$(dirname "$0")\nif [ "$1" = auth ]; then cat "$D/auth.out"; exit $(cat "$D/auth.rc"); fi\nprintf '%s\\n' "$@" > "$D/args.txt"\ncat > /dev/null\ncat "$D/run.out"\n`);
  chmodSync(bin, 0o755);
  const set = (name: string, v: string) => writeFileSync(join(dir, name), v);
  set("auth.out", o.auth ?? "{}");
  set("auth.rc", String(o.rc ?? 0));
  set("run.out", o.run ?? RESULT());
  return { bin, set, args: () => readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n") };
}

const LOGGED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "alice@example.com", orgId: "org-secret-id", orgName: "Example Org", subscriptionType: "team", accessToken: "sk-ant-SECRET" });
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: "none" });

// --- model field ---

test("model column: legacy DBs migrate to NULL; NULL/opus/sonnet/haiku accepted; junk rejected without writing", () => {
  const f = join(tmp(), "legacy.db");
  const old = new Database(f);
  old.exec(`CREATE TABLE users (gitlab_user_id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, token_enc BLOB NOT NULL, token_expires_at TEXT,
    skill_path TEXT NOT NULL, severity_threshold TEXT NOT NULL DEFAULT 'minor', confidence_threshold REAL NOT NULL DEFAULT 0.7,
    language TEXT NOT NULL DEFAULT 'zh-TW', enabled INTEGER NOT NULL DEFAULT 1, is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (gitlab_user_id, username, token_enc, skill_path, is_owner) VALUES (1, 'old', x'00', '/s', 1);
    CREATE TABLE reviews (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, project_id INTEGER NOT NULL, mr_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL, head_sha TEXT NOT NULL,
      dry_run INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, findings_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), mr_url TEXT, UNIQUE (owner_id, mr_id, head_sha, dry_run));
    INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status) VALUES (1, 1, 1, 1, 'a', 0, 'done');`);
  old.close();
  const db = openDb(f);
  assert.equal(getUser(db, "old")!.model, null);
  assert.equal(lastModelUsed(db, 1), undefined);
  for (const m of ["opus", "sonnet", "haiku"]) {
    setUser(db, "old", [`model=${m}`]);
    assert.equal(getUser(db, "old")!.model, m);
  }
  setUser(db, "old", ["model="]);
  assert.equal(getUser(db, "old")!.model, null);
  setUser(db, "old", ["model=haiku"]);
  for (const bad of ["model=Opus", "model=gpt-5", "model=claude-opus-5-5", "model=opus --x"]) assert.throws(() => setUser(db, "old", ["language=en", bad]), /model 必須是/);
  assert.equal(getUser(db, "old")!.model, "haiku");
  assert.equal(getUser(db, "old")!.language, "zh-TW", "validation failure writes nothing");
});

test("--model is passed only when a model is set (ClaudeCliEngine and engineFor)", async () => {
  const input: ReviewInput = { cwd: tmp(), mrTitle: "t", mrDescription: "", diff: "+x", incremental: false, language: "en" };
  const fc = fakeClaude();
  await new ClaudeCliEngine({ claudeBin: fc.bin, skillPath }).review(input);
  assert.ok(!fc.args().includes("--model"));
  await new ClaudeCliEngine({ claudeBin: fc.bin, skillPath, model: null }).review(input);
  assert.ok(!fc.args().includes("--model"));
  await new ClaudeCliEngine({ claudeBin: fc.bin, skillPath, model: "sonnet" }).review(input);
  const a = fc.args();
  assert.equal(a[a.indexOf("--model") + 1], "sonnet");
  assert.ok(a.includes("--strict-mcp-config") && a.includes("--tools"), "read-only flags unchanged");
  // via engineFor
  await engineFor({ isOwner: true, skillPath, username: "o", engine: "claude-cli", model: "haiku" }, fc.bin)!.review(input);
  assert.equal(fc.args()[fc.args().indexOf("--model") + 1], "haiku");
});

// --- actual model ---

test("extractModel: primary = most output tokens among modelUsage keys; falls back to model; never throws", () => {
  assert.equal(extractModel(RESULT({ "claude-opus-5-5": 900, "claude-haiku-4-5-20251001": 40 })), "claude-opus-5-5");
  assert.equal(extractModel(RESULT({ "claude-haiku-4-5-20251001": 900, "claude-opus-5-5": 40 })), "claude-haiku-4-5-20251001");
  assert.equal(extractModel(JSON.stringify([{ type: "system" }, JSON.parse(RESULT({ "claude-sonnet-5": 1 })) ])), "claude-sonnet-5");
  assert.equal(extractModel('{"type":"result","result":"x","model":"claude-x"}'), "claude-x");
  assert.equal(extractModel('{"type":"result","result":"x"}'), undefined);
  assert.equal(extractModel("not json"), undefined);
  assert.equal(extractModel(RESULT({ "bad model\n<script>": 1 })), undefined, "non-plain ids are dropped");
});

test("engine returns the CLI-reported model alongside the review", async () => {
  const fc = fakeClaude({ run: RESULT({ "claude-opus-5-5": 7 }) });
  const input: ReviewInput = { cwd: tmp(), mrTitle: "t", mrDescription: "", diff: "+x", incremental: false, language: "en" };
  const r = await new ClaudeCliEngine({ claudeBin: fc.bin, skillPath }).review(input);
  assert.equal(r.model, "claude-opus-5-5");
  assert.deepEqual(r.findings, []);
});

// --- persisted + rendered: history, settings, summary footer ---

function reviewRig(language = "zh-TW") {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
  setUser(db, "alice", [`language=${language}`]);
  const user = getUser(db, "alice")!;
  const base: MrSummary = { id: 100, iid: 5, project_id: 7, title: "t", description: "", sha: "a".repeat(40), web_url: "https://gl.test/g/p/-/merge_requests/5", target_branch: "main" };
  const gl = {
    getMr: async () => ({ ...base, diff_refs: { base_sha: "b", start_sha: "b", head_sha: base.sha } }),
    getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [],
    postNote: async () => assert.fail("dry-run"),
    postDiscussion: async () => assert.fail("dry-run"),
  } as unknown as GitLab;
  const engine: ReviewEngine = { review: async () => ({ findings: [], resolved: [], model: "claude-opus-5-5" }) };
  const rt: UserRuntime = { token: async () => "t", gl, engine, prepare: async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false }) };
  const run = async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      await reviewMr({ ...loadConfig({}), dryRun: true }, db, user, rt, base);
    } finally {
      console.log = log;
    }
    return out.join("\n");
  };
  return { db, run };
}

const webApp = (db: Db, env: Record<string, string> = {}, claudeBin = "/nonexistent/claude") => {
  const cfg = { ...loadConfig({ DATA_DIR: tmp(), GITLAB_URL: "https://gl.test", CLAUDE_BIN: claudeBin, CODEX_BIN: "/nonexistent/codex", ...env }), dryRun: true };
  const oauth = { gitlabUrl: "https://gl.test", redirectUri: "http://localhost:3000/auth/callback", clientId: "c", clientSecret: "s" };
  const app = createApp({ cfg, db, key, oauth });
  const login = (id: number) => {
    const s = createSession(db, id);
    return { cookie: `sid=${s.id}`, csrf: s.csrf };
  };
  const post = (path: string, s: { cookie: string; csrf: string }, fields: Record<string, string> = {}, csrf: string | null = s.csrf) =>
    app.request(path, { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ ...(csrf === null ? {} : { _csrf: csrf }), ...fields }) });
  const get = (path: string, s: { cookie: string }) => app.request(path, { headers: { cookie: s.cookie } });
  return { app, login, post, get };
};

test("actual model: stored per review, shown in history, settings and the GitLab summary footer (zh + en)", async () => {
  const zh = reviewRig("zh-TW");
  const out = await zh.run();
  assert.match(out, /<sub>使用模型: claude-opus-5-5<\/sub>/);
  assert.equal(lastModelUsed(zh.db, 1), "claude-opus-5-5");
  const { login, get } = webApp(zh.db);
  const s = login(1);
  const hist = await (await get("/reviews", s)).text();
  assert.match(hist, /<th scope="col">Model<\/th>/);
  assert.match(hist, /<code>claude-opus-5-5<\/code>/);
  assert.match(await (await get("/settings", s)).text(), /最近一次實際使用：claude-opus-5-5/);
  assert.match(await reviewRig("en").run(), /<sub>model: claude-opus-5-5<\/sub>/);
  // no recorded model -> neutral text, no footer
  const fresh = openDb(":memory:");
  addUser(fresh, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
  assert.match(await (await webApp(fresh).get("/settings", webApp(fresh).login(1))).text(), /尚無紀錄/);
});

test("settings: model select validated server-side, persisted, kept when absent, disabled for codex-cli", async () => {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
  const { login, get, app } = webApp(db);
  const s = login(1);
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ _csrf: s.csrf, severity_threshold: "minor", confidence_threshold: "0.7", language: "zh-TW", ...fields })) fd.set(k, v);
    return app.request("/settings", { method: "POST", headers: { cookie: s.cookie }, body: fd });
  };
  let html = await (await get("/settings", s)).text();
  assert.match(html, /<option value="" selected[^>]*>CLI 預設<\/option>/);
  for (const l of ["Opus", "Sonnet", "Haiku"]) assert.match(html, new RegExp(`>${l}</option>`));
  assert.equal((await form({ model: "sonnet" })).status, 200);
  assert.equal(getUser(db, "alice")!.model, "sonnet");
  assert.match(await (await get("/settings", s)).text(), /<option value="sonnet" selected[^>]*>Sonnet<\/option>/);
  assert.equal((await form({ model: "gpt-5" })).status, 400);
  assert.equal(getUser(db, "alice")!.model, "sonnet");
  assert.equal((await form({})).status, 200); // field absent (disabled select) keeps the value
  assert.equal(getUser(db, "alice")!.model, "sonnet");
  assert.equal((await form({ model: "" })).status, 200);
  assert.equal(getUser(db, "alice")!.model, null);
  setUser(db, "alice", ["engine=codex-cli"]);
  html = await (await get("/settings", s)).text();
  assert.match(html, /<select id="model"[^>]* disabled/);
  assert.match(html, /不適用/);
});

// --- engine status card ---

test("claude auth status parsing: logged in (masked, whitelisted), logged out, garbage, command missing", async () => {
  const a = parseClaudeAuth(LOGGED_IN);
  assert.deepEqual(a, { state: "logged-in", authMethod: "claude.ai", subscription: "team", email: "a***@example.com" });
  assert.doesNotMatch(JSON.stringify(a), /SECRET|org-secret|michael@/);
  assert.deepEqual(parseClaudeAuth(LOGGED_OUT), { state: "logged-out" });
  assert.equal(parseClaudeAuth("nope").state, "error");
  assert.equal(parseClaudeAuth("{}").state, "error");
  assert.equal((await claudeAuthStatus(fakeClaude({ auth: LOGGED_IN }).bin)).state, "logged-in");
  assert.equal((await claudeAuthStatus(fakeClaude({ auth: LOGGED_OUT, rc: 1 }).bin)).state, "logged-out"); // real CLI exits 1 when logged out
  assert.equal((await claudeAuthStatus("/nonexistent/claude")).state, "missing");
  assert.equal((await claudeAuthStatus(fakeClaude({ auth: "", rc: 3 }).bin)).state, "error");
  assert.equal((await codexLoginStatus("/nonexistent/codex")).state, "missing");
});

test("ttlCache: reuses within the TTL, refetches after it or when forced", async () => {
  let t = 0;
  let n = 0;
  const get = ttlCache(60_000, async () => ++n, () => t);
  assert.deepEqual([await get(), await get()], [1, 1]);
  t = 59_999;
  assert.equal(await get(), 1);
  t = 60_000;
  assert.equal(await get(), 2);
  assert.equal(await get(true), 3);
});

function adminRig(fc = fakeClaude({ auth: LOGGED_IN }), env: Record<string, string> = {}) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "owner", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
  addUser(db, key, { gitlabUserId: 2, username: "bob", token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  return { db, fc, ...webApp(db, env, fc.bin) };
}

test("/admin status card: logged in is masked and leak-free; logged out shows the login steps; cached 60s", async () => {
  const r = adminRig();
  const owner = r.login(1);
  let html = await (await r.get("/admin", owner)).text();
  assert.match(html, /已登入/);
  assert.match(html, /a\*\*\*@example\.com/);
  assert.doesNotMatch(html, /SECRET|org-secret|alice@example/);
  assert.match(html, /選用。沒有使用者採用 codex-cli/);
  r.fc.set("auth.out", LOGGED_OUT);
  r.fc.set("auth.rc", "1");
  assert.match(await (await r.get("/admin", owner)).text(), /已登入/, "cached");
  html = await (await r.get("/admin?refresh=1", owner)).text();
  assert.doesNotMatch(html, /已登入/);
  assert.match(html, /未登入/);
  assert.match(html, /<pre[^>]*>claude<\/pre>/); // default deploy=local; per-deploy commands: commands.test.tsx
  assert.match(html, /\/login/);
  assert.match(html, /href="\/docs\/setup"/);
  assert.equal((await r.get("/admin", r.login(2))).status, 403);
});

test("/admin status card: missing claude binary; codex status only when a user runs codex-cli", async () => {
  const r = adminRig(fakeClaude(), {});
  const missing = webApp(r.db, {}, "/nonexistent/claude");
  assert.match(await (await missing.get("/admin", missing.login(1))).text(), /找不到 claude/);
  setUser(r.db, "bob", ["engine=codex-cli"]);
  assert.match(await (await missing.get("/admin", missing.login(1))).text(), /找不到 codex/);
});

test("POST /admin/engine/test: owner-only, CSRF, rate-limited 1/30s, shows model; failure reported", async () => {
  const r = adminRig(fakeClaude({ auth: LOGGED_IN, run: RESULT({ "claude-opus-5-5": 3 }) }));
  const owner = r.login(1);
  const bob = r.login(2);
  assert.equal((await r.post("/admin/engine/test", bob)).status, 403);
  assert.equal((await r.post("/admin/engine/test", owner, {}, null)).status, 403);
  assert.equal((await r.post("/admin/engine/test", owner, {}, "wrong")).status, 403);
  assert.equal((await r.app.request("/admin/engine/test", { method: "POST" })).status, 302); // anonymous -> login
  const ok = await r.post("/admin/engine/test", owner);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /測試成功/);
  assert.match(html, /<code>claude-opus-5-5<\/code>/);
  assert.ok(r.fc.args().includes("--strict-mcp-config") && r.fc.args().includes("Read,Grep,Glob"), "same read-only flags as reviews");
  assert.equal((await r.post("/admin/engine/test", owner)).status, 429);
  assert.equal((await r.get("/admin/engine/test", owner)).status, 404); // GET is not a route

  const bad = adminRig(fakeClaude({ run: JSON.stringify({ type: "result", is_error: true, result: "Invalid API key" }) }));
  const res = await bad.post("/admin/engine/test", bad.login(1));
  assert.match(await res.text(), /測試失敗/);
  const direct = await claudeTestConnection("/nonexistent/claude");
  assert.equal(direct.ok, false);
});

// --- owner bootstrap ---

test("bootstrapOwner matrix: match+no owner -> owner; match+owner exists -> unchanged+warn; mismatch/unset -> pending; case-insensitive", () => {
  const mk = (db: Db, id: number, name: string) => upsertOAuthUser(db, key, { gitlabUserId: id, username: name, accessToken: "a", refreshToken: "r", accessExpiresAt: 1 });
  const warns: string[] = [];
  const warn = (m: string) => void warns.push(m);
  const quiet = console.log;
  console.log = () => {};
  try {
    // match, no owner yet (case differs)
    let db = openDb(":memory:");
    let u = bootstrapOwner(db, mk(db, 1, "Alice"), "alice", warn);
    assert.deepEqual([u.isOwner, u.approved, u.enabled], [true, true, true]);
    assert.equal(getUser(db, "Alice")!.isOwner, true);
    // already the owner: no-op, no warning
    assert.equal(bootstrapOwner(db, getUser(db, "Alice")!, "ALICE", warn).isOwner, true);
    assert.deepEqual(warns, []);
    // owner exists: ARGUS_OWNER ignored for someone else, with a warning
    u = bootstrapOwner(db, mk(db, 2, "bob"), "bob", warn);
    assert.deepEqual([u.isOwner, u.approved, u.enabled], [false, false, false]);
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /ignored/);
    // mismatch / unset: nobody is promoted, not even the first login
    db = openDb(":memory:");
    assert.equal(bootstrapOwner(db, mk(db, 3, "carol"), "alice", warn).isOwner, false);
    assert.equal(bootstrapOwner(db, mk(db, 4, "dave"), undefined, warn).isOwner, false);
    assert.equal(bootstrapOwner(db, mk(db, 5, "alicex"), "alice", warn).isOwner, false);
    assert.equal(warns.length, 1);
  } finally {
    console.log = quiet;
  }
  assert.equal(loadConfig({ ARGUS_OWNER: " @Alice " }).ownerRef, "Alice");
  assert.equal(loadConfig({}).ownerRef, undefined);
});

test("OAuth callback with ARGUS_OWNER: the named user becomes owner; others stay pending; pending page hints when no owner exists", async () => {
  const run = async (env: Record<string, string>, username: string, id: number, db = openDb(":memory:")) => {
    const cfg = { ...loadConfig({ DATA_DIR: tmp(), GITLAB_URL: "https://gl.test", ...env }), dryRun: true };
    const fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("/oauth/token")
        ? Response.json({ access_token: "at", refresh_token: "rt", expires_in: 7200 })
        : Response.json({ id, username })) as typeof globalThis.fetch;
    const oauth = { gitlabUrl: "https://gl.test", redirectUri: "http://localhost:3000/auth/callback", clientId: "c", clientSecret: "s", fetch };
    const app = createApp({ cfg, db, key, oauth });
    const res = await app.request("/auth/callback?state=s1&code=c", { headers: { cookie: "oauth_state=s1; oauth_verifier=v" } });
    assert.equal(res.status, 302);
    const sid = res.headers.getSetCookie().find((c) => c.startsWith("sid="))!.split(";")[0]!;
    return { db, app, sid };
  };
  const quiet = console.log;
  console.log = () => {};
  try {
    const a = await run({ ARGUS_OWNER: "Alice" }, "alice", 10);
    assert.equal(getUser(a.db, "alice")!.isOwner, true);
    assert.equal((await a.app.request("/admin", { headers: { cookie: a.sid } })).status, 200);
    const b = await run({ ARGUS_OWNER: "alice" }, "mallory", 11);
    assert.equal(getUser(b.db, "mallory")!.isOwner, false);
    const pending = await (await b.app.request("/pending", { headers: { cookie: b.sid } })).text();
    assert.match(pending, /尚未設定 owner/);
    assert.match(pending, /ARGUS_OWNER/);
    // an owner exists -> the hint is gone, normal waiting text
    addUser(b.db, key, { gitlabUserId: 1, username: "boss", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
    const later = await (await b.app.request("/pending", { headers: { cookie: b.sid } })).text();
    assert.doesNotMatch(later, /尚未設定 owner/);
    // owner already exists before the named user logs in: not promoted
    const db = openDb(":memory:");
    addUser(db, key, { gitlabUserId: 1, username: "boss", token: "t", tokenExpiresAt: null, skillPath, isOwner: true });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const c = await run({ ARGUS_OWNER: "alice" }, "alice", 12, db);
      assert.equal(getUser(c.db, "alice")!.isOwner, false);
    } finally {
      console.warn = warn;
    }
  } finally {
    console.log = quiet;
  }
});

test("bootstrapOwner: a numeric ARGUS_OWNER matches the immutable GitLab user id, never a username", () => {
  const db = openDb(":memory:");
  const mk2 = (id: number, name: string) => {
    upsertOAuthUser(db, key, { gitlabUserId: id, username: name, accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
    return getUser(db, name)!;
  };
  const warn = () => {};
  assert.equal(bootstrapOwner(db, mk2(7, "153"), "153", warn).isOwner, false); // username "153" is not id 153
  assert.equal(bootstrapOwner(db, mk2(153, "renamed"), "153", warn).isOwner, true);
});

test("ttlCache shares one in-flight lookup and does not cache failures", async () => {
  const { ttlCache } = await import("../src/engine-status.ts");
  let calls = 0;
  let fail = true;
  const c = ttlCache(60_000, async () => { calls++; await new Promise((r) => setTimeout(r, 5)); if (fail) throw new Error("x"); return calls; });
  await Promise.allSettled([c(), c(), c()]);
  assert.equal(calls, 1);
  fail = false;
  assert.equal(await c(), 2); // the failure was not cached
  assert.equal(await c(), 2); // the success is
});
