import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { ReviewQueue } from "../src/queue.ts";
import { pollOnce } from "../src/review.ts";
import { addUser, setUser } from "../src/users.ts";

// Single pollOnce in this file: the orphan sweep is throttled per process (cleanupDue), so it runs on this first call.
test("orphan sweep deletes pushed_branches of users who opted out or no longer exist, keeps opted-in users'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p-"));
  writeFileSync(join(dir, "SKILL.md"), "x");
  const key = randomBytes(32);
  const db = openDb(":memory:");
  for (const id of [1, 2]) addUser(db, key, { gitlabUserId: id, username: `u${id}`, token: "t", tokenExpiresAt: null, skillPath: join(dir, "SKILL.md"), isOwner: false });
  setUser(db, "u1", ["review_pushed_branches=1"]);
  for (const owner of [1, 2, 3]) db.prepare(`INSERT INTO pushed_branches (owner_id, project_id, branch, head_sha, pushed_at) VALUES (?,9,'b','h',1)`).run(owner);
  const l = console.log; console.log = () => {};
  try { await pollOnce(loadConfig({ DATA_DIR: dir }), db, [], () => { throw new Error("none"); }, new ReviewQueue()); } finally { console.log = l; }
  assert.deepEqual((db.prepare(`SELECT owner_id FROM pushed_branches`).all() as { owner_id: number }[]).map((r) => r.owner_id), [1]);
});
