# Changelog

All notable changes to Argus are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While Argus is pre-1.0, a minor version adds features and a patch version only fixes. Sections are added by the release workflow from `.changes/<version>.md`; see `docs/RELEASING.md`.

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
