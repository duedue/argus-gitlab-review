import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_SKILL_BYTES = 200 * 1024;

export interface SkillWarning {
  line: number;
  text: string; // truncated source line
  reason: string;
}

// Import-time static scan (DESIGN "Compatibility"): the platform contract overrides these at run time, so
// hits only WARN. Heuristic by design (regex over lines); false positives are acceptable.
const RULES: [RegExp, string][] = [
  [/mcp__\w+/i, "提及 MCP 工具；review agent 沒有 MCP 權限"],
  [/\b(gitlab|jira)\b.{0,60}\b(tool|mcp|api|call|invoke|use)\b|\b(call|invoke|use)\b.{0,60}\b(gitlab|jira)\b/i, "要求使用 GitLab/Jira 工具；review agent 只有 Read/Grep/Glob"],
  [/\b(post|add|leave|submit|publish|write)\b.{0,40}\b(comments?|notes?|reviews?|threads?|discussions?)\b/i, "要求發佈留言；留言由平台代為發佈"],
  [/\b(approve|unapprove)\b|\bmerge\b.{0,20}\b(mr|merge request|pull request)\b/i, "要求 approve/merge；review agent 無法執行"],
];

export function scanSkill(text: string): SkillWarning[] {
  const out: SkillWarning[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const hit = RULES.find(([re]) => re.test(l));
    if (hit) out.push({ line: i + 1, text: l.trim().slice(0, 120), reason: hit[1] });
  });
  return out;
}

/** Validates uploaded skill text (UTF-8 text, non-empty, <= 200KB). Returns the cleaned text; throws a user-facing error. */
export function validateSkillText(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) throw new Error(`skill 檔案超過 ${MAX_SKILL_BYTES / 1024}KB 上限`);
  if (text.includes("\0") || text.includes("�")) throw new Error("skill 必須是 UTF-8 文字檔");
  if (!text.trim()) throw new Error("skill 內容是空的");
  return text;
}

/** The only location a web-uploaded skill is ever written: <dataDir>/skills/<numeric user id>/SKILL.md. */
export const managedSkillPath = (dataDir: string, userId: number): string => {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("bad user id");
  return join(dataDir, "skills", String(userId), "SKILL.md");
};

/** Atomic replace (tmp + rename). Returns the final path. */
export function saveSkill(dataDir: string, userId: number, text: string): string {
  const path = managedSkillPath(dataDir, userId);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
