// 目录树判据（2026-10-17）—— 纯函数，不起宿主、不碰网络 ✓。
//
// 为什么要这组：在此之前 zip 里是**全平铺** ✗（一堆 `页面.md`），而页面树本来的层级丢了 ✗
// （方案里写的就是 `父页面.md` ＋ `父页面/子页面.md` ✓）。这组只钉**路径形状**与**几个边界**，
// 不碰字节、不碰 zip（那些在 `exportMarkdownBundle.test.ts` 里 ✓）。
import { describe, expect, it } from "vitest";
import { exportPageBundleToZip, planBundle, treePaths, type PreparedPage } from "./exportMarkdownBundle";

function p(id: string, title: string, parentId: string | null = null, kind?: string): PreparedPage {
  return { id, title, parentId, kind, markdown: `# ${title}`, srcToHash: new Map() };
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

// ⭐ 2026-10-18（owner 报的缺口：空间导出后**目录节点自己变成了一个空 .md**，子页反而看不出层级）：
//   文件夹节点 ＝ **一层目录**，自己不出文件；数据库节点照旧出 `.md`（它有正文）。
describe("文件夹节点（kind === \"folder\"）—— 只作目录，不出 .md", () => {
  it("① 文件夹不出自己的 `.md`；子页落在 `文件夹/子.md` ✓", () => {
    const paths = treePaths([p("f", "资料", null, "folder"), p("c", "子", "f")]);
    expect(paths.has("f")).toBe(false);
    expect(paths.get("c")).toBe("资料/子.md");
  });

  it("② zip 里也没有文件夹那一条（不会出现 `资料.md`）", () => {
    const plan = planBundle([p("f", "资料", null, "folder"), p("c", "子", "f"), p("x", "别页")]);
    expect(plan.files.map((f) => f.path).sort()).toEqual(["资料/子.md", "别页.md"].sort());
    expect(plan.files.some((f) => f.path === "资料.md")).toBe(false);
  });

  it("③ 嵌套文件夹：两个文件夹都不出 `.md`，子页在 `A/B/子.md` ✓", () => {
    const paths = treePaths([
      p("a", "A", null, "folder"),
      p("b", "B", "a", "folder"),
      p("c", "子", "b"),
    ]);
    expect(paths.has("a")).toBe(false);
    expect(paths.has("b")).toBe(false);
    expect(paths.get("c")).toBe("A/B/子.md");
  });

  it("④ 数据库节点（`kind === \"database\"`）照旧出 `.md` ✓（它有正文，不是目录）", () => {
    const paths = treePaths([p("db", "表格", null, "database"), p("c", "子", "db")]);
    expect(paths.get("db")).toBe("表格.md");
    expect(paths.get("c")).toBe("表格/子.md");
  });

  it("⑤ 没有 `kind` 的根级普通页向后兼容 ✓（仍是平铺 `标题.md`）", () => {
    const paths = treePaths([p("a", "甲"), p("b", "乙")]);
    expect([...paths.values()].sort()).toEqual(["乙.md", "甲.md"]);
  });

  it("⑥ 单页导出拿到文件夹 ⇒ 一个字节都不写、也不报成功 ✗", async () => {
    const msg = await exportPageBundleToZip({ id: "f", title: "资料", docJson: "{}", kind: "folder" });
    expect(msg).toContain("文件夹");
    expect(msg).not.toContain("已导出");
  });
});
