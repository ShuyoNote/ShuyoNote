// **「文档里的快捷键」和「真的有人测」之间的闸门。**
//
// `src/lib/shortcuts.ts` 是快捷键清单的单一来源：快捷键面板、帮助、文档都读它。但它只是一份
// **声明**——声明和实现分在两个地方，就会出现"文档写了、按下去没反应"。2026-09 就是这么发现
// 两处真问题的：`InsertShortcutPlugin`（Ctrl+Alt 那一组 10 条）和 `PageLinkSuggestPlugin` 把
// KEY_DOWN_COMMAND 注册在 `COMMAND_PRIORITY_EDITOR` 档，而 Lexical 自己那支"对每次 keydown
// 都 return true"的 `$handleKeyDown` 就在同一档且排在前头——同档的后来者永远收不到事件，
// 10 条快捷键**全部静默失效**；斜杠菜单的分组清单也不是按分组相邻的，菜单里分组标题出现了两次。
//
// 所以这里要求：**清单里每一条都能指到一个真存在、且真的在测它的用例**。
// 光"文件存在"不够——映射表里的用例标题必须真出现在那个文件里（下面会去文件里找）。
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SHORTCUTS } from "./shortcuts";

interface Owner {
  /** 相对仓库根的测试文件。 */
  file: string;
  /** 该文件里真的在测这条快捷键的用例标题（`it("…")` 的原文）。 */
  title: string;
}

const GLOBAL = "src/hooks/globalShortcuts.test.ts";
const OVERLAY = "src/components/overlayShortcuts.test.ts";
const EDITOR_INPUT = "src/editor/editorInputShortcuts.test.ts";
const EDITOR_KEYS = "src/editor/insertShortcut.test.ts";

const EDITOR_GROUP_TITLE = "文档里 Ctrl+Alt 那一组，每一条都真的改了块类型";
const MARKDOWN_GROUP_TITLE = "文档里那 5 条行首语法，输入完都真的变成了对应块";

/** 清单里每条快捷键 → 哪条用例在测它。 */
const OWNERS: Record<string, Owner> = {
  // 基础
  "new-page": { file: GLOBAL, title: "Ctrl+N（新建页面）：文档说全局 → 真的建页" },
  "command-palette": { file: OVERLAY, title: "按 Ctrl+K 真的打开/关闭命令面板" },
  "toggle-sidebar": { file: GLOBAL, title: "Ctrl+B（开合侧栏）：非编辑态收起/展开" },
  "focus-search": { file: GLOBAL, title: "Ctrl+Shift+F（聚焦搜索）：把焦点交给搜索框" },
  shortcuts: { file: GLOBAL, title: "Ctrl+/ 与 ?（快捷键面板）：全局都能开，但 ? 不在输入态抢" },
  close: { file: OVERLAY, title: "快捷键面板开着时按 Esc 真的关掉" },
  "slash-menu": { file: EDITOR_INPUT, title: "输入 / 真的弹出斜杠菜单" },

  // 编辑器（Ctrl+Alt 那一组，同一个用例逐条按键）
  h1: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  h2: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  h3: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  "bullet-list": { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  "ordered-list": { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  todo: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  quote: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  code: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  link: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },
  hr: { file: EDITOR_KEYS, title: EDITOR_GROUP_TITLE },

  // 列表（Markdown 行首语法，同一个用例逐条输入）
  "md-bullet": { file: EDITOR_INPUT, title: MARKDOWN_GROUP_TITLE },
  "md-ordered": { file: EDITOR_INPUT, title: MARKDOWN_GROUP_TITLE },
  "md-todo": { file: EDITOR_INPUT, title: MARKDOWN_GROUP_TITLE },
  "md-heading": { file: EDITOR_INPUT, title: MARKDOWN_GROUP_TITLE },
  "md-quote": { file: EDITOR_INPUT, title: MARKDOWN_GROUP_TITLE },

  // 导航
  "cycle-view": { file: GLOBAL, title: "Ctrl+E（循环视图）：文档说调 onToggleView" },
  "editor-find": { file: EDITOR_INPUT, title: "按 Ctrl+F 真的出现查找条" },

  // AI
  "ai-draft": { file: EDITOR_INPUT, title: "空行按空格打开内联 AI 起草；有字的行不抢" },
};

const ROOT = process.cwd();

/** 去掉整行注释与块注释——扫描注册实参时不看注释（注释里会提到被禁用的档位）。 */
function stripCommentLines(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("文档里的快捷键：每条都指得到一个真存在的用例", () => {
  it("清单里没有「没人测」的快捷键", () => {
    const missing = SHORTCUTS.filter((s) => !OWNERS[s.key]).map((s) => `${s.key}（${s.label}）`);
    expect(missing, `这些快捷键在测试里没有主人：${missing.join("、")}`).toEqual([]);
  });

  it("映射表里没有「清单已经删掉」的快捷键", () => {
    const live = new Set(SHORTCUTS.map((s) => s.key));
    const stale = Object.keys(OWNERS).filter((k) => !live.has(k));
    expect(stale, `映射表里还留着清单里已不存在的：${stale.join("、")}`).toEqual([]);
  });

  it("指到的用例真的在文件里（不是文件名糊弄）", () => {
    for (const [key, owner] of Object.entries(OWNERS)) {
      const path = resolve(ROOT, owner.file);
      expect(existsSync(path), `${key} 指到的文件不存在：${owner.file}`).toBe(true);
      const src = readFileSync(path, "utf8");
      expect(src, `${key} 指到的用例「${owner.title}」在 ${owner.file} 里找不到`).toContain(owner.title);
      // 标题必须真的在某条 it(...) / describe(...) 里，而不是某句注释里
      const declaration = `${owner.title}`;
      expect(
        src.split("\n").some((line) => (line.includes("it(") || line.includes("describe(")) && line.includes(declaration)),
        `${key}：「${owner.title}」出现了，但不在 it(...)/describe(...) 里`,
      ).toBe(true);
    }
  });

  it("清单本身没有重复、没有空组合键、分组都在规范顺序里", () => {
    const keys = SHORTCUTS.map((s) => s.key);
    expect(new Set(keys).size, `key 重复：${keys.join("、")}`).toBe(keys.length);
    for (const s of SHORTCUTS) {
      expect(s.keys.length, `${s.key} 的组合键是空的`).toBeGreaterThan(0);
      expect(s.label.trim().length, `${s.key} 没有标题`).toBeGreaterThan(0);
      expect(["基础", "编辑器", "列表", "导航", "AI"]).toContain(s.group);
      // 展示用的组合键必须能拼出来（面板/文档都直接读它）
      expect(s.keys.every((k) => typeof k === "string" && k.length > 0), `${s.key} 的组合键有空的`).toBe(true);
    }
  });
});

describe("插件里的按键注册：不许再踩 EDITOR 优先级那个坑", () => {
  // Lexical 的优先级队列是 CRITICAL > HIGH > NORMAL > LOW > **EDITOR（最后一档）**，而
  // Lexical 自己那支 `$handleKeyDown`（由 RichTextPlugin 在 layout effect 里装进编辑器）就在
  // EDITOR 档，且对**每一次** keydown 都 `return true`。同档里后来者排在它后面，所以插件在
  // `useEffect`（被动 effect 永远晚于 layout effect）里注册 EDITOR 档的 KEY_DOWN_COMMAND，
  // 等于一块永远收不到事件的牌子。2026-09 就是这样静默废掉了两组功能：
  //   - InsertShortcutPlugin：Ctrl+Alt+1/2/3/U/O/T/Q/C/L/M 共 10 条（文档里写着能用）
  //   - PageLinkSuggestPlugin：`[[` 菜单的 ↑/↓/Enter/Esc（Enter 变成换行）
  // 行为测试（insertShortcut.test.ts / editorInputShortcuts.test.ts）负责"这两处真的能用"；
  // 这条负责"别再有人新写一个"。
  const pluginDir = resolve(ROOT, "src/editor/plugins");

  it("src/editor/plugins 下没有把按键命令注册到 COMMAND_PRIORITY_EDITOR 的地方", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(pluginDir)) {
      if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
      const src = readFileSync(resolve(pluginDir, file), "utf8");
      // 逐个 registerCommand(...) 调用看它的实参（用括号配平截出这一段的文本）
      let idx = src.indexOf("registerCommand(");
      while (idx !== -1) {
        const start = idx + "registerCommand(".length;
        let depth = 1;
        let i = start;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === "(") depth++;
          else if (c === ")") depth--;
          i++;
        }
        const call = stripCommentLines(src.slice(start, i));
        if (call.includes("KEY_DOWN_COMMAND") && call.includes("COMMAND_PRIORITY_EDITOR")) {
          offenders.push(`${file}: ${call.split("\n").slice(-3).join(" ").trim().slice(0, 80)}`);
        }
        idx = src.indexOf("registerCommand(", i);
      }
    }
    expect(
      offenders,
      `KEY_DOWN_COMMAND 注册在 COMMAND_PRIORITY_EDITOR 档会永远收不到事件（Lexical 自己那支 ` +
        `$handleKeyDown 就在该档且总是 return true），请改用 COMMAND_PRIORITY_LOW：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("编辑器快捷键：文档与实现**双向**对齐", () => {
  // `InsertShortcutPlugin` 手写的 `if (key === "x")` 分支就是它真正支持的组合键。
  // 正向（文档里的都实现了）由 insertShortcut.test.ts 逐条按键保证；这里补反向：
  // 实现里多出来的（文档没写的）组合键要拦住——否则用户会撞上一堆"文档里没有、
  // 但按下去会改文档"的按键。
  const plugin = readFileSync(resolve(ROOT, EDITOR_KEYS.replace("insertShortcut.test.ts", "plugins/InsertShortcutPlugin.tsx")), "utf8");

  it("插件里的分支与文档里「编辑器」组的字母一一对应", () => {
    const handled = [...plugin.matchAll(/key === "([^"]+)"/g)].map((m) => m[1]).sort();
    const documented = SHORTCUTS.filter((s) => s.group === "编辑器")
      .map((s) => s.keys[s.keys.length - 1].toLowerCase())
      .sort();
    expect(
      handled,
      `InsertShortcutPlugin 支持 ${JSON.stringify(handled)}，文档写的是 ${JSON.stringify(documented)}。` +
        `（若实现改成表驱动，请同步更新本测试的提取方式）`,
    ).toEqual(documented);
  });

  it("每条编辑器快捷键都是 Ctrl+Alt 起手（守卫写在插件里，靠这个前提不与输入冲突）", () => {
    for (const s of SHORTCUTS.filter((x) => x.group === "编辑器")) {
      expect(s.keys.slice(0, 2), `${s.key} 的组合键`).toEqual(["Ctrl", "Alt"]);
      expect(s.keys.length, `${s.key} 应当只有三键`).toBe(3);
    }
  });
});
