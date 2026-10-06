import { z } from "zod";

export const SEVERITIES = ["nit", "minor", "major", "blocker"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FP_RE = /^[0-9a-f]{12}$/;

export const VERDICTS = ["approve", "request_changes", "needs_discussion"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const ReviewOutputSchema = z.object({
  // New fields are optional (and a malformed value is dropped, not fatal): an older/sloppy agent reply still parses.
  verdict: z.enum(VERDICTS).optional().catch(undefined),
  summary: z.string().optional().catch(undefined),
  checked: z.array(z.string()).optional().catch(undefined),
  focus: z.array(z.string()).optional().catch(undefined), // the riskiest aspects the agent planned and checked
  findings: z.array(FindingSchema),
  // Fingerprints of previously reported open threads the agent verified as fixed.
  resolved: z.array(z.string().regex(FP_RE)).default([]),
});
export type ReviewResult = z.infer<typeof ReviewOutputSchema>;

/** Extract and validate findings from raw agent text (plain JSON, fenced, or JSON embedded in prose). */
export function parseFindings(text: string): Finding[] {
  return parseReview(text).findings;
}

export function parseReview(text: string): ReviewResult {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  let lastErr: unknown = new Error("empty output");
  for (const c of candidates) {
    try {
      return ReviewOutputSchema.parse(JSON.parse(c));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`invalid findings output: ${lastErr instanceof Error ? lastErr.message.slice(0, 300) : lastErr}`);
}

/** Deterministic fallback when the agent omitted the verdict. */
export function deriveVerdict(findings: Pick<Finding, "severity">[]): Verdict {
  return findings.some((f) => f.severity === "blocker" || f.severity === "major") ? "request_changes" : "approve";
}

export function passesThreshold(f: Finding, minSeverity: Severity, minConfidence: number): boolean {
  return SEVERITIES.indexOf(f.severity) >= SEVERITIES.indexOf(minSeverity) && f.confidence >= minConfidence;
}
