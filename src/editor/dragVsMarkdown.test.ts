// ⭐ **块拖拽打开之后，Markdown 行首语法失效**？ —— 2026-10-12 owner 实测的那条事故的判据。
//
// ── 现场（Lead 给的，逐字）────────────────────────────────────────────────
//   · A/B：`Editor.tsx:731` 从 `<BlockDragPlugin dragEnabled />` 临时改回 `<BlockDragPlugin />`
//     ⇒ owner 回「好了」⇒ Markdown 立刻恢复 ⇒ **头号嫌疑＝刚打开的块拖拽** ✗；
//   · 现象：笔记里 `## 核心管理团队` **原样显示**（不转换 ✗），且那两行是**高亮**的。
//
// ── ⭐⭐ 本文件的第一条读数（⛔ 与 Lead 的预期相反，如实写 ✗）────────────────
//   `npx vitest run src/editor/dragVsMarkdown.test.ts`，**改 `BlockDragPlugin.tsx` 之前**逐字：
//     `❯ src/editor/dragVsMarkdown.test.ts (5 tests | 1 failed)`
//     `✓ ①` `✓ ②` `✓ ③` `× ④` `✓ ⑤` ⇒ `Tests  1 failed | 4 passed (5)`
//   ⭐ 也就是说：**把 `dragEnabled` 挂上、在行首逐字敲 `## 核心管理团队`，块照样变成 `heading`/`h2`** ✓
//   ⇒ 「挂上 `dragEnabled` ⇒ Markdown 行首语法失效」**在判据里重现不出来** ✗
//   （⚠️ 更早一版只有①②③三格时是 `3 passed (3)` ✓ —— 那时**一条都没红** ✓）。
//
//   已排除（⭐ 逐条交代它靠什么钉住，⛔ 不混着写 ✗）：
//     · **只挂载**：判据① ⇒ 绿（判据在，可复跑 ✓）；
//     · **完整拖一次**（mousedown 手柄 → 位移 >5px → 松手 → 顺序真落库）⇒ 绿 ——
//       `blockDragBehavior.test.ts` 的①②③④ 就是这条路的验收 ✓（同在 `src/editor` 里，可复跑 ✓）；
//     · **卡住的拖拽**下 Markdown **照旧转换**：判据⑥ ⇒ 绿 —— 因为 `@lexical/markdown` 的
//       `registerMarkdownShortcuts` 只看 **update ＋ selection**
//       （`node_modules/@lexical/markdown/src/MarkdownShortcuts.ts:582-660`），
//       ⛔ **完全不看 `editor.isEditable()`** ✗；
//     · **走真 `keydown` 通路**也不吃 `#`：判据⑤ ⇒ 绿；
//     · **只悬停出手柄（不按）** ⇒ 绿 —— ⚠️ 这一条**只有临时探针的读数** ✗（探针已删，
//       ⛔ 本文件里没有它的判据 ⇒ 别把它当已验收 ✗，如实交代）。
//   ⇒ ⚠️ 结论只到这里：**"Markdown 行首语法失效"的真因我没查到** ✗（⛔ 不硬编一个 ✗）；
//      ⭐ 我查到**唯一**能吃掉那个空格、从而真的杀死行首语法的邻居是
//      `AiSpaceTriggerPlugin`（`Editor.tsx:719` 常驻挂着；它自己的门在
//      `plugins/AiSpaceTriggerPlugin.tsx:36`＝"顶层块文本 trim 后为空"）——
//      ⛔ 而这道门**与 `dragEnabled` 无关** ✗（开关两态同形 ✓）⇒ 它解释不了这次 A/B ✗。
//      ⭐ 留给 Lead 复核的一条：那次 A/B 的"改一行 ⇒ 重建 ⇒ 重载"本身会不会是**混淆变量** ✗
//      （重载会清掉会话内的态；本工作区栽过好几次"拿一个对象当另一个"✓）。
//
// ── 于是本文件的判据分两半 ──────────────────────────────────────────────
//   ①②（Lead 指定）：**①** 挂 `dragEnabled` 时行首 `## ` 必须真变成 `h2`（读**编辑器状态**，
//      ⛔ 不是只断言 DOM 文本 ✗）；**②** 反面对照：普通文本**不许**被改造成标题 ✓。
//     ⚠️ ① 今天就是绿的 —— 它**不是**"修好了"的证据，它是"这条假设立不住"的读数 ✓。
//   ③（出处对照）拿掉 `dragEnabled` ⇒ 与 ① 同形 ⇒ 把"① 的读数与开关无关"钉住 ✓。
//   ④ ⭐ **本文件唯一会红的判据（真缺陷）**：起拖之后**收不到 `mouseup`**（指针在窗外松开 /
//      Alt+Tab 走掉 —— 这正是 owner 描述里"**像拖拽状态卡住**"的形状 ✓）⇒
//      `beginDrag()` 已把编辑器设成**不可编辑**（`BlockDragPlugin.tsx:296`），而**回不来了** ✗：
//      拖拽 effect 的清理是**唯一**恢复路径（`:262-270` 的 `editor.setEditable(true)` ＋
//      `body.classList.remove("is-dragging-block")`），而它只在 `dragKey` 变化时才跑
//      ⇒ `mouseup` 一丢，**`contenteditable="false"` ＋ `body.is-dragging-block` ＋ 幽灵手柄
//      就永久留在页面上**（本判据先红读数就是它 ✓）；顺带 `draggingRef` 也卡在 true
//      ⇒ **悬停再也出不来 ⋮⋮ 手柄** ✓。
//      ⭐ 恢复的触发＝**窗口失焦**（`window` 的 `blur`）：把"按下之后跑到别处去了"这件事
//      当成拖拽结束 ✓（⛔ 不用 `mousemove` 的 `buttons===0` 当触发 —— 那会撞坏
//      `blockDragBehavior.test.ts` 里既有的派发形状，而那个文件不在本任务的写域里 ✗）。
//   ⑤（触发字符的守门人）：行首已经敲出 `##` 时，那个**空格** `keydown` 不许被任何插件
//      `preventDefault()` 吃掉 ✓（行首语法正是靠它触发；现状绿，钉的是"别把触发字符吃了"）。
//   ⑥（**已排除**的机器读数，现状绿）：**卡住的拖拽态下** Markdown 照旧转换 ✓ ⇒
//      把"拖拽（含它留下的不可编辑态）不是行首语法失效的通路"钉成可核的一格 ✓
//      （⛔ 它不是"修好了"的证据 ✗，是"这条假设不成立"的证据 ✓）。
//
// ⚠️⚠️ **宿主必须挂上 `Editor.tsx` 同形的插件集合**（`Editor.tsx:714` `MarkdownShortcutPlugin` /
//    `:719` `AiSpaceTriggerPlugin`（就是全仓唯一那个吃空格的 ✓）/ `:738` `BlockDragPlugin` /
//    `:740` `BlockSelectionPlugin` / `:742` `ClickToEditPlugin`）——
//    `tableMenu.test.tsx:16-31` 头注逐字写着"只挂被测插件 ⇒ 判据自己骗自己"✓，本事故是它的同族 ✓。
//
// ⚠️ 输入形状抄 `editorInputShortcuts.test.ts:104-192`：**逐字**提交 ＋ `settled()`（React `act`，
//    等条件、⛔ 不是睡固定时长 ✗）＋ 读**编辑器状态** ✓。⚠️ 如实交代一处边界：
//    happy-dom 里 `beforeinput` 的插入**不落地**（Lexical 0.50 把它推迟到 DOM 变更阶段，
//    见 `LexicalEvents.ts:1041-1068`）⇒ 这里只能用仓内既有惯例 `editor.update(... insertText)` ✓；
//    真 `keydown` 通路只用于判据⑤（那里要的正是"有没有被 preventDefault"✓）。
import { act } from "react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from "lexical";
import { EDITOR_NODES } from "./config";
import { SHUYONOTE_TRANSFORMERS } from "./markdownTransformers";
import { BlockDragPlugin } from "./plugins/BlockDragPlugin";
import { BlockSelectionPlugin } from "./plugins/BlockSelectionPlugin";
import { ClickToEditPlugin } from "./plugins/ClickToEditPlugin";
import { AiSpaceTriggerPlugin } from "./plugins/AiSpaceTriggerPlugin";
import { useBlockSelection } from "../store/blockSelection";
import { silenceLexicalDevWarnings } from "../test/lexicalWarnings";

// Lexical dev 构建在这个环境里会打 updateEditorSync 警告（见 src/test/lexicalWarnings.ts）
// ——只静音那一条，其余警告照旧输出。
silenceLexicalDevWarnings();

interface Harness {
  editor: LexicalEditor;
  root: Root;
  host: HTMLDivElement;
  /** 卸干净：`useBlockSelection` 是**模块级** store ⇒ 残留会让下一个用例读到上一个的块选态。 */
  dispose: () => void;
}

let harness: Harness | null = null;

afterEach(() => {
  harness?.dispose();
  harness = null;
  useBlockSelection.getState().setSelectMode(false);
});

/**
 * 挂一个最小可用的编辑器：与应用同一份节点清单 ＋ **同形的插件集合**（见文件头 ⚠️⚠️）。
 *
 * ⚠️ `dragEnabled` **必须显式传**：`BlockDragPlugin.tsx:99` 的默认是 `false` —— 传漏了
 *    这里测的就成了"拖拽关着"的形态，而事故只在**开着**时出现 ✗。
 */
function setup(opts: { dragEnabled: boolean }): Harness {
  let editor: LexicalEditor | null = null;
  function Probe() {
    [editor] = useLexicalComposerContext();
    return null;
  }
  useBlockSelection.getState().setSelectMode(false);
  const host = document.createElement("div");
  host.className = "editor-shell"; // 与 Editor.tsx:694 同形
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() =>
    root.render(
      React.createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: "drag-vs-markdown-test",
            nodes: EDITOR_NODES,
            onError: (e: Error) => {
              throw e;
            },
          },
        },
        React.createElement(Probe),
        React.createElement(RichTextPlugin, {
          contentEditable: React.createElement(ContentEditable, { className: "editor-content", "aria-label": "编辑器" }),
          placeholder: null,
          ErrorBoundary: LexicalErrorBoundary,
        }),
        React.createElement(ListPlugin),
        React.createElement(CheckListPlugin),
        React.createElement(MarkdownShortcutPlugin, { transformers: SHUYONOTE_TRANSFORMERS }),
        React.createElement(AiSpaceTriggerPlugin),
        React.createElement(BlockDragPlugin, opts.dragEnabled ? { dragEnabled: true } : {}),
        React.createElement(BlockSelectionPlugin),
        React.createElement(ClickToEditPlugin),
      ),
    ),
  );
  if (!editor) throw new Error("编辑器没挂起来");
  const h: Harness = {
    editor: editor as LexicalEditor,
    root,
    host,
    dispose: () => {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
  harness = h;
  return h;
}

/** 塞一个段落并把光标收在行尾（`text` 为空就是空行，同 `editorInputShortcuts.test.ts:90-102`）。 */
function seed(editor: LexicalEditor, text = "") {
  editor.update(
    () => {
      const p = $createParagraphNode();
      if (text) p.append($createTextNode(text));
      const r = $getRoot();
      r.clear();
      r.append(p);
      p.selectEnd();
    },
    { discrete: true },
  );
}

/** 塞 3 个顶层段落（手柄只对**非空**块出现 —— `BlockDragPlugin.tsx:147-153` 的 `isEmptyBlock` ✓）。 */
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
 * 跑一段"会改 React 状态"的动作，并等 React 把这条链做完（渲染 → commit → 被动副作用）。
 * 逐字抄 `editorInputShortcuts.test.ts:179-192`：`IS_REACT_ACT_ENVIRONMENT` 只在这期间置真 ✓。
 */
async function settled<T>(fn: () => T): Promise<T> {
  const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = g.IS_REACT_ACT_ENVIRONMENT;
  let out!: T;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      out = fn();
    });
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = prev;
  }
  return out;
}

/**
 * 像用户那样**一个字一个字**地敲（每个字符单独提交一次，中间把 React 那一跳跑完）。
 * 同 `editorInputShortcuts.test.ts:112-124` —— 行首语法是在"空格那一下"的 **update listener**
 * 里转换的（`MarkdownShortcuts.ts:582`）⇒ 必须逐字提交 ✓。
 */
async function typeChars(editor: LexicalEditor, text: string) {
  for (const ch of text) {
    await settled(() => {
      editor.update(
        () => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) sel.insertText(ch);
        },
        { discrete: true },
      );
    });
  }
}

/** 读第一个块的**类型 / 标签 / 文本** —— ⛔ 不读 DOM ✗（DOM 说"看起来像标题"时状态可能是段落 ✓）。 */
function first(editor: LexicalEditor) {
  return editor.getEditorState().read(() => {
    const n = $getRoot().getFirstChild();
    if (n === null) return { type: null as string | null, tag: "", text: "" };
    const tagged = n as unknown as { getTag?: () => string };
    return {
      type: n.getType(),
      tag: tagged.getTag?.() ?? "",
      text: n.getTextContent(),
    };
  });
}

/** 等一拍：拖拽 effect 里挂的 document 监听要落地（先例 `tableMenu.test.tsx:206-211`）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  await tick();
  await tick();
  flushSync(() => {});
}

/** 派发一个鼠标事件（`cancelable` ⇒ 插件才 preventDefault 得动）。 */
function mouseOn(target: EventTarget, type: string, init: MouseEventInit) {
  flushSync(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}

/**
 * 给顶层块钉确定的版面：happy-dom 的 `getBoundingClientRect()` **全是 0**，
 * 而拖拽是**纯几何**插件（`BlockDragPlugin.tsx:62/77-86/204-208`）⇒ 不钉版面就量不出块位 ✓
 * （先例 `blockDragBehavior.test.ts:140-165`）。版面：甲 `0..26`、乙 `40..66`、丙 `80..106`。
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

/** 桌面版面（见 `stubLayout()`）：甲 `0..26`、乙 `40..66`、丙 `80..106`。 */
const LAYOUT = [
  { top: 0, height: 26 },
  { top: 40, height: 26 },
  { top: 80, height: 26 },
];

/** 悬停第 1 块 ⇒ 应当渲染出 `⋮⋮` 手柄（`BlockDragPlugin.tsx:156-159`）✓。 */
async function hoverFirstBlock(editor: LexicalEditor) {
  const el = editor.getEditorState().read(() => {
    const firstBlock = $getRoot().getFirstChild();
    return firstBlock ? editor.getElementByKey(firstBlock.getKey()) : null;
  });
  if (!el) throw new Error("前提不成立：编辑器里没有顶层块");
  mouseOn(el, "mousemove", { clientX: 100, clientY: 13, buttons: 1 });
  await settle();
  return document.querySelector<HTMLElement>(".block-handle");
}

/** 按用户的手指走一遍：悬出手柄 ⇒ 在手柄上 mousedown ⇒ 移到 `dx` 之外 ⇒ `beginDrag()` 起拖。 */
async function startDrag(editor: LexicalEditor, dx = 8) {
  const handle = await hoverFirstBlock(editor);
  if (!handle) throw new Error("前提不成立：⋮⋮ 手柄没出来");
  mouseOn(handle, "mousedown", { clientX: 100, clientY: 13, button: 0 });
  mouseOn(document, "mousemove", { clientX: 100 + dx, clientY: 13, buttons: 1 });
  await settle();
  return handle;
}

describe("块拖拽（dragEnabled）与 Markdown 行首语法 —— 2026-10-12 事故的判据", () => {
  it("① ⭐ 挂 `BlockDragPlugin dragEnabled` 时，行首 `## 核心管理团队` 必须真的变成 `h2`", async () => {
    const { editor } = setup({ dragEnabled: true });

    seed(editor);
    await typeChars(editor, "## 核心管理团队");
    const got = first(editor);

    expect(
      got.type,
      `行首敲 \`## \` 之后，**编辑器状态**里那个块应当是 \`heading\`（⛔ 不是停在 \`paragraph\`）——` +
        `实际 type=${JSON.stringify(got.type)}、tag=${JSON.stringify(got.tag)}、text=${JSON.stringify(got.text)}。` +
        "红 ⇒ 挂上 dragEnabled 的块拖拽把 Markdown 行首语法吃掉了（owner 看到的就是这一条）",
    ).toBe("heading");
    expect(got.tag, `\`## \` 应当给出 \`h2\`（不是 h1/h3）——实际 tag=${JSON.stringify(got.tag)}`).toBe("h2");
    expect(got.text, "转换之后标记 `## ` 应当被吃掉、正文留在标题里").toBe("核心管理团队");
  });

  it("② ⭐ 反面对照：不带 `#` 的普通文本 ⇒ 不许被改造成标题（段落照旧）", async () => {
    const { editor } = setup({ dragEnabled: true });

    seed(editor);
    await typeChars(editor, "核心管理团队");
    const got = first(editor);

    expect(
      got.type,
      `普通文本（没有行首 \`#\`）**不许**被改造成标题 —— 实际 type=${JSON.stringify(got.type)}、` +
        `tag=${JSON.stringify(got.tag)}、text=${JSON.stringify(got.text)}`,
    ).toBe("paragraph");
    expect(got.tag, "段落没有 tag（有 tag ⇒ 被当成标题了）").toBe("");
    expect(got.text, "普通文本必须一字不差地留在文档里").toBe("核心管理团队");
  });

  it("③（出处对照，⛔ 不是「修好」的判据）同宿主不传 `dragEnabled` ⇒ ① 的形状本来就正常", async () => {
    const { editor } = setup({ dragEnabled: false });

    seed(editor);
    await typeChars(editor, "## 核心管理团队");
    const got = first(editor);

    expect(
      `${got.type}/${got.tag}`,
      "不传 `dragEnabled`（＝2026-10-02→10-12 那个「拖拽关着」的形态）时行首语法正常 —— " +
        "这一格只用来把「① 的读数与开关无关」钉住（⛔ 别把它读成「打开之后就坏」✗）",
    ).toBe("heading/h2");
    expect(got.text).toBe("核心管理团队");
  });

  it("④ ⭐ 起拖后收不到 `mouseup` ⇒ 拖拽态必须能收干净（本文件唯一会红的判据）", async () => {
    const { editor } = setup({ dragEnabled: true });
    seedBlocks(editor, ["甲", "乙", "丙"]);
    stubLayout(editor, LAYOUT);

    await startDrag(editor);
    // 前提：确实"卡住"了 —— `beginDrag()` 把编辑器设成不可编辑、body 带上拖拽态类
    // （`BlockDragPlugin.tsx:293-301` / `:192`）。
    expect(editor.isEditable(), "前提：起拖之后编辑器应当是不可编辑的").toBe(false);
    expect(document.body.classList.contains("is-dragging-block"), "前提：起拖之后 body 应当带上拖拽态类").toBe(true);
    expect(document.querySelector(".block-handle--dragging"), "前提：起拖之后应当有拖拽幽灵").not.toBeNull();

    // ⛔ 故意**不发 `mouseup`**：用户把指针移到窗外/切走之后才松手 ——
    //    这是真实会发生的一跳（`blockDragBehavior.test.ts` 里没有这一格）。
    await settle();
    expect(editor.isEditable(), "⛔ 前提：不松手时本来就该是不可编辑的（这一格不许现在是绿的）").toBe(false);

    // ⭐ 恢复动作：窗口失焦（`blur`）⇒ 那次拖拽必须**收干净**。
    flushSync(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await settle();

    expect(
      editor.isEditable(),
      "起拖之后收不到 `mouseup` ⇒ 编辑器被永久留在**不可编辑**态 ✗（`contenteditable=false`）。" +
        "清理只挂在拖拽 effect 的 return 上（`BlockDragPlugin.tsx:262-270`），而它只在 `dragKey` 变化时才跑 ⇒ " +
        "mouseup 一丢就再也回不来（用户看到的就是「拖拽状态卡住」）",
    ).toBe(true);
    expect(
      document.body.classList.contains("is-dragging-block"),
      "拖拽态结束后 body 上不许还留着 `is-dragging-block`（它带着 `user-select: none`，见 App.css:7367-7371）",
    ).toBe(false);
    expect(document.querySelector(".block-handle--dragging"), "拖拽态结束后不许还留着拖拽幽灵").toBeNull();

    // ⭐ 顺带：`draggingRef` 也不许卡住 —— 卡住之后 `⋮⋮` 手柄**再也出不来**（`BlockDragPlugin.tsx:124`）。
    expect(
      await hoverFirstBlock(editor),
      "恢复之后悬停必须仍能出 `⋮⋮` 手柄（`draggingRef.current` 卡在 true 会让它永久熄灭）",
    ).not.toBeNull();

    // ⭐ 恢复之后 Markdown 行首语法照旧（把这条缺陷与"行首语法"重新拴在一起）。
    seed(editor);
    await typeChars(editor, "## 核心管理团队");
    const got = first(editor);
    expect(`${got.type}/${got.tag}`, "恢复之后行首 `## ` 应当照旧变成 h2").toBe("heading/h2");
  });

  it("⑤ ⭐ 行首 `##` 之后那个**空格** `keydown` 不许被任何插件吃掉（触发字符的守门人）", async () => {
    const { editor, host } = setup({ dragEnabled: true });
    seed(editor, "##");
    const el = host.querySelector<HTMLElement>("[contenteditable]");
    if (!el) throw new Error("前提不成立：没有 contenteditable");

    const kd = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await settled(() => {
      el.dispatchEvent(kd);
    });

    expect(
      kd.defaultPrevented,
      "行首已经有 `##`（非空行）时，空格**不许**被 `preventDefault()` 吃掉 —— 被吃掉 ⇒ 文档里永远凑不出 `## `，" +
        "`@lexical/markdown` 的 HEADING 转换式 `^(#{1,6})\\s` 就永远不匹配 ⇒ 行首语法失效 ✗" +
        "（全仓唯一吃空格的是 `plugins/AiSpaceTriggerPlugin.tsx:56`，它的门是 :36 的「顶层块文本为空」）",
    ).toBe(false);
  });

  it("⑥（**已排除**的读数，⛔ 不是「修好」的证据）卡住的拖拽态下，Markdown 照旧转换", async () => {
    const { editor } = setup({ dragEnabled: true });
    seedBlocks(editor, ["甲", "乙", "丙"]);
    stubLayout(editor, LAYOUT);

    await startDrag(editor);
    // ⛔ 不发 mouseup：拖拽态卡住（`isEditable()` 为 false）。
    expect(editor.isEditable(), "前提：这一格要的就是「卡住的拖拽态」").toBe(false);

    seed(editor);
    await typeChars(editor, "## 核心管理团队");
    const got = first(editor);

    expect(
      `${got.type}/${got.tag}`,
      "⭐ 已排除：`@lexical/markdown` 的转换只看 update ＋ selection（`MarkdownShortcuts.ts:582-660`），" +
        "⛔ 不看 `editor.isEditable()` ✗ ⇒ 连「卡住的拖拽态」下它都照旧转换 ✓ ⇒ " +
        "「拖拽吃掉行首语法」这条假设**不成立**（真因得往别处找）。" +
        "⚠️ 本判据绿**不是**修好了的证据 —— 它钉的是「这条假设不成立」",
    ).toBe("heading/h2");
  });
});
