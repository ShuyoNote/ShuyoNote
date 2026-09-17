// 抽取器接口契约（冻结 v1）—— 见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15。
//
// 冻结日期 2026-09-17。**分家开工前以 §15 为准，不要各自发挥**；要改契约先改那一节再改这里。
//
// 一句话：抽取器只做「格式 → 带定位的段」，不做分块（分块是 P2 的职责）；失败返回结构化
// 错误码而不抛异常；网络只经注入的 deps.vision，不自建客户端（守「默认不出网」的红线）。

/** 抽取器的算力档位 —— 调度器据此排队错峰（6GB 显存放不下「文本＋嵌入＋VLM」三件常驻）。 */
export type ExtractCost = "cpu" | "gpu";

/** 段类型：决定检索侧如何展示与加权，也决定 loc 的格式（§15.2）。 */
export type SegmentKind =
  | "text" // 普通正文
  | "heading" // 标题（docx Heading / pptx 标题占位符）
  | "table" // 表格：text 内用 \t 分列、\n 分行
  | "sheet" // 工作表整表：loc = 'S<名或序号>'
  | "slide" // 幻灯片：loc = 'slide <n>'
  | "ocr" // 图像识别得到的文字：loc = 'p.<n>' 或 ''
  | "caption" // 图像/图表的语义描述（VLM 产出）
  | "transcript"; // 音视频转写：loc = 'HH:MM:SS'

export type ExtractErrorCode =
  | "unsupported" // 本抽取器不认这个格式（调度器应换一个）
  | "encrypted" // 加密 / 口令保护
  | "corrupt" // 结构损坏
  | "empty" // 合法但抽不出内容（扫描件常见）
  | "timeout"
  | "provider_error" // VLM/ASR 端点不可达或未配置
  | "internal";

/**
 * 光栅化一页的产物：**一张编码图**（不是裸 RGBA）。
 *
 * ⚠️ 这个形状改过一次（2026-09-17，Mac 侧开工 `pdf.ocr` 时撞出来的）：
 * 原先定的是 `{ rgba, width, height }`（照桌面 `pdfium_native::render_page` 的裸像素来的），
 * 但那样**两侧都缺一步**——`deps.vision` 只接受编码图
 * （`src/lib/ai/ocrVision.ts` 要的是 `data:image/...;base64,…`），
 * 而"RGBA → 编码图"在抽取层做不了（要 canvas / 编解码库，正是隔离断言禁的那类）。
 *
 * ⇒ 现在**光栅化这一步直接产出编码图**。选它而不是"保留裸 RGBA + 再加一个 encode 能力"，理由是：
 *  1. **少一个能力就少一处三轴漂移**（能力要登记、要三边实现、要各自的假实现）；
 *  2. **裸 RGBA 要求三台机器对字节序 / 行 stride / 是否预乘 alpha 达成一致** ——
 *     这是一类**不会报错、只会悄悄画错**的约定，且没有一处能把它测出来。
 *     PNG 没有这些自由度：要么解出对的图，要么解不开；
 *  3. 生产代码里**没有 `deps.rasterize` 的裸像素消费者**（阅读器用的是平台**驱动**的
 *     `renderPdfPage`，那是另一回事，**没有改**）。
 */
export interface RasterizedPage {
  /** 编码后的图片字节。 */
  bytes: Uint8Array;
  /** 必须是 `deps.vision` 能直接接受的图片类型（实现用 `image/png`）。 */
  mime: string;
  width: number;
  height: number;
}

/**
 * **平台能力注入点** —— 抽取层需要"平台才会做的事"时，一律从这里注入。
 *
 * 三条不变量（对应 §15.3）：
 *  1. **全部可选，且抽取器不许自己想办法**：没注入就返回 `provider_error`；
 *     绝不自建网络客户端、不自带渲染器、不 import `src/lib/platform/**`。
 *  2. **只能由平台层构造**（唯一的 `attachmentDeps(...)` 入口），抽取层内**禁止**平台 import ——
 *     否则抽取层在 CI / Node / Headless 上就跑不了，而那正是它至今能做纯函数单测的前提。
 *     有**源码级断言**守着这条（`isolated.test.ts`）。
 *  3. **形状与原生实现对齐**：桌面 `pdfium_native::render_page(cache_key, bytes, page_index, scale)`
 *     本来就是"bytes 进、RGBA + 宽高出"（AMD 侧查证）⇒ **入口这一侧**是薄适配；
 *     出口之所以改成编码图，理由见 `RasterizedPage`。
 */
export interface ExtractDeps {
  /** 视觉模型调用（图片 / 视频关键帧 / 扫描件页）。**由平台层注入**。
   *  未注入时，需要它的抽取器必须返回 `provider_error`，不许抛（§15.3-7）。
   *  ⚠️ `image` 是**编码图字节**（配 `mime`），不是裸像素。 */
  vision?: (prompt: string, image: Uint8Array, mime: string) => Promise<string>;
  /** 把 PDF 的某一页（0 基）渲染成**编码图**。**由平台层注入**。
   *
   *  为什么需要：扫描件要"页 → 图"才能走 `vision`，而抽取器手上只有 `bytes`
   *  （平台原有的 `renderPdfPage(attachmentId, …)` 要的是存储层 id，抽取层不该知道 id）。
   *
   *  ⚠️ 注入的实现**允许忽略 `bytes`**（用构造闭包时捕获的 attachmentId 走原生路径）——
   *  这是刻意的：`bytes` 在这里的作用是"让抽取器保持输入自足、假实现能被 trivially 伪造"。
   *
   *  ⚠️ **Web 平台尚无实现**（`renderPdfPage` 是抛异常的桩）⇒ Web 构建下 `pdf.ocr`
   *  **预期**返回 `provider_error`，**这是已知状态不是 bug**（补它属平台层的活，见 §15.8）。 */
  rasterize?: (
    bytes: Uint8Array,
    pageIndex: number,
    scale: number,
  ) => Promise<RasterizedPage>;
}

export interface ExtractInput {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  /** 附件内容寻址哈希（attachments.rs:291）。回写 src_hash，并用于日志关联。 */
  hash: string;
  deps: ExtractDeps;
}

export interface ExtractedSegment {
  kind: SegmentKind;
  /** **纯文本**：不含 Markdown / HTML / 任何标记，检索与嵌入直接用这一份（§15.3-3）。 */
  text: string;
  /** 给人看的定位：'p.12' | 'S3!B4' | 'slide 7' | '00:03:21' | ''（无定位时）。
   *  **不做机器解析** —— 回链由页面侧的 att:// / pdf://#page 负责（§15.3-4）。 */
  loc: string;
}

export type ExtractResult =
  | { ok: true; extractor: string; segments: ExtractedSegment[] }
  | { ok: false; extractor: string; code: ExtractErrorCode; message: string };

export interface Extractor {
  /** **稳定标识 + 版本**：'<family>.<format>@<n>'，例 'ooxml.docx@1'。
   *  换实现 ⇒ 升 n ⇒ 可按 extractor 整批重跑（§6.1 的 extractor 列）。 */
  readonly id: string;
  /** 认领的 MIME（小写）。 */
  readonly mimes: readonly string[];
  /** MIME 缺失/不可信时的扩展名兜底（小写，含点）。 */
  readonly extensions: readonly string[];
  /** 算力档位。 */
  readonly cost: ExtractCost;
  extract(input: ExtractInput): Promise<ExtractResult>;
}

/** 构造成功结果的糖（保证 `extractor` 字段与实现 id 一致，避免手写漏填）。 */
export function ok(extractor: string, segments: ExtractedSegment[]): ExtractResult {
  return { ok: true, extractor, segments };
}

/** 构造失败结果的糖。 */
export function fail(
  extractor: string,
  code: ExtractErrorCode,
  message: string,
): ExtractResult {
  return { ok: false, extractor, code, message };
}
