// 深链的**分派**：一条 URL 进来之后，谁去处理它。
//
// 为什么需要这一层：`mountDeepLinks`（Windows 侧）只负责把 URL 搬进来，
// `openWithLink`（我这边）只负责"存笔记/导入"那个对话框。直接把它们接在一起会漏掉一类链接：
//
//   `shuyonote://page/<id>` —— 应用**自己**生成的页面链接（`DrawingEditorModal` 就在生成它）。
//   用户在别处点它，期望是"打开那一页"；而接到对话框上，他会看到一个
//   「这是应用内部的页面链接」的红字——**动作接错了，而且那条链接本来是有效的**。
//
// 所以这里做分派（纯逻辑 + 注入副作用，便于测）：
//   page        → 打开那一页（不弹社区对话框）
//   save/import → 交给社区对话框（它自己会预览、自己会确认）
//   compose     → 如实说"这条路还没做"（要的是未保存的草稿，不是先落库再删）
//   非法/不认识 → 仍然**交给对话框**：那里能把原因显示出来，而且用户可以直接改那条链接
//   （一次误点的提示条一闪而过，比一个能改的红框更容易被忽略）
//
// 另外做了**去重**：同一条 URL 在很短的时间内重复到达（连点两次、或系统两条投递路径同时命中）
// 只处理一次。`mountDeepLinks` 那边有"取走即空"的队列保证不重投，这里是第二道保险——
// 它是纯本地的判断，出错也不会漏掉真链接。

import { parseDeepLink } from "./deepLink";

/** 「起一份草稿」这条路还没做——同一句话只写一处，测试与界面都引用它。 */
export const COMPOSE_NOT_DONE =
  "「起一份草稿」这条路还没做（要的是「未保存的编辑器内容」，不是先落库再删）——" +
  "现在请用「新建页面」手动粘贴，或让对方把内容发成帖子链接";

export interface DeepLinkDeps {
  /** 打开某一页（应用内部的页面链接）。 */
  openPage: (pageId: string) => Promise<void> | void;
  /** 交给「从社区链接存一篇笔记 / 导入模板」对话框（传**原始 URL**，它自己再解析一次）。 */
  openCommunityDialog: (url: string) => void;
  /** 一次性提示（打不开那一页之类）。 */
  notify: (message: string) => void;
  /** 注入时钟：去重窗口要能被测。 */
  now?: () => number;
  /** 去重窗口（毫秒）。默认 1.5 秒。 */
  dedupeMs?: number;
}

/**
 * 造一个可以交给 `mountDeepLinks` 的 handler。
 *
 * 返回的函数**不会抛**：深链来自应用外面，一次失败不该把启动流程带崩
 * （`mountDeepLinks` 那边也兜了一层，但"自己这边不抛"是更硬的保证）。
 */
export function createDeepLinkHandler(deps: DeepLinkDeps): (raw: string) => Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const dedupeMs = deps.dedupeMs ?? 1500;
  let lastUrl = "";
  let lastAt = 0;

  return async (raw: string) => {
    const url = (raw ?? "").trim();
    if (!url) return;

    const at = now();
    if (url === lastUrl && at - lastAt < dedupeMs) return; // 同一条链接的重复投递
    lastUrl = url;
    lastAt = at;

    const parsed = parseDeepLink(url);
    if (!parsed.ok) {
      // 解析失败也交给对话框：那里有红字与可编辑的输入框，用户能立刻改成对的那条。
      deps.openCommunityDialog(url);
      return;
    }

    switch (parsed.action.kind) {
      case "page":
        try {
          await deps.openPage(parsed.action.pageId);
        } catch (e) {
          deps.notify(`打不开这一页：${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      case "save":
      case "import":
        deps.openCommunityDialog(url);
        return;
      case "compose":
        deps.notify(COMPOSE_NOT_DONE);
        return;
    }
  };
}
