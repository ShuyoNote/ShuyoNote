// ⭐ 2026-10-11（owner：「把功能加到…新建页面的『从文件导入』」）：
//    「从文件导入」那条对话框必须**也吃 .docx** ✓，而且必须**复用** Office 那条现成的链 ✓。
//
// ⚠️ 为什么做成**源码形态**判据（不是渲染判据 ✗）：
//    · 这一条要钉的是"**接线**"（认识 .docx ＋ 复用哪条路 ✓），⛔ 不是像素；
//    · 仓里已有同形先例（`src/lib/spaceFilter.test.ts` 读组件源码 ✓）；
//    · ⭐ 而**真正的端到端**（选一个 .docx ⇒ 真建出一页）要真宿主 ＋ 真文件对话框 ⇒
//      ⭐ 那一条在 CI 上跑不了 ✓（⭐ 如实记在这里：⭐ 本判据**不**代替它 ✓）。
//
// ⛔ 反面：如果谁在对话框里**自己再实现一遍** docx 解析/落库 ⇒ ⭐ 这条判据**不会**红 ✗
//    （它只钉"必须出现复用调用"✓）—— ⭐ 那类第二份真相源由 `check-derived-writers` 等仓门禁管 ✓。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 必须 `fileURLToPath`：vitest 里 `import.meta.url` 是 **http** 协议，
//    直接丢给 `readFileSync` 会 TypeError（本仓栽过：The URL must be of scheme file ✓）。
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(resolve(HERE, ...parts), "utf8");

describe("「从文件导入」也吃 Word（.docx）", () => {
  it("a) 文件选择器放开了 .docx，并把它路由到 Office 那条**现成**的链", () => {
    const src = read("MarkdownImportDialog.tsx");
    expect(src, "文件选择器没放开 .docx ⇒ 用户根本选不到 Word 文件").toMatch(/docx/i);
    expect(
      src,
      "没有调用 importOfficeFromPath ⇒ 要么没接上，要么自己实现了一遍转换（第二份真相源）",
    ).toContain("importOfficeFromPath");
    expect(src, "没接真依赖（realOfficePathDeps）⇒ 这条路落不了盘").toContain("realOfficePathDeps");
  });

  it("b) Markdown 那条老路**没被动过**（⛔ 不许顺手改掉替换当前页的行为）", () => {
    const src = read("MarkdownImportDialog.tsx");
    expect(src, "老的读文本那条路没了").toContain("readTextFile");
    expect(src, "老路的『灌进当前页』没影了").toContain("$convertFromMarkdownString");
  });

  // ⭐ 2026-10-11（owner：「在 word 文档的右键菜单里面才有转成笔记」）：⭐ 这一项在**文件行**菜单上 ✓。
  //    ⚠️ 四条缺一不可：⭐ ① 菜单里真有它 ② ⭐ 走**共用**入口（⛔ 不自己写一份解析/落库 ✗）
  //       ③ ⭐ **只有 Word 才有**（⭐ 别的文件根本转不成 ✓）④ ⭐ 转成后刷新页面树 ✓。
  it("c) Word 附件的右键菜单有「转成笔记」，别的文件没有；且走共用入口、转完刷新树", () => {
    const src = read("PageTree.tsx");
    expect(src, "文件行菜单里没有那一项").toContain("转成笔记");
    expect(src, "没接共用入口（importOfficeAttachmentAsPage）⇒ 多半自己写了一份").toContain(
      "importOfficeAttachmentAsPage",
    );
    expect(src, "不是「只有 Word 才有」⇒ 别的文件也会看到一项转不成的").toMatch(/docx\|docm/);
    expect(src, "转成后不刷新页面树 ⇒ 用户会以为没转成").toContain("loadPages");
  });
});
