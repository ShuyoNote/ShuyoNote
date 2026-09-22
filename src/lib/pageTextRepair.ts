// 阶段 1 · **正文文本的本地修复**（"正文待重建"那条边界的收口）。
//
// ## 为什么需要它
//
// 合并 / 裁决产物是**拼出来**的（服务端拼的、或本地按块拼的），而库里那份正文纯文本仍是**页级胜方那一份**
// ⇒ 那一页的 FTS 会有一段时间"搜不到刚合并进来的字"，要等下一次保存才重建
// （文档 §4/§6 都记了这条已知边界）。
//
// ## 修法：**不引第二份派生实现**
//
// 派生文本要**编辑器语义**（`src/lib/contentText.ts` 里的 `deriveContentText` 是唯一实现，
// 但它会拖进整张节点表 ⇒ 不能在同步路径里调用，见 `docs/development.md` 记的那条坑）。
// ⇒ 于是换一个方向：**有编辑器的那一侧**在打开页面时顺手算一遍（编辑器已经把文档解析好了），
// 把算出来的文本交给那一层（`docContent.refreshPageTextIfStale` / Rust
// `doc_content::refresh_page_text_if_stale`），由**那一层**与库里那份比、不同才写回 ——
// **只动正文文本**：不动内容、不动 `dirty`、不动 `updated_at`。
//
// 这一段判据只盯"要不要修 + 修的时候传什么"：真正算文本的是编辑器自己（那边已有判据）。

/** 修复需要的那个能力（注入进来，便于判据里做桩）。 */
export interface PageTextRepairDeps {
  /** 把算好的正文写回去（只动正文）。 */
  refresh: (pageId: string, text: string) => void;
}

/**
 * 需要修就修：`stored`（库里那份）与 `derived`（按编辑器语义算出来的）不同 ⇒ 调 `refresh`。
 *
 * 返回**是否修了**。**比较由那一层做**（它才读得到"库里那份"），这里只管判定逻辑，便于单独验。
 *
 * ⚠️ 三条边界：
 *   · **拿不到库里那份**（`undefined`）⇒ **不修**（不猜：这一页可能压根没读过）；
 *   · 两边相同 ⇒ 不修（绝大多数页面走这条，**没有额外写库**）；
 *   · 空页（两边都是空串）⇒ 相同 ⇒ 不修。
 */
export function repairPageTextIfStale(
  deps: PageTextRepairDeps,
  pageId: string,
  stored: string | undefined,
  derived: string,
): boolean {
  if (!pageId) return false;
  if (stored === undefined) return false;
  if (stored === derived) return false;
  deps.refresh(pageId, derived);
  return true;
}
