// 判据：移动「快速记录」的图片按钮必须**真开系统选择器**，且插的是"真图"（不是一对空括号）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "MobileCapture.tsx"), "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("快速记录：图片按钮", () => {
  it("① 有隐藏的系统选择器（accept=image/*）", () => {
    expect(code, "应当有 file input").toMatch(/type="file"/);
    expect(code, "只收图片").toMatch(/accept="image\/\*"/);
    expect(code, "应当绑到 ref 以便按钮触发").toContain("fileRef");
  });

  it("② 点「图片」= 打开选择器（⛔ 不再插一对空括号）", () => {
    // 旧实现是 BAR 里 insert: "![]()" ⇒ 存进去就是坏图
    const barLine = (SRC.match(/\{ id: "img"[^\n]*\n/)?.[0] ?? "").trim();
    expect(barLine, "BAR 里 img 不该再带 insert 空括号").not.toContain("![]()");
    expect(code, "img 分支应当 click 选择器").toMatch(/b\.id === "img"[\s\S]{0,120}fileRef\.current\?\.click\(\)/);
  });

  it("③ 选中后存附件并插入真图（api.saveImage ＋ convertFileSrc）", () => {
    expect(code).toContain("api.saveImage");
    expect(code, "URL 必须走平台转换（⛔ 不自己拼路径）").toContain("platform.asset.convertFileSrc");
    expect(code, "插入的应当是 ![name](url)").toMatch(/insert\(\s*`!\[/);
  });

  it("④ 失败如实说（不吞错）", () => {
    expect(code).toContain("插图失败");
  });
});
