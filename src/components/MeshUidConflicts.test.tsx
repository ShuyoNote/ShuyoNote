// 判据：同名但空间身份不同（owner 2026-11-10 批 B）—— 列表 ＋ 确认入口。
//
// 三条口径：
// ① 没有冲突 ⇒ **不渲染这一块**（⛔ 不显示“0 条”的假读数）；
// ② 有冲突 ⇒ 列出本地名字；**界面上不出现**对端 uid（内部标识）；
// ③ 点「确认是同一空间」⇒ 先弹二次确认（window.confirm），确认后才调 `mesh_uid_confirm` 并刷新。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const meshUidConflicts = vi.fn();
const meshUidConfirm = vi.fn();
const toast = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    meshUidConflicts: (...a: unknown[]) => meshUidConflicts(...a),
    meshUidConfirm: (...a: unknown[]) => meshUidConfirm(...a),
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

let host: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  // 让 promise 链跑完（api 都是 mock 的 resolved）
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  meshUidConflicts.mockReset();
  meshUidConfirm.mockReset();
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

  it("有冲突 ⇒ 列出本地名字，且**不显示对端 uid**（内部标识不进界面）", async () => {
    meshUidConflicts.mockResolvedValue([row]);
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    expect(host.textContent ?? "").toContain("山焦招标");
    expect(host.textContent ?? "").not.toContain(row.peerUid);
    expect(host.textContent ?? "").not.toContain(row.peerDevice);
  });

  it("点确认 ⇒ 二次确认通过后才调命令；确认后刷新列表", async () => {
    meshUidConflicts.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    meshUidConfirm.mockResolvedValue(true);
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmSpy);
    flushSync(() => root.render(<MeshUidConflicts />));
    await settle();
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="mesh-uid-confirm"]');
    expect(btn).toBeTruthy();
    flushSync(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(confirmSpy).toHaveBeenCalled();
    expect(meshUidConfirm).toHaveBeenCalledWith({
      peerDevice: row.peerDevice,
      peerUid: row.peerUid,
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
    flushSync(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(confirmSpy).toHaveBeenCalled();
    expect(meshUidConfirm).not.toHaveBeenCalled();
  });
});


