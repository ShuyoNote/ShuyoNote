// **AI / PDF 路径上的正文纯文本派生** —— 住在这一层，因为它需要"编辑器语义"。
//
// ## 为什么单独一个文件（不是随手拆）
//
// 唯一实现是 `lib/contentText.ts::deriveContentText`，它要 `editor/config` 的**节点表**
// 才能把内容 JSON 解析成 Lexical 状态（少了某一类节点，那一块文本会被静默丢掉）。
// 于是**凡是 import 到它的打包路径，都会带上整个编辑器节点图**：
// excalidraw 的 CSS、katex 的字体、sql.js 的 wasm……
// 这对 Vite 无所谓（浏览器那边本来全都要），但对 `scripts/smoke-web.mjs` 那种
// **node 侧 esbuild** 的纯逻辑冒烟包是致命的 —— 它没有资源加载器，`pnpm verify` 直接红。
//
// ⇒ 分层：`./lexical.ts` 保持纯 JSON 逻辑（`appendBlocksToJson` / `cleanDraftText` /
// `pageJsonFromText`），**需要节点表的**只有本文件这一个函数。
// `ai/tools` → `capabilities/frontend` → `./lexical` 这条纯逻辑链因此不再被拖进编辑器图。
//
// 调用方是编辑器侧（AI 应用层 / PDF 注释面板），它们本来就在完整应用包里。

import { deriveContentText } from "../contentText";

/**
 * 由页面内容 JSON 取正文纯文本（预览/片段/PDF 注释落库用）。
 *
 * 语义已经与编辑器保存路径**统一**（`lib/contentText.ts` 的 `deriveContentText`）：
 * 原先这里自己 walk JSON、用**空格**连接，而编辑器用 Lexical 的
 * `$getRoot().getTextContent()`（块间是换行）⇒ 实测 7 个样本里 4 个结果不同，
 * 也就是"谁最后保存决定了正文文本长什么样"（FTS 命中 / 反链片段 / 预览会随路径漂）。
 *
 * 保留 `contentTextOf` 这个名字：调用方有多处，改名只增加 diff。
 */
export function contentTextOf(docJson: string): string {
  return deriveContentText(docJson);
}
