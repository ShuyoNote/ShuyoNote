// 回归判据：**手机档必须先于桌面主区分支**。
//
// 2026-10-20 跨机实测报回的真缺陷：`App.tsx` 的主区三元里，桌面分支
// （`pdfWhere === "inline"` / `previewWhere === "inline"` / `templateOpen` /
// `view === "graph" | "timeline" | "map" | "board" | "files" | "sync"`）
// 排在手机分支**前面** ⇒ 只要其中任一状态成立（例如上次的看板/关系图被还原、
// PDF/文件预览还开着、模板中心打开），手机上就会渲染**桌面界面** ✗。
//
// 修法是每个桌面主区分支加 `!isMobile &&`（⛔ 不是把手机分支整体提前 —— 那会动桌面骨架）。
// 本文件是**源码形状判据**：谁删掉一个 `!isMobile &&`，这里就红。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "App.tsx"), "utf8");

/** 桌面主区里「一旦成立就会顶掉手机屏」的分支 token（与 App.tsx 三元逐字对应）。 */
const DESKTOP_BRANCHES = [
  'pdfWhere === "inline"',
  'previewWhere === "inline"',
  "templateOpen",
  'view === "graph"',
  'view === "timeline"',
  'view === "map"',
  'view === "board"',
  'view === "files"',
  'view === "sync"',
];

describe("App 主区：桌面分支必须带 !isMobile 守卫（手机优先）", () => {
  for (const token of DESKTOP_BRANCHES) {
    it(`「${token}」分支前有 !isMobile &&`, () => {
      expect(SRC).toContain(`!isMobile && ${token}`);
    });
  }

  it("不存在未守卫的 `) : view === \"…\" ?` 桌面分支", () => {
    for (const view of ["graph", "timeline", "map", "board", "files", "sync"]) {
      expect(SRC, `未守卫的桌面 view 分支：${view}`).not.toMatch(
        new RegExp(String.raw`\)\s*:\s*view === "${view}"\s*\?`),
      );
    }
  });
});
