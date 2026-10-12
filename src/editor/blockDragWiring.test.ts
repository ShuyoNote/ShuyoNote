// ⭐⭐ **2026-10-12（owner：「打开」）**：块拖拽的**接线判据** ✗ ——
//
// ⚠️ 这里只钉两件事：⭐ **开关真的开着** ✓（`Editor` 必须把 `dragEnabled` 传上去 ✓）
//    ＋ ⭐ **唯一那条拖拽入口仍然被这个开关掐着** ✓（否则"打开"两个字不算数 ✓）。
//
// ⛔ **别把本文件读成"拖拽已被验收"** ✗：拖拽**行为**那四条 --
//    ① >5px 才起拖 ② 落点线画在正确的块位 ③ 松手**顺序真的落库**（⛔ 不是只动 DOM ✗）
//    ④ 点一下 ≠ 拖（块菜单照旧 ✓）-- **现在还没有判据** ✗（`Editor.tsx` 那处注释里也写着 ✓）。
//
// 来由：2026-10-02 owner 裁定「只恢复 ⋮⋮ 手柄与块菜单，**不恢复拖拽**」⇒ `Editor` 挂组件时
//   **不传** `dragEnabled`（插件默认 `false` ✓）⇒ ⭐ 拖了不动 ✓（不是坏了 ✓）。
//   2026-10-12 owner 说「打开」⇒ ⭐ 这一条钉的就是"别再被默默关回去" ✓。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src", "editor");
const editor = readFileSync(join(SRC, "Editor.tsx"), "utf8");
const plugin = readFileSync(join(SRC, "plugins", "BlockDragPlugin.tsx"), "utf8");

describe("块拖拽 · 接线（owner 2026-10-12「打开」）", () => {
  it("① Editor 必须**真的把开关传上去**（⛔ 不是挂在插件默认的 false 上 ✗）", () => {
    expect(editor).toContain("<BlockDragPlugin dragEnabled />");
    // ⛔ 反例：也**不许**再出现"不传参数"的那一版 ✗（那正是 10-02 到 10-12 之间的状态 ✓）
    expect(editor).not.toContain("<BlockDragPlugin />");
  });

  it("② 拖拽的**唯一入口**仍然被这个开关掐着（⛔ 开关不算数 ✗ 就没意义）", () => {
    expect(plugin).toContain("if (!dragEnabled) return;");
    expect(plugin).toContain("dragEnabled = false");
  });

  it("③ 打开拖拽不许把**手柄与块菜单**弄丢（⭐ 它们是 10-02 那次「恢复」的东西 ✓）", () => {
    expect(plugin).toContain("block-handle");
    expect(plugin).toContain("块操作");
  });
});
