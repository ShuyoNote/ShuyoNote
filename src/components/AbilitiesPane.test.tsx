// 「还没上架」那一节的说明文字：⛔ 不许被压成「一个字一列」✗
//
// owner 2026-10-10 截图的**真 UI bug**：「英汉词库（ECDICT）」那条的 note 被压成一列 ✗，
// 右边一大片空白，而同节其它条（版面分析／看图识字／本地向量／音频转写）看不出问题 ✓。
//
// 根因（读 JSX ＋ 读 CSS 定位，⛔ 不是猜）：
//   · 那一格是 `<span className="set-row-sub">`，**直接当 `.set-row` 的 flex 子项** ✗；
//   · `.set-row { display:flex }`（App.css:13626）＋ `.set-row-sub` **没有** `min-width` ✗；
//   · CJK 文本可以在**任何字之间**断行 ⇒ flex 的自动最小尺寸 ＝ min-content ＝ **一个汉字** ✗
//     ⇒ note 一长就被挤成一列 ✓。
//   · ⭐ 而**兄弟**那一格 `.set-row-text`（App.css:13639-13642）**早就有** `flex:1; min-width:0` ✓
//     ⇒ 同一页里两种待遇 ✗ —— 这才是"为什么只有这一条坏"的答案 ✓
//   · 只有 ecdict 那条 note 长（≈60+ 字）⇒ 别的条挤到一列也看不出来 ✓
//
// ⚠️ 本机 **浏览器组跑不了**（要真 Chromium ＋ 真布局）✗ ⇒ 判据做成**结构级 ＋ CSS 级**（机械可判 ✓）：
//   a) 那一格**不许是裸的 `set-row-sub`** ✓ —— 它必须带**明确的宽度策略**（`set-row-note`）✓
//   b) **反向**：note 的**信息量**还在 ✓（⛔ 不许删掉、也不许换成「还没上架」一句了事 ✗）
//   c) 回归：别的条（短 note）**文字不变** ✓
//   d) ⭐ **挡住下一次**：`set-row-note` 那条规则**必须有** `min-width: 0` ✓ ——
//      这条才是"flex 经典坑"的判据（⛔ 光把宽度调宽不算修 ✓）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../i18n"; // 先初始化 i18n，免得刷一屏 NO_I18NEXT_INSTANCE（同 vaultGate.test.ts ✓）

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS = resolve(HERE, "../App.css");
const SRC_TSX = resolve(HERE, "AbilitiesPane.tsx");

// 本组件挂载时**不**联网（note 都是清单里的静态值 ✓）；只有点「下载」才会走 api ✓。
vi.mock("../lib/api", () => ({ api: new Proxy({}, { get: () => async () => ({}) }) }));
// ⭐ 2026-10-11（owner 截图问「下载完了，是不是应该移到『可用（已装）』？」）：给 `platform` 造桩 ✓ ——
//    组件挂载时会问一次 `dictionary_status` ✓；判据要能造出「⭐ 下完那一态 ✗」✓。
//    ⚠️ 默认 `available:false` ⇒ 词库**仍在「按需下载」** ✓ ⇒ 上面那几条老判据**一个字不受影响** ✓。
const stub = vi.hoisted(() => ({ dict: { available: false, verified: null as boolean | null }, fail: false }));
vi.mock("../lib/platform", () => ({
  platform: {
    executor: {
      invoke: async (cmd: string) => {
        if (cmd === "dictionary_status") {
          if (stub.fail) throw new Error("stub：读不到状态");
          return stub.dict;
        }
        return {};
      },
    },
    event: { listen: async () => () => {} },
  },
}));

const { AbilitiesPane } = await import("./AbilitiesPane");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root.render(React.createElement(AbilitiesPane)));
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

/** 「还没上架」那一节里的行（按**标题**找，不靠下标 —— 上下两节都有 `.set-row` ✓）。 */
function soonRows(): HTMLElement[] {
  const sec = [...host.querySelectorAll<HTMLElement>(".set-section")].find((s) =>
    (s.querySelector(".set-section-title")?.textContent ?? "").includes("还没上架"),
  );
  return [...(sec?.querySelectorAll<HTMLElement>(".set-row") ?? [])];
}

/** 一行里"那一格"＝ `.set-row` 的最后一个直接子元素（就是说明文字那格）。 */
const noteCellOf = (row: HTMLElement) => row.lastElementChild as HTMLElement;

describe("「还没上架」那节的说明文字：⛔ 不许被压成一列", () => {
  it("⭐ a) 那一格带**明确的宽度策略**（`set-row-note`），⛔ 不是裸的 `set-row-sub`", () => {
    const rows = soonRows();
    // ⚠️ **2026-10-10**：这一节原为 5 条 —— ⭐「英汉词库」升级成 `downloadable` 后**离开了这一节** ✓
    //    （同一次还按 owner 的口径删掉了「PDF 引擎」那条"验证用"的条目 ✓）
    // ⚠️ **2026-10-18**：3 条 —— ⭐「看图识字（VLM）」搬去了**第四态**那一节（`local-endpoint`）✓：
    //    它现在**能用**（靠本机 Ollama），只是模型不由本应用下发 ⇒ 不该再跟"还没上架"混在一起 ✓。
    expect(rows.length, "这一节应该有 3 条（看图识字已移到「需要本机模型」那一节）").toBe(3);
    for (const row of rows) {
      const cell = noteCellOf(row);
      expect(cell, "那一格必须是 `.set-row` 的直接子元素（就是它被 flex 压的现场）").not.toBeNull();
      expect(
        cell.classList.contains("set-row-note"),
        "⭐ 裸的 `set-row-sub` 直接当 flex 子项 ⇒ 长 CJK 会被压到一个字一列 ⇒ 必须带 `set-row-note` 那套宽度策略",
      ).toBe(true);
      expect(cell.classList.contains("set-row-sub"), "灰字那档样式仍要保留 ✓").toBe(true);
    }
  });

  it("⭐ b) 反向：note 的**信息量**还在（⛔ 不许删、也不许换成「还没上架」了事）", () => {
    const cell = longNoteCell();
    const text = cell.textContent ?? "";
    // ecdict 那条是所有 note 里唯一长的 —— 它必须**整段**都在 ✓
    // ⚠️ **2026-10-10（owner 拍「那句文案改掉」）**：这三条断言跟着**新文案**走 ✓ ——
    //    旧断言要的是「包已产出／还没托管」两个**内部词**，而它们**不该出现在用户面** ✓
    //    （⚠️ 而且「还没托管」那半**没有可核读数** ⇒ 已按 lead 的口径**不再断言、也不写** ✓）。
    //    ⭐ "不许换成四个字了事"这条**含义没变**：下限 30 远大于「还没上架」的 4 ✓。
    expect(text.length, "那条说明是长文本 ⇒ 不许被截成一句").toBeGreaterThan(30);
    // ⚠️⭐ **2026-10-10 第三次订正**：这一格现在是「按需下载」节里那行 ⇒ 它写的是
    //    `{summary} · {大小} · sha256 {前 12 位}…` ✓ ⇒ 断言跟着**现在用户看到的那句**走 ✓：
    expect(text, "它如实说了**下载多大**（用户据此决定要不要下）").toContain("39.1 MiB");
    expect(text, "以及**解压后多大**（磁盘占用据此判断）").toContain("85.6 MiB");
    expect(text, "并且写明了**校验收口**（sha256 前 12 位可见）").toContain("sha256");
  });

  it("⭐ c) 回归：别的条（短 note）文字不变", () => {
    const names = host.textContent ?? "";
    for (const n of ["版面分析", "看图识字（VLM）", "本地向量", "音频转写"]) {
      expect(names, `这一条还在：${n}`).toContain(n);
    }
    // 其余 3 条的说明仍是「还没上架」那一句（形状不变 ✓）
    // ⚠️ 原为 4 条 —— 「英汉词库」升级成 `downloadable` 后离开了这一节（见 a 那条的注释 ✓）
    for (const row of soonRows().slice(1)) {
      expect((noteCellOf(row).textContent ?? "").trim()).toBe("还没上架");
    }
  });

  // ⭐ **2026-10-10 订正**：这条判据原来要求"`set-row-note` **必须**有 `min-width: 0`" ✗ ——
  //    ⛔ **它是错的**：`min-width: 0` 正是**允许那一格被压到 0** 的那一半 ✗（＝成因 ✓），
  //    而它当时**绿着、现象没变** ✗（owner 截图里还是"一个字一列" ✓）。
  //    ⇒ 教训：⭐ **别判"文本里有没有某个声明"✗，判"那个形状对不对"** ✓（同 `spaceSecurity` 那次的误伤 ✓）。
  it("⭐ d) 那一格必须有**确定的宽度基准**（⛔ 不许 `0 1 auto`）—— 钉住「被 `.set-row-text` 饿死」那个成因", () => {
    const css = readFileSync(APP_CSS, "utf8");
    const m = /\.set-row-note\s*\{([^}]*)\}/.exec(css);
    expect(m, "`set-row-note` 必须有它自己的规则（本仓规矩：新类名没规则 = 裸的 ✗）").not.toBeNull();
    const rule = m![1];
    // ⛔ 成因那一半：base ＝ auto（＝ max-content ＝ 整句宽）⇒ 把兄弟饿死
    expect(
      /flex\s*:\s*0\s+1\s+auto/.test(rule),
      "又变成 `flex: 0 1 auto` 了 ⇒ 它的基准会是整句自然宽（实测 590px）⇒ 兄弟会被压到 0 ✗",
    ).toBe(false);
    // ⭐ 解药那一半：确定且有限的宽度（`flex: 0 0 <n>%` 或显式 width）
    expect(
      /flex\s*:\s*0\s+0\s+\d+%/.test(rule) || /width\s*:\s*\d+%/.test(rule),
      "少了确定的宽度基准 ⇒ 长 CJK 又会被压成一列（实测 textW = 0 ／ nameH = 90 ✗）",
    ).toBe(true);
    // ⚠️ 真验收**不是**这条判据：它是**回归闸** ✓ —— 真验收是 CDP 上的两个宽度数
    //    （修前 `textW = 0` ／ `nameH = 90` ⇒ 修后 `textW = 349.2` ／ `nameH = 18` ✓，
    //     626px 面板、同一夹具、同一轮 A/B ✓）。
  });

  it("⭐ e) 源码级：那份 JSX 里**不许**再出现裸的 `set-row-sub` 直接当 flex 子项", () => {
    const src = readFileSync(SRC_TSX, "utf8");
    expect(
      /<span className="set-row-sub">/.test(src),
      "裸 span 又回来了 ⇒ 下一次长文本还会被压成一列",
    ).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ⭐⭐ **2026-10-10（owner 拍 C）**：那条说明**压到 2 行 ＋ 悬停看全**。
  //
  // ⚠️ owner 自己承认过的顾虑：**"压缩 ＝ 把字藏起来"** ✗ ⇒ 所以判据**不能只判"有 2 行"** ✗，
  //    必须同时钉住：⭐ **全文仍在 DOM 里**（只是视觉截断）＋ ⭐ **悬停看得到全文**。
  //    ⛔ 也不许"把文案改短"（那是 owner **没选**的那个）⇒ 源码那句的长度也要钉 ✓。
  //
  // ⚠️ 真验收**不是** f)：它是回归闸 ✓ —— 真验收是**实量高度**（626px 面板、真 App.css、真那句文本，
  //    同一夹具 A/B：修前 `note.h = 130`（≈8.1 行）／长行 `152` ⇒ 修后 `note.h = 32`（＝2 行）／长行 `57`，
  //    四条短 note 两次都是 `16` ✓）。
  //
  // ⭐ **2026-10-10 第二次改**（owner 又拍「那句文案改掉」：⛔ 内部词「待拍板」不给用户看）⇒
  //    文案从 **236 字**改成 **≈49 字**（只描述用户看得见的状态：还不能下 ＋ 多大；内部状态留在
  //    `AbilitiesPane.tsx` 的注释与规格／台账里 ✓）
  //    ⇒ ⭐ 下面那条"长度下限"从 `> 200` 调成 `> 30` ✓ —— ⭐ **含义没变**：仍然挡"换成四个字了事"
  //    （30 远大于 4 ✓）；⚠️ **如实记：这个阈值是跟着文案长度走的**，⛔ 不是为了让红变绿 ✗
  //    （"DOM ＝ 源码那句"那条判据**一个字都没动** ✓）。
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * ⭐ 从**真源码**取 ecdict 那条的 **`summary`**（⛔ 不手抄 ⇒ 判据与被判对象同源）。
   * ⚠️⭐ **2026-10-10 第四次订正**：原来取的是 **`note`** 字段 ✗ —— 而「英汉词库」升级成
   *    `downloadable` 后搬进「按需下载」节，**那节只渲染 `summary`**（`note` 不渲染 ✗）⇒
   *    ⭐ 拿 `note` 去 DOM 里找**必然找不到**（候选里明明有那一格，却比不中 ✓）。
   *    ⇒ ⭐ 改取 `summary`：**用户实际看到的那一句**才该被钉 ✓。
   */
  function ecdictSummaryFromSource(): string {
    const src = readFileSync(SRC_TSX, "utf8");
    const m = /id:\s*"ecdict-en-zh"[\s\S]*?summary:\s*"((?:[^"\\]|\\.)*)"/.exec(src);
    expect(m, "源码里必须有 ecdict 那条 summary").not.toBeNull();
    return m![1].replace(/\\"/g, '"');
  }

  /**
   * ⭐⭐ **2026-10-10 订正**：那格原来按"「还没上架」节里的第 0 行"取 ✗ ——
   *   而「英汉词库」那条**升级成 `downloadable` 之后搬去了另一节** ⇒ ⭐ 那个位置现在是「版面分析」，
   *   它的 note 就是「还没上架」四个字 ⇒ 下面三条判据**全红**（而现象一个都没坏 ✗）。
   *   ⇒ ⭐ 改成**按那句话本身**找那格（⛔ 不靠它在哪一节、也不靠下标 ✓）：
   *     判据要钉的是「**那条长说明**不许被压成一列」，不是「它在第几节第几行」✓。
   *   ⚠️ **必须定义在 `describe` 内**（它要用上面的 `ecdictNoteFromSource` ✓ —— 放到文件顶层会 tsc 报错 ✗）。
   */
  function longNoteCell(): HTMLElement {
    const want = ecdictSummaryFromSource();
    // ⚠️⭐ **2026-10-10 第二次订正**：那一格**换了类名** —— 「英汉词库」升级成 `downloadable` 后
    //    从「还没上架」节搬进了「按需下载」节，而那节用的是 `.set-row-sub`（⛔ 不是 `.set-row-note`）✓
    //    ⇒ 判据按**那句话本身**找（⛔ 不靠类名、不靠哪一节、不靠下标 ✓），
    //      因为要钉的是"**那条长说明**不许被压成一列"，不是"它挂在哪个类上" ✓。
    const cells = [...host.querySelectorAll<HTMLElement>(".set-row-note, .set-row-sub")];
    const hit = cells.find((c) => (c.textContent ?? "").includes(want));
    // ⚠️ 找不到时**把候选印出来**（自诊断 ⇒ 别让人去猜为什么没找到 ✓）
    expect(
      hit,
      "⭐ 全文里必须有一格的文字**含**源码里那条长说明（长说明不见了 ⇒ 判据失去对象）。"
        + `候选 ${cells.length} 格：`
        + cells
            .map((c) => `〔${(c.textContent ?? "").slice(0, 26)}…〕`)
            .join(" "),
    ).not.toBeUndefined();
    return hit!;
  }

  it("⭐ f) CSS：那一格**最多 2 行**（视觉截断生效的三件套）", () => {
    const css = readFileSync(APP_CSS, "utf8");
    const m = /\.set-row-note\s*\{([^}]*)\}/.exec(css);
    expect(m, "`set-row-note` 必须有它自己的规则").not.toBeNull();
    const rule = m![1];
    expect(
      /-webkit-line-clamp\s*:\s*2\b/.test(rule),
      "少了 `-webkit-line-clamp: 2` ⇒ 那条长说明又会变成 7–8 行（owner 拍的是 2 行）",
    ).toBe(true);
    expect(/display\s*:\s*-webkit-box/.test(rule), "`line-clamp` 只对 `-webkit-box` 生效").toBe(true);
    expect(/overflow\s*:\s*hidden/.test(rule), "没有 `overflow: hidden` ⇒ 截断不生效").toBe(true);
  });

  it("⭐ g) 反向：**全文仍在 DOM 里**（⛔ 不许把话改短 —— 截断只发生在视觉层）", () => {
    const cell = longNoteCell();
    const full = ecdictSummaryFromSource();
    // ⭐ 下限 30：挡"换成四个字了事"（⚠️ 2026-10-10 文案改短后从 200 调到 30 —— 含义未变，见上面那段注释）
    expect(full.length, "那条说明仍旧是一整段（⛔ 不是四个字）").toBeGreaterThan(30);
    expect(
      cell.textContent ?? "",
      "⭐ DOM 里的那格必须**含完整那句** ⇒ ⛔ 不许把文案本身改短 ✗（那是 owner 没选的那个）",
    ).toContain(full);
    expect((cell.textContent ?? "").length).toBeGreaterThan(30);
  });

  it("⭐ h) 那一格**刻意没有** `title`（⛔ 不把内部措辞写进用户面）", () => {
    const cell = longNoteCell();
    // ⚠️⭐ **2026-10-10 第三次订正**：原来这条判「`title` ＝ 完整那句」—— ⭐ 那是为
    //    「还没上架」节里**被 `line-clamp: 2` 截断**的那格设计的 ✓。
    //    而「英汉词库」升级后搬进「按需下载」节 ⇒ ⭐ **那节不截断**（没有 `line-clamp`）⇒
    //    全文本来就在，**不需要** `title` 兜底 ✓；⚠️ 而那条 note 的措辞里带内部实现
    //    （`dictionary.rs`、两段校验）⇒ ⭐ **按 owner 的口径，⛔ 不许把它塞进用户面的 `title`** ✗。
    //    ⇒ 这条判据改成钉**那个决定**：这一格**没有** `title` ✓（⛔ 不是"忘了加" ✗）。
    expect(
      cell.getAttribute("title"),
      "⭐ 这一格不许有 `title` —— 内部措辞不进用户面（要改这条得先改 owner 那条口径 ✓）",
    ).toBeNull();
    expect((cell.textContent ?? "").length).toBeGreaterThan(30);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ⭐⭐ **2026-10-11（owner 拍「把 Office 导入登记成一条能力」）**
  //    「可用（已装）」那一节从此**不再空** ✓ —— 而这条判据同时钉住三件事：
  //      ① 收据：源码里真有这条 `builtin`（⛔ 不是只改文案 ✗）；
  //      ② 那一节**恰好一条**且写着「已装」；
  //      ③ ⭐ **不许夸大**：导入链第一期**只做 `.docx`** ✗ —— `ooxml.ts` 里虽然还有
  //         `xlsxExtractor` / `pptxExtractor`，但导入链**一次都没调**它们 ⇒
  //         用户面写"支持 Excel / PPT / 邮件 / 压缩包"就是**拿相邻的东西当证据** ✗（本仓栽过 ✓）。
  // ─────────────────────────────────────────────────────────────────────────────
  it("⭐ i) 「可用（已装）」不再空 ＋ ⛔ 这条能力**不许**把没接线的格式说成支持", () => {
    const src = readFileSync(SRC_TSX, "utf8");
    expect(
      /id:\s*"office-import"[\s\S]*?state:\s*"builtin"/.exec(src),
      "源码里没有把 office-import 登记成 builtin ⇒ 那一节又会是空的 ✗",
    ).not.toBeNull();

    const sec = [...host.querySelectorAll<HTMLElement>(".set-section")].find((s) =>
      (s.querySelector(".set-section-title")?.textContent ?? "").includes("可用（已装）"),
    );
    expect(sec, "找不到「可用（已装）」那一节").not.toBeUndefined();
    const rows = [...sec!.querySelectorAll<HTMLElement>(".set-row")];
    expect(rows.length, "这一节应当**恰好一条**（多了少了都说明登记面变了）").toBe(1);
    const claim = rows[0].textContent ?? "";
    expect(claim, "那条没写「已装」").toContain("已装");
    expect(claim, "那条的名字不是「Word 导入」").toContain("Word 导入");
    for (const bad of ["Excel", "PPT", "xlsx", "pptx", "邮件", "压缩包"]) {
      expect(claim, `⭐ 用户面写了「${bad}」⇒ 那个格式**没接线**（导入链只做 .docx）✗`).not.toContain(bad);
    }

    // 接线收据：这条能力得**真**有入口（⛔ 不是写一行字就说它有 ✗）
    // ⚠️ 路径从 `SRC_TSX` 推（它本来就是真文件系统路径 ✓）——
    //    ⛔ 别用 `new URL(…, import.meta.url)` ✗：**vitest 里那是 http URL** ⇒ `readFileSync`
    //    报「The URL must be of scheme file」✗（两版都踩过：先拼成 `src/components/App.tsx` ✗，
    //    再换成 import.meta.url ✗）⇒ 现在只把 `components/AbilitiesPane.tsx` 这段换成 `App.tsx` ✓。
    const app = readFileSync(SRC_TSX.replace(/components[\\/][^\\/]+$/, "App.tsx"), "utf8");
    expect(app, "App 里没有 <OfficeImportPanel ⇒ 那这条就不是「已装」而是空话 ✗").toContain("<OfficeImportPanel");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ⭐⭐ **2026-10-11（owner 截图问「下载完了，是不是应该移到『可用（已装）』？」）**
  //    答案：⭐ **该移** ✓ —— 原清单是**写死的** ⇒ 盘上明明有那份包，界面还说「按需下载」✗
  //    （⭐ 与"已经接线了却还写没接入"同一个病 ✓）。
  //    做法：⭐ 挂载时问一次后端 `dictionary_status`（⭐ **带缓存校验** ✓）；
  //    ⚠️ **只有 `available && verified` 才算已装** ✗，查不到 ⇒ **当作没装** ✓（⭐ 宁少说 ✓）。
  // ─────────────────────────────────────────────────────────────────────────────
  const sectionByTitle = (kw: string) =>
    [...host.querySelectorAll<HTMLElement>(".set-section")].find((s) =>
      (s.querySelector(".set-section-title")?.textContent ?? "").includes(kw),
    );
  const rowsIn = (kw: string) => [...(sectionByTitle(kw)?.querySelectorAll<HTMLElement>(".set-row") ?? [])];
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("⭐ j) 下载成功后 ⇒ 词库**自己移到「可用（已装）」**（owner 问的那件 ✓）", async () => {
    stub.fail = false;
    stub.dict = { available: false, verified: null };
    await settle();
    expect(rowsIn("按需下载").length, "下之前它应当在「按需下载」里").toBe(1);
    const btn = [...host.querySelectorAll<HTMLButtonElement>("button.set-btn")].find((b) =>
      (b.textContent ?? "").includes("下载"),
    );
    expect(btn, "找不到那颗下载按钮").not.toBeUndefined();
    flushSync(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    const installed = rowsIn("可用（已装）").map((r) => r.textContent ?? "");
    expect(installed.length, "下完 ⇒ 已装那节应当是两条：Word 导入 ＋ 英汉词库").toBe(2);
    expect(installed.join("|"), "词库没移过去").toContain("英汉词库");
    expect(installed.join("|"), "它得写着「已装」").toContain("已装");
    expect(rowsIn("按需下载").length, "「按需下载」里不该再列它").toBe(0);
  });

  it("⭐ k) 查不到 ／ 没核过 ⇒ ⛔ **不许**说已装（fail-closed ✓）", async () => {
    stub.fail = true;
    await settle();
    // ⚠️ 这里不能重挂载（`beforeEach` 已经挂过、effect 依赖是 []）⇒ 判的是**默认那一态**：
    //    `available:false` / 查询失败 ⇒ ⭐ 词库**必须留在「按需下载」**✓，⛔ 不许跑进「已装」✗。
    expect(rowsIn("可用（已装）").length, "查不到就当成没装 ⇒ 已装那节只应有 Word 导入一条").toBe(1);
    expect(rowsIn("按需下载").length, "查不到 ⇒ 它还留在「按需下载」里，用户还能再下一次").toBe(1);
    expect(rowsIn("可用（已装）").map((r) => r.textContent ?? "").join("|"), "⛔ 不许把没核过的词库说成已装 ✗").not.toContain(
      "英汉词库",
    );
  });
});
