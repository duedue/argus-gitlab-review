import { join } from "node:path";
import { jiraTokenFrom } from "./jira.ts";

export interface Config {
  // Which path the operator commands take. Explicit, never inferred: ARGUS_DEPLOY=compose (set by docker-compose.yml) | local (developer, default); unknown values fall back to local with a warning.
  deploy: "compose" | "local";
  gitlabUrl: string; // base, e.g. https://gitlab.example.com; REQUIRED (empty here only when unset: entry points call assertRequiredConfig)
  // Effective publish mode. The ONLY writers are loadConfig (env / safe default), applyStoredSettings (DB `dry_run`, startup) and
  // setDryRun (web toggle, which also persists). Precedence: env DRY_RUN (any non-empty value; only "0" = live) > DB `dry_run` > ON.
  dryRun: boolean;
  dryRunLocked: boolean; // env DRY_RUN is set: the web toggle is disabled
  claudeBin: string;
  codexBin: string;
  dataDir: string;
  maxDiffLines: number;
  excludeGlobs: string[];
  pollIntervalMs: number;
  ownerRef?: string; // ARGUS_OWNER: GitLab user id (all digits, preferred) or username that may bootstrap the owner on first OAuth login
  ownerEngineTestUsers: string[]; // M5 test whitelist: non-owners allowed to borrow the owner's CLI engine
  jira: { url: string; token: () => string | undefined }; // requirement context (Jira Server/DC only); url "" = JIRA_URL unset = Jira context disabled
  web: { port: number; host: string; baseUrl: string; cookieSecure: boolean };
}

export const DEFAULT_EXCLUDES = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/Cargo.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/composer.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/locales/**/*.json", // translation catalogs: mechanical, bulky, not worth review budget
  "**/third_party/**",
  "**/generated/**",
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*_pb2.py",
];

/** Fail fast at startup (web + CLI entry points) when GITLAB_URL is missing or not an http(s) URL. Throws an Error with a fix hint. */
export function assertRequiredConfig(cfg: Pick<Config, "gitlabUrl">): void {
  if (!cfg.gitlabUrl) throw new Error("GITLAB_URL is required: set it to your GitLab base URL, e.g. GITLAB_URL=https://gitlab.example.com");
  if (!/^https?:\/\/[^/\s]+/i.test(cfg.gitlabUrl)) throw new Error(`GITLAB_URL must be an http(s) URL, got ${JSON.stringify(cfg.gitlabUrl)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const sec = Number(env.POLL_INTERVAL_SEC);
  const pollSec = Number.isFinite(sec) && sec >= 1 ? sec : 30; // unset/invalid -> 30s default
  const deploy = env.ARGUS_DEPLOY === "compose" ? "compose" : "local";
  if (env.ARGUS_DEPLOY && env.ARGUS_DEPLOY !== "compose" && env.ARGUS_DEPLOY !== "local") {
    console.warn(`[config] unknown ARGUS_DEPLOY=${JSON.stringify(env.ARGUS_DEPLOY)}; using "local" (valid: compose, local)`);
  }
  const dryRunEnv = env.DRY_RUN?.trim() || undefined; // empty counts as unset
  return {
    deploy,
    gitlabUrl: (env.GITLAB_URL ?? "").trim().replace(/\/+$/, ""),
    // Safe default: with DRY_RUN unset the DB setting decides (default ON); when set, anything other than the literal "0" keeps dry-run on.
    dryRun: dryRunEnv === undefined ? true : dryRunEnv !== "0",
    dryRunLocked: dryRunEnv !== undefined,
    claudeBin: env.CLAUDE_BIN ?? "claude",
    codexBin: env.CODEX_BIN ?? "codex",
    dataDir: env.DATA_DIR ?? join(process.cwd(), "data"),
    maxDiffLines: 2000,
    excludeGlobs: env.EXCLUDE_GLOBS ? env.EXCLUDE_GLOBS.split(",").map((s) => s.trim()) : DEFAULT_EXCLUDES,
    pollIntervalMs: pollSec * 1000,
    ownerRef: env.ARGUS_OWNER?.trim().replace(/^@/, "") || undefined,
    ownerEngineTestUsers: (env.OWNER_ENGINE_TEST_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    jira: { url: (env.JIRA_URL ?? "").trim().replace(/\/+$/, ""), token: () => jiraTokenFrom(env) },
    web: {
      port,
      host: env.HOST ?? "127.0.0.1", // loopback by default; set HOST=0.0.0.0 in Docker
      // Must match the redirect URI registered on the GitLab OAuth application.
      baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
      cookieSecure: env.COOKIE_SECURE === "1" || (env.BASE_URL ?? "").startsWith("https://"),
    },
  };
}
