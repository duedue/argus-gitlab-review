// Clone cleanup: idle / oversized / orphan removal, layout safety, best-effort errors, lane serialization.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { GitLab } from "../src/gitlab.ts";
import { ReviewQueue } from "../src/queue.ts";
import { cleanupDue, CLONE_CLEANUP_INTERVAL_MS, packBytes, pruneUserClones, resetCleanupThrottle } from "../src/repo.ts";
import { pollOnce } from "../src/review.ts";
import { addUser, getUserById, setUserEnabled } from "../src/users.ts";

const DAY = 86_400_000;
const mk = () => mkdtempSync(join(tmpdir(), "cleanup-"));
/** A clone dir whose stamp is `ageMs` old, with `packKb` KiB of pack data. */
function clone(data: string, uid: number, pid: number | string, ageMs: number, packKb = 0): string {
  const dir = join(data, "clones", `u${uid}`, String(pid));
  mkdirSync(join(dir, ".git", "objects", "pack"), { recursive: true });
  if (packKb) writeFileSync(join(dir, ".git", "objects", "pack", "a.pack"), Buffer.alloc(packKb * 1024));
  const f = join(dir, ".argus-last-used");
  writeFileSync(f, "");
  const t = new Date(Date.now() - ageMs);
  utimesSync(f, t, t);
  return dir;
}
const quiet = async <T>(fn: () => T | Promise<T>): Promise<{ out: string[]; err: string[] }> => {
  const out: string[] = [], err: string[] = [];
  const [l, e] = [console.log, console.error];
  console.log = (...a) => void out.push(a.join(" "));
  console.error = (...a) => void err.push(a.join(" "));
  try { await fn(); } finally { [console.log, console.error] = [l, e]; }
  return { out, err };
};

test("packBytes sums .git/objects/pack", () => {
  const d = clone(mk(), 1, 10, 0, 3);
  writeFileSync(join(d, ".git", "objects", "pack", "b.idx"), Buffer.alloc(1024));
  assert.equal(packBytes(d), 4096);
  assert.equal(packBytes(join(d, "nope")), 0);
});

test("prune: idle > 14 d removed, recent and small kept, log has reason and size", async () => {
  const data = mk();
  const old = clone(data, 7, 1, 15 * DAY, 2048);
  const fresh = clone(data, 7, 2, 13 * DAY, 10);
  const { out } = await quiet(() => pruneUserClones(data, 7));
  assert.ok(!existsSync(old));
  assert.ok(existsSync(fresh));
  assert.equal(out.filter((l) => l.includes("removed")).length, 1);
  assert.match(out.join("\n"), /idle 15 d.*2 MiB/);
});

test("prune: oversized pack removed even when recent (injected threshold / fake size)", async () => {
  const data = mk();
  const big = clone(data, 7, 1, 0, 600);
  const small = clone(data, 7, 2, 0, 100);
  const { out } = await quiet(() => pruneUserClones(data, 7, { maxPackBytes: 500 * 1024 }));
  assert.ok(!existsSync(big));
  assert.ok(existsSync(small));
  assert.match(out.join("\n"), /pack size over limit/);
  await quiet(() => pruneUserClones(data, 7, { size: () => 2 * 1024 ** 3 }));
  assert.ok(!existsSync(small));
});

test("prune: a clone without a stamp is stamped, not deleted", async () => {
  const data = mk();
  const dir = join(data, "clones", "u7", "5");
  mkdirSync(join(dir, ".git"), { recursive: true });
  await quiet(() => pruneUserClones(data, 7));
  assert.ok(existsSync(dir));
  assert.ok(existsSync(join(dir, ".argus-last-used")));
});

test("prune: unknown layout is ignored and logged", async () => {
  const data = mk();
  const odd = join(data, "clones", "u7", "legacy-x");
  mkdirSync(odd, { recursive: true });
  const { out } = await quiet(() => pruneUserClones(data, 7, { maxIdleMs: -1, maxPackBytes: -1 }));
  assert.ok(existsSync(odd));
  assert.match(out.join("\n"), /ignoring unknown entry/);
});

test("prune: errors are swallowed", async () => {
  const data = mk();
  clone(data, 7, 1, 0);
  const { err } = await quiet(() => pruneUserClones(data, 7, { size: () => { throw new Error("boom"); } }));
  assert.match(err.join("\n"), /boom/);
  await quiet(() => pruneUserClones(join(data, "missing"), 7)); // no clones dir: no throw
});

test("throttle: once per hour per key", () => {
  resetCleanupThrottle();
  assert.ok(cleanupDue("a", 1000));
  assert.ok(!cleanupDue("a", 1000 + CLONE_CLEANUP_INTERVAL_MS - 1));
  assert.ok(cleanupDue("a", 1000 + CLONE_CLEANUP_INTERVAL_MS));
  assert.ok(cleanupDue("b", 1000));
});

const key = randomBytes(32);
function setup(ids: number[]) {
  const data = mk();
  const db = openDb(":memory:");
  const skillPath = join(mk(), "SKILL.md");
  writeFileSync(skillPath, "S");
  for (const id of ids) addUser(db, key, { gitlabUserId: id, username: `u${id}`, token: "t", tokenExpiresAt: null, skillPath, isOwner: false });
  const cfg = { ...loadConfig({ DATA_DIR: data }), dryRun: true };
  const users = ids.map((id) => getUserById(db, id)!);
  const rt = () => ({ token: async () => "t", gl: { listReviewMrs: async () => [], listAssignedMrs: async () => [] } as unknown as GitLab });
  return { data, cfg, db, users, rt };
}

test("pollOnce: prunes idle clones of live users and removes orphan user dirs, leaves unknown entries", async () => {
  resetCleanupThrottle();
  const { data, cfg, db, users, rt } = setup([21]);
  const idle = clone(data, 21, 1, 20 * DAY);
  const orphan = clone(data, 99, 1, 0);
  const odd = join(data, "clones", "legacy");
  mkdirSync(odd, { recursive: true });
  await quiet(() => pollOnce(cfg, db, users, rt, new ReviewQueue(2)));
  assert.ok(!existsSync(idle));
  assert.ok(!existsSync(orphan));
  assert.ok(existsSync(odd));
  assert.ok(existsSync(join(data, "clones", "u21")));
});

test("pollOnce: cleanup waits for the user's running job in the same lane", async () => {
  resetCleanupThrottle();
  const { data, cfg, db, users, rt } = setup([22]);
  const idle = clone(data, 22, 1, 20 * DAY);
  const q = new ReviewQueue(2);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  q.enqueue(22, "busy", () => gate); // the user's review (no-engine user => lane = its GitLab id)
  const poll = quiet(() => pollOnce(cfg, db, users, rt, q));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(idle), "not deleted while the lane is busy");
  release();
  await poll;
  assert.ok(!existsSync(idle));
});

test("pollOnce: a DB user missing from the passed list (setup mode drops OAuth users) is not an orphan", async () => {
  resetCleanupThrottle();
  const { data, cfg, db, rt } = setup([31, 32]);
  const kept = clone(data, 31, 1, 0);
  const orphan = clone(data, 98, 1, 0);
  await quiet(() => pollOnce(cfg, db, [getUserById(db, 32)!], rt, new ReviewQueue(2)));
  assert.ok(existsSync(kept));
  assert.ok(!existsSync(orphan));
});

test("pollOnce: cleanup still runs when the user's poll fails early (expired token)", async () => {
  resetCleanupThrottle();
  const { data, cfg, db, rt } = setup([33]);
  db.prepare("UPDATE users SET token_expires_at='2000-01-01' WHERE gitlab_user_id=33").run();
  const idle = clone(data, 33, 1, 20 * DAY);
  const { err } = await quiet(() => pollOnce(cfg, db, [getUserById(db, 33)!], rt, new ReviewQueue(2)));
  assert.match(err.join("\n"), /token expired/);
  assert.ok(!existsSync(idle));
});

test("pollOnce: a disabled DB user's idle clone is pruned in its lane, fresh ones kept", async () => {
  resetCleanupThrottle();
  const { data, cfg, db, rt } = setup([34]);
  setUserEnabled(db, 34, false);
  const idle = clone(data, 34, 1, 20 * DAY);
  const fresh = clone(data, 34, 2, 0);
  await quiet(() => pollOnce(cfg, db, [getUserById(db, 34)!], rt, new ReviewQueue(2)));
  assert.ok(!existsSync(idle));
  assert.ok(existsSync(fresh));
});

test("pollOnce: a failing cleanup never breaks the cycle", async () => {
  resetCleanupThrottle();
  const { data, cfg, db, users, rt } = setup([23]);
  mkdirSync(join(data, "clones"), { recursive: true });
  writeFileSync(join(data, "clones", "u23"), "x"); // a file where the user dir should be: readdir fails with ENOTDIR
  const { err } = await quiet(() => pollOnce(cfg, db, users, rt, new ReviewQueue(2)));
  assert.match(err.join("\n"), /u23 failed/);
});
