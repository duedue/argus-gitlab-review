import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { OAuthCtx } from "../src/oauth.ts";
import { applyStoredSettings, bootstrapSetup, completeSetup, resetSetup, startSetupMode, storedOAuth } from "../src/setup.ts";
import { bootstrapOwner, getUser, upsertOAuthUser } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const key = randomBytes(32);
const GL = "https://gl.test";
const CODE_RE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

function boot(env: Record<string, string> = {}, reachable = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "setup-"));
  const cfg = loadConfig({ DATA_DIR: dataDir, GITLAB_URL: GL, BASE_URL: "http://argus.example:3000", ...env });
  const db = openDb(":memory:");
  const logs: string[] = [];
  const code = startSetupMode(cfg, db, (m) => logs.push(m));
  const fetched: string[] = [];
  const f = (async (u: string | URL | Request) => {
    fetched.push(String(u));
    if (!reachable) throw new Error("ENOTFOUND");
    return new Response("{}", { status: 401 }); // any HTTP answer = reachable
  }) as typeof fetch;
  const oauth: OAuthCtx = { gitlabUrl: GL, redirectUri: "http://argus.example:3000/auth/callback", clientId: "", clientSecret: "", fetch: f };
  return { app: createApp({ cfg, db, key, oauth }), cfg, db, oauth, code, logs, dataDir, fetched };
}

async function form(app: ReturnType<typeof boot>["app"]) {
  const res = await app.request("/setup");
  const token = res.headers.getSetCookie().find((c) => c.startsWith("setup_csrf="))!.split(";")[0]!.split("=")[1]!;
  return { res, token, html: await res.text() };
}
const submit = (app: ReturnType<typeof boot>["app"], token: string, fields: Record<string, string>, cookie = token) =>
  app.request("/setup", { method: "POST", headers: { cookie: `setup_csrf=${cookie}` }, body: new URLSearchParams({ _csrf: token, ...fields }) });
const good = (code: string) => ({ client_id: "app-id-12345678", client_secret: "gloas-secret-1234", owner: "42", jira_token: "jira-tok-xyz", setup_code: code });

test("setup mode: code file 0600, exact log line, redirects, page content", async () => {
  const t = boot();
  assert.match(t.code, CODE_RE);
  assert.equal(t.logs.length, 1);
  assert.equal(t.logs[0], `[setup] Argus is not configured yet. Setup code: ${t.code}  Open http://argus.example:3000/setup`);
  const file = join(t.dataDir, "setup-code");
  assert.equal(readFileSync(file, "utf8"), `${t.code}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const hash = (t.db.prepare(`SELECT value FROM settings WHERE name='setup_code_hash'`).get() as { value: Buffer }).value.toString();
  assert.ok(!hash.includes(t.code.replaceAll("-", "")));

  for (const p of ["/", "/login", "/reviews", "/admin", "/settings", "/auth/callback", "/pending"]) {
    const r = await t.app.request(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get("location"), "/setup", p);
  }
  assert.equal((await t.app.request("/static/base.css")).status, 200);
  assert.equal((await t.app.request("/docs/setup")).status, 200);
  const { res, html } = await form(t.app);
  assert.equal(res.status, 200);
  assert.ok(html.includes("http://argus.example:3000/auth/callback") && html.includes("read_repository"));
  assert.ok(!html.includes(t.code));
});

test("restart overwrites the code and invalidates the old one", () => {
  const t = boot();
  const second = startSetupMode(t.cfg, t.db, () => {});
  assert.notEqual(second, t.code);
  assert.equal(readFileSync(join(t.dataDir, "setup-code"), "utf8"), `${second}\n`);
});

test("wrong code / bad csrf / bad input are rejected and store nothing", async () => {
  const t = boot();
  const { token } = await form(t.app);
  assert.equal((await submit(t.app, token, good("AAAA-AAAA-AAAA-AAAA"))).status, 400);
  assert.equal((await submit(t.app, token, good(t.code), "other")).status, 400); // csrf cookie mismatch
  assert.equal((await submit(t.app, token, { ...good(t.code), client_id: "bad id!" })).status, 400);
  assert.equal((await submit(t.app, token, { ...good(t.code), owner: "" })).status, 400);
  assert.equal(storedOAuth(t.db, key), undefined);
  assert.ok(existsSync(join(t.dataDir, "setup-code")));
  assert.equal(t.oauth.clientId, "");
});

test("rate limit: 5 attempts per 10 min per IP, then locked out even with the right code", async () => {
  const t = boot();
  const { token } = await form(t.app);
  for (let i = 0; i < 5; i++) assert.equal((await submit(t.app, token, good("AAAA-AAAA-AAAA-AAAA"))).status, 400);
  const r = await submit(t.app, token, good(t.code));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "600");
  assert.equal(storedOAuth(t.db, key), undefined);
});

test("success: encrypted at rest, code file deleted, hot switch to normal mode", async () => {
  const t = boot();
  const { token } = await form(t.app);
  const r = await submit(t.app, token, good(t.code.toLowerCase().replaceAll("-", " ")));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/login");
  assert.ok(!existsSync(join(t.dataDir, "setup-code")));
  assert.ok(t.fetched.some((u) => u === `${GL}/api/v4/version`));

  const raw = JSON.stringify(t.db.prepare(`SELECT name, value FROM settings`).all());
  const dump = (t.db.prepare(`SELECT value FROM settings`).all() as { value: Buffer }[]).map((x) => x.value.toString("latin1")).join("|");
  for (const secret of ["app-id-12345678", "gloas-secret-1234", "jira-tok-xyz"]) assert.ok(!dump.includes(secret) && !raw.includes(secret), secret);
  assert.deepEqual(storedOAuth(t.db, key), { clientId: "app-id-12345678", clientSecret: "gloas-secret-1234" });
  assert.equal((t.db.prepare(`SELECT value FROM settings WHERE name='owner_ref'`).get() as { value: Buffer }).value.toString(), "42");
  assert.equal(t.db.prepare(`SELECT 1 FROM settings WHERE name='setup_code_hash'`).get(), undefined);

  // normal mode without restart
  const login = await t.app.request("/login");
  assert.equal(login.status, 200);
  assert.ok((await login.text()).includes("client_id=app-id-12345678"));
  assert.equal((await t.app.request("/setup")).headers.get("location"), "/login");
  assert.equal((await submit(t.app, token, good(t.code))).headers.get("location"), "/login");
  assert.equal(t.cfg.ownerRef, "42");
});

test("unreachable GitLab: rejected, code stays valid", async () => {
  const t = boot({}, false);
  const { token } = await form(t.app);
  assert.equal((await submit(t.app, token, good(t.code))).status, 400);
  assert.equal(storedOAuth(t.db, key), undefined);
});

test("env overrides DB for owner and Jira token; DB fills in when env is unset", () => {
  const t = boot();
  completeSetup(t.db, key, t.cfg, { clientId: "app-id-12345678", clientSecret: "gloas-secret-1234", owner: "42", jiraToken: "db-jira" }, t.code);
  const fromDb = loadConfig({ DATA_DIR: t.dataDir });
  applyStoredSettings(fromDb, t.db, key);
  assert.equal(fromDb.ownerRef, "42");
  assert.equal(fromDb.jira.token(), "db-jira");
  const fromEnv = loadConfig({ DATA_DIR: t.dataDir, ARGUS_OWNER: "7", JIRA_API_TOKEN: "env-jira" });
  applyStoredSettings(fromEnv, t.db, key);
  assert.equal(fromEnv.ownerRef, "7");
  assert.equal(fromEnv.jira.token(), "env-jira");
});

test("owner bootstrap uses the stored owner ref", () => {
  const t = boot();
  completeSetup(t.db, key, t.cfg, { clientId: "app-id-12345678", clientSecret: "gloas-secret-1234", owner: "42" }, t.code);
  const cfg2 = loadConfig({ DATA_DIR: t.dataDir });
  applyStoredSettings(cfg2, t.db, key);
  const u = upsertOAuthUser(t.db, key, { gitlabUserId: 42, username: "boss", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  bootstrapOwner(t.db, u, cfg2.ownerRef, () => {});
  assert.equal(getUser(t.db, "boss")?.isOwner, true);
});

test("setup reset clears stored settings", () => {
  const t = boot();
  completeSetup(t.db, key, t.cfg, { clientId: "app-id-12345678", clientSecret: "gloas-secret-1234", owner: "42" }, t.code);
  assert.ok(resetSetup(t.db) >= 3);
  assert.equal(storedOAuth(t.db, key), undefined);
});

test("concurrent submits with the same code: exactly one succeeds", async () => {
  const t = boot();
  const { token } = await form(t.app);
  const [a, b] = await Promise.all([submit(t.app, token, good(t.code)), submit(t.app, token, { ...good(t.code), client_id: "other-app-id-9999" })]);
  assert.deepEqual([a.status, b.status].sort(), [302, 400]);
  assert.equal(storedOAuth(t.db, key)?.clientId, a.status === 302 ? "app-id-12345678" : "other-app-id-9999");
  // direct: second consume of a burned code returns false and stores nothing new
  assert.equal(completeSetup(t.db, key, t.cfg, { clientId: "zzzzzzzz-1", clientSecret: "zzzzzzzz-2", owner: "1" }, t.code), false);
});

test("rate limit counts only attempts that pass csrf + validation", async () => {
  const t = boot();
  const { token } = await form(t.app);
  for (let i = 0; i < 8; i++) assert.equal((await submit(t.app, token, good("AAAA-AAAA-AAAA-AAAA"), "other")).status, 400); // csrf fails
  for (let i = 0; i < 8; i++) assert.equal((await submit(t.app, token, { ...good(t.code), client_id: "bad id!" })).status, 400); // invalid input
  assert.equal((await submit(t.app, token, good(t.code))).status, 302); // installer still gets in
});

test("setup mode: /api/* answers 503 JSON, not a redirect", async () => {
  const t = boot();
  const r = await t.app.request("/api/anything");
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "not_configured" });
});

test("bootstrapSetup: creds in env / only in DB / none", () => {
  const mk = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "boot-"));
    return { cfg: loadConfig({ DATA_DIR: dataDir, GITLAB_URL: GL, BASE_URL: "http://argus.example:3000" }), db: openDb(":memory:"), file: join(dataDir, "setup-code") };
  };
  const none = () => { throw new Error("no creds"); };
  // none: setup mode, code generated
  let t = mk();
  let r = bootstrapSetup(t.cfg, t.db, key, none);
  assert.equal(r.setupMode, true);
  assert.deepEqual([r.oauth.clientId, r.oauth.clientSecret], ["", ""]);
  assert.equal(r.oauth.redirectUri, "http://argus.example:3000/auth/callback");
  assert.ok(existsSync(t.file));
  assert.ok(t.db.prepare(`SELECT 1 FROM settings WHERE name='setup_code_hash'`).get());
  // env creds win over DB and clear a stale code file
  completeSetup(t.db, key, t.cfg, { clientId: "db-app-id-1234", clientSecret: "db-secret-1234", owner: "1" }, readFileSync(t.file, "utf8").trim());
  startSetupMode(t.cfg, t.db, () => {}); // stale code file + hash
  r = bootstrapSetup(t.cfg, t.db, key, () => ({ clientId: "env-id", clientSecret: "env-secret" }));
  assert.equal(r.setupMode, false);
  assert.deepEqual([r.oauth.clientId, r.oauth.clientSecret], ["env-id", "env-secret"]);
  assert.ok(!existsSync(t.file));
  // DB only
  r = bootstrapSetup(t.cfg, t.db, key, none);
  assert.equal(r.setupMode, false);
  assert.deepEqual([r.oauth.clientId, r.oauth.clientSecret], ["db-app-id-1234", "db-secret-1234"]);
  assert.ok(!existsSync(t.file));
  t = mk(); // fresh DB, env only
  r = bootstrapSetup(t.cfg, t.db, key, () => ({ clientId: "env-id", clientSecret: "env-secret" }));
  assert.equal(r.setupMode, false);
  assert.ok(!existsSync(t.file));
});

test("setup page: the GitLab Applications link opens in a new tab (announced to screen readers)", async () => {
  const { app } = boot();
  const { html } = await form(app);
  assert.match(html, /user_settings\/applications" target="_blank" rel="noopener noreferrer">[^<]*<span class="sr-only">（另開新分頁）<\/span>/);
});
