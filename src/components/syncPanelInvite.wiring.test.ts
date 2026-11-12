// ⭐ U1（2026-11-12）：**邀请式配对**的接线判据（源码级 —— 不起宿主、不碰网络）。
//
// 为什么要有：这一片是"后端四条命令 ＋ 一个新组件"，最容易出的问题是
//   · 组件做了但**没挂进面板**（孤儿组件 —— 本仓有过先例）；
//   · 挂了但**没接 api**（点了没反应 / 调了不存在的命令名）；
//   · 界面把 **nonce / 设备号** 这类内部标识摆出来（`INV-UI-copy-no-internal-ids`）；
//   · 把「免人工核对」误写成"不用核对也行"（丢掉了 D2 的**一次性凭证**这个前提）。
//
// 判据（每条都能被一次"顺手改"打红）：
//   ① 面板里**真的挂了** `InvitePairingSection`，且是**桌面专属**门槛；
//   ② 组件真的调 **api.inviteExport / inviteImport / inviteList / inviteRevoke**，
//      且这四条在 `api.ts` 里都有包装（⛔ 不许字符串硬写命令名绕开类型）；
//   ③ 生成 / 接入 / 撤销三个动作与「10 分钟 / 只能用一次」话术都在；
//   ④ ⛔ 不许把 nonce 摆进可见文本（只许当 key/参数）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
const comp = readFileSync(resolve(__dirname, "InvitePairingSection.tsx"), "utf8");
const api = readFileSync(resolve(__dirname, "..", "lib", "api.ts"), "utf8");

describe("U1 邀请式配对 · 接线", () => {
  it("① 面板挂了组件，并且是桌面专属门槛", () => {
    expect(panel).toContain("InvitePairingSection");
    expect(panel).toMatch(/isDesktopPlatform\(\)\s*&&\s*<InvitePairingSection/);
    // ⛔ 不许挂两处（两处入口互相漂开=两份真相）
    expect(panel.match(/<InvitePairingSection/g)?.length ?? 0).toBe(1);
  });

  it("② 四条命令都有 api 包装，组件走包装而不是硬写命令名", () => {
    for (const fn of ["inviteExport", "inviteImport", "inviteList", "inviteRevoke"]) {
      expect(api).toContain(`${fn}:`);
      expect(comp).toContain(`api.${fn}(`);
    }
    // ⛔ 组件不许自己写 `invoke("...")`（绕过 CommandMap 的类型/契约）
    expect(comp).not.toContain("invoke(");
  });

  it("③ 生成 / 接入 / 撤销与「10 分钟 / 只能用一次」话术都在", () => {
    for (const id of ["invite-generate", "invite-import-submit", "invite-revoke"]) {
      expect(comp).toContain(`data-testid="${id}"`);
    }
    expect(comp).toContain("10 分钟");
    expect(comp).toContain("只能用一次");
    // D1=A：如实告诉用户"加密空间的主口令仍要输一次"
    expect(comp).toContain("主口令");
  });

  it("④ ⛔ 界面不显示 nonce / 设备号这类内部标识", () => {
    // `key={r.nonce}` 是 React 的 key（不渲染成文字）⇒ 先摘掉它，再判"有没有进可见文本"
    const visible = comp.replace(/key=\{r\.nonce\}/g, "");
    expect(visible).not.toMatch(/\{[a-zA-Z]*\.nonce\}/);
    expect(comp).not.toMatch(/device_id/);
  });
});
