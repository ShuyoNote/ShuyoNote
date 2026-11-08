// ⭐ P1 手动地址第一刀（task-53）：**界面接上了没有**（桌面发现层专属；Node 里起不了窗口 ⇒ 文本级判据）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("SyncPanel · 手动地址入口接线", () => {
  const panel = read("src/components/SyncPanel.tsx");
  const api = read("src/lib/api.ts");
  const commands = read("src/lib/platform/commands.ts");
  const web = read("src/lib/platform/web.ts");
  const lib = read("src-tauri/src/lib.rs");
  const mesh = read("src-tauri/src/mesh.rs");

  it("① 命令面三件都在（契约＋api＋Rust 注册）", () => {
    for (const cmd of ["mesh_set_manual_peer", "mesh_clear_manual_peer", "mesh_manual_peers"]) {
      expect(commands, `commands.ts 缺 ${cmd}`).toContain(`${cmd}:`);
      expect(lib, `lib.rs 没注册 ${cmd}`).toContain(`sync::${cmd},`);
    }
    expect(api).toContain("meshSetManualPeer:");
    expect(api).toContain("meshClearManualPeer:");
    expect(api).toContain("meshManualPeers:");
    // Web：没有发现层 ⇒ 读回空表、写要明确说不可用（⛔ 不假装支持）。
    expect(web).toContain('cmd === "mesh_manual_peers"');
    expect(web).toContain('cmd === "mesh_set_manual_peer"');
    expect(web).toContain("手动地址只在桌面版可用");
  });

  it("② 面板：只对「服务当前空间／已信任」的行显示入口，且有保存/清除", () => {
    const block = panel.slice(panel.indexOf("P1 手动地址（task-53）"));
    expect(block).toContain("p.serves_current || paired");
    expect(panel).toContain('data-testid="nearby-manual-address"');
    expect(panel).toContain('data-testid="nearby-manual-input"');
    expect(panel).toContain('data-testid="nearby-manual-save"');
    expect(panel).toContain('data-testid="nearby-manual-clear"');
    expect(panel).toContain('data-testid="nearby-manual-current"');
    expect(panel).toContain("api.meshSetManualPeer(");
    expect(panel).toContain("api.meshClearManualPeer(");
    expect(panel).toContain("api.meshManualPeers(");
    // 清除要**重读**（回落到公告地址），保存后也要重读；⛔ 不把覆盖写进全局 store。
    expect(panel).toContain("await refreshManualPeers()");
    expect(panel).not.toContain("useManualPeerStore");
  });

  it("③ Rust 侧：校验/存储/覆盖优先级与「不凭空加设备」的承重句都在", () => {
    expect(mesh).toContain("validate_manual_peer_base");
    expect(mesh).toContain("MANUAL_PEER_BASES_KEY");
    expect(mesh).toContain("mesh_peers_by_name_with_overrides");
    expect(mesh).toContain("覆盖优先");
    expect(mesh).toContain("绝不因为一条覆盖凭空加入");
    // 覆盖是**候选构造**的一层，不是信任/配对/同步协议。
    expect(mesh).not.toContain("manual_peer_bases(&g) && trusted");
  });
});
