import test from "node:test";
import assert from "node:assert/strict";
import { parseFindings, passesThreshold, type Finding } from "../src/findings.ts";
import { fp, plan } from "../src/publisher.ts";

const f = (o: Partial<Finding> = {}): Finding => ({ severity: "major", file: "a.ts", line: 3, title: "t", body: "b", confidence: 0.9, ...o });

test("parseFindings accepts plain, fenced and prose-wrapped JSON", () => {
  const json = JSON.stringify({ findings: [f()] });
  assert.equal(parseFindings(json).length, 1);
  assert.equal(parseFindings("```json\n" + json + "\n```").length, 1);
  assert.equal(parseFindings("Here you go: " + json + " done").length, 1);
  assert.deepEqual(parseFindings('{"findings":[]}'), []);
});

test("parseFindings rejects invalid output", () => {
  assert.throws(() => parseFindings("not json"));
  assert.throws(() => parseFindings(JSON.stringify({ findings: [f({ severity: "huge" as never })] })));
  assert.throws(() => parseFindings(JSON.stringify({ findings: [f({ confidence: 1.5 })] })));
  assert.throws(() => parseFindings(JSON.stringify({ findings: [f({ line: 0 })] })));
  assert.throws(() => parseFindings(JSON.stringify({ findings: [{ severity: "minor" }] })));
});

test("threshold: severity>=minor && confidence>=0.7", () => {
  assert.equal(passesThreshold(f({ severity: "nit" }), "minor", 0.7), false);
  assert.equal(passesThreshold(f({ severity: "minor", confidence: 0.69 }), "minor", 0.7), false);
  assert.equal(passesThreshold(f({ severity: "minor", confidence: 0.7 }), "minor", 0.7), true);
  assert.equal(passesThreshold(f({ severity: "blocker" }), "minor", 0.7), true);
});

test("plan: threshold only decides inline vs summary; nothing is hidden; already-posted is skipped", () => {
  const inline = f();
  const noLine = f({ title: "n", line: undefined });
  const low = f({ title: "l", confidence: 0.2 });
  const dup = f({ title: "d" });
  const p0 = plan([inline, noLine, low], { minSeverity: "minor", minConfidence: 0.7 }, new Set());
  assert.deepEqual([p0.inline, p0.summaryItems], [[inline], [noLine, low]]);
  // fingerprint (file+title) already posted -> dropped everywhere
  const p1 = plan([dup, inline], { minSeverity: "minor", minConfidence: 0.7 }, new Set([fp(dup)]));
  assert.deepEqual(p1.inline, [inline]);
  assert.deepEqual(p1.summaryItems, []);
});
