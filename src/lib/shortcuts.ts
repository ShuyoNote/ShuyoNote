// M25 — Single source of truth for keyboard shortcuts. The shortcuts panel, command
// palette, tooltips and docs all read from here, so adding/changing a combo edits
// one place. Pure helpers are unit-tested (see scripts/smoke-web.mjs).

export type ShortcutGroup = "基础" | "编辑器" | "列表" | "导航" | "AI";

export interface Shortcut {
  /** Stable id, e.g. "new-page". */
  key: string;
  /** Chinese label, e.g. "新建页面". */
  label: string;
  group: ShortcutGroup;
  /** Display combo, e.g. ["Ctrl", "N"] for Ctrl+N. */
  keys: string[];
  /** Optional macOS combo override, e.g. ["⌘", "N"]. */
  macKeys?: string[];
  /** Optional scope hint, e.g. "全局" / "编辑器内". */
  when?: string;
}

// The authoritative list (see docs/plans/2026-08-27-help-system-plan.md §9.2).
// Gaps are acknowledged where a feature has no keystroke yet.
export const SHORTCUTS: Shortcut[] = [
  // ---- 基础 ----
  { key: "new-page", label: "新建页面", group: "基础", keys: ["Ctrl", "N"], macKeys: ["⌘", "N"], when: "全局" },
  { key: "command-palette", label: "命令面板", group: "基础", keys: ["Ctrl", "K"], macKeys: ["⌘", "K"], when: "全局" },
  { key: "focus-search", label: "聚焦搜索", group: "基础", keys: ["Ctrl", "Shift", "F"], macKeys: ["⌘", "⇧", "F"], when: "全局" },
  { key: "shortcuts", label: "快捷键面板", group: "基础", keys: ["Ctrl", "/"], macKeys: ["⌘", "/"], when: "全局" },
  { key: "close", label: "关闭查找/命令面板/浮层", group: "基础", keys: ["Esc"], when: "全局" },
  { key: "slash-menu", label: "斜杠菜单", group: "基础", keys: ["/"], when: "编辑器内" },

  // ---- 编辑器 (Ctrl+Alt) ----
  { key: "h1", label: "标题 1", group: "编辑器", keys: ["Ctrl", "Alt", "1"], when: "编辑器内" },
  { key: "h2", label: "标题 2", group: "编辑器", keys: ["Ctrl", "Alt", "2"], when: "编辑器内" },
  { key: "h3", label: "标题 3", group: "编辑器", keys: ["Ctrl", "Alt", "3"], when: "编辑器内" },
  { key: "bullet-list", label: "无序列表", group: "编辑器", keys: ["Ctrl", "Alt", "U"], when: "编辑器内" },
  { key: "ordered-list", label: "有序列表", group: "编辑器", keys: ["Ctrl", "Alt", "O"], when: "编辑器内" },
  { key: "todo", label: "待办", group: "编辑器", keys: ["Ctrl", "Alt", "T"], when: "编辑器内" },
  { key: "quote", label: "引用", group: "编辑器", keys: ["Ctrl", "Alt", "Q"], when: "编辑器内" },
  { key: "code", label: "代码块", group: "编辑器", keys: ["Ctrl", "Alt", "C"], when: "编辑器内" },
  { key: "link", label: "链接", group: "编辑器", keys: ["Ctrl", "Alt", "L"], when: "编辑器内" },
  { key: "hr", label: "分隔线", group: "编辑器", keys: ["Ctrl", "Alt", "M"], when: "编辑器内" },

  // ---- 列表 (Markdown 快捷) ----
  { key: "md-bullet", label: "无序列表（行首 `- `）", group: "列表", keys: ["-", " "], when: "编辑器内" },
  { key: "md-ordered", label: "有序列表（行首 `1. `）", group: "列表", keys: ["1", ".", " "], when: "编辑器内" },
  { key: "md-todo", label: "待办（行首 `[] `）", group: "列表", keys: ["[", "]", " "], when: "编辑器内" },
  { key: "md-heading", label: "标题（行首 `# `）", group: "列表", keys: ["#", " "], when: "编辑器内" },
  { key: "md-quote", label: "引用（行首 `> `）", group: "列表", keys: [">", " "], when: "编辑器内" },
  { key: "md-code", label: "代码块（``` ）", group: "列表", keys: ["`", "`", "`"], when: "编辑器内" },

  // ---- 导航 ----
  { key: "cycle-view", label: "循环 笔记/看板/关系图 视图", group: "导航", keys: ["Ctrl", "E"], macKeys: ["⌘", "E"], when: "编辑器内" },
  { key: "editor-find", label: "编辑器内查找", group: "导航", keys: ["Ctrl", "F"], macKeys: ["⌘", "F"], when: "全局" },

  // ---- AI ----
  { key: "ai-draft", label: "内联 AI 起草（空行按空格）", group: "AI", keys: ["Space"], when: "编辑器内" },
];

const GROUP_ORDER: ShortcutGroup[] = ["基础", "编辑器", "列表", "导航", "AI"];

/** Distinct groups in canonical order (drops empty groups). */
export function shortcutGroups(): ShortcutGroup[] {
  const present = new Set(SHORTCUTS.map((s) => s.group));
  return GROUP_ORDER.filter((g) => present.has(g));
}

/** Case-insensitive search over label / key / group / each key token. */
export function shortcutSearch(q: string): Shortcut[] {
  const needle = String(q ?? "").trim().toLowerCase();
  if (!needle) return SHORTCUTS;
  return SHORTCUTS.filter((s) => {
    const hay = `${s.label} ${s.key} ${s.group} ${s.keys.join(" ")}`.toLowerCase();
    return hay.includes(needle);
  });
}

/** Format a combo for display: "Ctrl + Shift + F" (falls back to macKeys on macOS). */
export function shortcutLabel(s: Shortcut, isMac = false): string {
  const keys = isMac && s.macKeys ? s.macKeys : s.keys;
  return keys.join(" + ");
}
