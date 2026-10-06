import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mayApprove, type ApproveInput } from "../src/approve.ts";
import { loadConfig } from "../src/config.ts";
import { activeAutoApproval, openDb } from "../src/db.ts";
import type { ReviewEngine } from "../src/engine.ts";
import type { Finding } from "../src/findings.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { fp } from "../src/publisher.ts";
import { reviewMr, type UserRuntime } from "../src/review.ts";
import { addUser, getUser, setUser } from "../src/users.ts";

const f = (o: Partial<Finding> = {}): Finding => ({ severity: "minor", file: "a.ts", line: 3, title: "t", body: "B", confidence: 0.9, ...o });

const clean: ApproveInput = { autoApprove: true, dryRun: false, replay: false, selfReview: false, verdict: "approve", findings: [], unfixedPrev: 0, authorId: 2, userId: 1 };

test("approve condition matrix: every failing condition blocks, nits allowed", () => {
  assert.equal(mayApprove(clean), true);
  assert.equal(mayApprove({ ...clean, findings: [{ severity: "nit" }, { severity: "nit" }] }), true);
  const blocked: Partial<ApproveInput>[] = [
    { autoApprove: false }, { dryRun: true }, { replay: true }, { selfReview: true },
    { verdict: "request_changes" }, { verdict: "needs_discussion" },
    { findings: [{ severity: "minor" }] }, { findings: [{ severity: "major" }] }, { findings: [{ severity: "nit" }, { severity: "blocker" }] },
    { unfixedPrev: 1 }, { authorId: 1 }, { authorId: undefined },
  ];
  for (const b of blocked) assert.equal(mayApprove({ ...clean, ...b }), false, JSON.stringify(b));
});

const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");

function live(o: { language?: string; authorId?: number; autoApprove?: boolean; dryRun?: boolean; resetOnPush?: boolean; fail?: "approve" | "approvals" | "note" | "settings" } = {}) {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: true });
  setUser(db, "alice", [`auto_approve=${o.autoApprove === false ? 0 : 1}`, `language=${o.language ?? "zh-TW"}`]);
  const user = getUser(db, "alice")!;
  let sha = "a".repeat(40);
  let humanApproved = false; // GitLab's user_has_approved
  let discussions: unknown[] = [];
  const calls: string[] = [];
  const notes: string[] = [];
  const base: MrSummary = { id: 100, iid: 5, project_id: 7, title: "t", description: "", sha, web_url: "u", target_branch: "main" };
  const boom = (n: string) => { throw new Error(`${n} failed 409`); };
  const gl = {
    getMr: async () => ({ ...base, sha, author: { id: o.authorId ?? 2 }, diff_refs: { base_sha: "b", start_sha: "b", head_sha: sha } }),
    getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => discussions,
    postNote: async (_p: number, _i: number, body: string) => { if (o.fail === "note" && body.includes("自動 approve")) boom("note"); notes.push(body); },
    postDiscussion: async () => {},
    resetsApprovalsOnPush: async () => { if (o.fail === "settings") boom("settings"); return o.resetOnPush === true; },
    userHasApproved: async () => { if (o.fail === "approvals") boom("approvals"); return humanApproved; },
    approveMr: async (_p: number, _i: number, s: string) => { if (o.fail === "approve") boom("approve"); calls.push(`approve@${s}`); humanApproved = true; },
    unapproveMr: async () => { if (o.fail === "approvals") boom("unapprove"); calls.push("unapprove"); humanApproved = false; },
  } as unknown as GitLab;
  const prepare = async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });
  let next: Awaited<ReturnType<ReviewEngine["review"]>> = { findings: [], resolved: [] };
  const rt: UserRuntime = { token: async () => "t", gl, engine: { review: async () => next }, prepare };
  const cfg = { ...loadConfig({}), dryRun: o.dryRun ?? false };
  return {
    db, calls, notes,
    setDiscussions: (d: unknown[]) => (discussions = d),
    setHuman: (v: boolean) => (humanApproved = v),
    async round(newSha: string, res: typeof next, head?: string, selfReview = false) {
      sha = newSha;
      next = res;
      const warn = console.warn, log = console.log;
      console.warn = console.log = () => {};
      try { await reviewMr(cfg, db, user, rt, { ...base, sha }, head, { selfReview }); } finally { console.warn = warn; console.log = log; }
    },
  };
}

test("clean round approves with the reviewed sha, records it and posts a zh note", async () => {
  const h = live();
  await h.round("1".repeat(40), { verdict: "approve", findings: [f({ severity: "nit" })], resolved: [] });
  assert.deepEqual(h.calls, [`approve@${"1".repeat(40)}`]);
  assert.ok(activeAutoApproval(h.db, 1, 100));
  assert.ok(h.notes.some((n) => n === "🤖 **Argus** · 自動 approve（第 1 輪 `11111111`，無 minor 以上問題）"));
});

test("english note when language is not zh", async () => {
  const h = live({ language: "en" });
  await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  assert.ok(h.notes.some((n) => n.startsWith("🤖 **Argus** · Auto-approved (round 1 `11111111`")));
});

test("never approves: opt-out, dry-run, author == user, minor finding, verdict not approve", async () => {
  for (const [o, res] of [
    [{ autoApprove: false }, { verdict: "approve" as const, findings: [] }],
    [{ dryRun: true }, { verdict: "approve" as const, findings: [] }],
    [{ authorId: 1 }, { verdict: "approve" as const, findings: [] }],
    [{}, { verdict: "approve" as const, findings: [f()] }],
    [{}, { verdict: "request_changes" as const, findings: [] }],
  ] as const) {
    const h = live(o);
    await h.round("1".repeat(40), { ...res, findings: [...res.findings], resolved: [] });
    assert.deepEqual(h.calls, [], JSON.stringify(o));
    assert.equal(activeAutoApproval(h.db, 1, 100), undefined);
  }
});

test("--head replay never approves", async () => {
  const h = live({ dryRun: true });
  await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] }, "c".repeat(40));
  assert.deepEqual(h.calls, []);
});

test("unfixed previous item blocks approval; fixed one allows it", async () => {
  const h = live();
  const old = f({ severity: "nit", title: "old", line: undefined });
  await h.round("1".repeat(40), { verdict: "approve", findings: [old], resolved: [] }); // nit only: approved in round 1
  assert.equal(h.calls.length, 1);
  await h.round("2".repeat(40), { verdict: "approve", findings: [], resolved: [] }); // old still open, approval kept
  assert.deepEqual(h.calls, [`approve@${"1".repeat(40)}`, "unapprove"]);
  assert.match(h.notes.at(-1)!, /撤回自動 approve（第 2 輪：上一輪仍有 1 項未修正）/);
  await h.round("3".repeat(40), { verdict: "approve", findings: [], resolved: [fp(old)] }); // fixed now -> approve again
  assert.equal(h.calls.at(-1), `approve@${"3".repeat(40)}`);
});

test("revokes our approval on findings >= minor, and on verdict change", async () => {
  const h = live();
  await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  await h.round("2".repeat(40), { verdict: "approve", findings: [], resolved: [] }); // still clean: kept, no extra calls
  assert.deepEqual(h.calls, [`approve@${"1".repeat(40)}`]);
  await h.round("3".repeat(40), { verdict: "request_changes", findings: [f({ severity: "major", title: "x" })], resolved: [] });
  assert.equal(h.calls.at(-1), "unapprove");
  assert.equal(activeAutoApproval(h.db, 1, 100), undefined);
  assert.match(h.notes.at(-1)!, /撤回自動 approve（第 3 輪：結論為 request_changes、本輪有 1 項 minor 以上問題）/);

  const g = live();
  await g.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  await g.round("2".repeat(40), { verdict: "needs_discussion", findings: [], resolved: [] });
  assert.equal(g.calls.at(-1), "unapprove");
});

test("a human's manual approval is neither re-made nor revoked", async () => {
  const h = live();
  h.setHuman(true);
  await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  assert.deepEqual(h.calls, []);
  assert.equal(activeAutoApproval(h.db, 1, 100), undefined);
  await h.round("2".repeat(40), { verdict: "request_changes", findings: [f({ severity: "major" })], resolved: [] });
  assert.deepEqual(h.calls, []); // no Argus row => no unapprove
});

test("a human removing our approval is respected (row closed, no unapprove, no note)", async () => {
  const h = live();
  await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] });
  h.setHuman(false);
  const n = h.notes.length;
  await h.round("2".repeat(40), { verdict: "request_changes", findings: [f({ severity: "major" })], resolved: [] });
  assert.deepEqual(h.calls, [`approve@${"1".repeat(40)}`]);
  assert.equal(h.notes.length, n + 1); // only the round summary
  assert.equal(activeAutoApproval(h.db, 1, 100), undefined);
});

test("GitLab failures never fail the review and nothing is tracked", async () => {
  for (const fail of ["approve", "approvals", "note"] as const) {
    const h = live({ fail });
    await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] });
    const row = h.db.prepare(`SELECT status FROM reviews`).get() as { status: string };
    assert.equal(row.status, "done");
    assert.equal(!!activeAutoApproval(h.db, 1, 100), fail === "note"); // approval went through; only its note failed
  }
});

test("self-review never approves, even when the MR author is a bot (e.g. codex) rather than the user", async () => {
  const h = live({ authorId: 999 });
  await h.round("1".repeat(40), { verdict: "approve", findings: [], resolved: [] }, undefined, true);
  assert.deepEqual(h.calls, []);
  assert.equal(h.notes.some((n) => n.includes("自動 approve")), false);
});

test("approval reset by a push (project resets on push, new head): a clean round re-approves the new head", async () => {
  const h = live({ resetOnPush: true });
  const clean = { verdict: "approve" as const, findings: [], resolved: [] };
  await h.round("1".repeat(40), clean);
  h.setHuman(false); // project resets approvals on push
  await h.round("2".repeat(40), clean);
  assert.deepEqual(h.calls, [`approve@${"1".repeat(40)}`, `approve@${"2".repeat(40)}`]);
  assert.equal((h.db.prepare(`SELECT revoked_by FROM auto_approvals ORDER BY id LIMIT 1`).get() as { revoked_by: string }).revoked_by, "push");
});

test("approval removed by a human (project does not reset on push): Argus never auto-approves this MR again", async () => {
  const h = live({ resetOnPush: false });
  const clean = { verdict: "approve" as const, findings: [], resolved: [] };
  await h.round("1".repeat(40), clean);
  h.setHuman(false); // a human unapproves; the next push triggers the next review
  await h.round("2".repeat(40), clean);
  await h.round("3".repeat(40), clean);
  assert.deepEqual(h.calls, [`approve@${"1".repeat(40)}`]);
  assert.equal((h.db.prepare(`SELECT revoked_by FROM auto_approvals`).get() as { revoked_by: string }).revoked_by, "human");
});

test("unreadable project approval settings: treated as a human revoke, never stuck active", async () => {
  const h = live({ resetOnPush: true, fail: "settings" });
  const clean = { verdict: "approve" as const, findings: [], resolved: [] };
  await h.round("1".repeat(40), clean);
  h.setHuman(false);
  await h.round("2".repeat(40), clean);
  assert.deepEqual(h.calls, [`approve@${"1".repeat(40)}`]);
  assert.equal((h.db.prepare(`SELECT revoked_by FROM auto_approvals`).get() as { revoked_by: string }).revoked_by, "human");
});
