// ⭐⭐ **2026-10-29（owner 拍）：团队功能冻结** —— 判据（两层：**真渲染** ＋ **源码级接线**）。
//
// 事实（owner 2026-10-29）：`shuyonote-sync-server` **已归档**，被独立闭源企业版
// `shuyonote-enterprise-server` 取代 ⇒ 本仓（个人版 AGPL 客户端）团队功能**冻结**：
//   · ⛔ **新建 / 配置**入口一律不显示（新建团队空间 / 绑服务器 / 登录注册 / 组织管理）；
//   · ✅ **已存在**的团队空间档案**照旧可用**（状态可看、同步按钮在、数据路径一个字节不动）。
//
// ## 这一组钉什么
// ① **结果级**：真渲染 `SyncPanel`（带一个**已配置的团队空间**档案）⇒ 必须看到「团队空间 / 已绑定 /
//    冻结注记 / 只读服务器 / 只读组织空间 / 同步按钮」，且**看不到**登录注册、创建空间、成员管理、
//    保存、密码/邮箱输入 —— 这一条同时证明"冻结时入口不渲染"与"旧配置仍显示/可同步" ✓。
// ② **源码级**：每个隐藏点都读**唯一开关**（`lib/edition.ts`）＋ 冻结**没有删代码**（团队选项、
//    `team_*` 命令、组织管理整段都还在）＋ 设置页的"同步该组"（旧配置同步入口）也还在 ✓。
//
// ⚠️ 为什么还要源码级：DOM 测试只能证明"当前 true 时看不见"；"改回 false 就回来 / 不是删了代码"
//    这件事只有对着源码判（`teamConfigEntryVisible()` 包着那些块 ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeSpy, lanStatusSpy, listProfilesSpy, secSpy } = vi.hoisted(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => cb,
  };
  return {
    invokeSpy: vi.fn(),
    lanStatusSpy: vi.fn(),
    listProfilesSpy: vi.fn(),
    secSpy: vi.fn(),
  };
});

// ⚠️ `api` 其余方法一律"空读数"（面板那些分支只读、不崩 ✓）—— 本判据只问团队那一段的可达性 ✓。
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      lanStatus: (id: string) => lanStatusSpy(id),
      listSyncProfiles: () => listProfilesSpy(),
      spaceSecurityOverview: () => secSpy(),
      meshSetConfig: async () => ({ paired: [] }),
    },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => null) },
  ),
}));

import { platform } from "../lib/platform";
import { AUTO_SYNC_KEY } from "../lib/syncMode";
import { useSpaceStore } from "../store/space";

import { TEAM_EDITION_ARCHIVED, TEAM_EDITION_ARCHIVED_NOTE } from "../lib/edition";
import { SyncPanel } from "./SyncPanel";

const SRC = (name: string) => readFileSync(resolve(__dirname, name), "utf8");
const REPO = (rel: string) => readFileSync(resolve(__dirname, "..", "..", rel), "utf8");
/** ⚠️ 结构类断言**必须剥注释**：本仓踩过 —— 解释这件事的注释会喂饱 `toContain` ⇒ 假绿（实测这轮）
 *  （第一次写 M3/M4 变异时就没红，真因就是注释里也写着 `teamConfigEntryVisible()` / `teamConfigVisible && (`）。 */
const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "");

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** 渲染一个**当前空间是团队空间、且档案已配置**的面板（owner 的"老用户"形状 ✓）。 */
async function renderConfiguredTeamPanel(): Promise<HTMLElement> {
  lanStatusSpy.mockResolvedValue({
    enabled: true,
    peers: 0,
    kind: "",
    line: "",
    mesh: {
      enabled: false,
      bind: null,
      tokenSet: false,
      window: null,
      served: [],
      paired: [],
      note: "",
      reach: "",
      announced: null,
    },
    nearby: [],
  });
  listProfilesSpy.mockResolvedValue([
    {
      ws_id: "ws-team",
      server_url: "http://192.168.1.9:8787",
      token: "tok-old-1",
      space_id: "sp-old-1",
      last_pushed_seq: 0,
      last_pulled_seq: 0,
      sync_attachments: 1,
    },
  ]);
  secSpy.mockResolvedValue([{ space_id: "ws-team", kind: "team", encrypted_on_disk: false }]);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<SyncPanel contentOnly />));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    flushSync(() => {});
  }
  return host;
}

const buttonTexts = (el: HTMLElement): string[] =>
  [...el.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());

describe("① 结果级：冻结=true ⇒ 团队「新建/配置」入口不渲染，既有团队空间仍显示/可同步", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [{ id: "ws-team", name: "团队空间" }] as never, activeId: "ws-team" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
    listProfilesSpy.mockReset();
    secSpy.mockReset();
  });

  it("1) 既有团队空间**仍然显示**（名字 ＋ 已绑定状态 ＋ 冻结注记 ＋ 只读字段）", async () => {
    const el = await renderConfiguredTeamPanel();
    const text = el.textContent ?? "";
    expect(text, "⭐ 既有团队空间必须照旧显示（冻结 ≠ 删数据/删界面 ✓）").toContain("团队空间");
    expect(text, "⭐ 旧档案的状态要能看见（已绑定 ✓）").toContain("已绑定");
    expect(
      el.querySelector('[data-testid="team-frozen-note"]'),
      "⭐ 要有一句如实说明（团队功能已冻结 / 旧配置仍可同步 ✓）",
    ).toBeTruthy();
    expect(text).toContain(TEAM_EDITION_ARCHIVED_NOTE);
    // 服务器 / 组织空间改成**只读**显示（⛔ 不再提供改配置的输入框）
    expect(el.querySelector('[data-testid="team-server-readonly"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="team-space-readonly"]')).toBeTruthy();
  });

  it("2) ⛔ 「新建/配置」入口一个都不渲染：登录/注册/创建空间/成员管理/邀请/保存", async () => {
    const el = await renderConfiguredTeamPanel();
    const btns = buttonTexts(el);
    for (const bad of ["登录", "注册", "创建空间", "成员管理", "邀请", "保存"]) {
      expect(btns, `⛔ 冻结期间还渲染了「${bad}」按钮（新建/配置入口没藏干净 ✗）：${JSON.stringify(btns)}`).not.toContain(
        bad,
      );
    }
    // 输入面也要干净：不再有密码/邮箱/服务器地址/组织空间 id 的输入格
    expect(el.querySelectorAll('input[type="password"]').length, "⛔ 还渲染了密码输入框").toBe(0);
    const ids = [...el.querySelectorAll("input,select")].map((i) => i.id);
    for (const badPrefix of ["sync-srv-", "sync-mail-", "sync-space-", "sync-regcode-"]) {
      expect(ids.some((id) => id.startsWith(badPrefix)), `⛔ 还渲染了「${badPrefix}…」输入格：${JSON.stringify(ids)}`).toBe(
        false,
      );
    }
  });

  it("3) ⭐ 旧配置仍能同步：卡片上的「同步」按钮还在（⛔ 冻结不许把同步路径一起藏掉 ✗）", async () => {
    const el = await renderConfiguredTeamPanel();
    const btns = buttonTexts(el);
    expect(btns, `⭐ 已配置的团队空间必须还能点同步（否则"旧配置兼容"就是空话）：${JSON.stringify(btns)}`).toContain(
      "同步",
    );
  });
});

describe("② 源码级：隐藏点都读**唯一开关**，且冻结**没有删代码/删契约**", () => {
  it("1) `lib/edition.ts` 是唯一出处（常量 true ＋ 可逆函数）", () => {
    expect(TEAM_EDITION_ARCHIVED, "唯一开关现在必须是冻结态").toBe(true);
    const edition = SRC("../lib/edition.ts");
    expect(edition, "解冻说明要在（改回 false 即恢复；⛔ 不是删代码）").toContain("TEAM_EDITION_ARCHIVED = true");
    expect(edition, "语义函数要在（判据/组件都读它）").toContain("export function teamConfigEntryVisible");
  });

  it("2) `PageTree.tsx`：新建空间的「团队空间」选项被冻结门挡住，但代码仍在（可逆）", () => {
    const src = SRC("PageTree.tsx");
    expect(src, "必须从唯一开关处引入").toContain('from "../lib/edition"');
    // ⚠️ 剥注释再判（注释里也写着 `teamConfigEntryVisible()` —— 不剥会被它喂饱 ⇒ 假绿，实测过 ✓）
    const code = stripComments(src);
    expect(code, "新建分类那段必须**真的**走 `teamConfigEntryVisible()` 这道门").toContain(
      "if (isDesktopPlatform() && teamConfigEntryVisible()) {",
    );
    // ⛔ 冻结 ≠ 删：那个选项的代码还在（解冻即回来）
    expect(code, "⛔ 「团队空间」选项被删了 ⇒ 解冻时回不来（冻结只许隐藏 ✗）").toContain('label: "团队空间"');
  });

  it("3) `SyncPanel.tsx`：服务器/账号/组织空间/成员/保存都在冻结门里；「同步」**不在**门里", () => {
    const src = SRC("SyncPanel.tsx");
    expect(src, "必须从唯一开关处引入").toContain('from "../lib/edition"');
    expect(src, "面板内必须只算一次 `teamConfigVisible`（判据/组件同一把尺）").toContain(
      "const teamConfigVisible = teamConfigEntryVisible();",
    );
    // 服务器地址：冻结 ⇒ 只读；输入框在门里
    expect(src).toContain('data-testid="team-server-readonly"');
    // 账号：登录表单在门里（`teamConfigVisible ? (`）；冻结分支给注记
    expect(src).toContain('data-testid="team-frozen-note"');
    // 组织空间：冻结 ⇒ 只读
    expect(src).toContain('data-testid="team-space-readonly"');
    // 成员管理 & 保存：在门里
    expect(src, "成员管理必须被冻结门挡住").toContain("{teamConfigVisible && r.space_id && r.token && canManageSpace(r) && (");
    // ⭐ 同步按钮**不许**被门挡住（旧配置仍可同步 ✓）：
    //   ⚠️ 这里**不用"往前找 teamConfigVisible"**判（保存那颗按钮的冻结门就在它前面，会误伤 ✓）；
    //   真正的证据在 ①-3 的 DOM 判据（冻结态下屏上**确实有**「同步」按钮 ✓）。源码级只钉：
    //   ① 那条调用**只存在一处**（不是被悄悄删了/没接上）✓；② 保存那颗确实在门里 ✓。
    expect(
      src.split("onClick={() => syncOne(r)}").length - 1,
      "「同步」那条调用必须恰好一处且还在（旧配置兼容 ✓）",
    ).toBe(1);
    expect(src, "保存（改配置）必须在冻结门里；同步（用旧配置）不在 ✓").toMatch(
      /\{teamConfigVisible && \(\s*<button className="sync-btn" onClick=\{\(\) => save\(r\)\}/,
    );
  });

  it("4) `SettingsDialog.tsx`：组织账号/组织管理在冻结门里；「同步该组」仍在（旧配置同步入口）", () => {
    const src = SRC("SettingsDialog.tsx");
    expect(src, "必须从唯一开关处引入").toContain('from "../lib/edition"');
    const code = stripComments(src);
    // ⚠️ 精确到"整节被包住"（⛔ 不能只判 `{teamConfigVisible && (` 出现过 ✗ —— 另一处也有，实测会被喂饱）
    expect(code, "组织管理整节要被冻结门挡住").toMatch(
      /\{teamConfigVisible && \(\s*<section className="set-section">\s*<div className="set-section-title">组织管理<\/div>/,
    );
    expect(code, "⛔ 冻结 ≠ 删：组织管理那一节代码仍在").toContain("组织管理");
    // 旧配置的同步入口（按服务器分组那一节的「同步该组」）**不许**被藏
    expect(src, "⭐ 「同步该组」必须还在（旧配置仍可同步 ✓）").toContain("同步该组");
  });

  it("5) 契约没退：`team_*` 命令/类型/Rust 全在，且都带「已归档/冻结」注释", () => {
    const apiTs = REPO("src/lib/api.ts");
    const cmds = REPO("src/lib/platform/commands.ts");
    for (const cmd of ["team_register", "team_login", "team_list_spaces", "team_create_space", "team_invite_member"]) {
      expect(cmds, `⛔ 契约被删了：${cmd}（冻结只许隐藏界面，不许退契约 ✗）`).toContain(`${cmd}:`);
      expect(apiTs, `⛔ api 侧契约被删了：${cmd}`).toContain(`invoke("${cmd}"`);
    }
    const rust = REPO("src-tauri/src/sync.rs");
    expect(rust, "⛔ Rust 团队命令被删了").toContain("pub async fn team_register(");
    expect(rust, "Rust 侧要写明「已归档 / 冻结 / 旧配置兼容」").toMatch(/已归档[\s\S]{0,400}冻结/);
    // 前端契约文件也要有同样的说明
    expect(cmds, "commands.ts 要写明理由（已归档/冻结）").toContain("已归档");
    expect(apiTs, "api.ts 要写明理由（已归档/冻结）").toContain("已归档");
  });

  it("6) 文档口径：README / docs 都改成「sync-server 已归档」且说明旧配置兼容", () => {
    const readme = REPO("README.md");
    expect(readme, "README 必须写明 sync-server 已归档").toContain("已归档");
    expect(readme, "README 必须写明团队能力归企业版").toContain("enterprise-server");
    expect(readme, "README 必须写明旧配置仍兼容").toContain("旧配置");
    const docs = REPO("docs/README.md");
    expect(docs, "docs/README 也要有同一口径的注记").toContain("已归档");
    expect(docs, "docs/README 要写清历史规格不删").toContain("不删");
  });
});
