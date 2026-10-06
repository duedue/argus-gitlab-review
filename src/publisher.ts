import { createHash } from "node:crypto";
import type { Discussion, GitLab, Mr } from "./gitlab.ts";
import type { OpenThread } from "./engine.ts";
import { SEVERITIES, passesThreshold, type Finding, type Severity, type Verdict } from "./findings.ts";

export const MARKER = "🤖 **Argus**";
/** Markers of earlier releases: threads opened under them must still be recognised (auto-resolve). */
const hasMarker = (body: string) => body.startsWith(MARKER);

export interface PublishOpts {
  dryRun: boolean;
  minSeverity: Severity;
  minConfidence: number;
  hint?: AcceptHint;
}

/** Who may `/argus accept` a finding, shown under every finding so the MR author knows the rule where they read it. */
export interface AcceptHint {
  reviewer: string; // GitLab username of the review row's owner
  baseUrl: string;
  language: string;
}

export const fp = (f: Finding) =>
  createHash("sha1").update(`${f.file}\n${f.title}`).digest("hex").slice(0, 12);
const fpTag = (f: Finding) => `<!-- sentinel:${fp(f)} -->`;
/** Visible short id (first 6 of the fingerprint), in code span so GitLab does not link it as an issue. */
export const shortId = (id: string) => `\`#${id.slice(0, 6)}\``;

function hintLine(h: AcceptHint, id?: string): string {
  const docs = `${h.baseUrl}/docs/mr`;
  if (h.language.startsWith("zh")) {
    return id
      ? `> 不打算修改？請在 MR 留言說明原因；審查者 @${h.reviewer} 同意可留言 \`/argus accept #${id.slice(0, 6)} <原因>\`。（[說明](${docs})）`
      : `> 不打算修改？請在此回覆原因；審查者 @${h.reviewer} 同意可回覆 \`/argus accept\`。（[說明](${docs})）`;
  }
  return id
    ? `> Not going to change it? Explain why in an MR comment; reviewer @${h.reviewer} can comment \`/argus accept #${id.slice(0, 6)} <reason>\` to accept it. ([guide](${docs}))`
    : `> Not going to change it? Reply here with why; reviewer @${h.reviewer} can reply \`/argus accept\` to accept it. ([guide](${docs}))`;
}

export function inlineBody(f: Finding, hint?: AcceptHint): string {
  return `${MARKER} · ${shortId(fp(f))} · **${f.severity}**: ${f.title}\n\n${f.body}\n\n${hint ? hintLine(hint) + "\n\n" : ""}${fpTag(f)}`;
}

/** Pure: split fresh findings. Threshold only decides inline vs summary; it never hides content. */
export function plan(findings: Finding[], o: Pick<PublishOpts, "minSeverity" | "minConfidence">, seen: Set<string>) {
  const fresh = findings.filter((f) => !seen.has(fp(f)));
  const inline = fresh.filter((f) => f.line !== undefined && passesThreshold(f, o.minSeverity, o.minConfidence));
  return { fresh, inline, summaryItems: fresh.filter((f) => !inline.includes(f)) };
}

export interface Track {
  prev: OpenThread[]; // items open before this round (inline threads + carried summary-only items)
  fixed: Set<string>; // ids among prev verified fixed this round
}

export interface SummaryCtx {
  round: number;
  sha: string;
  language: string;
  verdict: Verdict;
  summary?: string;
  checked: string[];
  focus?: string[];
  track?: Track; // re-reviews only
  accepted?: number; // findings the reviewer accepted on this MR (human verdict, excluded from the verdict)
  model?: string; // model the CLI reported using; shown as a small footer
}

const LABELS = {
  zh: {
    round: (n: number) => `第 ${n} 輪`,
    verdict: { approve: "可合併", request_changes: "建議修改", needs_discussion: "需討論" } as Record<Verdict, string>,
    findings: "發現", inlineRef: "見 inline", checked: "已確認正確", focusChecked: "本輪重點檢查", track: "輪次追蹤",
    prev: (x: number, a: number, b: number) => `上一輪 ${x} 項：已修正 ${a}、仍存在 ${b}`,
    added: (c: number) => `本輪新增 ${c} 項`,
    none: "未發現需要回報的問題。",
    model: "使用模型",
    accepted: (n: number) => `審查者已接受 ${n} 項（人工裁決，不列入本輪發現與結論）`,
  },
  en: {
    round: (n: number) => `Round ${n}`,
    verdict: { approve: "Approve", request_changes: "Request changes", needs_discussion: "Needs discussion" } as Record<Verdict, string>,
    findings: "Findings", inlineRef: "see inline", checked: "Checked and correct", focusChecked: "Focus checked this round", track: "Round tracking",
    prev: (x: number, a: number, b: number) => `Previous round: ${x} item(s): ${a} fixed, ${b} still open`,
    added: (c: number) => `${c} new item(s) this round`,
    none: "No issues found.",
    model: "model",
    accepted: (n: number) => `${n} item(s) accepted by the reviewer (human decision; excluded from findings and verdict)`,
  },
};
const loc = (language: string) => (language.startsWith("zh") ? LABELS.zh : LABELS.en);
export const verdictLabel = (language: string, v: Verdict) => loc(language).verdict[v];

const where = (f: Pick<Finding, "file" | "line">) => `\`${f.file}${f.line ? ":" + f.line : ""}\``;
const indent = (t: string) => t.replace(/\n/g, "\n  ");

/** Pure. `inline`: findings posted as discussions (one-liners here); `items`: full bodies live only here. */
export function summaryBody(inline: Finding[], items: Finding[], ctx: SummaryCtx | undefined, extra?: string, added = items.length + inline.length, hint?: AcceptHint): string {
  if (!ctx) return [`${MARKER} review summary`, ...(extra ? [extra] : [])].join("\n\n");
  const L = loc(ctx.language);
  const parts = [`${MARKER} · ${L.round(ctx.round)} (\`${ctx.sha.slice(0, 8)}\`) · **${L.verdict[ctx.verdict]}**`];
  if (ctx.summary) parts.push(ctx.summary);
  if (extra) parts.push(extra);
  const rows: string[] = [];
  for (const sev of [...SEVERITIES].reverse()) {
    for (const f of inline.filter((x) => x.severity === sev)) rows.push(`- **${sev}** ${shortId(fp(f))} ${where(f)} ${f.title} (${L.inlineRef})`);
    for (const f of items.filter((x) => x.severity === sev)) {
      const h = hint ? hintLine(hint, fp(f)) : undefined;
      rows.push(
        sev === "nit"
          ? `<details><summary><b>nit</b> <code>#${fp(f).slice(0, 6)}</code> ${where(f)} ${f.title}</summary>\n\n${f.body}\n\n${h ? h + "\n\n" : ""}${fpTag(f)}\n\n</details>`
          : `- **${sev}** ${shortId(fp(f))} ${where(f)} **${f.title}**\n\n  ${indent(f.body)}\n\n  ${h ? h + "\n\n  " : ""}${fpTag(f)}`,
      );
    }
  }
  if (ctx.focus?.length) parts.push(`### ${L.focusChecked}`, ctx.focus.map((c) => `- ${c}`).join("\n"));
  parts.push(`### ${L.findings}`, rows.length ? rows.join("\n\n") : L.none);
  if (ctx.accepted) parts.push(L.accepted(ctx.accepted));
  if (ctx.checked.length) parts.push(`### ${L.checked}`, ctx.checked.map((c) => `- ${c}`).join("\n"));
  if (ctx.track) {
    const { prev, fixed } = ctx.track;
    const lines = [
      L.prev(prev.length, fixed.size, prev.length - fixed.size),
      ...prev.map((t) => `- ${fixed.has(t.id) ? "✅" : "⏳"} ${t.title} (${where(t)})`),
      L.added(added),
    ];
    parts.push(`### ${L.track}`, lines.join("\n"));
  }
  if (ctx.model) parts.push(`<sub>${L.model}: ${ctx.model}</sub>`);
  return parts.join("\n\n");
}

/** Returns the fresh findings that live only in the summary note (carried to later rounds as open items). */
export async function publish(gl: GitLab, mr: Mr, findings: Finding[], o: PublishOpts, extra?: string, ctx?: SummaryCtx): Promise<Finding[]> {
  const seen = new Set<string>();
  for (const d of await gl.listDiscussions(mr.project_id, mr.iid)) {
    for (const n of d.notes) for (const m of n.body.matchAll(/<!-- sentinel:([0-9a-f]{12}) -->/g)) seen.add(m[1]!);
  }
  // Items still open from earlier rounds are already reported (also in dry-run, where GitLab holds no markers).
  const prevIds = new Set((ctx?.track?.prev ?? []).map((t) => t.id));
  const p = plan(findings, o, new Set([...seen, ...prevIds]));
  const posted: Finding[] = [];
  const summaryItems = [...p.summaryItems];
  const send = async (label: string, body: string, fn: () => Promise<void>) => {
    if (o.dryRun) console.log(`[DRY_RUN] would post ${label} on ${mr.web_url}:\n${body}\n---`);
    else await fn();
  };

  for (const f of p.inline) {
    const body = inlineBody(f, o.hint);
    const position = {
      position_type: "text",
      base_sha: mr.diff_refs.base_sha,
      start_sha: mr.diff_refs.start_sha,
      head_sha: mr.diff_refs.head_sha,
      old_path: f.file,
      new_path: f.file,
      new_line: f.line,
    };
    try {
      await send(`inline ${f.file}:${f.line}`, body, () => gl.postDiscussion(mr.project_id, mr.iid, body, position));
      posted.push(f);
    } catch {
      // Line not in diff (GitLab 400): degrade to the summary note instead of losing the finding.
      summaryItems.push(f);
    }
  }
  // With a ctx the summary is posted every round (verdict + round tracking); without one only when there is a notice.
  if (ctx || extra) {
    const body = summaryBody(posted, summaryItems, ctx, extra, p.fresh.length, o.hint);
    await send("summary note", body, () => gl.postNote(mr.project_id, mr.iid, body));
  }
  return summaryItems;
}

export interface AiThread extends OpenThread {
  discussionId: string;
}

/** Pure: unresolved inline threads this platform opened as `ownerId` (the only threads it may resolve). */
export function openAiThreads(discussions: Discussion[], ownerId: number): AiThread[] {
  const out: AiThread[] = [];
  for (const d of discussions) {
    const n = d.notes[0];
    if (!n || n.author?.id !== ownerId || !n.resolvable || n.resolved || !hasMarker(n.body)) continue;
    const id = n.body.match(/<!-- sentinel:([0-9a-f]{12}) -->/)?.[1];
    const title = n.body.split("\n")[0]!.replace(/^.*?\*\*:\s*/, "");
    if (id) out.push({ discussionId: d.id, id, file: n.position?.new_path ?? "", line: n.position?.new_line ?? undefined, title });
  }
  return out;
}

/** Pure: items to close = agent's claim ∩ our open items, minus anything re-reported this round. */
export function claimedFixed<T extends { id: string }>(items: T[], resolved: string[], findings: Finding[]): T[] {
  const claimed = new Set(resolved);
  const reported = new Set(findings.map(fp));
  return items.filter((t) => claimed.has(t.id) && !reported.has(t.id));
}

export const threadsToResolve = (threads: AiThread[], resolved: string[], findings: Finding[]): AiThread[] => claimedFixed(threads, resolved, findings);

/** Best-effort side action: a failure is logged and never fails the (already published) review. Returns resolved count. */
export async function resolveThreads(gl: GitLab, mr: Mr, threads: AiThread[], o: { dryRun: boolean; language: string }): Promise<number> {
  const note = o.language.startsWith("zh")
    ? `${MARKER} · ✅ 已於 \`${mr.sha.slice(0, 8)}\` 確認修正，自動 resolve`
    : `${MARKER} · ✅ Verified fixed in \`${mr.sha.slice(0, 8)}\`; auto-resolved`;
  let ok = 0;
  for (const t of threads) {
    if (o.dryRun) {
      console.log(`[DRY_RUN] would resolve thread ${t.file}:${t.line ?? "-"} "${t.title}" on ${mr.web_url}`);
      ok++;
      continue;
    }
    try {
      // Resolve first: a resolved thread is no longer "open", so a failed reply can't cause a duplicate reply later.
      await gl.resolveDiscussion(mr.project_id, mr.iid, t.discussionId);
      ok++;
      await gl.replyDiscussion(mr.project_id, mr.iid, t.discussionId, note);
    } catch (e) {
      console.warn(`[resolve] ${mr.web_url} thread ${t.discussionId} failed: ${(e as Error).message}`);
    }
  }
  return ok;
}

/**
 * Short, safe failure reason for a public MR note: first line only (no stack), URLs, absolute paths, token-like
 * strings and credentials removed, capped at 200 chars. Errors can embed git remotes with tokens or local paths.
 */
export function sanitizeReason(raw: string): string {
  const r = (raw.split("\n")[0] ?? "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(/\b(?:token|key|secret|password|authorization)\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/\b(?:glpat|gloas|gldt|ghp|sk|argus)[-_][\w-]+/gi, "[redacted]")
    .replace(/(?<![\w.\]/])(?:[A-Za-z]:\\|~?\/)[\w.@~+-]+(?:[\\/][\w.@~+-]+)*/g, "[path]")
    .replace(/[A-Za-z0-9_+=-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (r.length > 200 ? `${r.slice(0, 199)}…` : r) || "unknown error";
}

export function failureNote(attempts: number, reason: string, language: string): string {
  const r = sanitizeReason(reason);
  return language.startsWith("zh")
    ? `${MARKER} · 審查失敗（第 ${attempts} 次嘗試）：${r}。push 新 commit，或在 Argus 審查紀錄按「重新審查」即可重試。`
    : `${MARKER} · Review failed (attempt ${attempts}): ${r}. Push a new commit, or press "Re-review" in the Argus review history to retry.`;
}
