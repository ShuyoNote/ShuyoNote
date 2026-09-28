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
// B 片 ①-a（2026-09-25）：不经服务器的换设备（配对码）。
const pairingExport = vi.fn();
const pairingImport = vi.fn();
// ★ B 片 ①-a 的"存/读文件"（2026-09-25）：平台 dialog ＋ 文本读写。
const dialogSave = vi.fn();
const dialogOpen = vi.fn();
const writeTextFile = vi.fn();
const readTextFile = vi.fn();
// ★ 2026-09-25：开/关加密之后**必须重读状态中枢**（`vault.ts::refreshVault` 走的就是这条内核读数）
// —— 否则「会话锁定」整节（`SettingsDialog` 里由 `useVault().enabled` 控制）要等**重启**才出现。
const encryptionStatus = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    spaceSecurityOverview: (...a: unknown[]) => spaceSecurityOverview(...a),
    setSpaceKind: (...a: unknown[]) => setSpaceKind(...a),
    enableSpaceEncryption: (...a: unknown[]) => enableSpaceEncryption(...a),
    disableSpaceEncryption: (...a: unknown[]) => disableSpaceEncryption(...a),
    pushSpaceKeyring: (...a: unknown[]) => pushSpaceKeyring(...a),
    pullSpaceKeyring: (...a: unknown[]) => pullSpaceKeyring(...a),
    pairingExport: (...a: unknown[]) => pairingExport(...a),
    pairingImport: (...a: unknown[]) => pairingImport(...a),
    writeTextFile: (...a: unknown[]) => writeTextFile(...a),
    readTextFile: (...a: unknown[]) => readTextFile(...a),
    encryptionStatus: (...a: unknown[]) => encryptionStatus(...a),
  },
}));

vi.mock("../lib/platform", () => ({
  isDesktopPlatform: () => flags.desktop,
  // ★ B 片 ①-a 的"存/读文件"那一半（2026-09-25）：走平台 dialog ＋ api 的文本读写。
  platform: {
    dialog: {
      save: (...a: unknown[]) => dialogSave(...a),
      open: (...a: unknown[]) => dialogOpen(...a),
    },
  },
}));

import type { SpaceSecurityView } from "../lib/api";
import { __resetVaultForTests, vaultState } from "../lib/vault";
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
      pairingExport,
      pairingImport,
      dialogSave,
      dialogOpen,
      writeTextFile,
      readTextFile,
      encryptionStatus,
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
  /** ★ A2：那一枚「我已保管好主口令」勾选框（开启加密的前置）。 */
  const ackBox = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="我已保管好主口令"]')!;
  /** ★ A2：走完"开启加密"的前置 —— 勾上那句话。 */
  const ackNoRecovery = async () => {
    await act(async () => {
      ackBox().click();
    });
  };

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

  it("②b ★ 后端文案里的 `**强调**` 渲染成 <b>，界面上**不许**出现两个星号", async () => {
    // 后端（Rust）那几句是按 Markdown 行内写法写的；这条钉"显示的最后一跳"把它渲染掉
    //（owner 2026-09-24 拿截图当场指出过：面板上直接露着 `**`）。
    const withMd: SpaceSecurityView = {
      ...personal,
      gate: {
        allow: false,
        unclassified: false,
        reason: "空间「default」是个人空间但还没有加密：先给它**开启加密**",
      },
    };
    spaceSecurityOverview.mockResolvedValue([withMd]);
    await render();
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).toContain("开启加密");
    expect(container.querySelector(".space-privacy-gate b")?.textContent).toBe("开启加密");
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
    await ackNoRecovery(); // ★ A2：开启加密的前置
    await act(async () => {
      buttons()[0].click();
    });

    expect(enableSpaceEncryption).toHaveBeenCalledWith("default", "我家猫叫mimi");
  });

  // ---------------------------------------------------------------------------
  // ★ A2（owner 2026-09-25 拍板）：**开启加密之前必须先把"忘了就没了"读进去**
  // ---------------------------------------------------------------------------
  //
  // 为什么要有这两条：零知识＝零恢复，口令丢了**数据永久打不开**。这句真话今天只在
  // **锁定屏**（连错 3 次之后）说 —— 那时候用户已经记不住了，等于事后通知。
  // `docs/identity-privacy-roadmap.md:34` 早就写着"开启前必须勾选确认"，而代码里一直没有
  // ⇒ 这两条把"用户真的被告知过"这件事钉成可执行的判据（改文案会连判据一起红）。
  it("⑪ ★ 没勾「我已保管好主口令」⇒ **点不动**开启加密（且那句真话在屏幕上）", async () => {
    spaceSecurityOverview.mockResolvedValue([personal]);
    enableSpaceEncryption.mockResolvedValue([]);
    await render();

    // ① 那句话必须在**开启之前**就看得见（不是点了才弹）
    expect(container.textContent).toContain("真的打不开了");
    expect(container.textContent).toContain("没有第二把备份钥匙");
    // ② 没勾 ⇒ 按钮是灰的，而且**点了也真的不调 api**（disabled 不只是视觉）
    const open = buttons().find((b) => b.textContent === "开启加密")!;
    expect(open.disabled).toBe(true);
    await act(async () => {
      open.click();
    });
    expect(enableSpaceEncryption).not.toHaveBeenCalled();
    expect(ackBox().checked).toBe(false);
  });

  it("⑫ ★ 勾上之后才点得动 —— 而且勾选框**按空间记**（一行勾了不算另一行）", async () => {
    // 两个都没加密的空间：勾了第一个，第二个的按钮必须还是灰的
    const other: SpaceSecurityView = { ...personal, space_id: "sp-2" };
    spaceSecurityOverview.mockResolvedValue([personal, other]);
    enableSpaceEncryption.mockResolvedValue([]);
    await render();

    const openButtons = () => buttons().filter((b) => b.textContent === "开启加密");
    expect(openButtons()).toHaveLength(2);
    await ackNoRecovery();

    expect(openButtons()[0].disabled).toBe(false);
    expect(openButtons()[1].disabled, "勾的是第一个空间，第二个不该跟着解锁").toBe(true);

    await act(async () => {
      openButtons()[0].click();
    });
    expect(enableSpaceEncryption).toHaveBeenCalledWith("default", undefined);
  });

  // ---------------------------------------------------------------------------
  // ★ 2026-09-25（Windows 侧定性、AMD 侧落）：**"改了数据、忘了刷新一个状态中枢"**这一族
  // ---------------------------------------------------------------------------
  //
  // 现场（MIX 2 真机）：给活动空间**开启加密成功后**，「设置 → 安全」里那行「已加密 · 已解锁」＋
  // **「立即锁定」按钮直到重启才出现**。根因不是条件写窄，而是 `run()` 成功后只 `reload()` 了
  // **本节自己的视图**，没有刷新 `vault` 状态中枢 —— 而整节由 `SettingsDialog` 里
  // `useVault().enabled` 控制（那读的是内核读数）。
  //
  // 为什么必须补这条判据：这个 bug **不会让任何既有判据变红**（既有用例都直接打桩 api、
  // 不经过 UI 的 store 刷新路径）⇒ 没有它就会以"重启才生效"的形态复发。
  // 判据形态刻意选**行为**（vault 读数真的变了），而不是"调用了 refreshVault"：
  // 前者是用户会撞上的那件事，后者只是实现细节。
  it("★ 开启加密成功后 ⇒ **状态中枢**必须跟着变（否则「会话锁定」整节要等重启才出现）", async () => {
    __resetVaultForTests();
    spaceSecurityOverview.mockResolvedValue([personal]);
    enableSpaceEncryption.mockResolvedValue([]);
    // 内核读数：这一步之后活动空间**已经是加密的**了（这正是 refreshVault 要去问的东西）
    encryptionStatus.mockResolvedValue({ enabled: true, locked: false });

    await render();
    expect(vaultState().enabled).toBe(false); // 起点：中枢还不知道

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      setValue(input, "我家猫叫mimi");
    });
    await ackNoRecovery(); // ★ A2：开启加密的前置
    await act(async () => {
      buttons()[0].click();
    });

    expect(enableSpaceEncryption).toHaveBeenCalledWith("default", "我家猫叫mimi");
    expect(encryptionStatus).toHaveBeenCalled(); // 真的去问了一次内核
    expect(vaultState().enabled).toBe(true); // ← 这一条就是「会话锁定」整节会不会出现
  });

  it("★ 关掉加密成功后同样刷新（反向也要：否则那一节会一直留着「立即锁定」）", async () => {
    __resetVaultForTests();
    spaceSecurityOverview.mockResolvedValue([encrypted]);
    disableSpaceEncryption.mockResolvedValue(null);
    encryptionStatus.mockResolvedValue({ enabled: false, locked: false });

    await render();
    // 「关闭加密」是两步：第一下只确认，第二下才真的动库
    await act(async () => {
      buttons()[0].click();
    });
    await act(async () => {
      buttons()[0].click();
    });

    expect(disableSpaceEncryption).toHaveBeenCalledWith("default");
    expect(vaultState().enabled).toBe(false);
  });

  it("⑨ ★ 「推到服务器」⇒ 真调 `pushSpaceKeyring(id)`，并把后端那句话**原样**显示", async () => {
    // ⚠️ 用 `encrypted` 夹具：换设备那一组动作现在**只对真的加密了的空间**出现
    //    （明文空间没有公开材料可推可取，那两个按钮只会报错）⇒ 折叠里才有按钮。
    spaceSecurityOverview.mockResolvedValue([encrypted]);
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
    spaceSecurityOverview.mockResolvedValue([encrypted]);
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

  // ── B 片 ①-a（2026-09-25）：不经服务器的换设备（配对码）────────────────────────
  //   这一组动作是**钥匙袋级**的（载荷带全部空间）⇒ 界面上只该有一份。
  const byText = (text: string) =>
    buttons().find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  /** textarea 要用**它自己**的 value 描述符：拿 Input 的会 illegal invocation。 */
  const setArea = (el: HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("⑪ ★ 「生成配对码」真调 pairingExport()，把**比对码**与那段文本显示出来（且不露 `**`）", async () => {
    spaceSecurityOverview.mockResolvedValue([encrypted]);
    pairingExport.mockResolvedValue({
      outcome: "ok",
      text: '{"v":1,"material":"M","fp":"dev-1"}',
      check_code: "1234 5678 9012 3456 7890",
      bytes: 38,
      spaces: 2,
      device_id: "dev-1",
      qr_fits: true,
      qr_svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>",
      message: "把下面这段配对码交给第二台设备（2 个空间）。**只交给你自己那台设备**。",
    });
    await render();
    await act(async () => {
      byText("生成配对码")!.click();
    });
    expect(pairingExport).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("1234 5678 9012 3456 7890");
    const area = container.querySelector('textarea[aria-label="配对码"]') as HTMLTextAreaElement;
    expect(area.value).toContain('"material"');
    expect(container.textContent).not.toContain("**"); // 后端那句里的强调要渲染掉（本仓 ②b 的纪律）
    expect(container.textContent).toContain("只交给你自己那台设备");
    // ★ 装得下 ⇒ 真的显示一张二维码，而且走 **data URI**（不是把 SVG 注进 DOM）
    const img = container.querySelector(".space-privacy-qr") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")!.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  });

  it("⑫ ★ 比对码：填了才传 confirmed_check_code；没填传 undefined（不是空串）", async () => {
    spaceSecurityOverview.mockResolvedValue([encrypted]);
    pairingImport.mockResolvedValue({
      outcome: "ok",
      check_code: "9999 8888 7777 6666 5555",
      spaces: 2,
      local_spaces: [],
      would_lose: [],
      message: "已装进本机（2 个盒子）",
    });
    await render();
    const area = container.querySelector('textarea[aria-label="粘贴配对码"]') as HTMLTextAreaElement;
    await act(async () => {
      setArea(area, '{"v":1}');
    });

    await act(async () => {
      byText("核对并采纳")!.click();
    });
    expect(pairingImport).toHaveBeenLastCalledWith({
      text: '{"v":1}',
      confirmed_check_code: undefined,
      overwrite: false,
    });

    const code = container.querySelector('input[aria-label="比对码"]') as HTMLInputElement;
    await act(async () => {
      setValue(code, "9999 8888 7777 6666 5555");
    });
    await act(async () => {
      byText("核对并采纳")!.click();
    });
    expect(pairingImport).toHaveBeenLastCalledWith({
      text: '{"v":1}',
      confirmed_check_code: "9999 8888 7777 6666 5555",
      overwrite: false,
    });
  });

  it("⑬ ★ already_local ⇒ 摆出「会失去哪些空间」，且**默认那次 overwrite 必须是 false**", async () => {
    spaceSecurityOverview.mockResolvedValue([encrypted]);
    pairingImport.mockResolvedValue({
      outcome: "already_local",
      check_code: "1111 2222 3333 4444 5555",
      spaces: 0,
      local_spaces: ["default"],
      would_lose: ["old-b"],
      message: "覆盖会**失去**这些空间：old-b —— 覆盖之后那台设备再也开不开它自己的库。",
    });
    await render();
    const area = container.querySelector('textarea[aria-label="粘贴配对码"]') as HTMLTextAreaElement;
    await act(async () => {
      setArea(area, '{"v":1}');
    });
    await act(async () => {
      byText("核对并采纳")!.click();
    });
    expect(pairingImport).toHaveBeenLastCalledWith(expect.objectContaining({ overwrite: false }));
    expect(container.textContent).toContain("old-b");
    expect(container.textContent).not.toContain("**");

    await act(async () => {
      byText("我确认，覆盖本机")!.click();
    });
    expect(pairingImport).toHaveBeenLastCalledWith(expect.objectContaining({ overwrite: true }));
  });

  // ---------------------------------------------------------------------------
  // ★ B 片 ①-a 的"存/读文件"那一半（2026-09-25）
  // ---------------------------------------------------------------------------
  //
  // 为什么要有这两条：复制粘贴那条路在两台设备**不在同一屏**时要走一遍"发给自己"
  // （邮件/IM/网盘），而"存成文件再传"是本地优先那条路。两条都给，别替用户选 ——
  // 而这条路上有两个**静默失败**的常见形态，正是这两条判据要挡的：
  //   ① 没生成码就点"存成文件"（存出个空文件）；
  //   ② 用户**取消**了另存对话框，而代码照样往下写（写出一个半截文件 / 报一句莫名其妙的错）。
  it("⑭ ★ 存成文件：默认名里带**比对码**，内容就是那段载荷；取消另存 ⇒ **一个字都不写**", async () => {
    spaceSecurityOverview.mockResolvedValue([encrypted]);
    pairingExport.mockResolvedValue({
      check_code: "1111 2222 3333 4444 5555",
      text: '{"v":1,"material":{}}',
      message: "已生成配对码",
    });
    writeTextFile.mockResolvedValue(undefined);
    await render();

    // ① 还没生成码 ⇒「存成文件」是灰的（否则会存出一个空文件）
    const saveBtn = () => byText("存成文件") as HTMLButtonElement;
    expect(saveBtn().disabled).toBe(true);
    await act(async () => {
      byText("生成配对码")!.click();
    });
    expect(saveBtn().disabled).toBe(false);

    // ② 用户取消 ⇒ 不许写盘
    dialogSave.mockResolvedValue(null);
    await act(async () => {
      saveBtn().click();
    });
    expect(dialogSave).toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();

    // ③ 真的选了路径 ⇒ 写的就是那段载荷，且默认名带比对码（两台设备对不上时一眼看出传错哪份）
    dialogSave.mockResolvedValue("C:\\tmp\\pair.txt");
    await act(async () => {
      saveBtn().click();
    });
    expect(writeTextFile).toHaveBeenCalledWith("C:\\tmp\\pair.txt", '{"v":1,"material":{}}');
    const opts = dialogSave.mock.calls[dialogSave.mock.calls.length - 1][0] as { defaultPath: string };
    expect(opts.defaultPath).toContain("1111 2222 3333 4444 5555");
  });

  it("⑮ ★ 从文件读取：把内容填进文本框，但**绝不自动采纳**（采纳永远要人点第二步）", async () => {
    spaceSecurityOverview.mockResolvedValue([encrypted]);
    dialogOpen.mockResolvedValue(["C:\\tmp\\pair.txt"]);
    readTextFile.mockResolvedValue('{"v":1,"material":{"spaces":{}}}');
    await render();

    await act(async () => {
      byText("从文件读取")!.click();
    });
    const area = container.querySelector('textarea[aria-label="粘贴配对码"]') as HTMLTextAreaElement;
    expect(area.value).toBe('{"v":1,"material":{"spaces":{}}}');
    // ★ 读进来只是"填好"，**没有**调过采纳 —— 用户还要核对比对码再点那一下
    expect(pairingImport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("一致再点");
  });
});
