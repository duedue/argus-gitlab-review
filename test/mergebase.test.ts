import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { ReviewEngine } from "../src/engine.ts";
import type { GitLab, Mr } from "../src/gitlab.ts";
import { prepareDiff } from "../src/repo.ts";
import { reviewMr, type UserRuntime } from "../src/review.ts";
import { addUser, getUser } from "../src/users.ts";

/** main: M0 -> M1 (target moves on); MR branch from M0: F (own change), then merge of M1. */
function repo() {
  const src = mkdtempSync(join(tmpdir(), "mergebase-src-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
  const put = (f: string, n: number) => writeFileSync(join(src, f), Array.from({ length: n }, (_, i) => `l${i}`).join("\n") + "\n");
  g("init", "-q", "-b", "main");
  g("config", "uploadpack.allowAnySHA1InWant", "true");
  put("m.txt", 1);
  g("add", "."); g("commit", "-qm", "M0");
  const m0 = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "mr");
  put("f.txt", 5);
  g("add", "."); g("commit", "-qm", "F");
  const reviewed = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  put("big.txt", 100); // 100 lines arrive from the target only
  g("add", "."); g("commit", "-qm", "M1");
  const m1 = g("rev-parse", "HEAD");
  g("checkout", "-q", "mr");
  g("merge", "-q", "--no-edit", "main");
  const head = g("rev-parse", "HEAD");
  g("update-ref", "refs/merge-requests/1/head", head);
  return { url: `file://${src}`, m0, m1, reviewed, head };
}
const run = (r: ReturnType<typeof repo>, over: { lastReviewedBaseSha?: string; baseSha: string }) =>
  prepareDiff({ dataDir: mkdtempSync(join(tmpdir(), "mergebase-data-")), ownerId: 1, token: "t", repoUrl: r.url, projectId: 1, iid: 1, headSha: r.head, lastReviewedSha: r.reviewed, excludeGlobs: [], ...over });

test("prepareDiff: merge base moved -> full MR diff (only the MR's own lines)", async () => {
  const r = repo();
  const p = await run(r, { baseSha: r.m1, lastReviewedBaseSha: r.m0 }); // GitLab's new merge-base is M1
  assert.equal(p.incremental, false);
  assert.deepEqual(p.files, ["f.txt"]);
  assert.equal(p.lines, 5);
});

test("prepareDiff: merge base unchanged -> incremental", async () => {
  const r = repo();
  const p = await run(r, { baseSha: r.m0, lastReviewedBaseSha: r.m0 });
  assert.equal(p.incremental, true);
});

test("prepareDiff: no recorded base (old rows) -> incremental as before", async () => {
  const r = repo();
  const p = await run(r, { baseSha: r.m0 });
  assert.equal(p.incremental, true);
});

function harness(prepare: UserRuntime["prepare"]) {
  const key = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), "mergebase-rv-"));
  writeFileSync(join(dir, "SKILL.md"), "x");
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "owner", token: "t", tokenExpiresAt: null, skillPath: join(dir, "SKILL.md"), isOwner: true });
  const mk = (sha: string, base: string): Mr => ({ id: 700, iid: 7, project_id: 9, title: "t", description: "", sha, web_url: "u", target_branch: "main", state: "opened", reviewers: [], diff_refs: { base_sha: base, start_sha: base, head_sha: sha } });
  const gl = {
    getMr: async () => cur.mr,
    getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [], postNote: async () => {}, postDiscussion: async () => {},
  } as unknown as GitLab;
  const cur = { mr: mk("h1", "b1") };
  const engine: ReviewEngine = { review: async () => ({ findings: [], resolved: [] }) };
  const rt: UserRuntime = { token: async () => "t", gl, engine, prepare };
  const quiet = async (f: () => Promise<unknown>) => { const l = console.log; console.log = () => {}; try { await f(); } finally { console.log = l; } };
  const review = (sha: string, base: string) => { cur.mr = mk(sha, base); return quiet(() => reviewMr(loadConfig({ DATA_DIR: dir }), db, getUser(db, "owner")!, rt, cur.mr)); };
  return { db, review };
}

test("reviewMr: a legacy round (no recorded base) whose incremental diff is over the limit falls back to the whole MR diff", async () => {
  const calls: (string | undefined)[] = [];
  const h = harness(async (o) => {
    calls.push(o.lastReviewedSha);
    return o.lastReviewedSha
      ? { dir: "/x", diff: "+x\n", lines: 7283, files: ["a.ts"], incremental: true }
      : { dir: "/x", diff: "+x\n", lines: 404, files: ["a.ts"], incremental: false };
  });
  await h.review("h1", "b1");
  h.db.prepare(`UPDATE reviews SET base_sha=NULL`).run(); // as if reviewed before base_sha existed
  await h.review("h2", "b2");
  assert.deepEqual(calls, [undefined, "h1", undefined]);
  const last = h.db.prepare(`SELECT status, error FROM reviews ORDER BY id DESC`).get() as { status: string; error: string | null };
  assert.equal(last.status, "done");
});

test("reviewMr records diff_refs.base_sha and passes the previous one to prepareDiff", async () => {
  const key = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), "mergebase-rv-"));
  writeFileSync(join(dir, "SKILL.md"), "x");
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "owner", token: "t", tokenExpiresAt: null, skillPath: join(dir, "SKILL.md"), isOwner: true });
  const user = getUser(db, "owner")!;
  const cfg = loadConfig({ DATA_DIR: dir });
  const mk = (sha: string, base: string): Mr => ({ id: 700, iid: 7, project_id: 9, title: "t", description: "", sha, web_url: "u", target_branch: "main", state: "opened", reviewers: [], diff_refs: { base_sha: base, start_sha: base, head_sha: sha } });
  let cur = mk("h1", "b1");
  const seen: { lastReviewedSha?: string; lastReviewedBaseSha?: string; baseSha: string }[] = [];
  const gl = {
    getMr: async () => cur,
    getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [], postNote: async () => {}, postDiscussion: async () => {},
  } as unknown as GitLab;
  const engine: ReviewEngine = { review: async () => ({ findings: [], resolved: [] }) };
  const rt: UserRuntime = {
    token: async () => "t", gl, engine,
    prepare: async (o) => { seen.push({ lastReviewedSha: o.lastReviewedSha, lastReviewedBaseSha: o.lastReviewedBaseSha, baseSha: o.baseSha }); return { dir: "/x", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false }; },
  };
  const quiet = async (f: () => Promise<unknown>) => { const l = console.log; console.log = () => {}; try { await f(); } finally { console.log = l; } };
  await quiet(() => reviewMr(cfg, db, user, rt, cur));
  cur = mk("h2", "b2"); // author merged target: new head and new merge-base
  await quiet(() => reviewMr(cfg, db, user, rt, cur));
  assert.deepEqual(seen[0], { lastReviewedSha: undefined, lastReviewedBaseSha: undefined, baseSha: "b1" });
  assert.deepEqual(seen[1], { lastReviewedSha: "h1", lastReviewedBaseSha: "b1", baseSha: "b2" });
  const rows = db.prepare(`SELECT head_sha, base_sha FROM reviews ORDER BY id`).all();
  assert.deepEqual(rows, [{ head_sha: "h1", base_sha: "b1" }, { head_sha: "h2", base_sha: "b2" }]);
});

test("reviewMr: no fallback when the base is recorded, or when a legacy incremental diff is within the limit", async () => {
  for (const [nullBase, lines, expectStatus] of [[false, 7283, "skipped"], [true, 50, "done"]] as const) {
    const calls: (string | undefined)[] = [];
    const h = harness(async (o) => {
      calls.push(o.lastReviewedSha);
      return { dir: "/x", diff: "+x\n", lines: o.lastReviewedSha ? lines : 10, files: ["a.ts"], incremental: !!o.lastReviewedSha };
    });
    await h.review("h1", "b1");
    if (nullBase) h.db.prepare(`UPDATE reviews SET base_sha=NULL`).run();
    await h.review("h2", "b1"); // same base: a plain incremental round
    assert.deepEqual(calls, [undefined, "h1"], `nullBase=${nullBase}: prepared once`);
    const last = h.db.prepare(`SELECT status FROM reviews ORDER BY id DESC`).get() as { status: string };
    assert.equal(last.status, expectStatus);
  }
});
