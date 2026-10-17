// ⭐⭐ **2026-10-18（owner：「更狠点」）**：rail 图标换成 **VS Code Codicons**（MIT）。
//
// 为什么：我们自绘的是 lucide 风格（24 网格、圆头描边），而 VS Code 的观感来自 **Codicons** ——
// 16 网格、**填充路径**、留白与视觉重量是官方调过的。换这套 = 从"像"变成"同一套字形"。
//
// 来源：https://github.com/microsoft/vscode-codicons（MIT License，Copyright (c) Microsoft Corporation）
//   · 只取 rail 用到的 13 个：layout-sidebar-left / file / search / cloud-upload / mail / folder / type-hierarchy / history / tag / book / layout / trash / gear
//   · **原样保留 path**（⛔ 不手改坐标）：官方 svg 是 viewBox 16 或 24；
//     ⚠️ 官方正在陆续迁 24 网格（同一版里 `search` 已是 24、其余仍是 16 ✗）⇒ 这里**统一到 16 画布**：
//     CSS 把 24px 渲染成 1.5× 放大 ⇒ 16 网格原样用、24 网格缩 ⅔ 装进 16（24×⅔=16 ✓），两边视觉尺寸才一致。
//     渲染尺寸由 CSS 定（.activity-bar ... > svg { width/height:24px }）。
// ⚠️ 这套**只给 rail 用**；App 其它地方仍是原来的自绘线性图标（不混着换，减少回归面）。
//
// ── 下面是这些 path 的许可证全文（MIT 要求随副本带上版权与许可声明）────────────────
// MIT License
//
// Copyright (c) Microsoft Corporation.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished
// to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ─────────────────────────────────────────────────────────────────────────────
import type { ReactNode, SVGProps } from "react";

export type RailIconProps = SVGProps<SVGSVGElement>;

function RailIcon({ children, ...props }: RailIconProps & { children: ReactNode }) {
  return (
    <svg width={24} height={24} viewBox="0 0 16 16" fill="currentColor" {...props}>
      {children}
    </svg>
  );
}

/** 侧栏开合 —— codicon `layout-sidebar-left` */
export function RailSidebarIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M2 1L1 2V14L2 15H14L15 14V2L14 1H2ZM14 14H7V2H14V14Z"/>
    </RailIcon>
  );
}

/** 页面 —— codicon `file` */
export function RailNotesIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM13 14H4V2h5v4h4v8zm-3-9V2l3 3h-3z"/>
    </RailIcon>
  );
}

/** 搜索 —— codicon `search` */
export function RailSearchIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <g transform="scale(0.6666667)"><path d="M15.25 0a8.25 8.25 0 0 0-6.18 13.72L1 22.88l1.12 1 8.05-9.12A8.251 8.251 0 1 0 15.25.01V0zm0 15a6.75 6.75 0 1 1 0-13.5 6.75 6.75 0 0 1 0 13.5z"/></g>
    </RailIcon>
  );
}

/** 同步 —— codicon `cloud-upload` */
export function RailSyncIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M11.956 6h.05a2.99 2.99 0 0 1 2.117.879 3.003 3.003 0 0 1 0 4.242 2.99 2.99 0 0 1-2.117.879h-1.995v-1h1.995a2.002 2.002 0 0 0 0-4h-.914l-.123-.857a2.49 2.49 0 0 0-2.126-2.122A2.478 2.478 0 0 0 6.23 5.5l-.333.762-.809-.189A2.49 2.49 0 0 0 4.523 6c-.662 0-1.297.263-1.764.732A2.503 2.503 0 0 0 4.523 11h2.494v1H4.523a3.486 3.486 0 0 1-2.628-1.16 3.502 3.502 0 0 1-.4-4.137A3.497 3.497 0 0 1 3.853 5.06c.486-.09.987-.077 1.468.041a3.486 3.486 0 0 1 3.657-2.06A3.479 3.479 0 0 1 11.956 6zm-1.663 3.853L8.979 8.54v5.436h-.994v-5.4L6.707 9.854 6 9.146 8.146 7h.708L11 9.146l-.707.707z"/>
    </RailIcon>
  );
}

/** 邮箱 —— codicon `mail` */
export function RailMailIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M1 3.5l.5-.5h13l.5.5v9l-.5.5h-13l-.5-.5v-9zm1 1.035V12h12V4.536L8.31 8.9H7.7L2 4.535zM13.03 4H2.97L8 7.869 13.03 4z"/>
    </RailIcon>
  );
}

/** 文件管理 —— codicon `folder` */
export function RailFolderIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.49l.35-.15.86-.86H14v1.5l-.01 4zm0-6.49h-6.5l-.35.15-.86.86H2v-3h4.29l.85.85.36.15H14l-.01.99z"/>
    </RailIcon>
  );
}

/** 关系图 —— codicon `type-hierarchy` */
export function RailGraphIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path d="M13.5 12h-1.793L10 10.293V6.5L9.5 6H8V4h.5l.5-.5v-2L8.5 1h-2l-.5.5v2l.5.5H7v2H5.5l-.5.5v3.793L3.293 12H1.5l-.5.5v2l.5.5h2l.5-.5v-1.793L5.707 11h3.586L11 12.707V14.5l.5.5h2l.5-.5v-2l-.5-.5zM7 2h1v1H7V2zM6 7h3v3H6V7zm-3 7H2v-1h1v1zm10 0h-1v-1h1v1z"/>
    </RailIcon>
  );
}

/** 时间线 —— codicon `history` */
export function RailTimelineIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M13.507 12.324a7 7 0 0 0 .065-8.56A7 7 0 0 0 2 4.393V2H1v3.5l.5.5H5V5H2.811a6.008 6.008 0 1 1-.135 5.77l-.887.462a7 7 0 0 0 11.718 1.092zm-3.361-.97l.708-.707L8 7.792V4H7v4l.146.354 3 3z"/>
    </RailIcon>
  );
}

/** 知识地图 —— codicon `tag` */
export function RailTagIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M13.2 2H8.017l-.353.146L1 8.81v.707L6.183 14.7h.707l2.215-2.215A4.48 4.48 0 0 0 15.65 9c.027-.166.044-.332.051-.5a4.505 4.505 0 0 0-2-3.74V2.5l-.5-.5zm-.5 2.259A4.504 4.504 0 0 0 11.2 4a.5.5 0 1 0 0 1 3.5 3.5 0 0 1 1.5.338v2.138L8.775 11.4a.506.506 0 0 0-.217.217l-2.022 2.022-4.475-4.476L8.224 3H12.7v1.259zm1 1.792a3.5 3.5 0 0 1 1 2.449 3.438 3.438 0 0 1-.051.5 3.487 3.487 0 0 1-4.793 2.735l3.698-3.698.146-.354V6.051z"/>
    </RailIcon>
  );
}

/** 库地图 —— codicon `book` */
export function RailWikiIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 2H9l-.35.15-.65.64-.65-.64L7 2H1.5l-.5.5v10l.5.5h5.29l.86.85h.7l.86-.85h5.29l.5-.5v-10l-.5-.5zm-7 10.32l-.18-.17L7 12H2V3h4.79l.74.74-.03 8.58zM14 12H9l-.35.15-.14.13V3.7l.7-.7H14v9zM6 5H3v1h3V5zm0 4H3v1h3V9zM3 7h3v1H3V7zm10-2h-3v1h3V5zm-3 2h3v1h-3V7zm0 2h3v1h-3V9z"/>
    </RailIcon>
  );
}

/** 模板中心 —— codicon `layout` */
export function RailTemplateIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path d="M3 2L2 3V13L3 14H7L8 13V3L7 2H3ZM3 13V3H7V13H3Z"/><path d="M10 3L11 2H14L15 3V6L14 7H11L10 6V3ZM11 3V6H14V3H11Z"/><path d="M10 10L11 9H14L15 10V13L14 14H11L10 13V10ZM11 10V13H14V10H11Z"/>
    </RailIcon>
  );
}

/** 回收站 —— codicon `trash` */
export function RailTrashIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/>
    </RailIcon>
  );
}

/** 设置 —— codicon `gear` */
export function RailSettingsIcon(props: RailIconProps) {
  return (
    <RailIcon {...props}>
      <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8zm.6 7c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zM8 9c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1z"/>
    </RailIcon>
  );
}
