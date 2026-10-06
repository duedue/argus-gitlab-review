import { execFileSync } from "node:child_process";

export const PROJECT_CONTEXT_CAP = 16 * 1024;

export interface ProjectContext {
  text: string;
  file: string;
  modifiedByMr: boolean; // the MR changes this file: the base version is still the yardstick
}

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });

/** First `cap` (+3 for a UTF-8 tail) bytes of a git blob, without buffering a huge file. */
function readHead(dir: string, object: string, cap: number): Buffer {
  try {
    return execFileSync("git", ["-C", dir, "cat-file", "blob", object], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: cap + 3 });
  } catch (e) {
    const out = (e as { stdout?: Buffer }).stdout; // maxBuffer exceeded: keep what was read
    if ((e as { code?: string }).code === "ENOBUFS" && out) return out;
    throw e;
  }
}

/** `git diff --quiet` exits 1 when the file differs; any other failure is "unknown", treated as not modified. */
function differs(dir: string, baseSha: string, headSha: string, file: string): boolean {
  try {
    git(dir, ["diff", "--quiet", baseSha, headSha, "--", file]);
    return false;
  } catch (e) {
    return (e as { status?: number }).status === 1;
  }
}

/** Cut at most `cap` bytes without splitting a UTF-8 character. */
export function truncateUtf8(buf: Buffer, cap: number): Buffer {
  if (buf.length <= cap) return buf;
  let end = cap;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // step back over continuation bytes
  return buf.subarray(0, end);
}

/**
 * Project rules from the MR's TARGET (base) commit: repo-root CLAUDE.md, else AGENTS.md. The base version is the
 * yardstick so an MR can't rewrite the rules it is reviewed against. Read by code from git objects (never the working
 * tree) and passed as untrusted data; the agent's --setting-sources stays `user`. Only regular files (mode 100644/100755):
 * a symlink must not pull other content in. Never throws.
 */
export function readProjectContext(dir: string, baseSha: string, headSha: string, cap = PROJECT_CONTEXT_CAP): ProjectContext | undefined {
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const mode = git(dir, ["ls-tree", baseSha, "--", file]).toString().split(/\s/)[0];
      if (mode !== "100644" && mode !== "100755") continue;
      const size = Number(git(dir, ["cat-file", "-s", `${baseSha}:${file}`]).toString().trim());
      const text = truncateUtf8(readHead(dir, `${baseSha}:${file}`, cap), cap).toString("utf8").trim();
      if (!text) continue;
      return {
        text: size > cap ? `${text}\n\n[... truncated: ${file} is ${size} bytes, first ${Buffer.byteLength(text)} shown]` : text,
        file,
        modifiedByMr: differs(dir, baseSha, headSha, file),
      };
    } catch {
      continue; // absent or unreadable
    }
  }
  return undefined;
}
