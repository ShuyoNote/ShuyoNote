// 表格浮动工具栏（`TableMenuPlugin`）的三条判据 —— 这一格此前**一条判据都没有**（`src/editor/`
// 下 10 个判据文件一个都没碰它），而用户实测的形状是：
// **「工具栏出现了 ✓、有 hover ✓，但点按钮没反应 ✗」**。
//
// 三条各钉一件事：
//   ① 光标进表格 ⇒ DOM 里真的出现 `.table-menu`（"它到底出不出来"）；
//   ② ⭐ 点「下方插入行」⇒ **编辑器状态**里那张表行数 +1（⛔ 不断言 DOM 行数 ✗ ——
//      只看 DOM 会把"命令空转"整个放过去 ✓）；
//   ③ ⭐ 按下按钮那一下（只 `mousedown`、不 `mouseup`）工具栏**不许先消失** ✗。
//
// 形状抄仓里既有的那一份：`src/editor/insertShortcut.test.ts:29-69`（真 `LexicalComposer` ＋
// 真 `ContentEditable` ＋ 真 `editor.getEditorState()` 读数，断言落**状态**不落外观）。
// ⚠️ 本仓**没有 @testing-library**（`package.json` 里没有它）⇒ 没有 `fireEvent`；
//    用仓内既有惯例 `flushSync` ＋ 原生 `dispatchEvent`（见 `src/components/SyncPanel.trustDevicePanel.wiring.test.tsx`）。
//
// ⚠️⚠️ **宿主里必须挂上与 `Editor.tsx` 同形的另外两个插件**（`BlockSelectionPlugin` /
//    `ClickToEditPlugin`）—— 第一版只挂 `TableMenuPlugin` 时这三条**全绿**，而应用里是坏的：
//    "判据自己骗自己"就是这么发生的。实测（本文件，A/B 只差一个插件的挂载）：
//      · 挂 `ClickToEditPlugin`：② 红 —— 行数停在 2、工具栏消失、按下后光标在**表格外**；
//      · 不挂：② 绿 —— 行数 3、工具栏还在、光标仍在 `r0c0`。
//    真因：这两个插件在 **`.editor-shell` / document 的 mousedown（捕获阶段）**上判定"块手势"，
//    排除清单是 `src/editor/blockGestures.ts:23-32` —— **`.table-menu` 不在里面** ✗
//    （列宽手柄 `.table-resize-handle` 在 ✓，那是 2026-10-01 / 10-06 两次事故补进去的）。
//    ⇒ 按工具栏按钮 = 在 `.editor-shell` 里按下 ⇒ `ClickToEditPlugin.tsx:18-30` 的
//    `isSafeMarqueeTarget` 判它"空白安全区"（按钮不在 `p,h1..td,th` 里，而 `.editor-shell` 命中）
//    ⇒ **起框选**（实测：mousedown 之后 `.block-box-select` 已经挂在 `document.body` 上 ✓）⇒
//    它那条 `mouseup` 挂在 **document 捕获阶段**、比 `click` 先跑（`ClickToEditPlugin.tsx:110-144`）
//    ⇒ 把光标挪去"离按下点最近的顶层块" ✗ ⇒ 等按钮的 `onClick` 跑到时
//    `$getActiveTableContext()` 已经是空 ✗ ⇒ `if (ctx)` 整段跳过 ✓ = 用户看到的"**点了没反应**"。
//    ⛔ 与"被浮层盖住"无关（有 hover ⇒ 没被盖 ✓），也与本插件自己那段"点 `.editor-shell` 外就关"
//    （`TableMenuPlugin.tsx:123-135`）无关（工具栏就在 `.editor-shell` 里 ✓）—— ③ 绿就是这条的读数。
//
// ⚠️ happy-dom 的 `getBoundingClientRect()` **全是 0** ⇒ "离按下点最近的块"会退化成
//    "永远选第一个块"，那不是真形状。所以下面 `stubLayout()` 给两个顶层块钉一个**确定的版面**
//    （段落 `0..26`、表格 `40..160`），并按 `TableMenuPlugin.tsx:86` 的 `rect.top - 40`
//    取按下点（`clientY=14`）—— 那里正是工具栏按钮所在、也在表格上方那一段。
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, type ElementNode, type LexicalEditor } from "lexical";
import { $createTableNodeWithDimensions, $isTableNode } from "@lexical/table";
import { EDITOR_NODES } from "./config";
import { BlockSelectionPlugin } from "./plugins/BlockSelectionPlugin";
import { ClickToEditPlugin } from "./plugins/ClickToEditPlugin";
import { TableMenuPlugin } from "./plugins/TableMenuPlugin";
import { $getActiveTableContext } from "./plugins/tableHelpers";
import { silenceLexicalDevWarnings } from "../test/lexicalWarnings";

// Lexical dev 构建在这个环境里会打 updateEditorSync 警告（见 src/test/lexicalWarnings.ts）
// ——只静音那一条，其余警告照旧输出。
silenceLexicalDevWarnings();

interface Harness {
  editor: LexicalEditor;
  host: HTMLDivElement;
  /** 卸干净：否则下一个用例的 `document.querySelector(".editor-shell")` 会命中上一个宿主，
   *  判据③就会因为**残留**而假红（那是判据自己的错，不是产品的错）。 */
  dispose: () => void;
}

let harness: Harness | null = null;

afterEach(() => {
  harness?.dispose();
  harness = null;
});

/** 挂一个最小可用的编辑器：与应用同一份节点清单 ＋ **同形的三个插件**（见文件头 ⚠️⚠️）。 */
function setup(): Harness {
  let editor: LexicalEditor | null = null;
  function Probe() {
    [editor] = useLexicalComposerContext();
    return null;
  }
  const host = document.createElement("div");
  host.className = "editor-shell"; // 与 Editor.tsx:694 同形
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() =>
    root.render(
      <LexicalComposer
        initialConfig={{
          namespace: "table-menu-test",
          nodes: EDITOR_NODES,
          onError: (e: Error) => {
            throw e;
          },
        }}
      >
        <Probe />
        <RichTextPlugin
          contentEditable={<ContentEditable className="editor-content" aria-label="编辑器" />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <BlockSelectionPlugin />
        <ClickToEditPlugin />
        <TableMenuPlugin />
      </LexicalComposer>,
    ),
  );
  if (!editor) throw new Error("编辑器没挂起来");
  const h: Harness = {
    editor: editor as LexicalEditor,
    host,
    dispose: () => {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
  harness = h;
  return h;
}

/**
 * 塞一个「一段话 ＋ 一张 `rows × cols` 的表」，并把光标放进**第一个单元格**
 * （`$getActiveTableContext()` 认的就是"选区锚点能不能往上找到 TableCellNode"，
 * 见 `src/editor/plugins/tableHelpers.ts:36-53`）。
 *
 * ⚠️ 上面那段话不是装饰：用户页面里表格上面几乎总有内容，而真凶那条路正是拿
 * "离按下点最近的顶层块"当落点（`ClickToEditPlugin.tsx:121-141`）。
 */
function seedDoc(editor: LexicalEditor, rows: number, cols: number) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const lead = $createParagraphNode();
      lead.append($createTextNode("表格上面的一段话"));
      root.append(lead);
      const table = $createTableNodeWithDimensions(rows, cols, false);
      root.append(table);
      // ⚠️ `getFirstChild()` 的静态类型是 `LexicalNode` ⇒ 要往下走三层必须**显式当 ElementNode** ✓
      //   （tsc 实测报过 `TS2339: Property 'getFirstChild' does not exist on type 'LexicalNode'` ✓）
      const row = table.getFirstChild() as ElementNode | null;
      const cell = row?.getFirstChild() as ElementNode | null;
      cell?.getFirstChild()?.selectStart();
    },
    { discrete: true },
  );
}

/**
 * 给顶层块钉确定的版面（happy-dom 的 `getBoundingClientRect()` 全是 0，几何型插件会退化）。
 * 版面照用户看到的形状：段落 `0..26`，表格 `40..160` ⇒ 工具栏落在表格上方 40px
 * （`TableMenuPlugin.tsx:86` 的 `rect.top - 40`）＝ 段落下半段那一片。
 */
function stubLayout(editor: LexicalEditor, boxes: { top: number; height: number }[]) {
  editor.getEditorState().read(() => {
    $getRoot()
      .getChildren()
      .forEach((node, i) => {
        const el = editor.getElementByKey(node.getKey());
        const box = boxes[i];
        if (!el || !box) return;
        el.getBoundingClientRect = () =>
          ({
            x: 0,
            y: box.top,
            left: 0,
            top: box.top,
            right: 600,
            bottom: box.top + box.height,
            width: 600,
            height: box.height,
          }) as DOMRect;
      });
  });
}

/** 从**编辑器状态**里读第一张表的行数。⛔ 不数 DOM 行 —— 命令空转时外观可以纹丝不动。 */
function tableRows(editor: LexicalEditor): number {
  return editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find($isTableNode);
    return table ? table.getChildrenSize() : -1;
  });
}

/**
 * 光标现在停在哪 —— 判据就用插件自己那一条（`$getActiveTableContext()`，
 * `src/editor/plugins/tableHelpers.ts:36-53`）：它返回 null ⇒ 按钮的 `onClick` 里
 * `if (ctx)` 一定整段跳过。
 * ⚠️ 别拿 `anchor.getNode().getType()` 当判据：单元格里的锚点本来就报 `paragraph`
 *    （第一版把它读成"光标跑出表格了" ✗ —— 假读数比没有读数更坏）。
 */
function caretSpot(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => {
    const ctx = $getActiveTableContext();
    if (ctx) return `表格内 r${ctx.rowIndex}c${ctx.colIndex}`;
    const s = $getSelection();
    if (s === null) return "表格外（无选区）";
    return `表格外（selection=${s.constructor.name}${$isRangeSelection(s) ? `, anchor=${s.anchor.getNode().getType()}` : ""}）`;
  });
}

const menu = () => document.querySelector<HTMLDivElement>(".table-menu");
const menuButton = (title: string) => document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);

/** 等一拍：插件里的 `run()` 走的是**非 discrete** 的 `editor.update`（TableMenuPlugin.tsx:139），
 *  它排在微任务里落地，读状态/读 DOM 都要等它。 */
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  await tick();
  await tick();
  flushSync(() => {});
}

/** 照用户手指的次序按一下：mousedown → mouseup → click（都 `cancelable`，按钮才 preventDefault 得动）。
 *  `clientY=14` 是工具栏按钮所在的高度（见 `stubLayout()` 的版面）。 */
function press(btn: HTMLElement, clientY = 14) {
  for (const type of ["mousedown", "mouseup", "click"]) {
    flushSync(() => {
      btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
    });
  }
}

/** 桌面版面（见 `stubLayout()`）：段落 `0..26`、表格 `40..160`。 */
const LAYOUT = [
  { top: 0, height: 26 },
  { top: 40, height: 120 },
];

/** 三个用例共用的夹具：一段话 ＋ 2×2 表，光标在第一格，版面已钉。 */
function fixture() {
  const h = setup();
  seedDoc(h.editor, 2, 2);
  stubLayout(h.editor, LAYOUT);
  return h;
}

describe("表格浮动工具栏（TableMenuPlugin）", () => {
  it("① 光标落在表格里 ⇒ DOM 里出现 .table-menu", async () => {
    const { editor } = setup();
    expect(menu(), "前提：还没进表格，不该有工具栏").toBeNull();

    seedDoc(editor, 2, 2);
    stubLayout(editor, LAYOUT);
    await settle();

    expect(tableRows(editor), "前提：表得真在编辑器状态里（2 行）").toBe(2);
    expect(caretSpot(editor), "前提：光标在单元格里").toBe("表格内 r0c0");
    expect(menu(), "光标在表格单元格里时，工具栏应当出现在 DOM 里").not.toBeNull();
  });

  it("② ⭐ 点「下方插入行」⇒ 编辑器状态里那张表真的多一行（不是只看 DOM）", async () => {
    const { editor } = fixture();
    await settle();

    const btn = menuButton("下方插入行");
    expect(menu(), "前提：工具栏得先出现（见判据①）").not.toBeNull();
    expect(btn, "前提：「下方插入行」按钮得在工具栏里").not.toBeNull();
    const before = tableRows(editor);
    expect(before, "前提：起始 2 行").toBe(2);
    expect(caretSpot(editor), "前提：按下之前光标在单元格里").toBe("表格内 r0c0");

    press(btn as HTMLButtonElement);
    await settle();

    const after = tableRows(editor);
    expect(
      after,
      `点「下方插入行」之后，**编辑器状态**里那张表应当是 ${before + 1} 行，实际 ${after} 行；` +
        `按下后光标＝${caretSpot(editor)}，工具栏还在＝${!!menu()}。` +
        "红 ⇒ 按钮的 onClick 跑到时 `$getActiveTableContext()` 已经不是表格了（命令整段被 `if (ctx)` 跳过）",
    ).toBe(before + 1);
  });

  it("③ ⭐ 只 mousedown（还没 mouseup）时，工具栏不许先消失 —— 「点了没反应」的守门人", async () => {
    // ⚠️ 本判据只要 fixture 的副作用（建编辑器 ＋ 挂插件）⇒ 解构出来的 editor 用不上 ✓
    //   （tsc 实测报过 `TS6133: 'editor' is declared but its value is never read` ✓）
    fixture();
    await settle();

    const btn = menuButton("下方插入行");
    expect(menu(), "前提：工具栏得先出现（见判据①）").not.toBeNull();
    expect(btn, "前提：按钮得在工具栏里").not.toBeNull();

    flushSync(() => {
      (btn as HTMLButtonElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 14 }));
    });

    expect(
      menu(),
      "按下按钮那一下工具栏就不见了 ⇒ 后面的 click 没有落点，用户看到的就是「点按钮没反应」",
    ).not.toBeNull();
  });
});
