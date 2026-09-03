// Hydrate `.fm-md-mermaid` container elements (emitted by mdToHtml for ```mermaid
// fenced blocks) into rendered SVGs. The source lives in a child
// `.fm-md-mermaid-src <pre>`, read via textContent (no HTML-entity round-trip).
// Mirror the app's MermaidNode lazy-import approach. Pass the target `theme`
// ("dark" | "default"); when it changes, already-hydrated blocks re-render.
// NOTE: mermaid is imported statically (into the main bundle) not via a dynamic
// chunk — Tauri/Web 正式版下动态 chunk 的相对路径可能解析失败，布局依赖(dagre)未
// 加载 → subgraph 全叠成一整块(开发版好、正式版坏)。静态引入根治该问题。
import mermaid from "mermaid";
let mermaidReady = false;
let mermaidTheme = "";

/**
 * Find every `.fm-md-mermaid` element under `root`, render each with Mermaid at
 * the given `theme`, and write the SVG into its `.fm-md-mermaid-svg` child (the
 * `.fm-md-mermaid-src` source is preserved, so a theme switch can re-render).
 * Safe to call repeatedly; re-renders when the theme changed.
 */
export async function hydrateMermaidBlocks(root: HTMLElement | null, theme: "dark" | "default" = "default"): Promise<void> {
  if (!root) return;
  const placeholders = Array.from(root.querySelectorAll<HTMLElement>(".fm-md-mermaid"));
  if (placeholders.length === 0) return;
  for (const el of placeholders) {
    const doneTheme = el.getAttribute("data-done");
    const src = el.querySelector<HTMLElement>(".fm-md-mermaid-src")?.textContent?.trim() || "";
    if (!src) continue;
    const svgHost = el.querySelector<HTMLElement>(".fm-md-mermaid-svg");
    if (!svgHost) continue;
    // Skip work when already rendered with the current theme.
    if (doneTheme === theme && el.getAttribute("data-ok")) continue;
    try {
      if (!mermaidReady || mermaidTheme !== theme) {
        mermaid.initialize({
          startOnLoad: false,
          theme,
          // subgraph + <br/> 标签 + 跨 subgraph 引用易布局错乱；htmlLabels + loose
          // 让 <br/> 正确换行且不因 strict 转义破坏，改善嵌套图渲染。
          securityLevel: "loose",
          // htmlLabels:false → SVG text label，布局不依赖宿主 CSS/字体（发布版/开发版一致）。
          flowchart: { htmlLabels: false, curve: "basis" },
        });
        mermaidReady = true;
        mermaidTheme = theme;
      }
      const id = `mdm-${Math.random().toString(36).slice(2, 10)}`;
      const { svg } = await mermaid.render(id, src);
      svgHost.innerHTML = svg;
      el.setAttribute("data-done", theme);
      el.setAttribute("data-ok", "1");
    } catch (e) {
      svgHost.innerHTML = `<pre class="fm-md-mermaid-error">${escapeHtml(src)}</pre><div class="fm-md-mermaid-errmsg">Mermaid 渲染失败：${escapeHtml(String((e as Error)?.message ?? e))}</div>`;
      el.setAttribute("data-done", theme);
      el.removeAttribute("data-ok");
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
