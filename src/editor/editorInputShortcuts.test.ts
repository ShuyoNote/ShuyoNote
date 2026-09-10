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
import React from "react";
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

/** 像用户那样**一个字一个字**地输入（一次提交一个字符）。 */
async function typeChars(editor: LexicalEditor, text: string) {
  for (const ch of text) {
    editor.update(
      () => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) sel.insertText(ch);
      },
      { discrete: true },
    );
    await tick();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

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
    await tick();
    expect(document.querySelector(".slash-menu"), "输入 / 后应当弹出菜单").not.toBeNull();

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
    await tick();
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
    document.body.dispatchEvent(e);
    await tick();
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
    await tick();
    const items = Array.from(document.querySelectorAll(".page-link-suggest-item"));
    expect(items.length, "应当出现候选").toBeGreaterThan(1);
    expect(items[0].className, "默认选中第一项").toContain("active");

    const down = pressKey(editor, "ArrowDown");
    await tick();
    const after = Array.from(document.querySelectorAll(".page-link-suggest-item"));
    expect(down.prevented, "↓ 应当被菜单认领").toBe(true);
    expect(after[1].className, "↓ 之后选中第二项").toContain("active");

    const enter = pressKey(editor, "Enter");
    await tick();
    expect(enter.prevented, "Enter 应当被菜单认领（否则会变成换行）").toBe(true);
    expect(first(editor).text, "Enter 应当插入 [[标题]]").toContain("[[页面乙]]");

    flushSync(() => root.unmount());
  });
});

describe("AI 组：空行按空格", () => {
  it("空行按空格打开内联 AI 起草；有字的行不抢", async () => {
    const s = doc("ai-draft");
    expect(s.keys).toEqual(["Space"]);
    const { editor, el, root } = setup([React.createElement(AiSpaceTriggerPlugin)]);

    // 事件必须真的发生在编辑器里（插件用 root.contains(target) 守门），所以派发到 contentEditable。
    const pressSpace = () => {
      const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e;
    };

    seed(editor);
    useEditorStore.setState({ aiBarOpen: false });
    const blank = pressSpace();
    await tick();
    expect(useEditorStore.getState().aiBarOpen, "空行按空格应当打开 AI 起草").toBe(true);
    expect(blank.defaultPrevented, "空格被 AI 接管，不能再往文档里插空格").toBe(true);

    seed(editor, "已经有字了");
    useEditorStore.setState({ aiBarOpen: false });
    const typed = pressSpace();
    await tick();
    expect(useEditorStore.getState().aiBarOpen, "有字的行不能抢空格").toBe(false);
    expect(typed.defaultPrevented, "正常输入空格不能被吃掉").toBe(false);

    flushSync(() => root.unmount());
  });
});
