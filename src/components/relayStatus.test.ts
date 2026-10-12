// 中继那一格（图⑤「中继」／图⑧「中继许可证」）· **owner 截图里那两条读数**的判据。
//
// 现场（owner 2026-10-12 截图逐字，我照抄 —— ⛔ 不含任何凭据；⚠️ 那是**改之前**的文案 ✓）：
// ```
// 中继              未连上中继
// 中继许可证        许可证状态未接线（读不到有效期）
//   本机就没放行（not_configured）：读不了中继配置
//   C:\…\cn.shuyo.shuyonote\relay\config.json: 系统找不到指定的路径。(os error 3)
//   读不了中继配置
//   C:\…\cn.shuyo.shuyonote\relay\config.json: 系统找不到指定的路径。(os error 3)
// ```
// ⭐ 两条都在这份判据里：**那条路径出现了两遍** ✗ ／ **"未接线"是一句假话** ✗。
// ⭐ 2026-10-12 已按这两条改：去重在 `src/lib/relay/statusView.ts`（渲染侧 ✓），
//    文案在 `relay_client.rs` ＋ `statusView.ts` ＋ `web.ts`（⛔ 后端那份 `note` 没删 ✗）。
//
// ## ① 为什么"两遍"是**界面**的账（⛔ 不是后端的账）
// 后端那一份是**如实**的：`relay_client.rs:856-859` 读不到配置 ⇒ `note = e`；
// `relay_client.rs:904-909` 那次探测又把同一个 `e` 放进 `Refused.message` ⇒
// `relay_client.rs:739` 折成 `detail = "本机就没放行（not_configured）：{e}"`。
// ⚠️ **`note` 那一份不许删** ✗：`relay_status`（不探测那条）本来就没有 `detail` ⇒
// 那时 `note` 是"读不到配置"的**唯一**一句读数（`RelayStatusSection.tsx:27`）。
// ⇒ ⭐ 所以"同一句摊两遍"是**渲染侧**的账：`RelayStatusSection.tsx:71-72` 把
// `connectionDetail` 与 `note` **无条件**都摆上去了 ✓（`statusView.ts:92/100` 两格都给）。
//
// ## ② 为什么"未接线"是假话
// `LicenseWindow::Unconfigured`（`relay_client.rs:236-237`）的**真因**是两件**配置**事：
//   · 没有 `relay/config.json`（`relay_client.rs:158-165` 读不了 ⇒ `:872` 落 `Unconfigured`）；
//   · 或者配置在、但没有 `license_exp`（`relay_client.rs:287-289`）。
// 而"未接线"说的是**代码状态** —— 与实况**相反** ✗：验签层 2026-10-11 已经落地并挂着
// （`relay_license.rs:1-26` 纯函数验签 ＋ `lib.rs:19 mod relay_license;` ＋
//  `relay_client.rs:387` 真的在调它 ＋ `:824 license_view_from` 四档齐）。
// ⇒ ⭐ owner 正是被这句**读成了"代码没做"** ✗（那条读数本来只是"本机没配"✓）。
//
// 判据形状照本仓 `src/lib/relay/statusView.test.ts`（纯映射）＋ `aiSettingsDisclosure.test.tsx`
// （`createRoot` ＋ `flushSync` ＋ `vi.waitFor`；⛔ 不要真 Chromium ✗）。
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { RelayStatus } from "../lib/platform/commands";

const mocks = vi.hoisted(() => ({ relayStatus: vi.fn(), relayProbe: vi.fn() }));

vi.mock("../lib/api", () => ({
  api: { relayStatus: mocks.relayStatus, relayProbe: mocks.relayProbe },
}));

import { RelayStatusSection } from "./RelayStatusSection";

const read = (p: string) => readFileSync(p, "utf8");

const CONFIG_PATH = "C:\\Users\\someone\\AppData\\Roaming\\cn.shuyo.shuyonote\\relay\\config.json";

/** ⭐ 逐字照 `relay_client.rs` 的三处格式串拼出来（⛔ 不是随手编的）：
 *  `:152` ＝ `format!("读不了中继配置 {}: {e}", path.display())`（`e` 是 os error 3 那句）
 *  `:739` ＝ `format!("本机就没放行（{code}）：{message}")`，`code` 来自 `:906` 的 `"not_configured"`
 *  `:856-859` ＝ `Err(e) => (None, e)` ⇒ `note` 就是同一个 `e`
 */
const E = `读不了中继配置 ${CONFIG_PATH}: 系统找不到指定的路径。 (os error 3)`;

/** 后端在"本机没配置"时给的那份读数（⭐ 形状与 `RelayStatus` 逐字段同形）。 */
const UNREADABLE: RelayStatus = {
  available: true,
  note: E,
  configured: false,
  url: null,
  connection: {
    state: "refused",
    label: "未连上中继",
    detail: `本机就没放行（not_configured）：${E}`,
    checked_at: 1_791_529_632,
  },
  license: {
    state: "missing",
    days_left: null,
    grace_days_left: null,
    // ⭐ 2026-10-12 改后的文案（与 `relay_client.rs:270/:777` 同口径 ✓）
    label: "还没配置中继（读不到有效期）",
    crossnet_allowed: false,
    source: "placeholder",
    refusal: null,
  },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.clearAllMocks();
});

function renderSection() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root?.render(React.createElement(RelayStatusSection)));
  return host;
}

describe("中继那一格 · owner 截图里那两条读数", () => {
  it("① 同一条原因只许摆一遍（截图里那条路径出现了两遍 ⇒ 必红）", async () => {
    mocks.relayStatus.mockResolvedValue(UNREADABLE);
    mocks.relayProbe.mockResolvedValue(UNREADABLE);

    const el = renderSection();
    // 等两格都渲染出来（① 先 relayStatus，② 再 relayProbe）
    await vi.waitFor(() => expect(mocks.relayProbe).toHaveBeenCalled());

    const text = el.textContent ?? "";
    const count = text.split(CONFIG_PATH).length - 1;
    expect(
      count,
      "同一条「读不了中继配置 …」被摊了两遍（connectionDetail 一份 ＋ note 一份）⇒ owner 看到那条路径两次",
    ).toBe(1);
  });

  it("② 那一档不许说成「未接线」（假话：真因是「本机还没配置」；验签层已接线）", () => {
    // 三处都带这句：Rust 那一档的文案（两处）＋ 界面的兜底常量 ＋ Web 执行器那一格。
    // ⚠️ 只判**代码行** ✗：注释里**引旧文案讲历史**是好事（`relay_client.rs` 的 `///`／`//!` 与
    //    `statusView.ts` 的 ` * ` 都引了它 ✓）⇒ 把注释行丢掉再扫，否则判据会被自己的说明绊红 ✗
    //    （第一版就是这样，实测逐字：`expected true to be false` ✓）。
    const codeOnly = (src: string) =>
      src
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return !(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/"));
        })
        .join("\n");

    for (const name of [
      "src-tauri/src/relay_client.rs",
      "src/lib/relay/statusView.ts",
      "src/lib/platform/web.ts",
    ] as const) {
      expect(
        codeOnly(read(name)).includes("许可证状态未接线"),
        `${name} 还在用「未接线」描述那一档 —— 而真因是"本机没有 relay/config.json"` +
          `（relay_client.rs:158-165 / :287-289）；代码是接了的（relay_license.rs:1-26 ＋ lib.rs:19 ＋ relay_client.rs:387）`,
      ).toBe(false);
    }
  });

  it("③ 反向：那一档**仍然**要如实说「读不到」（⛔ 不许改成编一个天数 ✗）", async () => {
    mocks.relayStatus.mockResolvedValue(UNREADABLE);
    mocks.relayProbe.mockResolvedValue(UNREADABLE);

    const el = renderSection();
    await vi.waitFor(() => expect(mocks.relayProbe).toHaveBeenCalled());

    const text = el.textContent ?? "";
    expect(text, "读不到有效期就得说读不到").toContain("读不到有效期");
    expect(text, "⛔ 不许在读数缺失时冒出任何天数").not.toMatch(/剩余\s*\d/);
    expect(text).not.toContain("已连上中继");
  });

  /**
   * ④ ⭐ owner 2026-10-12 拍「甲：保持现状但**把话说清**」⇒ 那一格必须**在人眼前**说清
   * "**为什么永远读不到**" ✓ —— 因为这一格**只会读**本机已有的那份中继配置，
   * 而 ⛔ **全仓没有任何写入者**能创建它（`relay_client.rs` 只有读路径；`relayStatus.wiring.test.ts:84`
   * 还禁着 `std::fs::write`）⇒ 用户**在界面上做不到**"去配置一下" ✗。
   * ⇒ 所以那句话**只许陈述事实**：⛔ 不承诺功能、⛔ 不许写"请配置/请设置"这种界面里做不到的话 ✗。
   *
   * ⚠️ 断言走**渲染出来的文字**（⛔ 不扫源码文件 ✗）—— 上次那个坑（② 第一版被自己注释里
   * 引的旧文案绊红 ✓）在这里从根上避开：注释**永远不会**出现在 DOM 里 ✓。
   */
  it("④ 那一格旁边要有一句人话：**本机没有托管中继 ⇒ 这一格不会有读数**（且⛔ 不许写「请配置」✗）", async () => {
    mocks.relayStatus.mockResolvedValue(UNREADABLE);
    mocks.relayProbe.mockResolvedValue(UNREADABLE);

    const el = renderSection();
    await vi.waitFor(() => expect(mocks.relayProbe).toHaveBeenCalled());

    const text = el.textContent ?? "";
    expect(
      text,
      "那一格没解释「为什么读不到」——用户只会看到一句读不到的读数（owner 要的是把原因说在人眼前）",
    ).toMatch(/本机(没有|未)托管中继[^。]{0,40}读数/);
    for (const bad of ["请配置", "请设置", "请先配置"]) {
      expect(text, `⛔ 界面里做不到的事不许写成「${bad}」（全仓没有写入者能建那份配置 ✗）`).not.toContain(bad);
    }
  });
});
