// ⭐ owner 2026-10-10 报「点了，没有弹窗」那条 —— 切到**打不开的加密空间**时发生了三件事：
//   ① 内核**拒绝**（D0 的「要么全成、要么全不动」✓）⇒ `set_active_workspace_id` 抛错 ✓；
//   ② `store/space.ts::switchTo` 的 `catch` **只 `console.error`** ✗ ⇒ 界面**零反馈** ✗
//      ⇒ 用户读成「什么都没发生」✓（那正是老板的原话 ✓）；
//   ③ `PageTree` 那边 `if (ok) …` ⇒ 只把下拉关掉 ✓。
// ⚠️ ⭐ 而**没弹锁屏是对的** ✓：DB 里活动空间**仍是原来那个明文空间** ✓ ⇒ 内核读到的就是它
//   ⇒ `enabled:false`／`locked:false` ⇒ 闸门 `activeSpaceEncrypted && locked` **本来就该为 false** ✓。
//   ⛔ 所以**不许**把这里当"闸门没成立"去改 ✗ —— 在这里拦 ⇒ owner 上次那条
//   「一个空间加密，其它空间怎么还需要密码？」会**复发** ✗。
//
// 四条判据（Lead 拍的 ✓，各自能红 ✓）：
//   ① 拒绝**不被吞掉**：必须有一条**可见**反馈（`toast` ✓）
//   ② 前端状态**不变**：`activeId` 仍是原来那个 ✓
//   ③ **闸门不会因失败而成立**：失败路径**不碰** `refreshVault` ✓ ＋ `vaultState().activeSpaceEncrypted` 仍 false ✓
//   ④ **两条拒绝理由分得开**：需要口令 vs 别的失败 ✓（⛔ 不许糊成一句 ✗）
//   ＋ b) ⛔ **不许把「拒绝」做成「什么都点不了」** ✗：失败之后**别的空间照样能切** ✓
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setActive: vi.fn(),
  toast: vi.fn(),
  loadPages: vi.fn(async () => {}),
  /** ⭐ 明确信号（判据 ④／f）：每空间读数由**这一格**给，⛔ 不再从错误串里嗅 ✗。 */
  overview: vi.fn(async () => [] as unknown[]),
}));

// ⚠️ 只桩 `api`／`toast`／`notes` 三处 ✓；`../lib/vault` 用**真的** ✓
//    （判据 ③ 要读真 `vaultState()` ⇒ 用桩就成空转了 ✗）。
vi.mock("../lib/api", () => ({
  // ⚠️ `get` 陷阱**必须先看目标自己有没有这个键** ✗ —— 否则它会给**每个**属性都返回兜底函数 ✓，
  //    于是 `setActiveWorkspaceId` 永远不被调用、`switchTo` 永远成功 ✗
  //    （我第一版就是这么写的，红读数因此是**假的** ✗ —— 当场改掉 ✓）。
  api: new Proxy(
    {
      setActiveWorkspaceId: (...a: unknown[]) => mocks.setActive(...a),
      spaceSecurityOverview: () => mocks.overview(),
    },
    { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => []) },
  ),
}));
vi.mock("./toast", () => ({ toast: mocks.toast }));
vi.mock("./notes", () => ({ useNotes: { getState: () => ({ loadPages: mocks.loadPages }) } }));
vi.mock("../lib/pluginEvents", () => ({ emitHostEvent: vi.fn() }));

import { __resetVaultForTests, vaultState } from "../lib/vault";
import { useSpaceStore } from "./space";

const PROD = { id: "eb9a07f1", name: "产品", created_at: 1, updated_at: 1 };
const SAFE = { id: "99082b5a", name: "保险柜", created_at: 2, updated_at: 2 };
const WORK = { id: "11112222", name: "工作", created_at: 3, updated_at: 3 };

beforeEach(() => {
  __resetVaultForTests();
  mocks.setActive.mockReset();
  mocks.toast.mockReset();
  mocks.overview.mockReset();
  mocks.overview.mockResolvedValue([]); // 默认：读不到读数 ⇒ 走"别的失败"那一档（保守 ✓）
  mocks.loadPages.mockClear();
  useSpaceStore.setState({ spaces: [PROD, SAFE, WORK] as never, activeId: PROD.id });
});

describe("设置-空间 · 切到打不开的空间：拒绝必须可见", () => {
  it("① ⭐ 拒绝不被吞掉：有一条**可见**反馈（⛔ 不许只剩 console.error）", async () => {
    mocks.setActive.mockRejectedValueOnce(new Error("空间「保险柜」的库打不开：需要口令"));

    const ok = await useSpaceStore.getState().switchTo(SAFE.id);

    expect(ok, "内核拒绝了 ⇒ 返回 false").toBe(false);
    expect(
      mocks.toast,
      "⭐ 拒绝了却没有任何可见反馈 ⇒ 用户读成「什么都没发生」",
    ).toHaveBeenCalledTimes(1);
    expect(String(mocks.toast.mock.calls[0][0]), "⭐ 要说清是**哪一个**空间").toContain("保险柜");
    expect(mocks.toast.mock.calls[0][1], "这一档是失败 ⇒ 用 error").toBe("error");
  });

  it("② 前端状态不变：activeId 仍是原来那个", async () => {
    mocks.setActive.mockRejectedValueOnce(new Error("boom"));

    await useSpaceStore.getState().switchTo(SAFE.id);

    expect(useSpaceStore.getState().activeId, "⭐ 拒绝之后前端**不许**先切过去").toBe(PROD.id);
  });

  it("③ ⭐ 闸门不会因这次失败而成立：不碰 refreshVault ＋ vaultState 仍 false", async () => {
    mocks.setActive.mockRejectedValueOnce(new Error("空间「保险柜」的库打不开：需要口令"));

    await useSpaceStore.getState().switchTo(SAFE.id);

    // ⭐ 失败路径**不许**刷新口令读数 —— 否则界面会拿"另一个空间"的口径去判闸门 ✗
    //    （能发现它的判据就是下一条：读数一刷，`activeSpaceEncrypted` 就可能被写成 true ✗）
    expect(vaultState().activeSpaceEncrypted, "⭐ 活动空间没变 ⇒ 闸门不该成立").toBe(false);
    expect(vaultState().locked).toBe(false);
  });

  it("④ ⭐ 两条拒绝理由分得开 —— 判**明确信号**，⛔ 不嗅错误字符串", async () => {
    // ① 信号说"这个空间加密在盘上、本会话拿不到钥匙" ⇒ 走"要口令"那一档
    mocks.overview.mockResolvedValueOnce([
      { space_id: SAFE.id, kind: "personal", encrypted_on_disk: true, in_keyring: true, key_available: false, gate: { allow: false, unclassified: false, reason: "" } },
    ]);
    mocks.setActive.mockRejectedValueOnce(new Error("内核拒绝（随便什么文案）"));
    await useSpaceStore.getState().switchTo(SAFE.id);
    expect(String(mocks.toast.mock.calls[0][0]), "信号说需要口令 ⇒ 要说出来").toContain("口令");

    // ② ⭐ 决定性的一条：**错误串里带"口令"，而信号说它是明文空间** ⇒ 必须走"别的"那一档 ✓
    //    ⛔ 若判据是"串里有没有口令"（旧写法）⇒ 这一条会红 ✓ ⇒ 它挡的就是那种写法 ✗
    mocks.toast.mockClear();
    mocks.overview.mockResolvedValueOnce([
      { space_id: SAFE.id, kind: "personal", encrypted_on_disk: false, in_keyring: false, key_available: false, gate: { allow: true, unclassified: false, reason: "" } },
    ]);
    mocks.setActive.mockRejectedValueOnce(new Error("空间「保险柜」的库打不开：需要口令"));
    await useSpaceStore.getState().switchTo(SAFE.id);
    const other = String(mocks.toast.mock.calls[0][0]);
    expect(other, "⭐ 明文空间⛔ 不许因为错误串里有'口令'就说是要口令（会让用户白输一遍 ✗）").not.toContain("要先输入口令");
    expect(other).toContain("内核拒绝了这次切换");
  });

  it("d) ⭐ toast 里⛔ 不许有空间 **id** ／「钥匙袋」／英文原文 —— 而**原文仍要进日志**", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.overview.mockResolvedValueOnce([]);
    mocks.setActive.mockRejectedValueOnce(
      new Error(`空间「${SAFE.id}」按钥匙袋是加密的，但会话未解锁（请先输口令）`),
    );

    await useSpaceStore.getState().switchTo(SAFE.id);

    const text = String(mocks.toast.mock.calls[0][0]);
    expect(text, "⛔ 用户面不许出现空间 id").not.toContain(SAFE.id);
    expect(text, "⛔ 用户面不许出现内部词「钥匙袋」").not.toContain("钥匙袋");
    expect(text, "⛔ 用户面不许出现英文原文").not.toMatch(/[A-Za-z]{3,}/);
    // ⭐ 但**原文必须还在日志里**（⛔ 别连日志一起删了 ✗）
    const logged = spy.mock.calls.map((c) => String((c[1] as Error)?.message ?? c[1])).join("\n");
    expect(logged, "原始报错必须留在日志里（排查靠它）").toContain("钥匙袋");
    spy.mockRestore();
  });

  it("b) ⛔ 不许把「拒绝」做成「什么都点不了」：失败之后别的空间照样能切", async () => {
    mocks.setActive.mockRejectedValueOnce(new Error("需要口令"));
    expect(await useSpaceStore.getState().switchTo(SAFE.id), "这一档是拒绝").toBe(false);

    // 紧接着切**另一个**空间 ⇒ 必须照常成功（store 不该卡在中间态 ✗）
    mocks.setActive.mockResolvedValueOnce(undefined);
    expect(await useSpaceStore.getState().switchTo(WORK.id), "别的空间仍要能切").toBe(true);
    expect(useSpaceStore.getState().activeId).toBe(WORK.id);
    expect(mocks.loadPages, "切成功之后照样要重读页面列表").toHaveBeenCalled();
  });
});
