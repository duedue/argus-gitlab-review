import { blockers, syncApproval } from "./approve.ts";
import type { Config } from "./config.ts";
import { acceptedFindings, acceptedIds, doneFindingsJson, handleNote, latestDone, markAnnounced, nextRound, unannouncedAccepts, watchCandidates, type Db, type WatchRow } from "./db.ts";
import { deriveVerdict, type Finding, type Verdict } from "./findings.ts";
import type { Discussion, GitLab, MrSummary } from "./gitlab.ts";
import { laneFor, type AcceptedItem } from "./engine.ts";
import { MARKER, fp, openAiThreads, verdictLabel, type AiThread } from "./publisher.ts";
import type { ReviewQueue } from "./queue.ts";
import type { UserRuntime } from "./review.ts";
import { engineFields, type User } from "./users.ts";

/**
 * `/argus accept [#id] [reason]`, strictly at the start of a note. undefined = not an accept command at all;
 * `bad` = it is one but the id is malformed. The id is 6-12 hex (a fingerprint prefix); case-insensitive.
 */
export function parseAccept(body: string): { id?: string; reason: string } | { bad: true } | undefined {
  const m = body.trim().match(/^\/argus[ \t]+accept(?![^\s])([\s\S]*)$/i);
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
  const known = new Map<string, Omit<AcceptedItem, "reason">>();
  for (const json of doneFindingsJson(db, ownerId, mrId, dryRun)) {
    try {
      const j = JSON.parse(json);
      for (const x of Array.isArray(j?.summaryOpen) ? j.summaryOpen : []) if (x?.id && !known.has(x.id)) known.set(x.id, { id: x.id, file: x.file, line: x.line, title: x.title });
      for (const f of Array.isArray(j?.findings) ? (j.findings as Finding[]) : []) {
        const id = fp(f);
        if (!known.has(id) || known.get(id)!.severity === undefined) known.set(id, { id, file: f.file, line: f.line, title: f.title, severity: f.severity });
      }
    } catch {
      // unreadable row: fall through to GitLab / bare id
    }
  }
  for (const d of ds) {
    const n = d.notes[0];
    const id = n && n.author?.id === ownerId && hasMarker(n.body) && n.position?.new_path ? n.body.match(/<!-- sentinel:([0-9a-f]{12}) -->/)?.[1] : undefined;
    if (!id || known.has(id)) continue;
    const head = n!.body.split("\n")[0]!;
    known.set(id, { id, file: n!.position!.new_path!, line: n!.position!.new_line ?? undefined, title: head.replace(/^.*?\*\*:\s*/, ""), severity: head.match(/\*\*(blocker|major|minor|nit)\*\*:/)?.[1] });
  }
  return acceptedFindings(db, ownerId, mrId, dryRun).map((a) => ({ ...(known.get(a.sentinel) ?? { id: a.sentinel, file: "?", title: `(id ${a.sentinel})` }), reason: a.reason }));
}

const hasMarker = (b: string) => b.startsWith(MARKER);
const SENTINEL = /<!-- sentinel:([0-9a-f]{12}) -->/g;

/** Ids an Argus note by `authorId` carries on this MR (that reviewer's items). */
const idsBy = (ds: Discussion[], authorId: number) =>
  ds.flatMap((d) => d.notes.filter((n) => n.author?.id === authorId && hasMarker(n.body)).flatMap((n) => [...n.body.matchAll(SENTINEL)].map((m) => m[1]!)));

const MSG = {
  zh: {
    accepted: (r: string) => `${MARKER} · ✅ 已接受${r ? `（原因：${r}）` : ""}。此項不再列入「仍存在」，也不計入結論。`,
    notReviewer: (who: string) => `${MARKER} · 只有審查者 @${who} 能標記接受。不打算修改的話，請回覆原因讓 @${who} 判斷。`,
    threadFormat: (id: string) => `${MARKER} · 指令格式錯誤：在此 thread 回覆 \`/argus accept <原因>\` 即可；若帶 id，須與本項 \`#${id.slice(0, 6)}\` 相同。`,
    format: `${MARKER} · 指令格式錯誤：請用 \`/argus accept #短id <原因>\`，短 id 是各項發現旁的 \`#xxxxxx\`（inline 討論可直接在該 thread 回覆 \`/argus accept\`）。`,
    notFound: (id: string) => `${MARKER} · 找不到待處理的 \`#${id}\`：可能已修正、已接受，或不屬於這張 MR。`,
    ambiguous: (id: string) => `${MARKER} · \`#${id}\` 對應多項，請改用完整 12 碼 id（留言原始碼的 \`sentinel:\` 標記）。`,
    summary: (n: number, left: number, v: string, moved: boolean) =>
      `${MARKER} · 已接受 ${n} 項，剩 ${left} 項，結論更新為：**${v}**${moved ? "（MR 已有新 commit，下一輪審查會沿用此裁決）" : ""}`,
  },
  en: {
    accepted: (r: string) => `${MARKER} · ✅ Accepted${r ? ` (reason: ${r})` : ""}. No longer listed as open and excluded from the verdict.`,
    notReviewer: (who: string) => `${MARKER} · Only the reviewer @${who} can accept a finding. If you won't change it, reply with the reason so @${who} can decide.`,
    threadFormat: (id: string) => `${MARKER} · Invalid command: reply \`/argus accept <reason>\` in this thread; an id, if given, must be this item's \`#${id.slice(0, 6)}\`.`,
    format: `${MARKER} · Invalid command: use \`/argus accept #shortid <reason>\`; the short id is the \`#xxxxxx\` next to each finding (in an inline thread just reply \`/argus accept\`).`,
    notFound: (id: string) => `${MARKER} · No open item \`#${id}\`: it may be fixed, already accepted, or not on this MR.`,
    ambiguous: (id: string) => `${MARKER} · \`#${id}\` matches several items; use the full 12-hex id (the \`sentinel:\` marker in the comment source).`,
    summary: (n: number, left: number, v: string, moved: boolean) =>
      `${MARKER} · Accepted ${n} item(s), ${left} left, verdict now: **${v}**${moved ? " (the MR has a new commit; the next round keeps this decision)" : ""}`,
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
          await acceptJob(db, user, rt, row.mr_id, dryRun);
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
async function acceptJob(db: Db, user: User, rt: UserRuntime, mrId: number, dryRun: boolean): Promise<void> {
  const row = latestDone(db, user.gitlabUserId, mrId, dryRun);
  if (!row) return;
  const st = stored(row.findings_json);
  await announce(db, user, rt, row, st, await handleCommands(db, user, rt, row, st, dryRun), dryRun);
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
async function handleCommands(db: Db, user: User, rt: UserRuntime, row: WatchRow, st: Stored, dryRun: boolean): Promise<AiThread[]> {
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

  for (const d of ds) {
    const first = d.notes[0];
    const inlineId = first?.position?.new_path && first.author && hasMarker(first.body) ? first.body.match(/<!-- sentinel:([0-9a-f]{12}) -->/)?.[1] : undefined;
    const threadOwner = inlineId ? first!.author!.id : undefined;
    for (const n of d.notes) {
      if (n.system || n.id === undefined || !n.author) continue;
      const cmd = parseAccept(n.body);
      if (!cmd) continue;
      let target: string;
      if (inlineId) {
        if (threadOwner !== me) continue; // another reviewer's thread
        if ("bad" in cmd || (cmd.id && !inlineId.startsWith(cmd.id))) { await refuse(d, n.id, M.threadFormat(inlineId)); continue; }
        if (!pending().includes(inlineId)) { await refuse(d, n.id, M.notFound(inlineId.slice(0, 6))); continue; }
        target = inlineId;
      } else {
        if ("bad" in cmd || !cmd.id) { if (answerUnattributable) await refuse(d, n.id, M.format); continue; }
        const hits = pending().filter((id) => id.startsWith(cmd.id!));
        if (!hits.length) { if (!othersOwn(cmd.id) && answerUnattributable) await refuse(d, n.id, M.notFound(cmd.id)); continue; }
        if (n.author.id !== me && argusAuthors.has(n.author.id) && othersOwn(cmd.id)) continue; // another reviewer accepting its own item
        if (hits.length > 1) { await refuse(d, n.id, M.ambiguous(cmd.id)); continue; }
        target = hits[0]!;
      }
      // Authorization is the GitLab note author id, never anything in the text.
      if (n.author.id !== me) { await refuse(d, n.id, M.notReviewer(user.username)); continue; }
      const reason = cmd.reason.replace(/\s+/g, " ").slice(0, 500);
      if (!handleNote(db, { ownerId: me, noteId: n.id, dryRun }, { mrId: row.mr_id, sentinel: target, reason, by: n.author.id })) continue;
      accepted.add(target);
      await say(d.id, M.accepted(reason));
      // A top-level command note is its own resolvable discussion: close it once handled (refusals stay open for humans).
      const first = d.notes[0];
      if (first?.id === n.id && first.resolvable && !first.resolved && !dryRun) {
        await rt.gl.resolveDiscussion(row.project_id, row.mr_iid, d.id).catch((e) => console.warn(`[accept] resolve command failed ${tagOf(row)}: ${(e as Error).message}`));
      }
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
