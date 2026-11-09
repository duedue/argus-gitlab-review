import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { listSeenMrs, openDb } from "../src/db.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { parseProjectList, projectAllowed } from "../src/projects.ts";
import { ReviewQueue } from "../src/queue.ts";
import { pollOnce } from "../src/review.ts";
import { triggerReviews } from "../src/trigger.ts";
import { addUser, bootstrapOwner, getUser, setUser, upsertOAuthUser } from "../src/users.ts";
import type { ReviewEngine } from "../src/engine.ts";

test("parseProjectList: normalizes, dedupes, accepts comma and newline, empty = []", () => {
  assert.deepEqual(parseProjectList(" /Grp/Sub/ \nGRP/sub, grp/other\r\n\n"), ["grp/sub", "grp/other"]);
  assert.deepEqual(parseProjectList("  \n,"), []);
});

test("parseProjectList: rejects bad paths and oversize lists with zh-TW messages", () => {
  for (const bad of ["a b", "a//b", "../x", "a/../b", "a/b?x", "https://x/y"]) assert.throws(() => parseProjectList(bad), /不合法/, bad);
  assert.throws(() => parseProjectList("a".repeat(256)), /255/);
  assert.throws(() => parseProjectList(Array.from({ length: 101 }, (_, i) => `g/p${i}`).join("\n")), /100/);
  assert.equal(parseProjectList(Array.from({ length: 100 }, (_, i) => `g/p${i}`).join("\n")).length, 100);
});

test("projectAllowed: strict empty list, allowAll, segment-boundary prefix, case-insensitive, fail closed", () => {
  assert.equal(projectAllowed("any/thing", [], false), false, "empty list reviews nothing");
  assert.equal(projectAllowed("any/thing", [], true), true);
  assert.equal(projectAllowed(undefined, [], true), true);
  assert.equal(projectAllowed("a/b", ["x/y"], true), true, "allowAll ignores the list");
  assert.equal(projectAllowed(undefined, ["a/b"], false), false);
  const l = ["a/b"];
  assert.equal(projectAllowed("a/b", l, false), true);
  assert.equal(projectAllowed("a/b/c/d", l, false), true);
  assert.equal(projectAllowed("A/B/C", l, false), true);
  assert.equal(projectAllowed("a/bc", l, false), false);
  assert.equal(projectAllowed("a", l, false), false);
  assert.equal(projectAllowed("x/a/b", l, false), false);
});

test("user set review_projects: stored normalized, empty clears, invalid rejected without writing", () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "s-"));
  writeFileSync(join(dir, "SKILL.md"), "x");
  addUser(db, randomBytes(32), { gitlabUserId: 1, username: "u", token: "t", tokenExpiresAt: null, skillPath: join(dir, "SKILL.md"), isOwner: false });
  assert.deepEqual(getUser(db, "u")!.reviewProjects, []);
  setUser(db, "u", ["review_projects=Grp/A, grp/b/"]);
  assert.deepEqual(getUser(db, "u")!.reviewProjects, ["grp/a", "grp/b"]);
  assert.throws(() => setUser(db, "u", ["language=en", "review_projects=bad path"]), /不合法/);
  assert.deepEqual(getUser(db, "u")!.reviewProjects, ["grp/a", "grp/b"]);
  setUser(db, "u", ["review_projects="]);
  assert.deepEqual(getUser(db, "u")!.reviewProjects, []);
});

const GL = "https://gl.test";
const key = randomBytes(32);
const dir = mkdtempSync(join(tmpdir(), "sk-"));
writeFileSync(join(dir, "SKILL.md"), "x");
const skillPath = join(dir, "SKILL.md");
const cfg = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "d-")), GITLAB_URL: GL }), dryRun: true };
const prepare = async () => ({ dir: "/x", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });
const mkUser = (db: ReturnType<typeof openDb>, id: number, name: string, list = "", allowAll = false) => {
  addUser(db, key, { gitlabUserId: id, username: name, token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  setUser(db, name, [`review_projects=${list}`, `review_all_projects=${allowAll ? 1 : 0}`]);
  return getUser(db, name)!;
};
const summary = (id: number, path: string): MrSummary => ({ id, iid: id, project_id: 7, title: String(id), description: "", sha: "deadbeef00", web_url: `${GL}/${path}/-/merge_requests/${id}`, target_branch: "main" });

test("poll: only allowlisted projects reach the engine, one summary log line, empty list reviews none, allowAll reviews all", async () => {
  const run = async (list: string, allowAll = false) => {
    const db = openDb(":memory:");
    const u = mkUser(db, 1, "alice", list, allowAll);
    const reviewed: number[] = [];
    const mrs = [summary(1, "grp/a/x"), summary(2, "grp/ab/y"), summary(3, "Other/z"), { ...summary(4, "grp/a/x"), web_url: "garbage" }];
    const gl = {
      listReviewMrs: async () => mrs,
      getMr: async (_p: number, iid: number) => ({ ...mrs.find((m) => m.iid === iid)!, state: "opened", diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } }),
      getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
      listDiscussions: async () => [],
      listNotes: async () => [],
    } as unknown as GitLab;
    const engine: ReviewEngine = { review: async (i) => (reviewed.push(Number(i.mrTitle)), { findings: [], resolved: [] }) };
    const logs: string[] = [];
    const log = console.log, err = console.error;
    console.log = (...a) => void logs.push(a.join(" "));
    console.error = () => {};
    try {
      await pollOnce(cfg, db, [u], () => ({ token: async () => "t", gl, engine, prepare }), new ReviewQueue());
    } finally {
      console.log = log;
      console.error = err;
    }
    return { reviewed: reviewed.sort(), logs, db };
  };
  const r = await run("grp/a");
  assert.deepEqual(r.reviewed, [1]);
  assert.equal(r.logs.filter((l) => l.includes("skipped (not in project list)")).length, 1);
  assert.ok(r.logs.some((l) => l.includes("3 skipped (not in project list)")));
  assert.deepEqual(listSeenMrs(r.db, 1).map((x) => x.path).sort(), ["grp/ab/y", "other/z"], "skipped MRs recorded (unparseable url is not)");
  assert.equal((r.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 1, "no reviews rows for skipped MRs");
  assert.deepEqual(listSeenMrs((await run("", true)).db, 1), [], "allowAll records nothing");
  assert.deepEqual((await run("")).reviewed, [], "strict: empty list reviews nothing");
  assert.deepEqual((await run("", true)).reviewed, [1, 2, 3, 4], "allowAll = no filtering");
});

test("trigger: non-self reviewer outside the list is skipped; self-review is not restricted", async () => {
  const db = openDb(":memory:");
  const caller = mkUser(db, 1, "caller", "other/only");
  const rev = mkUser(db, 2, "rev", "other/only");
  const ok = mkUser(db, 3, "ok", "grp");
  const mr = { id: 700, iid: 7, project_id: 9, title: "t", description: "", sha: "deadbeef00", web_url: `${GL}/grp/sub/proj/-/merge_requests/7`, target_branch: "main", state: "opened",
    reviewers: [{ id: 2, username: "rev" }, { id: 3, username: "ok" }], diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } };
  const ran: string[] = [];
  const runtimeFor = async (u: { username: string }) => ({
    token: async () => "t",
    gl: { getMr: async () => mr, getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }), listDiscussions: async () => [] } as unknown as GitLab,
    engine: { review: async () => (ran.push(u.username), { findings: [], resolved: [] }) } as ReviewEngine,
    prepare,
  });
  const queue = new ReviewQueue();
  const log = console.log;
  console.log = () => {};
  try {
    const ref = { path: "grp/sub/proj", iid: 7 };
    const r = await triggerReviews({ cfg, db, queue, runtimeFor }, caller, ref);
    assert.deepEqual(r.queued, ["ok"]);
    assert.deepEqual(r.skipped, [{ username: "rev", reason: "project not in user's review list" }]);
    const s = await triggerReviews({ cfg, db, queue, runtimeFor }, caller, ref, { self: true });
    assert.deepEqual(s.queued, ["caller"]);
  } finally {
    console.log = log;
  }
});

test("migration: existing users get review_all_projects=1 once, new sign-ups and later opens stay as they are", () => {
  const file = join(mkdtempSync(join(tmpdir(), "mig-")), "a.db");
  let db = openDb(file);
  addUser(db, key, { gitlabUserId: 1, username: "old", token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  upsertOAuthUser(db, key, { gitlabUserId: 3, username: "pending", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 }); // approved=0
  db.exec(`ALTER TABLE users DROP COLUMN review_all_projects`); // simulate a pre-feature database
  db.close();
  db = openDb(file);
  assert.equal(getUser(db, "old")!.reviewAllProjects, true, "existing active row migrated to 1");
  assert.equal(getUser(db, "pending")!.reviewAllProjects, false, "pending user starts strict like a new sign-up");
  const fresh = upsertOAuthUser(db, key, { gitlabUserId: 2, username: "new", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  assert.equal(fresh.reviewAllProjects, false, "web sign-up starts strict");
  setUser(db, "old", ["review_all_projects=0"]);
  db.close();
  db = openDb(file);
  assert.equal(getUser(db, "old")!.reviewAllProjects, false, "the UPDATE runs only when the column is added");
  assert.throws(() => setUser(db, "old", ["review_all_projects=yes"]));
});

test("bootstrapOwner: the owner created via OAuth reviews all projects; other sign-ups stay strict", () => {
  const db = openDb(":memory:");
  const o = upsertOAuthUser(db, key, { gitlabUserId: 1, username: "boss", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 });
  assert.equal(o.reviewAllProjects, false);
  const owner = bootstrapOwner(db, o, "boss", () => {});
  assert.deepEqual({ own: owner.isOwner, all: owner.reviewAllProjects }, { own: true, all: true });
  assert.equal(upsertOAuthUser(db, key, { gitlabUserId: 2, username: "col", accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 1e7 }).reviewAllProjects, false);
});
