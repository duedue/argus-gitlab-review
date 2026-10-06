import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.ts";
import { API_KEY_RE, createApiKey, findApiKey, getApiKeyInfo, touchApiKey } from "../apikeys.ts";
import { isSelfReview, lastModelUsed, resetFailed, type Db } from "../db.ts";
import { operatorCommands } from "../commands.ts";
import { claudeAuthStatus, claudeTestConnection, codexLoginStatus, ttlCache, type ConnectionTest } from "../engine-status.ts";
import { exchangeCode, fetchIdentity, newAuthRequest, type OAuthCtx } from "../oauth.ts";
import { queueKey, reviewQueue, type ReviewQueue } from "../queue.ts";
import { reviewMr, type UserRuntime } from "../review.ts";
import { claudeConfigDir, runtimeFactory } from "../runtime.ts";
import { checkSetupCode, completeSetup, setDryRun, validateSetupInput } from "../setup.ts";
import { createSession, deleteSession, getSession, safeEqual, SESSION_TTL_MS } from "../sessions.ts";
import { MAX_SKILL_BYTES, managedSkillPath, saveSkill, scanSkill, validateSkillText } from "../skills.ts";
import { bootstrapOwner, clearClaudeToken, engineFields, getUserById, hasOwner, listUsers, parseSettings, setClaudeToken, setUser, setUserEnabled, upsertOAuthUser, userStatus, validateClaudeToken, type User } from "../users.ts";
import { chooseEngine, laneFor } from "../engine.ts";
import { makeRateLimiter, parseMrUrl, TRIGGER_LIMIT_PER_HOUR, triggerReviews, TriggerError } from "../trigger.ts";
import { DOCS, loadDocs, type DocKey } from "./docs.ts";
import {
  AdminPage, DocPage, LoginPage, MessagePage, PendingPage, render, ReviewsPage, SettingsPage, SetupPage, type LastReview, type ReviewRow, type SettingsView,
} from "./views.tsx";

export interface WebDeps {
  cfg: Config;
  db: Db;
  key: Buffer;
  oauth: OAuthCtx;
  // Test seams; production defaults are the real per-user runtime, the shared review queue and 30 triggers/hour/key.
  runtimeFor?: (u: User) => Promise<UserRuntime>;
  queue?: ReviewQueue;
  triggerLimitPerHour?: number;
  docsDir?: URL; // test seam: where the guides are read from
  // Test seam: one minimal `claude -p` with the pasted Claude token before it is saved (real call by default).
  verifyClaudeToken?: (u: User, token: string) => Promise<ConnectionTest>;
}

type Env = { Variables: { user: User; csrf: string } };

const asset = (f: string) => readFileSync(new URL(`./static/${f}`, import.meta.url));
const CSS = asset("base.css").toString("utf8");
const ICON = asset("argus-icon.png");
const FAVICON = asset("favicon.png");
const SETUP_CSRF_COOKIE = "setup_csrf";
const STATE_COOKIE = "oauth_state";
const VERIFIER_COOKIE = "oauth_verifier";
const SESSION_COOKIE = "sid";

export function createApp({
  cfg, db, key, oauth, runtimeFor = runtimeFactory(cfg, db, key, oauth), queue = reviewQueue, triggerLimitPerHour = TRIGGER_LIMIT_PER_HOUR, docsDir,
  verifyClaudeToken = (u, token) => claudeTestConnection(cfg.claudeBin, u.model, { token: () => token, configDir: claudeConfigDir(cfg.dataDir, u.gitlabUserId) }),
}: WebDeps): Hono<Env> {
  const app = new Hono<Env>();
  const triggerAllowed = makeRateLimiter(triggerLimitPerHour);
  // Engine status card: cached ~60s (each check spawns the CLI); the connection test costs a real model call, so 1 per 30s.
  const claudeStatus = ttlCache(60_000, () => claudeAuthStatus(cfg.claudeBin));
  const codexStatus = ttlCache(60_000, () => codexLoginStatus(cfg.codexBin));
  const testAllowed = makeRateLimiter(1, 30_000);
  const retryAllowed = makeRateLimiter(1, 30_000); // manual re-review: 1 per 30s per user
  const tokenVerifyAllowed = makeRateLimiter(1, 30_000); // saving a Claude token costs one model call: 1 per 30s per user
  const cookieOpts = { httpOnly: true, sameSite: "Lax", secure: cfg.web.cookieSecure, path: "/" } as const;
  const page = (c: Context, el: unknown, status: 200 | 400 | 403 | 404 | 413 | 429 = 200) => c.html(render(el), status);

  // --- security headers on every response (CSP forbids inline script/style; CSS is served from /static) ---
  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; form-action 'self'");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.res.headers.get("content-type")?.startsWith("text/html")) c.header("Cache-Control", "no-store");
  });

  // --- first-run setup mode: OAuth creds are empty until POST /setup fills this same `oauth` object in place (no restart) ---
  const inSetup = () => !oauth.clientId || !oauth.clientSecret;
  const setupAllowed = makeRateLimiter(5, 10 * 60_000); // per IP; only POSTs that pass CSRF + input validation (i.e. actually compare the code) count, so junk can't lock the installer out
  const clientIp = (c: Context) => {
    try {
      return getConnInfo(c).remote.address ?? "unknown"; // never X-Forwarded-For: spoofable
    } catch {
      return "unknown";
    }
  };
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (inSetup() && p !== "/setup" && !p.startsWith("/static/") && !p.startsWith("/docs/")) {
      if (p.startsWith("/api/")) return c.json({ error: "not_configured" }, 503);
      return c.redirect("/setup");
    }
    await next();
  });

  app.onError((e, c) => {
    console.error("[web] unhandled:", e.message); // never echo internals (could include token endpoint text)
    if (c.req.path.startsWith("/api/")) return c.json({ error: "internal_error" }, 500);
    return page(c, <MessagePage title="發生錯誤" message="發生未預期的錯誤，請稍後再試。" />, 400);
  });

  app.get("/static/base.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" }));

  app.get("/static/argus-icon.png", (c) => c.body(ICON, 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }));
  app.get("/static/favicon.png", (c) => c.body(FAVICON, 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }));

  // --- public guides (no session required; a logged-in viewer just gets the normal nav) ---
  const docs = loadDocs(docsDir);
  for (const k of Object.keys(DOCS) as DocKey[]) {
    app.get(DOCS[k].path, (c) => {
      const s = getSession(db, getCookie(c, SESSION_COOKIE));
      const user = (s && getUserById(db, s.userId)) || undefined;
      const csrf = user && s ? s.csrf : undefined;
      const d = docs[k];
      if (!d) return page(c, <MessagePage title="找不到文件" message="這份文件目前無法使用。" user={user} csrf={csrf} />, 404);
      return page(c, <DocPage title={d.title} html={d.html} user={user} csrf={csrf} />);
    });
  }

  const setupPage = (c: Context, token: string, extra: { error?: string; clientId?: string; owner?: string } = {}, status: 200 | 400 | 429 = 200) =>
    page(c, <SetupPage cmds={operatorCommands(cfg)} redirectUri={oauth.redirectUri} gitlabUrl={cfg.gitlabUrl} csrf={token} {...extra} />, status);

  app.get("/setup", (c) => {
    if (!inSetup()) return c.redirect("/login");
    // Double-submit token: random cookie + identical hidden field; the setup code is the real gate.
    const token = randomBytes(24).toString("base64url");
    setCookie(c, SETUP_CSRF_COOKIE, token, { ...cookieOpts, sameSite: "Strict", maxAge: 3600 });
    return setupPage(c, token);
  });

  app.post("/setup", bodyLimit({ maxSize: 16 * 1024, onError: (c) => page(c, <MessagePage title="內容過大" message="請求內容超過大小上限。" />, 413) }), async (c) => {
    if (!inSetup()) return c.redirect("/login");
    const cookie = getCookie(c, SETUP_CSRF_COOKIE);
    const token = cookie ?? randomBytes(24).toString("base64url");
    const body = await c.req.parseBody();
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") f[k] = v;
    if (!cookie || !f._csrf || !safeEqual(f._csrf, cookie)) {
      setCookie(c, SETUP_CSRF_COOKIE, token, { ...cookieOpts, sameSite: "Strict", maxAge: 3600 });
      return setupPage(c, token, { error: "表單已過期，請重新送出。" }, 400);
    }
    const input = validateSetupInput(f);
    const keep = { clientId: f.client_id?.slice(0, 200), owner: f.owner?.slice(0, 255) }; // never echo secret / code back
    if (typeof input === "string") return setupPage(c, token, { ...keep, error: input }, 400);
    if (!setupAllowed(clientIp(c))) {
      c.header("Retry-After", "600");
      return setupPage(c, token, { ...keep, error: "嘗試次數過多，請 10 分鐘後再試。" }, 429);
    }
    if (!checkSetupCode(db, f.setup_code ?? "")) return setupPage(c, token, { ...keep, error: "Setup code 不正確。" }, 400);
    // Sanity check only: any HTTP answer means the GitLab instance is reachable (the real OAuth check happens at first login).
    try {
      await (oauth.fetch ?? fetch)(`${cfg.gitlabUrl}/api/v4/version`, { signal: AbortSignal.timeout(5000) });
    } catch {
      return setupPage(c, token, { ...keep, error: `連不到 GitLab（${cfg.gitlabUrl}），請檢查 GITLAB_URL 與網路。` }, 400);
    }
    // Re-checks and burns the code atomically: two concurrent submits with the same code cannot both succeed.
    if (!completeSetup(db, key, cfg, input, f.setup_code ?? "")) return setupPage(c, token, { ...keep, error: "Setup code 不正確。" }, 400);
    Object.assign(oauth, { clientId: input.clientId, clientSecret: input.clientSecret }); // hot swap: leaves setup mode
    deleteCookie(c, SETUP_CSRF_COOKIE, cookieOpts);
    console.log("[setup] configuration saved; Argus is now in normal mode");
    return c.redirect("/login");
  });

  // --- auth ---
  const authed = async (c: Context<Env>, next: () => Promise<void>) => {
    const s = getSession(db, getCookie(c, SESSION_COOKIE));
    const user = s && getUserById(db, s.userId);
    if (!s || !user) return c.redirect("/login");
    c.set("user", user);
    c.set("csrf", s.csrf);
    await next();
  };
  // Synchronizer token tied to the session; required on every POST (registered after `authed` per route).
  const csrf = async (c: Context<Env>, next: () => Promise<void>) => {
    const body = await c.req.parseBody();
    const t = body._csrf;
    if (typeof t !== "string" || !safeEqual(t, c.get("csrf"))) return page(c, <MessagePage title="禁止存取" message="CSRF token 無效或遺失，請重新整理頁面後再試。" user={c.get("user")} csrf={c.get("csrf")} />, 403);
    await next();
  };
  const ownerOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (!c.get("user").isOwner) return page(c, <MessagePage title="禁止存取" message="僅限 owner 使用。" user={c.get("user")} csrf={c.get("csrf")} />, 403);
    await next();
  };

  app.get("/", authed, (c) => c.redirect(userStatus(c.get("user")) === "pending" ? "/pending" : "/reviews"));

  app.get("/login", (c) => {
    const s = getSession(db, getCookie(c, SESSION_COOKIE));
    // A logged-in user whose OAuth token went invalid must be able to log in again.
    if (s && !getUserById(db, s.userId)?.tokenInvalid) return c.redirect("/");
    const req = newAuthRequest(oauth);
    // state and PKCE verifier live in short-lived HttpOnly cookies, so a callback is only accepted from the browser that started it.
    setCookie(c, STATE_COOKIE, req.state, { ...cookieOpts, maxAge: 600 });
    setCookie(c, VERIFIER_COOKIE, req.verifier, { ...cookieOpts, maxAge: 600 });
    return page(c, <LoginPage authorizeUrl={req.url} error={c.req.query("e") ? "登入失敗，請再試一次。" : undefined} />);
  });

  app.get("/auth/callback", async (c) => {
    const state = getCookie(c, STATE_COOKIE);
    const verifier = getCookie(c, VERIFIER_COOKIE);
    deleteCookie(c, STATE_COOKIE, cookieOpts);
    deleteCookie(c, VERIFIER_COOKIE, cookieOpts);
    const q = c.req.query();
    if (!state || !verifier || !q.state || !safeEqual(q.state, state)) {
      return page(c, <MessagePage title="登入失敗" message="登入狀態無效，請從登入頁重新開始。" />, 400);
    }
    if (q.error || !q.code) return c.redirect("/login?e=1"); // user denied access or GitLab reported an error
    let user: User;
    try {
      const t = await exchangeCode(oauth, q.code, verifier);
      const me = await fetchIdentity(oauth, t.accessToken);
      user = bootstrapOwner(db, upsertOAuthUser(db, key, { gitlabUserId: me.id, username: me.username, ...t }), cfg.ownerRef);
    } catch (e) {
      console.error("[web] oauth callback failed:", (e as Error).message);
      return c.redirect("/login?e=1");
    }
    const s = createSession(db, user.gitlabUserId); // always a fresh session id (no fixation)
    setCookie(c, SESSION_COOKIE, s.id, { ...cookieOpts, maxAge: SESSION_TTL_MS / 1000 });
    return c.redirect("/");
  });

  app.post("/logout", authed, csrf, (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) deleteSession(db, id);
    deleteCookie(c, SESSION_COOKIE, cookieOpts);
    return c.redirect("/login");
  });

  app.get("/pending", authed, (c) => page(c, <PendingPage user={c.get("user")} csrf={c.get("csrf")} noOwner={!hasOwner(db)} />));

  // --- settings ---
  const settingsView = (u: User, csrfToken: string, extra: Partial<SettingsView> = {}): SettingsView => {
    const managed = managedSkillPath(cfg.dataDir, u.gitlabUserId);
    const own = u.skillPath === managed && existsSync(managed) && statSync(managed).size <= MAX_SKILL_BYTES;
    const skillText = extra.skillText ?? (own ? readFileSync(managed, "utf8") : "");
    return {
      user: u, csrf: csrfToken, skillText, hasExternalSkill: !!u.skillPath && !own,
      apiKey: getApiKeyInfo(db, u.gitlabUserId), baseUrl: cfg.web.baseUrl, lastModel: lastModelUsed(db, u.gitlabUserId),
      warnings: own ? scanSkill(skillText) : [], maxSkillKb: MAX_SKILL_BYTES / 1024, defaultMaxDiffLines: cfg.maxDiffLines,
      engine: chooseEngine(engineFields(u), cfg.ownerEngineTestUsers), ...extra,
    };
  };

  app.get("/settings", authed, (c) => page(c, <SettingsPage {...settingsView(c.get("user"), c.get("csrf"))} />));

  // Validate -> write skill (fixed path) -> update settings. Nothing is written when validation fails.
  const applySettings = (c: Context<Env>, pairs: string[], pastedText: string, skill?: () => Promise<string | undefined>) => {
    const u = c.get("user");
    return (async () => {
      try {
        if (pairs.length) parseSettings(pairs); // validate everything before writing anything
        const text = skill ? await skill() : undefined;
        const all = [...pairs];
        if (text !== undefined) all.push(`skill_path=${saveSkill(cfg.dataDir, u.gitlabUserId, text)}`); // fixed path, never user-supplied
        if (all.length) setUser(db, u.username, all);
      } catch (e) {
        return page(c, <SettingsPage {...settingsView(u, c.get("csrf"), { error: (e as Error).message, skillText: pastedText })} />, 400);
      }
      return page(c, <SettingsPage {...settingsView(getUserById(db, u.gitlabUserId)!, c.get("csrf"), { saved: true })} />);
    })();
  };
  // One multipart form: optional skill file + optional pasted text (the textarea is prefilled with the current skill).
  // multipart does not inflate bytes, so the cap is file + text + overhead.
  const tooLarge = bodyLimit({ maxSize: MAX_SKILL_BYTES * 2 + 64 * 1024, onError: (c) => page(c, <MessagePage title="內容過大" message="請求內容超過大小上限。" />, 413) });

  // Needs Node >= 22: on Node 18 undici hangs parsing a multipart text field larger than a few KB.
  app.post("/settings", tooLarge, authed, csrf, async (c) => {
    const body = await c.req.parseBody();
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const pairs = [`severity_threshold=${str("severity_threshold")}`, `confidence_threshold=${str("confidence_threshold")}`, `language=${str("language").trim()}`, `auto_approve=${str("auto_approve") === "1" ? 1 : 0}`, `review_assigned=${str("review_assigned") === "1" ? 1 : 0}`, `max_diff_lines=${str("max_diff_lines").trim()}`];
    // The select is disabled for codex-cli users (not submitted): an absent field keeps the stored value instead of clearing it.
    if (typeof body.model === "string") pairs.push(`model=${body.model}`);
    const pasted = str("skill_text").replace(/\r\n/g, "\n"); // browsers submit CRLF
    const f = body.skill_file; // string when no file part was sent
    // An empty file input arrives as a 0-byte file. A chosen file wins over the pasted text (which is prefilled
    // with the current skill and so is usually present).
    return applySettings(c, pairs, str("skill_text"), async () => {
      if (typeof f === "object" && f !== null && f.size > 0) {
        if (f.size > MAX_SKILL_BYTES) throw new Error(`skill 檔案超過 ${MAX_SKILL_BYTES / 1024}KB 上限`);
        return validateSkillText(new TextDecoder("utf-8").decode(await f.arrayBuffer()));
      }
      return pasted.trim() ? validateSkillText(pasted) : undefined;
    });
  });

  // (Re)generate: replaces the old key at once; the plaintext is rendered in this response only (page is no-store).
  app.post("/settings/api-key", authed, csrf, (c) => {
    const u = c.get("user");
    const newApiKey = createApiKey(db, u.gitlabUserId);
    return page(c, <SettingsPage {...settingsView(u, c.get("csrf"), { newApiKey })} />);
  });

  // Personal Claude token: set/replace (format check, then one verifying model call) and delete. Own settings page only;
  // the value is never rendered back, logged or echoed in an error.
  const smallBody = bodyLimit({ maxSize: 4 * 1024, onError: (c) => page(c, <MessagePage title="內容過大" message="請求內容超過大小上限。" />, 413) });
  app.post("/settings/claude-token", smallBody, authed, csrf, async (c) => {
    const u = c.get("user");
    const fail = (error: string, status: 400 | 429 = 400) => page(c, <SettingsPage {...settingsView(u, c.get("csrf"), { error })} />, status);
    const raw = (await c.req.parseBody()).claude_token;
    let token: string;
    try {
      token = validateClaudeToken(typeof raw === "string" ? raw : "");
    } catch (e) {
      return fail((e as Error).message);
    }
    if (!tokenVerifyAllowed(String(u.gitlabUserId))) return fail("驗證 Claude token 每 30 秒只能一次，請稍後再試。", 429);
    const v = await verifyClaudeToken(u, token);
    if (v.rejected) return fail("Claude 拒絕了這個 token（可能已撤銷或過期），未儲存。請重新執行 claude setup-token 產生新的。");
    setClaudeToken(db, key, u.gitlabUserId, token);
    console.log(`[settings] ${u.username}: Claude token ${u.claudeTokenEnc ? "replaced" : "set"} (verified: ${v.ok})`);
    const warn = v.ok ? undefined : "已儲存，但目前無法驗證（例如網路或 CLI 問題）；若 token 無效，第一次審查會標示為失效。";
    return page(c, <SettingsPage {...settingsView(getUserById(db, u.gitlabUserId)!, c.get("csrf"), { saved: true, tokenWarning: warn })} />);
  });

  app.post("/settings/claude-token/delete", authed, csrf, (c) => {
    const u = c.get("user");
    clearClaudeToken(db, u.gitlabUserId);
    console.log(`[settings] ${u.username}: Claude token deleted`);
    return page(c, <SettingsPage {...settingsView(getUserById(db, u.gitlabUserId)!, c.get("csrf"), { saved: true })} />);
  });

  // --- trigger API: Bearer key only (no cookies, so no CSRF applies) ---
  app.post("/api/trigger", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }), async (c) => {
    const bearer = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const hit = bearer && API_KEY_RE.test(bearer) ? findApiKey(db, bearer) : undefined;
    const caller = hit && getUserById(db, hit.userId);
    if (!hit || !caller) return c.json({ error: "invalid_api_key" }, 401);
    // Per user, not per key: regenerating a key must not reset the budget (it protects the owner's subscription).
    if (!triggerAllowed(String(hit.userId))) {
      c.header("Retry-After", "3600");
      return c.json({ error: "rate_limited" }, 429);
    }
    touchApiKey(db, hit.hash);
    if (!caller.approved || !caller.enabled) return c.json({ error: "user_not_approved" }, 403);
    const body = await c.req.json().catch(() => undefined);
    const ref = parseMrUrl((body as { mr_url?: unknown } | undefined)?.mr_url, cfg.gitlabUrl);
    if (!ref) return c.json({ error: "invalid_mr_url" }, 400);
    try {
      const self = (body as { self?: unknown } | undefined)?.self;
      if (self !== undefined && typeof self !== "boolean") return c.json({ error: "invalid_self" }, 400);
      return c.json(await triggerReviews({ cfg, db, queue, runtimeFor }, caller, ref, { self }), 202);
    } catch (e) {
      if (e instanceof TriggerError) return c.json({ error: e.code }, e.status);
      throw e;
    }
  });

  // --- review history ---
  app.get("/reviews", authed, (c) => {
    const u = c.get("user");
    // Older rows lack mr_url: derive the project web URL from any other stored MR url of the same project (no GitLab call).
    const projectBase = new Map<number, string>();
    for (const r of db.prepare(`SELECT project_id, mr_url FROM reviews WHERE owner_id=? AND mr_url IS NOT NULL`).all(u.gitlabUserId) as { project_id: number; mr_url: string }[]) {
      const m = /^(.+)\/-\/merge_requests\/\d+$/.exec(r.mr_url);
      if (m) projectBase.set(r.project_id, m[1]!);
    }
    const rows = (db.prepare(
      // round: same rule as the review summary's 第 N 輪 (Nth done review of this MR for this reviewer and mode).
      `SELECT r.id, r.mr_url, r.project_id, r.mr_iid, r.head_sha, r.status, r.error, r.findings_json, r.dry_run, r.created_at, r.model, r.next_retry_at, r.mr_author,
         CASE WHEN r.status='done' THEN (SELECT COUNT(*) FROM reviews p WHERE p.owner_id=r.owner_id AND p.mr_id=r.mr_id AND p.dry_run=r.dry_run AND p.status='done' AND p.id<=r.id) END AS round
       FROM reviews r WHERE r.owner_id=? ORDER BY r.id DESC LIMIT 100`,
    ).all(u.gitlabUserId) as Record<string, unknown>[]).map((r): ReviewRow => {
      let n: number | null = null;
      try {
        const j = JSON.parse((r.findings_json as string | null) ?? "null");
        const list = Array.isArray(j) ? j : j?.findings; // pre-round rows store a bare array
        if (Array.isArray(list)) n = list.length;
      } catch { /* leave blank */ }
      const url = (r.mr_url as string | null) ?? (projectBase.has(r.project_id as number) ? `${projectBase.get(r.project_id as number)}/-/merge_requests/${r.mr_iid}` : null);
      return {
        mrUrl: url && url.startsWith(`${cfg.gitlabUrl}/`) ? url : null, // only link back to our own GitLab
        projectId: r.project_id as number, mrIid: r.mr_iid as number, headSha: r.head_sha as string, status: r.status as string,
        id: r.id as number, retryable: r.status === "failed" && (r.dry_run === 1) === cfg.dryRun, retryAt: (r.next_retry_at as number | null) ?? null,
        error: r.error as string | null, findingCount: n, dryRun: r.dry_run === 1, createdAt: r.created_at as string, model: (r.model as string | null) ?? null,
        author: (r.mr_author as string | null) ?? null,
        round: (r.round as number | null) ?? null,
      };
    });
    return page(c, <ReviewsPage user={u} csrf={c.get("csrf")} rows={rows} />);
  });

  // Manual re-review of a failed row: resets attempts, releases the row and queues the MR's current head at once.
  app.post("/reviews/:id/retry", authed, csrf, async (c) => {
    const u = c.get("user");
    const msg = (title: string, message: string, status: 200 | 400 | 404 | 429 = 200) => page(c, <MessagePage title={title} message={message} user={u} csrf={c.get("csrf")} />, status);
    const id = Number(c.req.param("id"));
    const row = Number.isSafeInteger(id)
      ? (db.prepare(`SELECT id, owner_id, project_id, mr_iid, head_sha, status, dry_run FROM reviews WHERE id=?`).get(id) as { id: number; owner_id: number; project_id: number; mr_iid: number; head_sha: string; status: string; dry_run: number } | undefined)
      : undefined;
    // Only the row's owner or the Argus owner; anyone else sees the same 404 as a missing row.
    if (!row || (row.owner_id !== u.gitlabUserId && !u.isOwner)) return msg("找不到", "沒有這筆審查紀錄。", 404);
    if (row.status !== "failed" || (row.dry_run === 1) !== cfg.dryRun) return msg("無法重新審查", "只有失敗的審查可以重新審查。", 400);
    const owner = getUserById(db, row.owner_id);
    if (!owner || !owner.approved || !owner.enabled || !owner.skillPath) return msg("無法重新審查", "此審查者目前無法執行審查。", 400);
    let rt: UserRuntime, mr;
    try {
      rt = await runtimeFor(owner);
      mr = await rt.gl.getMr(row.project_id, row.mr_iid);
    } catch (e) {
      console.error("[web] retry lookup failed:", (e as Error).message);
      return msg("無法重新審查", "無法從 GitLab 取得這個 MR，請稍後再試。", 400);
    }
    if (mr.state !== "opened") return msg("無法重新審查", "這個 MR 已不是 open 狀態，不需要重新審查。", 400);
    if (!rt.engine) return msg("無法重新審查", "此審查者目前沒有可用的審查引擎。", 400);
    // Counted only here: a lookup failure or closed MR must not block the user's next retry.
    if (!retryAllowed(String(u.gitlabUserId))) return msg("請稍後再試", "重新審查每 30 秒只能執行一次。", 429);
    const selfReview = isSelfReview(db, row.owner_id, mr.id, row.head_sha, row.dry_run === 1); // read before the reset deletes the row
    if (mr.sha === row.head_sha) resetFailed(db, row.id, row.owner_id); // a moved head is claimed fresh anyway; keep the old failed row as history
    const { queued } = queue.enqueue(laneFor(engineFields(owner), cfg.ownerEngineTestUsers), queueKey(owner.gitlabUserId, mr.id, mr.sha), () => reviewMr(cfg, db, owner, rt, mr, undefined, { selfReview }));
    return msg("已加入審查佇列", queued ? "審查將立即開始，完成後結果會出現在 MR 與審查紀錄。" : "這個 MR 已在佇列中。");
  });

  // --- admin (owner only) ---
  const adminPage = async (c: Context<Env>, extra: { test?: ConnectionTest; force?: boolean } = {}, status: 200 | 429 = 200) => {
    const users = listUsers(db);
    // Latest review row per user in ONE query (no N+1); both modes, the badge says which.
    const lastReviews = new Map((db.prepare(
      `SELECT owner_id, status, error, created_at, dry_run FROM reviews WHERE id IN (SELECT MAX(id) FROM reviews GROUP BY owner_id)`,
    ).all() as { owner_id: number; status: string; error: string | null; created_at: string; dry_run: number }[])
      .map((r): [number, LastReview] => [r.owner_id, { status: r.status, error: r.error, createdAt: r.created_at, dryRun: r.dry_run === 1 }]));
    const engineOf = (u: User) => chooseEngine(engineFields(u), cfg.ownerEngineTestUsers);
    const codexInUse = users.some((x) => x.engine === "codex-cli");
    const engines = { claude: await claudeStatus(extra.force), codex: codexInUse ? await codexStatus(extra.force) : undefined };
    return page(c, <AdminPage cmds={operatorCommands(cfg)} user={c.get("user")} csrf={c.get("csrf")} users={users.map((u) => ({ user: u, engine: engineOf(u), last: lastReviews.get(u.gitlabUserId) }))} engines={engines} test={extra.test} publish={{ dryRun: cfg.dryRun, locked: cfg.dryRunLocked, restart: operatorCommands(cfg).restart, reviewers: users.filter((u) => u.approved && u.enabled).length }} />, status);
  };
  app.get("/admin", authed, ownerOnly, (c) => adminPage(c, { force: c.req.query("refresh") === "1" }));

  // Real (billed) model call with the engine's read-only flags; the result shows OK/error + the model the CLI reports.
  app.post("/admin/engine/test", authed, ownerOnly, csrf, async (c) => {
    if (!testAllowed(String(c.get("user").gitlabUserId))) {
      return page(c, <MessagePage title="請稍後再試" message="連線測試每 30 秒只能執行一次。" user={c.get("user")} csrf={c.get("csrf")} />, 429);
    }
    return adminPage(c, { test: await claudeTestConnection(cfg.claudeBin, c.get("user").model), force: true });
  });

  // Owner-only publish mode. Env DRY_RUN locks it; going live needs an explicit confirm (server-validated, no JS).
  app.post("/admin/dry-run", authed, ownerOnly, csrf, async (c) => {
    const u = c.get("user");
    const err = (title: string, message: string, status: 400) => page(c, <MessagePage title={title} message={message} user={u} csrf={c.get("csrf")} />, status);
    const f = await c.req.parseBody();
    const live = f.mode === "live";
    if (!live && f.mode !== "dry") return err("設定無效", "mode 必須是 live 或 dry。", 400);
    if (live && f.confirm !== "1") return err("請先確認", "切換為正式模式前，請勾選確認方塊。", 400);
    if (!setDryRun(cfg, db, key, !live)) return err("無法變更", "DRY_RUN 已由 .env 鎖定，請移除後重新啟動再於此管理。", 400);
    console.log(`[admin] ${u.username} set publish mode: ${live ? "LIVE (comments will be posted)" : "dry-run"}`);
    return c.redirect("/admin");
  });

  for (const action of ["approve", "disable"] as const) {
    app.post(`/admin/users/:id/${action}`, authed, ownerOnly, csrf, (c) => {
      const id = Number(c.req.param("id"));
      const target = Number.isSafeInteger(id) ? getUserById(db, id) : undefined;
      if (!target) return page(c, <MessagePage title="找不到" message="沒有這位使用者。" user={c.get("user")} csrf={c.get("csrf")} />, 404);
      if (target.isOwner) return page(c, <MessagePage title="不允許" message="無法在此變更 owner。" user={c.get("user")} csrf={c.get("csrf")} />, 400);
      setUserEnabled(db, id, action === "approve");
      return c.redirect("/admin");
    });
  }

  // The "which engine" choice is explicit and owner-set; setUser validates it against ENGINES.
  app.post("/admin/users/:id/engine", authed, ownerOnly, csrf, async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isSafeInteger(id) ? getUserById(db, id) : undefined;
    if (!target) return page(c, <MessagePage title="找不到" message="沒有這位使用者。" user={c.get("user")} csrf={c.get("csrf")} />, 404);
    const engine = String((await c.req.parseBody()).engine ?? "");
    try {
      setUser(db, target.username, [`engine=${engine}`]);
    } catch (e) {
      return page(c, <MessagePage title="設定無效" message={(e as Error).message} user={c.get("user")} csrf={c.get("csrf")} />, 400);
    }
    return c.redirect("/admin");
  });

  return app;
}
