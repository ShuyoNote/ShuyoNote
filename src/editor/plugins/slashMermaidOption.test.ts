import { describe, expect, it } from "vitest";
import { makeOptions } from "./SlashMenuPlugin";

// ⭐ **R161 判据**：插入块菜单里必须有「Mermaid 图块」这一项 ✓。
//   现场（owner 2026-10-08）：「插入块添加 Mermaid图块 类型」—— 而当时 `makeOptions` 的 24 个 key
//   里**没有** mermaid ✗，分组表里却写着 `mermaid: "常用"` ✓（死条目）⇒ 用户当然看不到 ✓。
describe("R161：插入块菜单里的 Mermaid 图块", () => {
  it("★ 清单里有 key=mermaid 这一项，且标题是「Mermaid 图块」✓", () => {
    const opts = makeOptions("page-x");
    const m = opts.find((o) => o.key === "mermaid");
    expect(m, "makeOptions 里必须有 key=mermaid 的项 ✗（否则分组表那条 mermaid 是死条目 ✓）").toBeTruthy();
    expect(m!.title).toBe("Mermaid 图块");
    expect(m!.badge, "要有个图标位 ✓").toBeTruthy();
  });

  it("★ 它是个**可插入**的项（有 run ✓），且插的是 mermaid 语言（不是 javascript ✗）", () => {
    const m = makeOptions("page-x").find((o) => o.key === "mermaid");
    expect(typeof m!.run, "必须有 run（点了要真的插块 ✓）").toBe("function");
    // 源码里那一项必须传 "mermaid" 作为语言 ✓（⛔ 不是 javascript ✗ —— 那样就只是代码块 ✓）
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "SlashMenuPlugin.tsx"), "utf8");
    const seg = src.slice(src.indexOf('key: "mermaid"'));
    expect(seg.slice(0, 1200), "mermaid 那一项要用 $createSafeCodeNode(\"mermaid\") ✓").toContain('$createSafeCodeNode("mermaid")');
  });
});
