// 能力在**前端（渲染进程）**这一侧的实现。
//
// 插件那一侧的实现是 Rust（`src-tauri/src/plugins.rs` 的 cap_*）；两边消费的是
// **同一份注册表**（capabilities/capabilities.json），所以工具的 id / 描述 / 参数
// schema / 是不是写操作都只有一处定义——这里只负责"怎么在前端真去执行"。
// 门禁（scripts/check-capabilities.mjs）会校验注册表里 `ai:true` 的能力在这里都有实现。
//
// 语义要与插件侧保持一致：省略 pageId 时都用**当前打开的页面**（插件侧由宿主解析，
// 这一侧由 notes store 解析）。

import { codePointLength, sliceByCodePoints } from "../textSnippet";
import { api } from "../api";
import { coverageReportTool, scanLibraryCoverage } from "../libraryCoverage";
import { fenceDoc, importMarkdownArgs, pageReadMeta } from "../docContent";
import { annotatedWindow, blockEndOffsets, pageRev } from "./pageAnchors";
import { pageJsonFromText } from "../ai/lexical";
import type { DraftResult } from "../ai/types";
import type { CoverageStores } from "../extract/coverageReport";

/** 宿主（AI 宿主）传给适配器的上下文：当前打开的页面 ＋ 派生层 store 的取用口。 */
export interface AdapterContext {
  currentPageId?: string | null;
  /** 「全库索引覆盖报告」要的那对 store（由有平台的那一层注入，见 `AiToolContext.derivedStores`）。 */
  derivedStores?: () => Promise<CoverageStores | undefined>;
}

export type CapabilityAdapter = (
  args: Record<string, unknown>,
  ctx?: AdapterContext,
) => Promise<unknown>;

// 与 web.ts 的 uid() 同形（本地一份，避免把平台内部实现拖进能力层）。
function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function draft(key: string, summary: string, payload: unknown): DraftResult {
  return { draft: true, key, summary, payload };
}

/**
 * 数值型参数的取值口径：**只认整数（或能解析成整数的字符串），其余一律回落默认值**。
 *
 * 这是照着 Rust 侧逐字对齐的 —— `plugins.rs` 的 `arg_i64`：
 *
 * ```rust
 * args.get(name).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(default)
 * ```
 *
 * 于是三件事必须一致：① `0` 与负数**是合法值**（要取默认值的是"非法值"，不是"假值"）——
 * 写 `Number(x) || d` 会把 `0` 当成没传（这轮在四个适配器上各犯了一遍）；
 * ② 小数**回落默认值**（Rust 的 `as_i64()` 对 `2.5` 拿不到值）—— 取地板会在 `limit: 2.5` 时
 * 变成 TS 2 / 桌面 200；③ 数字字符串可以（`"7"` ⇒ 7，与 Rust 的 `parse()` 一致，含前置 `+`）。
 */
function intOr(v: unknown, d: number): number {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : d;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : d;
  }
  return d;
}

/**
 * 数值型参数的**统一读法**：`取值（只认整数，见 intOr）→ 夹取到 [min, max]`。
 * 与 Rust 侧的 `arg_i64("<名>", 默认)` ＋ `limit.clamp(min, max)` 是同一套口径。
 *
 * 为什么必须收成一处（2026-09-18）：这轮对着注册表核对时，同一个坑在**四个适配器**上各犯了一遍 ——
 * 写成 `args.limit > 0 ? … : 默认` 或 `typeof args.limit === "number" ? … : 默认`，
 * 于是 `limit=0` 在 TS 侧被当成"没传"、在 Rust 侧被 `clamp(1,·)` 夹到 1
 * （`files.search` 10 vs 1、`files.read` 200 vs 1、`pages.get` 6000 vs 1…）。
 * 这类分歧两边都能跑、都返回合理结果，只能靠"三处摆一起"或机器判据发现；
 * 各自写一遍就一定会再犯，所以这里只留一个实现。
 */
function intArg(
  args: Record<string, unknown>,
  name: string,
  def: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  return Math.min(max, Math.max(min, intOr(args[name], def)));
}

/**
 * 布尔参数的统一读法（与 Rust 侧 `arg_bool` 同一口径）：真布尔 / `"true"`·`"false"`·`"1"`·`"0"`
 * / 数字（非 0 为真）都认，其它回落默认值。
 *
 * 为什么认字符串：插件 shim 由生成器按 `String(...)` 传布尔 ⇒ 插件写 `false` 时收到的是 `"false"`；
 * 不认它的话"显式关"与"没传"在两条路径上是同一个结果（默认 true 时尤其看不出来）。
 */
function boolArg(args: Record<string, unknown>, name: string, def: boolean): boolean {
  const v = args[name];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  if (typeof v === "number") return v !== 0;
  return def;
}

/**
 * 省略 pageId 时用当前打开的页面（与插件侧同一语义：**宿主解析**，插件不用自己猜）。
 *
 * 当前页来自宿主传进来的 ctx —— 这里**刻意不导入 UI store**：能力层要保持薄，
 * 一旦它依赖 store，就会把整条 UI 依赖链（编辑器/公式/katex…）拖进 AI 能力层。
 */
function targetPage(args: Record<string, unknown>, ctx?: AdapterContext): string {
  const given = String(args.pageId ?? "");
  if (given) return given;
  return ctx?.currentPageId ?? "";
}

/**
 * `pages.get` 单次返回正文的**上限**（字，按码点）。与 Rust 侧 `MAX_PAGE_TEXT_LIMIT` 一致，
 * 也与 `capabilities/capabilities.json` 里 `limit` 的 desc 一致。
 *
 * ⚠️ 这个上限本身是既有行为（防止一页几万字把模型上下文撑爆），**没有改**。
 * 改的是"截断时**说不说**"以及"**能不能往下翻**"——见 `pages.get` 实现里的注释。
 */
const PAGE_TEXT_LIMIT = 6000;
const MAX_PAGE_TEXT_LIMIT = 20_000;

/**
 * `blocks.list` 的 `limit` 默认值与上限，**必须与 Rust 侧一致**
 * （`cap_blocks_list`: `limit.clamp(1, 500)`，注册表 `default: 100`）。
 * 两侧不一致的症状很隐蔽：同一个页面在 Web 与桌面返回的块数不同，而调用方无从察觉。
 */
const BLOCKS_LIMIT_DEFAULT = 100;
const BLOCKS_LIMIT_MAX = 500;

/** `pages.search` 的 `limit` 默认值与上限：与注册表 `default: 8`、Rust `limit.clamp(1, 100)` 一致。 */
const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 100;

/**
 * `pages.list` 的 `limit` 默认值与上限：注册表 `default: 50`、Rust `cap_pages_list` 的 `clamp(1, 200)`。
 * ⚠️ 这是**外部 agent 的发现通路**（搜索之外唯一能看到"这个空间有什么"的工具）⇒ 排序口径也必须一致：
 * 按 `updated_at` 倒序，不是侧栏树的 `sort_order/created_at` 顺序。
 */
const PAGES_LIST_LIMIT_DEFAULT = 50;
const PAGES_LIST_LIMIT_MAX = 200;

/** `files.search` 的 `limit`：注册表 `default: 10`、Rust `cap_files_search` 的 `clamp(1, 100)`。 */
const FILES_SEARCH_LIMIT_DEFAULT = 10;
const FILES_SEARCH_LIMIT_MAX = 100;

/**
 * `files.read` 的 `offset`/`limit`：注册表 `default: 0 / 200`，
 * Rust `cap_files_read` 的 `offset.max(0)` ＋ `limit.clamp(1, MAX_ATT_TEXT_LIMIT=1000)`。
 */
const FILES_READ_LIMIT_DEFAULT = 200;
const FILES_READ_LIMIT_MAX = 1000;

export const FRONTEND_ADAPTERS: Record<string, CapabilityAdapter> = {
  // ⭐ 2026-10-17：`pages.list` 进 AI/MCP 面 —— 外部 agent 以前**只能搜索**，
  // 搜不到就等于"库里没有"（没有第二条发现通路）。排序口径与 Rust 侧 `cap_pages_list` 一致：
  // `updated_at` 倒序（`api.listPages` 给的是侧栏树的 `sort_order/created_at` 顺序，别直接用）。
  "pages.list": async (args) => {
    const limit = intArg(args, "limit", PAGES_LIST_LIMIT_DEFAULT, 1, PAGES_LIST_LIMIT_MAX);
    // ⭐ 2026-10-18：`spaceId` —— 指定别的空间时走 `listWorkspacePages`（只读、不动活动空间 ✓）；
    //   不指定就是本空间那一条（`api.listPages`）。排序/字段两边一致。
    const spaceId = String(args.spaceId ?? "").trim();
    const rows = spaceId ? await api.listWorkspacePages(spaceId) : await api.listPages();
    const sorted = [...rows].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    return {
      ok: true,
      pages: sorted.slice(0, limit).map((p) => ({
        id: p.id,
        title: p.title,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
    };
  },

  "pages.search": async (args) => {
    const query = String(args.q ?? "");
    // ⚠️ 默认值与上限**必须与注册表和 Rust 侧逐值相同**（`check-capabilities` 会比对注册表
    // 与 Rust 的字面默认值）。这里原先默认 8 却不夹取，而 Rust 是 `limit.clamp(1, 100)`：
    // 传 `limit: 999` 时 Web 与桌面拿到的条数就不一样了。
    const limit = intArg(args, "limit", SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX);
    if (!query) return { ok: false, error: "pages.search 需要 q" };
    const spaceId = String(args.spaceId ?? "").trim();
    if (!spaceId) {
      const rows = await api.search(query, limit, false);
      return { ok: true, pages: rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })) };
    }
    // ⭐ 2026-10-18：指定了空间 ⇒ 走**全空间**检索再按 `workspace_id` 筛（命令面没有"只搜某一个
    // 非活动空间"的入口）。候选集给到 200（`search` 的上限），筛完再截 limit —— 否则跨空间那一路
    // 会因为"每空间平分 limit"而少给。
    const all = await api.search(query, 200, true);
    const rows = all.filter((r) => r.workspace_id === spaceId).slice(0, limit);
    return { ok: true, pages: rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })) };
  },

  "pages.get": async (args) => {
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "pages.get 需要 id" };
    const p = await api.getPage(id);
    if (!p) return { ok: false, error: `未找到页面 ${id}` };

    // ⚠️ **这里刻意不再 `trim()`**（2026-09-18 改）。原因不是洁癖，是分页一旦存在，
    // 窗口的"起点"就必须是**同一个固定字符串**：
    //   · 桌面路径（Rust `cap_pages_get`）切的是库里原始的正文列；
    //   · 这里若先 trim，`offset=6000` 在两条路径上指向的**不是同一个字符**
    //     ⇒ 调用方按同一条规则翻页会漏字/重字，而这种错**只在正文首尾有空白时**才出现（极难发现）。
    // 返回忠实原文也顺带满足"截断不改写文本"的既有原则（见下）。
    const raw = String(p.content_text ?? "");
    const total = codePointLength(raw); // 按码点计数，emoji 不会被算成 2
    // ⚠️ **别用 `|| 默认值`**：`limit=0` 是 falsy，会被换成 6000，而 Rust 侧 `limit.clamp(1, ·)`
    // 给的是 1 ⇒ 同一个调用在两条路径上返回 6000 字与 1 字。这类"边界差一个"的坑靠 `Number.isFinite` 判。
    const offset = intArg(args, "offset", 0, 0);
    const limit = intArg(args, "limit", PAGE_TEXT_LIMIT, 1, MAX_PAGE_TEXT_LIMIT);
    const window = sliceByCodePoints(raw, offset, limit);
    // ⚠️ `returned` / `truncated` / note 里的字数**一律量正文窗口**，不含锚点行：
    // 锚点是我们加的注释，不该被算成"用户读到了几个字"，否则翻页口径（offset+returned）就变了。
    const returned = codePointLength(window);
    // `truncated` 的含义是"**还没读完**"（窗口没够到正文末尾），而不是"这页太长"：
    // 翻到最后一页时它必须是 false，否则模型会以为还有内容、无限翻下去。
    const truncated = offset + returned < total;

    // ⭐ P1 读面（2026-10-29）：**块锚点**（默认开）＋ `rev`（乐观并发令牌，不受开关影响）。
    //   · 锚点只插在本次窗口里 ⇒ 分页截断时不会给没返回的块加锚点；
    //   · 关掉开关 ⇒ 正文**逐字节**等于旧行为（读面省 token 的通道）；
    //   · `rev` 的两样输入只经 `docContent` 那一层取（落盘列名别处不许碰，见 `check-doc-content-access`）。
    const includeAnchors = boolArg(args, "includeAnchors", true);
    const meta = pageReadMeta(p);
    const rev = await pageRev(meta.updatedAt, meta.docJson);
    const text =
      includeAnchors && meta.docJson !== null
        ? annotatedWindow(raw, blockEndOffsets(meta.docJson, raw), offset, limit)
        : window;

    // ⚠️ **"成功"不等于"读全了"** —— 与抽取层的 `ExtractCoverage` 同一条原则（方案 §15.10）。
    // 原先截断后只在末尾补一个 `…`，有两个问题：
    //  ① **有歧义**：原文本身可能就以省略号结尾，模型分不清哪个是我们加的；
    //  ② **没信号**：模型看到 6000 字会以为"这就是整页"，然后自信地总结一个片段。
    // ⇒ 现在**不再改写文本**（返回的就是原文的忠实窗口），截断与否由**显式字段**说明，
    //    并且**直接告诉模型下一步该做什么**（否则它拿到"已截断"也不知道怎么办）。
    const parts: string[] = [];
    if (truncated) {
      parts.push(
        `内容已截断：该页正文共 ${total} 字，本次返回第 ${offset + 1}~${offset + returned} 字。` +
          `**不要据此以为读完了整页**；继续读取请再调 pages.get 并传 offset=${offset + returned}` +
          `（也可先 pages.search 定位相关段落，再用 blocks.list 逐块读）。`,
      );
    } else if (offset > 0) {
      // 翻到末尾时也要有明确信号，否则模型分不清"读完了"和"传错 offset 拿到空串"。
      parts.push(`本次返回第 ${offset + 1}~${offset + returned} 字，已到正文末尾（共 ${total} 字）。`);
    }
    return {
      ok: true,
      page: {
        id: p.id,
        title: p.title,
        content_text: text,
        truncated,
        chars_total: total,
        offset,
        limit,
        chars_returned: returned,
        ...(rev ? { rev } : {}),
        ...(parts.length ? { note: parts.join("") } : {}),
      },
    };
  },

  // ⚠️ 这条适配器原本与注册表**有两处分歧**（2026-09-18 对着注册表查出并修掉）：
  //  ① 注册表声明 `pageId` **可选**（"省略 = 当前打开的页面"），这里却当必填直接报错 ——
  //     桌面路径（Rust `cap_blocks_list` → `target_page_or_current`）是支持省略的
  //     ⇒ 同一段插件代码在桌面能用、在 Web 报错。改成与 `backlinks.list` 一样走 `targetPage(args, ctx)`。
  //  ② 注册表声明 `limit`（默认 100），这里**根本没读** ⇒ Web 上"传了也没用"，
  //     而 Rust 侧 `limit.clamp(1,500).take(limit)` 是兑现的 ⇒ 两条路径返回的块数可能不同。
  // 这类"注册表承诺、某一侧不兑现"的分歧**没有任何编译期信号**，只能靠机器判据守
  // （`check-capabilities` 现在会检查两侧都读了声明的参数）。
  "blocks.list": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "blocks.list 需要 pageId（省略时需要一个当前打开的页面）" };
    const limit = intArg(args, "limit", BLOCKS_LIMIT_DEFAULT, 1, BLOCKS_LIMIT_MAX);
    const blocks = await api.getPageBlocks(pageId);
    return { ok: true, blocks: blocks.slice(0, limit).map((b) => ({ blockId: b.block_id, text: b.text })) };
  },

  "backlinks.list": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "backlinks.list 需要 pageId" };
    const links = await api.getBacklinks(pageId);
    return { ok: true, backlinks: links.map((l) => ({ id: l.id, title: l.title })) };
  },

  "files.list": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "files.list 需要 pageId" };
    const files = await api.listPageAttachments(pageId);
    return {
      ok: true,
      files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
    };
  },

  "files.search": async (args) => {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, error: "files.search 需要 query" };
    const limit = intArg(args, "limit", FILES_SEARCH_LIMIT_DEFAULT, 1, FILES_SEARCH_LIMIT_MAX);
    const hits = await api.searchChunks(query, limit);
    // 原样透出（pageId/attId/loc 就是回链三件套）：这一层**不加工**，
    // 免得 AI 与插件看到两种形状 —— 加工（拼标题、去重）属于调用方的展示逻辑。
    return { ok: true, hits };
  },

  "files.read": async (args) => {
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "files.read 需要 id" };
    const offset = intArg(args, "offset", 0, 0);
    const limit = intArg(args, "limit", FILES_READ_LIMIT_DEFAULT, 1, FILES_READ_LIMIT_MAX);
    const page = await api.readAttachmentText(id, offset, limit);
    // ⚠️ **不存在**（null）与**还没抽过**（segments 空）必须分开回话：
    //    合成一种，AI 就会把"还没索引"读成"文件里没有相关内容" —— 与 §15.10 用 ExtractCoverage
    //    防的是同一件事，只是发生在 AI 工具面。
    if (page === null) return { ok: true, file: null };
    return {
      ok: true,
      file: {
        id,
        segments: page.segments.map((r) => ({ extractor: r.extractor, kind: r.kind, text: r.text, loc: r.loc })),
        total: page.total,
        truncated: page.truncated,
        ...(page.segments.length === 0
          ? {
              note:
                "该附件没有派生文本：可能没有抽取器认领这种格式、抽取失败、或还没跑过抽取。" +
                "**不要**据此断言文件里没有相关内容。",
            }
          : {}),
      },
    };
  },

  /**
   * `coverage.report` —— **只有 AI 宿主实现的能力**（注册表里 `host: "frontend"`，插件调不到）。
   *
   * 为什么没有 Rust 那半：报告要判"**没人认领这种格式**（`no_extractor`）"，而"谁认领什么格式"
   * 的唯一事实源是 TS 侧的抽取器注册表（`extract/registry.ts`）。Rust 侧再长一份就是两份实现，
   * 而它们的漂移**不会报错**（只会让 AI 与插件看到两种答案）——这正是本方案一直在防的事。
   * ⇒ 这里**复用**现成的三层：`ctx.derivedStores()`（配对 store）→ `scanLibraryCoverage`（取材）
   * → `coverageReportTool`（形状），一行新逻辑都不写。
   *
   * ⚠️ **store 是 `ctx` 注入的，不是这里 `import { platform }`**：这层会被 `smoke-web` 的
   * AI 核心包静态打包，而那个包只装纯逻辑 —— 见 `AiToolContext.derivedStores` 的注释。
   */
  "coverage.report": async (_args, ctx) => {
    const getStores = ctx?.derivedStores;
    if (!getStores) {
      return { ok: false, error: "这条路径没有派生层存储，索引覆盖报告不可用（桌面版/已启用本地库才有）" };
    }
    const stores: CoverageStores | undefined = await getStores();
    if (!stores) return { ok: false, error: "这个平台没有派生层存储，索引覆盖报告不可用" };
    return coverageReportTool(await scanLibraryCoverage(stores));
  },

  "pages.create": async (args) => {
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "pages.create 需要 title" };
    // ⭐ R166：带 `fence` ⇒ **一整块** code 块 ✓（⛔ 不拆块 ✗）
    const fence = typeof args.fence === "string" && args.fence ? args.fence : null;
    const { content_json, content_text } = fence
      ? fenceDoc(fence, String(args.content ?? ""), makeId)
      : pageJsonFromText(String(args.content ?? ""), makeId);
    const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
    return draft(`create_page:${title}`, `新建页面「${title}」`, {
      kind: "create_page",
      args: { parent_id: parentId, title, content_json, content_text },
    });
  },

  // ⭐ R167：整篇 Markdown 导入（一次写完 ✓）—— 能力面只做**轻守卫**与组参 ✓，
  // 真正的 md→块解析在落库层（应用自己的导入路径 ✓）—— 避免把编辑器整张图拖进这个包 ✗
  "pages.importMarkdown": async (args) => {
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "pages.importMarkdown 需要 title" };
    const built = importMarkdownArgs(title, String(args.markdown ?? ""), typeof args.parentId === "string" && args.parentId ? args.parentId : null);
    if (!built.ok) return { ok: false, error: built.error };
    return draft(`import_markdown:${title}`, `导入 Markdown 新建页面「${title}」`, {
      kind: "create_page",
      args: built.args,
    });
  },

  // ⭐ pages.update（2026-10-17）：**整页替换**已有页面 —— 与 Rust `cap_pages_update` 同一语义：
  //   只产出草稿、不落库；正文只做轻守卫（空/超限），md→块的解析留给落库层（`ai/apply.ts` ✓）。
  //   ⚠️ 目标页 id 必填（Rust 侧 `arg_str("id")?` ✓），不走"当前页"回落。
  "pages.update": async (args) => {
    const id = String(args.id ?? "").trim();
    if (!id) return { ok: false, error: "pages.update 需要 id" };
    const markdown = typeof args.markdown === "string" ? args.markdown : "";
    const content = typeof args.content === "string" ? args.content : "";
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
    if (!markdown.trim() && !content.trim()) {
      return { ok: false, error: "pages.update 需要 markdown 或 content 之一" };
    }
    const bodyLen = Math.max(markdown.length, content.length);
    if (bodyLen > 200 * 1024) {
      return { ok: false, error: "pages.update 的新正文超过 200KB 上限，请拆分后再更新" };
    }
    const body = markdown.trim() ? { markdown } : { plain: content };
    return draft(`update_page:${id}`, `更新页面 ${id}（整页替换）`, {
      kind: "update_page",
      pageId: id,
      title,
      ...body,
    });
  },

  // ⭐ spaces.list / spaces.switch（2026-10-17）：MCP / AI 宿主都要能看见并切换空间。
  //   list：只读两跳（listWorkspaces + active id）；switch：只产出草稿，真正切换走 store（唯一实现）。
  "spaces.list": async () => {
    const [spaces, active] = await Promise.all([api.listWorkspaces(), api.getActiveWorkspaceId()]);
    return {
      ok: true,
      active,
      spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
    };
  },

  "spaces.switch": async (args) => {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!id && !name) return { ok: false, error: "spaces.switch 需要 id 或 name 之一" };
    const spaces = await api.listWorkspaces();
    let target: { id: string; name: string } | null = null;
    if (id) {
      target = spaces.find((s) => s.id === id) ?? null;
    } else {
      const hits = spaces.filter((s) => s.name === name);
      if (hits.length > 1) {
        return { ok: false, error: `有 ${hits.length} 个空间都叫「${name}」，请改用 id` };
      }
      target = hits[0] ?? null;
    }
    if (!target) return { ok: false, error: "找不到目标空间（可先调 spaces.list）" };
    return draft(`switch_space:${target.id}`, `切换空间到「${target.name}」`, {
      kind: "switch_space",
      spaceId: target.id,
      name: target.name,
    });
  },

  "blocks.append": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    const text = String(args.text ?? "").trim();
    if (!pageId) return { ok: false, error: "blocks.append 需要 pageId" };
    if (!text) return { ok: false, error: "blocks.append 需要 text" };
    return draft(
      `append_block:${pageId}:${text.slice(0, 24)}`,
      `向页面追加 ${text.split("\n").filter((s) => s.trim()).length} 个段落`,
      { kind: "append_block", pageId, text, fence: args.fence ?? null },
    );
  },
};
