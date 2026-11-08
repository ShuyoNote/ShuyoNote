// ⭐ P1 手动地址第二刀（task-62）：SyncPanel「手动添加设备」入口/保存/移除/未配对提示 —— 接线判据。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/SyncPanel.tsx", "utf8");

describe("SyncPanel · 手动添加设备（未发现设备）", () => {
  it("① 高级区有入口（仅桌面）；device_id＋base 输入，空值禁用添加", () => {
    expect(panel).toContain('data-testid="manual-device-entry"');
    expect(panel).toContain('data-testid="manual-device-id"');
    expect(panel).toContain('data-testid="manual-device-base"');
    expect(panel).toContain('data-testid="manual-device-add"');
    const entry_at = panel.indexOf('data-testid="manual-device-entry"');
    const block = panel.slice(
      panel.lastIndexOf("isDesktopPlatform()", entry_at),
      panel.indexOf('data-testid="manual-device-list"'),
    );
    expect(block, "入口必须只在桌面出现").toContain("isDesktopPlatform()");
    expect(block).toContain("!manualDeviceId.trim()");
    expect(block).toContain("!manualDeviceBase.trim()");
    expect(block).toContain("manualDeviceBusy");
  });

  it("② 保存复用现有命令；成功后重读列表并提示配对门", () => {
    const handler = panel.slice(
      panel.indexOf("const addManualDevice"),
      panel.indexOf("const [dpPeer", panel.indexOf("const addManualDevice")),
    );
    expect(handler).toContain("api.meshSetManualPeer(id, base)");
    expect(handler).toContain("await refreshManualPeers()");
    expect(handler).toContain("已配对");
    expect(handler).toContain("不会进入候选");
    expect(handler).toContain("先");
  });

  it("③ 列表显示已添加设备/配对状态/移除；移除复用 clear", () => {
    expect(panel).toContain('data-testid="manual-device-list"');
    expect(panel).toContain('data-testid="manual-device-row-id"');
    expect(panel).toContain('data-testid="manual-device-pair-state"');
    expect(panel).toContain('data-testid="manual-device-remove"');
    const list = panel.slice(
      panel.indexOf('data-testid="manual-device-list"'),
      panel.indexOf('data-testid="crdt-shadow-diagnose-row"'),
    );
    expect(list).toContain("duList.some((d) => d.deviceId === id)");
    expect(list).toContain("未配对（不会进候选）");
    expect(list).toContain("void clearManualPeer(id)");
    expect(panel).toContain("const clearManualPeer");
  });

  it("④ 不凭空信任：UI 只写 KV；不调用信任/配对命令、不显示成功连接", () => {
    const handler = panel.slice(
      panel.indexOf("const addManualDevice"),
      panel.indexOf("const clearManualPeer"),
    );
    for (const forbidden of [
      "meshTrust",
      "meshPair",
      "trustPrefill",
      "meshAccept",
      "api.meshTrust",
    ]) {
      expect(handler, `⛔ 手动添加不许顺带信任/配对：${forbidden}`).not.toContain(forbidden);
    }
    expect(handler).not.toContain("已连接");
    expect(panel).toContain("不凭空信任");
  });
});
