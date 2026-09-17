// 「全库 AI 覆盖」P1 的**平台侧收口**：`deps` 的唯一构造点 + 抽取的唯一入口。
// 契约依据：docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.8。
//
// ## 为什么这两件事必须在**平台层**、而不是在 `extract/pipeline.ts` 里
// `platform → extract` **已经存在**（`sqliteStore.ts` import `extract/schema`、`extract/store`），
// 再加一条反向依赖就变成**双向依赖** ⇒ 抽取层拿不出去（CLI / 服务端索引 / Headless 全堵），
// 单测也被迫加载平台驱动。而抽取层今天能在 Windows 上秒级跑 140 条纯函数测试，靠的正是它不依赖平台。
//
// ⇒ **唯一性由这里承担**：抽取层永远只**接收** `deps`，**不构造** `deps`（`isolated.test.ts` 用源码级断言守着）。
//
// ## 与那两个"看起来更省事"的做法的区别
// - 让 `pipeline.ts` 自己 import 平台来注入：双向依赖（Mac 与 AMD 起初都主张这条，AMD 后来撤回了）；
// - 让各调用点自己拼 `deps`：同一抽取器在不同路径下行为不同（有 deps / 没 deps），那是最难查的一类 bug。

import { chunkSegments, type ChunkOwner } from "../extract/chunk";
import type { ChunkStore } from "../extract/chunkStore";
import { extractAndStore, type ExtractOutcome } from "../extract/pipeline";
import type { AttachmentTextStore } from "../extract/store";
import type { ExtractDeps, RasterizedPage } from "../extract/types";
import type { AttachmentMeta } from "../../types";
import { platform } from "./index";

export interface AttachmentDepsOptions {
  /**
   * 视觉模型调用。
   *
   * ⚠️ **目前必须由调用方给**，因为**平台还没有"模型驱动"这一层**
   * （`Platform` 只有 executor/dialog/opener/event/asset/webview/pdfRender/community）——
   * 而"图片/音视频抽取走远程 API 还是本机推理"正是方案 **§13 待拍板第 7 项**，还没定。
   *
   * 不给就**如实**让 `cost:"gpu"` 的抽取器返回 `provider_error`（契约 §15.3-7），
   * **不在这里编一个假实现**充数。
   */
  vision?: ExtractDeps["vision"];
}

/**
 * **唯一构造点**：把一个附件需要的平台能力装成 `deps`。
 *
 * `rasterize` 走平台驱动 `pdfRender.renderPdfPage(attId, pageIndex, scale)`。
 * 注意这里**刻意忽略 `bytes` 参数**：平台驱动要的是 attachmentId，而我们在闭包里就有 ——
 * 这与契约注释里写的"允许忽略 `bytes`"一致（`bytes` 的作用是让抽取器输入自足、假实现能被伪造）。
 *
 * 缩放比例**原样透传抽取器给的值**：由抽取器决定它需要多清晰，平台不另立一套口径。
 */
export function attachmentDeps(attId: string, opts: AttachmentDepsOptions = {}): ExtractDeps {
  const deps: ExtractDeps = {
    rasterize: async (_bytes, pageIndex, scale): Promise<RasterizedPage> => {
      // ⚠️ 字段名映射：平台驱动回的是 `bytes`，契约里叫 `rgba`（同一份数据、两处命名）。
      const page = await platform.pdfRender.renderPdfPage(attId, pageIndex, scale);
      return { rgba: page.bytes, width: page.width, height: page.height };
    },
  };
  if (opts.vision) deps.vision = opts.vision;
  return deps;
}

export interface ExtractAttachmentResult {
  meta: AttachmentMeta;
  outcome: ExtractOutcome;
  /** 本次落库的块数（0 表示没有可切分的文本）。 */
  chunks: number;
}

/** 抽取入口要用的两个派生库。 */
export interface ExtractAttachmentStores {
  /** `attachment_text`（P1）。 */
  text: AttachmentTextStore;
  /** `chunks`（P2）。传了就**顺手分块**，两个派生层不会漂移。 */
  chunks: ChunkStore;
}

/**
 * **唯一入口**：按 attachmentId 取字节 → 构造 deps → 抽取落库 → **顺手分块**。
 *
 * `stores` 由调用方传入：平台门面并没有暴露 `SqliteStore`（那是应用层持有的），
 * 与其为了这一个函数把 store 塞进 `Platform` 接口（要同时改 web/tauri/mobile 三个实现），
 * 不如显式传参 —— **显式依赖比扩大接口便宜**。
 *
 * **为什么把分块也放在这里**：分块的输入是"已落库的段"（见下），
 * 若让调用方各自在抽取后记得调一次分块，迟早会出现"文本更新了、块没更新"的漂移 ——
 * 而那种漂移**检索侧看不出来**（搜到的是旧块，还以为是最新的）。
 */
export async function extractAttachment(
  attId: string,
  stores: ExtractAttachmentStores,
  opts: AttachmentDepsOptions = {},
): Promise<ExtractAttachmentResult> {
  // 两步都走平台自己的命令面（桌面走原生命令、Web 走自家实现），抽取层不需要知道这些
  const meta = await platform.executor.invoke<AttachmentMeta>("get_attachment", { id: attId });
  const raw = await platform.executor.invoke<ArrayBuffer>("read_attachment_bytes", {
    hash: meta.hash,
  });
  const outcome = await extractAndStore({
    attId,
    bytes: new Uint8Array(raw),
    filename: meta.name,
    mime: meta.mime,
    hash: meta.hash,
    store: stores.text,
    deps: attachmentDeps(attId, opts),
  });

  // ---- 分块 ----
  // 切的是**已落库的段**（而不是刚抽出来的 `r.segments`）：落库时管道层做了归一化（§15.9），
  // 从库里读回来切，块文本与检索侧的文本**必然是同一份**。
  const owner: ChunkOwner = { kind: "attachment", attId };
  const shouldChunk =
    outcome.status === "stored" ||
    // 文本没变（cached）但**块是空的** ⇒ 补切一次。
    // 这条是给"分块能力上线之前就已经抽好的附件"用的：否则它们会永远没有块，
    // 而每次调用都重切又没必要（块 id/hash 稳定，重切是幂等但白做功）。
    (outcome.status === "cached" && stores.chunks.chunksOf(owner).length === 0);

  if (!shouldChunk) return { meta, outcome, chunks: stores.chunks.chunksOf(owner).length };

  const segments = stores.text.segmentsOf(attId).map((r) => ({ text: r.text, loc: r.loc }));
  const chunks = chunkSegments(owner, segments);
  stores.chunks.replace(owner, chunks);
  return { meta, outcome, chunks: chunks.length };
}
