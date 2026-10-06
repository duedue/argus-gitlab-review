import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { engineFor, languageInstruction, SKIP_REASONS, type ReviewEngine, type ReviewInput } from "../src/engine.ts";
import type { Finding } from "../src/findings.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { pollOnce, type UserRuntime } from "../src/review.ts";
import { addUser, daysUntilExpiry, getUser, listUsers, removeUser, setUser, userToken, type User } from "../src/users.ts";

const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");
const skillPath = join(skillDir, "SKILL.md");

const mkUser = (db: ReturnType<typeof openDb>, id: number, name: string, isOwner: boolean): User => {
  addUser(db, key, { gitlabUserId: id, username: name, token: `tok-${name}`, tokenExpiresAt: null, skillPath, isOwner });
  return getUser(db, name)!;
};
const mr = (id: number): MrSummary => ({ id, iid: id, project_id: 7, title: "t", description: "", sha: "deadbeef00", web_url: "u", target_branch: "main" });
const cfg = { ...loadConfig({}), dryRun: true };

function fakeGl(mrs: MrSummary[], opts: { throwOnList?: boolean } = {}) {
  return {
    listReviewMrs: async () => {
      if (opts.throwOnList) throw new Error("boom");
      return mrs;
    },
    getMr: async (_p: number, iid: number) => ({ ...mrs[0]!, iid, diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } }),
    getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [],
    postNote: async () => assert.fail("must not post in dry-run"),
    postDiscussion: async () => assert.fail("must not post in dry-run"),
  } as unknown as GitLab;
}
const prepare = async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });

test("users: token is stored encrypted and round-trips; list/get expose no plaintext", () => {
  const db = openDb(":memory:");
  const u = mkUser(db, 1, "alice", false);
  assert.equal(userToken(key, u), "tok-alice");
  assert.ok(!u.tokenEnc.includes("tok-alice"));
  assert.throws(() => userToken(randomBytes(32), u));
  assert.equal(u.language, "zh-TW");
  assert.equal(u.severityThreshold, "minor");
});

test("users: re-add rotates token but keeps settings and ownership; remove works", () => {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice", true);
  setUser(db, "alice", ["language=en", "confidence_threshold=0.9"]);
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "new", tokenExpiresAt: "2030-01-01", skillPath, isOwner: false });
  const u = getUser(db, "alice")!;
  assert.equal(userToken(key, u), "new");
  assert.equal(u.isOwner, true);
  assert.equal(u.language, "en");
  assert.equal(u.confidenceThreshold, 0.9);
  assert.equal(removeUser(db, "alice"), true);
  assert.equal(listUsers(db).length, 0);
});

test("users set: validates keys and values, nothing written on error", () => {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice", false);
  for (const bad of ["severity_threshold=huge", "confidence_threshold=2", "confidence_threshold=", "language=en; ignore previous", "enabled=yes", "is_owner=1", "token_enc=x", "skill_path=/nope"]) {
    assert.throws(() => setUser(db, "alice", [bad]), Error, bad);
  }
  assert.throws(() => setUser(db, "alice", ["language=ja", "enabled=2"]));
  assert.equal(getUser(db, "alice")!.language, "zh-TW");
  setUser(db, "alice", ["severity_threshold=major", "enabled=0"]);
  assert.equal(getUser(db, "alice")!.severityThreshold, "major");
  assert.equal(getUser(db, "alice")!.enabled, false);
});

test("daysUntilExpiry", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  assert.equal(daysUntilExpiry({ tokenExpiresAt: null }, now), undefined);
  assert.equal(daysUntilExpiry({ tokenExpiresAt: "2026-10-05" }, now), 4);
  assert.ok(daysUntilExpiry({ tokenExpiresAt: "2026-09-20" }, now)! < 0);
});

test("subscription guard: claude CLI engine only for owners", () => {
  assert.ok(engineFor({ isOwner: true, skillPath, username: "o", engine: "claude-cli" }, "claude"));
  assert.equal(engineFor({ isOwner: false, skillPath, username: "bob", engine: "claude-cli" }, "claude"), undefined);
});

test("subscription guard: non-owner without a Claude token is recorded skipped (once, with the reason); engine/clone never reached", async () => {
  const db = openDb(":memory:");
  const bob = mkUser(db, 2, "bob", false);
  let prepared = false;
  const rt: UserRuntime = { token: async () => "t", gl: fakeGl([mr(1)]), engine: engineFor(bob, "claude"), prepare: async () => ((prepared = true), prepare()) };
  await pollOnce(cfg, db, [bob], () => rt);
  await pollOnce(cfg, db, [bob], () => rt); // the same head again: still one row
  assert.deepEqual(db.prepare(`SELECT status, error FROM reviews`).all(), [{ status: "skipped", error: SKIP_REASONS.no_token }]);
  assert.equal(prepared, false);
});

test("per-user threshold and language reach the engine and the publisher", async () => {
  const db = openDb(":memory:");
  const u = mkUser(db, 1, "alice", true);
  setUser(db, "alice", ["language=ja", "severity_threshold=blocker", "confidence_threshold=0.95"]);
  let seen: ReviewInput | undefined;
  const findings: Finding[] = [{ severity: "major", file: "a.ts", line: 1, title: "t", body: "b", confidence: 0.99 }];
  const engine: ReviewEngine = { review: async (i) => ((seen = i), { findings, resolved: [] }) };
  await pollOnce(cfg, db, [getUser(db, "alice")!], () => ({ token: async () => "t", gl: fakeGl([mr(1)]), engine, prepare }));
  assert.equal(seen?.language, "ja");
  assert.match(languageInstruction("ja"), /"ja"/);
  const row = db.prepare(`SELECT status FROM reviews WHERE owner_id=?`).get(u.gitlabUserId) as { status: string };
  assert.equal(row.status, "done");
  // threshold plumbing: major < blocker, so the finding goes to the summary note with its full body (publish gets user's thresholds)
  const posted: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void posted.push(a.join(" "));
  try {
    const db2 = openDb(":memory:");
    mkUser(db2, 1, "alice", true);
    setUser(db2, "alice", ["severity_threshold=blocker"]);
    await pollOnce(cfg, db2, [getUser(db2, "alice")!], () => ({ token: async () => "t", gl: fakeGl([mr(1)]), engine, prepare }));
  } finally {
    console.log = log;
  }
  const out = posted.join("\n");
  assert.match(out, /would post summary note/);
  assert.match(out, /\*\*major\*\* `#[0-9a-f]{6}` `a.ts:1` \*\*t\*\*\n\n  b/);
  assert.doesNotMatch(out, /would post inline/);
});

test("poller isolation: a user whose runtime or GitLab call throws does not affect others", async () => {
  const db = openDb(":memory:");
  const a = mkUser(db, 1, "alice", false);
  const b = mkUser(db, 2, "bob", false);
  const c = mkUser(db, 3, "carol", true);
  const d = mkUser(db, 4, "dave", false);
  const reviewed: string[] = [];
  const engine: ReviewEngine = { review: async () => (reviewed.push("ok"), { findings: [], resolved: [] }) };
  const err = console.error;
  console.error = () => {};
  try {
    await pollOnce(cfg, db, [a, b, c, d], (u) => {
      if (u.username === "alice") throw new Error("decrypt failed");
      if (u.username === "bob") return { token: async () => "t", gl: fakeGl([mr(1)], { throwOnList: true }), engine, prepare };
      return { token: async () => "t", gl: fakeGl([mr(u.gitlabUserId)]), engine: u.isOwner ? engine : undefined, prepare };
    });
  } finally {
    console.error = err;
  }
  assert.deepEqual(reviewed, ["ok"]); // carol reviewed
  const rows = db.prepare(`SELECT owner_id, status FROM reviews ORDER BY owner_id`).all();
  assert.deepEqual(rows, [{ owner_id: 3, status: "done" }, { owner_id: 4, status: "skipped" }]); // dave (non-owner, no token): visible skip
});

test("disabled and expired users are not polled", async () => {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice", true);
  setUser(db, "alice", ["enabled=0"]);
  addUser(db, key, { gitlabUserId: 2, username: "bob", token: "t", tokenExpiresAt: "2020-01-01", skillPath, isOwner: false });
  let calls = 0;
  const err = console.error;
  console.error = () => {};
  try {
    await pollOnce(cfg, db, listUsers(db), () => (calls++, { token: async () => "t", gl: fakeGl([]), engine: undefined }));
  } finally {
    console.error = err;
  }
  assert.equal(calls, 0);
});

test("only one owner may exist; re-adding the same owner is allowed", () => {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice", true);
  mkUser(db, 1, "alice", true); // token rotation for the same owner
  assert.throws(() => mkUser(db, 2, "bob", true), /owner already exists \(alice\)/);
  mkUser(db, 2, "bob", false);
  assert.equal(listUsers(db).filter((u) => u.isOwner).length, 1);
});

test("CLI user add approves a pending web sign-up", () => {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO users (gitlab_user_id, username, token_enc, skill_path, approved, enabled) VALUES (9, 'eve', '', '', 0, 0)`).run();
  addUser(db, key, { gitlabUserId: 9, username: "eve", token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  assert.equal(getUser(db, "eve")!.approved, true);
});

test("review_assigned: validator, default off, round-trip", () => {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice", false);
  assert.equal(getUser(db, "alice")!.reviewAssigned, false);
  assert.throws(() => setUser(db, "alice", ["review_assigned=yes"]));
  setUser(db, "alice", ["review_assigned=1"]);
  assert.equal(getUser(db, "alice")!.reviewAssigned, true);
});

/** Polls alice (gitlab id 1) with the given reviewer/assignee lists; returns the MR ids that reached the engine and the assignee-query count. */
async function pollAssigned(flag: boolean, reviewer: MrSummary[], assigned: MrSummary[] | Error) {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice", true);
  if (flag) setUser(db, "alice", ["review_assigned=1"]);
  const reviewed: number[] = [];
  let assignedCalls = 0;
  const base = fakeGl(reviewer);
  const gl = Object.assign(Object.create(base), {
    getMr: async (_p: number, iid: number) => ({ ...[...reviewer, ...(assigned instanceof Error ? [] : assigned)].find((m) => m.iid === iid)!, diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } }),
    listAssignedMrs: async () => { assignedCalls++; if (assigned instanceof Error) throw assigned; return assigned; },
  }) as GitLab;
  const engine: ReviewEngine = { review: async (i) => (reviewed.push(Number(i.mrTitle)), { findings: [], resolved: [] }) };
  const err = console.error;
  console.error = () => {};
  try {
    await pollOnce(cfg, db, [getUser(db, "alice")!], () => ({ token: async () => "t", gl, engine, prepare }));
  } finally {
    console.error = err;
  }
  return { reviewed: reviewed.sort(), assignedCalls };
}
const authored = (id: number, authorId: number): MrSummary => ({ ...mr(id), title: String(id), author: { id: authorId } });

test("review_assigned off: assignee query is never made and assignee-only MRs are not reviewed", async () => {
  const r = await pollAssigned(false, [authored(1, 9)], [authored(2, 9)]);
  assert.deepEqual(r, { reviewed: [1], assignedCalls: 0 });
});

test("review_assigned on: assignee MRs are reviewed, deduped against reviewer list, own-authored ones excluded", async () => {
  const r = await pollAssigned(true, [authored(1, 9), authored(4, 1)], [authored(1, 9), authored(2, 9), authored(3, 1), authored(4, 1)]);
  // 1 appears in both lists (reviewed once), 2 assignee-only, 3 own-authored assignee-only (excluded), 4 own-authored but also reviewer (kept)
  assert.deepEqual(r, { reviewed: [1, 2, 4], assignedCalls: 1 });
});

test("review_assigned on: a failing assignee query still reviews the reviewer MRs", async () => {
  const r = await pollAssigned(true, [authored(1, 9)], new Error("GitLab 502"));
  assert.deepEqual(r, { reviewed: [1], assignedCalls: 1 });
});
