# Changelog

All notable changes to Argus are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While Argus is pre-1.0, a minor version adds features and a patch version only fixes. Sections are added by the release workflow from `.changes/<version>.md`; see `docs/RELEASING.md`.

## [0.4.0] - 2026-11-23

### Added

- **`GET /api/branch-status`** lets agents and scripts ask what to do with a branch before submitting a branch review: `?project=<group/project or id>&branch=<branch>[&base=<branch>]`, same API key, read-only, own records only. The response carries the branch's current `head`, the latest branch review for that head and base (`review`), the push-trigger state (`push`, when "review my pushed branches" is on) and an `advice` value:
  - `done`: this head already has a finished or failed review (failed ones are not retried automatically).
  - `running`: a review is queued or running; check again or poll `review.id`.
  - `pending_push`: the push trigger will review this head shortly; wait instead of submitting.
  - `submit`: send `POST /api/review-branch` yourself.
- The status endpoint has its own limit of 600 calls per user per hour, separate from the submit budget, so polling never blocks a submission.

## [0.3.0] - 2026-11-19

### Added

- **Branch review before the MR exists.** `POST /api/review-branch` (same API key and hourly budget as the trigger API) queues an asynchronous review of a branch against its base with your own skill, thresholds and Claude token; poll `GET /api/review-branch/<id>` for the verdict, findings and below-threshold items. The result goes only to the caller: nothing is posted to GitLab, nothing is approved, and the later MR review is unaffected. One active branch review per user; results are kept for 90 days and listed by `GET /api/branch-reviews`. A host-side CLI, `npm run cli -- review-branch <project> <branch> [--base <branch>] [--user <username>] [--json]`, runs outside the review queue.
- **Attach on MR open.** When you open an MR from a branch whose head already has a finished branch review against the same target branch, Argus posts that result as the MR's review summary instead of reviewing again: summary only, no inline threads, never an auto-approve. The lookup covers reviews from the last 14 days and a failed attach is retried up to three times without leaving a failure note on the MR.
- **Push-triggered branch review** (off by default, per-user setting "review my pushed branches"): branches you push that have no open MR are reviewed about 5 minutes after the last push, only within your project allowlist and only while your review queue is idle, at most `branch_daily_cap` times per rolling 24 hours (default 20, range 0–1000, 0 turns it off; manual API/CLI runs do not count). Transient GitLab errors are retried up to three times, a 401 ends the cycle, and configuration problems such as an invalid token pause the trigger until fixed. Results are stored and attached when the MR opens.
- **Branch reviews tab** on the review history page (`/reviews?tab=branch`, 20 per page) with a detail page per run and a link to the MR a result was attached to; the pushed-branches toggle and the daily cap live on the settings page. CLI runs stuck for more than 20 minutes are marked interrupted.

### Changed

- Runtime dependencies updated: @hono/node-server 2, better-sqlite3 13, marked 18 and minimatch 11, plus patch updates of hono and zod.

## [0.2.0] - 2026-11-09

### Added

- Per-user project allowlist for automatic reviews. Each user keeps a strict list of projects (empty means nothing is reviewed automatically) or turns on "allow all assigned MRs". Existing users are migrated to allow-all; new web sign-ups start restricted. Self-review and the trigger API are never filtered.
- "MRs awaiting your decision": MRs skipped because their project is not on the list are kept for 30 days on the settings page and can be allowed with one click, which adds the project and queues the review right away. Adding or removing projects takes effect immediately.
- Automatic cleanup of review clones: clones idle for 14 days or larger than 1 GiB are pruned every hour, and orphaned clone directories are removed.

### Changed

- The Docker image applies Debian security upgrades at build time.

## [0.1.0] - 2026-10-06

First public release.

### Added

- Per-user reviews: GitLab OAuth login, one review skill per user, per-user language, severity/confidence thresholds, model and engine (`claude-cli`, experimental `codex-cli`); the owner approves new users.
- Incremental re-review of only the diff since the last reviewed commit; previous findings are tracked as fixed or still open, and fixed inline threads are replied to and resolved.
- Instant review through a per-user trigger API in addition to 30 s polling; author self-review mode.
- `/argus accept` lets the MR author mark a finding as accepted; optional auto-approve when nothing above the user's threshold remains.
- Review history page with rounds grouped per MR.
- Jira Server / Data Center requirement context (optional).
- Docker Compose deployment, setup page, encrypted token storage with `ARGUS_MASTER_KEY`.
