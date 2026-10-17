// 「刷新/重开/切回空间之后，还记得**这个空间**上次看的是哪一页」—— **纯存取那一半**。
//
// 来由（owner 2026-10-18）：「一个空间的那个文件夹展开、哪个折叠、**最后的文档位置**，可否记录下来？」
// —— 2026-10-05 起只记了**一个全局** `lastPageId`：切到别的空间再切回来，记忆已经被那个空间的
// 第一页/别页**改写**掉了 ✗ ⇒ 每个空间各记一份，切回来才真的回到原处 ✓。
//
// 四条口径：
//  ① 存 **localStorage**（这台设备的界面状态，与 `scrollMemory` / `treeMemory` 同一套 ✓）；
//  ② **按空间分键**（`shuyonote:lastPageId:<spaceId>`）✓；
//  ③ **继续写老键** `shuyonote:lastPageId`：老版本/老记忆仍然读得到（迁移不炸 ✓），
//     新版读的时候**先按空间、再退回老键** ✓；
//  ④ 读写一律 `try/catch`：隐私模式/配额异常 ⇒ 退化成"不还原"，⛔ 不影响用 ✗。
export const LAST_PAGE_KEY = "shuyonote:lastPageId";
export const LAST_PAGE_KEY_PREFIX = "shuyonote:lastPageId:";

function keyOf(spaceId: string): string {
  return LAST_PAGE_KEY_PREFIX + spaceId;
}

/**
 * 读「这个空间上次看的那一页」：**先按空间键**；没有再退回**老的全局键**（迁移 ✓）。
 * 没有记录 / 读不到 ⇒ 空串（调用方据此走自己的兜底 ✓）。
 */
export function readLastPage(spaceId?: string | null): string {
  try {
    if (spaceId) {
      const perSpace = localStorage.getItem(keyOf(spaceId));
      if (perSpace) return perSpace;
    }
    return localStorage.getItem(LAST_PAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * 记下「这个空间看的是这一页」。
 * ⭐ 老键也照写：老版本还读它（降级不丢记忆 ✓）；新版读的时候按空间键优先 ✓。
 */
export function writeLastPage(pageId: string, spaceId?: string | null): void {
  if (!pageId) return;
  try {
    localStorage.setItem(LAST_PAGE_KEY, pageId);
    if (spaceId) localStorage.setItem(keyOf(spaceId), pageId);
  } catch {
    /* 记不住不影响用 */
  }
}

/** 清掉记忆（测试 / 将来「不记了」入口用 ✓）：给空间 ⇒ 只清这个空间；不给 ⇒ 只清老键。 */
export function clearLastPage(spaceId?: string | null): void {
  try {
    if (spaceId) localStorage.removeItem(keyOf(spaceId));
    else localStorage.removeItem(LAST_PAGE_KEY);
  } catch {
    /* 同上 */
  }
}
