// 设置 →「安全」页的两条**行为**判据（owner 2026-09-24 拍板"选项 A"）：
//
//   ① 本机**还有加密空间**（内核 `encryption_status.enabled === true`）⇒ 出现「会话锁定」那一节
//      （它是**会话级**的：锁定丢弃内存里的主密钥、界面切回锁定屏）；
//   ② 本机**没有加密空间** ⇒ **整节隐藏** —— 那时它既没有动作（`lock_encryption` 会直接报
//      "这个空间没有加密"），也没有新信息（下面就是空间列表），留着只是占位。
//
// 为什么值得一条判据：这一节是"设置面板那一节换成按空间"之后**唯一留下来的非按空间内容**，
// 很容易被后来的人当成"没删干净"又塞回去，或者反过来真删掉（那就没人能手动锁了）。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  status: vi.fn(async () => ({ enabled: false, locked: false })),
}));

// 只桩和这一屏有关的三条加密命令；其余 api 一律给"空数组/空对象"，够它安静地渲染。
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      encryptionStatus: mocks.status,
      lockEncryption: vi.fn(async () => undefined),
      unlockEncryption: vi.fn(async () => undefined),
    },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => []) },
  ),
}));
// 桌面形态：这样「空间隐私」那一节会走桌面分支（Web 分支只渲染一句解释）。
vi.mock("../lib/platform", () => ({ isDesktopPlatform: () => true, emailSupported: () => false }));

import "../i18n";
import { useEditorStore } from "../store/editor";
import { __resetVaultForTests } from "../lib/vault";
import { SettingsDialog } from "./SettingsDialog";

let host: HTMLDivElement;
let root: Root;
/** ⚠️ 设置弹层走 `createPortal(…, document.body)` ⇒ 断言要查 **document**，不是容器节点
 * （同 `aboutDialog.test.ts` 的注意事项）。 */
const pane = () => document.body.textContent ?? "";

beforeEach(() => {
  __resetVaultForTests();
  mocks.status.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // 直接打开"安全"那一页（设置弹层是 store 驱动的，不需要点）。
  useEditorStore.setState({ settingsOpen: true, settingsTab: "security" });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  useEditorStore.setState({ settingsOpen: false });
});

async function render() {
  await act(async () => {
    root.render(createElement(SettingsDialog));
  });
  // vault 状态是异步问内核的：再冲一轮，让 enabled 落地
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("设置 → 安全", () => {
  it("① 有加密空间 ⇒ 「会话锁定」那一节在（并且能立即锁定）", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: false });
    await render();

    expect(pane(), "有加密空间时应当有「会话锁定」").toContain("会话锁定");
    expect(pane(), "已解锁 ⇒ 给「立即锁定」入口").toContain("立即锁定");
    // 它仍然只是"设置面板里的一节"，不是把整页占掉
    expect(document.querySelector(".space-privacy"), "空间隐私那一节照旧在下面").not.toBeNull();
  });

  it("② 没有加密空间 ⇒ 「会话锁定」**整节隐藏**（没动作就别占位）", async () => {
    mocks.status.mockResolvedValue({ enabled: false, locked: false });
    await render();

    expect(pane()).not.toContain("会话锁定");
    expect(pane()).not.toContain("立即锁定");
    // 首页只剩空间隐私（这才是"设置里那一节换成按空间"的意思）
    expect(document.querySelector(".space-privacy")).not.toBeNull();
  });

  it("③ 锁定时状态行说清后果（而不是给一个按不动的按钮）", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    await render();

    expect(pane()).toContain("已加密 · 已锁定");
    expect(pane()).toContain("解锁前读不到内容");
    expect(pane(), "锁着的时候不该再给「立即锁定」").not.toContain("立即锁定");
  });
});
