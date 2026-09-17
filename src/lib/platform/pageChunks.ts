// 页面侧的"正文 → 块"入口 —— 与附件侧的 `extractAttachment` 同构（`platform/extractDeps.ts`）。
//
// ## 为什么需要它（P2 现在只覆盖了一半）
// `chunks` 目前**只从附件产生**（`extractAttachment` 里顺手分块）。但用户的知识库里
// **页面才是主体**：一份 50 页的 PDF 是少数，几百页手写笔记/制度正文是常态。
// 页面正文在 `content_text` 里（§2 的体检结论：它是页面正文的纯文本镜像），
// 所以页面侧**不需要抽取器**，只需要"读出来 → 切块 → 落库"。
//
// ## 为什么不做"增量/脏标记"
// 页面每次保存都会变，但没有暴露内容哈希。与其加一张"页面版本 → 已切到哪"的表，
// 这里用一条更简单也更准的判据：**先把块算出来，再和库里已有的逐行比**（id + hash），
// **一样就不写**。理由：
//  - 分块是纯字符串运算，重算很便宜；**写库**才是贵的（Web 侧每条写都触发全库快照，§7）；
//  - 不需要新表、不需要新状态，也就不存在"脏标记与真实内容不一致"这类 bug；
//  - 块 id/hash 本来就稳定（`chunk.ts`），所以"没变 ⇒ 不写 ⇒ 已有嵌入继续有效"自然成立。

import { chunkText, type Chunk, type ChunkOwner } from "../extract/chunk";
import type { ChunkStore } from "../extract/chunkStore";
import type { PageDetail } from "../../types";
import { platform } from "./index";

export interface ChunkPageResult {
  pageId: string;
  /** 切出来的块数（0 = 这个页面没有正文）。 */
  chunks: number;
  /** 这次**是否真的写库**了（false = 内容没变，跳过了写）。 */
  changed: boolean;
}

/** 逐行比较"算出来的块"与"库里已有的块"：id 与 hash 都一样就没变。 */
function sameChunks(current: readonly Chunk[], stored: readonly Chunk[]): boolean {
  if (current.length !== stored.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (current[i].id !== stored[i].id || current[i].hash !== stored[i].hash) return false;
  }
  return true;
}

/**
 * 把一个页面切成块并落库。
 *
 * ⚠️ `content_text` 是**页面正文的纯文本镜像**（为搜索/反链/导出设计）。
 * 图片 / 视频 / 附件引用 / 数据库块**不在里面**（§2 的体检结论）——
 * 它们由 P1 的抽取层负责，与本函数无关。**本函数不解决那个缺口，只是不重复解决它。**
 */
export async function chunkPage(
  pageId: string,
  store: ChunkStore,
  opts: { title?: string } = {},
): Promise<ChunkPageResult> {
  const page = await platform.executor.invoke<PageDetail>("get_page", { id: pageId });
  const owner: ChunkOwner = { kind: "page", pageId };
  // 标题可由调用方覆盖（它可能刚改过、还没写回库里）；默认用库里的。
  const title = opts.title ?? page.title ?? "";
  const next = chunkText(owner, page.content_text ?? "", title);

  const stored = store.chunksOf(owner);
  if (sameChunks(next, stored)) return { pageId, chunks: next.length, changed: false };

  store.replace(owner, next);
  return { pageId, chunks: next.length, changed: true };
}

/** 批量（顺序执行，一次一个）：全库页面重建块时用。 */
export async function chunkPages(
  pageIds: readonly string[],
  store: ChunkStore,
): Promise<ChunkPageResult[]> {
  const out: ChunkPageResult[] = [];
  for (const id of pageIds) out.push(await chunkPage(id, store));
  return out;
}

/** 页面被删除时清掉它的块（否则会留下**永远检索得到、但页面已不存在**的孤儿块）。 */
export function removePageChunks(pageId: string, store: ChunkStore): void {
  store.remove({ kind: "page", pageId });
}
