// 「把一篇社区帖子存成笔记」——把 ① 解析、② 抓取、③ 确认 串起来的那一层里的**纯部分**。
//
// 有副作用的那一半（弹窗、落库、幂等查询）在 `CommunitySaveDialog.tsx` 里；
// 这里只放"能算出来的东西"：链接怎么认、笔记正文长什么样、预览显示哪几行、
// 以及**这篇帖子是不是已经存过了**。抽出来的理由和别处一样：这些判断写错了不会报错，
// 只会让用户多出一篇重复笔记，或者点开一个错的页面。

import { checkCommunityUrl, parseDeepLink } from "./deepLink";
import type { CommunityPost } from "./communityPost";

/**
 * 用户可能粘进来的东西：深链，或一条社区地址。
 *
 * `action` 必须带出来：**`save` 与 `import` 是两件事**（存一篇笔记 vs 导入一个产物），
 * 之前这里只返回 url、调用方一律按"存笔记"处理——于是点"导入模板"会去存一篇笔记，
 * 而且不报错。动作分不清就会静默做错事。
 */
export type LinkIntent =
  | { ok: true; action: "save" | "import"; url: string }
  | { ok: false; reason: string };

/**
 * 认「用户粘进来的东西」。
 *
 * 为什么要容忍两种：深链要靠操作系统递交（还没接完），而**网址是用户此刻就能粘的**。
 * 两条路最终都归一到"要抓的帖子地址"，所以后面的抓取、预览、落库只有一份实现。
 */
export function linkIntentOf(input: string): LinkIntent {
  const text = (input ?? "").trim();
  if (!text) return { ok: false, reason: "还没有粘贴链接" };
  if (/^shuyonote:/i.test(text)) {
    const r = parseDeepLink(text);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.action.kind === "save" || r.action.kind === "import") {
      return { ok: true, action: r.action.kind, url: r.action.url };
    }
    if (r.action.kind === "compose") {
      return {
        ok: false,
        reason:
          "「起一份草稿」这条路还没做（要的是「未保存的编辑器内容」，不是先落库再删）——" +
          "现在请用「新建页面」手动粘贴，或让对方把内容发成帖子链接",
      };
    }
    return { ok: false, reason: "这是应用内部的页面链接（shuyonote://page/…），不是社区内容" };
  }
  const checked = checkCommunityUrl(text);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  // 手动粘一条社区地址：默认按"存笔记"处理（那是这条入口最常见的用途）；
  // 要导入模板就粘 `shuyonote://import?url=…`（这样动作由链接本身说清，不靠猜）。
  return { ok: true, action: "save", url: checked.url };
}

/**
 * 笔记正文：**先写来源，再写正文**。
 *
 * 来源行必须在最前面：这篇笔记是别人写的东西，读者第一眼就该知道它从哪来、
 * 点得回去。用引用块而不是普通一行——引用块在 Markdown 阅读器里视觉上是"这段是引来的"。
 */
export function noteForPost(post: CommunityPost): { title: string; markdown: string } {
  const meta = [post.author ? `作者 ${post.author}` : "", post.updatedAt || post.createdAt]
    .filter(Boolean)
    .join(" · ");
  // **来源地址必须以纯文本出现在正文里**，不能只放进 Markdown 链接的 href：
  // 链接的 href 只活在 `content_json` 的节点属性里，而全文检索索引的是**纯文本**
  // （`content_text`）。只放 href 的话，"这篇帖子是不是已经存过"就永远查不到——
  // 幂等会静默失效，用户每次都会多出一篇重复笔记。（这条是渲染级测试抓出来的。）
  const sourceLine = `> 来源：${post.title} · ${post.url}${meta ? `（${meta}）` : ""}`;
  const tags = post.tags.length ? `\n\n标签：${post.tags.map((t) => `#${t}`).join(" ")}` : "";
  return {
    title: post.title,
    markdown: `${sourceLine}\n\n---\n\n${post.bodyMarkdown.trim()}${tags}\n`,
  };
}

/** 预览：给前 `maxLines` 行，并说明"后面还有多少"（不假装全文都在眼前）。 */
export function previewOf(markdown: string, maxLines = 12): { lines: string[]; hiddenLines: number } {
  const all = markdown.split("\n");
  return { lines: all.slice(0, maxLines), hiddenLines: Math.max(0, all.length - maxLines) };
}

/** 幂等判断的候选：搜索命中（只有片段）或整页内容（有全文）。 */
export interface StoredCandidate {
  id: string;
  title: string;
  /** 搜索片段或页面正文——用它**逐字**核对来源地址，不信分词结果。 */
  text: string;
}

/**
 * 这篇帖子是不是已经存过了？
 *
 * 为什么要**逐字核对**而不是"搜到了就算"：全文检索会分词，一条查询命中的页面
 * 未必真的含这个地址（同域名、同 slug 片段都会命中）。误判的代价是不对称的——
 * "以为存过"会让用户找不到那篇笔记，而"以为没存过"只是多一篇。
 * 所以：**搜到的候选必须在正文里逐字出现来源地址**，才算已经存过。
 */
export function findStoredPost(candidates: StoredCandidate[], url: string): StoredCandidate | null {
  const needle = url.trim();
  if (!needle) return null;
  for (const c of candidates) {
    if ((c.text ?? "").includes(needle)) return c;
  }
  return null;
}

/**
 * 搜索用的查询词：用地址里最后一段（slug / id）而不是整条 URL。
 *
 * 全文检索对带标点的整条 URL 分得很碎，拿整条去搜往往一条都搜不到；
 * 而 slug 是这条地址里最有辨识度的一段。**准确性由 `findStoredPost` 的逐字核对兜底**，
 * 搜索只负责"把可能相关的页面捞出来"。
 */
export function searchKeyOf(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : u.hostname;
  } catch {
    return url;
  }
}
