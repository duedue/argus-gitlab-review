import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { allowMr, listSeenMrs, openDb, replaceSeenMrs, type Db } from "../src/db.ts";
import type { ReviewEngine } from "../src/engine.ts";
import type { GitLab, Mr, MrSummary } from "../src/gitlab.ts";
import { mayApprove } from "../src/approve.ts";
import { reviewAllowed } from "../src/projects.ts";
import { ReviewQueue } from "../src/queue.ts";
import { pollOnce, type UserRuntime } from "../src/review.ts";
import { createSession } from "../src/sessions.ts";
import { triggerReviews } from "../src/trigger.ts";
import { addUser, getUser, getUserById, setUser } from "../src/users.ts";
import { createApp } from "../src/web/app.tsx";

const GL = "https://gl.test";
const key = randomBytes(32);
const dir = mkdtempSync(join(tmpdir(), "al-"));
writeFileSync(join(dir, "SKILL.md"), "x");
const skillPath = join(dir, "SKILL.md");
const cfg = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "d-")), GITLAB_URL: GL }), dryRun: true };
const prepare = async () => ({ dir: "/x", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });
const mkUser = (db: Db, id: number, name: string, list = "", allowAll = false) => {
  addUser(db, key, { gitlabUserId: id, username: name, token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  setUser(db, name, [`review_projects=${list}`, `review_all_projects=${allowAll ? 1 : 0}`]);
  return getUser(db, name)!;
};
const summary = (id: number, path: string, author = 99): MrSummary => ({ id, iid: id, project_id: 7, title: `t${id}`, description: "", sha: "deadbeef00", web_url: `${GL}/${path}/-/merge_requests/${id}`, target_branch: "main", author: { id: author, username: `u${author}` } });
const quiet = async <T>(f: () => T | Promise<T>): Promise<T> => {
  const l = console.log, e = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await f(); } finally { console.log = l; console.error = e; }
};

test("reviewAllowed: project list, allowAll, single allowed MR, own MR; everything else denied", () => {
  const db = openDb(":memory:");
  const u = mkUser(db, 1, "alice", "grp/a");
  assert.equal(reviewAllowed(db, u, "grp/a/x", 10, 99), true, "project");
  assert.equal(reviewAllowed(db, u, "other/z", 11, 99), false);
  allowMr(db, 1, { mrId: 11, projectId: 7, mrIid: 11 });
  assert.equal(reviewAllowed(db, u, "other/z", 11, 99), true, "single MR");
  assert.equal(reviewAllowed(db, u, "other/z", 12, 99), false, "only that MR");
  assert.equal(reviewAllowed(db, { ...u, gitlabUserId: 2 }, "other/z", 11, 99), false, "per user");
  assert.equal(reviewAllowed(db, u, "other/z", 13, 1), true, "own MR");
  assert.equal(reviewAllowed(db, u, undefined, 13, 1), true, "own MR even with an unparseable url");
  assert.equal(reviewAllowed(db, u, "other/z", 13, undefined), false, "unknown author fails closed");
  assert.equal(reviewAllowed(db, { ...u, reviewAllProjects: true }, "any/thing", 14), true, "allowAll");
});

test("own MR via the reviewer path is reviewed but still never auto-approves", () => {
  const input = { autoApprove: true, dryRun: false, replay: false, selfReview: false, verdict: "approve" as const, findings: [], unfixedPrev: 0, userId: 1 };
  assert.equal(mayApprove({ ...input, authorId: 1 }), false);
  assert.equal(mayApprove({ ...input, authorId: 99 }), true);
});

function pollHarness(list: string, listFails = false, assignedFails = false) {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice", list);
  const reviewed: number[] = [];
  let mrs = [summary(1, "grp/a/x"), summary(2, "other/z"), summary(3, "other/q"), summary(4, "other/own", 1)];
  const gl = {
    listAssignedMrs: async () => { if (assignedFails) throw new Error("assigned boom"); return []; },
    listReviewMrs: async () => { if (listFails) throw new Error("boom"); return mrs; },
    getMr: async (_p: number, iid: number) => ({ ...mrs.find((m) => m.iid === iid)!, state: "opened", diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } }),
    getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => [], listNotes: async () => [],
  } as unknown as GitLab;
  const engine: ReviewEngine = { review: async (i) => (reviewed.push(Number(i.mrTitle.slice(1))), { findings: [], resolved: [] }) };
  const poll = () => quiet(() => pollOnce(cfg, db, [getUser(db, "alice")!], () => ({ token: async () => "t", gl, engine, prepare }), new ReviewQueue()));
  return { db, reviewed, poll, setMrs: (m: MrSummary[]) => (mrs = m) };
}

test("poll: seen_mrs is replaced each successful list; own MRs are reviewed and never recorded; a single allowed MR is reviewed", async () => {
  const h = pollHarness("grp/a");
  await h.poll();
  assert.deepEqual(h.reviewed.sort(), [1, 4], "listed project + own MR");
  assert.deepEqual(listSeenMrs(h.db, 1).map((m) => [m.mrId, m.path, m.title, m.author]).sort(), [[2, "other/z", "t2", "u99"], [3, "other/q", "t3", "u99"]]);
  allowMr(h.db, 1, { mrId: 2, projectId: 7, mrIid: 2 });
  h.setMrs([summary(2, "other/z"), summary(5, "other/y")]);
  await h.poll();
  assert.ok(h.reviewed.includes(2), "allowed single MR is reviewed");
  assert.deepEqual(listSeenMrs(h.db, 1).map((m) => m.mrId), [5], "closed/allowed rows disappear, new ones appear");
});

test("poll: a failed list leaves seen_mrs untouched", async () => {
  const h = pollHarness("grp/a", true);
  replaceSeenMrs(h.db, 1, [{ mrId: 9, projectId: 7, mrIid: 9, path: "x/y", title: "t", url: `${GL}/x/y/-/merge_requests/9`, author: null }]);
  await h.poll();
  assert.deepEqual(listSeenMrs(h.db, 1).map((m) => m.mrId), [9]);
});

test("trigger: non-self honours a single allowed MR and the author's own MR", async () => {
  const db = openDb(":memory:");
  const caller = mkUser(db, 1, "caller", "other/only");
  const rev = mkUser(db, 2, "rev", "other/only");
  mkUser(db, 3, "own", "other/only");
  const mk = (id: number, author: number): Mr => ({ id, iid: id, project_id: 9, title: "t", description: "", sha: "deadbeef00", web_url: `${GL}/grp/p/-/merge_requests/${id}`, target_branch: "main", state: "opened", author: { id: author },
    reviewers: [{ id: 2, username: "rev" }, { id: 3, username: "own" }], diff_refs: { base_sha: "b", start_sha: "b", head_sha: "deadbeef00" } });
  let cur = mk(7, 3);
  const ran: string[] = [];
  const runtimeFor = async (u: { username: string }) => ({
    token: async () => "t",
    gl: { getMr: async () => cur, getProject: async () => ({ id: 9, http_url_to_repo: "x", path_with_namespace: "g/p" }), listDiscussions: async () => [] } as unknown as GitLab,
    engine: { review: async () => (ran.push(u.username), { findings: [], resolved: [] }) } as ReviewEngine,
    prepare,
  });
  const queue = new ReviewQueue();
  const r1 = await quiet(() => triggerReviews({ cfg, db, queue, runtimeFor }, caller, { path: "grp/p", iid: 7 }));
  assert.deepEqual(r1.queued, ["own"], "author's own MR passes, other reviewer does not");
  cur = mk(8, 99);
  allowMr(db, rev.gitlabUserId, { mrId: 8, projectId: 9, mrIid: 8 });
  const r2 = await quiet(() => triggerReviews({ cfg, db, queue, runtimeFor }, caller, { path: "grp/p", iid: 8 }));
  assert.deepEqual(r2.queued, ["rev"], "single allowed MR passes");
});

// --- web ---
function web(engine = true, mrOver: Partial<Mr> = {}) {
  const db = openDb(":memory:");
  mkUser(db, 1, "alice");
  mkUser(db, 2, "bob");
  const enq: string[] = [];
  const queue = { enqueue: (_l: unknown, k: string) => (enq.push(k), { queued: true }) } as unknown as ReviewQueue;
  const mr = { ...summary(10, "grp/a/x"), state: "opened", diff_refs: { base_sha: "b", start_sha: "b", head_sha: "x" }, ...mrOver } as Mr;
  const rt: UserRuntime = { token: async () => "t", gl: { getMr: async () => mr } as unknown as GitLab, engine: engine ? ({ review: async () => ({ findings: [], resolved: [] }) } as ReviewEngine) : undefined };
  const app = createApp({ cfg, db, key, oauth: { gitlabUrl: GL, redirectUri: "x", clientId: "c", clientSecret: "s" }, runtimeFor: async () => rt, queue });
  const sess = (id: number) => { const s = createSession(db, id); return { cookie: `sid=${s.id}`, csrf: s.csrf }; };
  const post = (path: string, s: { cookie: string; csrf: string }, fields: Record<string, string> = {}, csrf: string | null = s.csrf) =>
    app.request(path, { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ ...(csrf === null ? {} : { _csrf: csrf }), ...fields }) });
  const get = async (path: string, s: { cookie: string }) => (await app.request(path, { headers: { cookie: s.cookie } })).text();
  const seen = (owner: number, id: number, path: string) => replaceSeenMrs(db, owner, [...listSeenMrs(db, owner).map((m) => ({ mrId: m.mrId, projectId: m.projectId, mrIid: m.mrIid, path: m.path, title: m.title, url: m.url, author: m.author })), { mrId: id, projectId: 7, mrIid: id, path, title: `title ${id}`, url: `${GL}/${path}/-/merge_requests/${id}`, author: "zed" }]);
  return { db, app, enq, sess, post, get, seen };
}

test("/reviews pending block: rows with accessible buttons; hidden when empty or allow-all", async () => {
  const w = web();
  const s = w.sess(1);
  assert.doesNotMatch(await w.get("/reviews", s), /待你決定的 MR/, "empty");
  w.seen(1, 10, "grp/a/x");
  const html = await w.get("/reviews", s);
  assert.match(html, /待你決定的 MR（1）/);
  assert.match(html, /aria-label="只審這張 grp\/a\/x!10"/);
  assert.match(html, /aria-label="允許該專案自動審查（grp\/a\/x）"/);
  assert.match(html, /action="\/pending-mrs\/10\/allow-mr"/);
  assert.match(html, /作者 zed/);
  setUser(w.db, "alice", ["review_all_projects=1"]);
  assert.doesNotMatch(await w.get("/reviews", s), /待你決定的 MR/, "allow-all");
});

test("allow-mr: auth, CSRF, only own rows, stores the allowance, enqueues at once and removes the row", async () => {
  const w = web();
  w.seen(1, 10, "grp/a/x");
  const alice = w.sess(1), bob = w.sess(2);
  assert.equal((await w.app.request("/pending-mrs/10/allow-mr", { method: "POST" })).status, 302, "no session");
  assert.equal((await w.post("/pending-mrs/10/allow-mr", alice, {}, "bad")).status, 403);
  assert.equal((await w.post("/pending-mrs/10/allow-mr", bob)).status, 404, "bob cannot act on alice's row");
  assert.equal((await w.post("/pending-mrs/abc/allow-mr", alice)).status, 404);
  assert.equal(listSeenMrs(w.db, 1).length, 1);
  const res = await quiet(() => w.post("/pending-mrs/10/allow-mr", alice));
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location")!, /^\/reviews\?notice=queued$/);
  assert.equal(w.enq.length, 1);
  assert.deepEqual(listSeenMrs(w.db, 1), []);
  assert.equal(reviewAllowed(w.db, getUserById(w.db, 1)!, "grp/a/x", 10, 99), true);
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, [], "the project list is untouched");
  assert.match(await w.get("/reviews?notice=queued", alice), /已允許，審查已排入佇列/);
});

test("allow-project: adds the full path, clears same-project rows, enqueues this MR; no engine = allowed but not queued, with the reason", async () => {
  const w = web();
  w.seen(1, 10, "grp/a/x");
  w.seen(1, 11, "grp/a/x");
  w.seen(1, 12, "other/z");
  const alice = w.sess(1);
  const res = await quiet(() => w.post("/pending-mrs/10/allow-project", alice));
  assert.equal(res.status, 302);
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, ["grp/a/x"]);
  assert.deepEqual(listSeenMrs(w.db, 1).map((m) => m.mrId), [12], "other MRs of that project leave the block");
  assert.equal(w.enq.length, 1);

  const n = web(false);
  n.seen(1, 10, "grp/a/x");
  const r = await quiet(() => n.post("/pending-mrs/10/allow-mr", n.sess(1)));
  assert.match(r.headers.get("location")!, /notice=allowed_no_engine/);
  assert.equal(n.enq.length, 0, "no engine: not queued");
  assert.equal(reviewAllowed(n.db, getUserById(n.db, 1)!, "grp/a/x", 10, 99), true, "but still allowed");
  assert.match(await n.get("/reviews?notice=allowed_no_engine", n.sess(1)), /沒有可用的審查引擎/);
  assert.doesNotMatch(await n.get("/reviews?notice=<script>", n.sess(1)), /<script>/, "the query never supplies text");
});

test("settings project list: renders rows with labelled remove buttons; add normalizes and dedupes; bad input -> zh-TW 400; remove is instant", async () => {
  const w = web();
  const s = w.sess(1);
  let html = await w.get("/settings", s);
  assert.doesNotMatch(html, /name="review_projects"/, "textarea is gone");
  assert.doesNotMatch(html, /最近出現但未列入/);
  assert.match(html, /清單是空的/);
  assert.equal((await w.post("/settings/projects/add", s, { project: " Grp/A/ " })).status, 302);
  assert.equal((await w.post("/settings/projects/add", s, { project: "grp/a" })).status, 302);
  await w.post("/settings/projects/add", s, { project: "grp/b" });
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, ["grp/a", "grp/b"]);
  html = await w.get("/settings", s);
  assert.match(html, /aria-label="解除審查 grp\/a"/);
  const bad = await w.post("/settings/projects/add", s, { project: "bad path" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /不合法的路徑/);
  assert.equal((await w.post("/settings/projects/add", s, { project: "  " })).status, 400);
  assert.equal((await w.post("/settings/projects/add", s, { project: "x" }, "bad")).status, 403);
  assert.equal((await w.post("/settings/projects/remove", s, { project: "GRP/A" })).status, 302);
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, ["grp/b"]);
  assert.deepEqual(getUserById(w.db, 2)!.reviewProjects, [], "bob untouched");
  await w.post("/settings/projects/remove", s, { project: "not/in/list" });
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, ["grp/b"]);
  setUser(w.db, "alice", ["review_all_projects=1"]);
  html = await w.get("/settings", s);
  assert.match(html, /is-superseded/);
  assert.match(html, /id="review_projects_unrestricted"(?![^>]*hidden)/);
  assert.match(html, /目前不限制/);
});

test("settings form no longer touches review_projects", async () => {
  const w = web();
  const s = w.sess(1);
  await w.post("/settings/projects/add", s, { project: "grp/a" });
  const res = await w.app.request("/settings", { method: "POST", headers: { cookie: s.cookie }, body: new URLSearchParams({ _csrf: s.csrf, severity_threshold: "minor", confidence_threshold: "0.7", language: "zh-TW" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, ["grp/a"]);
});

test("poll: a failed assignee list leaves seen_mrs untouched (the skipped set would be incomplete)", async () => {
  const h = pollHarness("grp/a", false, true);
  setUser(h.db, "alice", ["review_assigned=1"]);
  replaceSeenMrs(h.db, 1, [{ mrId: 9, projectId: 7, mrIid: 9, path: "x/y", title: "t", url: `${GL}/x/y/-/merge_requests/9`, author: null }]);
  await h.poll();
  assert.deepEqual(listSeenMrs(h.db, 1).map((m) => m.mrId), [9]);
  assert.deepEqual(h.reviewed.sort(), [1, 4], "reviews still run");
});

test("allow on a draft MR keeps the decision, does not enqueue, and does not use the rate-limit budget", async () => {
  const w = web(true, { draft: true });
  const alice = w.sess(1);
  for (let i = 1; i <= 12; i++) w.seen(1, 100 + i, "grp/a/x");
  for (let i = 1; i <= 12; i++) {
    const r = await quiet(() => w.post(`/pending-mrs/${100 + i}/allow-mr`, alice));
    assert.match(r.headers.get("location")!, /notice=allowed_draft$/, `draft #${i} is never "busy"`);
  }
  assert.equal(w.enq.length, 0);
  assert.equal(reviewAllowed(w.db, getUserById(w.db, 1)!, "grp/a/x", 101, 99), true);
  assert.match(await w.get("/reviews?notice=allowed_draft", alice), /callout-warn[^>]*>已記下；MR 轉為 ready 後會自動審查/);
});

test("allow-mr: the 11th immediate review within a minute is allowed but not queued (busy)", async () => {
  const w = web();
  const alice = w.sess(1);
  for (let i = 1; i <= 11; i++) w.seen(1, 200 + i, "grp/a/x");
  const last: string[] = [];
  for (let i = 1; i <= 11; i++) last.push((await quiet(() => w.post(`/pending-mrs/${200 + i}/allow-mr`, alice))).headers.get("location")!);
  assert.equal(w.enq.length, 10);
  assert.match(last[10]!, /notice=allowed_busy$/);
});

test("project list errors and notices render inside the list card; remove normalizes like add and reports a miss", async () => {
  const w = web();
  const s = w.sess(1);
  const bad = await (await w.post("/settings/projects/add", s, { project: "bad path" })).text();
  const card = bad.slice(bad.indexOf('id="review-projects-h"'), bad.indexOf('action="/settings"'));
  assert.match(card, /role="alert"[^>]*>[^<]*不合法的路徑/, "error inside the card");
  assert.match(card, /name="project" value="bad path"/, "typed value kept");
  await w.post("/settings/projects/add", s, { project: "grp/a" });
  setUser(w.db, "alice", ["review_projects=grp/a,grp/b"]); // changed elsewhere (CLI): the next write must start from the stored row
  await w.post("/settings/projects/add", s, { project: "grp/c" });
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, ["grp/a", "grp/b", "grp/c"]);
  const rm = await w.post("/settings/projects/remove", s, { project: " GRP/B/ " });
  assert.match(rm.headers.get("location")!, /notice=removed#/);
  assert.deepEqual(getUserById(w.db, 1)!.reviewProjects, ["grp/a", "grp/c"]);
  const miss = await w.post("/settings/projects/remove", s, { project: "nope/x" });
  assert.match(miss.headers.get("location")!, /notice=not_found#/);
  const html = await w.get("/settings?notice=not_found", s);
  assert.match(html.slice(html.indexOf('id="review-projects-h"')), /^[^]*?callout-warn[^>]*>清單中沒有這一項/);
  assert.doesNotMatch(await w.get("/settings?notice=not_found", s), /已解除/);
});
