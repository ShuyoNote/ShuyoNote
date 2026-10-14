// 启动页版号：**两条纯静态判据**（阶段 3，R204 走乙 ⇒ 启动页那格改成运行时填 ✓）。
//
// ## 它挡的是哪一次真事故（incident ✓）
// `index.html` 的 `.splash-version` 原来**硬编码** `版本 1.92.6（开发）` ✗ —— 而当时桌面号已是
// **1.92.11** ✓ ⇒ ⭐ **启动页显示的是一个错的号** ✗，而且它**不随版本文件走** ✓（改一次版号就漂一次 ✓）。
// 修法：那格留**空占位** ✓ ＋ 由 `src/main.tsx` 在摘掉 splash **之前**用 `APP_VERSION` 填 ✓
//（`src/lib/links.ts:10` ✓ ⇒ 与关于屏／设置页**同一个事实源** ✓，⛔ 不引入第二份 ✗）。
//
// ## ⚠️ 为什么要有第 ② 条（⛔ 只删不填 = 假绿 ✗）
// 第 ① 条只保证"字面量没了" ✗ ⇒ **把填充代码也删掉**照样满足它 ✗，而那格会**永远空着** ✓
// ⇒ 用户看到的是"版本 "后什么都没有 ✓ —— 那**不是**修好 ✓，是换了个错法 ✓ ⇒ 所以必须有第 ② 条 ✓。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const INDEX = readFileSync(resolve(ROOT, "index.html"), "utf8");
const MAIN = readFileSync(resolve(ROOT, "src", "main.tsx"), "utf8");

describe("启动页版号（阶段 3）", () => {
  it("① `index.html` 里不许出现**版号字面量** ✗（它必须由运行时填 ✓）", () => {
    // 判据对准"**显示出来的**那一格"：`>版本 X.Y.Z` —— ⛔ 不去数注释里的历史数字 ✗
    //（那段注释本来就该讲"这里原来写的是 1.92.6"✓ ⇒ 数它会假红 ✓ —— 实测过 ✓）。
    expect(INDEX).not.toMatch(/>\s*版本 \d+\.\d+\.\d+/);
  });

  it("② ⭐ **填充那一行必须在** ✓（`.splash-version` ＋ `APP_VERSION` 同一段里 —— ⛔ 只删不填 ⇒ 红 ✗）", () => {
    expect(MAIN, "`src/main.tsx` 里必须提到 `.splash-version`").toContain(".splash-version");
    expect(MAIN, "`src/main.tsx` 里必须提到 `APP_VERSION`").toContain("APP_VERSION");
    // ⚠️ 还要在**同一段填充代码**里（防"两个词各出现一次但互不相干"✓ —— 那是第二种假绿 ✓）
    // ⚠️ 收紧：光有"两个词挨着"不够 ✗ —— 实测**只删赋值那行**时，`APP_VERSION` 还在 import 里、
    //    `.splash-version` 还在 `querySelector` 里 ⇒ 窗口内两词俱在 ⇒ 旧写法**仍绿** ✗（＝判据有洞 ✓）。
    //    ⇒ 所以要求窗口里**同时**出现 `textContent`（那才是"真的写进去了" ✓）。
    const wrote = /\.splash-version[\s\S]{0,240}textContent[\s\S]{0,240}APP_VERSION|APP_VERSION[\s\S]{0,240}textContent[\s\S]{0,240}\.splash-version/;
    expect(wrote.test(MAIN), "必须看到**把 `.splash-version` 写进去**的那段（`textContent` ＋ `APP_VERSION` ✓）—— ⛔ 只删不填 ⇒ 红 ✗").toBe(true);
  });
});
