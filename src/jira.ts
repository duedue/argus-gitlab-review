import { execFileSync } from "node:child_process";
import type { Config } from "./config.ts";

const MAX_ISSUES = 3;
const MAX_LINKED = 2;
const MAX_TEXT = 4000;
const TIMEOUT_MS = 10_000;
// Standards/algorithms that look like issue keys (UTF-8, SHA-1, CVE-2024...). Lowercase never matches the regex anyway.
const NOT_PROJECTS = new Set(["UTF", "SHA", "MD", "ISO", "RFC", "CVE", "AES", "RSA", "TLS", "SSL", "HTTP", "IPV"]);

/** Pure: unique Jira-style keys from MR title + description, first-seen order, at most MAX_ISSUES. */
export function extractIssueKeys(...texts: string[]): string[] {
  const keys = new Set<string>();
  for (const k of texts.join("\n").match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []) {
    if (!NOT_PROJECTS.has(k.slice(0, k.lastIndexOf("-")))) keys.add(k);
  }
  return [...keys].slice(0, MAX_ISSUES);
}

/** Token from env, else macOS Keychain (service argus, account jira-token). Keychain only for the real process env. */
export function jiraTokenFrom(env: NodeJS.ProcessEnv): string | undefined {
  if (env.JIRA_API_TOKEN?.trim()) return env.JIRA_API_TOKEN.trim();
  if (env !== process.env) return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "argus", "-a", "jira-token", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

export type JiraFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface IssueJson {
  fields?: {
    summary?: string;
    description?: string | null;
    issuelinks?: { inwardIssue?: LinkedJson; outwardIssue?: LinkedJson }[];
  };
}
interface LinkedJson { key?: string; fields?: { summary?: string } }

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + " …[truncated]" : s);
let warnedOff = false;

/**
 * Requirement text for the agent, or undefined (feature off / nothing found). Never throws: any Jira error just
 * drops that issue. The token stays in this process; the agent only ever sees the resulting text.
 */
export async function fetchRequirements(cfg: Pick<Config, "jira">, title: string, description: string, doFetch: JiraFetch = fetch as unknown as JiraFetch): Promise<string | undefined> {
  const token = cfg.jira.token();
  if (!token || !cfg.jira.url) {
    if (!warnedOff) console.log("[jira] no JIRA_API_TOKEN/URL; requirement context is off");
    warnedOff = true;
    return undefined;
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const get = async (key: string, fields: string): Promise<IssueJson | undefined> => {
    try {
      const r = await doFetch(`${cfg.jira.url}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return r.ok ? ((await r.json()) as IssueJson) : undefined;
    } catch (e) {
      console.warn(`[jira] ${key} skipped: ${(e as Error).name}`);
      return undefined;
    }
  };
  const out: string[] = [];
  // Title keys are the MR's own ticket. Bare keys in the description are often examples/references, so the
  // fallback only trusts explicit Jira links (`.../browse/KEY`, as in the mr-ops description template).
  const titleKeys = extractIssueKeys(title);
  const linkedKeys = extractIssueKeys(...[...description.matchAll(/\/browse\/([A-Z][A-Z0-9]+-\d+)\b/g)].map((m) => m[1]!));
  for (const key of titleKeys.length ? titleKeys : linkedKeys) {
    const f = (await get(key, "summary,description,issuelinks"))?.fields;
    if (!f) continue;
    const lines = [`## ${key}: ${clip(f.summary ?? "")}`, clip(f.description ?? "")];
    // Linked-issue stubs already carry their summary, so no extra GET is needed (bounded to MAX_LINKED).
    const linked = (f.issuelinks ?? []).map((l) => l.inwardIssue ?? l.outwardIssue).filter((l): l is LinkedJson => !!l?.key);
    for (const l of linked.slice(0, MAX_LINKED)) lines.push(`Linked ${l.key}: ${clip(l.fields?.summary ?? "")}`);
    out.push(lines.filter(Boolean).join("\n"));
  }
  return out.length ? out.join("\n\n") : undefined;
}
