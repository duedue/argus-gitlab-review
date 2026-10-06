import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { CodexEngine, ClaudeCliEngine, OUTPUT_CONTRACT, engineFor, type ReviewInput } from "../src/engine.ts";
import { addUser, getUser, setUser, type User } from "../src/users.ts";
import { createSession } from "../src/sessions.ts";
import { createApp } from "../src/web/app.tsx";

const key = randomBytes(32);
const tmp = () => mkdtempSync(join(tmpdir(), "engines-"));
const skillPath = join(tmp(), "SKILL.md");
writeFileSync(skillPath, "SKILL-CRITERIA");

// --- engine field: migration / default / validation ---

test("engine column: legacy DB migrates with the claude-cli default; new users default; bad values rejected without writing", () => {
  const f = join(tmp(), "legacy.db");
  const old = new Database(f);
  old.exec(`CREATE TABLE users (gitlab_user_id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, token_enc BLOB NOT NULL, token_expires_at TEXT,
    skill_path TEXT NOT NULL, severity_threshold TEXT NOT NULL DEFAULT 'minor', confidence_threshold REAL NOT NULL DEFAULT 0.7,
    language TEXT NOT NULL DEFAULT 'zh-TW', enabled INTEGER NOT NULL DEFAULT 1, is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (gitlab_user_id, username, token_enc, skill_path, is_owner) VALUES (1, 'old', x'00', '/s', 1);`);
  old.close();
  const db = openDb(f);
  assert.equal(getUser(db, "old")!.engine, "claude-cli");
  addUser(db, key, { gitlabUserId: 2, username: "new", token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  assert.equal(getUser(db, "new")!.engine, "claude-cli");
  setUser(db, "new", ["engine=codex-cli"]);
  assert.equal(getUser(db, "new")!.engine, "codex-cli");
  for (const bad of ["engine=gpt", "engine=", "engine=Codex-CLI"]) assert.throws(() => setUser(db, "new", ["language=en", bad]), /engine 必須是/);
  assert.equal(getUser(db, "new")!.engine, "codex-cli");
  assert.equal(getUser(db, "new")!.language, "zh-TW", "validation failure writes nothing");
});

// --- engineFor matrix ---

test("engineFor: engine field x (owner | whitelisted | other); no fallback", () => {
  const u = (engine: User["engine"], isOwner: boolean, username = "u") => ({ isOwner, skillPath, username, engine });
  const codex = { codexBin: "codex", dataDir: tmp() };
  for (const engine of ["claude-cli", "codex-cli"] as const) {
    assert.ok(engineFor(u(engine, true), "claude", [], codex), `owner ${engine}`);
    assert.ok(engineFor(u(engine, false, "Bob"), "claude", ["bob"], codex), `whitelisted ${engine}`);
    assert.equal(engineFor(u(engine, false, "eve"), "claude", ["bob"], codex), undefined, `other ${engine}`);
    assert.equal(engineFor(u(engine, false, "eve"), "claude", [], codex), undefined);
  }
  assert.throws(() => engineFor(u("gpt" as User["engine"], true), "claude", [], codex), /unknown engine/);
});

test("engineFor: the field picks the class (claude-cli vs codex-cli)", async () => {
  const codex = { codexBin: "/nonexistent/codex", dataDir: tmp() };
  const input: ReviewInput = { cwd: tmp(), mrTitle: "", mrDescription: "", diff: "", incremental: false, language: "en" };
  // Each engine fails on its own missing binary; the message names which binary was spawned.
  await assert.rejects(engineFor({ isOwner: true, skillPath, username: "o", engine: "codex-cli" }, "/nonexistent/claude", [], codex)!.review(input), /codex/);
  await assert.rejects(engineFor({ isOwner: true, skillPath, username: "o", engine: "claude-cli" }, "/nonexistent/claude", [], codex)!.review(input), /claude/);
  assert.ok(new ClaudeCliEngine({ claudeBin: "x", skillPath }));
});

// --- admin page ---

function webSetup() {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({ DATA_DIR: tmp(), GITLAB_URL: "https://gl.test", CLAUDE_BIN: "/nonexistent/claude" }), dryRun: true };
  const oauth = { gitlabUrl: "https://gl.test", redirectUri: "http://localhost:3000/auth/callback", clientId: "c", clientSecret: "s" };
  const app = createApp({ cfg, db, key, oauth });
  for (const [id, name, owner] of [[1, "owner", true], [2, "bob", false]] as const) addUser(db, key, { gitlabUserId: id, username: name, token: "t", tokenExpiresAt: null, skillPath, isOwner: owner });
  const login = (id: number) => {
    const s = createSession(db, id);
    return { cookie: `sid=${s.id}`, csrf: s.csrf };
  };
  const post = (path: string, s: { cookie: string; csrf: string }, fields: Record<string, string>, csrf: string | null = s.csrf) =>
    app.request(path, { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ ...(csrf === null ? {} : { _csrf: csrf }), ...fields }) });
  return { app, db, login, post };
}

test("admin engine select: rendered per user, owner-only, CSRF-protected, validated, persisted", async () => {
  const { app, db, login, post } = webSetup();
  const owner = login(1);
  const bob = login(2);
  const html = await (await app.request("/admin", { headers: { cookie: owner.cookie } })).text();
  assert.equal((html.match(/<select name="engine"/g) ?? []).length, 2);
  assert.match(html, /action="\/admin\/users\/2\/engine"/);
  assert.match(html, /<option value="claude-cli" selected/);
  assert.match(html, /<option value="codex-cli">/);

  assert.equal((await post("/admin/users/2/engine", bob, { engine: "codex-cli" })).status, 403); // non-owner
  assert.equal((await post("/admin/users/2/engine", owner, { engine: "codex-cli" }, null)).status, 403); // no CSRF
  assert.equal((await post("/admin/users/2/engine", owner, { engine: "codex-cli" }, "wrong")).status, 403);
  assert.equal(getUser(db, "bob")!.engine, "claude-cli");
  assert.equal((await post("/admin/users/2/engine", owner, { engine: "gpt" })).status, 400);
  assert.equal((await post("/admin/users/999/engine", owner, { engine: "codex-cli" })).status, 404);
  assert.equal(getUser(db, "bob")!.engine, "claude-cli");

  assert.equal((await post("/admin/users/2/engine", owner, { engine: "codex-cli" })).status, 302);
  assert.equal(getUser(db, "bob")!.engine, "codex-cli");
  assert.equal((await post("/admin/users/1/engine", owner, { engine: "codex-cli" })).status, 302); // owner's own engine is settable
  assert.equal(getUser(db, "owner")!.engine, "codex-cli");
  assert.match(await (await app.request("/admin", { headers: { cookie: owner.cookie } })).text(), /<option value="codex-cli" selected/);
});

test("settings form cannot change the engine (owner-only)", async () => {
  const { db, login, post } = webSetup();
  await post("/settings", login(2), { severity_threshold: "minor", confidence_threshold: "0.7", language: "en", engine: "codex-cli" });
  assert.equal(getUser(db, "bob")!.engine, "claude-cli");
});

// --- CodexEngine ---

const GOOD = JSON.stringify({
  verdict: "request_changes", summary: "s", focus: ["f"], checked: ["c"], resolved: [],
  findings: [{ severity: "major", file: "a.ts", line: null, title: "t", body: "b", confidence: 0.9 }, { severity: "nit", file: "b.ts", line: 3, title: "t2", body: "b2", confidence: 0.8 }],
});

/** Fake `codex`: dumps argv/env/stdin/cwd/CODEX_HOME listing, optionally "refreshes" auth.json, writes the -o file. */
function fakeCodex(dir: string, o: { out?: string; exit?: number; refresh?: boolean } = {}) {
  const bin = join(dir, "fake-codex");
  const out = o.out ?? GOOD;
  writeFileSync(join(dir, "payload"), out);
  writeFileSync(
    bin,
    `#!/bin/sh
D="${dir}"
{ for a in "$@"; do printf 'ARG:%s\\n' "$a"; done; } > "$D/args"
env > "$D/env"
pwd > "$D/cwd"
cat > "$D/stdin"
ls -A "$CODEX_HOME" > "$D/home.ls"
[ -e "$CODEX_HOME/auth.json" ] && cp "$CODEX_HOME/auth.json" "$D/auth.in"
for f in "$CODEX_HOME"/config.toml "$HOME"/.codex/config.toml; do [ -e "$f" ] && echo "$f" >> "$D/leak"; done
${o.refresh ? `echo '{"tokens":"refreshed"}' > "$CODEX_HOME/auth.json"` : ""}
OUT=""; while [ $# -gt 0 ]; do [ "$1" = "--output-last-message" ] && OUT="$2"; shift; done
[ -n "$OUT" ] && cp "$D/payload" "$OUT"
exit ${o.exit ?? 0}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function codexRig(o: Parameters<typeof fakeCodex>[1] = {}) {
  const dir = tmp();
  const realHome = join(dir, "real-codex"); // stands in for the owner's ~/.codex
  mkdirSync(realHome);
  writeFileSync(join(realHome, "auth.json"), '{"tokens":"original"}');
  writeFileSync(join(realHome, "config.toml"), '[mcp_servers.gitlab]\ncommand = "x"\n[mcp_servers.jira]\ncommand = "y"\n');
  const dataDir = join(dir, "data");
  const run = join(dir, "run");
  mkdirSync(run);
  const eng = new CodexEngine({ codexBin: fakeCodex(run, o), skillPath, dataDir, authSource: join(realHome, "auth.json") });
  const cwd = join(dir, "clone");
  mkdirSync(cwd);
  const input: ReviewInput = { cwd, mrTitle: "MR-TITLE", mrDescription: "d", diff: "+x", incremental: false, language: "zh-TW" };
  const rd = (n: string) => readFileSync(join(run, n), "utf8");
  return { eng, input, run, realHome, dataDir, cwd, rd };
}

test("CodexEngine: read-only sandbox, no MCP / user config, isolated CODEX_HOME with only auth.json", async () => {
  const prev = { g: process.env.GITLAB_TOKEN, j: process.env.JIRA_API_TOKEN, o: process.env.OPENAI_API_KEY, c: process.env.CODEX_API_KEY };
  Object.assign(process.env, { GITLAB_TOKEN: "glpat-SECRET", JIRA_API_TOKEN: "jira-SECRET", OPENAI_API_KEY: "sk-SECRET", CODEX_API_KEY: "ck-SECRET" });
  try {
    const r = codexRig();
    const res = await r.eng.review(r.input);
    const args = r.rd("args").split("\n").filter(Boolean).map((l) => l.slice(4));
    const pair = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(args[0], "exec");
    assert.equal(pair("--sandbox"), "read-only");
    for (const f of ["--ephemeral", "--ignore-user-config", "--ignore-rules"]) assert.ok(args.includes(f), f);
    assert.ok(!args.some((a) => /danger|bypass|workspace-write|full-access/.test(a)), "no sandbox escape flags");
    assert.ok(args.includes("mcp_servers={}"), "explicit MCP wipe");
    const disabled = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []));
    for (const f of ["apps", "plugins", "browser_use", "computer_use"]) assert.ok(disabled.includes(f), `--disable ${f}`);
    assert.ok(args.includes('web_search="disabled"'));
    assert.equal(pair("--cd"), r.cwd);
    assert.equal(args.at(-1), "-", "prompt goes via stdin, not argv");
    assert.ok(!args.join(" ").includes("MR-TITLE"));
    assert.equal(realpathSync(r.rd("cwd").trim()), realpathSync(r.cwd)); // spawned in the clone (compare realpaths: /var vs /private/var on macOS)

    // isolation: CODEX_HOME is a dedicated dir under dataDir holding ONLY auth.json; no config.toml, no MCP definitions reachable
    const env = Object.fromEntries(r.rd("env").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(env.CODEX_HOME, join(r.dataDir, "codex-home"));
    assert.notEqual(env.CODEX_HOME, r.realHome);
    assert.equal(env.HOME, env.CODEX_HOME);
    assert.deepEqual(r.rd("home.ls").trim().split("\n"), ["auth.json"]);
    assert.ok(!existsSync(join(r.dataDir, "codex-home", "config.toml")));
    assert.equal(existsSync(join(r.run, "leak")), false, "no config.toml visible via CODEX_HOME or HOME");
    assert.equal(readFileSync(join(env.CODEX_HOME!, "auth.json"), "utf8"), '{"tokens":"original"}');

    // env allowlist: no tokens of any kind
    const dump = r.rd("env") + r.rd("args") + r.rd("stdin");
    for (const s of ["glpat-SECRET", "jira-SECRET", "sk-SECRET", "ck-SECRET"]) assert.ok(!dump.includes(s), s);
    for (const k of Object.keys(env)) assert.ok(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "CODEX_HOME", "PWD", "SHLVL", "_", "LC_CTYPE", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(k), `unexpected env ${k}`);

    // same prompt as the claude engine: skill + contract + language + MR data
    const stdin = r.rd("stdin");
    for (const s of ["SKILL-CRITERIA", OUTPUT_CONTRACT, 'BCP-47 tag "zh-TW"', "MR-TITLE", "+x"]) assert.ok(stdin.includes(s), s);

    // output parsing reuse: nullable line -> absent; other findings intact
    assert.equal(res.verdict, "request_changes");
    assert.equal(res.findings.length, 2);
    assert.equal(res.findings[0]!.line, undefined);
    assert.equal(res.findings[1]!.line, 3);
    assert.deepEqual(res.focus, ["f"]);
  } finally {
    for (const [k, v] of [["GITLAB_TOKEN", prev.g], ["JIRA_API_TOKEN", prev.j], ["OPENAI_API_KEY", prev.o], ["CODEX_API_KEY", prev.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("CodexEngine: a token refreshed inside the isolated home is synced back; real login untouched otherwise", async () => {
  const r = codexRig({ refresh: true });
  utimesSync(join(r.realHome, "auth.json"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  await r.eng.review(r.input);
  assert.equal(readFileSync(join(r.realHome, "auth.json"), "utf8").trim(), '{"tokens":"refreshed"}');
  assert.ok(readFileSync(join(r.realHome, "config.toml"), "utf8").includes("mcp_servers"), "config.toml never touched");
  assert.deepEqual(readdirSync(r.realHome).sort(), ["auth.json", "config.toml"]);
  // a newer real login (user re-ran `codex login`) wins over the stale local copy on the next run
  writeFileSync(join(r.realHome, "auth.json"), '{"tokens":"relogin"}');
  utimesSync(join(r.realHome, "auth.json"), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const r2 = new CodexEngine({ codexBin: join(r.run, "fake-codex"), skillPath, dataDir: r.dataDir, authSource: join(r.realHome, "auth.json") });
  writeFileSync(join(r.run, "payload"), GOOD);
  await r2.review(r.input);
  // "in": codex was handed the newer real login, not the stale local copy
  assert.equal(readFileSync(join(r.run, "auth.in"), "utf8").trim(), '{"tokens":"relogin"}');
  // "out": the fake then rewrote the local copy, but the real file is newer (future mtime), so it must NOT be clobbered
  assert.equal(readFileSync(join(r.realHome, "auth.json"), "utf8").trim(), '{"tokens":"relogin"}');
});

test("CodexEngine: failures surface (non-zero exit, no final message, garbage, timeout)", async () => {
  await assert.rejects(codexRig({ exit: 3 }).eng.review(codexRig().input), /codex exited 3|fake-codex exited 3/);
  const bad = codexRig({ out: "not json at all" });
  await assert.rejects(bad.eng.review(bad.input), /invalid findings output/);
  const none = codexRig({ out: "" });
  await assert.rejects(none.eng.review(none.input), /no final message/);
  const slow = codexRig();
  writeFileSync(join(slow.run, "fake-codex"), "#!/bin/sh\nsleep 5\n");
  const t = new CodexEngine({ codexBin: join(slow.run, "fake-codex"), skillPath, dataDir: slow.dataDir, authSource: join(slow.realHome, "auth.json"), timeoutMs: 100 });
  await assert.rejects(t.review(slow.input), /timed out/);
});
