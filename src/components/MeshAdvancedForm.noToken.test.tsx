// ⭐ **P1.5 追加件（owner 2026-10-13 拍：「去掉同步面板的那个口令」）** —— 判据 ✓。
//
// ⛔ 依据（逐字，Lead 已核实 ✓）：
//   · `mesh.rs:787`「⛔ 不是用户手打的口令 ✗（用户手打的那条 `mesh_token` **已经退役** ✓）」
//   · `mesh.rs:1727`「旧的 `mesh_token:<space>` KV **保留可读**（不静默删 ✓）但**不再作任何凭证** ✗」
//   ⇒ ⭐ 所以那一格「口令」**删得安全** ✓（⛔ 但**后端不许删数据** ✗：KV 与 `get_mesh_config` 的读取**保留** ✓）。
//
// ⚠️ 本文件**先红后绿**：
//   · 今天红 ①：同步面板那块**还渲染着**「口令」输入格 ＋ 「设口令」按钮 ✗；
//   · 今天红 ②：它那两句文案**直接冲突** `mesh.rs:1727` ✗ ——
//     逐字「口令：**已设** —— ⚠️ **它是这个空间的唯一防线**…」／「**没设 = 不设防**」✗。
//   ⭐ 另有两条**锁**（今天已绿 ✓，不是本片的修 ✗）：
//     · 后端 `mesh_token` 的 KV **仍可读** ✓（防"顺手把数据也删了"✗）；
//     · ⭐ **主口令那条线不许被误伤** ✗（`SpacePrivacySection.tsx` 的「主口令」仍在 ✓ —— 那是**加密**那条线 ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MeshAdvancedForm } from "./MeshAdvancedForm";
import type { LanStatus } from "../lib/platform/commands";

// ⭐ 2026-10-13（owner：「地址那格不是应该自动吗？」＋ Lead 拍）：本文件新增两条判据要**真点那颗按钮**，
//    所以要把 `api.meshSetConfig` 换成**能记账的桩**（⛔ 只记调用，⛔ 不编后端读数 ✗）。
//    ⚠️ 本仓 vitest 里 `vi.mock` 工厂**返回 `new Proxy(...)` 会直接炸**（`Cannot create proxy with a
//    non-object as target or handler`，0 test、无栈）⇒ 一律用**普通对象**把键列全 ✓。
const mocks = vi.hoisted(() => ({ meshSetConfig: vi.fn() }));
vi.mock("../lib/api", () => ({
  api: {
    meshSetConfig: (...a: unknown[]) => mocks.meshSetConfig(...a),
  },
}));

const REPO = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** ⚠️ `tokenSet: true` ⇒ 走**今天**那句「唯一防线」的分支 ✓（＝先红那一支 ✓）。
 *  `bind` 默认给已保存值；⭐ 新判据要量"**什么都没保存**（`bind: ''`）时输入框显示什么"⇒ 显式传 `""` ✓。 */
function lanStatus(tokenSet: boolean, bind = "0.0.0.0:8788"): LanStatus {
  return {
    enabled: true,
    peers: 0,
    kind: "lan",
    line: "同步地址：直连（局域网）",
    mesh: { enabled: true, bind, tokenSet, window: "192.168.0.0/24", note: "" },
    nearby: [],
  } as unknown as LanStatus;
}

function render(tokenSet = true, bind = "0.0.0.0:8788"): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root!.render(
      <MeshAdvancedForm
        activeId="ws-1"
        lanStatus={lanStatus(tokenSet, bind)}
        onStatus={() => {}}
        onMeshChanged={() => {}}
      />,
    ),
  );
  return host;
}

/** 让"点一下 ⇒ await 命令 ⇒ onStatus"这条异步链跑完（本仓无 @testing-library ⇒ 手搓微任务 ✓）。 */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    flushSync(() => {});
  }
}

/** 监听地址那一格（`MeshAdvancedForm.tsx:120-126` 的 placeholder 是**它**独有的一格 ✓）。 */
const bindInput = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLInputElement>("input.sync-input")].find((i) =>
    (i.getAttribute("placeholder") ?? "").includes("监听地址"),
  ) ?? null;

describe("P1.5 追加件：同步面板不再有「口令」那一格", () => {
  it("1) ⭐ 渲染后**不许存在**「口令」输入格与「设口令」按钮（今天【红】：它就在 ✓）", () => {
    const el = render();
    const inputs = [...el.querySelectorAll("input")];
    const phs = inputs.map((i) => i.getAttribute("placeholder") ?? "");
    expect(
      phs.some((p) => p.includes("口令")),
      `⛔ 面板里还有「口令」输入格 ✗（它是**已退役**的那一格 ⇒ owner 拍了去掉 ✓）：实测 placeholder = ${JSON.stringify(phs)}`,
    ).toBe(false);
    expect(el.textContent ?? "", "⛔ 「设口令」那颗按钮也该一起走 ✗").not.toContain("设口令");
  });

  it("2) ⭐ 文案**不许**再写「唯一防线」／「没设 = 不设防」（今天【红】：与 `mesh.rs:1727` 直接冲突 ✗）", () => {
    const on = render(true).textContent ?? "";
    expect(on, "⛔ 「唯一防线」是**过时**的说法（那格已退役 ✓）").not.toContain("唯一防线");
    expect(on, "⛔ 「不设防」同样过时 ✗").not.toContain("不设防");
    expect(on, "⭐ 必须说清那格**已不再用于鉴权** ✓").toContain("不再用于鉴权");
  });

  it("3) ⭐ 锁（今天已绿 ✓，不是本片的修）：`mesh_token` 的 KV **仍可读** ⇒ ⛔ 没有顺手删数据 ✗", () => {
    const meshRs = read("src-tauri/src/mesh.rs");
    expect(meshRs, "⛔ 后端把 `mesh_token` 的读取删了 ＝ 静默删数据 ✗（口径：保留可读 ✓）").toContain(
      'read_setting(c, "mesh_token"',
    );
    expect(meshRs, "⭐ 那句「不再作任何凭证」的口径也要在（它是这一格的判据来源 ✓）").toContain("不再作任何凭证");
  });

  it("4) ⭐ 锁（今天已绿 ✓）：⭐ **主口令那条线不许被误伤** ✗（那是**加密**那条线 ✓）", () => {
    const privacy = read("src/components/SpacePrivacySection.tsx");
    expect(privacy, "⛔ 把「主口令」一起删了 ✗ —— 它与已退役的 `mesh_token` **不是一回事** ✓").toContain(
      "主口令",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **2026-10-13（owner 问：「地址那格不是应该自动吗？」＋ Lead 核实＋拍板）**：
//   ⭐ 设计里**本来就是自动** ✓（`docs/specs/2026-09-29-nearby-devices-spec.md:893/897/910`
//      ＋ `2026-09-29-personal-edition-requirements.md:26` 的 **U5**「地址自动…换网后仍能报出可达地址」✓、
//      `:27` 的 **U6**「配对后重启两台 ⇒ 无需任何操作即同步」✓）；
//   ⭐ 代码里"自动"那半**已落地** ✓（通配放行 `mesh.rs:3075` ✓、枚举 `announced_base mesh.rs:1509` ✓、
//      `announced_bases_with_named`（WLAN 排第一）✓、`is_unspecified` 分支 `:1232` ✓）；
//   ⚠️ **只差两件**（本组＝**修**：先红后绿 ✓）：① 那格默认值**是空** ✗ ⇒ 预填建议值 ✓；
//      ② 开启要**点两下**（先填再点保存）✗ ⇒ 加一颗**一键** ✓。
//
// ⭐ Lead 拍的两条口径（逐字照做 ✓）：
//   · ⭐ **不许把网格改成"默认自动开"** ✗ —— 拍的是「**保留默认关，但让开启变成一下**」✓
//     （理由：网格会**监听所有网卡** ⇒ 未经用户动作就自动开属**安全相关默认值** ✗ ⇒
//       本仓规矩"默认值只取零风险" ✓；而 U6「配对后重启无需操作」在**保存过之后**已经满足 ✓ ——
//       窗口在**进程启动**时开 ✓ `lan_state.rs:748` ✓）；
//   · ⚠️ U6 的**真机端到端**（配对 ⇒ 重启两台 ⇒ 零操作即同步 ✓）⭐ **只能真机 ⇒ P5** ✗
//     （现有 loopback 判据**证不了**"重启后仍自动"✗）。
//
// ⛔ **不是**既有那条"短码/口令"线 ✗：这两条只动**前端默认值与一个按钮** ✓，⛔ 不碰协议 ✗。
// ═══════════════════════════════════════════════════════════════════════════════
describe("追加件（owner：「地址那格不是应该自动吗？」）：预填 ＋ 一键自动开", () => {
  it("5) ⭐ **预填**：什么都没保存（`bind: ''`）⇒ 监听地址那格必须显示建议值 `0.0.0.0:8788`（今天【红】：是空的 ✓）", () => {
    const el = render(true, "");
    const input = bindInput(el);
    expect(input, "夹具前提：监听地址那一格要在（`MeshAdvancedForm.tsx:120-126`）").not.toBeNull();
    expect(
      input!.value,
      "⭐ 那格现在是**空**的 ✗ ⇒ 用户得自己知道该填什么 ✓；设计里「地址自动」（spec:893/897 ＋ U5 ✓）" +
        "⇒ 没保存过时应当**预填建议值** ✓（⛔ 不落库、⛔ 不改后端默认 ✓ —— 只是让人看见并一下点得动 ✓）",
    ).toBe("0.0.0.0:8788");
  });

  it("6) ⭐ **一键**：点一次「用自动选开启」⇒ 恰好调一次 `meshSetConfig('ws-1', '0.0.0.0:8788', null)`（今天【红】：没有那颗按钮 ✓）", async () => {
    mocks.meshSetConfig.mockReset();
    mocks.meshSetConfig.mockResolvedValue({ note: "网格已开", enabled: true, bind: "0.0.0.0:8788", tokenSet: true, window: "", note2: "" });
    const el = render(true, "");
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="mesh-auto-enable"]');
    expect(
      btn,
      "⭐ 必须有一颗**一键**（owner：自动应当是一下的事 ✓）—— 今天【红】：只有「保存地址」，" +
        "而没保存过时那格是空的 ⇒ 用户得先知道填什么、再点保存 ＝ **两步** ✗",
    ).toBeTruthy();

    flushSync(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(
      mocks.meshSetConfig.mock.calls.map((c) => [c[0], c[1], c[2]]),
      "⭐ 点一次就该用**通配**开起来（`0.0.0.0:8788`）＋ room 传 `null`（＝不动那一项 ✓，与 `api.ts:511-517` 同口径 ✓）",
    ).toEqual([["ws-1", "0.0.0.0:8788", null]]);
    // ⭐ 文案要说清它的**意思**（Lead 逐字）：绑通配 ⇒ 听所有网卡，报出去的地址由系统枚举（换网不用改）✓
    const text = el.textContent ?? "";
    expect(text, "⭐ 一键那颗旁边必须说清「听所有网卡」✓").toContain("听所有网卡");
    expect(text, "⭐ 还要说清「报出去的地址由系统枚举」✓").toContain("由系统枚举");
    expect(text, "⭐ 并且把「换网不用改」说出来（那正是 owner 问的那件事 ✓）").toContain("换网不用改");
  });

  it("7) ⭐ 锁（今天已绿 ✓，⛔ 不是本片的修）：后端那条「**默认是关的**」判据一个字不许动 ✗", () => {
    const meshRs = read("src-tauri/src/mesh.rs");
    expect(
      meshRs,
      "⛔ 把「没配绑定 ⇒ 网格是关的」那条既有判据改掉 ✗ —— Lead 拍的是「**保留默认关，只是让开启变成一下**」✓ " +
        "（网格监听所有网卡 ⇒ 未经用户动作自动开属安全相关默认值 ✗）",
    ).toContain("without_a_configured_bind_the_mesh_is_off_and_touches_nothing");
  });
});

