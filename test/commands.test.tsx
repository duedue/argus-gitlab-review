import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { assertRequiredConfig, loadConfig } from "../src/config.ts";
import { operatorCommands } from "../src/commands.ts";
import { openDb } from "../src/db.ts";
import { startSetupMode } from "../src/setup.ts";
import { createApp } from "../src/web/app.tsx";
import { AdminPage, render } from "../src/web/views.tsx";
import type { User } from "../src/users.ts";

const cmds = (env: Record<string, string>) => operatorCommands(loadConfig({ BASE_URL: "https://argus.example:8443", ...env }));

test("config: deploy is explicit, defaults to local; unknown values (incl. removed modes) warn and fall back", () => {
  assert.equal(loadConfig({}).deploy, "local");
  assert.equal(loadConfig({ ARGUS_DEPLOY: "local" }).deploy, "local");
  assert.equal(loadConfig({ ARGUS_DEPLOY: "compose" }).deploy, "compose");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(String(m));
  try {
    assert.equal(loadConfig({ ARGUS_DEPLOY: "bogus" }).deploy, "local");
    assert.equal(loadConfig({ ARGUS_DEPLOY: "docker" }).deploy, "local"); // removed mode
    assert.equal(warns.length, 2);
    assert.match(warns[0]!, /ARGUS_DEPLOY/);
    loadConfig({ ARGUS_DEPLOY: "compose" });
    loadConfig({});
    assert.equal(warns.length, 2); // valid or unset: no warning
  } finally {
    console.warn = orig;
  }
});

test("config: GITLAB_URL is required (no default), normalised; JIRA_URL optional", () => {
  assert.throws(() => assertRequiredConfig(loadConfig({})), /GITLAB_URL is required/);
  assert.throws(() => assertRequiredConfig(loadConfig({ GITLAB_URL: "   " })), /GITLAB_URL is required/);
  assert.throws(() => assertRequiredConfig(loadConfig({ GITLAB_URL: "gitlab.example.com" })), /http\(s\) URL/);
  const ok = loadConfig({ GITLAB_URL: " https://gitlab.example.com/ " });
  assert.equal(ok.gitlabUrl, "https://gitlab.example.com");
  assert.doesNotThrow(() => assertRequiredConfig(ok));
  assert.equal(ok.jira.url, "");
});

test("operatorCommands: compose uses docker compose exec / up -d, no ssh", () => {
  const c = cmds({ ARGUS_DEPLOY: "compose" });
  assert.equal(c.deploy, "compose");
  assert.equal(c.claudeLogin, "docker compose exec argus claude");
  assert.equal(c.codexLogin, "docker compose exec argus codex login --device-auth");
  assert.equal(c.setupCode, "docker compose exec argus cat /data/setup-code");
  assert.equal(c.restart, "docker compose up -d");
});

test("operatorCommands: local runs the CLIs directly", () => {
  const l = cmds({});
  assert.equal(l.deploy, "local");
  assert.equal(l.restart, "");
  assert.equal(l.claudeLogin, "claude");
  assert.equal(l.codexLogin, "codex login --device-auth");
  assert.equal(l.setupCode, "cat data/setup-code");
});

const owner = { username: "o", isOwner: true, gitlabUserId: 1 } as User;
function adminHtml(env: Record<string, string>, locked = false) {
  const engines = { claude: { state: "logged-out" as const }, codex: { state: "logged-out" as const } };
  const c = cmds(env);
  return String(render(<AdminPage cmds={c} user={owner} csrf="t" users={[]} engines={engines} publish={{ dryRun: true, locked, restart: c.restart, reviewers: 1 }} />));
}

test("admin engine card renders the per-deploy commands", () => {
  const c = adminHtml({ ARGUS_DEPLOY: "compose" });
  assert.match(c, /<pre[^>]*>docker compose exec argus claude<\/pre>/);
  assert.match(c, /docker compose exec argus codex login --device-auth/);
  assert.doesNotMatch(c, /ssh -t|argus\.sh/);
  const l = adminHtml({});
  assert.match(l, /<pre[^>]*>claude<\/pre>/);
  assert.doesNotMatch(l, /docker compose|ssh -t/);
});

test("admin DRY_RUN lock hint points at .env and the compose command", () => {
  const c = adminHtml({ ARGUS_DEPLOY: "compose" }, true);
  assert.match(c, /<code>\.env<\/code>/);
  assert.match(c, /docker compose up -d/);
  assert.doesNotMatch(adminHtml({}, true), /docker compose/);
});

test("setup page help shows the compose setup-code command and where to look", async () => {
  const get = async (env: Record<string, string>) => {
    const dataDir = mkdtempSync(join(tmpdir(), "cmds-"));
    const cfg = loadConfig({ DATA_DIR: dataDir, GITLAB_URL: "https://gitlab.example.com", BASE_URL: "http://argus.example:3000", ...env });
    const db = openDb(":memory:");
    startSetupMode(cfg, db, () => {});
    const oauth = { gitlabUrl: cfg.gitlabUrl, redirectUri: "http://argus.example:3000/auth/callback", clientId: "", clientSecret: "", fetch: fetch };
    return (await createApp({ cfg, db, key: randomBytes(32), oauth }).request("/setup")).text();
  };
  const c = await get({ ARGUS_DEPLOY: "compose" });
  assert.match(c, /docker compose exec argus cat \/data\/setup-code/);
  assert.match(c, /docker compose logs argus/);
  assert.doesNotMatch(await get({}), /docker compose/);
});
