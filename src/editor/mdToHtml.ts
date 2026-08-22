// Minimal Markdown → HTML converter used only for the mixed "markdown + block
// HTML" import path. Pure Markdown (no block HTML) still goes through
// $convertFromMarkdownString for lossless round-trips; this runs when the source
// contains block HTML so the direct HTML importer can render the whole document
// with structure preserved. Existing inline HTML (<p>/<img>/<strong>/<br> …) is
// passed through verbatim; Markdown constructs are turned into HTML tags.

const RE_HTML_TAG = /<[^>]+>/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Convert inline Markdown to HTML, leaving existing HTML tags untouched. Picks
// the earliest match among HTML tag / inline code / bold / italic / strikethrough
// / link / image so nested and adjacent runs are handled left-to-right.
export function inlineToHtml(s: string): string {
  let out = "";
  let rest = s;
  while (rest.length > 0) {
    const matches: Array<{ idx: number; len: number; rep: string }> = [];
    const tag = rest.match(RE_HTML_TAG);
    if (tag) matches.push({ idx: tag.index!, len: tag[0].length, rep: tag[0] });

    const img = rest.match(/!\[([^\]]*)\]\(([^)]+?)\)/);
    if (img)
      matches.push({
        idx: img.index!,
        len: img[0].length,
        rep: `<img src="${img[2].trim()}" alt="${escapeHtml(img[1])}">`,
      });

    const code = rest.match(/`([^`]+)`/);
    if (code)
      matches.push({ idx: code.index!, len: code[0].length, rep: `<code>${escapeHtml(code[1])}</code>` });

    const bold = rest.match(/\*\*([^*]+?)\*\*/);
    if (bold)
      matches.push({ idx: bold.index!, len: bold[0].length, rep: `<strong>${inlineToHtml(bold[1])}</strong>` });

    const del = rest.match(/~~([^~]+?)~~/);
    if (del)
      matches.push({ idx: del.index!, len: del[0].length, rep: `<del>${inlineToHtml(del[1])}</del>` });

    const italic = rest.match(/(^|[^*])\*([^*\n][^*]*?)\*/);
    if (italic)
      matches.push({
        idx: italic.index! + (italic[1] ? 1 : 0),
        len: italic[0].length - (italic[1] ? 1 : 0),
        rep: `<em>${inlineToHtml(italic[2])}</em>`,
      });

    const link = rest.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (link)
      matches.push({
        idx: link.index!,
        len: link[0].length,
        rep: `<a href="${link[2]}">${inlineToHtml(link[1])}</a>`,
      });

    if (matches.length === 0) {
      out += rest;
      break;
    }
    const best = matches.reduce((a, b) => (a.idx <= b.idx ? a : b));
    out += rest.slice(0, best.idx) + best.rep;
    rest = rest.slice(best.idx + best.len);
  }
  return out;
}

function isHtmlContainerStart(trimmed: string): boolean {
  return /^<(\/?)(p|div|h[1-6]|table|ul|ol|pre|blockquote|section|article|header|footer|main|aside|center)\b/i.test(
    trimmed,
  );
}

export function mdToHtml(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  const blank = (s: string) => s.trim() === "";

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Raw HTML block: pass through verbatim so the DOM importer structure it.
    if (isHtmlContainerStart(trimmed) || RE_HTML_TAG.test(trimmed)) {
      const block: string[] = [];
      let j = i;
      const openTag = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
      const tag = openTag ? openTag[1].toLowerCase() : null;
      const voidTags = new Set(["img", "br", "hr", "input", "meta", "link"]);
      while (j < lines.length) {
        block.push(lines[j]);
        if (tag && !voidTags.has(tag) && new RegExp(`</${tag}>`, "i").test(lines[j])) {
          j++;
          break;
        }
        if (tag === null || voidTags.has(tag)) {
          // single-line void / self-closing / attr-only element
          j++;
          break;
        }
        if (blank(lines[j]) && j > i) {
          j++;
          break;
        }
        j++;
      }
      out.push(block.join("\n"));
      i = j;
      continue;
    }

    if (blank(line)) {
      i++;
      continue;
    }

    // Fenced code block.
    if (/^```/.test(trimmed)) {
      const lang = trimmed.replace(/^```/, "").trim();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^```/.test(lines[j].trim())) {
        body.push(lines[j]);
        j++;
      }
      const code = body.join("\n");
      const langAttr = lang ? ` class="language-${lang}"` : "";
      out.push(`<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`);
      i = j + 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Heading.
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inlineToHtml(h[2].trim())}</h${h[1].length}>`);
      i++;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(trimmed)) {
      const inner: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        inner.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inlineToHtml(inner.join(" "))}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^\s{0,3}[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s{0,3}[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s{0,3}[-*+]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${inlineToHtml(it)}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s{0,3}\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s{0,3}\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s{0,3}\d+\.\s+/, ""));
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${inlineToHtml(it)}</li>`).join("")}</ol>`);
      continue;
    }

    // Markdown table.
    if (/^\|/.test(trimmed) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length && /^\|/.test(lines[j].trim())) {
        const cells = lines[j].replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!/^[\s:|-]+$/.test(cells.join(""))) rows.push(cells);
        j++;
      }
      if (rows.length > 0) {
        const header = rows[0];
        const bodyRows = rows.slice(1);
        const colCount = Math.max(1, header.length, ...bodyRows.map((r) => r.length));
        let html = "<table><thead><tr>";
        for (let c = 0; c < colCount; c++) html += `<th>${inlineToHtml(header[c] ?? "")}</th>`;
        html += "</tr></thead><tbody>";
        for (const r of bodyRows) {
          html += "<tr>";
          for (let c = 0; c < colCount; c++) html += `<td>${inlineToHtml(r[c] ?? "")}</td>`;
          html += "</tr>";
        }
        html += "</tbody></table>";
        out.push(html);
        i = j;
        continue;
      }
    }

    // Paragraph (group non-blank, non-special lines).
    const para: string[] = [];
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\||```|\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$)/.test(
        lines[i].trim(),
      ) &&
      !isHtmlContainerStart(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length > 0) out.push(`<p>${inlineToHtml(para.join(" "))}</p>`);
  }

  return out.join("\n");
}
