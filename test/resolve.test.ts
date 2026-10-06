import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview, type Finding } from "../src/findings.ts";
import { MARKER, fp, inlineBody, openAiThreads, threadsToResolve } from "../src/publisher.ts";
import type { Discussion } from "../src/gitlab.ts";

const f = (o: Partial<Finding> = {}): Finding => ({ severity: "minor", file: "a.ts", line: 3, title: "bug", body: "b", confidence: 0.9, ...o });
const thread = (id: string, finding: Finding, note: Partial<Discussion["notes"][0]> = {}): Discussion => ({
  id,
  notes: [{ body: inlineBody(finding), author: { id: 1 }, resolvable: true, resolved: false, position: { new_path: finding.file, new_line: finding.line }, ...note }],
});

test("parseReview defaults resolved to [] and rejects malformed ids", () => {
  assert.deepEqual(parseReview('{"findings":[]}'), { findings: [], resolved: [] });
  assert.deepEqual(parseReview('{"findings":[],"resolved":["0123456789ab"]}').resolved, ["0123456789ab"]);
  assert.throws(() => parseReview('{"findings":[],"resolved":["../etc"]}'));
});

test("openAiThreads only returns our own unresolved resolvable marker threads", () => {
  const a = f({ title: "mine" });
  const ds: Discussion[] = [
    thread("d1", a),
    thread("d2", f({ title: "other author" }), { author: { id: 2 } }),
    thread("d3", f({ title: "already resolved" }), { resolved: true }),
    thread("d4", f({ title: "summary" }), { resolvable: false }),
    { id: "d5", notes: [{ body: "human comment <!-- sentinel:0123456789ab -->", author: { id: 1 }, resolvable: true, resolved: false }] },
  ];
  assert.deepEqual(openAiThreads(ds, 1), [{ discussionId: "d1", id: fp(a), file: "a.ts", line: 3, title: "mine" }]);
  assert.ok(inlineBody(a).startsWith(MARKER));
});

test("threadsToResolve: only agent-claimed ids among our threads, never ones re-reported this round", () => {
  const a = f({ title: "fixed" });
  const b = f({ title: "still there" });
  const threads = openAiThreads([thread("d1", a), thread("d2", b)], 1);
  const out = threadsToResolve(threads, [fp(a), fp(b), "ffffffffffff"], [b]);
  assert.deepEqual(out.map((t) => t.discussionId), ["d1"]);
});

test("resolveThreads is best-effort: one failing thread doesn't throw, others still resolve", async () => {
  const { resolveThreads } = await import("../src/publisher.ts");
  const calls: string[] = [];
  const gl = {
    resolveDiscussion: async (_p: number, _i: number, id: string) => {
      if (id === "bad") throw new Error("502");
      calls.push(`resolve:${id}`);
    },
    replyDiscussion: async (_p: number, _i: number, id: string) => void calls.push(`reply:${id}`),
  } as never;
  const mr = { project_id: 1, iid: 1, sha: "abcdef0123", web_url: "u" } as never;
  const t = (discussionId: string) => ({ discussionId, id: "0123456789ab", file: "a.ts", title: "x" });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await resolveThreads(gl, mr, [t("bad"), t("ok")], { dryRun: false, language: "zh-TW" }), 1);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(calls, ["resolve:ok", "reply:ok"]);
});
