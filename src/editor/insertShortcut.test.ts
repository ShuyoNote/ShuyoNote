// **文档里写的「编辑器内」快捷键，真的能改块吗？** —— 在真 Lexical 编辑器里按一遍。
//
// 这 9 个组合（Ctrl+Alt+1/2/3/U/O/T/Q/C/L/M）由 `InsertShortcutPlugin` 接管；文档的
// 单一来源是 `src/lib/shortcuts.ts`。这里挂一个**真的 Lexical 编辑器**（与应用同一份节点
// 注册表），在 contentEditable 上派发真的 keydown，然后读编辑器状态看块类型变没变——
// 而不是断言"插件被注册了"这种自己骗自己的东西。
import { describe, expect, it } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { KEY_DOWN_COMMAND, $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "../editor/config";
import { InsertShortcutPlugin } from "../editor/plugins/InsertShortcutPlugin";
import { SHORTCUTS } from "../lib/shortcuts";
import { silenceLexicalDevWarnings } from "../test/lexicalWarnings";

// Lexical dev 构建在这个环境里会打 updateEditorSync 警告（见 src/test/lexicalWarnings.ts）
// ——只静音那一条，其余警告照旧输出。
silenceLexicalDevWarnings();

/** 挂一个最小可用的编辑器（与应用同一份节点清单 + 同一个插件），并把 editor 交回来。 */
function setup() {
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
            namespace: "shortcut-test",
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
        React.createElement(InsertShortcutPlugin),
        // 列表命令由 ListPlugin / CheckListPlugin 兜（应用里同样挂着），没有它们
        // Ctrl+Alt+U/O/T 派发出去的 INSERT_*_LIST_COMMAND 没人接——那是**测试环境的缺口**，
        // 不是插件的 bug，所以这里照应用的样子补齐。
        React.createElement(ListPlugin),
        React.createElement(CheckListPlugin),
      ),
    ),
  );
  const el = host.querySelector('[contenteditable="true"]') as HTMLElement | null;
  if (!editor || !el) throw new Error("编辑器没挂起来");
  return { editor: editor as LexicalEditor, el, root };
}

/** 塞一个普通段落并选中它。 */
function seedParagraph(editor: LexicalEditor, text = "段落内容") {
  editor.update(
    () => {
      const p = $createParagraphNode();
      p.append($createTextNode(text));
      const root = $getRoot();
      root.clear();
      root.append(p);
      p.selectStart();
    },
    { discrete: true },
  );
}

/** 读第一个块的类型/标签/文本。 */
function firstBlock(editor: LexicalEditor) {
  return editor.getEditorState().read(() => {
    const n = $getRoot().getFirstChild();
    const anyNode = n as unknown as { getTag?: () => string };
    return { type: n?.getType() ?? null, tag: anyNode?.getTag?.() ?? "", text: n?.getTextContent() ?? "" };
  });
}

/**
 * 按一次组合键。
 *
 * **走 `dispatchCommand(KEY_DOWN_COMMAND, …)` 而不是往 contentEditable 派 DOM 事件**：
 * 后者需要 Lexical 的 ContentEditable 把原生 keydown 转成 KEY_DOWN_COMMAND，而那一跳在
 * happy-dom 下不触发（已用探针确认：同一事件下 `defaultPrevented` 始终为 false）。
 * 这一跳是 **Lexical 自己的**代码——应用里每一次按键都靠它，它坏了编辑器整个不响应，
 * 不需要我们这层测试去证；我们自己的东西是「收到 KEY_DOWN_COMMAND 之后怎么改块」，
 * 而那正是这里用真命令测的（命令名、事件对象、preventDefault、块的变化，都是真契约）。
 *
 * 返回的 `handled` **不能当作「插件认领了这次按键」的证据**：Lexical 自己那支
 * `$handleKeyDown`（EDITOR 档、最后一个跑）对每一次 keydown 都 `return true`，所以
 * `dispatchCommand` 几乎总是返回 true。真正能区分「我们认领了」和「被 Lexical 吞掉」的
 * 是 `e.defaultPrevented`——`InsertShortcutPlugin` 只在认领时调用 `preventDefault()`。
 */
function press(editor: LexicalEditor, init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const handled = editor.dispatchCommand(KEY_DOWN_COMMAND, e);
  return { handled, e, prevented: e.defaultPrevented };
}

/** 等一拍：插件里的 editor.update() 是批处理的，读状态要等它落地。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 文档里那条「编辑器」组快捷键 → 期望的块类型。 */
const EXPECTED: { key: string; type: string; tag?: string }[] = [
  { key: "h1", type: "heading", tag: "h1" },
  { key: "h2", type: "heading", tag: "h2" },
  { key: "h3", type: "heading", tag: "h3" },
  { key: "bullet-list", type: "list" },
  { key: "ordered-list", type: "list" },
  { key: "todo", type: "list" },
  { key: "quote", type: "quote" },
  { key: "code", type: "code" },
  { key: "link", type: "paragraph" },
  { key: "hr", type: "horizontalrule" },
];

describe("编辑器内快捷键（Ctrl+Alt+…，照文档逐条按）", () => {
  it("文档里 Ctrl+Alt 那一组，每一条都真的改了块类型", async () => {
    const { editor, root } = setup();

    for (const { key, type, tag } of EXPECTED) {
      const doc = SHORTCUTS.find((s) => s.key === key);
      expect(doc, `shortcuts.ts 里应当有 ${key}`).toBeTruthy();
      // 照 shortcuts.ts 里的 keys 组装按键（不在这里抄一遍组合键）
      const init: KeyboardEventInit = { key: "", ctrlKey: false, altKey: false };
      for (const t of doc!.keys) {
        if (t === "Ctrl") init.ctrlKey = true;
        else if (t === "Alt") init.altKey = true;
        else init.key = t.toLowerCase();
      }

      seedParagraph(editor);
      const { prevented } = press(editor, init);
      await tick();
      const got = firstBlock(editor);
      expect(prevented, `${key}：插件应当认领这次按键（preventDefault，才能拦下浏览器/编辑器的默认行为）`).toBe(true);
      expect(got.type, `${key}（${doc!.keys.join("+")}）应当把段落变成 ${type}`).toBe(type);
      if (tag) expect(got.tag, `${key} 的标签`).toBe(tag);
    }

    flushSync(() => root.unmount());
  });

  it("守卫：带 Shift、或缺 Alt 都不抢（Ctrl+Alt+Shift+1 / Ctrl+1 不该改块）", async () => {
    const { editor, root } = setup();

    seedParagraph(editor);
    expect(press(editor, { key: "1", ctrlKey: true, altKey: true, shiftKey: true }).prevented, "带 Shift 不该认领").toBe(false);
    await tick();
    expect(firstBlock(editor).type, "带 Shift 不触发").toBe("paragraph");

    seedParagraph(editor);
    expect(press(editor, { key: "1", ctrlKey: true }).prevented, "缺 Alt 不该认领").toBe(false);
    await tick();
    expect(firstBlock(editor).type, "缺 Alt 不触发").toBe("paragraph");

    flushSync(() => root.unmount());
  });

  it("「链接」保留原文本（换成 https:// 链接，而不是把内容吞掉）", async () => {
    const { editor, root } = setup();
    seedParagraph(editor, "要链的文字");
    press(editor, { key: "l", ctrlKey: true, altKey: true });
    await tick();
    const blk = editor.getEditorState().read(() => {
      const n = $getRoot().getFirstChild() as unknown as { getFirstChild?: () => { getType: () => string; getTextContent: () => string } } | null;
      const link = n?.getFirstChild?.();
      return { type: link?.getType() ?? "", text: link?.getTextContent() ?? "" };
    });
    expect(blk.type).toBe("link");
    expect(blk.text).toBe("要链的文字");
    flushSync(() => root.unmount());
  });

  it("「分隔线」后面留一个空段落（否则光标没地方落，用户得自己敲回车）", async () => {
    const { editor, root } = setup();
    seedParagraph(editor);
    press(editor, { key: "m", ctrlKey: true, altKey: true });
    await tick();
    const types = editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .map((n) => n.getType()),
    );
    expect(types).toEqual(["horizontalrule", "paragraph"]);
    flushSync(() => root.unmount());
  });
});
