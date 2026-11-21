// 判据：同名但空间身份不同（owner 2026-11-10 批 B）—— 列表 ＋ 确认入口。
//
// 三条口径：
// ① 没有冲突 ⇒ **不渲染这一块**（⛔ 不显示“0 条”的假读数）；
// ② 有冲突 ⇒ 列出本地名字；**界面上不出现**对端 uid / 设备 id（内部标识）；
// ③ 点确认 ⇒ 先弹二次确认（window.confirm），确认后才调命令并刷新。
//
// ⭐ A3（2026-11-21）：批量勾选 ＋ 一次确认 —— 三条判据（与后端纯函数同名）：
// ① `batch-selected-only`：请求体**逐个都是勾选的**（勾两行 ⇒ 只送两行）；
// ② `propagate-same-uid-only`：界面上"另外 N 对"只数 **uid 相同** 的（uid 不同 ⇒ 不数）；
// ③ `empty-selection-writes-nothing`：一个都不勾 ⇒ 按钮禁用、点不动也**不发请求**。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const meshUidConflicts = vi.fn();
const meshUidConfirmBatch = vi.fn();
const toast = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    meshUidConflicts: (...a: unknown[]) => meshUidConflicts(...a),
    meshUidConfirmBatch: (...a: unknown[]) => meshUidConfirmBatch(...a),
  },
}));
vi.mock("../store/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));

import { MeshUidConflicts } from "./MeshUidConflicts";

const row = {
  peerDevice: "device-peer-xxxx",
  peerUid: "uid-peer-secret-value",
  localName: "山焦招标",
  peerName: "山焦招标",
  lastSeenAt: 1000,
};
/** 另一台设备、**同一个 uid**（＝ 同一个空间身份 ⇒ 该被传播）。 */
const rowSameUid = { ...row, peerDevice: "device-peer-yyyy" };
/** 同一台设备、**uid 不同**（⛔ 绝不传播）。 */
const rowOtherUid = { ...row, peerUid: "uid-peer-other" };

let host: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  // 让 promise 链跑完（api 都是 mock 的 resolved）
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function click(el: Element) {
  flushSync(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  meshUidConflicts.mockReset();
  meshUidConfirmBatch.mockReset();
  toast.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MeshUidConflicts", () => {
  it("没有冲突 ⇒ 不渲染", async () => {
    meshUidConflicts.mockResolvedValue([]);
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    expect(meshUidConflicts).toHaveBeenCalled();
    expect(host.textContent ?? "").not.toContain("同名空间身份不一致");
  });

  it("有冲突 ⇒ 列出本地名字，且**不显示对端 uid / 设备 id**（内部标识不进界面）", async () => {
    meshUidConflicts.mockResolvedValue([row, rowOtherUid]);
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    expect(host.textContent ?? "").toContain("山焦招标");
    expect(host.textContent ?? "").not.toContain(row.peerUid);
    expect(host.textContent ?? "").not.toContain(row.peerDevice);
  });

  it("点「确认这一对」⇒ 二次确认通过后才调批量命令（一条也走同一语义）；确认后刷新列表", async () => {
    meshUidConflicts.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    meshUidConfirmBatch.mockResolvedValue({ written: 1, propagated: 0 });
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmSpy);
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="mesh-uid-confirm"]');
    expect(btn).toBeTruthy();
    click(btn!);
    await settle();
    expect(confirmSpy).toHaveBeenCalled();
    expect(meshUidConfirmBatch).toHaveBeenCalledWith({
      keys: [{ peerDevice: row.peerDevice, peerUid: row.peerUid }],
    });
    expect(meshUidConflicts.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(toast).toHaveBeenCalled();
  });

  it("二次确认被取消 ⇒ **不调命令**", async () => {
    meshUidConflicts.mockResolvedValue([row]);
    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="mesh-uid-confirm"]');
    click(btn!);
    await settle();
    expect(confirmSpy).toHaveBeenCalled();
    expect(meshUidConfirmBatch).not.toHaveBeenCalled();
  });

  it("① batch-selected-only：勾两行再点批量 ⇒ **只送勾选的那两对**", async () => {
    meshUidConflicts.mockResolvedValue([row, rowOtherUid]);
    meshUidConfirmBatch.mockResolvedValue({ written: 2, propagated: 0 });
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    const boxes = host.querySelectorAll<HTMLButtonElement>('[data-testid="mesh-uid-check"]');
    expect(boxes.length).toBe(2);
    click(boxes[1]); // 只勾第二行
    const batch = host.querySelector<HTMLButtonElement>('[data-testid="mesh-uid-confirm-batch"]');
    expect(batch!.textContent ?? "").toContain("确认勾选的 1 对");
    click(batch!);
    await settle();
    expect(meshUidConfirmBatch).toHaveBeenCalledWith({
      keys: [{ peerDevice: rowOtherUid.peerDevice, peerUid: rowOtherUid.peerUid }],
    });
  });

  it("② propagate-same-uid-only：界面那句「另外 N 对」只数 uid 相同的（uid 不同 ⇒ 0）", async () => {
    meshUidConflicts.mockResolvedValue([row, rowSameUid, rowOtherUid]);
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    const boxes = host.querySelectorAll<HTMLButtonElement>('[data-testid="mesh-uid-check"]');
    // 勾第 1 行（uid-1）⇒ 第 2 行同 uid 会被一并确认；第 3 行同设备但 uid 不同 ⇒ 不算
    click(boxes[0]);
    expect(host.textContent ?? "").toContain("另外 1 对");
    // 换成只勾第 3 行（uid 不同那个）⇒ 没有任何"另外 N 对"
    click(boxes[0]);
    click(boxes[2]);
    expect(host.textContent ?? "").not.toContain("另外");
  });

  it("③ empty-selection-writes-nothing：一个都不勾 ⇒ 批量按钮禁用，点它也不发请求", async () => {
    meshUidConflicts.mockResolvedValue([row]);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    const batch = host.querySelector<HTMLButtonElement>('[data-testid="mesh-uid-confirm-batch"]');
    expect(batch!.disabled).toBe(true);
    click(batch!);
    await settle();
    expect(meshUidConfirmBatch).not.toHaveBeenCalled();
  });

  it("全选 ⇒ 每一行的键都进请求体（仍是一次点击）", async () => {
    meshUidConflicts.mockResolvedValueOnce([row, rowOtherUid]).mockResolvedValueOnce([]);
    meshUidConfirmBatch.mockResolvedValue({ written: 2, propagated: 1 });
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    click(host.querySelector('[data-testid="mesh-uid-select-all"]')!);
    click(host.querySelector('[data-testid="mesh-uid-confirm-batch"]')!);
    await settle();
    expect(meshUidConfirmBatch).toHaveBeenCalledWith({
      keys: [
        { peerDevice: row.peerDevice, peerUid: row.peerUid },
        { peerDevice: rowOtherUid.peerDevice, peerUid: rowOtherUid.peerUid },
      ],
    });
  });
});
