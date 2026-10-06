import { activeAutoApproval, humanRevokedAutoApproval, markAutoApprovalRevoked, recordAutoApproval, type Db } from "./db.ts";
import type { Finding, Verdict } from "./findings.ts";
import { SEVERITIES } from "./findings.ts";
import type { GitLab, MrSummary } from "./gitlab.ts";
import { MARKER } from "./publisher.ts";

export interface ApproveInput {
  autoApprove: boolean;
  dryRun: boolean;
  replay: boolean; // `--head` dev replay
  selfReview: boolean; // author self-review trigger: never approves (the MR author may be a bot, e.g. codex)
  verdict: Verdict;
  findings: Pick<Finding, "severity">[];
  unfixedPrev: number; // previous open items not verified fixed this round
  authorId?: number;
  userId: number;
}

/** Reasons the round is not clean enough to hold an approval (empty = clean). Deterministic; never the agent's call. */
export function blockers(i: Pick<ApproveInput, "verdict" | "findings" | "unfixedPrev">, zh: boolean): string[] {
  const out: string[] = [];
  if (i.verdict !== "approve") out.push(zh ? `結論為 ${i.verdict}` : `verdict is ${i.verdict}`);
  const n = i.findings.filter((f) => SEVERITIES.indexOf(f.severity) >= SEVERITIES.indexOf("minor")).length;
  if (n) out.push(zh ? `本輪有 ${n} 項 minor 以上問題` : `${n} finding(s) of severity minor or above`);
  if (i.unfixedPrev) out.push(zh ? `上一輪仍有 ${i.unfixedPrev} 項未修正` : `${i.unfixedPrev} item(s) from the previous round still open`);
  return out;
}

/** Approve condition: opt-in, live run, clean round, and the user is not the MR author (author must be known). */
export function mayApprove(i: ApproveInput): boolean {
  return i.autoApprove && !i.dryRun && !i.replay && !i.selfReview && i.authorId !== undefined && i.authorId !== i.userId && blockers(i, false).length === 0;
}

/**
 * Best-effort side action after the review is published: approve a clean round, or revoke an approval Argus made
 * earlier when this round is no longer clean. Never throws; failures are logged only.
 */
export async function syncApproval(gl: GitLab, db: Db, mr: MrSummary, round: number, language: string, i: ApproveInput): Promise<void> {
  const zh = language.startsWith("zh");
  const sha8 = mr.sha.slice(0, 8);
  const where = `${mr.web_url} (${i.userId})`;
  const note = async (body: string) => gl.postNote(mr.project_id, mr.iid, body).catch((e) => console.warn(`[approve] note failed ${where}: ${(e as Error).message}`));
  if (i.dryRun || i.replay) return;
  try {
    const active = activeAutoApproval(db, i.userId, mr.id);
    if (active && !(await gl.userHasApproved(mr.project_id, mr.iid))) {
      // Approval gone. Reviews run once per head, so "same head" can't tell who removed it; the project setting can:
      // only a project that resets approvals on push (and a new head) explains it, anything else was a human.
      // If the setting can't be read (e.g. a tier without the approvals API), conservatively assume a human.
      const pushed = active.sha !== mr.sha && (await gl.resetsApprovalsOnPush(mr.project_id).catch(() => false));
      markAutoApprovalRevoked(db, active.id, pushed ? "push" : "human");
      if (!pushed) return;
    } else if (active) {
      const why = blockers(i, zh);
      if (!why.length) return; // still clean: keep the approval
      await gl.unapproveMr(mr.project_id, mr.iid);
      markAutoApprovalRevoked(db, active.id, "argus");
      await note(`${MARKER} · ${zh ? `撤回自動 approve（第 ${round} 輪：${why.join("、")}）` : `Auto-approve revoked (round ${round}: ${why.join("; ")})`}`);
      return;
    }
    if (humanRevokedAutoApproval(db, i.userId, mr.id)) return;
    if (!mayApprove(i)) return;
    if (await gl.userHasApproved(mr.project_id, mr.iid)) return; // approved by the human: not ours, never tracked
    await gl.approveMr(mr.project_id, mr.iid, mr.sha); // sha = reviewed head: GitLab rejects it if the MR moved
    recordAutoApproval(db, { ownerId: i.userId, mrId: mr.id, projectId: mr.project_id, mrIid: mr.iid, sha: mr.sha });
    await note(`${MARKER} · ${zh ? `自動 approve（第 ${round} 輪 \`${sha8}\`，無 minor 以上問題）` : `Auto-approved (round ${round} \`${sha8}\`, no findings of minor severity or above)`}`);
  } catch (e) {
    console.warn(`[approve] failed ${where}: ${(e as Error).message}`); // 401/403/409 (already approved, sha mismatch, no rights) included
  }
}
