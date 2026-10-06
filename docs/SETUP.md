# Argus: Setup guide

For the deployer (owner): deploy Argus with Docker Compose. Users only need to use Argus; see [USER-GUIDE.md](USER-GUIDE.md). For design background, see [DESIGN.md](DESIGN.md).

Run every command in this guide from the directory containing `docker-compose.yml`. For local development without Docker, see the Development section of the [README](../README.md).

Note: the Argus web UI is in Traditional Chinese. UI labels are given here in English with the original text in parentheses, so you can find them in the interface.

## 1. Prerequisites

| Item | Details |
|---|---|
| Host | A Linux/macOS host (x86_64 or arm64) that can run Docker Engine and Docker Compose v2; RAM >= 2 GB recommended |
| Network | The container can reach your GitLab and `api.anthropic.com`, and Jira if you use it. Users' browsers can reach Argus's `BASE_URL` |
| GitLab | Ability to create an OAuth Application. Tested with version 15.11 |
| Jira (optional) | Jira Server / Data Center only (Bearer token, REST v2); Jira Cloud is not supported |
| Claude subscription | The owner's own Claude account (reviews the owner's MRs). Other users use their own subscriptions and paste their Claude token (`claude setup-token`) on the Settings page |

## 2. Install / upgrade

```sh
git clone <this project's URL> argus-gitlab-review && cd argus-gitlab-review
cp .env.example .env && chmod 600 .env
openssl rand -base64 32      # generate the master key; paste it into ARGUS_MASTER_KEY in .env
$EDITOR .env                 # fill in at least BASE_URL, GITLAB_URL, ARGUS_MASTER_KEY
docker compose up -d --build
```

- If `BASE_URL` or `GITLAB_URL` is missing, `docker compose` errors out and does not start; a missing `GITLAB_URL` also makes the app fail at startup with a message.
- The image includes the `claude` and `codex` CLIs (versions pinned in the `Dockerfile`); no separate installation is needed.
- Port `3000` is published by default (change with `ARGUS_PORT`). To serve other people, put it behind a reverse proxy (TLS) and set `BASE_URL` to the public URL.

**Upgrade**: `git pull`, then `docker compose up -d --build`. Settings, data, and the Claude login live in volumes and are kept.

## 3. First-time setup

1. Open `BASE_URL` in a browser; it redirects to `/setup`.
2. Get the Setup code (format `XXXX-XXXX-XXXX-XXXX`, case-insensitive). Argus prints one line to the container log when it enters setup mode, and also stores it in `/data/setup-code`:

   ```sh
   docker compose logs argus | grep "Setup code"
   docker compose exec argus cat /data/setup-code
   ```

3. In GitLab, go to Preferences -> Applications and add an Application:

   | Field | Value |
   |---|---|
   | Redirect URI | The URL shown as "Redirect URI" (「Redirect URI」) on the `/setup` page (`<BASE_URL>/auth/callback`); it must match exactly |
   | Confidential | Checked |
   | Scopes | `api`, `read_repository` |

   To add another URL later (e.g. a domain change), add another line to the Redirect URI of the **same** Application; do not create a duplicate Application. After saving, note the Application ID and Secret (the Secret is shown only once).

4. Go back to `/setup`, fill in the fields, and click **Save and continue** (「儲存並繼續」):

   | Field | Details |
   |---|---|
   | Application ID / Secret | From the previous step |
   | Owner's GitLab user ID (recommended) or username | Prefer the numeric ID (on the GitLab profile page, or `id` from `/api/v4/user`); it does not change when the account is renamed. A username can be taken over after a rename, so if you enter a username, log in right away and verify it under User management (「使用者管理」) |
   | Jira API token (optional) | Argus reads the Jira requirement linked to an MR only if this is filled in and `JIRA_URL` is set in `.env` |
   | Setup code | From the previous step; it is invalidated once used |

5. You are redirected to the login page. Click **Log in with GitLab** (「使用 GitLab 登入」) and authorize. You are the owner.

You can also skip `/setup`: set `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, and `ARGUS_OWNER` in `.env` and run `docker compose up -d`.

## 4. Log in to Claude

The review engine is Claude Code. The owner's reviews run on the `claude` login inside the container (this section). Other users paste their own Claude token under Settings (「設定」; see section 2 of the [USER-GUIDE](USER-GUIDE.md)) and never use the owner's subscription. The owner can also paste a personal Claude token instead; if one is set, it takes priority and the container login in this section is unnecessary.

1. Open `/admin` and find the Claude (claude-cli) entry in the "Engine status" card (「引擎狀態」). If it shows "Not logged in" (「未登入」), follow the instructions on the card.
2. On the host, run:

   ```sh
   docker compose exec argus claude
   ```

   In claude, enter `/login`, complete the authorization in the browser, paste the authorization code back into the terminal, and enter `/exit`.
3. Back on `/admin`, click **Re-check login status** (「重新檢查登入狀態」), then **Test connection** (「測試連線」; it makes one real model call, limited to 1 per 30 seconds). When you see "Test succeeded" (「測試成功」) and the actual model, you are done.
4. Under Settings (「設定」), upload your `SKILL.md` (the review rules).

Login data is stored in a Docker volume (`claude-home`) and survives upgrades and restarts.

> Other colleagues are in "Awaiting approval" (「等待核准」) after they log in. Click **Approve** (「核准」) for them on `/admin`; they are reviewed only after they paste their own Claude token under Settings. The "Claude token" column of the `/admin` user table shows each person's status (set / not set / invalid / uses owner's container login; 「已設定」「未設定」「失效」「使用 owner 容器登入」), and the "Last review" column (「最近一次審查」) shows the latest result, e.g. "Skipped (token not set)" (「略過（未設定 token）」). The table never shows any token content.

## 5. Going live (review publish mode)

A new installation starts in **Dry-run**: reviews run and results are recorded in Review history (「審查紀錄」, with a `dry-run` label), but Argus does **not** comment on MRs or auto-approve. Once the results look reasonable, you do not need to edit `.env`:

1. Open `/admin` as the owner and find the "Review publish mode" card (「審查發佈模式」).
2. Check the confirmation box (Argus will post comments under each reviewer's own GitLab account) and click **Switch to live mode** (「切換為正式模式」). It takes effect immediately with no restart; to go back to record-only, click **Switch to Dry-run** (「切換為 Dry-run」).

> After switching to live, **every open MR that was previously reviewed in dry-run is re-reviewed on the next cycle (within about 30 seconds) and its comments are published**, not just new commits afterward; engine usage also rises briefly. When you switch modes, failed reviews that were "waiting for automatic retry" in the previous mode end immediately (no more retries) and remain only as history; the new mode re-reviews still-open MRs on the next cycle.

The card shows the current state and its source (web setting / locked by `.env`; 「網頁設定」「.env 鎖定」). **If `.env` has `DRY_RUN` set (any non-empty value; only `0` means live), it takes priority over the web setting and the buttons on the card are disabled.** To manage it from the web instead, clear or delete the `DRY_RUN` line in `.env`, then run:

```sh
docker compose up -d
```

## 6. Operations commands

| Purpose | Command |
|---|---|
| Start / apply config changes | `docker compose up -d` (use this after editing `.env`; it recreates the container with the new environment variables) |
| Restart (no config change) | `docker compose restart` |
| Stop (keep volumes) | `docker compose stop`; `docker compose down` removes the container but keeps volumes |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f argus` |
| Show the current Setup code (none once setup is complete) | `docker compose exec argus cat /data/setup-code` |
| Clear the OAuth / owner / Jira settings stored via the web and return to `/setup` | `docker compose exec argus npm run cli -- setup reset`, then `docker compose restart`; has no effect when `.env` sets `OAUTH_*` (environment variables take priority) |
| Log in to Claude | `docker compose exec argus claude`, then enter `/login` |
| Log in to Codex (experimental, see section 9) | `docker compose exec argus codex login --device-auth` |
| User management CLI | `docker compose exec argus npm run cli -- user list` (other subcommands: see the README) |

> `docker compose restart` does **not** re-read `.env`; after editing `.env`, use `docker compose up -d`.

## 7. `.env` and data

`.env` lives in the compose directory. **Environment variables take priority over values saved in the database by `/setup`**; after editing, run `docker compose up -d`. See `.env.example` for the full template.

| Key | Details |
|---|---|
| `ARGUS_MASTER_KEY` | Required. Generate with `openssl rand -base64 32`. **If lost, all stored tokens can no longer be decrypted**; back it up separately. |
| `BASE_URL` | Required. The public URL users see in their browsers; it must match the prefix of the OAuth Redirect URI. A URL starting with `https://` enables Secure cookies |
| `GITLAB_URL` | Required. Your GitLab URL |
| `JIRA_URL`, `JIRA_API_TOKEN` | Optional; Jira requirements are read only if both are set, otherwise disabled. Jira Server / Data Center only |
| `DRY_RUN` | Optional; leave empty. If set, it locks the publish mode (`0` = live, any other value = Dry-run) and the switch buttons on `/admin` are disabled; if unset, `/admin` manages it (default Dry-run). See section 5 |
| `ARGUS_PORT` | Default 3000; the host-side port |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Optional; if set, Argus does not enter `/setup` setup mode |
| `ARGUS_OWNER` | Optional; a GitLab user ID or username. Takes effect only when there is no owner yet |
| `REVIEW_CONCURRENCY` | Optional, default `3`. Maximum number of reviews running at once across the whole site (each review is one `claude` process). One user's reviews always run in sequence; only different users run in parallel. Must be an integer >= 1; any other value is treated as 3 |

Data is stored in three Docker volumes (names are prefixed with the compose project name, which defaults to the directory name, e.g. `argus-gitlab-review_argus-data`): `argus-data` (database, skills, each user's encrypted Claude token, each user's separate Claude config directory `engines/<GitLab user ID>/claude`, and clones in `clones/u<GitLab user ID>/`), `claude-home` (the owner's container claude login), and `codex-home`.

**Backup**: back up at least `.env` (especially the master key) and the `argus-data` volume.

**Stopping the service**: `docker compose down` only removes the container; volumes and `.env` are kept, and `up -d` again restores it.

**Complete removal** (irreversible):

```sh
docker compose down -v
```

If you redeploy with a lost or different master key, tokens already stored in the database cannot be decrypted: put the original `ARGUS_MASTER_KEY` back in `.env`.

## 8. Subscriptions and review engines

Each user's reviews run on **their own** Claude subscription. There is a single rule, implemented in one place (`chooseEngine` in `src/engine.ts`):

| User | Has a personal Claude token | No personal Claude token |
|---|---|---|
| owner | Uses the personal token | Uses the container's `claude` login (section 4) |
| Test allowlist (`OWNER_ENGINE_TEST_USERS`) | Uses the personal token | Borrows the owner's container login (test exception) |
| Other users | Uses the personal token | **Not reviewed**; recorded in Review history as "Skipped (Claude token not set yet)" (「略過（尚未設定 Claude token）」). The owner's subscription is never used |

- When Claude rejects a personal token (revoked or expired), it is marked "invalid" (「失效」), and that user's later reviews are recorded as "skipped" until they paste a new token. The same applies to the owner: there is no automatic fallback to the container login (to go back to the container login, delete the personal token).
- Tokens are encrypted with `ARGUS_MASTER_KEY` in the database. **The owner can technically decrypt everyone's tokens with the master key**, so protect the master key and host admin access.
- Test allowlist: add `OWNER_ENGINE_TEST_USERS=bob,carol` (GitLab usernames, comma-separated) to `.env` to let those users borrow the owner's engine when they have no personal token. A `TEST MODE` warning is printed at startup; do not use it in production.
- The `codex-cli` engine remains experimental, is limited to the owner and the test allowlist, and never uses personal Claude tokens (it does not work in some Docker environments; see section 9).

Concurrency: one user's reviews and `/argus accept` handling run in sequence; users with personal tokens run in parallel with each other, and the site-wide cap is set by `REVIEW_CONCURRENCY` (section 7). Reviews that use the owner's shared login (the owner without a token, the test allowlist, codex-cli) all go in one queue and never run at the same time, so the shared login is not refreshed concurrently and invalidated.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `docker compose` reports `set BASE_URL ...` or `set GITLAB_URL ...` | A required value is missing from `.env`; see section 7 |
| The container exits right after starting, and the log shows `GITLAB_URL is required` or `no master key` | Add `GITLAB_URL` or `ARGUS_MASTER_KEY`, then `docker compose up -d` |
| GitLab shows "The redirect URI included is not valid" | The URL is not in the Redirect URI list of the **same** OAuth Application, or has an extra trailing `/`. It must match `BASE_URL` + `/auth/callback` exactly |
| After login, stuck on "Awaiting approval" (「等待核准」) and the page says no owner is set | There is no owner: set one on `/setup` (run `setup reset` first, see section 6), or add `ARGUS_OWNER=<GitLab user ID>` to `.env` and `docker compose up -d`, then log in again with that account to be promoted to owner |
| `/setup` shows "Too many attempts" (「嘗試次數過多」) | After 5 wrong Setup codes from the same source IP, it locks for 10 minutes. Wait, or `docker compose restart` to reset |
| Cannot find the Setup code | `docker compose exec argus cat /data/setup-code`; there is none once setup is complete |
| `/admin` shows "Not logged in" (「未登入」) | Log in as in section 4, then click **Re-check login status** (「重新檢查登入狀態」) |
| Test connection fails | Read the error message on the card; usually not logged in, or a subscription quota problem |
| The container cannot reach GitLab/Jira (name resolution fails) | If there is no DNS, enable the `extra_hosts` block in `docker-compose.yml` |
| The log shows bwrap / namespace errors | Some Docker environments (default seccomp, or user namespaces disabled) cannot run codex's sandbox. In that case **do not use codex-cli**; stay on `claude-cli`; never switch to `danger-full-access` |
| A user sees "GitLab authorization expired" (「GitLab 授權已失效」) | That user just logs in again |
| A user's reviews are all "Skipped (token not set)" (「略過（未設定 token）」) | Expected: ask them to paste their own Claude token under Settings (USER-GUIDE section 2). The owner does not need to, and should not, handle it for them |
| A user's Claude token shows "invalid" (「失效」) on `/admin` | Their token was revoked or expired; ask them to run `claude setup-token` again and replace it on the Settings page |
| Reviews are not publishing comments | Check the "Review publish mode" card on `/admin`: Dry-run means record only, nothing is posted; if it shows "locked by `.env`" (「.env 鎖定」), clear `DRY_RUN` in `.env` first, see section 5 |
