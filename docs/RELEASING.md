# Argus: Releasing

Argus ships on a weekly cadence. Releases are prepared as branches and published by a scheduled GitHub Actions workflow, so publishing is deterministic and never depends on someone being at a keyboard.

## Preparing a release

1. Branch from `main`: `git checkout -b release/<version>` (for example `release/0.2.0`). When more than one version is ready, stack the next one on top of the previous release branch; the workflow drops the already-published commits when it rebases.
2. Land the feature commits on that branch. Each commit must keep `npm run typecheck` and `npm test` green.
3. Finish with one commit that bumps `version` in `package.json` (and `package-lock.json`) and adds `.changes/<version>.md`: the release notes for that version in Keep a Changelog style (`### Added`, `### Changed`, `### Fixed`, ...), without the version heading.
4. Never edit `CHANGELOG.md` on a release branch. The workflow writes it, which is what keeps stacked branches free of conflicts.
5. Push the branch. CI runs on `release/**` branches, so a broken branch is visible before publish day.

## What the publish workflow does

`.github/workflows/publish.yml` runs every Monday at 09:00 Asia/Taipei (01:00 UTC) and can also be started by hand from the Actions tab (optionally naming a branch). It:

1. picks the pending `release/*` branch with the lowest version, and refuses one that is not newer than `main`;
2. rebases it onto `main` with the commit dates reset to publish time, checks that the package version matches the branch name, and adds a `docs(changelog): <version>` commit that inserts `.changes/<version>.md` under a dated heading at the top of `CHANGELOG.md`;
3. runs typecheck and tests, and builds the Docker image;
4. fast-forwards `main`, pushes the tag `v<version>`, deletes the release branch;
5. creates the GitHub release with `.changes/<version>.md` as its notes;
6. pushes the image to `ghcr.io/duedue/argus-gitlab-review:<version>` and `:latest`.

If no `release/*` branch exists the run ends quietly. Any failure before step 4 leaves the repository untouched.

## Repository secrets

| Secret | Used for |
|---|---|
| `PUBLISH_PAT` | Fine-grained personal access token with **Contents: read and write** on this repository. It pushes `main` and the tag and creates the release, so both are attributed to the token's owner and trigger CI. |

The image push uses the workflow's own `GITHUB_TOKEN` (`packages: write`). The image carries the `org.opencontainers.image.source` label so the package stays linked to this repository. If the push step fails after the release was created, run the **Push image** workflow (`.github/workflows/image.yml`) with the published version; it rebuilds from the tag and pushes without touching `main`, tags or releases. The package's **Manage Actions access** must grant this repository the Write role.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens grouped pull requests for npm dependencies, the Docker base image and GitHub Actions every Monday. Merge them like any other change; they go out with the next version.
