import { blockers, syncApproval } from "./approve.ts";
import type { Config } from "./config.ts";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { acceptedFindings, acceptedIds, doneFindingsJson, handleNote, latestDone, markAnnounced, nextRound, noteHandled, recordAccept, unannouncedAccepts, watchCandidates, type Db, type WatchRow } from "./db.ts";
import { deriveVerdict, type Finding, type Verdict } from "./findings.ts";
import type { Discussion, GitLab, Mr, MrSummary } from "./gitlab.ts";
import { laneFor, parseJudgement, type AcceptedItem, type JudgeInput, type Judgement } from "./engine.ts";
import { prepareDiff } from "./repo.ts";
import { MARKER, fp, openAiThreads, verdictLabel, type AiThread } from "./publisher.ts";
import type { ReviewQueue } from "./queue.ts";
import type { UserRuntime } from "./review.ts";
import { engineFields, type User } from "./users.ts";

/**
 * `/argus accept [#id] [reason]`, strictly at the start of a note. undefined = not an accept command at all;
 * `bad` = it is one but the id is malformed. The id is 6-12 hex (a fingerprint prefix); case-insensitive.
 */
export const parseAccept = (body: string) => parseCommand(body, "accept");

/** `/argus reply [#id] <reason>`: same grammar as accept, but the reason is required (empty = `bad`). */
export function parseReply(body: string): { id?: string; reason: string } | { bad: true } | undefined {
  const c = parseCommand(body, "reply");
  return c && !("bad" in c) && !c.reason ? { bad: true } : c;
}

function parseCommand(body: string, verb: "accept" | "reply"): { id?: string; reason: string } | { bad: true } | undefined {
  const m = body.trim().match(new RegExp(`^\\/argus[ \\t]+${verb}(?![^\\s])([\\s\\S]*)$`, "i"));
  if (!m) return undefined;
  const rest = m[1]!.trim();
  if (!rest.startsWith("#")) return { reason: rest };
  const idm = rest.match(/^#([0-9a-f]{6,12})(?:\s+([\s\S]*))?$/i);
  return idm ? { id: idm[1]!.toLowerCase(), reason: (idm[2] ?? "").trim() } : { bad: true };
}

/** The round's findings minus accepted ones; the verdict is lifted to approve only when nothing blocking remains. */
export function afterAccept(findings: Finding[], openPrev: string[], accepted: Set<string>, verdict: Verdict) {
  const ids = new Set(findings.map(fp));
  const remaining = findings.filter((f) => !accepted.has(fp(f)));
  const unfixed = [...new Set(openPrev)].filter((id) => !accepted.has(id) && !ids.has(id));
  // Same "clean" rule as the auto-approve gate (no finding >= minor, no unfixed previous item).
  const clean = blockers({ verdict: "approve", findings: remaining, unfixedPrev: unfixed.length }, false).length === 0;
  return { remaining, unfixed, verdict: clean ? ("approve" as const) : verdict };
}

interface Stored { findings: Finding[]; verdict: Verdict; openPrev: string[]; legacy: boolean }

/** What the latest done review recorded: its findings, verdict, and the items it left open from earlier rounds. */
function stored(json: string | null): Stored {
  try {
    const j = JSON.parse(json ?? "null") ?? {};
    const findings: Finding[] = Array.isArray(j.findings) ? j.findings : [];
    const ids = (a: unknown) => (Array.isArray(a) ? a.map((x) => (typeof x === "string" ? x : (x as { id?: string })?.id)).filter((x): x is string => typeof x === "string") : []);
    // Rows written before unfixedPrev existed may still have open inline threads only GitLab knows about.
    return { findings, verdict: j.verdict ?? deriveVerdict(findings), openPrev: [...ids(j.unfixedPrev), ...ids(j.summaryOpen)], legacy: !Array.isArray(j.unfixedPrev) };
  } catch {
    return { findings: [], verdict: "approve", openPrev: [], legacy: true };
  }
}

/**
 * What each accepted id was, for telling the AI (it re-words titles, so fingerprints alone miss re-reports): the newest
 * stored finding or carried item with that id, else our thread on GitLab (legacy rows), else the bare id.
 */
export function acceptedItems(db: Db, ownerId: number, mrId: number, dryRun: boolean, ds: Discussion[]): AcceptedItem[] {
  const known = knownItems(db, ownerId, mrId, dryRun, ds);
  return acceptedFindings(db, ownerId, mrId, dryRun).map((a) => {
    const { body: _, ...k } = known.get(a.sentinel) ?? { id: a.sentinel, file: "?", title: `(id ${a.sentinel})` };
    return { ...k, reason: a.reason, ...(a.source === "ai-reply" ? { viaReply: true } : {}) };
  });
}

type KnownItem = Omit<AcceptedItem, "reason"> & { body?: string };

/** What each id on this MR was: the newest stored finding or carried item with that id, else our thread on GitLab (legacy rows). */
function knownItems(db: Db, ownerId: number, mrId: number, dryRun: boolean, ds: Discussion[]): Map<string, KnownItem> {
  const known = new Map<string, KnownItem>();
  for (const json of doneFindingsJson(db, ownerId, mrId, dryRun)) {
    try {
      const j = JSON.parse(json);
      for (const x of Array.isArray(j?.summaryOpen) ? j.summaryOpen : []) if (x?.id && !known.has(x.id)) known.set(x.id, { id: x.id, file: x.file, line: x.line, title: x.title });
      for (const f of Array.isArray(j?.findings) ? (j.findings as Finding[]) : []) {
        const id = fp(f);
        if (!known.has(id) || known.get(id)!.severity === undefined) known.set(id, { id, file: f.file, line: f.line, title: f.title, severity: f.severity, body: f.body });
      }
    } catch {
      // unreadable row: fall through to GitLab / bare id
    }
  }
  for (const d of ds) {
    const n = d.notes[0];
    const id = n && n.author?.id === ownerId && hasMarker(n.body) && n.position?.new_path ? n.body.match(/<!-- sentinel:([0-9a-f]{12}) -->/)?.[1] : undefined;
    if (!id || known.has(id)) continue;
    const [head, ...rest] = n!.body.split("\n");
    const body = rest.filter((l) => !(l.startsWith("> ") && l.includes("/argus accept")) && !l.includes("<!-- sentinel:")).join("\n").trim(); // drop the hint line and marker
    known.set(id, { id, file: n!.position!.new_path!, line: n!.position!.new_line ?? undefined, title: head!.replace(/^.*?\*\*:\s*/, ""), severity: head!.match(/\*\*(blocker|major|minor|nit)\*\*:/)?.[1], body });
  }
  return known;
}

const hasMarker = (b: string) => b.startsWith(MARKER);
const SENTINEL = /<!-- sentinel:([0-9a-f]{12}) -->/g;

/** Ids an Argus note by `authorId` carries on this MR (that reviewer's items). */
const idsBy = (ds: Discussion[], authorId: number) =>
  ds.flatMap((d) => d.notes.filter((n) => n.author?.id === authorId && hasMarker(n.body)).flatMap((n) => [...n.body.matchAll(SENTINEL)].map((m) => m[1]!)));

const MSG = {
  zh: {
    accepted: (r: string) => `${MARKER} · ✅ 已接受${r ? `（原因：${r}）` : ""}。此項不再列入「仍存在」，也不計入結論。`,
    notReviewer: (who: string) => `${MARKER} · 只有審查者 @${who} 能標記接受。不打算修改的話，MR 作者或指派對象可改用 \`/argus reply <原因>\` 由 AI 判斷，或回覆原因讓 @${who} 判斷。`,
    threadFormat: (id: string) => `${MARKER} · 指令格式錯誤：在此 thread 回覆 \`/argus accept <原因>\` 即可；若帶 id，須與本項 \`#${id.slice(0, 6)}\` 相同。`,
    format: `${MARKER} · 指令格式錯誤：請用 \`/argus accept #短id <原因>\`，短 id 是各項發現旁的 \`#xxxxxx\`（inline 討論可直接在該 thread 回覆 \`/argus accept\`）。`,
    notFound: (id: string) => `${MARKER} · 找不到待處理的 \`#${id}\`：可能已修正、已接受，或不屬於這張 MR。`,
    ambiguous: (id: string) => `${MARKER} · \`#${id}\` 對應多項，請改用完整 12 碼 id（留言原始碼的 \`sentinel:\` 標記）。`,
    summary: (n: number, left: number, v: string, moved: boolean) =>
      `${MARKER} · 已接受 ${n} 項，剩 ${left} 項，結論更新為：**${v}**${moved ? "（MR 已有新 commit，下一輪審查會沿用此裁決）" : ""}`,
    replyThreadFormat: (id: string) => `${MARKER} · 指令格式錯誤：在此 thread 回覆 \`/argus reply <原因>\`（原因必填）；若帶 id，須與本項 \`#${id.slice(0, 6)}\` 相同。`,
    replyFormat: `${MARKER} · 指令格式錯誤：請用 \`/argus reply #短id <原因>\`（原因必填），短 id 是各項發現旁的 \`#xxxxxx\`（inline 討論可直接在該 thread 回覆 \`/argus reply <原因>\`）。`,
    useAccept: `${MARKER} · 審查者請直接用 \`/argus accept\` 接受此項；\`/argus reply\` 是給 MR 作者與指派對象用的。`,
    notAuthor: (who: string) => `${MARKER} · 只有 MR 作者或指派對象能用 \`/argus reply\`。要接受此項請由審查者 @${who} 用 \`/argus accept\`。`,
    waitRound: `${MARKER} · MR 已有新 commit、這輪審查還沒涵蓋，暫不判斷。請等下一輪審查完成後再留言 \`/argus reply\`。`,
    cannotJudge: (who: string) => `${MARKER} · AI 這次無法判斷此回覆，此項維持開啟，請審查者 @${who} 決定是否 \`/argus accept\`。`,
    rejected: (r: string, who: string) => `${MARKER} · AI 判斷此回覆不足以推翻本項：${r}。此項維持開啟；仍有異議請審查者 @${who} 決定。`,
    aiAccepted: (r: string) => `${MARKER} · ✅ 依作者回覆經 AI 判斷接受（AI：${r}）。此項不再列入「仍存在」，也不計入結論。`,
    suggest: (r: string, sev: string, who: string) => `${MARKER} · AI 判斷此回覆成立，建議接受：${r}。本項為 **${sev}**，須由審查者 @${who} 以 \`/argus accept\` 決定。`,
  },
  en: {
    accepted: (r: string) => `${MARKER} · ✅ Accepted${r ? ` (reason: ${r})` : ""}. No longer listed as open and excluded from the verdict.`,
    notReviewer: (who: string) => `${MARKER} · Only the reviewer @${who} can accept a finding. If you won't change it, the MR author or an assignee can use \`/argus reply <reason>\` to have the AI judge it, or reply with the reason so @${who} can decide.`,
    threadFormat: (id: string) => `${MARKER} · Invalid command: reply \`/argus accept <reason>\` in this thread; an id, if given, must be this item's \`#${id.slice(0, 6)}\`.`,
    format: `${MARKER} · Invalid command: use \`/argus accept #shortid <reason>\`; the short id is the \`#xxxxxx\` next to each finding (in an inline thread just reply \`/argus accept\`).`,
    notFound: (id: string) => `${MARKER} · No open item \`#${id}\`: it may be fixed, already accepted, or not on this MR.`,
    ambiguous: (id: string) => `${MARKER} · \`#${id}\` matches several items; use the full 12-hex id (the \`sentinel:\` marker in the comment source).`,
    summary: (n: number, left: number, v: string, moved: boolean) =>
      `${MARKER} · Accepted ${n} item(s), ${left} left, verdict now: **${v}**${moved ? " (the MR has a new commit; the next round keeps this decision)" : ""}`,
    replyThreadFormat: (id: string) => `${MARKER} · Invalid command: reply \`/argus reply <reason>\` in this thread (the reason is required); an id, if given, must be this item's \`#${id.slice(0, 6)}\`.`,
    replyFormat: `${MARKER} · Invalid command: use \`/argus reply #shortid <reason>\` (the reason is required); the short id is the \`#xxxxxx\` next to each finding (in an inline thread just reply \`/argus reply <reason>\`).`,
    useAccept: `${MARKER} · As the reviewer, use \`/argus accept\` to accept this item; \`/argus reply\` is for the MR author and assignees.`,
    notAuthor: (who: string) => `${MARKER} · Only the MR author or an assignee can use \`/argus reply\`. To accept this item, the reviewer @${who} can use \`/argus accept\`.`,
    waitRound: `${MARKER} · The MR has a new commit this round did not review, so no judgement now. Please post \`/argus reply\` again after the next review round.`,
    cannotJudge: (who: string) => `${MARKER} · The AI could not judge this reply; the item stays open for the reviewer @${who} to decide (\`/argus accept\`).`,
    rejected: (r: string, who: string) => `${MARKER} · The AI does not find that this reply refutes the item: ${r}. It stays open; the reviewer @${who} can still decide.`,
    aiAccepted: (r: string) => `${MARKER} · ✅ Accepted on the author's reply after AI judgement (AI: ${r}). No longer listed as open and excluded from the verdict.`,
    suggest: (r: string, sev: string, who: string) => `${MARKER} · The AI finds this reply valid and suggests accepting it: ${r}. This item is **${sev}**, so the reviewer @${who} decides with \`/argus accept\`.`,
  },
};

const CLOSED = "closed";
/** Per-process "last seen" stamp per (owner, MR, mode); a restart costs one discussion read per watched MR. */
export const acceptWatch = new Map<string, string>();

/**
 * Accept watch, once per poll cycle per user: MRs whose latest done review (last 30 days) still has unaccepted items,
 * has any accepts (to retry a failed resolve), has accepts not yet announced, or predates `unfixedPrev` (legacy: its open inline threads are only visible on GitLab).
 * Discussions are read only when the MR's `user_notes_count`/`updated_at` changed since the last look (or an accept
 * still awaits its verdict note); the stamp comes
 * from this cycle's reviewer listing when the MR is in it, else from one GET of the MR (self-reviews are never listed).
 * Each MR is isolated (a failure is logged; the stamp is kept so it is retried next cycle).
 */
export async function watchAccepts(cfg: Config, db: Db, user: User, rt: UserRuntime, listed: MrSummary[], queue: ReviewQueue, stamps = acceptWatch): Promise<void> {
  const dryRun = cfg.dryRun; // snapshot, like reviewMr
  const me = user.gitlabUserId;
  const byId = new Map(listed.map((m) => [m.id, m]));
  for (const row of watchCandidates(db, me, dryRun)) {
    const key = `${me}:${row.mr_id}:${dryRun ? 1 : 0}`;
    if (stamps.get(key) === CLOSED) continue;
    const st = stored(row.findings_json);
    const accepted = acceptedIds(db, me, row.mr_id, dryRun);
    const unannounced = unannouncedAccepts(db, me, row.mr_id, dryRun).length > 0;
    // Nothing left to accept. MRs with accepts stay watched: a thread whose resolve failed is closed by the next job.
    if (!st.legacy && !unannounced && !accepted.size && ![...st.findings.map(fp), ...st.openPrev].some((id) => !accepted.has(id))) continue;
    try {
      const mr = byId.get(row.mr_id) ?? (await rt.gl.getMr(row.project_id, row.mr_iid));
      if (mr.state && mr.state !== "opened") {
        stamps.set(key, CLOSED);
        continue;
      }
      const stamp = mr.user_notes_count === undefined && mr.updated_at === undefined ? undefined : `${mr.user_notes_count}|${mr.updated_at}`;
      if (stamp && stamps.get(key) === stamp && !unannounced) continue;
      await queue.enqueue(laneFor(engineFields(user), cfg.ownerEngineTestUsers), `accept:${key}`, async () => { // same lane rule as this reviewer's reviews: never interleaves with them
        try {
          await acceptJob(cfg, db, user, rt, row.mr_id, dryRun);
          if (stamp) stamps.set(key, stamp);
        } catch (e) {
          console.error(`[accept] ${user.username} ${row.project_id}!${row.mr_iid} failed:`, (e as Error).message);
        }
      }).done;
    } catch (e) {
      console.error(`[accept] ${user.username} ${row.project_id}!${row.mr_iid} failed:`, (e as Error).message);
    }
  }
}

/**
 * Runs in the reviewer's queue lane (after any review of theirs queued earlier), so it re-reads the latest done row here: a review that finished while this job waited
 * must not be recomputed from stale data (that review already marked the accepts it saw as announced).
 */
async function acceptJob(cfg: Config, db: Db, user: User, rt: UserRuntime, mrId: number, dryRun: boolean): Promise<void> {
  const row = latestDone(db, user.gitlabUserId, mrId, dryRun);
  if (!row) return;
  const st = stored(row.findings_json);
  await announce(db, user, rt, row, st, await handleCommands(cfg, db, user, rt, row, st, dryRun), dryRun);
}

const tagOf = (row: WatchRow) => `${row.project_id}!${row.mr_iid}`;

/**
 * Best-effort resolve of our open threads whose finding is accepted: just accepted, or an earlier resolve that failed
 * (later rounds skip accepted threads, so this is their only way to close). Resolve only, no reply; never in dry-run.
 */
export async function resolveAccepted(gl: GitLab, projectId: number, iid: number, threads: AiThread[], accepted: Set<string>, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  for (const t of threads.filter((x) => accepted.has(x.id))) {
    await gl.resolveDiscussion(projectId, iid, t.discussionId).catch((e) => console.warn(`[accept] resolve failed ${projectId}!${iid} thread ${t.discussionId}: ${(e as Error).message}`));
  }
}

/** Parses and answers new commands; returns our open inline threads (read anyway) for the recompute. */
async function handleCommands(cfg: Config, db: Db, user: User, rt: UserRuntime, row: WatchRow, st: Stored, dryRun: boolean): Promise<AiThread[]> {
  const me = user.gitlabUserId;
  const M = user.language.startsWith("zh") ? MSG.zh : MSG.en;
  const ds = await rt.gl.listDiscussions(row.project_id, row.mr_iid);
  const threads = openAiThreads(ds, me);
  const accepted = acceptedIds(db, me, row.mr_id, dryRun);
  // Open items: the latest round's findings, what it left open, and our still-open inline threads (covers rows
  // recorded before unfixedPrev was stored).
  const openPrev = [...st.openPrev, ...threads.map((t) => t.id)];
  const pending = () => [...new Set([...st.findings.map(fp), ...openPrev])].filter((id) => !accepted.has(id));
  // Other Argus reviewers on this MR answer for their own items; unattributable errors are answered by one of us only.
  const argusAuthors = new Set(ds.flatMap((d) => d.notes.filter((n) => n.author && hasMarker(n.body)).map((n) => n.author!.id)));
  const othersOwn = (prefix: string) => [...argusAuthors].some((a) => a !== me && idsBy(ds, a).some((id) => id.startsWith(prefix)));
  const answerUnattributable = Math.min(me, ...argusAuthors) === me;

  const say = async (discussionId: string, body: string) => {
    if (dryRun) return console.log(`[DRY_RUN] would reply on ${tagOf(row)} (discussion ${discussionId}):\n${body}\n---`);
    await rt.gl.replyDiscussion(row.project_id, row.mr_iid, discussionId, body).catch((e) => console.warn(`[accept] reply failed ${tagOf(row)}: ${(e as Error).message}`));
  };
  const refuse = async (d: Discussion, noteId: number, body: string) => {
    if (handleNote(db, { ownerId: me, noteId, dryRun })) await say(d.id, body);
  };
  // A top-level command note is its own resolvable discussion: close it once handled (refusals stay open for humans).
  const closeCommand = async (d: Discussion, noteId: number) => {
    const first = d.notes[0];
    if (first?.id === noteId && first.resolvable && !first.resolved && !dryRun) {
      await rt.gl.resolveDiscussion(row.project_id, row.mr_iid, d.id).catch((e) => console.warn(`[accept] resolve command failed ${tagOf(row)}: ${(e as Error).message}`));
    }
  };
  let mrP: Promise<Mr> | undefined; // fetched once, only when a reply needs it
  let checkoutP: Promise<string> | undefined; // the reviewed head, checked out once per job for all replies
  const checkout = (mr: Mr) => (checkoutP ??= prepareCheckout(cfg, rt, me, mr));
  let known: Map<string, KnownItem> | undefined;

  for (const d of ds) {
    const first = d.notes[0];
    const inlineId = first?.position?.new_path && first.author && hasMarker(first.body) ? first.body.match(/<!-- sentinel:([0-9a-f]{12}) -->/)?.[1] : undefined;
    const threadOwner = inlineId ? first!.author!.id : undefined;
    for (const n of d.notes) {
      if (n.system || n.id === undefined || !n.author) continue;
      const accept = parseAccept(n.body);
      const isReply = !accept;
      const cmd = accept ?? parseReply(n.body);
      if (!cmd) continue;
      let target: string;
      if (inlineId) {
        if (threadOwner !== me) continue; // another reviewer's thread
        if ("bad" in cmd || (cmd.id && !inlineId.startsWith(cmd.id))) { await refuse(d, n.id, (isReply ? M.replyThreadFormat : M.threadFormat)(inlineId)); continue; }
        if (!pending().includes(inlineId)) { await refuse(d, n.id, M.notFound(inlineId.slice(0, 6))); continue; }
        target = inlineId;
      } else {
        if ("bad" in cmd || !cmd.id) { if (answerUnattributable) await refuse(d, n.id, isReply ? M.replyFormat : M.format); continue; }
        const hits = pending().filter((id) => id.startsWith(cmd.id!));
        if (!hits.length) { if (!othersOwn(cmd.id) && answerUnattributable) await refuse(d, n.id, M.notFound(cmd.id)); continue; }
        if (n.author.id !== me && argusAuthors.has(n.author.id) && othersOwn(cmd.id)) continue; // another reviewer accepting its own item
        if (hits.length > 1) { await refuse(d, n.id, M.ambiguous(cmd.id)); continue; }
        target = hits[0]!;
      }
      const reason = cmd.reason.replace(/\s+/g, " ").slice(0, 500);
      if (isReply) {
        if (noteHandled(db, me, n.id, dryRun)) continue; // answered in an earlier job: no MR fetch
        // Authorization is the GitLab ids (note author vs. the MR's author/assignees), never anything in the text.
        if (n.author.id === me) { await refuse(d, n.id, M.useAccept); continue; }
        const mr = await (mrP ??= rt.gl.getMr(row.project_id, row.mr_iid));
        const by = n.author.id;
        if (by !== mr.author?.id && !mr.assignees?.some((a) => a.id === by)) { await refuse(d, n.id, M.notAuthor(user.username)); continue; }
        if (mr.sha !== row.head_sha) { await refuse(d, n.id, M.waitRound); continue; } // judge only against the code this round reviewed
        // Claimed before the engine runs: a failed or unparsable judgement is answered, never retried (the author can reply again).
        if (!handleNote(db, { ownerId: me, noteId: n.id, dryRun })) continue;
        try {
          const item = (known ??= knownItems(db, me, row.mr_id, dryRun, ds)).get(target);
          const j = item ? await judgeReply(rt, () => checkout(mr), item, reason, user.language, tagOf(row)) : undefined;
          if (!j) { await say(d.id, M.cannotJudge(user.username)); continue; }
          // The head may have moved while the engine ran: that judgement is about code no longer at the head.
          const now = await rt.gl.getMr(row.project_id, row.mr_iid);
          mrP = Promise.resolve(now);
          if (now.sha !== row.head_sha) { await say(d.id, M.waitRound); continue; }
          if (!j.replyHolds) await say(d.id, M.rejected(noMention(j.rationale), user.username));
          else if (item!.severity === "minor" || item!.severity === "nit") {
            // Only minor/nit: the AI never accepts major/blocker (or an item whose severity is unknown) on its own.
            recordAccept(db, { ownerId: me, noteId: n.id, dryRun }, { mrId: row.mr_id, sentinel: target, reason: noMention(`${reason} (AI: ${j.rationale})`), by, source: "ai-reply" });
            accepted.add(target);
            await say(d.id, M.aiAccepted(noMention(j.rationale)));
            await closeCommand(d, n.id);
          } else await say(d.id, M.suggest(noMention(j.rationale), item!.severity ?? "?", user.username));
        } catch (e) {
          // The note is already claimed: never leave the author without an answer.
          console.warn(`[reply] ${tagOf(row)}: ${(e as Error).message}`);
          await say(d.id, M.cannotJudge(user.username));
        }
        continue;
      }
      // Authorization is the GitLab note author id, never anything in the text.
      if (n.author.id !== me) { await refuse(d, n.id, M.notReviewer(user.username)); continue; }
      if (!handleNote(db, { ownerId: me, noteId: n.id, dryRun }, { mrId: row.mr_id, sentinel: target, reason, by: n.author.id })) continue;
      accepted.add(target);
      await say(d.id, M.accepted(reason));
      await closeCommand(d, n.id);
    }
  }
  await resolveAccepted(rt.gl, row.project_id, row.mr_iid, threads, accepted, dryRun);
  return threads;
}

/**
 * Publishes accepts not yet announced: recompute from the stored round (no AI run), post the verdict note, mark them
 * announced only after the note succeeded (a crash or failed note is redone next cycle), then the usual approval rules.
 */
async function announce(db: Db, user: User, rt: UserRuntime, row: WatchRow, st: Stored, threads: AiThread[], dryRun: boolean): Promise<void> {
  const me = user.gitlabUserId;
  const pendingIds = unannouncedAccepts(db, me, row.mr_id, dryRun);
  if (!pendingIds.length) return;
  const M = user.language.startsWith("zh") ? MSG.zh : MSG.en;
  // Open inline threads (from the command pass) count as unfixed previous items.
  const r = afterAccept(st.findings, [...st.openPrev, ...threads.map((t) => t.id)], acceptedIds(db, me, row.mr_id, dryRun), st.verdict);
  const mr = await rt.gl.getMr(row.project_id, row.mr_iid); // fresh: the head may have moved while the job waited
  const moved = mr.sha !== row.head_sha; // a newer head is not what was reviewed: never approve it from here
  const note = M.summary(pendingIds.length, r.remaining.length + r.unfixed.length, verdictLabel(user.language, r.verdict), moved);
  if (dryRun) console.log(`[DRY_RUN] would post note on ${mr.web_url}:\n${note}\n---`);
  else {
    try {
      await rt.gl.postNote(row.project_id, row.mr_iid, note);
    } catch (e) {
      return console.warn(`[accept] verdict note failed ${mr.web_url} (retried next cycle): ${(e as Error).message}`);
    }
  }
  markAnnounced(db, me, row.mr_id, dryRun, pendingIds);
  console.log(`[accept] ${user.username} ${tagOf(row)}: ${pendingIds.length} accepted, verdict ${r.verdict}`);
  if (moved) return;
  await syncApproval(rt.gl, db, mr, nextRound(db, me, row.mr_id, dryRun) - 1, user.language, {
    autoApprove: user.autoApprove, dryRun, replay: false, selfReview: row.self_review === 1, verdict: r.verdict,
    findings: r.remaining, unfixedPrev: r.unfixed.length, authorId: mr.author?.id, userId: me,
  });
}

/** AI text posted on the MR must not ping anyone. */
const noMention = (s: string) => s.replace(/@/g, "＠");

/**
 * `/argus reply` judgement: checks out the reviewed head (the reviewer's own clone, as a review does) and asks the reviewer's
 * engine about this one finding only. Any failure (no engine, git/GitLab error, engine error, unparsable output) is undefined.
 */
async function judgeReply(rt: UserRuntime, checkout: () => Promise<string>, item: KnownItem, reason: string, language: string, tag: string): Promise<Judgement | undefined> {
  if (!rt.engine?.judge) return undefined;
  try {
    const dir = await checkout();
    const input: JudgeInput = {
      cwd: dir, language, reason,
      finding: { file: item.file, line: item.line, severity: item.severity, title: item.title, body: item.body ?? "" },
      snippet: snippetAt(dir, item.file, item.line),
    };
    const j = parseJudgement(await rt.engine.judge(input));
    if (!j) console.warn(`[reply] ${tag}: unparsable judgement`);
    return j;
  } catch (e) {
    console.warn(`[reply] ${tag}: judgement failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** The reviewed head (`mr.sha`) checked out in the reviewer's own clone, as a review does; returns its directory. */
async function prepareCheckout(cfg: Config, rt: UserRuntime, me: number, mr: Mr): Promise<string> {
  if (!mr.diff_refs) throw new Error("diff_refs not ready");
  const project = await rt.gl.getProject(mr.project_id);
  const prep = await (rt.prepare ?? prepareDiff)({
    dataDir: cfg.dataDir, ownerId: me, token: await rt.token(), repoUrl: project.http_url_to_repo, projectId: mr.project_id, iid: mr.iid,
    baseSha: mr.diff_refs.base_sha, headSha: mr.sha, excludeGlobs: cfg.excludeGlobs,
  });
  return prep.dir;
}

/** The cited file around `line` (numbered), read from the checkout; never outside it (symlinks included). */
export function snippetAt(dir: string, file: string, line?: number, radius = 40): string {
  const outside = `(${file}: outside the repository)`;
  let text: string;
  try {
    const root = realpathSync(dir);
    const p = resolve(root, file);
    if (!p.startsWith(root + sep)) return outside;
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      return `(${file}: no such file at this head)`;
    }
    if (!real.startsWith(root + sep)) return outside; // a symlink pointing out of the checkout
    text = readFileSync(real, "utf8");
  } catch {
    return `(${file}: no such file at this head)`;
  }
  const lines = text.split("\n");
  const from = line ? Math.max(1, line - radius) : 1;
  const to = Math.min(lines.length, line ? line + radius : 2 * radius);
  return `${file} lines ${from}-${to} of ${lines.length}:\n${lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join("\n")}`;
}
