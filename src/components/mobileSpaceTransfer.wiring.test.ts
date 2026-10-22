// 判据：移动端「空间」卡必须**真的能落地**，不是画上去的两个按钮。
//
// 来由（owner 2026-10-22）：「web 版的移动版加上空间导入导出功能如何？」
//   ⇒ 能力早就在（`web.ts` 的 export_workspace / import_workspace，与桌面同一个 zip 形态），
//     缺的是移动端入口；而**移动端没有空间切换器**（`MobilePair` / `MobilePairCode` 只按
//     `activeId` 查）⇒ 只"导入成功"的话，新空间在这屏里**永远看不到** ＝ 死路
//     （与"浮「＋」建空页落只读屏"同族，那一次 owner 的原话是"给你一张纸却不给笔"）。
//
// 所以这条判据钉的是**三件事**，缺一件都算没做完：
//   ① 两个入口真的调了那两个函数（不是装饰按钮）；
//   ② 导入**拿到 meta.id 之后**必须 `switchTo`（否则导完看不到）；
//   ③ 导出用的是**当前空间**的名字（导出别的空间是最难查的一类错）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "MobileSettings.tsx"), "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("移动设置 · 空间卡（导出 / 导入）", () => {
  it("① 两个入口都在：exportCurrentSpace / importSpacePackage 真的被调用", () => {
    expect(code, "缺「导出当前空间」的调用").toMatch(/exportCurrentSpace\(/);
    expect(code, "缺「导入空间包」的调用").toMatch(/importSpacePackage\(/);
  });

  it("② 导入成功后必须 switchTo(meta.id) —— 移动端没有切换器，不切就是死路", () => {
    // 断言"拿到返回值"和"用它切换"两件事同时成立
    expect(code, "importSpacePackage 的返回值没接").toMatch(/const\s+meta\s*=\s*await\s+importSpacePackage\(\)/);
    expect(code, "导入后没有 switchTo(meta.id)").toMatch(/switchTo\(\s*meta\.id\s*\)/);
  });

  it("③ 导出用的是**当前空间**的名字（不是写死的串）", () => {
    expect(code, "activeName 应当从 spaces/activeId 算出来").toMatch(/spaces\.find\(/);
    expect(code, "导出当前空间时应当传 activeName").toMatch(/exportCurrentSpace\(\s*activeName\s*\)/);
  });

  it("④ ⛔ 不整店订阅 store（check-store-subscriptions 的规矩）", () => {
    expect(code, "不许 const { … } = useSpaceStore()").not.toMatch(/=\s*useSpaceStore\(\)/);
  });
});
