import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { join } from "node:path";
import { decrypt } from "./crypto.ts";
import { engineFor, type ClaudeTokenAuth } from "./engine.ts";
import { GitLab } from "./gitlab.ts";
import { accessTokenFor, type OAuthCtx } from "./oauth.ts";
import { pollOnce, type UserRuntime } from "./review.ts";
import { engineFields, listUsers, markClaudeTokenRejected, type User } from "./users.ts";

/** Per-user CLAUDE_CONFIG_DIR: a personal token never shares the owner's container login state (or another user's). */
export const claudeConfigDir = (dataDir: string, gitlabUserId: number): string => join(dataDir, "engines", String(gitlabUserId), "claude");

/**
 * Credentials for the user's own Claude token, or undefined without one. The ciphertext captured here is what a 401 flags,
 * so a token replaced while this review ran is never marked invalid. Decryption happens only when the CLI is spawned.
 */
export function claudeAuthFor(cfg: Pick<Config, "dataDir">, db: Db, key: Buffer, u: User): ClaudeTokenAuth | undefined {
  const enc = u.claudeTokenEnc;
  if (!enc) return undefined;
  return {
    token: () => decrypt(key, enc),
    configDir: claudeConfigDir(cfg.dataDir, u.gitlabUserId),
    onRejected: () => {
      markClaudeTokenRejected(db, u.gitlabUserId, enc);
      console.warn(`[engine] ${u.username}: Claude token rejected (401); marked invalid until the user pastes a new one`);
    },
  };
}

/** Per-user runtime: fresh token (refreshed if needed) + GitLab client + subscription-guarded engine. */
export const runtimeFactory = (cfg: Config, db: Db, key: Buffer, oauth?: OAuthCtx) => async (u: User): Promise<UserRuntime> => {
  const get = () => accessTokenFor(db, key, oauth, u.gitlabUserId);
  await get(); // fail fast (refresh / invalid token) before listing MRs
  const bearer = u.tokenType === "oauth";
  return { token: get, gl: new GitLab({ gitlabUrl: cfg.gitlabUrl, token: get, bearer }), engine: engineFor(engineFields(u), cfg.claudeBin, cfg.ownerEngineTestUsers, { codexBin: cfg.codexBin, dataDir: cfg.dataDir }, claudeAuthFor(cfg, db, key, u)) };
};

/** One cycle over all users (re-read each time so CLI/web changes apply without a restart). */
export function pollCycle(cfg: Config, db: Db, key: Buffer, oauth?: OAuthCtx): Promise<void> {
  let users = listUsers(db);
  if (oauth && (!oauth.clientId || !oauth.clientSecret) && users.some((u) => u.tokenType === "oauth")) {
    console.warn("[poll] OAuth not configured yet (setup mode); skipping OAuth users this cycle"); // once per cycle, not per user
    users = users.filter((u) => u.tokenType !== "oauth");
  }
  if (!users.length) console.warn("[poll] no users configured; run `user add` or log in via the web UI (see README)");
  return pollOnce(cfg, db, users, runtimeFactory(cfg, db, key, oauth));
}

/** Sequential loop: the next cycle starts `intervalMs` after the previous one FINISHED, so cycles never overlap. */
export async function runLoop(cycle: () => Promise<void>, intervalMs: number, stop?: AbortSignal): Promise<void> {
  while (!stop?.aborted) {
    await cycle().catch((e) => console.error("[poll] failed:", (e as Error).message));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const pollLoop = (cfg: Config, db: Db, key: Buffer, oauth?: OAuthCtx): Promise<void> =>
  runLoop(() => pollCycle(cfg, db, key, oauth), cfg.pollIntervalMs);
