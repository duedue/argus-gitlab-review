// Per-user diff limit (0.2.1): validator, reviewMr uses the user's limit, review time limit scales with the diff.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { ClaudeCliEngine, DEFAULT_REVIEW_TIMEOUT_MS, reviewTimeoutMs, type ReviewInput } from "../src/engine.ts";
import type { GitLab, Mr } from "../src/gitlab.ts";
import { reviewMr, tooLargeNote, type UserRuntime } from "../src/review.ts";
import { addUser, getUser, setUser } from "../src/users.ts";

test("max_diff_lines: default NULL, 500-8000 integers accepted, empty resets, junk rejected without writing", () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "dl-"));
  writeFileSync(join(dir, "SKILL.md"), "x");
  addUser(db, randomBytes(32), { gitlabUserId: 1, username: "u", token: "t", tokenExpiresAt: null, skillPath: join(dir, "SKILL.md"), isOwner: true });
  assert.equal(getUser(db, "u")!.maxDiffLines, null);
  for (const n of [500, 2000, 8000]) {
    setUser(db, "u", [`max_diff_lines=${n}`]);
    assert.equal(getUser(db, "u")!.maxDiffLines, n);
  }
  for (const bad of ["499", "8001", "0", "-1", "1500.5", "abc", "1e3x"]) {
    assert.throws(() => setUser(db, "u", ["language=en", `max_diff_lines=${bad}`]), /max_diff_lines 必須是 500 到 8000/, bad);
  }
  assert.equal(getUser(db, "u")!.maxDiffLines, 8000);
  assert.equal(getUser(db, "u")!.language, "zh-TW", "a rejected batch writes nothing");
  setUser(db, "u", ["max_diff_lines="]);
  assert.equal(getUser(db, "u")!.maxDiffLines, null);
});

test("reviewTimeoutMs: default up to 2000 lines, proportional above, capped at 15 minutes", () => {
  assert.equal(reviewTimeoutMs(0), DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(reviewTimeoutMs(2000), DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(reviewTimeoutMs(2500), 750_000);
  assert.equal(reviewTimeoutMs(3000), 900_000);
  assert.equal(reviewTimeoutMs(8000), 900_000);
});

function harness(maxDiffLines: number | null, lines: number, cfgLimit = 2000) {
  const key = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), "dl-rv-"));
  writeFileSync(join(dir, "SKILL.md"), "x");
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "owner", token: "t", tokenExpiresAt: null, skillPath: join(dir, "SKILL.md"), isOwner: true });
  if (maxDiffLines !== null) setUser(db, "owner", [`max_diff_lines=${maxDiffLines}`]);
  const mr: Mr = { id: 700, iid: 7, project_id: 9, title: "t", description: "", sha: "h1", web_url: "u", target_branch: "main", state: "opened", reviewers: [], diff_refs: { base_sha: "b1", start_sha: "b1", head_sha: "h1" } };
  const notes: string[] = [];
  const gl = {
    getMr: async () => mr, getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [], postDiscussion: async () => {},
    postNote: async (_p: number, _i: number, body: string) => void notes.push(body),
  } as unknown as GitLab;
  const inputs: ReviewInput[] = [];
  const rt: UserRuntime = {
    token: async () => "t", gl,
    engine: { review: async (i) => (inputs.push(i), { findings: [], resolved: [] }) },
    prepare: async () => ({ dir: "/x", diff: "+x\n", lines, files: ["a.ts"], incremental: false }),
  };
  const run = async () => {
    const l = console.log;
    console.log = () => {};
    try { await reviewMr({ ...loadConfig({ DATA_DIR: dir }), maxDiffLines: cfgLimit, dryRun: false }, db, getUser(db, "owner")!, rt, mr); } finally { console.log = l; }
    return (db.prepare(`SELECT status FROM reviews`).get() as { status: string }).status;
  };
  return { run, notes, inputs };
}

test("reviewMr uses the user's limit, not the global one", async () => {
  const over = harness(3000, 2500); // above the global 2000, within the user's 3000
  assert.equal(await over.run(), "done");
  assert.equal(over.inputs.length, 1);
  const under = harness(500, 600); // within the global 2000, above the user's 500
  assert.equal(await under.run(), "skipped");
  assert.equal(under.inputs.length, 0);
  assert.match(under.notes.join("\n"), /超過審查者的上限 500 行/);
});

test("reviewMr without a personal limit falls back to the global default", async () => {
  const h = harness(null, 2500, 2000);
  assert.equal(await h.run(), "skipped");
  assert.match(h.notes.join("\n"), /上限 2000 行/);
});

test("reviewMr passes the diff-scaled time limit to the engine", async () => {
  const small = harness(null, 1500);
  await small.run();
  assert.equal(small.inputs[0]!.timeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
  const big = harness(8000, 2500);
  await big.run();
  assert.equal(big.inputs[0]!.timeoutMs, 750_000);
});

test("ClaudeCliEngine: input.timeoutMs governs the spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dl-eng-"));
  const bin = join(dir, "slow-claude");
  writeFileSync(bin, "#!/bin/sh\nsleep 2\n");
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "SKILL.md"), "x");
  const eng = new ClaudeCliEngine({ claudeBin: bin, skillPath: join(dir, "SKILL.md"), timeoutMs: 10_000 });
  const input: ReviewInput = { cwd: dir, mrTitle: "t", mrDescription: "", diff: "+x\n", incremental: false, language: "en", timeoutMs: 100 };
  await assert.rejects(eng.review(input), /timed out after 100ms/);
});

test("tooLargeNote states the reviewer's actual limit", () => {
  const n = tooLargeNote(4623, 3500, "http://argus.test");
  assert.match(n, /4623 行/);
  assert.match(n, /超過審查者的上限 3500 行/);
});
