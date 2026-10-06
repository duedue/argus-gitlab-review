import { execFile } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { isExcluded } from "./exclude.ts";

const run = promisify(execFile);

/**
 * Added + removed lines of a unified diff (what GitLab shows as +/-). Only lines inside hunks count: file headers
 * are skipped structurally, so content such as a removed `-- comment` (diffed as `--- comment`) is still counted.
 */
export function changedLines(diff: string): number {
  let n = 0;
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) inHunk = false;
    else if (l.startsWith("@@")) inHunk = true;
    else if (inHunk && (l[0] === "+" || l[0] === "-")) n++;
  }
  return n;
}

export interface PreparedDiff {
  dir: string;
  diff: string; // unified diff of non-excluded files
  lines: number;
  files: string[]; // non-excluded changed files
  incremental: boolean;
}

/**
 * Token is injected per command via GIT_CONFIG_* env (http.extraHeader): never written to .git/config,
 * never in argv (so not visible in `ps`). The fetch URL is passed explicitly and has no credentials.
 */
function gitEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`oauth2:${token}`).toString("base64");
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

async function git(dir: string, args: string[], token: string): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: dir, env: gitEnv(token), maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    // execFile errors embed argv+stderr; neither contains the token (it is only in env).
    throw new Error(`git ${args[0]} failed: ${(e as Error).message.slice(0, 400)}`);
  }
}

export const cloneDir = (dataDir: string, ownerId: number, projectId: number): string => join(dataDir, "clones", `u${ownerId}`, String(projectId));

export async function prepareDiff(opts: {
  dataDir: string;
  ownerId: number; // reviewer: each has its own clone, since reviews of different users run in parallel
  token: string;
  repoUrl: string; // http_url_to_repo, no credentials
  projectId: number;
  iid: number;
  baseSha: string;
  headSha: string;
  lastReviewedSha?: string;
  lastReviewedBaseSha?: string; // merge-base of that review; undefined (old rows) keeps the incremental diff
  excludeGlobs: string[];
}): Promise<PreparedDiff> {
  // The checkout is the agent's cwd for the whole review, so it must never be shared across queue lanes (= users).
  // One user's jobs are sequential, so one clone per (user, project) is never used by two reviews at once.
  const dir = cloneDir(opts.dataDir, opts.ownerId, opts.projectId);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, ["init", "-q"], opts.token);

  const fetch = (ref: string) => git(dir, ["fetch", "-q", "--depth=1", "--no-tags", opts.repoUrl, ref], opts.token);
  await fetch(`refs/merge-requests/${opts.iid}/head`);
  await fetch(opts.baseSha);
  // A pinned head (dev `--head`) may predate the MR ref's tip: fetch it by sha when missing.
  await git(dir, ["cat-file", "-e", `${opts.headSha}^{commit}`], opts.token).catch(() => fetch(opts.headSha));

  let from = opts.baseSha;
  let incremental = false;
  // A moved merge-base means the target branch was merged into the MR: lastReviewedSha..head would drag in the
  // target's commits, so review the whole MR diff (== GitLab "Changes") instead.
  const baseMoved = !!opts.lastReviewedBaseSha && opts.lastReviewedBaseSha !== opts.baseSha;
  if (baseMoved && opts.lastReviewedSha) console.log(`[repo] !${opts.iid} merge base moved since last review; reviewing the full MR diff`);
  if (opts.lastReviewedSha && opts.lastReviewedSha !== opts.headSha && !baseMoved) {
    try {
      await fetch(opts.lastReviewedSha);
      from = opts.lastReviewedSha;
      incremental = true;
    } catch {
      // last reviewed commit gone (force push / gc): fall back to full MR diff
    }
  }
  await git(dir, ["checkout", "-q", "--force", "--detach", opts.headSha], opts.token);

  const names = (await git(dir, ["diff", "--name-only", "-z", from, opts.headSha], opts.token))
    .split("\0")
    .filter(Boolean);
  const files = names.filter((f) => !isExcluded(f, opts.excludeGlobs));
  if (files.length === 0) return { dir, diff: "", lines: 0, files, incremental };
  // Pathspec also carries rename sources (listed only with --no-renames), so a moved file diffs as a rename
  // instead of a whole-file add.
  const paths = (await git(dir, ["diff", "--name-only", "--no-renames", "-z", from, opts.headSha], opts.token))
    .split("\0")
    .filter((f) => f && !isExcluded(f, opts.excludeGlobs));
  // Literal pathspecs so filenames with glob chars are not reinterpreted.
  const diff = await git(
    dir,
    ["--literal-pathspecs", "diff", "--no-color", "-M", from, opts.headSha, "--", ...paths],
    opts.token,
  );
  return { dir, diff, lines: changedLines(diff), files, incremental };
}

