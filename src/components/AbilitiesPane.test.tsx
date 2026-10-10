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
    expect(rows.length, "这一节应该有 5 条").toBe(5);
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
    const cell = noteCellOf(soonRows()[0]);
    const text = cell.textContent ?? "";
    // ecdict 那条是所有 note 里唯一长的 —— 它必须**整段**都在 ✓
    // ⚠️ **2026-10-10（owner 拍「那句文案改掉」）**：这三条断言跟着**新文案**走 ✓ ——
    //    旧断言要的是「包已产出／还没托管」两个**内部词**，而它们**不该出现在用户面** ✓
    //    （⚠️ 而且「还没托管」那半**没有可核读数** ⇒ 已按 lead 的口径**不再断言、也不写** ✓）。
    //    ⭐ "不许换成四个字了事"这条**含义没变**：下限 30 远大于「还没上架」的 4 ✓。
    expect(text.length, "那条说明是长文本 ⇒ 不许被截成一句").toBeGreaterThan(30);
    expect(text, "它如实说了**现在还不能下**（用户看得见的状态）").toContain("下载渠道还在准备");
    expect(text, "以及它有多大（用户据此决定要不要下）").toContain("85.6 MiB");
  });

  it("⭐ c) 回归：别的条（短 note）文字不变", () => {
    const names = host.textContent ?? "";
    for (const n of ["版面分析", "看图识字（VLM）", "本地向量", "音频转写"]) {
      expect(names, `这一条还在：${n}`).toContain(n);
    }
    // 其余 4 条的说明仍是「还没上架」那一句（形状不变 ✓）
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

  /** ⭐ 从**真源码**取 ecdict 那条 note（⛔ 不手抄 ⇒ 判据与被判对象同源）。 */
  function ecdictNoteFromSource(): string {
    const src = readFileSync(SRC_TSX, "utf8");
    const m = /id:\s*"ecdict-en-zh"[\s\S]*?note:\s*([\s\S]*?),\n\s*\}/.exec(src);
    expect(m, "源码里必须有 ecdict 那条 note").not.toBeNull();
    const parts = [...m![1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\"/g, '"'));
    return parts.join("");
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
    const cell = noteCellOf(soonRows()[0]);
    const full = ecdictNoteFromSource();
    // ⭐ 下限 30：挡"换成四个字了事"（⚠️ 2026-10-10 文案改短后从 200 调到 30 —— 含义未变，见上面那段注释）
    expect(full.length, "那条说明仍旧是一整段（⛔ 不是四个字）").toBeGreaterThan(30);
    expect(
      cell.textContent ?? "",
      "⭐ DOM 里必须是**完整那句** ⇒ ⛔ 不许把文案本身改短 ✗（那是 owner 没选的那个）",
    ).toBe(full);
    expect((cell.textContent ?? "").length).toBeGreaterThan(30);
  });

  it("⭐ h) 悬停能看到全文（`title` ＝ 完整那句）", () => {
    const cell = noteCellOf(soonRows()[0]);
    const title = cell.getAttribute("title") ?? "";
    expect(
      title,
      "⭐ 既然列表里截断了，就必须能看全：`title` 是**完整那句**（⛔ 不是缩写、⛔ 不是空）",
    ).toBe(ecdictNoteFromSource());
    expect(title.length).toBeGreaterThan(30);
    // ⛔ 不许自己写浮层（owner 拍的形状就是现成的 `title` ✓）
  });
});
