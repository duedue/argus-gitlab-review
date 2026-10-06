import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { claimReview, finishReview, lastReviewedSha, openDb, releaseStaleRunning } from "../src/db.ts";
import { isDraft } from "../src/gitlab.ts";

const base = { ownerId: 1, projectId: 10, mrId: 100, mrIid: 5 };

test("dedupe by (mr_id, head_sha)", () => {
  const db = openDb(":memory:");
  assert.equal(claimReview(db, { ...base, headSha: "aaa", dryRun: false }), true);
  assert.equal(claimReview(db, { ...base, headSha: "aaa", dryRun: false }), false);
  assert.equal(claimReview(db, { ...base, headSha: "bbb", dryRun: false }), true);
});

test("failed attempts are also deduped (until their retry is due); stale running rows are released on startup", () => {
  const db = openDb(":memory:");
  claimReview(db, { ...base, headSha: "aaa", dryRun: false });
  finishReview(db, 1, 100, "aaa", false, "failed", { error: "x" });
  assert.equal(claimReview(db, { ...base, headSha: "aaa", dryRun: false }), false);
  claimReview(db, { ...base, headSha: "ccc", dryRun: false });
  const w = console.warn;
  console.warn = () => {};
  try { assert.equal(releaseStaleRunning(db), 1); } finally { console.warn = w; }
  assert.equal(claimReview(db, { ...base, headSha: "ccc", dryRun: false }), true);
});

test("dry-run rows do not block a live run nor count as last reviewed", () => {
  const db = openDb(":memory:");
  claimReview(db, { ...base, headSha: "aaa", dryRun: true });
  finishReview(db, 1, 100, "aaa", true, "done");
  assert.equal(claimReview(db, { ...base, headSha: "aaa", dryRun: false }), true);
  assert.equal(lastReviewedSha(db, 1, 100, false), undefined);
  assert.equal(lastReviewedSha(db, 1, 100, true), "aaa");
});

test("incremental base = latest done head_sha only", () => {
  const db = openDb(":memory:");
  for (const [sha, st] of [["a", "done"], ["b", "failed"]] as const) {
    claimReview(db, { ...base, headSha: sha, dryRun: false });
    finishReview(db, 1, 100, sha, false, st);
  }
  assert.equal(lastReviewedSha(db, 1, 100, false), "a");
});

test("dedupe is per owner: two reviewers of the same MR+sha do not block each other", () => {
  const db = openDb(":memory:");
  assert.equal(claimReview(db, { ...base, headSha: "aaa", dryRun: false }), true);
  assert.equal(claimReview(db, { ...base, ownerId: 2, headSha: "aaa", dryRun: false }), true);
  finishReview(db, 1, 100, "aaa", false, "done");
  assert.equal(lastReviewedSha(db, 2, 100, false), undefined);
});

test("legacy reviews table (unique without owner_id) is migrated, rows kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "ms-"));
  const path = join(dir, "t.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE reviews (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, project_id INTEGER NOT NULL, mr_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL, head_sha TEXT NOT NULL, dry_run INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, findings_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (mr_id, head_sha, dry_run));
    INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status) VALUES (1, 10, 100, 5, 'aaa', 0, 'done');`);
  old.close();
  const db = openDb(path);
  assert.equal(claimReview(db, { ...base, ownerId: 2, headSha: "aaa", dryRun: false }), true);
  assert.equal(claimReview(db, { ...base, headSha: "aaa", dryRun: false }), false);
  rmSync(dir, { recursive: true });
});

test("draft detection", () => {
  assert.equal(isDraft({ title: "Draft: x" }), true);
  assert.equal(isDraft({ title: "[WIP] x" }), true);
  assert.equal(isDraft({ title: "WIP: x" }), true);
  assert.equal(isDraft({ title: "fix", draft: true }), true);
  assert.equal(isDraft({ title: "Drafting docs" }), false);
});
