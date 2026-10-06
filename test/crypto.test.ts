import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "../src/crypto.ts";

const key = randomBytes(32);

test("encryption round-trips and is randomized", () => {
  const a = encrypt(key, "glpat-secret");
  assert.equal(decrypt(key, a), "glpat-secret");
  assert.notDeepEqual(a, encrypt(key, "glpat-secret"));
  assert.ok(!a.includes("glpat-secret"));
});

test("tampering with iv, tag or ciphertext is detected", () => {
  const blob = encrypt(key, "glpat-secret");
  for (const i of [0, 12, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[i] = bad[i]! ^ 1;
    assert.throws(() => decrypt(key, bad), /decryption failed/);
  }
  assert.throws(() => decrypt(key, blob.subarray(0, 10)), /too short/);
});

test("wrong key fails", () => {
  assert.throws(() => decrypt(randomBytes(32), encrypt(key, "x")), /decryption failed/);
});
