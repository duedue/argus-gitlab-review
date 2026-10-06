import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptWatch, afterAccept, parseAccept } from "../src/accept.ts";
import { loadConfig } from "../src/config.ts";
import { handleNote, openDb } from "../src/db.ts";
import { buildPrompt, type ReviewEngine } from "../src/engine.ts";
import type { Finding } from "../src/findings.ts";
import type { GitLab, Mr } from "../src/gitlab.ts";
import { fp, inlineBody, summaryBody } from "../src/publisher.ts";
import { ReviewQueue } from "../src/queue.ts";
import { pollOnce, reviewMr, type UserRuntime } from "../src/review.ts";
import { addUser, getUser, setUser } from "../src/users.ts";

const f = (o: Partial<Finding> = {}): Finding => ({ severity: "major", file: "a.ts", line: 3, title: "t", body: "B", confidence: 0.9, ...o });
const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "accept-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");

type Note = { id: number; body: string; author: { id: number; username?: string }; system?: boolean; resolvable?: boolean; resolved?: boolean; position?: { new_path: string; new_line: number } };
type Res = Awaited<ReturnType<ReviewEngine["review"]>>;

function harness(o: { dryRun?: boolean; autoApprove?: boolean; authorId?: number; listed?: boolean; language?: string; beforeJob?: () => Promise<void> } = {}) {
  acceptWatch.clear();
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: true });
  setUser(db, "alice", [`auto_approve=${o.autoApprove === false ? 0 : 1}`, `language=${o.language ?? "zh-TW"}`]);
  const user = getUser(db, "alice")!;
  let sha = "1".repeat(40);
  let noteSeq = 500;
  let notesCount = 0;
  let approved = false;
  let failVerdictNote = 0;
  let failResolve = 0;
  const ds: { id: string; notes: Note[] }[] = [];
  const c = { replies: [] as [string, string][], resolves: [] as string[], notes: [] as string[], approves: [] as string[], getMr: 0, listDisc: 0, posts: 0 };
  const touch = () => notesCount++;
  const mr = (): Mr => ({
    id: 100, iid: 5, project_id: 7, title: "t", description: "", sha, web_url: "u", target_branch: "main", state: "opened",
    author: { id: o.authorId ?? 2 }, user_notes_count: notesCount, updated_at: "x", diff_refs: { base_sha: "b", start_sha: "b", head_sha: sha },
  });
  const gl = {
    getMr: async () => { c.getMr++; return mr(); },
    getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => { c.listDisc++; return structuredClone(ds); },
    listReviewMrs: async () => (o.listed ? [mr()] : []),
    postNote: async (_p: number, _i: number, body: string) => { if (failVerdictNote > 0 && body.includes("結論更新為")) { failVerdictNote--; throw new Error("503"); } c.notes.push(body); ds.push({ id: `n${++noteSeq}`, notes: [{ id: noteSeq, body, author: { id: 1 } }] }); touch(); },
    postDiscussion: async (_p: number, _i: number, body: string, pos: { new_path: string; new_line: number }) => {
      c.posts++;
      ds.push({ id: `d${++noteSeq}`, notes: [{ id: noteSeq, body, author: { id: 1 }, resolvable: true, resolved: false, position: { new_path: pos.new_path, new_line: pos.new_line } }] });
      touch();
    },
    replyDiscussion: async (_p: number, _i: number, d: string, body: string) => { c.replies.push([d, body]); ds.find((x) => x.id === d)!.notes.push({ id: ++noteSeq, body, author: { id: 1 } }); touch(); },
    resolveDiscussion: async (_p: number, _i: number, d: string) => { if (failResolve > 0) { failResolve--; throw new Error("502"); } c.resolves.push(d); ds.find((x) => x.id === d)!.notes[0]!.resolved = true; },
    userHasApproved: async () => approved,
    approveMr: async (_p: number, _i: number, s: string) => { c.approves.push(s); approved = true; },
    unapproveMr: async () => { approved = false; },
    resetsApprovalsOnPush: async () => false,
  } as unknown as GitLab;
  let next: Res = { findings: [], resolved: [] };
  const seen: unknown[] = [];
  const inputs: Parameters<ReviewEngine["review"]>[0][] = [];
  const rt: UserRuntime = {
    token: async () => "t", gl, prepare: async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false }),
    engine: { review: async (input) => { seen.push(input.openThreads); inputs.push(input); return next; } },
  };
  const cfg = { ...loadConfig({}), dryRun: o.dryRun ?? false };
  const real = new ReviewQueue();
  // beforeJob runs once inside the queue ahead of the next job: "a review finished while the accept job waited".
  const queue = { enqueue: (lane: number, k: string, job: () => Promise<void>) => real.enqueue(lane, k, async () => { const b = o.beforeJob; o.beforeJob = undefined; if (b) await b(); await job(); }) } as unknown as ReviewQueue;
  const quiet = async (fn: () => Promise<void>) => {
    const { log, warn, error } = console;
    console.log = console.warn = () => {};
    const errs: string[] = [];
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try { await fn(); } finally { Object.assign(console, { log, warn, error }); }
    return errs;
  };
  return {
    db, c, ds, seen, inputs,
    thread: () => ds.find((d) => d.notes[0]!.position)!,
    /** A note (reply in `discussion`, else a new top-level note, resolvable unless `plain`) by GitLab user `author`. */
    say(body: string, author = 1, discussion?: string, plain = false) {
      const n: Note = { id: ++noteSeq, body, author: { id: author }, ...(discussion || plain ? {} : { resolvable: true, resolved: false }) };
      if (discussion) ds.find((d) => d.id === discussion)!.notes.push(n);
      else ds.push({ id: `n${noteSeq}`, notes: [n] });
      touch();
      return n.id;
    },
    accepted: () => db.prepare(`SELECT sentinel, reason, accepted_by, note_id, dry_run FROM accepted_findings`).all() as { sentinel: string; reason: string; accepted_by: number; note_id: number; dry_run: number }[],
    round: (newSha: string, res: Res, selfReview = false) => quiet(async () => { sha = newSha; next = res; await reviewMr(cfg, db, user, rt, mr(), undefined, { selfReview }); }),
    poll: (rtOverride?: Partial<UserRuntime>) => quiet(() => pollOnce(cfg, db, [user], () => ({ ...rt, ...rtOverride }), queue)),
    failVerdictNote: (n: number) => (failVerdictNote = n),
    failResolve: (n: number) => (failResolve = n),
    setBeforeJob: (fn: () => Promise<void>) => (o.beforeJob = fn),
    push: (newSha: string) => { sha = newSha; },
    reviewRaw: (newSha: string, res: Res) => { sha = newSha; next = res; return reviewMr(cfg, db, user, rt, mr()); },
    reset: () => { c.replies.length = c.notes.length = c.resolves.length = c.approves.length = 0; c.getMr = c.listDisc = 0; },
  };
}

test("parseAccept is strict: command only at note start, id 6-12 hex, reason optional", () => {
  assert.deepEqual(parseAccept("/argus accept 誤報，這是預期行為"), { reason: "誤報，這是預期行為" });
  assert.deepEqual(parseAccept("  /argus accept  "), { reason: "" });
  assert.deepEqual(parseAccept("/ARGUS accept #24A3C7 ok\nmore"), { id: "24a3c7", reason: "ok\nmore" });
  assert.deepEqual(parseAccept("/argus accept #0123456789ab"), { id: "0123456789ab", reason: "" });
  for (const bad of ["/argus accept #24a3", "/argus accept #zzzzzz x", "/argus accept #0123456789abc"]) assert.deepEqual(parseAccept(bad), { bad: true }, bad);
  for (const none of ["please /argus accept x", "/argus accepted", "/argus help", "> /argus accept quoted", "argus accept"]) assert.equal(parseAccept(none), undefined, none);
});

test("afterAccept: verdict lifts only when nothing blocking remains (same rule as auto-approve)", () => {
  const a = f({ title: "a" }), n = f({ title: "n", severity: "nit" });
  assert.equal(afterAccept([a, n], [], new Set([fp(a)]), "request_changes").verdict, "approve"); // nit left: still clean
  assert.equal(afterAccept([a], ["0123456789ab"], new Set([fp(a)]), "request_changes").verdict, "request_changes"); // unfixed prev left
  assert.equal(afterAccept([a], ["0123456789ab"], new Set([fp(a), "0123456789ab"]), "needs_discussion").verdict, "approve");
});

test("every finding shows its short id and the accept hint (inline + summary)", () => {
  const a = f({ title: "x" });
  const hint = { reviewer: "alice", baseUrl: "https://argus", language: "zh-TW" };
  const inl = inlineBody(a, hint);
  assert.ok(inl.startsWith(`🤖 **Argus** · \`#${fp(a).slice(0, 6)}\` · **major**: x`));
  assert.match(inl, /審查者 @alice 同意可回覆 `\/argus accept`。（\[說明\]\(https:\/\/argus\/docs\/mr\)）/);
  const sum = summaryBody([], [a, f({ title: "y", severity: "nit" })], { round: 1, sha: "0".repeat(40), language: "zh-TW", verdict: "approve", checked: [] }, undefined, 2, hint);
  assert.ok(sum.includes(`\`/argus accept #${fp(a).slice(0, 6)} <原因>\``));
  assert.ok(sum.includes(`/argus accept #${fp(f({ title: "y" })).slice(0, 6)} <原因>`), "nit items carry the hint too");
  assert.match(inlineBody(a, { ...hint, language: "en" }), /reviewer @alice can reply `\/argus accept`/);
});

test("inline thread accept: reply + resolve, recomputed verdict note, auto-approve; recorded once", async () => {
  const h = harness();
  const a = f();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  assert.equal(h.c.approves.length, 0);
  const t = h.thread();
  assert.match(t.notes[0]!.body, /審查者 @alice 同意可回覆 `\/argus accept`。（\[說明\]\(http:\/\/localhost:3000\/docs\/mr\)）/, "publish wires the hint");
  const nid = h.say("/argus accept 這是預期行為", 1, t.id);
  h.reset();
  await h.poll();
  assert.deepEqual(h.c.replies, [[t.id, "🤖 **Argus** · ✅ 已接受（原因：這是預期行為）。此項不再列入「仍存在」，也不計入結論。"]]);
  assert.deepEqual(h.c.resolves, [t.id]);
  assert.ok(h.c.notes.includes("🤖 **Argus** · 已接受 1 項，剩 0 項，結論更新為：**可合併**"), h.c.notes.join("\n"));
  assert.deepEqual(h.c.approves, ["1".repeat(40)]);
  assert.deepEqual(h.accepted(), [{ sentinel: fp(a), reason: "這是預期行為", accepted_by: 1, note_id: nid, dry_run: 0 }]);
  // Next cycles (stamp changed by our own replies) and a restart (fresh stamps) never handle it again.
  h.reset();
  await h.poll();
  acceptWatch.clear();
  await h.poll();
  assert.deepEqual([h.c.replies.length, h.c.notes.length, h.c.resolves.length], [0, 0, 0]);
  assert.equal(h.accepted().length, 1);
});

test("self-review MR: accept recomputes but never approves", async () => {
  const h = harness();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] }, true);
  h.say("/argus accept ok", 1, h.thread().id);
  await h.poll();
  assert.ok(h.c.notes.some((n) => n.includes("結論更新為：**可合併**")));
  assert.deepEqual(h.c.approves, []);
});

test("summary item accept via #id; partial accept keeps the verdict", async () => {
  const h = harness();
  const a = f({ line: undefined, title: "summary-only" });
  const b = f({ line: undefined, title: "still here" });
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a, b], resolved: [] });
  assert.ok(h.c.notes[0]!.includes(`同意可留言 \`/argus accept #${fp(a).slice(0, 6)} <原因>\``), "summary items carry the #id hint");
  const d = h.say(`/argus accept #${fp(a).slice(0, 6)} 已在別張 MR 處理`);
  h.reset();
  await h.poll();
  assert.deepEqual(h.c.replies, [[`n${d}`, "🤖 **Argus** · ✅ 已接受（原因：已在別張 MR 處理）。此項不再列入「仍存在」，也不計入結論。"]]);
  assert.deepEqual(h.c.resolves, [`n${d}`], "the handled command discussion is resolved");
  assert.ok(h.c.notes.includes("🤖 **Argus** · 已接受 1 項，剩 1 項，結論更新為：**建議修改**"), h.c.notes.join("\n"));
  assert.deepEqual(h.c.approves, []);
  assert.deepEqual(h.accepted().map((r) => r.sentinel), [fp(a)]);
});

test("non-reviewer is refused with a reply that mentions the reviewer; nothing is accepted", async () => {
  const h = harness();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  const t = h.thread();
  h.say("/argus accept 我覺得不用改", 2, t.id); // the MR author
  h.reset();
  await h.poll();
  assert.deepEqual(h.c.replies, [[t.id, "🤖 **Argus** · 只有審查者 @alice 能標記接受。不打算修改的話，請回覆原因讓 @alice 判斷。"]]);
  assert.deepEqual([h.c.resolves.length, h.c.notes.length, h.accepted().length], [0, 0, 0]);
  await h.poll(); // answered once
  assert.equal(h.c.replies.length, 1);
});

test("format errors are answered: missing/bad id, unknown id, wrong id in thread; others' threads ignored", async () => {
  const h = harness();
  const a = f();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  const n1 = h.say("/argus accept 沒帶 id");
  const n2 = h.say("/argus accept #zz12 x");
  const n3 = h.say("/argus accept #ffffff 不存在");
  const t = h.thread();
  h.say("/argus accept #abcdef 錯的 id", 1, t.id);
  // An inline thread opened by another Argus reviewer (user 3): theirs to answer.
  h.ds.push({ id: "other", notes: [{ id: 900, body: inlineBody(f({ title: "theirs" })), author: { id: 3 }, resolvable: true, resolved: false, position: { new_path: "a.ts", new_line: 1 } }, { id: 901, body: "/argus accept x", author: { id: 3 } }] });
  h.reset();
  await h.poll();
  const by = new Map(h.c.replies);
  assert.match(by.get(`n${n1}`)!, /指令格式錯誤：請用 `\/argus accept #短id <原因>`/);
  assert.match(by.get(`n${n2}`)!, /指令格式錯誤/);
  assert.match(by.get(`n${n3}`)!, /找不到待處理的 `#ffffff`/);
  assert.match(by.get(t.id)!, new RegExp(`須與本項 \`#${fp(a).slice(0, 6)}\` 相同`));
  assert.equal(by.has("other"), false);
  assert.deepEqual([h.c.replies.length, h.accepted().length, h.c.notes.length, h.c.resolves.length], [4, 0, 0, 0], "refused commands stay open");
});

test("next round: accepted item is not tracked as still open and an identical re-report is dropped", async () => {
  const h = harness({ autoApprove: false });
  const a = f({ title: "accepted one" });
  const s = f({ title: "summary accepted", line: undefined });
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a, s], resolved: [] });
  h.say("/argus accept ok", 1, h.thread().id);
  h.say(`/argus accept #${fp(s).slice(0, 6)} ok`);
  await h.poll();
  assert.equal(h.accepted().length, 2);
  h.reset();
  h.thread().notes[0]!.resolved = false; // resolve failed / a human reopened it: still accepted
  const postsBefore = h.c.posts;
  await h.round("2".repeat(40), { verdict: "request_changes", findings: [a, s], resolved: [] }); // AI reports both again
  assert.deepEqual(h.seen.at(-1), [], "accepted items are not handed to the AI as open threads");
  assert.equal(h.c.posts, postsBefore, "no new inline thread for the accepted finding");
  const sum = h.c.notes.at(-1)!;
  assert.match(sum, /第 2 輪 .* · \*\*可合併\*\*/);
  assert.match(sum, /未發現需要回報的問題/);
  assert.match(sum, /審查者已接受 2 項/);
  assert.match(sum, /上一輪 0 項：已修正 0、仍存在 0/);
  assert.doesNotMatch(sum, /accepted one|summary accepted/);
  const row = h.db.prepare(`SELECT findings_json FROM reviews WHERE head_sha=?`).get("2".repeat(40)) as { findings_json: string };
  assert.deepEqual(JSON.parse(row.findings_json), { findings: [], verdict: "approve", summaryOpen: [], unfixedPrev: [] });
});

test("watch: discussions are read only when the MR changed; listed MRs need no extra GET", async () => {
  const h = harness();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  h.reset();
  await h.poll(); // first look
  assert.deepEqual([h.c.getMr, h.c.listDisc], [1, 1]);
  await h.poll(); // nothing new
  assert.deepEqual([h.c.getMr, h.c.listDisc], [2, 1]);
  h.say("隨便聊聊", 2);
  await h.poll(); // new note -> one read
  assert.deepEqual([h.c.getMr, h.c.listDisc], [3, 2]);
  assert.deepEqual(h.c.replies, []);

  const l = harness({ listed: true });
  await l.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  l.reset();
  await l.poll();
  await l.poll();
  assert.equal(l.c.getMr, 0, "stamp comes from the reviewer listing");
  assert.equal(l.c.listDisc, 1);
});

test("watch is skipped when nothing is open, and a watch failure does not break the cycle", async () => {
  const h = harness();
  await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  h.reset();
  await h.poll();
  assert.deepEqual([h.c.getMr, h.c.listDisc], [0, 0]);

  const e = harness();
  await e.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  e.say("/argus accept ok", 1, e.thread().id);
  const errs = await e.poll({ gl: { ...({} as GitLab), listReviewMrs: async () => [], getMr: async () => { throw new Error("502"); } } as unknown as GitLab });
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /\[accept\] alice 7!5 failed: 502/);
  await e.poll(); // recovers next cycle
  assert.equal(e.accepted().length, 1);
});

test("dry-run: accept is recorded per mode but nothing is posted, resolved or approved", async () => {
  const h = harness({ dryRun: true });
  const a = f({ line: undefined });
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  assert.equal(h.ds.length, 0, "dry-run review posted nothing");
  h.say(`/argus accept #${fp(a).slice(0, 6)} ok`);
  h.say("/argus accept #ffffff nope", 2);
  await h.poll();
  assert.deepEqual([h.c.replies.length, h.c.notes.length, h.c.resolves.length, h.c.approves.length], [0, 0, 0, 0]);
  assert.deepEqual(h.accepted().map((r) => [r.sentinel, r.dry_run]), [[fp(a), 1]]);
});

const announced = (db: ReturnType<typeof openDb>) => (db.prepare(`SELECT announced FROM accepted_findings`).all() as { announced: number }[]).map((r) => r.announced);

test("legacy row (no unfixedPrev, no findings) with only an open inline thread: accept is still handled", async () => {
  const h = harness();
  const a = f({ title: "from an older round" });
  h.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, findings_json) VALUES (1, 7, 100, 5, ?, 0, 'done', ?)`)
    .run("1".repeat(40), JSON.stringify({ findings: [], verdict: "approve", summaryOpen: [] }));
  h.ds.push({ id: "old", notes: [{ id: 42, body: inlineBody(a), author: { id: 1 }, resolvable: true, resolved: false, position: { new_path: "a.ts", new_line: 3 } }] });
  h.say("/argus accept 舊項目不改", 1, "old");
  await h.poll();
  assert.deepEqual(h.accepted().map((r) => r.sentinel), [fp(a)]);
  assert.deepEqual(h.c.resolves, ["old"]);
  assert.match(h.c.replies[0]![1], /已接受（原因：舊項目不改）/);
  assert.ok(h.c.notes.includes("🤖 **Argus** · 已接受 1 項，剩 0 項，結論更新為：**可合併**"), h.c.notes.join("\n"));
});

test("job re-reads the latest round: a review that finished while it waited is the recompute base", async () => {
  const a = f({ title: "accept me" });
  const b = f({ title: "fixed in round 2", line: undefined });
  const h = harness();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a, b], resolved: [] });
  h.say("/argus accept ok", 1, h.thread().id);
  // Round 2 (new head) completes in the queue ahead of the accept job: b fixed, a re-reported (not yet accepted then).
  h.setBeforeJob(() => h.reviewRaw("2".repeat(40), { verdict: "request_changes", findings: [a], resolved: [fp(b)] }));
  h.reset();
  await h.poll();
  assert.ok(h.c.notes.includes("🤖 **Argus** · 已接受 1 項，剩 0 項，結論更新為：**可合併**"), h.c.notes.join("\n"));
  assert.deepEqual(h.c.approves, ["2".repeat(40)], "approves the head the latest round reviewed, never the stale one");
});

test("verdict note failure: accept kept unannounced, redone once next cycle, then never again", async () => {
  const h = harness();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  h.say("/argus accept ok", 1, h.thread().id);
  h.failVerdictNote(1);
  h.reset();
  await h.poll();
  assert.equal(h.c.replies.length, 1);
  assert.deepEqual([h.c.notes.length, h.c.approves.length], [0, 0]);
  assert.deepEqual(announced(h.db), [0]);
  await h.poll();
  const verdictNotes = () => h.c.notes.filter((n) => n.includes("結論更新為"));
  assert.deepEqual(verdictNotes(), ["🤖 **Argus** · 已接受 1 項，剩 0 項，結論更新為：**可合併**"]);
  assert.equal(h.c.approves.length, 1);
  assert.deepEqual(announced(h.db), [1]);
  await h.poll();
  acceptWatch.clear();
  await h.poll();
  assert.deepEqual([verdictNotes().length, h.c.replies.length, h.c.approves.length], [1, 1, 1]);
});

test("crash after the accept was recorded: the next cycle announces it (no reply repeated)", async () => {
  const h = harness();
  const a = f();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  const nid = h.say("/argus accept ok", 1, h.thread().id);
  handleNote(h.db, { ownerId: 1, noteId: nid, dryRun: false }, { mrId: 100, sentinel: fp(a), reason: "ok", by: 1 }); // then the process died
  h.reset();
  await h.poll();
  assert.deepEqual(h.c.replies, []);
  assert.deepEqual(h.c.notes.filter((n) => n.includes("結論更新為")), ["🤖 **Argus** · 已接受 1 項，剩 0 項，結論更新為：**可合併**"]);
  assert.equal(h.c.approves.length, 1);
});

test("a review round after an unannounced accept announces it: no late verdict note", async () => {
  const h = harness({ autoApprove: false });
  const a = f();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  const nid = h.say("/argus accept ok", 1, h.thread().id);
  handleNote(h.db, { ownerId: 1, noteId: nid, dryRun: false }, { mrId: 100, sentinel: fp(a), reason: "ok", by: 1 });
  await h.round("2".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  assert.deepEqual(announced(h.db), [1]);
  h.reset();
  await h.poll();
  assert.deepEqual(h.c.notes, []);
});

test("head pushed while the job waited: verdict note says so, no approve of the unreviewed head", async () => {
  const h = harness();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  h.say("/argus accept ok", 1, h.thread().id);
  h.setBeforeJob(async () => h.push("3".repeat(40)));
  h.reset();
  await h.poll();
  assert.ok(h.c.notes.includes("🤖 **Argus** · 已接受 1 項，剩 0 項，結論更新為：**可合併**（MR 已有新 commit，下一輪審查會沿用此裁決）"), h.c.notes.join("\n"));
  assert.deepEqual(h.c.approves, []);
});

test("migration: an accepted_findings table without announced gets the column, existing rows default to 0", () => {
  const path = join(mkdtempSync(join(tmpdir(), "accept-mig-")), "old.db");
  const old = new Database(path);
  old.exec(`CREATE TABLE accepted_findings (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, mr_id INTEGER NOT NULL, dry_run INTEGER NOT NULL,
    sentinel TEXT NOT NULL, reason TEXT NOT NULL, accepted_by INTEGER NOT NULL, note_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (owner_id, mr_id, sentinel, dry_run))`);
  old.prepare(`INSERT INTO accepted_findings (owner_id, mr_id, dry_run, sentinel, reason, accepted_by, note_id) VALUES (1, 100, 0, '0123456789ab', '', 1, 7)`).run();
  old.close();
  const db = openDb(path);
  const col = (db.prepare(`PRAGMA table_info(accepted_findings)`).all() as { name: string; dflt_value: string | null }[]).find((c) => c.name === "announced");
  assert.equal(col?.dflt_value, "0");
  assert.deepEqual(db.prepare(`SELECT announced FROM accepted_findings`).all(), [{ announced: 0 }]);
  db.close();
});

test("resolve failed at accept time: retried (resolve only, no second reply) by the next job and by the next round", async () => {
  const accepts = (h: ReturnType<typeof harness>) => h.c.replies.filter(([, b]) => b.includes("已接受")).length;
  // Next accept job (any new note on the MR).
  const j = harness();
  await j.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  const t = j.thread();
  j.say("/argus accept ok", 1, t.id);
  j.failResolve(1);
  j.reset();
  await j.poll();
  assert.deepEqual([j.c.resolves.length, accepts(j), j.accepted().length], [0, 1, 1]);
  j.say("謝謝", 2);
  await j.poll();
  assert.deepEqual([j.c.resolves, accepts(j)], [[t.id], 1]);

  // Next review round.
  const r = harness();
  const a = f();
  await r.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  const t2 = r.thread();
  r.say("/argus accept ok", 1, t2.id);
  r.failResolve(1);
  await r.poll();
  r.reset();
  await r.round("2".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  assert.deepEqual([r.c.resolves, accepts(r)], [[t2.id], 0]);
});

test("dry-run never resolves accepted threads", async () => {
  const h = harness({ dryRun: true });
  const a = f();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  h.ds.push({ id: "t", notes: [{ id: 77, body: inlineBody(a), author: { id: 1 }, resolvable: true, resolved: false, position: { new_path: "a.ts", new_line: 3 } }] });
  h.say("/argus accept ok", 1, "t");
  await h.poll();
  await h.round("2".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  assert.equal(h.accepted().length, 1);
  assert.deepEqual(h.c.resolves, []);
});

test("unannounced accept is retried even when the MR has no new activity", async () => {
  const h = harness();
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [f()], resolved: [] });
  h.say("/argus accept ok", 1, h.thread().id);
  h.failVerdictNote(2);
  await h.poll(); // accept + reply (changes the stamp); note fails
  await h.poll(); // stamp changed by our reply; note fails again
  h.reset();
  await h.poll(); // stamp unchanged: only the pending announcement brings it back
  assert.deepEqual(h.c.notes.filter((n) => n.includes("結論更新為")), ["🤖 **Argus** · 已接受 1 項，剩 0 項，結論更新為：**可合併**"]);
  assert.deepEqual(announced(h.db), [1]);
});

test("prompt tells the AI about accepted items (file, line, severity, title, reason) and not to re-report them", () => {
  const base = { cwd: "/x", mrTitle: "t", mrDescription: "", diff: "+x", incremental: false, language: "zh-TW" };
  assert.doesNotMatch(buildPrompt(base), /ACCEPTED/);
  const p = buildPrompt({ ...base, accepted: [{ id: "0123456789ab", file: "src/db.ts", line: 12, severity: "major", title: "SQL injection：username 直接插入 SQL 字串", reason: "內部工具，輸入受控" }] });
  assert.match(p, /Issues the human reviewer has ACCEPTED as-is .* Do NOT report any of them again, under any title, wording or severity\. Report something at the same place only if the code there changed and now has a NEW, different problem/);
  assert.ok(p.includes("- src/db.ts:12 [major]: SQL injection：username 直接插入 SQL 字串 (reason: 內部工具，輸入受控)"), p);
});

test("next round: the engine receives the accepted items with their details (stored findings and legacy threads)", async () => {
  const h = harness({ autoApprove: false });
  const a = f({ title: "inline one", line: 7, severity: "blocker" });
  const s2 = f({ title: "summary one", line: undefined, severity: "minor", file: "b.ts" });
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a, s2], resolved: [] });
  h.say("/argus accept 預期行為", 1, h.thread().id);
  h.say(`/argus accept #${fp(s2).slice(0, 6)} 另案處理`);
  await h.poll();
  await h.round("2".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  assert.deepEqual(h.inputs.at(-1)!.accepted, [
    { id: fp(a), file: "a.ts", line: 7, title: "inline one", severity: "blocker", reason: "預期行為" },
    { id: fp(s2), file: "b.ts", line: undefined, title: "summary one", severity: "minor", reason: "另案處理" },
  ]);

  // Legacy: the row holds no findings for the id; details come from our thread on GitLab.
  const l = harness({ autoApprove: false });
  const old = f({ title: "from an old round", line: 9, severity: "major" });
  l.db.prepare(`INSERT INTO reviews (owner_id, project_id, mr_id, mr_iid, head_sha, dry_run, status, findings_json) VALUES (1, 7, 100, 5, ?, 0, 'done', ?)`)
    .run("1".repeat(40), JSON.stringify({ findings: [], verdict: "approve", summaryOpen: [] }));
  l.ds.push({ id: "old", notes: [{ id: 42, body: inlineBody(old), author: { id: 1 }, resolvable: true, resolved: false, position: { new_path: "a.ts", new_line: 9 } }] });
  l.say("/argus accept ok", 1, "old");
  await l.poll();
  await l.round("2".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  assert.deepEqual(l.inputs.at(-1)!.accepted, [{ id: fp(old), file: "a.ts", line: 9, title: "from an old round", severity: "major", reason: "ok" }]);
});

test("accept command replied under another discussion: that discussion is not resolved", async () => {
  const h = harness();
  const a = f({ line: undefined });
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  const summary = h.ds.find((d) => d.notes[0]!.body.includes("第 1 輪"))!;
  h.say(`/argus accept #${fp(a).slice(0, 6)} ok`, 1, summary.id);
  h.reset();
  await h.poll();
  assert.equal(h.accepted().length, 1);
  assert.deepEqual(h.c.resolves, []);
});

test("a non-resolvable top-level command note is accepted but never resolved", async () => {
  const h = harness();
  const a = f({ line: undefined, title: "summary-only" });
  await h.round("1".repeat(40), { verdict: "request_changes", findings: [a], resolved: [] });
  h.say(`/argus accept #${fp(a).slice(0, 6)} plain comment`, 1, undefined, true);
  h.reset();
  await h.poll();
  assert.deepEqual(h.accepted().map((r) => r.sentinel), [fp(a)]);
  assert.deepEqual(h.c.resolves, [], "plain notes cannot be resolved; no doomed API call");
});
