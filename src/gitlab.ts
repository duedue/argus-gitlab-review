export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

export interface MrSummary {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  draft?: boolean;
  work_in_progress?: boolean;
  sha: string;
  web_url: string;
  target_branch: string;
  state?: string;
  author?: { id: number; username?: string };
  reviewers?: { id: number; username: string }[];
  updated_at?: string; // with user_notes_count: cheap "anything new?" stamp for the accept watch
  user_notes_count?: number;
}

export interface Mr extends MrSummary {
  diff_refs: DiffRefs; // GitLab returns null for a few seconds after creation; reviewMr waits for it
}

export interface Project {
  id: number;
  http_url_to_repo: string;
  path_with_namespace: string;
}

export interface Discussion {
  id: string;
  notes: { id?: number; body: string; system?: boolean; author?: { id: number; username?: string }; resolvable?: boolean; resolved?: boolean; position?: { new_path?: string; new_line?: number | null } }[];
}

/**
 * Thin GitLab REST client. The token only lives here (and in repo.ts's per-command git header).
 * `token` may be a provider so OAuth tokens are refreshed per request (a review can outlive a 2h token).
 * `bearer` selects the OAuth `Authorization: Bearer` header instead of PRIVATE-TOKEN (PATs).
 */
export class GitLab {
  constructor(private cfg: { gitlabUrl: string; token: string | (() => string | Promise<string>); bearer?: boolean }) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<{ data: T; next?: string }> {
    const token = typeof this.cfg.token === "function" ? await this.cfg.token() : this.cfg.token;
    const res = await fetch(`${this.cfg.gitlabUrl}/api/v4${path}`, {
      method,
      headers: { ...(this.cfg.bearer ? { Authorization: `Bearer ${token}` } : { "PRIVATE-TOKEN": token }), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      // Never include request headers; truncate body.
      throw Object.assign(new Error(`GitLab ${method} ${path.split("?")[0]} -> ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
    }
    return { data: (await res.json()) as T, next: res.headers.get("x-next-page") || undefined };
  }

  private async paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let page: string | undefined = "1";
    const sep = path.includes("?") ? "&" : "?";
    while (page) {
      const r: { data: T[]; next?: string } = await this.req("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...r.data);
      page = r.next;
    }
    return out;
  }

  async currentUser(): Promise<{ id: number; username: string }> {
    return (await this.req<{ id: number; username: string }>("GET", "/user")).data;
  }

  /** Metadata of the PAT in use (scopes + expiry). Fails for non-PAT tokens. */
  async tokenInfo(): Promise<{ scopes: string[]; active: boolean; expires_at: string | null }> {
    return (await this.req<{ scopes: string[]; active: boolean; expires_at: string | null }>("GET", "/personal_access_tokens/self")).data;
  }

  listReviewMrs(userId: number): Promise<MrSummary[]> {
    return this.paged(`/merge_requests?reviewer_id=${userId}&state=opened&scope=all`);
  }

  listAssignedMrs(userId: number): Promise<MrSummary[]> {
    return this.paged(`/merge_requests?assignee_id=${userId}&state=opened&scope=all`);
  }

  async getMr(projectId: number | string, iid: number): Promise<Mr> {
    return (await this.req<Mr>("GET", `/projects/${projectId}/merge_requests/${iid}`)).data;
  }

  async getProject(id: number): Promise<Project> {
    return (await this.req<Project>("GET", `/projects/${id}`)).data;
  }

  listDiscussions(projectId: number, iid: number): Promise<Discussion[]> {
    return this.paged(`/projects/${projectId}/merge_requests/${iid}/discussions`);
  }

  async userHasApproved(projectId: number, iid: number): Promise<boolean> {
    return (await this.req<{ user_has_approved?: boolean }>("GET", `/projects/${projectId}/merge_requests/${iid}/approvals`)).data.user_has_approved === true;
  }

  /** Project setting "Reset approvals when new commits are pushed". */
  async resetsApprovalsOnPush(projectId: number): Promise<boolean> {
    return (await this.req<{ reset_approvals_on_push?: boolean }>("GET", `/projects/${projectId}/approvals`)).data.reset_approvals_on_push === true;
  }

  // --- write APIs: called only by publisher.ts, and only when DRY_RUN=0 ---

  async postNote(projectId: number, iid: number, body: string): Promise<void> {
    await this.req("POST", `/projects/${projectId}/merge_requests/${iid}/notes`, { body });
  }

  /** `sha` makes GitLab reject the approval (409) if the MR head moved since it was reviewed. */
  async approveMr(projectId: number, iid: number, sha: string): Promise<void> {
    await this.req("POST", `/projects/${projectId}/merge_requests/${iid}/approve`, { sha });
  }

  async unapproveMr(projectId: number, iid: number): Promise<void> {
    await this.req("POST", `/projects/${projectId}/merge_requests/${iid}/unapprove`);
  }

  async replyDiscussion(projectId: number, iid: number, discussionId: string, body: string): Promise<void> {
    await this.req("POST", `/projects/${projectId}/merge_requests/${iid}/discussions/${discussionId}/notes`, { body });
  }

  async resolveDiscussion(projectId: number, iid: number, discussionId: string): Promise<void> {
    await this.req("PUT", `/projects/${projectId}/merge_requests/${iid}/discussions/${discussionId}?resolved=true`);
  }

  async postDiscussion(projectId: number, iid: number, body: string, position: unknown): Promise<void> {
    await this.req("POST", `/projects/${projectId}/merge_requests/${iid}/discussions`, { body, position });
  }
}

const DRAFT_RE = /^\s*(\[|\()?\s*(draft|wip)\s*(\]|\))?\s*[:\s]/i;

export function isDraft(mr: Pick<MrSummary, "title" | "draft" | "work_in_progress">): boolean {
  return mr.draft === true || mr.work_in_progress === true || DRAFT_RE.test(mr.title);
}
