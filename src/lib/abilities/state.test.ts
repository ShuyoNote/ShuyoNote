// ⭐ task-14（2026-11-01）：能力启停状态的**前端那一半**（`src/lib/abilities/state.ts`）判据。
//
// 这一层只有三件要钉住的事（每件都对应一个"用户会遇到的错"）：
//   a) **缺省＝启用** —— 后端没有那条记录、或读不到，都不许把功能误判成"被停用"；
//   b) **读不到 ⇒ fail-open** —— Web 壳/命令面抽风不该让导入入口整个失效（强制那一面在 Rust）；
//   c) **改完状态要立刻让别的入口看见** —— 缓存必须被更新/作废（否则用户启用之后 Office 导入
//      还是"禁用了"的状态，得等 TTL —— 那就是 bug，不是缓存）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiStub = vi.hoisted(() => ({
  abilityStates: vi.fn(),
  abilitySetEnabled: vi.fn(),
  abilityUninstall: vi.fn(),
  saveAbilityPack: vi.fn(),
}));
vi.mock("../api", () => ({ api: apiStub }));

const {
  abilityEnabledIn,
  invalidateAbilityStates,
  isAbilityEnabled,
  loadAbilityStates,
  setAbilityEnabled,
  uninstallAbility,
} = await import("./state");

const flags = (id: string, enabled: boolean, uninstallable = false) => ({ id, enabled, uninstallable });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAbilityStates();
  apiStub.abilityStates.mockImplementation(async () => [
    flags("office-import", true),
    flags("ecdict-en-zh", true, true),
    flags("vlm-ocr", true),
  ]);
});

describe("能力启停状态（前端那一半）", () => {
  it("a) **缺省＝启用**：没这条记录 / 传 null 都按启用算", () => {
    expect(abilityEnabledIn(null, "office-import"), "读不到 ⇒ 启用（fail-open）").toBe(true);
    expect(abilityEnabledIn([], "office-import"), "空表 ⇒ 启用").toBe(true);
    expect(abilityEnabledIn([flags("vlm-ocr", false)], "vlm-ocr")).toBe(false);
    expect(abilityEnabledIn([flags("vlm-ocr", false)], "office-import"), "别的项不受影响").toBe(true);
  });

  it("b) **读不到 ⇒ null ＋ 按启用**（Web 壳/命令面出错不该让入口整个失效）", async () => {
    apiStub.abilityStates.mockRejectedValueOnce(new Error("能力状态仅桌面版支持"));
    expect(await loadAbilityStates({ force: true })).toBeNull();
    expect(await isAbilityEnabled("office-import"), "读不到就放行（强制那一面在 Rust，不在这里）").toBe(true);
  });

  it("b2) 形状不认识 ⇒ 按「读不到」处理（⛔ 不拿半份猜 ✗）", async () => {
    apiStub.abilityStates.mockResolvedValueOnce({ nope: true });
    expect(await loadAbilityStates({ force: true })).toBeNull();
    apiStub.abilityStates.mockResolvedValueOnce([]);
    expect(await loadAbilityStates({ force: true }), "空表也是「没有读数」").toBeNull();
  });

  it("c) 2s 内走缓存；`invalidateAbilityStates()` 之后立刻重读", async () => {
    await loadAbilityStates({ force: true });
    await loadAbilityStates();
    expect(apiStub.abilityStates, "第二次不该再发命令（缓存）").toHaveBeenCalledTimes(1);
    invalidateAbilityStates();
    await loadAbilityStates();
    expect(apiStub.abilityStates, "作废之后必须重读").toHaveBeenCalledTimes(2);
  });

  it("c2) **改完状态立刻生效**：`setAbilityEnabled` 用后端回的那份刷新缓存，别的入口马上看到", async () => {
    apiStub.abilitySetEnabled.mockResolvedValueOnce([
      flags("office-import", false),
      flags("ecdict-en-zh", true, true),
      flags("vlm-ocr", true),
    ]);
    await loadAbilityStates({ force: true });
    const states = await setAbilityEnabled("office-import", false);
    expect(states.length).toBe(3);
    expect(await isAbilityEnabled("office-import"), "刚停用 ⇒ 立刻是 false").toBe(false);
    expect(apiStub.abilityStates, "这次判定不该再发一次读命令（缓存已经更新）").toHaveBeenCalledTimes(1);
  });

  it("c3) 卸载之后缓存作废（盘上事实变了，不能还拿着旧读数）", async () => {
    apiStub.abilityUninstall.mockResolvedValueOnce({ path: "C:/appdata/packs/ecdict-en-zh", removed: true, bytes: 8 });
    await loadAbilityStates({ force: true });
    const rep = await uninstallAbility("ecdict-en-zh");
    expect(rep.removed).toBe(true);
    await loadAbilityStates();
    expect(apiStub.abilityStates, "卸载之后必须重读一次").toHaveBeenCalledTimes(2);
  });

  it("d) 后端回了、但形状不认识 ⇒ **抛错**（⛔ 不假装改动生效了）", async () => {
    apiStub.abilitySetEnabled.mockResolvedValueOnce({ ok: true });
    await expect(setAbilityEnabled("office-import", false)).rejects.toThrow(/形状/);
  });
});
