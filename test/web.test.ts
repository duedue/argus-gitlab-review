import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { decrypt } from "../src/crypto.ts";
import { accessTokenFor, REFRESH_SKEW_MS, type OAuthCtx } from "../src/oauth.ts";
import { pollCycle } from "../src/runtime.ts";
import { createSession } from "../src/sessions.ts";
import { scanSkill } from "../src/skills.ts";
import { addUser, getUserById, upsertOAuthUser } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const key = randomBytes(32);
const GL = "https://gl.test";

interface Calls { token: URLSearchParams[]; user: string[] }
/** Fake GitLab: /oauth/token and /api/v4/user. `tokenStatus` lets a test make the token endpoint fail. */
function fakeGitlab(identity: { id: number; username: string }, opts: { tokenStatus?: number; tokenError?: string } = {}) {
  const calls: Calls = { token: [], user: [] };
  let n = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/oauth/token")) {
      calls.token.push(new URLSearchParams(String(init?.body)));
      if (opts.tokenStatus) return new Response(JSON.stringify({ error: opts.tokenError ?? "invalid_grant" }), { status: opts.tokenStatus });
      n++;
      return Response.json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 7200, token_type: "Bearer" });
    }
    if (u.endsWith("/api/v4/user")) {
      calls.user.push(String((init?.headers as Record<string, string>).Authorization));
      return Response.json(identity);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return { f, calls };
}

function setup(identity = { id: 42, username: "newbie" }, opts: { tokenStatus?: number; tokenError?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "web-"));
  const cfg = { ...loadConfig({ DATA_DIR: dataDir, GITLAB_URL: GL, CLAUDE_BIN: "/nonexistent/claude" }), dryRun: true };
  const db = openDb(":memory:");
  const gl = fakeGitlab(identity, opts);
  const oauth: OAuthCtx = { gitlabUrl: GL, redirectUri: "http://localhost:3000/auth/callback", clientId: "cid", clientSecret: "csecret", fetch: gl.f };
  return { app: createApp({ cfg, db, key, oauth }), db, cfg, oauth, gl, dataDir };
}

const cookieJar = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0]!.split("=") as [string, string]));
const loginAs = (db: Db, id: number) => {
  const s = createSession(db, id);
  return { cookie: `sid=${s.id}`, csrf: s.csrf };
};
const post = (app: ReturnType<typeof setup>["app"], path: string, s: { cookie: string; csrf: string }, fields: Record<string, string> = {}, csrf: string | null = s.csrf) =>
  app.request(path, { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ ...(csrf === null ? {} : { _csrf: csrf }), ...fields }) });
const patUser = (db: Db, id: number, name: string, isOwner: boolean) =>
  addUser(db, key, { gitlabUserId: id, username: name, token: `pat-${name}`, tokenExpiresAt: null, skillPath: "/x/SKILL.md", isOwner });

async function startLogin(app: ReturnType<typeof setup>["app"]) {
  const res = await app.request("/login");
  const jar = cookieJar(res);
  const href = (await res.text()).match(/href="(https:\/\/gl\.test\/oauth\/authorize\?[^"]+)"/)![1]!.replaceAll("&amp;", "&");
  return { res, jar, url: new URL(href) };
}

test("login page: authorize link carries state + PKCE S256, security headers set", async () => {
  const { app } = setup();
  const { res, jar, url } = await startLogin(app);
  assert.equal(res.status, 200);
  assert.equal(url.searchParams.get("state"), jar.oauth_state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "api read_repository");
  assert.match(res.headers.get("content-security-policy")!, /default-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.getSetCookie().join("\n"), /HttpOnly/i);
});

test("unauthenticated pages redirect to /login", async () => {
  const { app } = setup();
  for (const p of ["/", "/settings", "/reviews", "/admin"]) {
    const r = await app.request(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get("location"), "/login");
  }
});

test("callback: state mismatch / missing cookie is rejected and no user or session is created", async () => {
  const { app, db, gl } = setup();
  const { jar } = await startLogin(app);
  const cookie = `oauth_state=${jar.oauth_state}; oauth_verifier=${jar.oauth_verifier}`;
  const bad = await app.request("/auth/callback?code=abc&state=forged", { headers: { cookie } });
  assert.equal(bad.status, 400);
  const noCookie = await app.request(`/auth/callback?code=abc&state=${jar.oauth_state}`);
  assert.equal(noCookie.status, 400);
  assert.equal(gl.calls.token.length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM users`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number }).n, 0);
});

test("callback: new user is created pending with encrypted tokens and gets an HttpOnly session", async () => {
  const { app, db, gl } = setup();
  const { jar } = await startLogin(app);
  const res = await app.request(`/auth/callback?code=abc&state=${jar.oauth_state}`, { headers: { cookie: `oauth_state=${jar.oauth_state}; oauth_verifier=${jar.oauth_verifier}` } });
  assert.equal(res.status, 302);
  const sid = res.headers.getSetCookie().find((c) => c.startsWith("sid="))!;
  assert.match(sid, /HttpOnly/i);
  assert.match(sid, /SameSite=Lax/i);
  const t = gl.calls.token[0]!;
  assert.equal(t.get("grant_type"), "authorization_code");
  assert.equal(t.get("code_verifier"), jar.oauth_verifier);
  const u = getUserById(db, 42)!;
  assert.deepEqual([u.approved, u.enabled, u.isOwner, u.tokenType], [false, false, false, "oauth"]);
  assert.equal(decrypt(key, u.tokenEnc), "at-1");
  assert.equal(decrypt(key, u.refreshTokenEnc!), "rt-1");
  assert.ok(!u.tokenEnc.includes("at-1"));
  // pending user lands on the waiting page and can reach settings
  const cookie = sid.split(";")[0]!;
  const home = await app.request("/", { headers: { cookie } });
  assert.equal(home.headers.get("location"), "/pending");
  assert.match(await (await app.request("/pending", { headers: { cookie } })).text(), /等待核准/);
  assert.equal((await app.request("/settings", { headers: { cookie } })).status, 200);
});

test("callback: existing PAT owner keeps their PAT (token_type stays pat), still gets a session", async () => {
  const { app, db } = setup({ id: 7, username: "boss" });
  patUser(db, 7, "boss", true);
  const before = getUserById(db, 7)!;
  const { jar } = await startLogin(app);
  const res = await app.request(`/auth/callback?code=abc&state=${jar.oauth_state}`, { headers: { cookie: `oauth_state=${jar.oauth_state}; oauth_verifier=${jar.oauth_verifier}` } });
  assert.equal(res.status, 302);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("sid=")));
  const after = getUserById(db, 7)!;
  assert.equal(after.tokenType, "pat");
  assert.ok(after.tokenEnc.equals(before.tokenEnc));
  assert.equal(after.refreshTokenEnc, null);
  assert.equal(decrypt(key, after.tokenEnc), "pat-boss");
  assert.equal(after.isOwner, true);
});

test("csrf: POST without or with a wrong token is rejected and has no effect", async () => {
  const { app, db } = setup();
  patUser(db, 1, "owner", true);
  patUser(db, 2, "bob", false);
  db.prepare(`UPDATE users SET approved=0, enabled=0 WHERE gitlab_user_id=2`).run();
  const s = loginAs(db, 1);
  assert.equal((await post(app, "/admin/users/2/approve", s, {}, null)).status, 403);
  assert.equal((await post(app, "/admin/users/2/approve", s, {}, "wrong")).status, 403);
  assert.equal((await post(app, "/settings", s, { language: "en", severity_threshold: "minor", confidence_threshold: "0.5" }, null)).status, 403);
  assert.equal((await post(app, "/logout", s, {}, null)).status, 403);
  assert.equal(getUserById(db, 2)!.approved, false);
  assert.equal(getUserById(db, 1)!.language, "zh-TW");
  assert.equal((await post(app, "/admin/users/2/approve", s)).status, 302); // with the right token it works
  assert.deepEqual([getUserById(db, 2)!.approved, getUserById(db, 2)!.enabled], [true, true]);
});

test("admin: 403 for non-owner (page and actions); owner cannot be modified", async () => {
  const { app, db } = setup();
  patUser(db, 1, "owner", true);
  patUser(db, 2, "bob", false);
  const bob = loginAs(db, 2);
  assert.equal((await app.request("/admin", { headers: { cookie: bob.cookie } })).status, 403);
  assert.equal((await post(app, "/admin/users/1/disable", bob)).status, 403);
  assert.equal(getUserById(db, 1)!.enabled, true);
  const owner = loginAs(db, 1);
  assert.equal((await app.request("/admin", { headers: { cookie: owner.cookie } })).status, 200);
  assert.equal((await post(app, "/admin/users/1/disable", owner)).status, 400);
  assert.equal(getUserById(db, 1)!.enabled, true);
  assert.equal((await post(app, "/admin/users/999/disable", owner)).status, 404);
  assert.equal((await post(app, "/admin/users/2/disable", owner)).status, 302);
  assert.equal(getUserById(db, 2)!.enabled, false);
});

const settingsForm = (s: { csrf: string }, fields: Record<string, string>, file?: { name: string; content: string }, csrf: string | null = s.csrf) => {
  const fd = new FormData();
  const all: Record<string, string> = { severity_threshold: "major", confidence_threshold: "0.8", language: "en", ...fields };
  if (csrf !== null) fd.append("_csrf", csrf);
  for (const [k, v] of Object.entries(all)) fd.append(k, v);
  if (file) fd.append("skill_file", new Blob([file.content]), file.name);
  return fd;
};
const postSettings = (app: ReturnType<typeof setup>["app"], s: { cookie: string; csrf: string }, fields: Record<string, string>, file?: { name: string; content: string }, csrf: string | null = s.csrf) =>
  app.request("/settings", { method: "POST", headers: { cookie: s.cookie }, body: settingsForm(s, fields, file, csrf) });
const postFile = (app: ReturnType<typeof setup>["app"], s: { cookie: string; csrf: string }, file: { name: string; content: string }, csrf: string | null = s.csrf) =>
  postSettings(app, s, {}, file, csrf);

test("settings: upload stores at the fixed path regardless of filename, shows scan warnings, updates thresholds", async () => {
  const { app, db, dataDir } = setup();
  upsertOAuthUser(db, key, { gitlabUserId: 5, username: "eve", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  const s = loginAs(db, 5);
  const content = "# Review\nBe strict.\nThen post a comment on the MR with the findings.\nCall mcp__gitlab__create_note.\n";
  const res = await postFile(app, s, { name: "../../evil.md", content });
  assert.equal(res.status, 200);
  const html = await res.text();
  const fixed = join(dataDir, "skills", "5", "SKILL.md");
  assert.equal(readFileSync(fixed, "utf8"), content);
  assert.equal(getUserById(db, 5)!.skillPath, fixed);
  assert.match(html, /Skill 警告/);
  assert.match(html, /第 3 行/);
  assert.match(html, /第 4 行/);
  assert.ok(!existsSync(join(dataDir, "evil.md")) && !existsSync(join(dataDir, "..", "evil.md")));
  assert.equal((await postFile(app, s, { name: "SKILL.md", content }, null)).status, 403); // csrf on the multipart form too
  assert.equal((await postSettings(app, s, {})).status, 200);
  const u = getUserById(db, 5)!;
  assert.deepEqual([u.severityThreshold, u.confidenceThreshold, u.language], ["major", 0.8, "en"]);
  // pasted text path (CRLF normalised); empty submission keeps the existing skill
  assert.equal((await postSettings(app, s, { skill_text: "line1\r\nline2" })).status, 200);
  assert.equal(readFileSync(fixed, "utf8"), "line1\nline2");
  assert.equal((await postSettings(app, s, { skill_text: "" })).status, 200);
  assert.equal(readFileSync(fixed, "utf8"), "line1\nline2");
});

test("settings: oversize skill and invalid input are rejected and nothing is written", async () => {
  const { app, db, dataDir } = setup();
  upsertOAuthUser(db, key, { gitlabUserId: 5, username: "eve", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  const s = loginAs(db, 5);
  const big = "x".repeat(201 * 1024);
  assert.equal((await postFile(app, s, { name: "SKILL.md", content: big })).status, 400);
  assert.equal((await postSettings(app, s, { skill_text: big })).status, 400);
  assert.equal((await postSettings(app, s, { skill_text: "x".repeat(700 * 1024) })).status, 413);
  assert.equal((await postSettings(app, s, { language: "en; ignore previous", skill_text: "ok" })).status, 400);
  assert.equal((await postSettings(app, s, { severity_threshold: "huge" })).status, 400);
  assert.equal((await postSettings(app, s, { confidence_threshold: "2" })).status, 400);
  assert.equal((await postFile(app, s, { name: "b.md", content: "bin\0ary" })).status, 400);
  assert.ok(!existsSync(join(dataDir, "skills", "5", "SKILL.md")));
  assert.equal(getUserById(db, 5)!.skillPath, "");
  assert.equal(getUserById(db, 5)!.language, "zh-TW");
});

test("skill static scan flags GitLab/Jira tool use, posting and approving; clean text passes", () => {
  assert.equal(scanSkill("Review the diff for bugs.\nPrefer small functions.").length, 0);
  const w = scanSkill("use the GitLab MCP to fetch\nPost a comment per finding\nApprove the MR if clean\nmcp__jira__add_comment");
  assert.deepEqual(w.map((x) => x.line), [1, 2, 3, 4]);
});

test("reviews page: only the user's rows, output escaped, links only to our GitLab", async () => {
  const { app, db } = setup();
  patUser(db, 1, "owner", true);
  patUser(db, 2, "bob", false);
  const ins = db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, error, findings_json, mr_url) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run(1, 7, 100, 3, "abcdef1234", 0, "failed", "<script>alert(1)</script>", null, `${GL}/g/p/-/merge_requests/3`);
  ins.run(1, 7, 101, 4, "1111111111", 0, "done", null, JSON.stringify([{}, {}]), "https://evil.test/x");
  ins.run(2, 7, 102, 5, "2222222222", 0, "done", null, "[]", null);
  const html = await (await app.request("/reviews", { headers: { cookie: loginAs(db, 1).cookie } })).text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /href="https:\/\/gl\.test\/g\/p\/-\/merge_requests\/3" target="_blank" rel="noopener noreferrer">[^<]*<span class="sr-only">（另開新分頁）<\/span>/); // opens in a new tab, announced to screen readers
  assert.ok(!html.includes("evil.test"));
  assert.ok(!html.includes("22222222"));
  assert.match(html, /abcdef12/);
});

test("logout deletes the session", async () => {
  const { app, db } = setup();
  patUser(db, 1, "owner", true);
  const s = loginAs(db, 1);
  assert.equal((await post(app, "/logout", s)).status, 302);
  assert.equal((await app.request("/settings", { headers: { cookie: s.cookie } })).status, 302);
});

// ---- token refresh ----

function oauthUser(db: Db, expiresInMs: number) {
  upsertOAuthUser(db, key, { gitlabUserId: 9, username: "oa", accessToken: "at-old", refreshToken: "rt-old", accessExpiresAt: Date.now() + expiresInMs });
}

test("refresh: token valid beyond the 5 min skew is used as-is (no network)", async () => {
  const { db, oauth, gl } = setup();
  oauthUser(db, REFRESH_SKEW_MS + 60_000);
  assert.equal(await accessTokenFor(db, key, oauth, 9), "at-old");
  assert.equal(gl.calls.token.length, 0);
});

test("refresh: expiring token is refreshed once, rotated pair persisted encrypted, concurrent callers share it", async () => {
  const { db, oauth, gl } = setup();
  oauthUser(db, REFRESH_SKEW_MS - 1000);
  const [a, b] = await Promise.all([accessTokenFor(db, key, oauth, 9), accessTokenFor(db, key, oauth, 9)]);
  assert.deepEqual([a, b], ["at-1", "at-1"]);
  assert.equal(gl.calls.token.length, 1);
  const t = gl.calls.token[0]!;
  assert.equal(t.get("grant_type"), "refresh_token");
  assert.equal(t.get("refresh_token"), "rt-old");
  const u = getUserById(db, 9)!;
  assert.equal(decrypt(key, u.tokenEnc), "at-1");
  assert.equal(decrypt(key, u.refreshTokenEnc!), "rt-1");
  assert.ok(u.accessExpiresAt! - Date.now() > 7000 * 1000);
  assert.equal(await accessTokenFor(db, key, oauth, 9), "at-1"); // now fresh: no further refresh
  assert.equal(gl.calls.token.length, 1);
});

test("refresh: rejection marks the token invalid and later calls fail fast; poller-side runtime throws, never crashes", async () => {
  const { db, oauth, gl } = setup(undefined, { tokenStatus: 400 });
  oauthUser(db, 1000);
  const err = console.error;
  console.error = () => {};
  try {
    await assert.rejects(accessTokenFor(db, key, oauth, 9), /log in again/);
    await assert.rejects(accessTokenFor(db, key, oauth, 9), /invalid/);
  } finally {
    console.error = err;
  }
  assert.equal(getUserById(db, 9)!.tokenInvalid, true);
  assert.equal(gl.calls.token.length, 1); // second call did not hit the network
  // a fresh login clears the flag
  upsertOAuthUser(db, key, { gitlabUserId: 9, username: "oa", accessToken: "n", refreshToken: "m", accessExpiresAt: Date.now() + 1e7 });
  assert.equal(getUserById(db, 9)!.tokenInvalid, false);
  assert.equal(await accessTokenFor(db, key, oauth, 9), "n");
});

test("refresh: invalid_client (our creds wrong) or unconfigured OAuth never invalidates users", async () => {
  const { db, oauth, gl } = setup(undefined, { tokenStatus: 401, tokenError: "invalid_client" });
  oauthUser(db, 1000);
  await assert.rejects(accessTokenFor(db, key, oauth, 9));
  assert.equal(gl.calls.token.length, 1);
  assert.equal(getUserById(db, 9)!.tokenInvalid, false);
  // empty client creds (setup mode / after `setup reset`): no network call at all, still not invalid
  const empty: OAuthCtx = { ...oauth, clientId: "", clientSecret: "" };
  await assert.rejects(accessTokenFor(db, key, empty, 9), /not configured/);
  assert.equal(gl.calls.token.length, 1);
  assert.equal(getUserById(db, 9)!.tokenInvalid, false);
  // poll cycle with empty creds: skips OAuth users, does not touch them
  const warn = console.warn;
  console.warn = () => {};
  try {
    await pollCycle(loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "poll-")), GITLAB_URL: GL }), db, key, empty);
  } finally {
    console.warn = warn;
  }
  assert.equal(gl.calls.token.length, 1);
  assert.equal(getUserById(db, 9)!.tokenInvalid, false);
});

test("refresh: transient failure (5xx) does not invalidate the token", async () => {
  const { db, oauth } = setup(undefined, { tokenStatus: 503 });
  oauthUser(db, 1000);
  await assert.rejects(accessTokenFor(db, key, oauth, 9));
  assert.equal(getUserById(db, 9)!.tokenInvalid, false);
});

test("refresh: PAT users are returned untouched, even with no OAuth config", async () => {
  const { db } = setup();
  patUser(db, 1, "owner", true);
  assert.equal(await accessTokenFor(db, key, undefined, 1), "pat-owner");
});

// ---- migration ----

test("openDb migrates a pre-M3 database: existing users stay approved PAT users", () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  const path = join(dir, "s.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE users (gitlab_user_id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, token_enc BLOB NOT NULL, token_expires_at TEXT, skill_path TEXT NOT NULL,
    severity_threshold TEXT NOT NULL DEFAULT 'minor', confidence_threshold REAL NOT NULL DEFAULT 0.7, language TEXT NOT NULL DEFAULT 'zh-TW', enabled INTEGER NOT NULL DEFAULT 1,
    is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (gitlab_user_id, username, token_enc, skill_path, is_owner) VALUES (153, 'alice', x'00', '/s/SKILL.md', 1);`);
  old.close();
  const db = openDb(path);
  const u = getUserById(db, 153)!;
  assert.deepEqual([u.tokenType, u.approved, u.enabled, u.isOwner, u.tokenInvalid], ["pat", true, true, true, false]);
  openDb(path).close(); // idempotent
});

test("mrLabel shows the project path from the MR url, else the numeric id", async () => {
  const { mrLabel } = await import("../src/web/views.tsx");
  assert.equal(mrLabel({ mrUrl: "https://gitlab.example.com/alice/demo-app/-/merge_requests/2", projectId: 8220, mrIid: 2 }), "alice/demo-app !2");
  assert.equal(mrLabel({ mrUrl: "https://gitlab.example.com/team-a/a/b/-/merge_requests/9", projectId: 1, mrIid: 9 }), "team-a/a/b !9");
  assert.equal(mrLabel({ mrUrl: null, projectId: 8220, mrIid: 2 }), "project 8220 !2");
});

test("settings: a ~150KB Chinese pasted skill round-trips through the multipart form (in-process and over real HTTP)", async () => {
  const { app, db } = setup();
  upsertOAuthUser(db, key, { gitlabUserId: 6, username: "zed", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  const s = loginAs(db, 6);
  const zh = "審查規則：注意安全與效能。\n".repeat(3800); // ~150KB UTF-8
  assert.ok(Buffer.byteLength(zh) < 200 * 1024 && Buffer.byteLength(zh) > 140 * 1024);
  assert.equal((await postSettings(app, s, { skill_text: zh, severity_threshold: "major" })).status, 200);
  assert.equal(getUserById(db, 6)!.severityThreshold, "major");
  // The Node 18 hang only showed on the real @hono/node-server -> undici path, so also go through a socket.
  const srv = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  try {
    await new Promise((r) => srv.once("listening", r));
    const { port } = srv.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/settings`, { method: "POST", headers: { cookie: s.cookie }, body: settingsForm(s, { skill_text: zh + "x", severity_threshold: "blocker" }), signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200);
    assert.equal(getUserById(db, 6)!.severityThreshold, "blocker");
    assert.equal(readFileSync(getUserById(db, 6)!.skillPath, "utf8"), zh + "x");
  } finally {
    // fetch keeps the connection alive; drop it so the server (and the test file) can exit promptly.
    (srv as import("node:http").Server).closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test("settings: file wins over pasted text; an empty file input falls back to the text", async () => {
  const { app, db } = setup();
  upsertOAuthUser(db, key, { gitlabUserId: 7, username: "kim", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  const s = loginAs(db, 7);
  assert.equal((await postSettings(app, s, { skill_text: "from text" }, { name: "SKILL.md", content: "from file" })).status, 200);
  assert.equal(readFileSync(getUserById(db, 7)!.skillPath, "utf8"), "from file");
  assert.equal((await postSettings(app, s, { skill_text: "from text" }, { name: "", content: "" })).status, 200);
  assert.equal(readFileSync(getUserById(db, 7)!.skillPath, "utf8"), "from text");
});

test("settings: review_assigned checkbox persists and renders checked state", async () => {
  const { app, db } = setup();
  patUser(db, 1, "owner", true);
  const s = loginAs(db, 1);
  const html = async () => (await app.request("/settings", { headers: { cookie: s.cookie } })).text();
  assert.equal(getUserById(db, 1)!.reviewAssigned, false);
  assert.doesNotMatch(await html(), /name="review_assigned"[^>]*checked/);
  assert.equal((await postSettings(app, s, { review_assigned: "1" })).status, 200);
  assert.equal(getUserById(db, 1)!.reviewAssigned, true);
  assert.match(await html(), /name="review_assigned"[^>]*checked/);
  assert.equal((await postSettings(app, s, {})).status, 200);
  assert.equal(getUserById(db, 1)!.reviewAssigned, false);
});

test("settings: auto_approve checkbox persists, renders checked state, and CSRF is still enforced", async () => {
  const { app, db } = setup();
  patUser(db, 1, "owner", true);
  const s = loginAs(db, 1);
  const html = async () => (await app.request("/settings", { headers: { cookie: s.cookie } })).text();
  assert.equal(getUserById(db, 1)!.autoApprove, false);
  assert.doesNotMatch(await html(), /name="auto_approve"[^>]*checked/);
  assert.equal((await postSettings(app, s, { auto_approve: "1" })).status, 200);
  assert.equal(getUserById(db, 1)!.autoApprove, true);
  assert.match(await html(), /name="auto_approve"[^>]*checked/);
  assert.equal((await postSettings(app, s, {})).status, 200); // unchecked box sends no field
  assert.equal(getUserById(db, 1)!.autoApprove, false);
  assert.equal((await post(app, "/settings", s, { language: "en", severity_threshold: "minor", confidence_threshold: "0.5", auto_approve: "1" }, null)).status, 403);
  assert.equal(getUserById(db, 1)!.autoApprove, false);
});

// --- in-app guides ---
import { renderDoc } from "../src/web/docs.ts";

test("docs: MR author guide is public and linked from the footer", async () => {
  const { app } = setup();
  const res = await app.request("/docs/mr");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes("<title>Argus：MR 作者須知 - Argus"));
  assert.match(body, /2000 行/);
  assert.match(body, /href="\/docs\/mr"/);
});

test("docs: both guides are public and rendered", async () => {
  const { app } = setup();
  for (const [path, h1] of [["/docs/setup", "部署指南"], ["/docs/guide", "使用指南"]] as const) {
    const res = await app.request(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy")!, /default-src 'self'/);
    const body = await res.text();
    assert.ok(body.includes(`<title>Argus：${h1} - Argus`), `${path} title from H1`);
    assert.match(body, /<h1>Argus：/);
    assert.match(body, /<table>/);
    assert.match(body, /<pre class="codeblock"/);
    assert.doesNotMatch(body, /style=/);
    assert.match(body, /href="\/login"/); // logged-out hint
  }
});

test("docs: raw HTML is escaped, links rewritten, no style attrs", () => {
  const { html } = renderDoc([
    "# T", "", "<script>alert(1)</script> and <b>x</b>", "",
    "[s](SETUP.md) [s2](docs/SETUP.md#x) [g](USER-GUIDE.md) [g2](../docs/USER-GUIDE.md)",
    "[r](../README.md) [src](src/web/app.tsx) [ext](https://example.com/a?b=1)", "",
    "| a | b |", "|:-:|--:|", "| 1 | 2 |",
  ].join("\n"));
  assert.doesNotMatch(html, /<script|<b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="\/docs\/setup">s<\/a>/);
  assert.match(html, /<a href="\/docs\/setup">s2<\/a>/);
  assert.match(html, /<a href="\/docs\/guide">g<\/a>/);
  assert.match(html, /<a href="\/docs\/guide">g2<\/a>/);
  assert.doesNotMatch(html, /README|src\/web/); // dropped to plain text...
  assert.match(html, /r src/); // ...text kept
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1" rel="noopener noreferrer">ext<\/a>/);
  assert.doesNotMatch(html, /style=/);
});

test("docs: missing file -> friendly 404, app still starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  writeFileSync(join(dir, "USER-GUIDE.md"), "# Only guide\n");
  const { cfg, db, oauth } = setup();
  const app = createApp({ cfg, db, key, oauth, docsDir: pathToFileURL(`${dir}/`) });
  const res = await app.request("/docs/setup");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /找不到文件/);
  assert.equal((await app.request("/docs/guide")).status, 200);
});

test("docs: login page and footer link to in-app guides, never GitLab", async () => {
  const { app } = setup();
  const body = await (await app.request("/login")).text();
  assert.match(body, /href="\/docs\/setup"/);
  assert.match(body, /href="\/docs\/guide"/);
  assert.doesNotMatch(body, /gitlab\.example\.com/);
});

test("settings: max_diff_lines form field saves, resets on empty, rejects out-of-range", async () => {
  const { app, db } = setup();
  upsertOAuthUser(db, key, { gitlabUserId: 7, username: "dl", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  const s = loginAs(db, 7);
  const page = await (await app.request("/settings", { headers: { cookie: s.cookie } })).text();
  assert.match(page, /name="max_diff_lines"[^>]*placeholder="2000"/);
  assert.equal((await postSettings(app, s, { max_diff_lines: "3500" })).status, 200);
  assert.equal(getUserById(db, 7)!.maxDiffLines, 3500);
  assert.match(await (await app.request("/settings", { headers: { cookie: s.cookie } })).text(), /name="max_diff_lines"[^>]*value="3500"/);
  const bad = await postSettings(app, s, { max_diff_lines: "9000" });
  assert.equal(bad.status, 400);
  assert.equal(getUserById(db, 7)!.maxDiffLines, 3500);
  assert.equal((await postSettings(app, s, { max_diff_lines: "" })).status, 200);
  assert.equal(getUserById(db, 7)!.maxDiffLines, null);
});

test("docs: Docker image ships docs/", () => {
  const root = new URL("../", import.meta.url);
  assert.match(readFileSync(new URL("Dockerfile", root), "utf8"), /^COPY .*\bdocs \.\/docs$/m);
  assert.ok(!readFileSync(new URL(".dockerignore", root), "utf8").split("\n").some((l) => /^\/?docs\/?$/.test(l.trim())));
});
