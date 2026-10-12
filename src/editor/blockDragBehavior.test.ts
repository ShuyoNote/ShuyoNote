// 块拖拽的**行为**判据 —— **恰好四条**。此前拖拽的行为**一条判据都没有** ✗：
// `blockDragWiring.test.ts` 只钉"开关真的开着 ＋ 唯一入口仍被它掐着"（接线 ✓），
// 它自己在文件头就写着「⛔ 别把本文件读成"拖拽已被验收"」✓。
//
// 来由：2026-10-02 曾因"橡皮筋"体验把拖拽**整块关掉**（`dd8d19d5`）⇒ 2026-10-12 owner 说「打开」
//   ⇒ `Editor.tsx:731` 变成 `<BlockDragPlugin dragEnabled />` ✓。这四条就是补上"打开之后它到底对不对"。
//
// 四条各钉一件事（**断言落编辑器状态 / 插件的真实可见产物**，⛔ 不落"插件被挂上了"这类自证 ✗）：
//   ① 阈值：`mousedown` 后位移 <5px（**含恰好 5px**）⇒ 不起拖（无幽灵、无落点线、编辑器仍可编辑）；
//      位移 >5px ⇒ 起拖（幽灵 `.block-handle--dragging` ＋ `body.is-dragging-block`）。
//      ⚠️ 恰好 5px 这一格按**源码真实语义**钉：`BlockDragPlugin.tsx:293` 是 `> 25`（不是 `>=`）
//      ⇒ 恰好 5px **不起拖** ✓（2026-10-12 Lead 拍：以源码为准，不为这个 off-by-one 改实现 ✓）。
//   ② 落点线：拖到**第 3 块**的中段 ⇒ `.block-drop-line` 画在**第 3 块**的边缘（块位对）。
//   ③ ⭐ 松手**真的落库**：`editor.getEditorState()` 里顶层块的**文本顺序真的变了**（⛔ 不看 DOM ✗）。
//   ④ 点一下 ≠ 拖：原地 `mousedown`+`mouseup` ⇒ 块菜单 `.block-grip-menu` 照旧开 ＋ 顺序不动。
//
// 形状抄仓里刚落地的那一份（`src/editor/tableMenu.test.tsx`，真 `LexicalComposer` ＋ 真
//   `ContentEditable` ＋ 真状态读数 ＋ 手工 `dispatchEvent`），文件后缀按任务要求是 **`.ts`**
//   ⇒ 与 `src/editor/insertShortcut.test.ts:39-65` 同形，用 `createElement` 而不是 JSX ✓。
//
// ⚠️⚠️ **宿主必须挂上 `Editor.tsx` 里同形的插件集合**（`Editor.tsx:731` `BlockDragPlugin` /
//    `:733` `BlockSelectionPlugin` / `:735` `ClickToEditPlugin`）—— 后两个都在 **document 捕获阶段**
//    的 `mousedown` 上判"块手势"（`BlockSelectionPlugin.tsx:66-93` / `ClickToEditPlugin.tsx:73-90`），
//    正是与拖拽**抢手势**的那两个。只挂 `BlockDragPlugin` 一个 ⇒ 把"手柄没被排除、按下即起框选"
//    这类坏形状放过去 ✗（同一个坑 `tableMenu.test.tsx:16-31` 头注里逐字写着 ✓）。
//    它们放行 `.block-handle` 靠的是共用清单 `blockGestures.ts:24` ✓ —— 本文件因此也顺带钉住了它。
//
// ⚠️ happy-dom 的 `getBoundingClientRect()` **全是 0** ⇒ 而拖拽是**纯几何**插件
//    （`BlockDragPlugin.tsx:62/77-86` 拿 `rect` 挑最近的块、`:204-208` 用 `rect` 画落点线）：
//    全 0 时 `findTargetBlock` 会永远挑中第一个块、落点线永远在同一个位置 —— 那不是真形状。
//    ⇒ 四条**全部**用下面 `stubLayout()` 钉一份确定版面（先例：`tableMenu.test.tsx:148-174`）。
//    如实交代：①④（阈值 / 点一下）其实不依赖几何也能立（手柄只看位移），
//    ②③ 则**必须**靠 stub，否则"块位对不对"根本量不出来 ✓。
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "./config";
import { BlockDragPlugin } from "./plugins/BlockDragPlugin";
import { BlockSelectionPlugin } from "./plugins/BlockSelectionPlugin";
import { ClickToEditPlugin } from "./plugins/ClickToEditPlugin";
import { useBlockSelection } from "../store/blockSelection";
import { silenceLexicalDevWarnings } from "../test/lexicalWarnings";

// Lexical dev 构建在这个环境里会打 updateEditorSync 警告（见 src/test/lexicalWarnings.ts）
// ——只静音那一条，其余警告照旧输出。
silenceLexicalDevWarnings();

interface Harness {
  editor: LexicalEditor;
  host: HTMLDivElement;
  /** 卸干净：`useBlockSelection` 是**模块级** store，宿主残留会让下一个用例的
   *  `.block-handle` / 菜单读数命中上一个用例的东西（那是判据自己的错，不是产品的错）。 */
  dispose: () => void;
}

let harness: Harness | null = null;

afterEach(() => {
  harness?.dispose();
  harness = null;
  // 退出多选模式会顺带清空已选（`src/store/blockSelection.ts:32-33`）✓
  useBlockSelection.getState().setSelectMode(false);
});

/** 挂一个最小可用的编辑器：与应用同一份节点清单 ＋ **同形的三个插件**（见文件头 ⚠️⚠️）。 */
function setup(): Harness {
  let editor: LexicalEditor | null = null;
  function Probe() {
    [editor] = useLexicalComposerContext();
    return null;
  }
  useBlockSelection.getState().setSelectMode(false); // 防止上一个用例漏下的多选态
  const host = document.createElement("div");
  host.className = "editor-shell"; // 与 Editor.tsx:694 同形
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() =>
    root.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: "block-drag-behavior-test",
            nodes: EDITOR_NODES,
            onError: (e: Error) => {
              throw e;
            },
          },
        },
        createElement(Probe),
        createElement(RichTextPlugin, {
          contentEditable: createElement(ContentEditable, { className: "editor-content", "aria-label": "编辑器" }),
          placeholder: null,
          ErrorBoundary: LexicalErrorBoundary,
        }),
        // ⚠️ `dragEnabled` **必须显式传**：默认是 `false`（`BlockDragPlugin.tsx:99`）——
        //    那正是 10-02→10-12 之间"拖了不动"的状态，传漏了这四条会**全绿**而应用里是关的 ✗。
        createElement(BlockDragPlugin, { dragEnabled: true }),
        createElement(BlockSelectionPlugin),
        createElement(ClickToEditPlugin),
      ),
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

/** 塞 3 个顶层段落（文本 = 判据里的顺序读数）。手柄只对**非空**块出现（`isEmptyBlock`）⇒ 必须带字 ✓。 */
function seedBlocks(editor: LexicalEditor, labels: string[]) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const label of labels) {
        const p = $createParagraphNode();
        p.append($createTextNode(label));
        root.append(p);
      }
    },
    { discrete: true },
  );
}

/**
 * 给顶层块钉确定的版面（happy-dom 的 `getBoundingClientRect()` 全是 0，几何型插件会退化）。
 * 版面：A `0..26`、B `40..66`、C `80..106` ⇒ 三段互不重叠、中心 13 / 53 / 93。
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

/** 从**编辑器状态**里读顶层块的文本序列 —— 判据③④的顺序判据就是它（⛔ 不读 DOM ✗）。 */
function blockTexts(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() => $getRoot().getChildren().map((c) => c.getTextContent()));
}

/** 顶层块当前的 DOM 元素（顺序同状态）。 */
function blockEls(editor: LexicalEditor): HTMLElement[] {
  return editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map((c) => editor.getElementByKey(c.getKey())))
    .filter((e): e is HTMLElement => e !== null);
}

const mouseOn = (target: EventTarget, type: string, init: MouseEventInit) => {
  flushSync(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
};

/** 等一拍：插件的状态更新 ＋ `useEffect` 里挂的 document 监听都要落地（先例 `tableMenu.test.tsx:206-211`）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  await tick();
  await tick();
  flushSync(() => {});
}

/** 桌面版面（见 `stubLayout()`）：A `0..26`、B `40..66`、C `80..106`。 */
const LAYOUT = [
  { top: 0, height: 26 },
  { top: 40, height: 26 },
  { top: 80, height: 26 },
];

function fixture() {
  const h = setup();
  seedBlocks(h.editor, ["A", "B", "C"]);
  stubLayout(h.editor, LAYOUT);
  return h;
}

/** 把指针悬到第 1 块上 ⇒ 插件应当渲染出 `⋮⋮` 手柄（`BlockDragPlugin.tsx:156-159`）✓。 */
async function hoverFirstBlock(editor: LexicalEditor, clientX = 100, clientY = 13) {
  const first = blockEls(editor)[0];
  if (!first) throw new Error("前提不成立：编辑器里没有顶层块");
  mouseOn(first, "mousemove", { clientX, clientY });
  await settle();
  return document.querySelector<HTMLElement>(".block-handle");
}

/** 按用户的手指走一遍：悬出手柄 ⇒ 在手柄上 mousedown ⇒ 移到 `dx` 之外 ⇒ beginDrag 起拖。 */
async function startDrag(editor: LexicalEditor, dx = 8) {
  const handle = await hoverFirstBlock(editor);
  if (!handle) throw new Error("前提不成立：⋮⋮ 手柄没出来（本用例没得测）");
  mouseOn(handle, "mousedown", { clientX: 100, clientY: 13, button: 0 });
  mouseOn(document, "mousemove", { clientX: 100 + dx, clientY: 13 });
  await settle();
  return handle;
}

describe("块拖拽 · 行为（owner 2026-10-12「打开」之后它到底对不对）", () => {
  it("① 阈值：位移 <5px **含恰好 5px** 不起拖（无幽灵 / 无落点线）；>5px 才起拖", async () => {
    const { editor } = fixture();
    const handle = await hoverFirstBlock(editor);
    expect(handle, "前提：悬停后 ⋮⋮ 手柄得先出来").not.toBeNull();

    mouseOn(handle as HTMLElement, "mousedown", { clientX: 100, clientY: 13, button: 0 });
    mouseOn(document, "mousemove", { clientX: 103, clientY: 13 }); // 3px（3*3=9）
    await settle();

    expect(document.querySelector(".block-handle--dragging"), "3px 位移（<5px）不该出现拖拽幽灵").toBeNull();
    expect(document.querySelector(".block-drop-line"), "3px 位移（<5px）不该出现落点线").toBeNull();
    expect(document.body.classList.contains("is-dragging-block"), "3px 位移（<5px）不该进拖拽态").toBe(false);
    expect(editor.isEditable(), "<5px 没起拖 ⇒ 编辑器必须仍可编辑（beginDrag 会 setEditable(false)）").toBe(true);

    // ⭐ 恰好 5px 这一格：源码那一行**逐字**是
    //       `      if (dx * dx + dy * dy > 25) {`
    //   （`BlockDragPlugin.tsx:293`）⇒ 25 **不大于** 25 ⇒ **恰好 5px 不起拖** ✓ ——
    //   所以这里是 `>`、不是 `>=`（2026-10-12 Lead 拍：以源码为准，不为这个口误改实现 ✓）。
    mouseOn(document, "mousemove", { clientX: 105, clientY: 13 }); // 恰好 5px（5*5=25）
    await settle();

    expect(
      document.querySelector(".block-handle--dragging"),
      "恰好 5px（25 不大于 25）不该起拖 —— `BlockDragPlugin.tsx:293` 是 `>` 不是 `>=`",
    ).toBeNull();
    expect(document.body.classList.contains("is-dragging-block"), "恰好 5px 不该进拖拽态").toBe(false);
    expect(editor.isEditable(), "恰好 5px 没起拖 ⇒ 编辑器必须仍可编辑").toBe(true);

    // 越过阈值：8px（8*8 = 64 > 25）⇒ 这才是"起拖"那一侧 ✓。
    mouseOn(document, "mousemove", { clientX: 108, clientY: 13 });
    await settle();

    expect(document.querySelector(".block-handle--dragging"), "越过 5px 阈值应当起拖（幽灵出现）").not.toBeNull();
    expect(document.body.classList.contains("is-dragging-block"), "起拖后 body 应当带上拖拽态类").toBe(true);
    expect(editor.isEditable(), "起拖 ⇒ beginDrag 已把编辑器设为不可编辑").toBe(false);
  });

  it("② 落点线：拖到第 3 块（80..106）的中段 ⇒ `.block-drop-line` 画在**第 3 块**的上边缘", async () => {
    const { editor } = fixture();
    await startDrag(editor); // 拖的是第 1 块 A

    // 指针 = clientY 90：落在第 3 块 C（80..106）的中段、且在其中心 93 **以上**
    // ⇒ 源码 `findTargetBlock` 取"中心离得最近的块"（`BlockDragPlugin.tsx:75-86`）
    //    最近 = C（|90-93|=3 ＜ B 的 37）⇒ `after = 90 > 93` = false ⇒ 落点线取 `rect.top` = 80 ✓
    mouseOn(document, "mousemove", { clientX: 108, clientY: 90 });
    await settle();

    const line = document.querySelector<HTMLElement>(".block-drop-line");
    expect(line, "拖到第 3 块附近必须出现落点指示线").not.toBeNull();
    expect(
      line?.style.top,
      "落点线应当画在第 3 块的上边缘 80px（＝插到 C 前面）；画成 0px/40px 就是块位错了",
    ).toBe("80px");
    expect(line?.style.left, "落点线的左边界应当跟着目标块（stub 版面 left=0）").toBe("0px");
    expect(line?.style.width, "落点线的宽度应当跟着目标块（stub 版面 width=600）").toBe("600px");
  });

  it("③ ⭐ 松手真的落库：`editor.getEditorState()` 里块的顺序真的变了（⛔ 不是只看 DOM ✗）", async () => {
    const { editor } = fixture();
    expect(blockTexts(editor), "前提：起始顺序应当是 A,B,C").toEqual(["A", "B", "C"]);

    await startDrag(editor);
    mouseOn(document, "mousemove", { clientX: 108, clientY: 90 });
    await settle();
    expect(document.querySelector(".block-drop-line"), "前提：落点已经算出来了（见判据②）").not.toBeNull();

    mouseOn(document, "mouseup", { clientX: 108, clientY: 90 }); // 松手
    await settle();

    const after = blockTexts(editor);
    expect(
      after,
      "松手后**编辑器状态**里 A 应当被挪到第 3 块之前 ⇒ [B,A,C]；" +
        `实际 ${JSON.stringify(after)}。红 ⇒ 拖拽只动了外观、没落库（` +
        "`BlockDragPlugin.tsx:211-235` 的 onUp 没跑到 / 没改到状态）",
    ).toEqual(["B", "A", "C"]);
    expect(after, "顺序必须真的变了（只挪 DOM 不算数）").not.toEqual(["A", "B", "C"]);
  });

  it("④ 点一下 ≠ 拖：原地 mousedown+mouseup ⇒ 块菜单照旧开、顺序不动", async () => {
    const { editor } = fixture();
    const handle = await hoverFirstBlock(editor);
    expect(handle, "前提：⋮⋮ 手柄得先出来").not.toBeNull();
    expect(document.querySelector(".block-grip-menu"), "前提：还没点，菜单不该在").toBeNull();

    mouseOn(handle as HTMLElement, "mousedown", { clientX: 100, clientY: 13, button: 0 });
    mouseOn(handle as HTMLElement, "mouseup", { clientX: 100, clientY: 13 });
    await settle();

    expect(
      document.querySelector(".block-grip-menu"),
      "点一下手柄 ⇒ 块操作菜单照旧要开（那是 2026-10-02 明确「恢复」的那条路，`BlockDragPlugin.tsx:300-328`）",
    ).not.toBeNull();
    expect(document.querySelector(".block-handle--dragging"), "没位移 ⇒ 不许出现拖拽幽灵").toBeNull();
    expect(document.querySelector(".block-drop-line"), "没位移 ⇒ 不许出现落点线").toBeNull();
    expect(blockTexts(editor), "点一下不是拖 ⇒ 顺序不许动").toEqual(["A", "B", "C"]);
  });
});
