import { join } from "node:path";
import { assertRequiredConfig, loadConfig } from "./config.ts";
import { getMasterKey, keyInit } from "./crypto.ts";
import { releaseStaleRunning, openDb } from "./db.ts";
import { warnOwnerEngineTest } from "./engine.ts";
import { GitLab } from "./gitlab.ts";
import type { OAuthCtx } from "./oauth.ts";
import { parseHeadSha, reviewMr } from "./review.ts";
import { pollCycle, pollLoop, runtimeFactory } from "./runtime.ts";
import { applyStoredSettings, resetSetup, resolveOAuthCreds } from "./setup.ts";
import { ENGINES, addUser, daysUntilExpiry, getUser, listUsers, removeUser, resolveSkillPath, setUser, type User } from "./users.ts";

const USAGE = `usage: cli.ts <command>
  key init
  user add --skill <path> [--owner]     (token from env GITLAB_TOKEN or stdin)
  user list | user set <username> key=value... | user remove <username>
  setup reset                           (forget the web-setup OAuth/Jira/owner settings; next start re-enters setup mode)
  once | loop
  review <project_id> <mr_iid> [--user <username>] [--head <sha>] [--engine <name>]
                                        (always dry-run; --head reviews the MR as of that commit; --engine overrides the user's engine for this run only)`;
const die = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

const [cmd, sub, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
try {
  assertRequiredConfig(cfg);
} catch (e) {
  die((e as Error).message);
}
const db = openDb(join(cfg.dataDir, "argus.db"));

async function readToken(): Promise<string> {
  let t = process.env.GITLAB_TOKEN;
  if (!t && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    t = Buffer.concat(chunks).toString("utf8");
  }
  return t?.trim() || die("token required: set env GITLAB_TOKEN or pipe it on stdin (never as an argument)");
}

async function userAdd(args: string[]): Promise<void> {
  const si = args.indexOf("--skill");
  const skill = si >= 0 ? args[si + 1] : undefined;
  if (!skill) die("user add: --skill <path> is required");
  const skillPath = resolveSkillPath(skill!);
  const key = getMasterKey(); // fail closed before touching the token
  const token = await readToken();
  const gl = new GitLab({ gitlabUrl: cfg.gitlabUrl, token });
  const me = await gl.currentUser();
  const info = await gl.tokenInfo();
  if (!info.active) die("token is not active");
  if (!info.scopes.includes("api")) die(`token needs the "api" scope (has: ${info.scopes.join(", ")})`);
  const days = daysUntilExpiry({ tokenExpiresAt: info.expires_at });
  if (days !== undefined && days < 0) die(`token expired on ${info.expires_at}`);
  addUser(db, key, { gitlabUserId: me.id, username: me.username, token, tokenExpiresAt: info.expires_at, skillPath, isOwner: args.includes("--owner") });
  console.log(`user ${me.username} (id ${me.id}) saved; token expires ${info.expires_at ?? "never"}${args.includes("--owner") ? "; owner" : ""}`);
}

function printUsers(users: User[]): void {
  console.table(
    users.map((u) => ({
      id: u.gitlabUserId, username: u.username, owner: u.isOwner, enabled: u.enabled, expires: u.tokenExpiresAt ?? "never",
      engine: u.engine, severity: u.severityThreshold, confidence: u.confidenceThreshold, language: u.language, skill: u.skillPath,
    })),
  );
}

// OAuth users need the app credentials to refresh tokens; PAT-only setups run without them.
function oauthCtx(): OAuthCtx | undefined {
  const creds = resolveOAuthCreds(db, getMasterKey());
  return creds && { gitlabUrl: cfg.gitlabUrl, redirectUri: `${cfg.web.baseUrl}/auth/callback`, ...creds };
}

if (cmd === "key" && sub === "init") {
  console.log(keyInit() ? "master key created in macOS Keychain (service argus)" : "master key already present; nothing changed");
} else if (cmd === "setup" && sub === "reset") {
  console.log(`cleared ${resetSetup(db)} setup setting(s); restart Argus (with no OAUTH_* env) to re-enter setup mode`);
} else if (cmd === "user" && sub === "add") {
  await userAdd(rest);
} else if (cmd === "user" && sub === "list") {
  printUsers(listUsers(db));
} else if (cmd === "user" && sub === "set") {
  const [name, ...pairs] = rest;
  setUser(db, name ?? die(USAGE), pairs);
  console.log(`updated ${name}`);
} else if (cmd === "user" && sub === "remove") {
  const name = rest[0] ?? die(USAGE);
  console.log(removeUser(db, name) ? `removed ${name}` : `no such user: ${name}`);
} else if (cmd === "once" || cmd === "loop" || cmd === "review") {
  warnOwnerEngineTest(cfg.ownerEngineTestUsers);
  // Only the long-running poller owns stale-row cleanup; `once`/`review` may run beside a live server.
  if (cmd === "loop") releaseStaleRunning(db);
  const key = getMasterKey();
  applyStoredSettings(cfg, db, key);
  const oauth = oauthCtx();
  const rt = runtimeFactory(cfg, db, key, oauth);
  if (cmd === "review") {
    // Dev aid: review an arbitrary MR (e.g. an already-merged one). Always dry-run.
    cfg.dryRun = true;
    const projectId = Number(sub);
    const iid = Number(rest[0]);
    if (!projectId || !iid) die(USAGE);
    const hi = rest.indexOf("--head");
    let head: string | undefined;
    try {
      head = hi >= 0 ? parseHeadSha(rest[hi + 1]) : undefined;
    } catch (e) {
      die((e as Error).message);
    }
    const ui = rest.indexOf("--user");
    const users = listUsers(db);
    const user = ui >= 0 ? getUser(db, rest[ui + 1] ?? "") : users.length === 1 ? users[0] : users.find((u) => u.isOwner);
    if (!user) die("no matching user (use --user <username>; see `user list`)");
    // Dev-only engine override (never persisted; this command is dry-run only).
    const ei = rest.indexOf("--engine");
    const engine = ei >= 0 ? rest[ei + 1] : undefined;
    if (engine !== undefined && !(ENGINES as readonly string[]).includes(engine)) die(`--engine must be one of ${ENGINES.join("|")}`);
    const runUser = engine ? { ...user!, engine: engine as User["engine"] } : user!;
    const r = await rt(runUser);
    await reviewMr(cfg, db, runUser, r, await r.gl.getMr(projectId, iid), head);
  } else {
    console.log(cfg.dryRun ? "dry-run: nothing will be posted" : "LIVE: comments WILL be posted to GitLab");
    if (cmd === "once") await pollCycle(cfg, db, key, oauth);
    else await pollLoop(cfg, db, key, oauth);
  }
} else die(USAGE);
