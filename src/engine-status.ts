import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, claudeArgs, extractModel, extractResultText, runClaude, type ClaudeTokenAuth } from "./engine.ts";
import type { Model } from "./users.ts";

export interface ClaudeAuth {
  state: "logged-in" | "logged-out" | "missing" | "error";
  authMethod?: string;
  subscription?: string;
  email?: string; // masked
  detail?: string;
}

const short = (v: unknown): string | undefined => (typeof v === "string" && v ? v.replace(/[^\w .@:+\-]/g, "").slice(0, 40) : undefined);

/** "alice@example.com" -> "a***@example.com". The status output is the only source; nothing else is ever shown. */
export function maskEmail(e: string): string {
  const [local, domain] = e.split("@");
  return domain ? `${local!.slice(0, 1)}***@${domain}` : "***";
}

/** Pure: `claude auth status --json` (exit 1 + loggedIn:false when logged out). Only whitelisted fields survive; tokens never appear in it. */
export function parseClaudeAuth(stdout: string): ClaudeAuth {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { state: "error", detail: "無法解析 claude auth status 的輸出" };
  }
  if (typeof j?.loggedIn !== "boolean") return { state: "error", detail: "claude auth status 輸出格式不符" };
  if (!j.loggedIn) return { state: "logged-out" };
  return { state: "logged-in", authMethod: short(j.authMethod), subscription: short(j.subscriptionType), email: typeof j.email === "string" ? maskEmail(j.email.slice(0, 120)) : undefined };
}

const run = (bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number | string | null; missing: boolean }> =>
  new Promise((resolve) =>
    execFile(bin, args, { env, timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      const code = err ? ((err as { code?: number | string }).code ?? null) : 0;
      resolve({ stdout, code, missing: code === "ENOENT" });
    }),
  );

/** Same env allowlist as the engine, so the check sees the same CLAUDE_CONFIG_DIR / HOME the reviews use. */
export async function claudeAuthStatus(bin: string, env: NodeJS.ProcessEnv = agentEnv()): Promise<ClaudeAuth> {
  const r = await run(bin, ["auth", "status", "--json"], env);
  if (r.missing) return { state: "missing" };
  return r.stdout.trim() ? parseClaudeAuth(r.stdout) : { state: "error", detail: `claude auth status 失敗 (${r.code})` };
}

export interface CodexAuth {
  state: "logged-in" | "logged-out" | "missing";
  method?: string; // ChatGPT | API key; the raw status line is never shown
}

/** `codex login status`: exit 0 + "Logged in using ChatGPT" / "... an API key"; non-zero = not logged in. */
export async function codexLoginStatus(bin: string, env: NodeJS.ProcessEnv = { ...agentEnv(), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) }): Promise<CodexAuth> {
  const r = await run(bin, ["login", "status"], env);
  if (r.missing) return { state: "missing" };
  if (r.code !== 0) return { state: "logged-out" };
  return { state: "logged-in", method: /chatgpt/i.test(r.stdout) ? "ChatGPT" : /api key/i.test(r.stdout) ? "API key" : undefined };
}

export interface ConnectionTest {
  ok: boolean;
  rejected?: boolean; // the CLI answered 401 for the personal token
  model?: string;
  error?: string;
}

/**
 * Minimal read-only `claude -p` round trip (same flags/env as reviews, empty cwd, no repo). Without `auth` it tests the
 * owner's container login; with `auth` a personal Claude token (rejected = `rejected: true`, the message never holds the token).
 */
export async function claudeTestConnection(bin: string, model?: Model | null, auth?: ClaudeTokenAuth): Promise<ConnectionTest> {
  const cwd = mkdtempSync(join(tmpdir(), "argus-test-"));
  let rejected = false;
  const a = auth && { ...auth, onRejected: () => void (rejected = true) };
  try {
    const out = await runClaude(bin, claudeArgs(model), "Reply with the single word OK.", cwd, 90_000, a);
    extractResultText(out); // throws on is_error / no result
    return { ok: true, model: extractModel(out) };
  } catch (e) {
    return { ok: false, rejected, error: (e as Error).message.slice(0, 200) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Tiny TTL cache; `force` bypasses it (the admin page's "recheck" link). */
export function ttlCache<T>(ttlMs: number, fn: () => Promise<T>, now: () => number = Date.now): (force?: boolean) => Promise<T> {
  let at = -Infinity;
  let val: Promise<T> | undefined; // caching the promise lets concurrent callers share one in-flight lookup
  return (force = false) => {
    if (!force && val && now() - at < ttlMs) return val;
    at = now();
    const p = fn();
    val = p;
    p.catch(() => { if (val === p) val = undefined; }); // a failed lookup is not cached
    return p;
  };
}
