import { createHash, randomBytes } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";
import type { Db } from "./db.ts";
import { getOAuthCreds, type OAuthCtx } from "./oauth.ts";
import { safeEqual } from "./sessions.ts";

// First-run setup mode: OAuth credentials missing from env/Keychain AND the DB. Precedence everywhere: env > DB settings.
// `settings` rows: oauth_client_id / oauth_client_secret / jira_token are AES-GCM encrypted; owner_ref / setup_code_hash are plain
// (the hash is a sha256 of a random 80-bit code, so it cannot be brute-forced offline).

const ENCRYPTED = new Set(["oauth_client_id", "oauth_client_secret", "jira_token"]);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols (5 bits each), no I/O/0/1
export const SETUP_CODE_FILE = "setup-code";

const hashCode = (code: string) => createHash("sha256").update(normalizeCode(code)).digest("hex");

/** Case/space/dash-insensitive so a code typed by hand still matches. */
export const normalizeCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** 16 symbols x 5 bits = 80 bits, shown as XXXX-XXXX-XXXX-XXXX. */
export function generateSetupCode(): string {
  const b = randomBytes(16);
  const s = Array.from({ length: 16 }, (_, i) => ALPHABET[b[i]! & 31]).join("");
  return s.match(/.{4}/g)!.join("-");
}

export function getSetting(db: Db, key: Buffer, name: string): string | undefined {
  const r = db.prepare(`SELECT value FROM settings WHERE name=?`).get(name) as { value: Buffer } | undefined;
  if (!r) return undefined;
  return ENCRYPTED.has(name) ? decrypt(key, r.value) : r.value.toString("utf8");
}

function putSetting(db: Db, key: Buffer, name: string, value: string): void {
  const v = ENCRYPTED.has(name) ? encrypt(key, value) : Buffer.from(value, "utf8");
  db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).run(name, v);
}

export function storedOAuth(db: Db, key: Buffer): { clientId: string; clientSecret: string } | undefined {
  const clientId = getSetting(db, key, "oauth_client_id");
  const clientSecret = getSetting(db, key, "oauth_client_secret");
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/**
 * Wire DB-stored owner/Jira token under env: env always wins. The Jira getter reads the DB lazily, so a token saved by
 * the setup page applies without a restart.
 */
export function applyStoredSettings(cfg: Config, db: Db, key: Buffer): void {
  cfg.ownerRef ??= getSetting(db, key, "owner_ref");
  applyDryRunSetting(cfg, db, key);
  const fromEnv = cfg.jira.token;
  cfg.jira.token = () => {
    try {
      return fromEnv() ?? getSetting(db, key, "jira_token");
    } catch {
      return undefined; // undecryptable (wrong master key): Jira context is optional, never fail a review over it
    }
  };
}

/** env DRY_RUN locks the mode; otherwise the DB `dry_run` setting ("0" = live) decides; absent = dry-run ON (cfg default). */
export function applyDryRunSetting(cfg: Config, db: Db, key: Buffer): void {
  if (cfg.dryRunLocked) return;
  const v = getSetting(db, key, "dry_run");
  if (v !== undefined) cfg.dryRun = v !== "0";
}

/** Single write path for the web toggle: persist, then update the running config (applies to the next review, no restart). False = locked by env. */
export function setDryRun(cfg: Config, db: Db, key: Buffer, dryRun: boolean): boolean {
  if (cfg.dryRunLocked) return false;
  const was = cfg.dryRun;
  putSetting(db, key, "dry_run", dryRun ? "1" : "0");
  cfg.dryRun = dryRun;
  if (was !== dryRun) {
    // Retries are only swept/allowed for the current mode; pending ones of the mode being left would otherwise
    // freeze and fire much later if the mode is switched back. Finalize them now (no note).
    const n = db.prepare(`UPDATE reviews SET next_retry_at=NULL WHERE status='failed' AND dry_run=? AND next_retry_at IS NOT NULL`).run(was ? 1 : 0).changes;
    if (n) console.log(`[publish] cleared ${n} pending retr${n === 1 ? "y" : "ies"} of the previous mode`);
  }
  return true;
}

/** New one-time code: hash into the DB, plaintext to DATA_DIR/setup-code (0600) and one log line. Overwrites any previous code. */
export function startSetupMode(cfg: Config, db: Db, log: (m: string) => void = console.log): string {
  const code = generateSetupCode();
  db.prepare(`INSERT INTO settings (name, value) VALUES ('setup_code_hash', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).run(Buffer.from(hashCode(code)));
  const file = join(cfg.dataDir, SETUP_CODE_FILE);
  writeFileSync(file, `${code}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // mode above only applies when the file is created
  log(`[setup] Argus is not configured yet. Setup code: ${code}  Open ${cfg.web.baseUrl}/setup`);
  return code;
}

export function removeSetupCodeFile(cfg: Config): void {
  rmSync(join(cfg.dataDir, SETUP_CODE_FILE), { force: true });
}

export function checkSetupCode(db: Db, code: string): boolean {
  const r = db.prepare(`SELECT value FROM settings WHERE name='setup_code_hash'`).get() as { value: Buffer } | undefined;
  const ok = !!r && safeEqual(r.value.toString("utf8"), hashCode(code)); // constant-time on equal-length sha256 hex
  return ok;
}

export interface SetupInput { clientId: string; clientSecret: string; owner: string; jiraToken?: string }

const SAFE = (max: number) => new RegExp(`^[\\w.\\-]{8,${max}}$`);
/** Returns a zh-TW error message, or the cleaned input. */
export function validateSetupInput(f: Record<string, string>): SetupInput | string {
  const clientId = (f.client_id ?? "").trim();
  const clientSecret = (f.client_secret ?? "").trim();
  const owner = (f.owner ?? "").trim().replace(/^@/, "");
  const jiraToken = (f.jira_token ?? "").trim();
  if (!SAFE(200).test(clientId)) return "Application ID 格式不正確（8-200 個英數字、底線、點或連字號）。";
  if (!SAFE(300).test(clientSecret)) return "Secret 格式不正確（8-300 個英數字、底線、點或連字號）。";
  if (!/^(\d{1,12}|[A-Za-z0-9_.\-]{1,255})$/.test(owner)) return "Owner 請填 GitLab 數字使用者 ID（建議）或帳號名稱。";
  if (jiraToken && !/^[\x21-\x7e]{1,500}$/.test(jiraToken)) return "Jira token 格式不正確。";
  return { clientId, clientSecret, owner, jiraToken: jiraToken || undefined };
}

/**
 * One transaction: atomically consume the code (DELETE ... WHERE hash matches; exactly one concurrent submit can win),
 * store everything. Returns false (nothing stored) if the code was already used or is wrong.
 */
export function completeSetup(db: Db, key: Buffer, cfg: Config, i: SetupInput, code: string): boolean {
  const ok = db.transaction(() => {
    const burned = db.prepare(`DELETE FROM settings WHERE name='setup_code_hash' AND value=?`).run(Buffer.from(hashCode(code))).changes;
    if (burned !== 1) return false;
    putSetting(db, key, "oauth_client_id", i.clientId);
    putSetting(db, key, "oauth_client_secret", i.clientSecret);
    putSetting(db, key, "owner_ref", i.owner);
    if (i.jiraToken) putSetting(db, key, "jira_token", i.jiraToken);
    return true;
  })();
  if (!ok) return false;
  removeSetupCodeFile(cfg);
  cfg.ownerRef ??= i.owner; // env ARGUS_OWNER (already in cfg) wins
  return true;
}

/** `setup reset`: forget DB-stored setup; the next start (with no env creds) re-enters setup mode. */
export function resetSetup(db: Db): number {
  return db.prepare(`DELETE FROM settings`).run().changes;
}

/** Env/Keychain first, then DB: env always wins. Undefined = not configured anywhere (setup mode). */
export function resolveOAuthCreds(db: Db, key: Buffer, readEnv: () => { clientId: string; clientSecret: string } = getOAuthCreds): { clientId: string; clientSecret: string } | undefined {
  try {
    return readEnv();
  } catch {
    return storedOAuth(db, key);
  }
}

/** Startup decision for the web entry: resolve creds (env > DB); none => setup mode (new code), else drop any stale code file. */
export function bootstrapSetup(cfg: Config, db: Db, key: Buffer, readEnv?: Parameters<typeof resolveOAuthCreds>[2]): { oauth: OAuthCtx; setupMode: boolean } {
  const creds = resolveOAuthCreds(db, key, readEnv);
  const oauth: OAuthCtx = { gitlabUrl: cfg.gitlabUrl, redirectUri: `${cfg.web.baseUrl}/auth/callback`, clientId: creds?.clientId ?? "", clientSecret: creds?.clientSecret ?? "" };
  if (creds) removeSetupCodeFile(cfg);
  else startSetupMode(cfg, db);
  return { oauth, setupMode: !creds };
}
