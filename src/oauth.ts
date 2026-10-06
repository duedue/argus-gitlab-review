import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "./crypto.ts";
import type { Db } from "./db.ts";
import { getUserById } from "./users.ts";

export const REFRESH_SKEW_MS = 5 * 60_000;
export const OAUTH_SCOPES = "api read_repository";

export interface OAuthCtx {
  gitlabUrl: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch; // injectable for tests
  now?: () => number;
}

function keychainRead(account: string): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "argus", "-a", account, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Keychain first (dev), then env OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET (Docker secret later). Fail closed; never logged. */
export function getOAuthCreds(env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } {
  const clientId = keychainRead("oauth-client-id") ?? env.OAUTH_CLIENT_ID;
  const clientSecret = keychainRead("oauth-client-secret") ?? env.OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("no OAuth credentials: store them in the Keychain (argus / oauth-client-id, oauth-client-secret) or set OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET");
  return { clientId, clientSecret };
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Fresh state + PKCE (S256) pair for one login attempt. */
export function newAuthRequest(ctx: Pick<OAuthCtx, "gitlabUrl" | "redirectUri" | "clientId">): { url: string; state: string; verifier: string } {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const q = new URLSearchParams({
    client_id: ctx.clientId,
    redirect_uri: ctx.redirectUri,
    response_type: "code",
    state,
    scope: OAUTH_SCOPES,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return { url: `${ctx.gitlabUrl}/oauth/authorize?${q}`, state, verifier };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms
}

class TokenEndpointError extends Error {
  constructor(public status: number | undefined, msg: string, public code?: string) {
    super(msg);
  }
}

async function tokenRequest(ctx: OAuthCtx, params: Record<string, string>): Promise<TokenSet> {
  const now = ctx.now?.() ?? Date.now();
  let res: Response;
  try {
    res = await (ctx.fetch ?? fetch)(`${ctx.gitlabUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: ctx.clientId, client_secret: ctx.clientSecret, redirect_uri: ctx.redirectUri, ...params }),
    });
  } catch (e) {
    throw new TokenEndpointError(undefined, `token endpoint unreachable: ${(e as Error).message}`);
  }
  // Error bodies carry only an error code/description, never our secrets; still truncate.
  if (!res.ok) {
    const body = await res.text();
    let code: string | undefined;
    try {
      const e = (JSON.parse(body) as { error?: unknown }).error;
      if (typeof e === "string") code = e;
    } catch { /* non-JSON error body: no code */ }
    throw new TokenEndpointError(res.status, `token endpoint -> ${res.status}: ${body.slice(0, 200)}`, code);
  }
  const j = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  if (typeof j?.access_token !== "string" || typeof j.refresh_token !== "string" || typeof j.expires_in !== "number") {
    throw new TokenEndpointError(undefined, "token endpoint returned an unexpected payload");
  }
  return { accessToken: j.access_token, refreshToken: j.refresh_token, accessExpiresAt: now + j.expires_in * 1000 };
}

export const exchangeCode = (ctx: OAuthCtx, code: string, verifier: string): Promise<TokenSet> =>
  tokenRequest(ctx, { grant_type: "authorization_code", code, code_verifier: verifier });

/** Identity of the token holder (the OAuth login result). */
export async function fetchIdentity(ctx: OAuthCtx, accessToken: string): Promise<{ id: number; username: string }> {
  const res = await (ctx.fetch ?? fetch)(`${ctx.gitlabUrl}/api/v4/user`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`GET /user -> ${res.status}`);
  const j = (await res.json()) as { id?: unknown; username?: unknown };
  if (typeof j.id !== "number" || typeof j.username !== "string") throw new Error("GET /user returned an unexpected payload");
  return { id: j.id, username: j.username };
}

// One refresh at a time per user: GitLab rotates refresh tokens, so two parallel refreshes would burn the token.
const inflight = new Map<number, Promise<string>>();

/**
 * Usable access token for a user. PAT: decrypted as-is. OAuth: refreshed when it expires within 5 min, with
 * the rotated pair persisted in one UPDATE. A definitive rejection (4xx invalid_grant) marks the token invalid (user must log
 * in again); network errors / 5xx are transient and only throw, so a GitLab blip never forces a re-login.
 */
export function accessTokenFor(db: Db, key: Buffer, ctx: OAuthCtx | undefined, userId: number): Promise<string> {
  const running = inflight.get(userId);
  if (running) return running;
  const p = resolveToken(db, key, ctx, userId).finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

async function resolveToken(db: Db, key: Buffer, ctx: OAuthCtx | undefined, userId: number): Promise<string> {
  const u = getUserById(db, userId);
  if (!u) throw new Error("no such user");
  if (u.tokenInvalid) throw new Error(`${u.username}: OAuth token invalid, user must log in again`);
  if (u.tokenType === "pat") return decrypt(key, u.tokenEnc);
  if (!u.refreshTokenEnc) throw new Error(`${u.username}: OAuth user without refresh token`);
  const now = ctx?.now?.() ?? Date.now();
  if (u.accessExpiresAt !== null && u.accessExpiresAt - now > REFRESH_SKEW_MS) return decrypt(key, u.tokenEnc);
  if (!ctx || !ctx.clientId || !ctx.clientSecret) throw new Error("OAuth is not configured; cannot refresh token"); // transient: never marks invalid (setup mode / after `setup reset`)

  try {
    const t = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: decrypt(key, u.refreshTokenEnc) });
    db.prepare(`UPDATE users SET token_enc=?, refresh_token_enc=?, access_expires_at=? WHERE gitlab_user_id=?`).run(
      encrypt(key, t.accessToken), encrypt(key, t.refreshToken), t.accessExpiresAt, userId,
    );
    return t.accessToken;
  } catch (e) {
    // Only invalid_grant means "this refresh token is dead". invalid_client (401) means OUR client id/secret are wrong:
    // that must never log every user out, so it (and any other non-grant error) stays transient.
    if (!(e instanceof TokenEndpointError) || e.status === undefined || e.status >= 500 || e.code !== "invalid_grant") throw e;
    // Another process (e.g. `npm run dev`) may have rotated the pair first; if so, its fresh token is fine.
    const fresh = getUserById(db, userId);
    if (fresh?.refreshTokenEnc && !fresh.refreshTokenEnc.equals(u.refreshTokenEnc)) return decrypt(key, fresh.tokenEnc);
    db.prepare(`UPDATE users SET token_invalid=1 WHERE gitlab_user_id=?`).run(userId);
    console.error(`[oauth] ${u.username}: refresh rejected (${e.status}); marked invalid, user must log in again`);
    throw new Error(`${u.username}: OAuth refresh rejected (${e.status}), user must log in again`);
  }
}
