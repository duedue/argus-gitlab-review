import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLines, prepareDiff } from "../src/repo.ts";

test("changedLines counts only +/- lines inside hunks", () => {
  const diff = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " ctx", "-old", "+new", "+more", " ctx", ""].join("\n");
  assert.equal(changedLines(diff), 3);
  assert.equal(changedLines("diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n"), 0);
  // hunk content that looks like a file header (removed SQL comment, added `++ x`) is still counted
  const tricky = ["diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,2 @@", "--- old comment", "+++ x", " ctx", ""].join("\n");
  assert.equal(changedLines(tricky), 2);
});

/** Source repo with an MR ref: commit A adds files, commit B renames them (one with an edit). */
function sourceRepo(): { url: string; base: string; head: string } {
  const src = mkdtempSync(join(tmpdir(), "diffsize-src-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "uploadpack.allowAnySHA1InWant", "true");
  const body = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";
  writeFileSync(join(src, "a.txt"), body);
  mkdirSync(join(src, "vendor"));
  writeFileSync(join(src, "vendor", "lib.txt"), body);
  g("add", ".");
  g("commit", "-qm", "A");
  const base = g("rev-parse", "HEAD");
  g("mv", "a.txt", "b.txt");
  writeFileSync(join(src, "b.txt"), body + "added\n");
  mkdirSync(join(src, "src"));
  g("mv", "vendor/lib.txt", "src/lib.txt");
  g("add", ".");
  g("commit", "-qm", "B");
  const head = g("rev-parse", "HEAD");
  g("update-ref", "refs/merge-requests/1/head", head);
  return { url: `file://${src}`, base, head };
}

test("prepareDiff: a rename counts only its edits; a rename out of an excluded path counts as a whole add", async () => {
  const r = sourceRepo();
  const prep = await prepareDiff({
    dataDir: mkdtempSync(join(tmpdir(), "diffsize-data-")), ownerId: 1, token: "t", repoUrl: r.url, projectId: 1, iid: 1,
    baseSha: r.base, headSha: r.head, excludeGlobs: ["**/vendor/**"],
  });
  assert.deepEqual(prep.files.sort(), ["b.txt", "src/lib.txt"]);
  assert.match(prep.diff, /rename from a\.txt/);
  // b.txt: +1 (rename with one added line); src/lib.txt: source is excluded, so it is a 300-line add
  assert.equal(prep.lines, 301);
});
