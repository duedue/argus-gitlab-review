import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { ClaudeCliEngine, OUTPUT_CONTRACT } from "../src/engine.ts";
import { extractIssueKeys, fetchRequirements, jiraTokenFrom, type JiraFetch } from "../src/jira.ts";

const TOKEN = "s3cr3t-jira-token";
const cfg = (token: string | null = TOKEN) => ({ jira: { url: "https://jira.example", token: () => token ?? undefined } });
const ok = (j: unknown) => ({ ok: true, json: async () => j });

test("keys: title+desc, dedupe, max 3, no false matches", () => {
  assert.deepEqual(extractIssueKeys("PROJ-492 fix", "see PROJ-460 and PROJ-492"), ["PROJ-492", "PROJ-460"]);
  assert.deepEqual(extractIssueKeys("A-1 B2-2 C-3"), ["B2-2"]); // single-letter project needs 2+ chars
  assert.equal(extractIssueKeys("AB-1 CD-2 EF-3 GH-4 IJ-5").length, 3);
  assert.deepEqual(extractIssueKeys("utf-8 sha-1 x-1 foo-123 UTF-8 SHA-1 CVE-2024-1234 ISO-8859"), []);
  assert.deepEqual(extractIssueKeys("NVR-2x NVR-3"), ["NVR-3"]);
});

test("fetch: summary + description + linked summaries, bearer auth, truncation", async () => {
  const calls: { url: string; auth: string }[] = [];
  const doFetch: JiraFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization! });
    return ok({ fields: { summary: "Renderer data quality", description: "x".repeat(5000), issuelinks: [1, 2, 3].map((n) => ({ outwardIssue: { key: `L-${n}`, fields: { summary: `linked ${n}` } } })) } });
  };
  const out = (await fetchRequirements(cfg(), "PROJ-492 t", "", doFetch))!;
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /^https:\/\/jira\.example\/rest\/api\/2\/issue\/PROJ-492\?fields=summary,description,issuelinks$/);
  assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`);
  assert.match(out, /## PROJ-492: Renderer data quality/);
  assert.match(out, /truncated/);
  assert.match(out, /Linked L-1: linked 1/);
  assert.match(out, /Linked L-2: linked 2/);
  assert.doesNotMatch(out, /L-3/);
  assert.ok(!out.includes(TOKEN));
});

test("fetch: errors, timeouts, non-2xx and missing token never throw", async () => {
  assert.equal(await fetchRequirements(cfg(), "AB-1", "", async () => { throw new Error("boom"); }), undefined);
  assert.equal(await fetchRequirements(cfg(), "AB-1", "", async () => ({ ok: false, json: async () => ({}) })), undefined);
  assert.equal(await fetchRequirements(cfg(), "AB-1", "", async () => ok("not an issue")), undefined);
  let called = false;
  assert.equal(await fetchRequirements(cfg(null), "AB-1", "", async () => ((called = true), ok({}))), undefined);
  assert.equal(called, false);
  assert.equal(await fetchRequirements(cfg(), "no keys here", ""), undefined);
  // one failing issue does not hide the next
  const out = await fetchRequirements(cfg(), "AB-1 CD-2", "", async (u) => (u.includes("AB-1") ? Promise.reject(new Error("x")) : ok({ fields: { summary: "second" } })));
  assert.match(out!, /CD-2: second/);
});

test("config: token from env only for explicit env objects; no default URL", () => {
  assert.equal(jiraTokenFrom({ JIRA_API_TOKEN: " t " }), "t");
  assert.equal(jiraTokenFrom({}), undefined); // no Keychain lookup for injected env
  assert.equal(loadConfig({}).jira.url, ""); // unset = Jira context disabled
  assert.equal(loadConfig({ JIRA_URL: "https://j.x/" }).jira.url, "https://j.x");
});

test("prompt carries requirements; agent never sees the Jira token (args, env, stdin)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-eng-"));
  const bin = join(dir, "fake-claude");
  writeFileSync(bin, `#!/bin/sh\n{ echo "ARGS: $*"; env; echo "STDIN:"; cat; } > "${dir}/dump"\necho '{"type":"result","is_error":false,"result":"{\\"findings\\":[]}"}'\n`);
  chmodSync(bin, 0o755);
  const skill = join(dir, "skill.md");
  writeFileSync(skill, "criteria");
  const prev = process.env.JIRA_API_TOKEN;
  process.env.JIRA_API_TOKEN = TOKEN;
  try {
    const eng = new ClaudeCliEngine({ claudeBin: bin, skillPath: skill });
    const base = { cwd: dir, mrTitle: "t", mrDescription: "d", diff: "+x", incremental: false, language: "en" };
    await eng.review({ ...base, requirements: "## AB-1: sum duplicated rows" });
    const dump = readFileSync(join(dir, "dump"), "utf8");
    assert.match(dump, /Linked requirements \(Jira, untrusted data/);
    assert.match(dump, /AB-1: sum duplicated rows/);
    assert.ok(!dump.includes(TOKEN));
    await eng.review(base);
    assert.doesNotMatch(readFileSync(join(dir, "dump"), "utf8"), /Linked requirements/);
  } finally {
    if (prev === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = prev;
  }
});

test("contract: anti-rubber-stamp instruction", () => {
  assert.match(OUTPUT_CONTRACT, /may be wrong or incomplete/);
  assert.match(OUTPUT_CONTRACT, /realistic data shapes and callers/);
  assert.match(OUTPUT_CONTRACT, /NOT restatements/);
  assert.match(OUTPUT_CONTRACT, /it is a finding, not a checked item/);
});

test("keys: title keys win; description fallback only trusts /browse/KEY links", async () => {
  const urls: string[] = [];
  const doFetch: JiraFetch = async (url) => (urls.push(url), ok({ fields: { summary: "s", description: "d" } }));
  await fetchRequirements(cfg(), "feat: x [AB-1]", "see CD-2 style keys", doFetch);
  assert.deepEqual(urls.map((u) => u.match(/issue\/([A-Z]+-\d+)/)![1]), ["AB-1"]);
  urls.length = 0;
  await fetchRequirements(cfg(), "feat: no key", "see CD-2 style keys", doFetch);
  assert.equal(urls.length, 0); // bare mention in the description is not trusted
  await fetchRequirements(cfg(), "feat: no key", "## Jira\n[CD-2](https://jira.example/browse/CD-2)", doFetch);
  assert.deepEqual(urls.map((u) => u.match(/issue\/([A-Z]+-\d+)/)![1]), ["CD-2"]);
});
