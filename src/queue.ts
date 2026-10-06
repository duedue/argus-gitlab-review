/**
 * In-process review queue shared by the poller, the trigger API, the retry sweep and accept jobs.
 * - Lane = reviewer (GitLab user id): one user's jobs run strictly one after another, in enqueue order. Everything that
 *   must not interleave for one MR (a review and an accept job of the same reviewer) is keyed to that reviewer's lane.
 * - Different lanes run in parallel, at most `limit` jobs at once (global cap; each job may be a `claude -p` process).
 * - Items are deduped by key while queued/running; claimReview remains the final (atomic, DB) gate.
 */
export const DEFAULT_CONCURRENCY = 3;

export class ReviewQueue {
  private lanes = new Map<number, Promise<void>>(); // tail of each lane
  private pending = new Map<string, Promise<void>>();
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(readonly limit = DEFAULT_CONCURRENCY) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("queue concurrency must be an integer >= 1");
  }

  /** `queued:false` means an identical item is already queued/running; `done` then settles with that one. */
  enqueue(lane: number, key: string, job: () => Promise<void>): { queued: boolean; done: Promise<void> } {
    const existing = this.pending.get(key);
    if (existing) return { queued: false, done: existing };
    const done: Promise<void> = (this.lanes.get(lane) ?? Promise.resolve())
      .then(() => this.withSlot(job))
      .catch((e) => console.error("[queue] job failed:", (e as Error).message))
      .finally(() => {
        this.pending.delete(key);
        if (this.lanes.get(lane) === done) this.lanes.delete(lane);
      });
    this.lanes.set(lane, done);
    this.pending.set(key, done);
    return { queued: true, done };
  }

  private async withSlot(job: () => Promise<void>): Promise<void> {
    while (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /** Resolves when everything enqueued so far (and anything those jobs enqueue) has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending.values());
  }
}

/** Global cap from env REVIEW_CONCURRENCY (integer >= 1); unset/invalid -> 3. */
export function concurrencyFrom(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.REVIEW_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_CONCURRENCY;
}

export const reviewQueue = new ReviewQueue(concurrencyFrom());
export const queueKey = (ownerId: number, mrId: number, headSha: string): string => `${ownerId}:${mrId}:${headSha}`;
