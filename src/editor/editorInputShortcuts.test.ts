// **文档里「编辑器内」的其余快捷键，真的能用吗？** —— 逐字敲一遍，看块有没有变。
//
// `src/lib/shortcuts.ts` 是清单的单一来源，面板/文档都读它；但"清单"和"实现"在两个地方，
// 清单写错、handler 被改掉，界面上几乎没人发现（按下去没反应，用户只会以为自己按错了）。
// 所以这里不测静态文本，而是挂真编辑器、敲真字符/按真键，然后读编辑器状态与 DOM：
//
//   列表组（Markdown 行首语法）：- / 1. / [ ] / # / >
//   基础组「编辑器内」：`/` 斜杠菜单
//   导航组「编辑器内」：Ctrl+F 查找条
//   AI 组：空行按空格打开内联 AI 起草
//
// 与 `insertShortcut.test.ts` 分工：那边是 Ctrl+Alt 那一组（要真 KEY_DOWN_COMMAND），
// 这边是"靠输入或 document 监听"的那些。
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

// 编辑器插件会拉插件列表 / 笔记数据等副作用。给一个空实现：本测试只关心按键行为，
// 不想把 web 平台驱动（sql.js / fetch）拖进来。
vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, KEY_DOWN_COMMAND, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "./config";
import { SHUYONOTE_TRANSFORMERS } from "./markdownTransformers";
import { SlashMenuPlugin } from "./plugins/SlashMenuPlugin";
import { FindPlugin } from "./plugins/FindPlugin";
import { AiSpaceTriggerPlugin } from "./plugins/AiSpaceTriggerPlugin";
import { PageLinkSuggestPlugin } from "./plugins/PageLinkSuggestPlugin";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import { SHORTCUTS } from "../lib/shortcuts";
import { silenceLexicalDevWarnings } from "../test/lexicalWarnings";

// Lexical dev 构建在这个环境里会打 updateEditorSync 警告（见 src/test/lexicalWarnings.ts）
// ——只静音那一条，其余警告照旧输出。
silenceLexicalDevWarnings();

/** 挂一个最小可用的编辑器：与应用同一份节点清单 + 同一批插件。 */
function setup(children: React.ReactNode[]) {
  let editor: LexicalEditor | null = null;
  function Probe() {
    [editor] = useLexicalComposerContext();
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      React.createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: "editor-input-test",
            nodes: EDITOR_NODES,
            onError: (e: Error) => {
              throw e;
            },
          },
        },
        React.createElement(Probe),
        React.createElement(RichTextPlugin, {
          contentEditable: React.createElement(ContentEditable, { "aria-label": "编辑器" }),
          placeholder: null,
          ErrorBoundary: LexicalErrorBoundary,
        }),
        React.createElement(ListPlugin),
        React.createElement(CheckListPlugin),
        ...children,
      ),
    ),
  );
  const el = host.querySelector('[contenteditable="true"]') as HTMLElement | null;
  if (!editor || !el) throw new Error("编辑器没挂起来");
  return { editor: editor as LexicalEditor, el, root };
}

/** 塞一个段落并收起光标（空文本就是"空行"）。 */
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

/** 像用户那样**一个字一个字**地输入（一次提交一个字符）。
 *
 *  ⚠️ 每个字符都走 `settled`，**不是**"打完再等一个 tick"：编辑器 update 会
 *  **同步**跑插件的 update listener，而 listener 里是 React `setState`
 *  （`setQuery` / `setOpen` / `setSel`）。这一跳必须**当场**连同它带出的被动副作用
 *  一起做完——否则"下一次按键"就可能落到还没被换掉的**旧闭包**上
 *  （比如 `matches` 还是上一帧的空数组 ⇒ `Math.min(sel+1, -1)` = −1，
 *  两项都不再 active）。这正是本文件 flake 的成因，见下面 `settled` 那段说明。 */
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

/**
 * ⚠️ **别用"睡一个固定时长"（`await new Promise(r => setTimeout(r, 0))`）去等
 * "React 把 UI 画出来了 / 副作用跑完了"**（这正是本文件此前 flake 的根因）。
 *
 * 这一条曾经三次全量里红过一次，报的是
 * `expected '[[页面甲]]' to contain '[[页面乙]]'`；单独跑这个文件又 3/3 全绿。
 * 根因**不是"慢"，是等错了东西**，而且有**两个**不同的窗口：
 *
 *   1. **commit 与被动副作用之间**。`commit` 是同步的 ⇒ DOM 已经渲染成"第二项 active"；
 *      而 ↑/↓/Enter 的处理函数注册在插件 `useEffect` 里、闭包带着当时的 `sel` 与
 *      `matches`（后者**每帧都是新数组**，所以那个 effect 每帧都会注销再注册），
 *      **被动副作用在 commit 之后才跑**。这中间有一小段窗口：DOM 说"选中第二项"、
 *      菜单也确实是两项，而 `KEY_DOWN_COMMAND` 上挂的还是**上一版闭包**——
 *      实测抓到过两种后果：`matches` 还是上一帧的空数组 ⇒ `Math.min(sel+1, -1)` = −1
 *      （两项都不再 active）；或 `sel` 还是 0 ⇒ Enter 插进去的是「页面甲」。
 *      同一次复现抓到的另一个落点是 `Ctrl+F 后应当出现查找条`
 *      （同一个写法：**派发事件 → 睡一个 tick → 断言 DOM**）。
 *   2. **`setTimeout(0)` 与 React 的调度宏任务没有先后保证**。React 用 Scheduler
 *      （DOM 环境下是 `MessageChannel`）冲渲染与副作用，`setTimeout(0)` 是另一条宏任务队列；
 *      单跑这个文件时几乎总是 React 先跑完，整仓 67 个文件并跑、CPU 争用时就会翻过来——
 *      所以它"单跑不红、全量偶尔红"。
 *
 * 修法**不是加重试、也不是多睡一会儿**：多睡只是把窗口推小，没有消除它。
 * 现在的两条等法都等**条件本身**：
 *
 *   · 等 UI → `vi.waitFor(() => expect(<DOM 条件>))`，它反复让出事件循环直到条件成立；
 *   · 等"这次按键引起的渲染 + 被动副作用都跑完" → `settled(fn)`（内部用 React 的 `act`）。
 *
 * `act()` 把 **Scheduler 换成 act 队列**，所以在它作用域内排队的渲染与副作用
 * 会在它返回前被冲干净——这是**确定的**，跑多少次结果都一样（见下面 `settled`）。
 *
 * ⚠️ **`settled` 必须包住**每一次**会改 React 状态**的动作——不只是按键，还有**打字**
 * （`typeChars` 每个字符一次）。原因就是 `act` 的工作方式：它只认**在它作用域内排队**的
 * 工作，作用域开始**之前**就已经挂在 React 调度队列上的那些它管不着。
 * 于是"只包按键、不包打字"反而会把窗口挪到更早的那一跳上——实测：这样改完，
 * 红点从 `Enter 应当插入 [[页面乙]]` **前移**到了 `↓ 之后选中第二项`，
 * 报的正是 `matches` 那一版旧闭包。包住整条链之后，任何一次按键看到的都一定是
 * "最新一帧 + 它的副作用已经跑完"。
 */

/**
 * 跑一段"会改 React 状态"的动作，并**等 React 把这次改动整条链做完**
 * （渲染 → commit → 被动副作用）再返回，返回 `fn` 的返回值。
 *
 * 为什么是 `act` 而不是"再睡一个 tick"：`act` 是 React 官方的"等它做完"原语，
 * 它把这期间排队的调度回调收进自己的队列并在返回前冲干净；而一次渲染的 `commit`
 * 开头又会先把**之前挂起**的被动副作用冲掉——所以只要包住"触发那一次渲染"的一跳，
 * 整条链就是干净的。固定时长只是赌博，窗口小不等于没有（本文件就是活证据）。
 * **它不是重试**：断言一个字没改，跑几次都走同一条路径。
 *
 * `IS_REACT_ACT_ENVIRONMENT` 只在这一次调用期间置真（React 只在这时为真才走 act 队列；
 * 常开会让本文件里那些**刻意不在 act 里**的更新被 React 打一堆 act 警告）。
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

/** 在编辑器里按一次键（走真的 KEY_DOWN_COMMAND，和用户按键是同一个入口）。 */
function pressKey(editor: LexicalEditor, key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  const handled = editor.dispatchCommand(KEY_DOWN_COMMAND, e);
  return { handled, prevented: e.defaultPrevented };
}

/** 读第一个块的类型（列表断言到 list-item 之外还要看 listType）。 */
function first(editor: LexicalEditor) {
  return editor.getEditorState().read(() => {
    const n = $getRoot().getFirstChild();
    const anyNode = n as unknown as { getListType?: () => string; getTag?: () => string };
    return {
      type: n?.getType() ?? null,
      listType: anyNode?.getListType?.() ?? "",
      tag: anyNode?.getTag?.() ?? "",
      text: n?.getTextContent() ?? "",
    };
  });
}

/** 文档里这条快捷键（读 shortcuts.ts，不在这里抄一遍）。 */
function doc(key: string) {
  const s = SHORTCUTS.find((x) => x.key === key);
  if (!s) throw new Error(`shortcuts.ts 里没有 ${key}`);
  return s;
}

describe("列表组：Markdown 行首语法（逐字输入）", () => {
  it("文档里那 5 条行首语法，输入完都真的变成了对应块", async () => {
    const { editor, root } = setup([React.createElement(MarkdownShortcutPlugin, { transformers: SHUYONOTE_TRANSFORMERS })]);

    const cases: { key: string; want: { type: string; listType?: string; tag?: string } }[] = [
      { key: "md-bullet", want: { type: "list", listType: "bullet" } },
      { key: "md-ordered", want: { type: "list", listType: "number" } },
      { key: "md-todo", want: { type: "list", listType: "check" } },
      { key: "md-heading", want: { type: "heading", tag: "h1" } },
      { key: "md-quote", want: { type: "quote" } },
    ];

    for (const { key, want } of cases) {
      const s = doc(key);
      // 文档里的 keys 是"逐键敲"的字符序列（如 ["-", " "]），拼起来就是用户敲的内容。
      const typed = s.keys.join("");
      seed(editor);
      await typeChars(editor, typed);
      const got = first(editor);
      expect(got.type, `${key}（行首 ${JSON.stringify(typed)}）应当变成 ${want.type}`).toBe(want.type);
      if (want.listType) expect(got.listType, `${key} 的列表类型`).toBe(want.listType);
      if (want.tag) expect(got.tag, `${key} 的标签`).toBe(want.tag);
    }

    flushSync(() => root.unmount());
  });
});

describe("基础组「编辑器内」：斜杠菜单", () => {
  it("输入 / 真的弹出斜杠菜单", async () => {
    const s = doc("slash-menu");
    expect(s.keys).toEqual(["/"]);
    const { editor, root } = setup([React.createElement(SlashMenuPlugin, { pageId: "p1" })]);

    seed(editor);
    expect(document.querySelector(".slash-menu"), "还没输入时不该有菜单").toBeNull();
    await typeChars(editor, s.keys.join(""));
    // 等**条件**（菜单真的渲染出来），不是"睡一个 tick 再赌它画完了"。
    await vi.waitFor(() => expect(document.querySelector(".slash-menu"), "输入 / 后应当弹出菜单").not.toBeNull());

    flushSync(() => root.unmount());
  });

  // 分组标题是**按"同组相邻"推断**渲染的（`option.group !== lastGroup` 才插一条标题）。
  // 所以清单里只要有一个后来追加的条目落回老分组（2026-09 就出过一次：`帮助` 落在
  // `表格` 后面，于是菜单里「基础」「嵌入」各出现**两次**，React 还会报 duplicate key），
  // 用户看到的就是错乱的分组标题。这里按菜单真实 DOM 断言：每个分组只出现一次。
  it("分组标题不重复（菜单是按相邻分组的，清单顺序错了就会重复）", async () => {
    const { editor, root } = setup([React.createElement(SlashMenuPlugin, { pageId: "p1" })]);

    seed(editor);
    await typeChars(editor, "/");
    await vi.waitFor(() => expect(document.querySelector(".slash-group"), "菜单里应当有分组标题").not.toBeNull());
    const heads = Array.from(document.querySelectorAll(".slash-group")).map((n) => n.textContent ?? "");
    expect(heads.length, "菜单里应当有分组标题").toBeGreaterThan(0);
    expect([...new Set(heads)], `分组标题重复了：${JSON.stringify(heads)}`).toEqual(heads);

    flushSync(() => root.unmount());
  });
});

describe("导航组「编辑器内」：Ctrl+F 查找", () => {
  it("按 Ctrl+F 真的出现查找条", async () => {
    const s = doc("editor-find");
    expect(s.keys.join("+")).toBe("Ctrl+F");
    const { root } = setup([React.createElement(FindPlugin)]);

    expect(document.querySelector(".find-bar")).toBeNull();
    const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    // ⚠️ 这一处**全量复现时真的红过**（同一次 flake 的另一个落点，报的是
    // `Ctrl+F 后应当出现查找条`）：`FindPlugin` 的 keydown 监听也挂在 `useEffect` 里，
    // 派发事件之后只睡一个 tick 并不保证"监听已注册 + React 已 commit"。
    // 用 `settled` 把这次派发引起的整条链跑完再断言。
    await settled(() => document.body.dispatchEvent(e));
    expect(document.querySelector(".find-bar"), "Ctrl+F 后应当出现查找条").not.toBeNull();
    expect(e.defaultPrevented, "拦下浏览器自带的查找").toBe(true);

    flushSync(() => root.unmount());
  });
});

describe("「[[」链接建议菜单：键盘操作（同一条优先级坑）", () => {
  // 这条不在 shortcuts.ts 清单里，但它踩的是**同一个坑**：`PageLinkSuggestPlugin` 当年也把
  // KEY_DOWN_COMMAND 注册在 `COMMAND_PRIORITY_EDITOR` 档，于是 ↑/↓/Enter/Esc 一个都收不到——
  // 菜单开着时按 Enter 变成换行（菜单等于只能用鼠标点）。这里把它钉住。
  it("菜单开着时 ↓ 换选中项、Enter 插入 [[标题]]", async () => {
    useNotes.setState({
      pages: [
        { id: "1", title: "页面甲", updated_at: 2 },
        { id: "2", title: "页面乙", updated_at: 1 },
      ] as never,
    });
    const { editor, root } = setup([React.createElement(PageLinkSuggestPlugin)]);

    seed(editor);
    await typeChars(editor, "[[页"); // 空查询不出候选（suggestPageLinks 对空串直接返回 []），所以带一个字
    // 等**候选真的渲染出来**（而不是"睡一个 tick"）：菜单是 React 渲染的，
    // 事件已派发 ≠ DOM 已提交。
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".page-link-suggest-item").length, "应当出现候选").toBeGreaterThan(1),
    );
    const items = Array.from(document.querySelectorAll(".page-link-suggest-item"));
    expect(items[0].className, "默认选中第一项").toContain("active");

    // ⚠️ ↓ / Enter 都用 `settled`：**必须**等这次按键引起的渲染**与被动副作用**
    // 都跑完再按下一个键。否则 DOM 已经显示"第二项 active"，而
    // `KEY_DOWN_COMMAND` 上挂的还是上一版闭包（`sel = 0`）⇒ Enter 插进去的是「页面甲」。
    // 这就是那条 `expected '[[页面甲]]' to contain '[[页面乙]]'` 的成因。
    const down = await settled(() => pressKey(editor, "ArrowDown"));
    const after = Array.from(document.querySelectorAll(".page-link-suggest-item"));
    expect(down.prevented, "↓ 应当被菜单认领").toBe(true);
    expect(after[1].className, "↓ 之后选中第二项").toContain("active");

    const enter = await settled(() => pressKey(editor, "Enter"));
    expect(enter.prevented, "Enter 应当被菜单认领（否则会变成换行）").toBe(true);
    // 插入是编辑器自己的一次 update（Lexical 走微任务提交），也按条件等，不按 tick 等。
    await vi.waitFor(() =>
      expect(first(editor).text, "Enter 应当插入 [[标题]]").toContain("[[页面乙]]"),
    );

    flushSync(() => root.unmount());
  });
});

describe("AI 组：空行按空格", () => {
  it("空行按空格打开内联 AI 起草；有字的行不抢", async () => {
    const s = doc("ai-draft");
    expect(s.keys).toEqual(["Space"]);
    const { editor, el, root } = setup([React.createElement(AiSpaceTriggerPlugin)]);

    // 事件必须真的发生在编辑器里（插件用 root.contains(target) 守门），所以派发到 contentEditable。
    // 同样用 `settled`：插件的监听挂在 `useEffect` 里，派发之后要等注册/渲染这一条链跑完。
    const pressSpace = () => {
      const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      return settled(() => el.dispatchEvent(e)).then(() => e);
    };

    seed(editor);
    useEditorStore.setState({ aiBarOpen: false });
    const blank = await pressSpace();
    expect(useEditorStore.getState().aiBarOpen, "空行按空格应当打开 AI 起草").toBe(true);
    expect(blank.defaultPrevented, "空格被 AI 接管，不能再往文档里插空格").toBe(true);

    seed(editor, "已经有字了");
    useEditorStore.setState({ aiBarOpen: false });
    const typed = await pressSpace();
    expect(useEditorStore.getState().aiBarOpen, "有字的行不能抢空格").toBe(false);
    expect(typed.defaultPrevented, "正常输入空格不能被吃掉").toBe(false);

    flushSync(() => root.unmount());
  });
});
