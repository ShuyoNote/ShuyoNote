// 外部跳转总闸的**纯决策**判据（不碰平台、不弹提示 —— 那是 `openExternal.ts` 的事）。
//
// 为什么值得单测：这个开关以前只被「关于」对话框查过一次，其余 5 处照样能把人送出去
// （"总闸"名不副实）；现在判定收进 `decideExternalOpen` 一处，判据要钉住三件：
//   ① 关着时**拿不到 url**（不是"拿到了但调用方装作没看见"）；
//   ② 非 http(s) 一律不安全（`javascript:` / `file:` / 相对路径）；
//   ③ 被拦下时有话说（不许静默无反应）。
import { describe, expect, it } from "vitest";
import { decideExternalOpen, externalOpenNotice, getAllowExternal, setAllowExternal, linkItems } from "./links";

describe("外部跳转总闸（纯决策）", () => {
  const ok = "https://gitcode.com/shuyo-cn/ShuyoNote";

  it("开着 ⇒ 放行，且 url 原样（已过 http(s) 白名单）", () => {
    const d = decideExternalOpen(ok, true);
    expect(d).toEqual({ kind: "open", url: ok });
  });

  it("关着 ⇒ blocked，且**拿不到 url**（调用方无从绕过）", () => {
    const d = decideExternalOpen(ok, false);
    expect(d.kind).toBe("blocked");
    expect("url" in d).toBe(false);
  });

  it("非 http(s) 一律 unsafe：javascript: / file: / data: / 相对路径", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "/etc/passwd", "ftp://x/y", ""]) {
      expect(decideExternalOpen(bad, true).kind, bad).toBe("unsafe");
    }
  });

  it("不安全优先于开关：关着 + javascript: 仍是 unsafe（不谎报成 blocked）", () => {
    expect(decideExternalOpen("javascript:alert(1)", false).kind).toBe("unsafe");
  });

  it("被拦下时有话说，且说清是设置拦的、怎么开", () => {
    const blocked = externalOpenNotice({ kind: "blocked" });
    expect(blocked).toContain("允许跳转到外部项目网站");
    expect(blocked.length).toBeGreaterThan(10);
    expect(externalOpenNotice({ kind: "unsafe" }).length).toBeGreaterThan(0);
  });

  it("默认开：localStorage 里没有那个键 ⇒ true；写 false ⇒ false", () => {
    localStorage.removeItem("shuyonote-allow-external");
    expect(getAllowExternal()).toBe(true);
    setAllowExternal(false);
    expect(getAllowExternal()).toBe(false);
    setAllowExternal(true);
    expect(getAllowExternal()).toBe(true);
    localStorage.removeItem("shuyonote-allow-external");
  });

  it("四个外链本身不带跟踪参数（与开关无关的那句真话）", () => {
    const links = linkItems();
    expect(links).toHaveLength(4);
    for (const l of links) {
      expect(l.url).toMatch(/^https:\/\//);
      expect(l.url).not.toMatch(/[?&](utm_|ref=|gclid|fbclid)/);
    }
  });
});
