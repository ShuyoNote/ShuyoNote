// 隐私边界 ②b · **「空间隐私」那一节**的判据（happy-dom；api 与平台判定都打桩）。
//
// 钉住八件事：
//   ① **未分类**的空间照样显示，并把「闸门没管到它」**说出来**（不许沉默放行，也不许显示成个人空间）；
//   ② 个人空间没加密 ⇒ 显示后端那句**可操作**的原因（**原样**，不在界面侧重写一遍）；
//   ③ 团队空间 ⇒ 说明可以绑同步；
//   ④ 改分类 ⇒ 真的调 `setSpaceKind(id, kind)` 并**重读**一次；
//   ⑤ 「关闭加密」是**两步确认**：第一下**不调** api，第二下才调（这是会把库换回明文的动作）；
//   ⑥ Web（`isDesktopPlatform() === false`）⇒ 只渲染解释句，**一次 api 都不调**；
//   ⑦ 主口令填了就**原样传给后端**（不传口令时给 `undefined`）；
//   ⑧ 接线：`SyncPanel.tsx` 里真的挂了这一节（文本级判据 —— 防它变成没人用的孤儿组件）；
//   ⑨ ③ 0b：「推到服务器」真调 `pushSpaceKeyring(id)`，并把后端那句话**原样**显示；
//   ⑩ ③ 0b：「从服务器取回」**默认不许覆盖**（`overwrite=false`），勾了「允许覆盖」才传 `true`。
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 平台判定要在**模块被求值之前**就绪 ⇒ `vi.hoisted`（工厂会在 import 之前跑）
const flags = vi.hoisted(() => ({ desktop: true }));

const spaceSecurityOverview = vi.fn();
const setSpaceKind = vi.fn();
const enableSpaceEncryption = vi.fn();
const disableSpaceEncryption = vi.fn();
const pushSpaceKeyring = vi.fn();
const pullSpaceKeyring = vi.fn();
const migrateLegacySpaceEncryption = vi.fn();
const rotateLegacySpaceEncryption = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    spaceSecurityOverview: (...a: unknown[]) => spaceSecurityOverview(...a),
    setSpaceKind: (...a: unknown[]) => setSpaceKind(...a),
    enableSpaceEncryption: (...a: unknown[]) => enableSpaceEncryption(...a),
    disableSpaceEncryption: (...a: unknown[]) => disableSpaceEncryption(...a),
    pushSpaceKeyring: (...a: unknown[]) => pushSpaceKeyring(...a),
    pullSpaceKeyring: (...a: unknown[]) => pullSpaceKeyring(...a),
    migrateLegacySpaceEncryption: (...a: unknown[]) => migrateLegacySpaceEncryption(...a),
    rotateLegacySpaceEncryption: (...a: unknown[]) => rotateLegacySpaceEncryption(...a),
  },
}));

vi.mock("../lib/platform", () => ({
  isDesktopPlatform: () => flags.desktop,
}));

import type { SpaceSecurityView } from "../lib/api";
import { SpacePrivacySection } from "./SpacePrivacySection";

const personal: SpaceSecurityView = {
  space_id: "default",
  kind: "personal",
  encrypted_on_disk: false,
  in_keyring: false,
  key_available: false,
  gate: {
    allow: false,
    unclassified: false,
    reason: "空间「default」是个人空间但还没有加密：先给它设一句口令（按空间加密），再绑定同步",
  },
};

const team: SpaceSecurityView = {
  space_id: "team-a",
  kind: "team",
  encrypted_on_disk: false,
  in_keyring: false,
  key_available: false,
  gate: { allow: true, unclassified: false, reason: "" },
};

const unclassified: SpaceSecurityView = {
  space_id: "old-b",
  kind: "",
  encrypted_on_disk: false,
  in_keyring: false,
  key_available: false,
  gate: { allow: true, unclassified: true, reason: "这个空间还没分类（个人/团队）：同步闸门这次没有管到它" },
};

const encrypted: SpaceSecurityView = {
  space_id: "default",
  kind: "personal",
  encrypted_on_disk: true,
  in_keyring: true,
  key_available: true,
  gate: { allow: true, unclassified: false, reason: "" },
};

/** 用**原生 setter** 写值再派事件：直接赋 `input.value` 会被 React 的值追踪吞掉。 */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("SpacePrivacySection（空间隐私：这个空间敢不敢绑同步）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    flags.desktop = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const m of [
      spaceSecurityOverview,
      setSpaceKind,
      enableSpaceEncryption,
      disableSpaceEncryption,
      pushSpaceKeyring,
      pullSpaceKeyring,
      migrateLegacySpaceEncryption,
      rotateLegacySpaceEncryption,
    ])
      m.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () => {
      root.render(createElement(SpacePrivacySection));
    });
  };
  const rows = () => Array.from(container.querySelectorAll(".space-privacy-row"));
  const buttons = () => Array.from(container.querySelectorAll("button"));
  const selects = () => Array.from(container.querySelectorAll("select"));

  it("① ★ 未分类的空间**照样显示**，并把「闸门没管到它」说出来（不沉默、不显示成个人空间）", async () => {
    spaceSecurityOverview.mockResolvedValue([unclassified]);
    await render();
    expect(rows()).toHaveLength(1);
    // ⚠️ 只断言**那一枚徽标**：`row.textContent` 里还含着下拉框的选项文案（「个人空间（…）」），
    //    拿整行去 `not.toContain("个人空间")` 会误伤。
    expect(rows()[0].querySelector(".space-privacy-kind")!.textContent).toBe("未分类");
    expect(rows()[0].textContent).toContain("没管到");
  });

  it("② 个人空间没加密 ⇒ 显示后端那句可操作的原因（原样，不重写）", async () => {
    spaceSecurityOverview.mockResolvedValue([personal]);
    await render();
    expect(container.textContent).toContain("个人空间");
    expect(container.textContent).toContain(personal.gate.reason);
    expect(container.textContent).toContain("明文");
  });

  it("③ 团队空间 ⇒ 说明可以绑同步（免检）", async () => {
    spaceSecurityOverview.mockResolvedValue([team]);
    await render();
    expect(container.textContent).toContain("团队空间");
    expect(container.textContent).toContain("可以绑同步");
  });

  it("④ ★ 改分类 ⇒ 真的调 `setSpaceKind(id, kind)`，并**重读**一次", async () => {
    spaceSecurityOverview.mockResolvedValue([team]);
    setSpaceKind.mockResolvedValue(null);
    await render();
    const before = spaceSecurityOverview.mock.calls.length;

    await act(async () => {
      setValue(selects()[0], "personal");
    });

    expect(setSpaceKind).toHaveBeenCalledWith("team-a", "personal");
    expect(spaceSecurityOverview.mock.calls.length).toBe(before + 1);
  });

  it("⑤ ★ 「关闭加密」是两步：第一下**不调** api，第二下才调（会把库换回明文）", async () => {
    spaceSecurityOverview.mockResolvedValue([encrypted]);
    disableSpaceEncryption.mockResolvedValue(null);
    await render();

    await act(async () => {
      buttons()[0].click();
    });
    expect(disableSpaceEncryption).not.toHaveBeenCalled(); // 第一下只是确认，不许真的动库
    expect(container.textContent).toContain("再点一次");

    await act(async () => {
      buttons()[0].click();
    });
    expect(disableSpaceEncryption).toHaveBeenCalledWith("default");
  });

  it("⑥ Web ⇒ 只渲染解释句，**一次 api 都不调**", async () => {
    flags.desktop = false;
    await render();
    // Web 上没有这条命令（调了就是 command not found）
    expect(spaceSecurityOverview).not.toHaveBeenCalled();
    expect(disableSpaceEncryption).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Web 版没有钥匙柜");
    expect(rows()).toHaveLength(0);
  });

  it("⑦ 主口令：填了就**原样**传给后端（不填则传 undefined）", async () => {
    spaceSecurityOverview.mockResolvedValue([personal]);
    enableSpaceEncryption.mockResolvedValue([]);
    await render();

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      setValue(input, "我家猫叫mimi");
    });
    await act(async () => {
      buttons()[0].click();
    });

    expect(enableSpaceEncryption).toHaveBeenCalledWith("default", "我家猫叫mimi");
  });

  it("⑪ ★ 「把旧钥匙迁进钥匙袋」⇒ 真调 `migrateLegacySpaceEncryption(id)`（不动库文件那条）", async () => {
    spaceSecurityOverview.mockResolvedValue([personal]);
    migrateLegacySpaceEncryption.mockResolvedValue(true);
    await render();
    const migrate = buttons().find((b) => b.textContent === "把旧钥匙迁进钥匙袋")!;
    await act(async () => {
      migrate.click();
    });
    expect(migrateLegacySpaceEncryption).toHaveBeenCalledWith("default");
    expect(container.textContent).toContain("已完成");
  });

  it("⑫ ★ 「换成真随机钥匙」也是**两步**（它会重写库）：第一下不调、第二下才调", async () => {
    spaceSecurityOverview.mockResolvedValue([personal]);
    rotateLegacySpaceEncryption.mockResolvedValue(null);
    await render();
    // ⚠️ 按文字找，不按下标：这一行里前面还有「开启加密 / 迁进钥匙袋」两个按钮
    const rotateBtn = () =>
      buttons().find(
        (b) => b.textContent === "换成真随机钥匙" || b.textContent === "确认：换成随机钥匙",
      )!;
    await act(async () => {
      rotateBtn().click();
    });
    expect(rotateLegacySpaceEncryption).not.toHaveBeenCalled();
    expect(container.textContent).toContain("再点一次");
    await act(async () => {
      rotateBtn().click();
    });
    expect(rotateLegacySpaceEncryption).toHaveBeenCalledWith("default");
  });

  it("⑨ ★ 「推到服务器」⇒ 真调 `pushSpaceKeyring(id)`，并把后端那句话**原样**显示", async () => {
    spaceSecurityOverview.mockResolvedValue([personal]);
    pushSpaceKeyring.mockResolvedValue({
      outcome: "ok",
      bytes: 812,
      status: 200,
      message: "已把这一份公开材料（812 字节）交给同步服务；第二台设备从此只凭主口令就能解开",
    });
    await render();
    const push = buttons().find((b) => b.textContent === "推到服务器")!;
    await act(async () => {
      push.click();
    });
    expect(pushSpaceKeyring).toHaveBeenCalledWith("default");
    expect(container.textContent).toContain("已把这一份公开材料（812 字节）交给同步服务");
  });

  it("⑩ ★ 「从服务器取回」默认**不许覆盖**（false）；勾了「允许覆盖」才传 true", async () => {
    spaceSecurityOverview.mockResolvedValue([personal]);
    pullSpaceKeyring.mockResolvedValue({
      outcome: "already_local",
      bytes: 0,
      status: 0,
      message: "本机已经有这一份公开材料了，所以**没有动它**；确实要用服务端那一份覆盖，请显式选「覆盖本机」",
    });
    await render();
    const pull = () => buttons().find((b) => b.textContent === "从服务器取回")!;

    await act(async () => {
      pull().click();
    });
    expect(pullSpaceKeyring).toHaveBeenLastCalledWith("default", false);
    expect(container.textContent).toContain("没有动它");

    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      box.click(); // 勾上「允许覆盖本机已有的材料」（React 的 checkbox onChange 走 click）
    });
    await act(async () => {
      pull().click();
    });
    expect(pullSpaceKeyring).toHaveBeenLastCalledWith("default", true);
  });

  it("⑧ 接线：SyncPanel 里真的挂了这一节（防孤儿组件）", () => {
    const panel = readFileSync("src/components/SyncPanel.tsx", "utf8");
    expect(panel, "SyncPanel 里没有挂 SpacePrivacySection ⇒ 用户在同步面板里看不到").toContain(
      "<SpacePrivacySection",
    );
  });
});
