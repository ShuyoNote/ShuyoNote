// Focused HTML sanitizer for the read-only Markdown PREVIEW path.
//
// `mdToHtml` deliberately passes raw HTML blocks through verbatim so the Lexical
// HTML importer can structure them on "转为笔记" (a separate, safe path). But that
// SAME output is injected into the DOM via `dangerouslySetInnerHTML` for preview,
// which would execute any <script>/<img onerror>/javascript: URL in a downloaded
// .md file. This strips exactly those executable vectors before preview.
//
// This is NOT a general-purpose sanitizer (no config, no CSS parsing); it is a
// narrow allowlist-style strip for trusted-structure markdown preview only.

const DROP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base",
  "form", "input", "button", "textarea", "select", "option", "svg", "math",
  "template", "noscript", "frame", "frameset", "applet", "audio", "video",
  "source", "track", "canvas",
]);

const DROP_ATTRS = new Set(["srcdoc", "formaction", "style"]);

function cleanAttributes(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim().toLowerCase();
    if (name.startsWith("on") || DROP_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (
      (name === "href" || name === "src" || name === "xlink:href" || name === "action") &&
      (value.startsWith("javascript:") ||
        value.startsWith("data:text/html") ||
        value.startsWith("vbscript:"))
    ) {
      el.removeAttribute(attr.name);
    }
  }
}

export function sanitizePreviewHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const tag of DROP_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  }
  doc.body.querySelectorAll("*").forEach(cleanAttributes);
  return doc.body.innerHTML;
}
