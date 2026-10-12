// **`InsertShortcutPlugin` 的监听器有没有在「只读上下文」里派发命令？**
//
// Lexical dev 构建会打这条警告（`node_modules/lexical/src/LexicalUpdates.ts:1313`）：
//
//   updateEditorSync: an editor update (e.g. a command listener that mutates the editor)
//   ran while a read-only context was on the stack. ...
//
// 说的是「读上下文还在栈上时又跑了写更新」。本文件把这条警告**抓出来当判据**：
//
//   ① 检测器自检 —— 用 Lexical 自己点名的形状（在 `editor.read()` 里派发命令）把警告真抓一次，
//      证明下面的「0 条」不是判据失灵（`updateEditorSync` 那支 `console.warn`，原文见上）。
//   ② 归因 —— 只挂一个**裸**编辑器（不挂本仓任何插件）提交一次更新，同样能抓到这条警告 ⇒
//      这条警告的来源在 Lexical 自己的提交路径上（`$commitPendingUpdates` → `$updateDOMSelection`
//      → `setDOMSelectionBaseAndExtent` → Lexical 自己的 selectionchange 处理器），不在本插件。
//   ③ 判据 —— 按 Ctrl+Alt+U/O/T 这条路上，**没有任何一条**警告是
//      `InsertShortcutPlugin` 的监听器派发出来的（栈里不许以它作为被警告那次派发的调用点）。
//   ④ 反面对照 —— 同一个窗口里快捷键**仍然生效**（段落真的变成列表）；否则「没警告」可能只是
//      「功能被关掉了」。
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
import { KEY_DOWN_COMMAND, $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import type { LexicalEditor } from "lexical";
import { EDITOR_NODES } from "./config";
import { InsertShortcutPlugin } from "./plugins/InsertShortcutPlugin";
import { LEXICAL_DEV_WARNING_PREFIX, silenceLexicalDevWarnings } from "../test/lexicalWarnings";

// 窗口**外**的那几条（每次播种/提交都会打，见 ② 的归因）按仓里既有约定静音；
// 本文件的 `captureReadOnlyWarnings()` 是在它**之上**再包一层，窗口内的照样抓得到。
silenceLexicalDevWarnings();

/** 本插件的源码文件名（警告栈里会以这个路径出现）。 */
const PLUGIN_FILE = "plugins/InsertShortcutPlugin.tsx";

type Captured = { text: string; stack: string };

/** 抓住 Lexical 那条「只读上下文」警告（连带**完整**调用栈，V8 默认只留 10 帧）。 */
function captureReadOnlyWarnings() {
  const real = console.warn.bind(console);
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const seen: Captured[] = [];
  console.warn = (...args: unknown[]) => {
    const text = String(args[0] ?? "");
    if (text.startsWith(LEXICAL_DEV_WARNING_PREFIX)) {
      seen.push({ text, stack: new Error().stack ?? "" });
      return;
    }
    real(...args);
  };
  return {
    seen,
    restore: () => {
      console.warn = real;
      Error.stackTraceLimit = prevLimit;
    },
  };
}

/** 挂一个最小可用编辑器；`shortcut: false` 时不挂本仓任何插件（归因对照用）。 */
function setup(opts: { shortcut: boolean }) {
  let editor: LexicalEditor | null = null;
  function Probe() {
    [editor] = useLexicalComposerContext();
    return null;
  }
  const children: React.ReactNode[] = [
    React.createElement(Probe),
    React.createElement(RichTextPlugin, {
      contentEditable: React.createElement(ContentEditable, { "aria-label": "编辑器" }),
      placeholder: null,
      ErrorBoundary: LexicalErrorBoundary,
    }),
  ];
  if (opts.shortcut) {
    children.push(
      React.createElement(InsertShortcutPlugin),
      React.createElement(ListPlugin),
      React.createElement(CheckListPlugin),
    );
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
            namespace: "insert-shortcut-readonly",
            nodes: EDITOR_NODES,
            onError: (e: Error) => {
              throw e;
            },
          },
        },
        ...children,
      ),
    ),
  );
  const el = host.querySelector('[contenteditable="true"]') as HTMLElement | null;
  if (!editor || !el) throw new Error("编辑器没挂起来");
  return { editor: editor as LexicalEditor, root };
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

/** 按一次组合键（同 `insertShortcut.test.ts`：走真 `dispatchCommand(KEY_DOWN_COMMAND, …)`）。 */
function press(editor: LexicalEditor, init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  editor.dispatchCommand(KEY_DOWN_COMMAND, e);
  return e.defaultPrevented;
}

function firstBlockType(editor: LexicalEditor): string | null {
  return editor.getEditorState().read(() => $getRoot().getFirstChild()?.getType() ?? null);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("InsertShortcutPlugin：监听器不在只读上下文里派发（Ctrl+Alt+U/O/T）", () => {
  it("① 检测器自检：在 editor.read() 里派发命令时，警告真的会被抓到", async () => {
    const { editor, root } = setup({ shortcut: true });
    try {
      seedParagraph(editor);
      await tick(); // 先让挂载/播种那一拍的提交走完，窗口只留下面这一次派发
      const c = captureReadOnlyWarnings();
      try {
        editor.read(() => {
          press(editor, { key: "u", ctrlKey: true, altKey: true });
        });
        await tick();
      } finally {
        c.restore();
      }
      // 这就是 Lexical 警告原文点名的形状：读上下文还在栈上时派发命令。
      expect(c.seen.length, "在 editor.read() 里派发命令，必须抓到这条警告（否则下面几条「0 条」不算数）").toBeGreaterThan(0);
      expect(
        c.seen.some((s) => s.stack.includes("triggerCommandListeners")),
        "被警告的那次派发要能追到 triggerCommandListeners",
      ).toBe(true);
      // ⭐ 关键：被警告的调用点是**本测试文件里那次** editor.dispatchCommand，不是插件的监听器。
      expect(
        c.seen.some((s) => s.stack.includes("insertShortcutReadonly.test.ts")),
        "栈里应当出现本测试文件（说明检测器抓的是真调用点）",
      ).toBe(true);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("② 归因：警告的来源在 Lexical 自己的提交路径上（不挂本仓任何插件也能重现）", async () => {
    const { editor, root } = setup({ shortcut: false });
    try {
      const c = captureReadOnlyWarnings();
      try {
        seedParagraph(editor);
        await tick();
      } finally {
        c.restore();
      }
      expect(c.seen.length, "只提交一次更新（没有任何本仓插件）就会出现这条警告").toBeGreaterThan(0);
      const s = c.seen[0].stack;
      // 逐字形状：$commitPendingUpdates → $commitPendingUpdatesImpl → $updateDOMSelection
      // → setDOMSelectionBaseAndExtent → Lexical 自己的 selectionchange 处理器 → updateEditorSync
      expect(s, "栈里应当有 Lexical 提交路径").toContain("$commitPendingUpdates");
      expect(s, "栈里应当有 $updateDOMSelection").toContain("$updateDOMSelection");
      expect(s, "栈里应当有 setDOMSelectionBaseAndExtent").toContain("setDOMSelectionBaseAndExtent");
      expect(s, "这条警告与 InsertShortcutPlugin 无关").not.toContain(PLUGIN_FILE);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("③ 判据：按 Ctrl+Alt+U/O/T 这条路上，0 条只读上下文警告", async () => {
    const { editor, root } = setup({ shortcut: true });
    try {
      const all: Captured[] = [];
      for (const key of ["u", "o", "t"]) {
        // 播种（它自己的提交在 happy-dom 下会打一条 Lexical 自己的警告，见 ②）留在窗口**外**，
        // 窗口里只有「按快捷键 → 插件派发 INSERT_*_LIST_COMMAND → 改块」这一条路。
        seedParagraph(editor);
        await tick();
        const c = captureReadOnlyWarnings();
        try {
          press(editor, { key, ctrlKey: true, altKey: true });
          await tick();
        } finally {
          c.restore();
        }
        all.push(...c.seen);
      }
      const explained = all.map((s) => (s.stack.includes(PLUGIN_FILE) ? "plugin" : "lexical-internal"));
      expect(
        all.length,
        `Ctrl+Alt+U/O/T 这条路上不该有只读上下文警告（抓到 ${all.length} 条：${explained.join(",") || "无"}）`,
      ).toBe(0);
      // 双保险：即便将来 Lexical 升级后这条路上冒出别的警告，也不许是**本插件**派的、
      // 也不许是「命令从 editor.read() 里派发」那族（那族的栈里会有 readEditorState）。
      expect(explained.filter((w) => w === "plugin"), "不许由 InsertShortcutPlugin 派发").toEqual([]);
      expect(all.filter((s) => s.stack.includes("readEditorState")), "不许是「从 editor.read() 里派发」那族").toEqual([]);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("④ 反面对照：同一批组合键仍然真的改块（不是把功能关掉换来的「没警告」）", async () => {
    const { editor, root } = setup({ shortcut: true });
    try {
      seedParagraph(editor);
      expect(press(editor, { key: "u", ctrlKey: true, altKey: true }), "Ctrl+Alt+U 要被认领").toBe(true);
      await tick();
      expect(firstBlockType(editor), "Ctrl+Alt+U → 列表").toBe("list");

      seedParagraph(editor);
      expect(press(editor, { key: "o", ctrlKey: true, altKey: true }), "Ctrl+Alt+O 要被认领").toBe(true);
      await tick();
      expect(firstBlockType(editor), "Ctrl+Alt+O → 列表").toBe("list");

      seedParagraph(editor);
      expect(press(editor, { key: "t", ctrlKey: true, altKey: true }), "Ctrl+Alt+T 要被认领").toBe(true);
      await tick();
      expect(firstBlockType(editor), "Ctrl+Alt+T → 列表").toBe("list");
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
