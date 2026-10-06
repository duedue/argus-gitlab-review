import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { carriedSummaryItems, nextRound, openDb } from "../src/db.ts";
import { OUTPUT_CONTRACT, languageInstruction, type ReviewEngine, type ReviewInput } from "../src/engine.ts";
import { deriveVerdict, parseReview, type Finding } from "../src/findings.ts";
import type { GitLab, MrSummary } from "../src/gitlab.ts";
import { fp, summaryBody, type SummaryCtx } from "../src/publisher.ts";
import { parseHeadSha, reviewMr, type UserRuntime } from "../src/review.ts";
import { addUser, getUser } from "../src/users.ts";

const f = (o: Partial<Finding> = {}): Finding => ({ severity: "minor", file: "a.ts", line: 3, title: "t", body: "BODY", confidence: 0.9, ...o });
const ctx = (o: Partial<SummaryCtx> = {}): SummaryCtx => ({ round: 1, sha: "0123456789abcdef", language: "zh-TW", verdict: "request_changes", checked: [], ...o });

test("schema: new fields optional, malformed ones dropped; derived verdict", () => {
  const bare = parseReview('{"findings":[]}');
  assert.equal(bare.verdict, undefined);
  assert.equal(bare.summary, undefined);
  assert.equal(bare.checked, undefined);
  const full = parseReview('{"verdict":"needs_discussion","summary":"s","checked":["x"],"findings":[]}');
  assert.deepEqual([full.verdict, full.summary, full.checked], ["needs_discussion", "s", ["x"]]);
  assert.equal(parseReview('{"verdict":"lgtm","checked":"nope","findings":[]}').verdict, undefined);
  assert.equal(deriveVerdict([f({ severity: "major" })]), "request_changes");
  assert.equal(deriveVerdict([f({ severity: "blocker" })]), "request_changes");
  assert.equal(deriveVerdict([f({ severity: "minor" }), f({ severity: "nit" })]), "approve");
  assert.equal(deriveVerdict([]), "approve");
});

test("summary: full bodies below threshold, severity grouping, inline refs, checked, header (zh)", () => {
  const major = f({ severity: "major", title: "M", body: "major body" });
  const minor = f({ severity: "minor", title: "m", body: "minor body" });
  const nit = f({ severity: "nit", title: "n", body: "nit body" });
  const inl = f({ severity: "blocker", title: "B", line: 9 });
  const out = summaryBody([inl], [minor, nit, major], ctx({ summary: "overall", checked: ["ok1"] }));
  assert.ok(out.startsWith("🤖 **Argus** · 第 1 輪 (`01234567`) · **建議修改**"));
  assert.match(out, /overall/);
  assert.ok(out.indexOf("**blocker**") < out.indexOf("**major**") && out.indexOf("**major**") < out.indexOf("**minor**"));
  assert.match(out, /\*\*blocker\*\* `#[0-9a-f]{6}` `a.ts:9` B \(見 inline\)/);
  assert.doesNotMatch(out, /BODY/); // inline body is not repeated
  assert.match(out, /major body/);
  assert.match(out, /minor body/);
  assert.match(out, /<details><summary><b>nit<\/b> <code>#[0-9a-f]{6}<\/code> `a.ts:3` n<\/summary>[\s\S]*nit body/);
  assert.match(out, new RegExp(`sentinel:${fp(major)}`));
  assert.match(out, /### 已確認正確\n\n- ok1/);
  assert.doesNotMatch(out, /輪次追蹤/); // round 1
});

test("summary: english labels and verdicts", () => {
  const out = summaryBody([], [], ctx({ language: "en", verdict: "approve", round: 2, checked: ["c"], track: { prev: [{ id: "a".repeat(12), file: "x.ts", title: "old" }], fixed: new Set(["a".repeat(12)]) } }), undefined, 0);
  assert.ok(out.startsWith("🤖 **Argus** · Round 2 (`01234567`) · **Approve**"));
  assert.match(out, /No issues found/);
  assert.match(out, /Checked and correct/);
  assert.match(out, /Previous round: 1 item\(s\): 1 fixed, 0 still open\n- ✅ old/);
  assert.match(out, /0 new item\(s\) this round/);
  assert.match(summaryBody([], [], ctx({ verdict: "needs_discussion" })), /\*\*需討論\*\*/);
  assert.match(summaryBody([], [], ctx({ verdict: "approve" })), /\*\*可合併\*\*/);
});

test("contract carries the calibration rubric and new schema", () => {
  for (const t of ["blocker: must fix before merge", "EVEN IF currently latent", "Confidence = how sure you are", "NOT the impact", "Critical->blocker", "High/Medium->major", "Nit/Style/Info->nit", '"verdict"', '"checked"'])
    assert.ok(OUTPUT_CONTRACT.includes(t), t);
  assert.match(languageInstruction("en"), /"summary"/);
});

test("parseHeadSha validates a full 40-hex sha", () => {
  assert.equal(parseHeadSha("A".repeat(40)), "a".repeat(40));
  for (const bad of [undefined, "", "abc1234", "g".repeat(40), "a".repeat(41), "--user"]) assert.throws(() => parseHeadSha(bad as string));
});

// --- multi-round flow through reviewMr ---
const key = randomBytes(32);
const skillDir = mkdtempSync(join(tmpdir(), "skill-"));
writeFileSync(join(skillDir, "SKILL.md"), "x");

function harness() {
  const db = openDb(":memory:");
  addUser(db, key, { gitlabUserId: 1, username: "alice", token: "t", tokenExpiresAt: null, skillPath: join(skillDir, "SKILL.md"), isOwner: true });
  const user = getUser(db, "alice")!;
  let sha = "a".repeat(40);
  let discussions: unknown[] = [];
  const base: MrSummary = { id: 100, iid: 5, project_id: 7, title: "t", description: "", sha, web_url: "u", target_branch: "main" };
  const gl = {
    getMr: async () => ({ ...base, sha, diff_refs: { base_sha: "b", start_sha: "b", head_sha: sha } }),
    getProject: async () => ({ id: 7, http_url_to_repo: "x", path_with_namespace: "g/p" }),
    listDiscussions: async () => discussions,
    postNote: async () => assert.fail("dry-run"),
    postDiscussion: async () => assert.fail("dry-run"),
  } as unknown as GitLab;
  const prepare = async () => ({ dir: "/nonexistent", diff: "+x\n", lines: 1, files: ["a.ts"], incremental: false });
  const seen: ReviewInput[] = [];
  let next: Awaited<ReturnType<ReviewEngine["review"]>> = { findings: [], resolved: [] };
  const engine: ReviewEngine = { review: async (i) => (seen.push(i), next) };
  const rt: UserRuntime = { token: async () => "t", gl, engine, prepare };
  const cfg = { ...loadConfig({}), dryRun: true };
  return {
    db, seen,
    setDiscussions: (d: unknown[]) => (discussions = d),
    async round(newSha: string, res: typeof next, opts: { head?: string } = {}) {
      sha = newSha;
      next = res;
      const out: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => void out.push(a.join(" "));
      try {
        await reviewMr(cfg, db, user, rt, { ...base, sha }, opts.head);
      } finally {
        console.log = log;
      }
      return out.join("\n");
    },
  };
}

test("always posts a summary, even with 0 findings (verdict derived, checked shown)", async () => {
  const h = harness();
  const out = await h.round("1".repeat(40), { findings: [], resolved: [], checked: ["looked at X"] });
  assert.match(out, /would post summary note/);
  assert.match(out, /第 1 輪 \(`11111111`\) · \*\*可合併\*\*/);
  assert.match(out, /looked at X/);
  assert.match(out, /verdict derived/);
});

test("round tracking: summary-only items are passed back, reported fixed, persisted, not re-listed", async () => {
  const h = harness();
  const low = f({ title: "latent bug", confidence: 0.6, body: "full analysis" });
  const r1 = await h.round("1".repeat(40), { verdict: "request_changes", summary: "s", findings: [low], resolved: [] });
  assert.match(r1, /full analysis/); // below threshold but body visible
  assert.equal(h.seen[0]!.openThreads?.length, 0);
  assert.deepEqual(carriedSummaryItems(h.db, 1, 100, true).map((t) => t.id), [fp(low)]);

  const added = f({ title: "new one", line: undefined });
  const r2 = await h.round("2".repeat(40), { findings: [added], resolved: [fp(low)] });
  assert.deepEqual(h.seen[1]!.openThreads?.map((t) => t.id), [fp(low)]);
  assert.match(r2, /第 2 輪/);
  assert.match(r2, /上一輪 1 項：已修正 1、仍存在 0\n- ✅ latent bug/);
  assert.match(r2, /本輪新增 1 項/);
  assert.equal(nextRound(h.db, 1, 100, true), 3);
  assert.deepEqual(carriedSummaryItems(h.db, 1, 100, true).map((t) => t.id), [fp(added)]); // fixed one is gone

  const r3 = await h.round("3".repeat(40), { findings: [], resolved: [] });
  assert.deepEqual(h.seen[2]!.openThreads?.map((t) => t.id), [fp(added)]); // not re-listing the fixed one
  assert.match(r3, /上一輪 1 項：已修正 0、仍存在 1\n- ⏳ new one/);
  assert.deepEqual(carriedSummaryItems(h.db, 1, 100, true).map((t) => t.id), [fp(added)]); // still carried
});

test("round tracking covers open inline threads too, and re-reported items are not new", async () => {
  const h = harness();
  const a = f({ title: "inline one" });
  h.setDiscussions([{ id: "d1", notes: [{ body: `🤖 **Argus** · **minor**: inline one\n\nb\n\n<!-- sentinel:${fp(a)} -->`, author: { id: 1 }, resolvable: true, resolved: false, position: { new_path: "a.ts", new_line: 3 } }] }]);
  await h.round("1".repeat(40), { findings: [], resolved: [] });
  const out = await h.round("2".repeat(40), { findings: [a], resolved: [] }); // re-reported => still open
  assert.deepEqual(h.seen[1]!.openThreads?.map((t) => t.id), [fp(a)]);
  assert.match(out, /已修正 0、仍存在 1/);
  assert.match(out, /本輪新增 0 項/);
});

test("--head: pins the reviewed sha, leaves no review history, can be re-run, and is dry-run only", async () => {
  const h = harness();
  const head = "c".repeat(40);
  const out = await h.round("1".repeat(40), { findings: [], resolved: [] }, { head });
  assert.match(out, /\(`cccccccc`\)/);
  assert.equal((h.db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
  assert.match(await h.round("1".repeat(40), { findings: [], resolved: [] }, { head }), /\(`cccccccc`\)/); // not deduped
  assert.equal(h.seen.at(-1)!.incremental, false);
  // live mode refuses the override
  const db = openDb(":memory:");
  const err = console.error;
  console.error = () => {};
  try {
    await reviewMr({ ...loadConfig({}), dryRun: false }, db, {} as never, {} as never, {} as never, head);
  } finally {
    console.error = err;
  }
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM reviews`).get() as { n: number }).n, 0);
});

test("contract treats unjustified requirement deviations as a product question", async () => {
  const { OUTPUT_CONTRACT } = await import("../src/engine.ts");
  assert.match(OUTPUT_CONTRACT, /deliberate deviation from the linked requirements/);
  assert.match(OUTPUT_CONTRACT, /"needs_discussion" if it is the\s+only reason not to approve/);
});

test("dry-run carries 'inline' findings to the next round (no GitLab thread exists to track them)", async () => {
  const h = harness();
  const f = { severity: "major" as const, file: "a.ts", line: 3, title: "bug", body: "b", confidence: 0.9 };
  await h.round("1".repeat(40), { findings: [f], resolved: [] });
  await h.round("2".repeat(40), { findings: [], resolved: [] });
  assert.deepEqual(h.seen.at(-1)!.openThreads!.map((t) => t.title), ["bug"]);
});

test("too-large note states the numbers and links the MR author guide", async () => {
  const { tooLargeNote } = await import("../src/review.ts");
  const n = tooLargeNote(4623, 2000, "http://argus.test");
  assert.match(n, /4623 行/);
  assert.match(n, /2000 行/);
  assert.ok(n.includes("(http://argus.test/docs/mr)"));
});
