import { readFileSync } from "node:fs";
import { Marked, type Tokens } from "marked";

// In-app guides: docs/*.md rendered once at startup and served publicly (the repo is private, colleagues cannot open it).
export const DOCS = {
  setup: { file: "SETUP.md", path: "/docs/setup" },
  guide: { file: "USER-GUIDE.md", path: "/docs/guide" },
  mr: { file: "MR-AUTHOR.md", path: "/docs/mr" },
} as const;
export type DocKey = keyof typeof DOCS;

const ROUTE_BY_FILE = new Map<string, string>(Object.values(DOCS).map((d) => [d.file, d.path]));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const md = new Marked({
  renderer: {
    // Defense in depth: embedded raw HTML is shown as text, never passed through.
    html: ({ text }: Tokens.HTML | Tokens.Tag) => esc(text),
    // Same look as the app's other code blocks; no inline style (CSP).
    code: ({ text }: Tokens.Code) => `<pre class="codeblock" tabindex="0"><code>${esc(text)}</code></pre>\n`,
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const t = title ? ` title="${esc(title)}"` : "";
      if (/^https?:\/\//i.test(href)) return `<a href="${esc(href)}"${t} rel="noopener noreferrer">${inner}</a>`;
      if (href.startsWith("#")) return `<a href="${esc(href)}"${t}>${inner}</a>`;
      // Relative repo link: keep only the two guides (they exist in-app); anything else (README, src/...) becomes plain text.
      const route = ROUTE_BY_FILE.get(href.split(/[?#]/)[0]!.split("/").pop()!);
      return route && /^(\.\/|\.\.\/)*(docs\/)?[\w-]+\.md/.test(href) ? `<a href="${route}"${t}>${inner}</a>` : inner;
    },
  },
});

export interface RenderedDoc { title: string; html: string }

export function renderDoc(src: string): RenderedDoc {
  const title = /^#\s+(.+?)\s*$/m.exec(src)?.[1] ?? "文件";
  return { title, html: md.parse(src, { async: false }) };
}

/** Reads each guide once, relative to the app root (not cwd). A missing/unreadable file is simply absent (route answers 404). */
export function loadDocs(dir = new URL("../../docs/", import.meta.url)): Partial<Record<DocKey, RenderedDoc>> {
  const out: Partial<Record<DocKey, RenderedDoc>> = {};
  for (const [k, d] of Object.entries(DOCS) as [DocKey, (typeof DOCS)[DocKey]][]) {
    try {
      out[k] = renderDoc(readFileSync(new URL(d.file, dir), "utf8"));
    } catch (e) {
      console.error(`[web] doc ${d.file} unavailable:`, (e as Error).message);
    }
  }
  return out;
}
