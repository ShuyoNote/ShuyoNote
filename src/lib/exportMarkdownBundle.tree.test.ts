// 目录树判据（2026-10-17）—— 纯函数，不起宿主、不碰网络 ✓。
//
// 为什么要这组：在此之前 zip 里是**全平铺** ✗（一堆 `页面.md`），而页面树本来的层级丢了 ✗
// （方案里写的就是 `父页面.md` ＋ `父页面/子页面.md` ✓）。这组只钉**路径形状**与**几个边界**，
// 不碰字节、不碰 zip（那些在 `exportMarkdownBundle.test.ts` 里 ✓）。
import { describe, expect, it } from "vitest";
import { planBundle, treePaths, type PreparedPage } from "./exportMarkdownBundle";

function p(id: string, title: string, parentId: string | null = null): PreparedPage {
  return { id, title, parentId, markdown: `# ${title}`, srcToHash: new Map() };
}

describe("treePaths —— zip 内的目录树（2026-10-17 加）", () => {
  it("① 父/子 ⇒ `父.md` ＋ `父/子.md`（Obsidian folder-note 惯例 ✓）", () => {
    const paths = treePaths([p("a", "父"), p("b", "子", "a")]);
    expect(paths.get("a")).toBe("父.md");
    expect(paths.get("b")).toBe("父/子.md");
  });

  it("② 深两层：A.md ／ A/B.md ／ A/B/C.md", () => {
    const paths = treePaths([p("a", "A"), p("b", "B", "a"), p("c", "C", "b")]);
    expect(paths.get("a")).toBe("A.md");
    expect(paths.get("b")).toBe("A/B.md");
    expect(paths.get("c")).toBe("A/B/C.md");
  });

  it("③ 父不在这一轮清单里（父删了／没选中）⇒ 当顶层，⛔ 不造空目录 ✗", () => {
    const paths = treePaths([p("b", "子", "missing")]);
    expect(paths.get("b")).toBe("子.md");
  });

  it("④ 父链成环 ⇒ 不死循环、两个都当顶层 ✓", () => {
    const paths = treePaths([p("a", "甲", "b"), p("b", "乙", "a")]);
    expect(paths.get("a")).toBe("甲.md");
    expect(paths.get("b")).toBe("乙.md");
  });

  it("⑤ 同名兄弟 ⇒ 后出现的加 `-<id 前 6 位>` ✓（排序＝标题再按 id ⇒ 稳定 ✓）", () => {
    const paths = treePaths([p("bbbbbb", "同名"), p("aaaaaa", "同名")]);
    expect(paths.get("aaaaaa")).toBe("同名.md");
    expect(paths.get("bbbbbb")).toBe("同名-bbbbbb.md");
  });

  it("⑥ 顶层页仍是平的（向后兼容 ✓）", () => {
    const paths = treePaths([p("a", "甲"), p("b", "乙")]);
    expect([...paths.values()].sort()).toEqual(["乙.md", "甲.md"]);
  });

  it("⑦ 转换失败的页不占路径 ✓（它本来就不进 zip）", () => {
    const paths = treePaths([{ ...p("a", "甲"), error: "正文坏了" }]);
    expect(paths.size).toBe(0);
  });
});

describe("planBundle —— zip 条目用树形路径 ✓", () => {
  it("父/子两页 ⇒ files 的 path 是 `父.md` / `父/子.md` ✓", () => {
    const plan = planBundle([p("a", "父"), p("b", "子", "a")]);
    expect(plan.files.map((f) => f.path).sort()).toEqual(["父.md", "父/子.md"]);
  });
});
