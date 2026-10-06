import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;
const KC_ARGS = ["-s", "argus", "-a", "master-key"];

/** AES-256-GCM. Layout: iv(12) | tag(16) | ciphertext. */
export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Throws on wrong key or any tampering (GCM auth failure). */
export function decrypt(key: Buffer, blob: Buffer): string {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_LEN));
  d.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
  try {
    return Buffer.concat([d.update(blob.subarray(IV_LEN + TAG_LEN)), d.final()]).toString("utf8");
  } catch {
    throw new Error("token decryption failed (wrong master key or corrupted data)");
  }
}

function parseKey(b64: string): Buffer {
  const k = Buffer.from(b64.trim(), "base64");
  if (k.length !== 32) throw new Error("master key must be base64 of exactly 32 bytes");
  return k;
}

function keychainRead(): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", ...KC_ARGS, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return undefined; // not found / not macOS
  }
}

/** macOS Keychain first, then env ARGUS_MASTER_KEY (Docker secret later). Fail closed. */
export function getMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = keychainRead() ?? env.ARGUS_MASTER_KEY;
  if (!raw) throw new Error("no master key: run `key init` (macOS Keychain) or set ARGUS_MASTER_KEY");
  return parseKey(raw);
}

/** Generate + store a key in the Keychain if absent. Never prints the key. Returns true if created. */
export function keyInit(): boolean {
  if (keychainRead() !== undefined) return false;
  if (process.platform !== "darwin") throw new Error("Keychain is macOS-only; set ARGUS_MASTER_KEY (base64 32 bytes) instead");
  const key = randomBytes(32).toString("base64");
  // `security -i` reads the command from stdin so the key never appears in argv / `ps`.
  execFileSync("security", ["-i"], { input: `add-generic-password ${KC_ARGS.join(" ")} -w ${key}\n`, stdio: ["pipe", "ignore", "ignore"] });
  if (keychainRead()?.trim() !== key) throw new Error("failed to store master key in Keychain");
  return true;
}
