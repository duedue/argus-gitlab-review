# Argus: Guide for MR authors

For people who open MRs: how to make sure your reviewer's Argus can review your MR, and review it well. You do not need to install or log in to Argus.

## 1. Getting Argus to review your MR

| Condition | Details |
|---|---|
| **Reviewer** assigned | Argus only looks at the MR's Reviewer field. Setting only the Assignee does not trigger a review, unless that person turned on "Also review MRs where I am the Assignee" (「也審查 Assignee 是我的 MR」) in Argus |
| Not a Draft | Draft/WIP MRs are not reviewed. Review starts within about 30 seconds after you mark the MR ready |
| Within the size limit | See the next section. Above the limit, Argus posts a single "please split" note and does not review |

Every new commit you push gets another review round. It covers only what changed since the last review and tracks whether issues from earlier rounds were fixed. After you merge the target branch into your branch, that round re-reads the whole MR (lines are counted from the MR's actual changes, excluding commits that came in from the target).

**Self-review before you open the MR**: every push after the MR is open counts as a review round, so it is best to run a branch review on your branch first (call `POST /api/review-branch`; the `review-branch` CLI on the Argus host is only a development aid and should not be used while the server is busy; see the [user guide](USER-GUIDE.md) for usage), fix what it finds, and then open the MR. It returns the result only to you: it leaves no comments on GitLab and does not affect later reviews of the MR.

## 2. MR size limit: set per reviewer (default 2000 lines, adjustable 500-8000)

Each reviewer sets the limit on their own settings page. When an MR exceeds it, the note states that reviewer's actual limit.

**How lines are counted**: added lines + deleted lines (same as the +/- on the GitLab "Changes" tab). Unchanged context lines and renamed files with no content change are not counted.

**Files that are not counted**: lock files (`package-lock.json`, `yarn.lock`, `go.sum`, etc.), `*.min.js` / `*.min.css` / `*.map`, `dist/`, `build/`, `vendor/`, `node_modules/`, and translation files `locales/**/*.json`.

**Why there is a limit**:

- **Accuracy**: with a huge diff, the review tends to miss the key problems and leave only surface-level comments
- **Time**: a single review has a time limit (10 minutes up to 2000 lines; larger diffs get more time in proportion to line count, up to 15 minutes), and large MRs still tend to time out
- **Usage**: a review spends the reviewer's AI quota, and an oversized MR costs about 5-10 times as much as a normal one
- **Humans too**: small MRs are also easier for people to review

## 3. How to split

- Separate mechanical changes from logic changes: send large renames, reformatting, and file moves as their own MR first
- Split a new feature into "infrastructure / data layer" -> "the feature itself" -> "UI", and merge them in order
- Ship large amounts of new tests with the feature they cover, not all together in a final MR
- Translation files are no longer counted, so they can go in the same MR as the feature

## 4. Helping Argus review well

| What to do | Effect |
|---|---|
| Put the Jira key in the title (e.g. `[PROJ-520] ...`), or put a Jira `/browse/KEY` link in the description | Argus reads that ticket's requirements and checks whether the implementation matches |
| Maintain a `CLAUDE.md` or `AGENTS.md` at the repo root | Argus treats it as the project's conventions (taken from the MR's base commit, first 16 KB) |
| Describe in the MR description what changed and why | Helps Argus judge the intent of the change and reduces false positives |

## 5. After you see Argus's comments

- Comments start with `🤖 **Argus**` and are posted under the reviewer's own account; the reviewer is responsible for the content
- Push your fixes: the next round checks them automatically, and threads that are fixed are resolved automatically
- Each finding has a short id (e.g. `#24a3c7`), and a closing line explains what to do if you do not plan to change something
- **Argus's comments are advisory only. Not replying does not affect merging; the reviewer decides.**

### When you do not plan to change a finding

1. Explain why: for an inline finding, reply in that thread; for a finding in the summary (no thread), comment on the MR and say which one (e.g. "#24a3c7: this is expected because ...").
2. If the reviewer agrees, they mark it "accepted" with a command:
   - Inline finding: reply in that thread with `/argus accept <reason>`
   - Finding in the summary: comment on the MR with `/argus accept #24a3c7 <reason>`
3. On the next polling cycle (about 30 seconds; if Argus is reviewing other MRs, it waits for the queue to free up), Argus replies "accepted" (「已接受」), resolves the thread, and posts a short note updating the verdict (e.g. "1 accepted, 0 remaining, verdict updated to: mergeable" (「已接受 1 項，剩 0 項，結論更新為：可合併」)). It does not re-run the AI review. Later rounds no longer list the item, and the AI reporting it again is filtered out.

Only the reviewer of that review can mark a finding accepted. If anyone else (including the MR author) issues `/argus accept`, Argus replies with an explanation and @-mentions the reviewer. A malformed command or an unknown id also gets an explanatory reply.

### If you think a finding is a false positive: `/argus reply`

The MR author or an assignee of the MR can dispute a finding with `/argus reply`; the reviewer's Argus has its AI judge it, so you do not have to wait for the reviewer:

- Inline finding: reply in that thread with `/argus reply <reason>`
- Finding in the summary: comment on the MR with `/argus reply #24a3c7 <reason>`

The reason is required. Give something checkable (for example "`docs/archive/` already exists at HEAD" or "the caller checks this at `x.ts:42`"). A plain reply does not trigger a judgement; you must use this command.

Argus looks only at that one finding, your reason, and the code at the commit the review ran on (it can inspect the paths you mention). It does not re-review the MR. Outcomes:

| AI judgement | Finding severity | What Argus does |
|---|---|---|
| Reply holds | minor, nit | Marks it "accepted" (recorded as accepted via author reply, AI-judged), resolves the thread, updates the verdict; auto-approves as usual when the conditions are met |
| Reply holds | major, blocker | Only replies "suggest accepting" and @-mentions the reviewer; the thread stays open and the reviewer decides with `/argus accept` |
| Reply does not hold | any | Replies with the rationale; the thread stays open |
| Could not judge (AI failure or unparsable output) | any | Asks the reviewer to decide; the thread stays open |

- If you pushed a new commit and its review round has not finished yet, Argus does not judge; it asks you to reply again after that round completes.
- Each `/argus reply` note is handled once; to add more reasoning, post a new one.
- Permission is checked against GitLab accounts (the MR author and assignees), not against anything written in the note. The reviewer should use `/argus accept` directly.

If the project requires all threads to be resolved before merging and the reviewer has not dealt with it yet, you can resolve the thread manually after explaining why.
