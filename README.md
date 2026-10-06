# Argus

<img src="docs/images/argus-icon.png" alt="Argus logo" width="72" align="right">

**Website: <https://duedue.github.io/argus-gitlab-review/>** ([繁體中文](https://duedue.github.io/argus-gitlab-review/zh-TW/))

Argus is a self-hosted GitLab merge-request reviewer. It polls GitLab for open MRs where **you** are a reviewer, reviews them with an AI coding agent (`claude -p`, read-only, in a shallow clone) using **your own review skill**, and posts the findings as inline discussions plus a summary comment under your GitLab identity. Several people can share one Argus: each user brings their own GitLab login, skill, thresholds and Claude subscription.

The in-app UI and the detailed guides in `docs/` are written in Traditional Chinese; this README is the English entry point.

## Features

- **Per-user reviews**: GitLab OAuth login, one skill (`SKILL.md`) per user, per-user language, severity/confidence thresholds and model. The owner approves new users.
- **Incremental re-review**: only the diff since the last reviewed commit; previous findings are tracked as fixed / still open, fixed inline threads are replied to and resolved.
- **Instant review** via a trigger API (per-user API key) in addition to 30 s polling; author self-review mode.
- **Safe by construction**: the agent only gets `Read`/`Grep`/`Glob` on a shallow clone, never a token; deterministic code does all GitLab writes. Dry-run is the default publish mode.
- **Optional auto-approve** (opt-in per user), optional Jira requirement context, accept-finding commands (`/argus accept`).
- **Retries, dedupe and a review history UI** with the model that actually ran.
- Hono + server-side JSX web UI (no frontend build), SQLite storage, tokens encrypted with AES-256-GCM.

## Architecture overview

```
GitLab  <--REST/OAuth--  Argus (one Node 22 process)  --spawns-->  claude -p  (read-only, shallow clone)
                          |- web UI + /api/trigger (Hono)
                          |- poller + per-credential job queue
                          |- SQLite in DATA_DIR (users, reviews, settings; tokens encrypted)
Jira Server/DC (optional) <--REST v2 (requirement text only)--
```

The web process runs the poller too, on purpose: GitLab rotates OAuth refresh tokens, and a single process serialises refreshes per user. Design decisions: [docs/DESIGN.md](docs/DESIGN.md).

## Quick start (Docker Compose)

```sh
git clone <this repo> argus-gitlab-review && cd argus-gitlab-review
cp .env.example .env && chmod 600 .env
openssl rand -base64 32          # put the output in ARGUS_MASTER_KEY
$EDITOR .env                     # set BASE_URL, GITLAB_URL, ARGUS_MASTER_KEY
docker compose up -d --build
```

Then open `BASE_URL`. A first run lands on `/setup`: it needs the one-time **setup code** printed in the container log (`docker compose logs argus | grep "Setup code"`, or `docker compose exec argus cat /data/setup-code`), your GitLab OAuth application credentials and the owner's GitLab user id. Afterwards log in with GitLab, log the container's `claude` in once (`docker compose exec argus claude`, then `/login`), upload a skill under Settings, and switch the publish mode from dry-run to live on `/admin` when the results look right. Step-by-step guide (Traditional Chinese): [docs/SETUP.md](docs/SETUP.md).

Useful commands (run in the compose directory):

| Goal | Command |
|---|---|
| Logs | `docker compose logs -f argus` |
| Apply `.env` changes | `docker compose up -d` (`docker compose restart` does **not** re-read `.env`) |
| Show the setup code | `docker compose exec argus cat /data/setup-code` |
| Forget web-stored setup (re-enter `/setup`) | `docker compose exec argus npm run cli -- setup reset` then `docker compose restart` |
| Upgrade | `git pull && docker compose up -d --build` |

## Requirements

- Docker with Compose v2 (for the Compose deployment).
- A **GitLab** instance you can create an OAuth application on: confidential, scopes `api` and `read_repository`, redirect URI `<BASE_URL>/auth/callback`. Tested with GitLab **15.11**.
- A **Claude subscription**. Every user reviews on their own subscription: they run `claude setup-token` on their machine and paste the token on their Argus settings page. The owner can instead use the container's `claude` login. No Claude token means no review for that user (it is recorded as skipped; the owner's subscription is never used for others).
- Optional: **Jira Server / Data Center** (Bearer token, REST v2) for requirement context.

## Web UI

Hono + server-side JSX, no frontend build. The web process runs the poller too, on purpose: GitLab rotates OAuth refresh tokens, and one process
serialises refreshes per user. Do not run `npm run dev` alongside it (the dedupe gate prevents double reviews, but two processes can race a refresh).

OAuth app (confidential, scopes `api read_repository`, redirect `<BASE_URL>/auth/callback`). Credentials: env `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` or the first-run `/setup` page (stored encrypted); local dev on macOS may also use Keychain items `argus`/`oauth-client-id` and `oauth-client-secret`. Without any, the server starts in setup mode.

| Route | Auth | Notes |
|---|---|---|
| `GET /login` | - | sets `state` + PKCE(S256) cookies, links to GitLab authorize |
| `GET /auth/callback` | - | verifies state, exchanges code, creates session |
| `POST /logout` | session+CSRF | |
| `GET /`, `/pending` | session | redirect / "waiting for approval" |
| `GET/POST /settings` | session+CSRF | one multipart form: optional skill file, optional pasted text (file wins if both), thresholds, language, auto-approve |
| `GET /reviews` | session | last 100 reviews of the current user |
| `POST /reviews/:id/retry` | session+CSRF | re-review a failed row (row owner or Argus owner; 1 per 30 s); queues the MR's current head if still open |
| `GET /admin`, `POST /admin/users/:id/approve\|disable` | owner + CSRF | others get 403. `/admin` also shows the engine status card (`?refresh=1` bypasses the 60 s cache) |
| `POST /admin/engine/test` | owner + CSRF | real `claude -p` round trip with the engine's read-only flags; shows OK/error + the model the CLI reports; 1 per 30 s (429 after) |
| `GET /static/base.css` | - | |

Behavior notes:
- First OAuth login creates a **pending** user (`approved=0`, `enabled=0`, not owner). Pending users can edit settings/skill; the poller ignores them until the owner approves. Non-owners are reviewed on their own Claude subscription once they paste a Claude token (`claude setup-token`) on their settings page; without one their reviews are recorded as skipped. See docs/DESIGN.md "Per-user Claude token (0.2.0)".
- Tokens: OAuth access + refresh token are stored encrypted (`token_type='oauth'`), refreshed when expiring within 5 min and persisted in one UPDATE. A refresh the server **rejects (4xx)** marks the token invalid (poller skips + logs, UI shows a re-login banner; logging in again clears it). Network errors / 5xx are treated as transient and do not invalidate.
- **Existing PAT users keep their PAT**: an OAuth login by a `token_type='pat'` user only creates a session (the OAuth tokens are discarded, nothing is overwritten).
- Sessions: random id in cookie (`sid`, HttpOnly, SameSite=Lax, 7 days), only its sha256 is stored. `Secure` when `BASE_URL` is https or `COOKIE_SECURE=1`. Every POST needs the session-bound CSRF token.
- Skill uploads (file or pasted text) are stored at `DATA_DIR/skills/<user_id>/SKILL.md` (never a user-supplied path, max 200KB, UTF-8). The import-time scan only **warns** about lines that tell the agent to call GitLab/Jira tools or to post/approve/merge.
- Headers: `Content-Security-Policy: default-src 'self'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

## Configuration

Set in `.env` (compose passes the file to the container). Template: [.env.example](.env.example).

| Var | Default | Note |
|---|---|---|
| `GITLAB_URL` | - (**required**) | GitLab base URL, e.g. `https://gitlab.example.com`. Startup fails with a hint when missing or not http(s) |
| `BASE_URL` | `http://localhost:$PORT` (**required** by compose) | public URL; must match the OAuth redirect URI; https => Secure cookies |
| `ARGUS_MASTER_KEY` | - (**required**) | base64, 32 bytes (`openssl rand -base64 32`). Encrypts stored tokens; losing it makes them undecryptable. Local macOS dev can use the Keychain instead (`npm run cli -- key init`); never logged |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | - | optional; when unset Argus starts in setup mode and the `/setup` page stores them encrypted |
| `ARGUS_OWNER` | empty | GitLab user id (all digits, preferred: immutable) or username that becomes the owner on its first OAuth login **if no owner exists yet**. Never promotes anyone else |
| `JIRA_URL` / `JIRA_API_TOKEN` | empty | optional; both are needed, otherwise Jira context is disabled. Jira Server / Data Center only |
| `DRY_RUN` | unset | optional. Precedence: env `DRY_RUN` (any non-empty value; only `0` = live) > DB setting `dry_run` (owner toggle on `/admin`, applies without restart) > dry-run ON. When set it locks the toggle |
| `ARGUS_DEPLOY` | `local` | `compose` (set by `docker-compose.yml`; the UI shows `docker compose ...` commands) or `local`; explicit, never inferred; anything else = `local` + warning |
| `ARGUS_PORT` | `3000` | compose only: published host port |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | web server (`0.0.0.0` in the container) |
| `DATA_DIR` | `./data` (`/data` in the image) | SQLite db, clone cache, uploaded skills |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | `codex` is only used by the experimental `codex-cli` engine |
| `COOKIE_SECURE` | auto | `1` forces Secure cookies behind a TLS proxy |
| `POLL_INTERVAL_SEC` | `30` | the next cycle starts this long after the previous one finished (no overlap). Values < 1 or non-numeric fall back to 30 |
| `REVIEW_CONCURRENCY` | `3` | max reviews running at once across users; one user's jobs always run one at a time. Integer >= 1, else 3 |
| `OWNER_ENGINE_TEST_USERS` | empty | **TEST ONLY**, see "Owner-engine test whitelist" |
| `POLL` | on | `0` = `npm run web` without the poller |
| `EXCLUDE_GLOBS` | built-in lock/generated/vendor list | comma-separated, replaces defaults |

Per-user `engine` (`claude-cli` default, `codex-cli` experimental) is owner-only: `user set <u> engine=codex-cli` or the per-user select on `/admin`. It is an explicit choice, never inferred; the subscription guard below applies to both.

Per-user (set with `user set` or on the web `/settings`): `model` (empty = CLI default, or `opus` / `sonnet` / `haiku`; applies to the `claude-cli` engine only, passed as `claude --model <alias>`), `skill_path`, `severity_threshold` (`minor`), `confidence_threshold` (`0.7`), `language` (`zh-TW`, applied to all finding titles/bodies), `enabled`, `auto_approve` (`0`, see below).

### Model and what actually ran

The chosen alias is only a request. Argus records the model the CLI **reports** it used (keys of `modelUsage` in `claude -p --output-format json`; with several, the one with the most output tokens) in `reviews.model` and shows it in the history table (Model column), on `/settings` (latest actual model) and as a small footer in the GitLab summary comment (`<sub>model: ...</sub>`). Nothing is inferred; no report means NULL and no footer. The codex engine does not report one.

### Engine status, owner bootstrap

`/admin` (owner) shows `claude auth status --json` (logged in, auth method, plan, masked email; same env allowlist as the engine, cached 60 s). When logged out it prints the login steps for the deploy mode: compose `docker compose exec argus claude` (then `/login` inside Claude Code); local `claude` then `/login`. The codex line (`codex login status`) appears only if some user runs `codex-cli`.

Fresh install: the first-run `/setup` page collects OAuth credentials and the owner's GitLab user id. Alternatively set `ARGUS_OWNER=<gitlab user id>` (or username; log in right away, usernames can be renamed) in the environment: that user is created as the approved, enabled owner on first GitLab login. Without an owner, every other sign-up stays pending and the pending page tells the deployer to set `ARGUS_OWNER` or run `user add --owner`.

### Auto-approve (opt-in)

Off by default; toggle on `/settings` or `user set <u> auto_approve=1`. After a **live** review (never dry-run / `--head`), Argus approves the MR **under the user's own name** (GitLab shows it as theirs; a note marks it as Argus) when all hold: verdict `approve`, no finding of severity >= minor this round (nits allowed), no previous open item left unfixed, the MR author is not the user, and this is not an author self-review (`self: true`; codex MRs are bot-authored). The approval carries the reviewed head `sha`, so GitLab rejects it if the MR moved. If a later round stops meeting the condition, Argus unapproves **only approvals it made itself** (tracked in `auto_approvals`) and posts a note; a manual human approval is never touched. If an Argus approval disappears, the project setting "reset approvals on push" decides why: if it is on and the head changed, the push reset it and a clean round re-approves; otherwise a human removed it and Argus never auto-approves that MR again (if the setting can't be read, it is treated as a human). Known limit: in projects that reset on push, a human revoke followed by a push looks the same as a push reset. All of this is best-effort: GitLab errors are logged and never fail the review. Decided in code, never by the agent.

## Trigger API (instant review)

Polling (every 30 s) is the zero-integration fallback. For instant review, the MR creator's agent/CLI calls Argus right after creating the MR
(GitLab webhooks are not used, so Argus is called directly).

1. Web UI -> Settings -> "API key" -> generate. The key (`argus_...`) is shown **once**; only its sha256 is stored. One key per user, regenerating invalidates the old one at once.
2. Call it:

```sh
curl -fsS -X POST -H "Authorization: Bearer $ARGUS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"mr_url":"https://gitlab.example.com/group/project/-/merge_requests/123"}' http://<argus-host>:3000/api/trigger
# 202 {"queued":["alice"],"skipped":[{"username":"bob","reason":"not an Argus user"}]}
```

An agent/CLI should run this right after `glab mr create` / the GitLab API call, with the new MR's `web_url`. It is fire-and-forget: reviews run in the background.

**Author self-review**: add `"self": true` to review the MR as the caller (own skill and engine), regardless of who the reviewers are; draft MRs are allowed in this mode. This is what an author's agent should use right after opening its own MR:

```sh
-d '{"mr_url":"https://gitlab.example.com/group/project/-/merge_requests/123","self":true}'
```

| Status | Meaning |
|---|---|
| 202 | accepted; `queued` = reviewers whose review was queued, `skipped` = `{username, reason}` (not an Argus user / not approved / draft MR / no skill / already reviewed or in progress / already queued / no engine / token unavailable) |
| 400 | body is not JSON, `mr_url` is not an MR URL under `GITLAB_URL`, `self` is not a boolean (`invalid_self`), or the MR is not open |
| 401 | missing/unknown API key, or the caller's GitLab token is invalid (log in to Argus again) |
| 403 | caller is not an approved + enabled Argus user |
| 404 | MR not visible to the caller's GitLab token |
| 429 | more than 30 calls/hour for this user (regenerating the key does not reset it) (in-memory counter, resets on restart; `Retry-After` set) |

The MR is fetched with the **caller's** GitLab token; every reviewer who is an approved, enabled Argus user with a review engine is queued using *that reviewer's* own token, skill and settings.
Poller and trigger share one in-process serial queue (reviews never run concurrently), deduped by `(reviewer, MR, head sha)`; `claimReview` stays the final gate. No cookies/CSRF apply to `/api/*`.

Reachability for teammates: the server binds `127.0.0.1` by default. The Docker image binds `0.0.0.0` and compose publishes the port; set `BASE_URL` to the address teammates use (not `localhost`; it must match the OAuth redirect URI). Running locally, they would need `HOST=0.0.0.0` and a reachable `BASE_URL`.

## Owner-engine test whitelist (test only)

`OWNER_ENGINE_TEST_USERS=bob,carol` (comma-separated GitLab usernames, default empty) lets those **non-owner** users borrow the owner's `claude -p` engine
(the owner's Claude subscription) when they have no Claude token of their own. Their own skill, language and thresholds still apply.
Startup logs a `TEST MODE` warning and every review through it logs `[owner-engine-test]`. Unset the variable to restore the guard; no code change needed. Not for production use.

## Engines

| `users.engine` | Runs | Status |
|---|---|---|
| `claude-cli` (default) | `claude -p` on the owner's Claude subscription | production |
| `codex-cli` | `codex exec` on the owner's ChatGPT subscription | **experimental** (quality unproven, see the eval notes) |

Both use the same prompt, output contract and parser. `codex-cli` is locked down like the Claude engine: `--sandbox read-only`, no MCP servers,
env allowlist. Isolation detail: it runs with `CODEX_HOME` and `HOME` pointing at `DATA_DIR/codex-home`, which never gets the owner's `config.toml`
(so the `gitlab`/`jira` MCP servers, plugins and connectors are unreachable; also `--ignore-user-config`, `-c mcp_servers={}`, `--disable apps/plugins/...`).
Only `auth.json` is carried over, as a copy synced both ways (real -> copy before a run, copy -> real after a run if codex refreshed the token),
so the official `codex login` keeps working without sharing anything else. Check the isolation with `CODEX_HOME=<DATA_DIR>/codex-home codex mcp list` (prints no servers).
Residual risk, same as the Claude engine: the read-only sandbox can still read files the OS user can read.

Caveats for the experimental `codex-cli` engine:
- **Shared rotating refresh token**: the ChatGPT login's refresh token rotates on every refresh. Argus works on a copy and syncs back, but any *other* codex use of the same login
  (another process, or interactive `codex` on the same host/volume) can invalidate the copy or the real login. Avoid concurrent use; if a login breaks, re-run `codex login`.
- **Linux sandbox**: codex's `read-only` sandbox on Linux uses Landlock/seccomp/user namespaces. Some Docker environments (restrictive default seccomp profile, user namespaces disabled, older kernels) cannot run it, so keep `claude-cli` there; a sandbox failure aborts the run. Never switch to `danger-full-access` or `--dangerously-bypass-approvals-and-sandbox`.

## Security model

- Agent runs `claude -p` with `--tools Read,Grep,Glob`, no MCP servers, only user-level settings, and an env allowlist (no tokens). cwd = shallow clone. The experimental `codex-cli` engine gets the equivalent (see Engines).
- Git auth is injected per command via `GIT_CONFIG_*` env (`http.extraHeader`); nothing is persisted in `.git/config` or argv.
- Only `publisher.ts` calls GitLab write APIs, and only when `DRY_RUN=0`.

## Behavior notes

- **Subscription guard**: every user reviews on their own Claude subscription (personal Claude token, env-only to the `claude` child, isolated `CLAUDE_CONFIG_DIR`). The owner without a token uses the container login; `OWNER_ENGINE_TEST_USERS` is the test-only exception. Anyone else without a token is recorded as `skipped` ("尚未設定 Claude token…") and `claude` is never invoked; the owner's subscription is never used for them.
- Users are polled independently; one user's failure never stops the others. A warning is logged when a token expires within 7 days; expired tokens are skipped.

- Dedupe on `(owner_id, mr_id, head_sha)`; failed reviews are retried automatically (up to 3 attempts, after 5 then 15 min); after the final failure Argus posts one note on the MR. A per-cycle retry sweep also retries failed reviews the poller never lists (author self-reviews, MRs without you as reviewer), keeping self-review mode. Reviews interrupted by a restart are released and re-run. A failed row also has a "重新審查" button in the history page. Dry-run rows are tracked separately and never block a live run.
- Incremental: diff since the last successfully reviewed `head_sha` (falls back to full MR diff).
- Diff > 2000 lines (after exclusions) -> one "please split" note, no review.
- Findings that already have a posted comment (fingerprint of file+title in a hidden marker) are not re-posted.

## Limitations

- **Jira Server / Data Center only** (Bearer token, REST v2). Jira Cloud is not supported.
- Tested against **GitLab 15.11** only.
- The web UI, the review summary labels and the guides under `docs/` are in **Traditional Chinese**. Review finding language is configurable per user (`zh-TW` by default).
- The `codex-cli` engine is experimental and not available in every Docker environment.
- Single-instance design (one process owns the poller, queue and SQLite file).

## Development

Requires Node 22 (see `.nvmrc`), git >= 2.31 and, to run real reviews, a logged-in `claude` CLI. `better-sqlite3` is compiled per Node ABI: run `npm rebuild better-sqlite3` after changing Node versions.

```sh
npm ci
npm run cli -- key init        # once: master key -> macOS Keychain (never printed); or env ARGUS_MASTER_KEY (base64, 32 bytes)
export GITLAB_URL=https://gitlab.example.com
npm run web                    # http://localhost:3000 : web server + poller in one process (POLL=0 = web only)
npm test && npx tsc --noEmit
```

CLI (PAT users; dry-run unless `DRY_RUN=0` or the DB `dry_run` setting is live):

```sh
GITLAB_TOKEN=glpat-... npm run cli -- user add --skill ./my-skill --owner   # PAT from env/stdin, never argv; re-run rotates
npm run cli -- user list                     # no secrets shown
npm run cli -- user set <username> language=en severity_threshold=major confidence_threshold=0.8 enabled=1
npm run cli -- user remove <username>
npm run poll-once                            # one cycle over all enabled users
npm run cli -- review <project_id> <mr_iid> [--user <username>] [--head <sha>] [--engine claude-cli|codex-cli]   # always dry-run
```

`user add` checks the PAT via `GET /user` and `/personal_access_tokens/self` (needs `api` scope, not expired) and stores it AES-256-GCM encrypted. Master key: Keychain item `argus`/`master-key`, fallback env `ARGUS_MASTER_KEY`; no key = refuse to run.

## License

[MIT](LICENSE) (c) 2026 Michael Tsai
