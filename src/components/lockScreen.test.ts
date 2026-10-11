// 锁定屏的两半：**能解锁**，以及**忘了口令的人有没有出路**。
//
// E2 的原话是「解锁/锁定 UX + 忘记口令提醒」。前半好测（输对了就解锁），后半才是重点：
// 这块屏是用户唯一能看到的"门口"，如果它只给一个输入框，忘记口令的人就只剩反复试错；
// 而如果它给的是安慰话（"可能可以找回"），那是更坏的事——用户会以为还有后路。
// 所以这里钉三件：
//   1. 输错：报错、清空、重新聚焦，并记下连错次数；
//   2. 连错 3 次：自动摊开「忘记口令？」，且说明里必须有**真话**（服务器那份也打不开、
//      唯一可能是加密前的明文备份）；
//   3. 输对：调到已解锁状态（由状态中枢 publish，不靠回调）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { __resetVaultForTests, vaultState } from "../lib/vault";

const mocks = vi.hoisted(() => ({
  unlockEncryption: vi.fn<(p: string) => Promise<void>>(),
  encryptionStatus: vi.fn(async () => ({ enabled: true, locked: true })),
}));

vi.mock("../lib/api", () => ({
  api: {
    unlockEncryption: mocks.unlockEncryption,
    encryptionStatus: mocks.encryptionStatus,
  },
}));

const { LockScreen } = await import("./LockScreen");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  __resetVaultForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root.render(React.createElement(LockScreen)));
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function input(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(".lock-input");
  if (!el) throw new Error("锁定屏里没有口令输入框");
  return el;
}

function button(text: string): HTMLButtonElement {
  const el = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`锁定屏里没有「${text}」按钮`);
  return el as HTMLButtonElement;
}

function type(value: string) {
  const el = input();
  // 直接 `el.value = x` 会被 React 的 value tracker 吃掉：它把这次赋值当成"没变化"，
  // onChange 根本不会触发（仓库里别的用例也踩过，见 communitySaveDialog.test.ts）。
  // 走原生 setter 才能让 React 看见这次输入。
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(value: string) {
  await act(async () => {
    type(value);
    button("解锁").click();
    await Promise.resolve();
  });
}

// React 的更新要跑完一轮再断言（跟 vaultGate.test.ts 同一套做法）。
async function act(fn: () => Promise<void> | void) {
  const { act: reactAct } = await import("react");
  await reactAct(async () => {
    await fn();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("锁定屏", () => {
  it("默认只给一件事做：输入口令解锁（说明里点明口令即密钥）", () => {
    expect(host.querySelector(".lock-title")?.textContent).toContain("已加密锁定");
    expect(input().type, "口令默认必须遮起来").toBe("password");
    expect(button("解锁").disabled, "空口令时不该能点").toBe(true);
    // 没连错之前不摊开长篇说明：那是"忘了"的人需要的，不是所有人需要的。
    expect(host.querySelector(".lock-forgot-overlay")).toBeNull();
    expect(button("忘记口令？")).not.toBeNull();
  });

  it("「显示」按钮能把口令露出来（先看清自己打了什么，再谈记不记得）", async () => {
    await act(() => button("显示").click());
    expect(input().type).toBe("text");
    await act(() => button("隐藏").click());
    expect(input().type).toBe("password");
  });

  it("输错：报错留在屏上、输入被清空、焦点回到输入框、不再尝试解锁", async () => {
    // ★ 用**当前**的内核文案（2026-10-10 起：用户面只剩**一句人话** ⇒ 不再是三层套娃、也不带术语 ✓；
    //   原文只进日志 ✓ —— 内核那句的形状由 `space_crypto::tests::a_wrong_master_gives_one_human_sentence_without_jargon` 钉 ✓）。
    mocks.unlockEncryption.mockRejectedValue(new Error("打不开：口令不对，或者这把锁被改过 —— 内容没有被解开"));

    await submit("错误口令");

    const err = host.querySelector(".lock-error");
    expect(err?.textContent, "错误要看得见").toContain("打不开");
    expect(err?.getAttribute("role"), "错误要能被读屏软件念出来").toBe("alert");
    expect(input().value, "错误的输入不该留在框里").toBe("");
    expect(document.activeElement, "焦点要回到输入框").toBe(input());
    // 状态层面"失败不改状态"由 vaultGate.test.ts 钉（那边有完整的 before/after）；
    // 这里只钉屏上的事实：还在锁定屏上，没有跑掉。
    expect(host.querySelector(".lock-screen")).not.toBeNull();
    expect(mocks.unlockEncryption).toHaveBeenCalledWith("错误口令");
  });

  it("连错 3 次：自动摊开「忘记口令？」，并说真话（服务器那份也打不开 / 唯一出路是加密前的备份）", async () => {
    mocks.unlockEncryption.mockRejectedValue(new Error("打不开：口令不对，或者这把锁被改过 —— 内容没有被解开"));
    await submit("错1");
    expect(host.querySelector(".lock-forgot-overlay"), "错 1 次还不该展开").toBeNull();
    await submit("错2");
    expect(host.querySelector(".lock-forgot-overlay"), "错 2 次还不该展开").toBeNull();

    await submit("错3");

    const forgot = host.querySelector(".lock-forgot-overlay");
    expect(forgot, "错到第 3 次就该主动把出路摊开").not.toBeNull();
    const text = forgot!.textContent ?? "";
    expect(text, "要明说没有找回流程/没有后门").toContain("没有找回流程");
    expect(text, "要说清连服务器那份也打不开（同步走的就是这把钥匙）").toContain("同一把钥匙");
    expect(text, "要指出唯一可能的救法").toContain("开启加密之前导出的备份");
    expect(text, "没有备份时不要把话说软").toContain("永久");
    expect(host.querySelector(".lock-error-count")?.textContent).toContain("3");
  });

  it("自己点「忘记口令？」也能随时看到那段说明，并且能收起", async () => {
    await act(() => button("忘记口令？").click());
    expect(host.querySelector(".lock-forgot-overlay")).not.toBeNull();
    await act(() => button("收起").click());
    expect(host.querySelector(".lock-forgot-overlay")).toBeNull();
  });

  it("文案精简后 ⭐ 要点一个都不许丢（不可逆那半必须**原意**保留）", async () => {
    await act(() => button("忘记口令？").click());
    const text = host.querySelector(".lock-forgot-overlay")?.textContent ?? "";

    // ③ 导语的口径
    expect(text, "要说清口令只由用户自己保管").toContain("口令只由你保管");
    // ⑤ 脚注两条
    expect(text, "要说清输错不会被锁死").toContain("输错多少次都不会被锁死");
    expect(text, "要说清慢是密钥派生的代价").toContain("每次慢是密钥派生");
    expect(text, "「不是卡住了」这半不许丢").toContain("不是卡住了");
    // ⭐ (c) 整段里**唯一**说"不可逆"的地方 ⇒ 原意必须留着（不只是"永久"两个字）
    expect(text, "⭐ 不可逆这半必须原意保留").toContain("永久取不回来了");
    // ① 顶部压成一句，但要点还在
    expect(host.querySelector(".lock-desc")?.textContent, "顶部要点不许丢").toContain("输入口令后才会加载");
  });

  it("输对：状态变成已解锁（界面切换由状态中枢驱动）", async () => {
    mocks.unlockEncryption.mockResolvedValue(undefined);

    await submit("正确口令");

    expect(vaultState().locked).toBe(false);
    expect(vaultState().enabled).toBe(true);
    expect(host.querySelector(".lock-error")).toBeNull();
  });
});

// ⭐ 2026-10-10（owner）：「忘记口令」那段改成**弹窗**（模态 ✓），要求**点背景可关** ✓。
// ⚠️ 这条的必要反面：⛔ **点弹窗里面不许关** ✗（冒泡那个坑 ✓）—— 判据 e) 专钉它 ✓。
// ⚠️ 文案**一个字节都不动** ✓（那几段刚按 owner 拍的 C 精简过 ⇒ 本轮**只动形态** ✓）。
const OVERLAY = ".lock-forgot-overlay";
const MODAL = ".lock-forgot-modal";

describe("「忘记口令」是弹窗：点背景关 ／ Esc 关 ／ × 关 ／ ⛔ 点里面不关", () => {
  async function openModal() {
    await act(() => button("忘记口令？").click());
  }
  const overlay = () => host.querySelector(OVERLAY);

  it("a) 点「忘记口令？」⇒ **浮层**出现（⛔ 不再是就地展开）", async () => {
    await openModal();
    expect(overlay(), "⭐ 必须是浮层，不是就地展开").not.toBeNull();
    expect(host.querySelector(".lock-forgot"), "⭐ 旧的就地容器不许再出现（那就是没改 ✗）").toBeNull();
    expect(host.querySelector(MODAL)).not.toBeNull();
  });

  it("b) 点**背景** ⇒ 关闭（owner 点名 ✓）", async () => {
    await openModal();
    await act(() => {
      overlay()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(overlay(), "点背景必须关").toBeNull();
  });

  it("c) **Esc** ⇒ 关闭", async () => {
    await openModal();
    // ⚠️ 夹具前提**必须断言**：否则"没有浮层 ⇒ Esc 之后仍为空"会让本判据**空转** ✓
    //    （红跑时它就是这么"过"的 ✗ —— 没牙的判据不许留在账上 ✓）。
    expect(overlay(), "夹具前提：先得开着").not.toBeNull();
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(overlay(), "Esc 必须关").toBeNull();
  });

  it("d) 点右上角 **×** ⇒ 关闭，且它有可读屏的名字", async () => {
    await openModal();
    const close = host.querySelector(".lock-forgot-close") as HTMLButtonElement;
    expect(close, "要有一个看得见的关闭按钮").not.toBeNull();
    expect(close.getAttribute("aria-label"), "关闭按钮要能读屏").toBe("关闭");
    await act(() => close.click());
    expect(overlay(), "× 必须关").toBeNull();
  });

  it("e) ⛔ **反向**：点浮层**里面**（那段文字）⇒ 不许关", async () => {
    await openModal();
    expect(overlay(), "夹具前提：先得开着").not.toBeNull();
    const inner = host.querySelector(MODAL)!.querySelector("p") as HTMLElement;
    await act(() => {
      inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(overlay(), "⭐ 点里面关了 ＝ 这条的反面（冒泡那个坑）").not.toBeNull();
  });

  it("f) 内容一字不丢：导语 ＋ 三条要点 ＋ 脚注都在", async () => {
    await openModal();
    const text = host.querySelector(MODAL)?.textContent ?? "";
    expect(text, "导语").toContain("口令只由你保管");
    expect(text, "要点：连服务器那份也打不开").toContain("同一把钥匙");
    expect(text, "要点：唯一出路是加密前的明文备份").toContain("开启加密之前导出的备份");
    expect(text, "要点：永久取不回来（不可逆那半）").toContain("永久取不回来了");
    expect(text, "脚注：不会被锁死").toContain("输错多少次都不会被锁死");
    expect(text, "脚注：慢是正常的").toContain("每次慢是密钥派生");
  });

  it("h) 关掉之后 ⛔ 不许还残留在 DOM 里", async () => {
    await openModal();
    await act(() => {
      overlay()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(host.querySelector(MODAL), "关了就得真没了").toBeNull();
    expect(host.textContent ?? "", "正文也不许留在屏上").not.toContain("永久取不回来了");
  });
});
