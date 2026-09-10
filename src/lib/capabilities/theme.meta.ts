// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。

/** 一个可主题化的设计变量。 */
export interface ThemeToken {
  name: string;
  /** `color` / `length`：值的形态检查据此做。 */
  kind: string;
  desc: string;
}

export const THEME_TOKENS: ThemeToken[] = [
  { name: "--bg", kind: "color", desc: "主背景" },
  { name: "--bg-sidebar", kind: "color", desc: "侧栏背景" },
  { name: "--text", kind: "color", desc: "正文色" },
  { name: "--text-dim", kind: "color", desc: "次要文字" },
  { name: "--text-faint", kind: "color", desc: "更浅的文字" },
  { name: "--border", kind: "color", desc: "边框" },
  { name: "--border-strong", kind: "color", desc: "较重的边框" },
  { name: "--hover", kind: "color", desc: "悬停底色" },
  { name: "--hover-strong", kind: "color", desc: "较重的悬停底色" },
  { name: "--card-bg", kind: "color", desc: "卡片背景" },
  { name: "--code-bg", kind: "color", desc: "行内代码背景" },
  { name: "--codeblock-bg", kind: "color", desc: "代码块背景" },
  { name: "--accent", kind: "color", desc: "强调色" },
  { name: "--accent-strong", kind: "color", desc: "强调色（深）" },
  { name: "--accent-soft", kind: "color", desc: "强调色（浅）" },
  { name: "--danger", kind: "color", desc: "危险色" },
  { name: "--cat-red", kind: "color", desc: "分类色·红" },
  { name: "--cat-orange", kind: "color", desc: "分类色·橙" },
  { name: "--cat-yellow", kind: "color", desc: "分类色·黄" },
  { name: "--cat-green", kind: "color", desc: "分类色·绿" },
  { name: "--cat-blue", kind: "color", desc: "分类色·蓝" },
  { name: "--cat-purple", kind: "color", desc: "分类色·紫" },
  { name: "--radius", kind: "length", desc: "圆角" },
  { name: "--radius-sm", kind: "length", desc: "小圆角" },
];

export const THEME_TOKEN_NAMES = THEME_TOKENS.map((t) => t.name);
