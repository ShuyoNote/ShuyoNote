// 口令锁闸门的回归测试。这条测试钉的是一个**真事故**（2026-09-16 发现并修）：
//
//   加密开启后重启应用 = 用户看到崩溃屏，而不是锁定屏。
//
// 原因是 `App` 里的闸门写成一句早退，而它排在七八个 hooks **之前**：
//   首帧 `enc === null` → 不算锁定 → 这一帧跑了 N 个 hooks；
//   状态回来后的第二帧早退 → 只跑 N-3 个 → React 抛
//   `Rendered fewer hooks than expected.`
// 根部 ErrorBoundary 把它接住 → 崩溃屏。于是 E1 的锁定屏在这条路径上**永远没机会出现**
// （真机没验过重启，所以一直没暴露）。
//
// 所以这里的判据是**用户看得见的结果**：锁定安装启动后 DOM 里是锁定屏、外壳不挂载、
// 渲染过程一声不响；运行中锁定要立刻切屏；解锁后要回来。修复前的代码会让本文件红。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { __resetVaultForTests, lockVault, unlockVault, vaultState } from "./lib/vault";
import { useSpaceStore } from "./store/space";
import "./i18n"; // 外壳里的组件用 useTranslation；先初始化，免得刷一屏 NO_I18NEXT_INSTANCE

const mocks = vi.hoisted(() => ({
  status: vi.fn<() => Promise<{ enabled: boolean; locked: boolean }>>(),
  lockEncryption: vi.fn<() => Promise<void>>(),
  unlockEncryption: vi.fn<(p: string) => Promise<void>>(),
  // ⭐ 2026-10-10：锁定屏的**出路**要读"本机哪些空间是明文" ⇒ 两条命令都得给桩。
  overview: vi.fn<() => Promise<unknown[]>>(async () => []),
  workspaces: vi.fn<() => Promise<{ id: string; name: string }[]>>(async () => []),
  setActive: vi.fn<(id: string) => Promise<void>>(async () => undefined),
}));

// 只替换加密那几个命令；外壳里的其它命令一律给空数组，够它安静地渲染。
// ★ owner 第三轮拍板（2026-09-24）：`set_encryption` / `disable_encryption`（应用级）已删 ⇒
// 这里也不再桩它们（`enableVault` / `disableVault` 随命令一起没了）。
vi.mock("./lib/api", () => ({
  api: new Proxy(
    {
      encryptionStatus: mocks.status,
      lockEncryption: mocks.lockEncryption,
      unlockEncryption: mocks.unlockEncryption,
      spaceSecurityOverview: mocks.overview,
      listWorkspaces: mocks.workspaces,
      setActiveWorkspaceId: mocks.setActive,
    },
    {
      get: (target: Record<string, unknown>, name: string) =>
        name in target ? target[name] : async () => [],
    },
  ),
}));

const { default: App } = await import("./App");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let consoleErrors: string[];

// 不桩掉 fetch 的话，happy-dom 会真的去连 http://localhost:3000（相对 URL 的落点），
// 留下一个没人处理的 `AggregateError: ECONNREFUSED`——结果是**用例全过、退出码却是 1**。
// 这是本机（Windows）实测过的坑，见 aboutDialog.test.ts 的同一段注释。
const fetchStub = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));

beforeEach(() => {
  __resetVaultForTests();
  consoleErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  });
  vi.stubGlobal("fetch", fetchStub);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 状态回执与订阅通知都发生在 React 之外（promise 里），所以要真正跑完一轮：
// act 会把这些更新连同 effect 一起冲干净，再断言。
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render() {
  flushSync(() => root.render(React.createElement(App)));
  await settle();
}

function hookOrderErrors() {
  return consoleErrors.filter((e) => /Rendered (fewer|more) hooks/.test(e));
}

describe("加密锁定的启动闸门", () => {
  it("已开启加密且锁定：启动后是锁定屏，外壳不挂载，且没有任何 hooks 顺序报错", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    expect(host.querySelector(".lock-screen"), "锁定态必须给出锁定屏").not.toBeNull();
    expect(host.querySelector(".app"), "锁定态不应挂载应用外壳").toBeNull();
    expect(hookOrderErrors(), "渲染期不许出现 hooks 顺序报错").toEqual([]);
  });

  it("未开启加密：直接进应用外壳（不许卡在锁定屏上）", async () => {
    mocks.status.mockResolvedValue({ enabled: false, locked: false });

    await render();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app"), "正常启动应当渲染外壳").not.toBeNull();
    expect(hookOrderErrors()).toEqual([]);
  });

  it("运行中锁定（设置页点「立即锁定」）：界面立刻切回锁定屏", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: false });
    mocks.lockEncryption.mockResolvedValue(undefined);
    await render();
    expect(host.querySelector(".app"), "先确认已解锁时渲染的是外壳").not.toBeNull();

    // 模拟设置页里的「立即锁定」：走同一个状态中枢，不经过 App 自己的 state。
    await act(async () => {
      await lockVault();
    });

    expect(host.querySelector(".lock-screen"), "锁定后必须马上切屏，不能继续展示读不出来的内容").not.toBeNull();
    expect(host.querySelector(".app")).toBeNull();
    expect(vaultState().locked).toBe(true);
  });

  it("解锁成功后回到外壳（锁定屏不能把人关在外面）", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    mocks.unlockEncryption.mockResolvedValue(undefined);
    await render();
    expect(host.querySelector(".lock-screen")).not.toBeNull();

    await act(async () => {
      await unlockVault("正确口令");
    });
    await settle();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app")).not.toBeNull();
  });

  it("解锁失败不改变状态：仍然锁定，错误照常抛出给界面显示", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    // ★ 内核文案（owner 第三轮拍板后）：口令对不对由**解盒子**回答
    mocks.unlockEncryption.mockRejectedValue(new Error("打不开（口令不对或盒子被改过）"));
    await render();

    await act(async () => {
      await expect(unlockVault("错的")).rejects.toThrow("打不开");
    });

    expect(vaultState().locked, "口令不对就不能变成已解锁").toBe(true);
    expect(host.querySelector(".lock-screen")).not.toBeNull();
  });

  it("问不到内核状态时按「未开启」处理：宁可让人用，也不要卡在锁定屏", async () => {
    mocks.status.mockRejectedValue(new Error("no such command"));

    await render();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app")).not.toBeNull();
    expect(vaultState()).toMatchObject({ enabled: false, locked: false, ready: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-10：owner 亲口报的缺陷 ——「**一个空间加密，其它空间怎么还需要密码？**」
//
// 量到的机制（⛔ 不是猜 ✗）：
//   · 闸门 = `vault.activeSpaceEncrypted && vault.locked`，判的是**当前活动空间**
//     （内核 `encryption_status.enabled` 按活动空间算；启动时的 `LOCKED` 也只看活动空间的文件头 ✓）
//     ⇒ ⭐ **这一半原先就是对的** ✓；
//   · ✗ 出事的是下一层：闸门一为真，`AppShell` **整块不挂载**，而**空间切换器就在 AppShell 里**
//     ⇒ 用户**出不去**，只能先输那个加密空间的口令 ⇒ 「一个空间的口令」事实上成了「整个应用的开关」✗。
// ⇒ 所以这四条判据守的不是"把闸门放开"✗，而是：**闸门照挡 ＋ 明文空间有一条直接进去的路** ✓。
// ══════════════════════════════════════════════════════════════════════════

/** 一个加密空间的读数（与 `SpaceSecurityView` 同形 ✓）。 */
function encView(id: string) {
  return {
    space_id: id,
    kind: "personal",
    encrypted_on_disk: true,
    in_keyring: true,
    key_available: false,
    gate: { allow: true, unclassified: false, reason: "" },
  };
}
/** 一个**明文**空间的读数。 */
function plainView(id: string) {
  return {
    space_id: id,
    kind: "personal",
    encrypted_on_disk: false,
    in_keyring: false,
    key_available: false,
    gate: { allow: true, unclassified: false, reason: "" },
  };
}

/** 夹具：本机**一个加密空间（未解锁）＋ 一个明文空间** ✓（就是 owner 那个现场 ✓）。 */
function fixture() {
  mocks.overview.mockResolvedValue([encView("enc"), plainView("plain")]);
  mocks.workspaces.mockResolvedValue([
    { id: "enc", name: "加密空间" },
    { id: "plain", name: "明文空间" },
  ]);
  // 活动空间是**加密**那个，且会话锁着 ⇒ 闸门该出来 ✓
  mocks.status.mockResolvedValue({ enabled: true, locked: true });
}

const escapeBox = () => host.querySelector('[data-testid="lock-other-spaces"]');

// ⭐ 2026-10-10（owner 拍 C：「全都压」）：文案精简后 ⛔ **要点一个都不许丢** ✗ ＋ ⭐ 那排按钮的形态**一个字不许动** ✗。
describe("锁屏文案精简后：要点还在 ＋ 按钮形态没动", () => {
  it("「放弃打开」那段：两条要点还在（不用输口令 ／ 随时可以切回来）", async () => {
    fixture();
    await render();

    const text = escapeBox()?.textContent ?? "";
    expect(text, "要点：换过去马上就能用、不用输这里的口令").toContain("不用输这里的口令");
    expect(text, "要点：随时可以切回来").toContain("随时可以切回来");
    // ⚠️ 压掉的那两句是**同义重复** ✓（"先不打开它" / "解锁之前读不出来"）——
    //    但它们说的是**同一件事**：换过去 ≠ 解锁 ⇒ 前半句（不用输口令）已承担该语义 ✓。
  });

  it("⭐ 那排「去「名字」」按钮的形态：⛔ 不许把「放弃打开它，」前缀加回来", async () => {
    // ⚠️ 这一格**本来就有判据**（`a3)`「按钮只留『去「<名字>」』：⛔ 前缀一个字都不许有 ＋ 每颗带名字 ＋
    //    数量＝明文空间数」✓）⇒ 这里**只写一句指向它**，⛔ 不重复造第二条 ✗（账本上重复判据会被当成新覆盖 ✓）。
    //    ⭐ 收尾前我实测过：把前缀加回来 ⇒ `a3)` 与新写的那版**都会红** ✓ ⇒ 既有那条已经够 ✓。
    fixture();
    await render();
    const go = host.querySelector('[data-testid^="lock-go-"]') as HTMLButtonElement;
    expect(go.textContent, "按钮只留「去「<名字>」」（权威判据见 a3)）").toMatch(/^去「.+」$/);
  });
});

describe("一个空间加密，⛔ 不锁住其它空间（owner 拍 B：明文空间直接可用）", () => {
  it("⭐ a) 正面：本机有明文空间 ⇒ 锁定屏上**必须有一条直接进去的路**（旧行为必红）", async () => {
    fixture();
    await render();

    // 闸门**照旧挡着**（不是在"放开"✗）
    expect(host.querySelector(".lock-screen"), "加密空间未解锁 ⇒ 仍然要口令").not.toBeNull();
    expect(host.querySelector(".app"), "那一个空间锁着时，外壳不挂载").toBeNull();

    // ⭐ 但**出口必须在**：旧代码在这一步是**死路** ⇒ 本用例红 ✓
    expect(escapeBox(), "锁定屏上必须有「其它空间不用口令」那一段").not.toBeNull();
    const box = escapeBox()!.textContent ?? "";
    expect(box, "要把那个明文空间的名字摆出来").toContain("明文空间");
    // ⛔ 加密的那个**不许**被当成"去处"摆出来 ✗
    // ⚠️ 2026-10-10 订正这条判据的口径：原先写的是 `expect(box).not.toContain("加密空间")` ——
    //    那是拿**文案里有没有那三个字**当代理信号 ✗；而 owner 要的就是让它说清"这是**放弃打开
    //    这个加密空间**" ⇒ 那三个字**本来就该出现** ✓。⇒ 改成按**按钮**判（真信号）：
    expect(host.querySelector('[data-testid="lock-go-enc"]'), "加密空间不许出现在去处清单里").toBeNull();
    // ⭐ b) 反向：「放弃打开」的意思**必须由上面那段说明承担** ✓
    //    ⚠️ 2026-10-10 订正这条判据的口径：原先它打在**整块**的 `textContent` 上 ✗ ⇒
    //    「说明被删了、而按钮上还留着『放弃打开它，』」时它**照样绿** ✗（又是一个代理信号 ✓）。
    //    ⇒ 改成**指名那段说明**：按钮去前缀之后，"放弃"的语义就只剩它一个承重墙了 ✓
    const lead = escapeBox()!.querySelector(".lock-forgot-lead")!.textContent ?? "";
    expect(lead, "⭐ 「放弃打开」的意思必须在那段说明里（⛔ 别顺手把整块文案删干净）").toContain("放弃打开");
    expect(box, "⛔ owner 没选「关掉应用」那条").not.toContain("关掉应用");
  });

  it("⭐ a3) 按钮只留「去「<名字>」」：⛔ 前缀一个字都不许有 ＋ 每颗带名字 ＋ 数量＝明文空间数", async () => {
    // owner 2026-10-10 的截图那一排（工作／运营／山焦招标…）⇒ 去掉前缀后每颗都短一截 ✓
    const plains = ["工作", "运营", "山焦招标"];
    mocks.overview.mockResolvedValue([encView("enc"), ...plains.map((n) => plainView(n))]);
    mocks.workspaces.mockResolvedValue([
      { id: "enc", name: "加密空间" },
      ...plains.map((n) => ({ id: n, name: n })),
    ]);
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    const box = escapeBox();
    expect(box, "有明文空间 ⇒ 那一段必须在").not.toBeNull();
    const btns = [...box!.querySelectorAll("button")];
    // ⭐ d) 回归闸：按钮数量**等于**明文空间数（⛔ 别顺手改成只给一个 ✗）
    expect(btns.length, "明文空间有几个就要给几条路").toBe(plains.length);
    for (const [i, b] of btns.entries()) {
      const t = b.textContent ?? "";
      // ⭐ a) 前缀必须去掉（⭐ 旧行为**必红** —— owner 那张截图就是红读数 ✓）
      expect(t, `第 ${i + 1} 颗按钮不许再带「放弃打开它，」前缀`).not.toContain("放弃打开");
      // ⭐ c) 每颗仍要带自己的空间名（⛔ 不许出现一排光秃秃的「去」✗）
      expect(t, `第 ${i + 1} 颗按钮要带上空间名「${plains[i]}」`).toContain(plains[i]);
    }
  });

  it("⭐ a2) 点一下就换过去：闸门随之放开，明文空间**直接可用**", async () => {
    fixture();
    await render();

    // 换过去之后内核会这么报：**活动空间**不再加密，而会话**仍然锁着** ✓（锁定是会话级 ✓）
    mocks.status.mockResolvedValue({ enabled: false, locked: true });

    await act(async () => {
      (host.querySelector('[data-testid="lock-go-plain"]') as HTMLButtonElement).click();
    });
    await settle();

    expect(mocks.setActive, "要走内核那条换空间的路").toHaveBeenCalledWith("plain");
    expect(host.querySelector(".lock-screen"), "明文空间不该再被拦").toBeNull();
    expect(host.querySelector(".app"), "明文空间必须能直接用").not.toBeNull();
  });

  it("⭐ b) 反向：加密空间未解锁 ⇒ 仍然读不出来（⛔ 不许修成「谁都能开」）", async () => {
    // 只有加密空间、**没有**明文出路 ⇒ 一个字节都不许松
    mocks.overview.mockResolvedValue([encView("enc")]);
    mocks.workspaces.mockResolvedValue([{ id: "enc", name: "加密空间" }]);
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    expect(host.querySelector(".lock-screen")).not.toBeNull();
    expect(host.querySelector(".app"), "没有出路时就该老实挡着").toBeNull();
    expect(escapeBox(), "没有明文空间时不许摆那个空盒子").toBeNull();
    expect(vaultState().locked, "仍然锁着").toBe(true);
  });

  it("⭐ c) 反向：换到明文空间**不是**「偷偷解锁」（会话仍然锁着）", async () => {
    fixture();
    await render();
    // ⚠️ 用**增量**判，不用"从没调过"：同一个文件里前面的用例已经调解锁过 ✓。
    const before = mocks.unlockEncryption.mock.calls.length;
    mocks.status.mockResolvedValue({ enabled: false, locked: true });

    await act(async () => {
      (host.querySelector('[data-testid="lock-go-plain"]') as HTMLButtonElement).click();
    });
    await settle();

    // ⭐ 出路是"换空间"，⛔ 不是"解锁"✗ —— 锁还在，主密钥没被放出来 ✓
    expect(vaultState().locked, "换空间不许顺手把会话解锁").toBe(true);
    expect(mocks.unlockEncryption.mock.calls.length, "⛔ 不许在背后调解锁").toBe(before);
  });

  it("⭐ d) 回归：本机**没有**加密空间 ⇒ 一个字节都不变（不出现锁定屏、也不出现那一段）", async () => {
    mocks.overview.mockResolvedValue([plainView("plain")]);
    mocks.workspaces.mockResolvedValue([{ id: "plain", name: "明文空间" }]);
    mocks.status.mockResolvedValue({ enabled: false, locked: false });

    await render();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app"), "没有加密空间 ⇒ 直接进外壳（同旧行为）").not.toBeNull();
    expect(escapeBox(), "没锁就不该有那一段").toBeNull();
    expect(vaultState()).toMatchObject({ enabled: false, locked: false, ready: true });
  });

  it("⭐ 出路读不到时**如实不给**（⛔ 不摆一个点不动的空间名）", async () => {
    mocks.overview.mockRejectedValue(new Error("no such command"));
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    expect(host.querySelector(".lock-screen"), "闸门照旧").not.toBeNull();
    expect(escapeBox(), "读不到就不给路，但也不假报有一个").toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-10（owner 从**锁屏截图**里量出来的）：
//   ① 解锁失败那一行漏出了 SQLCipher 的英文原文（截图逐字：`file is not a database`）✗
//   ② owner 已拍「**不改，就现在这样**」✗ —— 「已连续输错 N 次」的计数只查只报：
//      `LockScreen` 用的是普通组件 state（`useState(0)`）+ 进程级会话，**没有任何持久化**
//      ⇒ 窗口重载/应用重启后必然从 0 重新数 ✓。本文件**只钉前端不许自己造映射**这一半 ✓
//      （⛔ 不在这里改行为，也⛔ 不顺手加持久化）。
// ══════════════════════════════════════════════════════════════════════════

/** 真的往输入框里打字（React 受控组件的原生 setter 写法）——否则 `submit()` 会被 `!pass` 挡掉。 */
function typePassphrase(v: string) {
  const el = host.querySelector(".lock-input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
/** 点「解锁」（DOM 里第一个 `.lock-button` 就是它；出路那段的按钮在它后面）。 */
async function clickUnlock() {
  await act(async () => {
    typePassphrase("随便打的");
  });
  await act(async () => {
    (host.querySelectorAll(".lock-button")[0] as HTMLButtonElement).click();
  });
  await settle();
}

describe("① 解锁失败那句话：只透传内核那一份翻译，⛔ 前端不许自己造第二条映射", () => {
  it("⭐ c) 正面：内核给什么就逐字显示什么，且用户可见文本里**没有**英文原文", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    // 内核（`Result<(), String>`）给的那一份 —— 可操作的中文，**不含** `file is not a database` ✓
    const KERNEL =
      "空间 s1 的库打不开：口令/密钥不对（最常见）：确认大小写、输入法、以及是不是另一台设备的口令；" +
      "也可能是这个库用了另一种页加密算法（换过构建的话见 docs/SM-CRYPTO-DELIVERY.md）。";
    mocks.unlockEncryption.mockRejectedValue(KERNEL);
    await render();

    await clickUnlock();

    const shown = host.querySelector(".lock-error")?.textContent ?? "";
    expect(shown, "内核那句必须逐字到达用户面（前端只透传）").toContain(KERNEL);
    expect(shown, "⭐ 截图那一幕：用户可见文本里不许出现英文原文").not.toMatch(/not a database|malformed/);
    expect(shown, "要有可操作的话（说清怎么确认口令）").toContain("口令");
  });

  it("⭐ c) 反向：前端**不许**自己做英文→中文的映射（内核认不出的英文必须原样透传）", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    // 一句内核翻译函数**不认识**的英文 ⇒ 若前端悄悄把它换成中文，本用例红 ✗
    // （真因见 `src-tauri/src/security.rs` 的 `cipher_open_error`：只翻认得的那两句，其余原样返回。）
    const UNKNOWN = "unable to open database file";
    mocks.unlockEncryption.mockRejectedValue(UNKNOWN);
    await render();

    await clickUnlock();

    const shown = host.querySelector(".lock-error")?.textContent ?? "";
    expect(shown, "前端只负责显示：内核给什么就显示什么（⛔ 第二条映射会随上游改版静默失效）").toContain(
      UNKNOWN,
    );
  });
});

describe("④ 启动口径：跟**最后离开的那个**空间（⛔ 不许每次从最早那个开始）", () => {
  it("⭐ h+j) 最后离开的是**明文**空间 ⇒ 启动不出现锁屏（最早那个是加密的也不行）", async () => {
    // ⚠️ **夹具形状必须自证**：最早的是加密的、最后离开的是明文的 ⇒ 两者**不是同一个** ✓
    //    （否则这条退化成"最早＝最后"，就测不出 ④ 的反向了 ✓）
    const views = [encView("old-enc"), plainView("plain-last")];
    expect(views[0].encrypted_on_disk, "夹具：最早那个是**加密**的").toBe(true);
    expect(views[1].encrypted_on_disk, "夹具：最后离开的是**明文**的").toBe(false);
    mocks.overview.mockResolvedValue(views);
    mocks.workspaces.mockResolvedValue([
      { id: "old-enc", name: "老加密空间" },
      { id: "plain-last", name: "明文空间" },
    ]);
    // 内核按**活动（最后离开的）**空间报：不加密 ⇒ ⭐ 这一格就是 ④ 的判据
    mocks.status.mockResolvedValue({ enabled: false, locked: true });

    await render();

    expect(
      host.querySelector(".lock-screen"),
      "活动空间是明文 ⇒ ⛔ 不许拿「最早那个加密空间」把人挡在启动处",
    ).toBeNull();
    expect(host.querySelector(".app"), "直接进最后离开的那一个").not.toBeNull();
  });

  it("⭐ i) 最后离开的是**加密**空间 ⇒ 出锁定屏（解锁 ＋ 选择空间两段都在）", async () => {
    const views = [plainView("plain-first"), encView("enc-last")];
    expect(views[0].encrypted_on_disk, "夹具：最早那个是**明文**的").toBe(false);
    expect(views[1].encrypted_on_disk, "夹具：最后离开的是**加密**的").toBe(true);
    mocks.overview.mockResolvedValue(views);
    mocks.workspaces.mockResolvedValue([
      { id: "plain-first", name: "明文空间" },
      { id: "enc-last", name: "加密空间" },
    ]);
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    expect(host.querySelector(".lock-screen"), "活动空间加密且没解锁 ⇒ 必须出锁定屏").not.toBeNull();
    expect(host.querySelector(".app")).toBeNull();
    // ⭐ 「解锁 ／ 选择空间」两段都要在：本机确有明文空间 ⇒ 换空间那条路必须同时给出来 ✓
    expect(escapeBox(), "本机有明文空间 ⇒ 同时给出「选择空间」那一段").not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-10（owner 拍 A）：「从**明文**空间切到**未解锁的加密**空间 ⇒ 解锁屏必须真的出来」。
//
// 本段是**渲染级**判据（⛔ 不拿「代码里有那段」当验收 ✗）：走 store 那条**与界面同一条**的动作
// （`switchTo` ✓，侧栏那一行点的也是它 ✓）⇒ 读回内核读数 ⇒ 闸门 ⇒ **DOM**。
//
// 三样（Lead 点名 ✓）：
//   ① 锁屏**真的渲出来**（且上面有一个**可输口令的输入框** ✓）
//   ② **反向**：切到**明文**空间 ⇒ 锁屏⛔ **不**出现（挡「见谁都拦」✗ —— owner 上次报过那条 ✓）
//   ③ ⭐ 锁屏**不是**靠「偷偷解锁」换来的：一次 `unlockEncryption` 都没发生，且外壳（那个空间的内容）没渲染
// ⚠️ 「那个加密库**一个字节都没被读**」那一半在 **Rust** 判据 e)（`PRAGMA database_list` ✓）——
//    渲染链**观测不到文件读**，所以这里**不假装**能判它 ✓（只说清"没渲染 ⇒ 用户看不到内容" ✓）。
describe("⭐ 从明文空间切到未解锁的加密空间：解锁屏必须真的出来", () => {
  /** 起始：活动空间是**明文**的 ⇒ 外壳渲染、没有锁屏。 */
  function startPlaintext() {
    mocks.overview.mockResolvedValue([encView("enc"), plainView("plain")]);
    mocks.workspaces.mockResolvedValue([
      { id: "enc", name: "加密空间" },
      { id: "plain", name: "明文空间" },
    ]);
    mocks.status.mockResolvedValue({ enabled: false, locked: false });
  }

  it("① 切过去 ⇒ 锁屏渲染出来，且上面有可输口令的输入框", async () => {
    startPlaintext();
    await render();
    expect(host.querySelector(".lock-screen"), "先在明文空间：不该有锁屏").toBeNull();
    expect(host.querySelector(".app"), "明文空间 ⇒ 外壳要渲染").not.toBeNull();

    // 用户切到那个**加密**空间（界面上点那一行走的就是这条 store 动作 ✓）；
    // 内核这次**不再拒绝**（本笔修好的那一条 ✓）⇒ 它报「加密在盘上 ＋ 本会话拿不到钥匙」。
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    await act(async () => {
      await useSpaceStore.getState().switchTo("enc");
    });
    await settle();

    expect(mocks.setActive, "要走内核那条换空间的路").toHaveBeenCalledWith("enc");
    expect(host.querySelector(".lock-screen"), "⭐ 切到未解锁的加密空间 ⇒ 锁屏必须出来").not.toBeNull();
    expect(host.querySelector(".lock-input"), "锁屏上要真的有一个可输口令的输入框").not.toBeNull();
    expect(host.querySelector(".app"), "锁屏期间外壳不挂载").toBeNull();
  });

  it("② 反向：切到**明文**空间 ⇒ 锁屏⛔ 不出现（挡「见谁都拦」）", async () => {
    fixture(); // 起始在**加密**锁屏
    await render();
    expect(host.querySelector(".lock-screen"), "夹具前提：先在锁屏").not.toBeNull();

    mocks.status.mockResolvedValue({ enabled: false, locked: false });
    await act(async () => {
      await useSpaceStore.getState().switchTo("plain");
    });
    await settle();

    expect(host.querySelector(".lock-screen"), "⭐ 明文空间⛔ 不许被拦（owner 上次报的就是这个 ✗）").toBeNull();
    expect(host.querySelector(".app"), "明文空间 ⇒ 外壳要回来").not.toBeNull();
  });

  it("③ 锁屏不是靠「偷偷解锁」换来的：一次 `unlockEncryption` 都没有 ＋ 那个空间的内容没渲染", async () => {
    startPlaintext();
    await render();
    const before = mocks.unlockEncryption.mock.calls.length;

    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    await act(async () => {
      await useSpaceStore.getState().switchTo("enc");
    });
    await settle();

    expect(mocks.unlockEncryption.mock.calls.length, "⛔ 不许在背后替用户解锁").toBe(before);
    expect(host.querySelector(".lock-screen")).not.toBeNull();
    expect(host.querySelector(".app"), "锁屏期间那个空间的内容一个都不渲染").toBeNull();
  });

  // ⚠️⭐ **这条用例钉的是"锁屏随闸门挂／卸"，⛔ 不是"④（挂载时清 err）在起作用"** ✗ ——
  //   Lead 2026-10-10 拍 (a)：④ 留着当**双保险** ✓（无害 ✓），但**账上不许把它写成"验过了"** ✗。
  //   ⭐ 实测（就为这条做的体检）：把 ④ 那两行**摘掉**再跑本文件 ⇒ **照样 21 passed** ✗
  //     —— 真因：切走时锁屏**整块卸载** ✓、切回来是**重新挂载** ⇒ React 状态本来就归零 ✓
  //     ⇒ ④ 在"切走再切回来"这个流程上**是空操作** ✓（⚠️ "看起来有、其实没牙"那种形状 ✓）。
  //   ⭐ 那它为什么还值得留：若**哪天**锁屏不再随闸门卸载（改动 App 的闸门形状就可能）⇒ 本用例**会红** ✓
  //     ⇒ 所以它**有用** ✓，只是**不是** ④ 的判据 ✓。
  //   ⚠️ ④ 本身**没有**判据（"锁屏不卸载而目标空间变了"那种流程当前界面上不存在 ✓——
  //     锁屏的出路只列**明文**空间 ⇒ 选了就走 ✓）。
  it("锁屏随闸门挂／卸：切走时整块卸载 ＋ 切回来不带上一轮报错（⛔ 不覆盖 ④ 的效果）", async () => {
    fixture();
    await render();

    // 先看见一次报错（输一次错口令）
    mocks.unlockEncryption.mockRejectedValueOnce(new Error("打不开：口令不对，或者这把锁被改过"));
    const input = host.querySelector(".lock-input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "wrong-pass");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const btn = host.querySelector(".lock-button") as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();
    expect(host.querySelector(".lock-error"), "夹具前提：先得看见一次报错").not.toBeNull();

    // 切走（明文空间）⇒ 锁屏消失；再切回那个加密空间 ⇒ 锁屏再来
    mocks.status.mockResolvedValue({ enabled: false, locked: false });
    await act(async () => {
      await useSpaceStore.getState().switchTo("plain");
    });
    await settle();
    expect(host.querySelector(".lock-screen"), "切到明文 ⇒ 锁屏该消失").toBeNull();

    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    await act(async () => {
      await useSpaceStore.getState().switchTo("enc");
    });
    await settle();
    expect(host.querySelector(".lock-screen"), "切回来 ⇒ 锁屏再来").not.toBeNull();
    // ⭐ 关键：⛔ 不许还挂着**上一次**那句报错
    expect(host.querySelector(".lock-error"), "⭐ 人还没输就先看到上一轮的报错 ✗").toBeNull();
  });
});
