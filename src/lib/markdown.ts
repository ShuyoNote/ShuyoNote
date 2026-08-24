// Lightweight, XSS-safe Markdown parser for AI replies. Only well-known tokens
// are recognised (headings / bold / italic / inline code / links / lists /
// blockquote / fenced code / hr). Raw HTML is NEVER emitted — text is returned
// as data so React escapes it, and links only accept http/https. The parser is
// pure (returns a serializable tree) so it is unit-testable in the smoke harness.

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: MdInline[] }
  | { kind: "italic"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; label: string };

export type MdBlock =
  | { kind: "p"; children: MdInline[] }
  | { kind: "h1"; children: MdInline[] }
  | { kind: "h2"; children: MdInline[] }
  | { kind: "h3"; children: MdInline[] }
  | { kind: "h4"; children: MdInline[] }
  | { kind: "ul"; items: MdInline[][] }
  | { kind: "ol"; items: MdInline[][] }
  | { kind: "quote"; children: MdBlock[] }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "hr" };

function safeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !/[\s<>"']/.test(url);
}

// Scan raw text for inline tokens; everything else is escaped text.
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const pushText = (s: string) => {
    if (s) out.push({ kind: "text", text: s });
  };
  const RE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/;
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const m = RE.exec(rest);
    if (!m) {
      pushText(text.slice(i));
      break;
    }
    if (m.index > 0) pushText(rest.slice(0, m.index));
    if (m[2] !== undefined) {
      out.push({ kind: "bold", children: parseInline(m[2]) });
    } else if (m[4] !== undefined) {
      out.push({ kind: "italic", children: parseInline(m[4]) });
    } else if (m[6] !== undefined) {
      out.push({ kind: "code", text: m[6] });
    } else if (m[8] !== undefined && safeUrl(m[9])) {
      out.push({ kind: "link", href: m[9], label: m[8] });
    } else {
      pushText(m[0]);
    }
    i += m.index + m[0].length;
  }
  return out;
}

const BLOCK_START =
  /^(#{1,4})\s|^```|^>\s|^[-*]\s|^\d+\.\s|^([-*_])\1{2,}\s*$/;

export function parseMarkdown(text: string): MdBlock[] {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Fenced code block.
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ kind: "code", lang: lang || undefined, text: code.join("\n") });
      continue;
    }

    // Heading h1-h4.
    const h = /^(#{1,4})\s+/.exec(trimmed);
    if (h) {
      const level = h[1].length as 1 | 2 | 3 | 4;
      blocks.push({ kind: `h${level}`, children: parseInline(trimmed.slice(h[0].length)) } as MdBlock);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // Blockquote (recursively parsed for nested blocks).
    if (/^>/.test(trimmed)) {
      const q: string[] = [];
      while (i < lines.length && /^>/.test(lines[i].trim())) {
        q.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", children: parseMarkdown(q.join("\n")) });
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(trimmed)) {
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = /^[-*]\s+(.*)$/.exec(lines[i].trim());
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = /^\d+\.\s+(.*)$/.exec(lines[i].trim());
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragraph: glue consecutive plain lines, stop at a block start / blank.
    if (trimmed) {
      const para: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || BLOCK_START.test(t)) break;
        para.push(t);
        i++;
      }
      blocks.push({ kind: "p", children: parseInline(para.join(" ")) });
      continue;
    }

    i++; // blank line
  }
  return blocks;
}
