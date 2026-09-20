// 「发布前清单」的正文预览：Markdown → **安全 HTML**。
//
// 为什么要有它（owner 2026-09-21：「内容是 md 格式，不友好」）：清单此前把**源码**糊在用户脸上
// （`# 今日小记` / `## 三件…` / `---`），而发出去的东西在社区那边是**渲染过**的
// （社区自己把 `body` 当 Markdown 渲染，实测 `<h1>/<h2>/<ul>/<blockquote>` 都在）。
// 所以这里只是把"发出去会长什么样"摆给人看 —— **线上发的仍然是 Markdown 源码**，一个字没改。
//
// 渲染器复用导入那条 `mdToHtml`（"粘贴 Markdown 存为笔记"走的是同一套解析），
// 免得预览和实际导入出现两套 Markdown 口径。产物要 `dangerouslySetInnerHTML`，
// 而笔记正文里可能贴着从别处复制来的 HTML ⇒ 一律过 DOMPurify。
import DOMPurify from "dompurify";
import { mdToHtml } from "../editor/mdToHtml";

/** 只留 Markdown 会产出的那些标签（`class` 是给代码块的 `language-xxx` 用的）。 */
export const PREVIEW_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "img",
    "table", "thead", "tbody", "tr", "th", "td",
    "div", "span",
  ],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "colspan", "rowspan"],
  ALLOW_DATA_ATTR: false,
};

/**
 * Markdown → 可直接塞进 `dangerouslySetInnerHTML` 的 HTML。
 *
 * 链接强制新开 + `noreferrer`：这是应用内的浮层，点一个链接把整个 WebView 导航走
 * （或把本地地址泄给目标站）都不能接受 —— 与邮件正文那条同一套处理。
 */
export function markdownPreviewHtml(md: string): string {
  if (!md.trim()) return "";
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
  });
  const html = DOMPurify.sanitize(mdToHtml(md), { ...PREVIEW_SANITIZE_CONFIG, ADD_ATTR: ["target", "rel"] });
  DOMPurify.removeHook("afterSanitizeAttributes");
  return html;
}
