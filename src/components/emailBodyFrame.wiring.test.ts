// 判据：邮件正文必须走**沙箱 iframe**（允许 <style>，但**不许** allow-scripts），且图片拦截不变。
//
// 来由（owner 2026-10-21）：「邮件的内容渲染为何这么丑？」
//   真因：为了安全把 `<style>` 整块禁掉 ⇒ 邮件（尤其通知类，靠自带 style + 表格排版）样式全丢。
//   修法：放进 iframe（样式作用域锁在 iframe 内）⇒ 可以允许 `<style>`；脚本靠 sandbox 挡住。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "EmailPanel.tsx"), "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("邮件正文：沙箱 iframe 渲染", () => {
  it("① 正文走 iframe（不再 dangerouslySetInnerHTML）", () => {
    expect(code, "应当有 EmailBodyFrame").toContain("function EmailBodyFrame");
    expect(code, "正文应当用 <EmailBodyFrame").toContain("<EmailBodyFrame");
    // ⛔ 正文那一路不许再直接把 HTML 塞进 DOM
    expect(code).not.toMatch(/email-rich-body[^>]*dangerouslySetInnerHTML/);
  });

  it("② sandbox 必须只给 allow-same-origin（⛔ 不给 allow-scripts）", () => {
    expect(code, "sandbox 里应当有 allow-same-origin").toMatch(/sandbox="allow-same-origin"/);
    // ⛔ 关键：一旦给了 allow-scripts，邮件里的 JS 就能跑（与 US 的消毒结论相反）
    expect(code, "⛔ 不许 allow-scripts").not.toMatch(/sandbox="[^"]*allow-scripts/);
  });

  it("③ 消毒规则允许 <style>（它现在只在 iframe 内生效）", () => {
    const forbid = code.match(/FORBID_TAGS:\s*\[[^\]]*\]/s)?.[0] ?? "";
    expect(forbid, "FORBID_TAGS 里不该再有 style").not.toMatch(/"style"/);
    // 但脚本类必须还禁着
    for (const tag of ['"script"', '"iframe"', '"object"', '"embed"']) {
      expect(forbid, `FORBID_TAGS 必须仍含 ${tag}`).toContain(tag);
    }
  });

  it("④ 图片拦截不变（默认 data-src，点「显示图片」才换回 src）", () => {
    expect(code, "应当保留 data-src 占位逻辑").toContain("data-src");
    expect(code, "应当保留「显示图片」入口").toContain("显示图片");
  });

  it("⑤ 表格布局：尊重邮件原宽（⛔ 不再 table max-width:100%），列对齐与横滚都在", () => {
    // 2026-10-29 事故：通知类邮件是老式 table + 固定宽；给 table 压 max-width:100% 会让列塌成 1 字
    // （GitHub 通知邮件里的 `Status` 被挤成竖排）。判据钉三件：
    expect(code, "⛔ 不许再给 table 加 max-width:100%（会把列压塌）").not.toMatch(/table\s*\{[^}]*max-width\s*:\s*100%/);
    expect(code, "单元格顶部对齐（列不被拉歪）").toContain("td, th { vertical-align: top; }");
    expect(code, "宽邮件允许横向滚动，而不是压扁").toContain("overflow-x: auto");
    // ⭐ 2026-10-29 第二版：上一版（撤 table max-width）**没治住** GitHub 邮件的竖排 `Status`。
    //   真因是 `body{word-break:break-word}` 被 th 继承 + 表头列只有十几像素宽 ⇒ 逐字符断行。
    expect(code, "表头必须 nowrap（否则单字竖排）").toMatch(/th\s*\{[^}]*white-space:\s*nowrap/);
    expect(code, "表头必须 word-break: normal（⛔ 别再逐字符断）").toMatch(/th\s*\{[^}]*word-break:\s*normal/);
  });
});
