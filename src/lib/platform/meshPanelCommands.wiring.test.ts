// ⭐ **P1.5 主件 · A1 片**（Lead 2026-10-13 切法 ✓）：两条**本机读数**命令 ＋ **三处接线**的判据 ✗。
//
// 片内范围（⛔ 不碰 UI ✗ —— 读数接线与 `SyncPanel` 那一行是 **A2** ✓）：
//   · Rust：新模块 `src-tauri/src/mesh_panel.rs`（两条命令 ✓）＋ `lib.rs` 的 `mod` ＋ `generate_handler!` 注册 ✓；
//   · TS 三处：`src/lib/platform/commands.ts`（类型 ＋ `CommandMap` ✓）／`web.ts`（2 分支 ✓）／`api.ts`（2 包装 ✓）。
//
// ⭐ 两条命令的形状（名字 owner 已拍 ✓）：`mesh_panel_scopes` ⇒ `[{wsId,name,kind,announced}]` ✓；
//   `mesh_panel_spaces` ⇒ `{offer:[…], local:[…]}` ✓ —— ⚠️ **本片只填 `local`** ✗（`offer` 是 B 片 ✓）。
//
// ⭐ 口径（owner 拍 ✓，⛔ 别再发明 ✗）：
//   · `local` ＝ 本机**现在存在**（`deleted_at IS NULL`）的空间 ✓；
//   · `announced` ＝ 与**窗口同一把尺**：`lan_state::window_serve_space(c, space_id, ws_id)`
//     （`lan_state.rs:953` ✓ —— P-B 已同源用过 ✓）；`kind` **直读** `meta.workspaces.kind` ✓；
//   · ⛔ 回给界面的字段**不含** `space_id` ✗（那是内部标识：⛔ 不上界面 ✓ `INV-UI-copy-no-internal-ids` ✓）。
//
// ⚠️ **本文件先红后绿**：它写下时那四件（Rust 模块／`lib.rs` 注册／`web.ts` 分支／两个包装）都**不存在** ✗
//   ⇒ 六条判据全红 ✓；落完 A1 之后应全绿 ✓。
// ⭐ 两条**锁**（今天已绿 ✓，⛔ 不是本片的修 ✗）：⛔ 后端那条「默认是关的」判据不许被动 ✗（`mesh.rs:4067` ✓）；
//   ⛔ `tests/baseline.json` 一个字节都不许动 ✗（Lead 的硬边界 ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

const RUST_MOD = "src-tauri/src/mesh_panel.rs";
const LIB_RS = "src-tauri/src/lib.rs";
const COMMANDS_TS = "src/lib/platform/commands.ts";
const WEB_TS = "src/lib/platform/web.ts";
const API_TS = "src/lib/api.ts";

describe("P1.5 · A1：两条本机读数命令 ＋ 三处接线", () => {
  it("1) ⭐ Rust：两条命令存在 ✓、`lib.rs` 有 `mod` ✓、**两条都进了 `generate_handler!`** ✗（漏一条 ⇒ 桌面点下去 command not found ✓）", () => {
    const rs = read(RUST_MOD);
    expect(rs, "`mesh_panel_scopes` 没写").toContain("pub fn mesh_panel_scopes");
    expect(rs, "`mesh_panel_spaces` 没写").toContain("pub fn mesh_panel_spaces");
    const lib = read(LIB_RS);
    expect(lib, "`lib.rs` 没登记模块（没有 `mod` ⇒ 那两条命令**不在二进制里** ✓）").toContain("mod mesh_panel;");
    expect(lib, "`generate_handler!` 里没有 `mesh_panel_scopes` ⇒ 前端调用会 `command not found` ✓").toContain(
      "mesh_panel::mesh_panel_scopes,",
    );
    expect(lib, "同上：`mesh_panel_spaces` 也要注册 ✓").toContain("mesh_panel::mesh_panel_spaces,");
  });

  it("2) ⭐ `local` 的**真值口径**：只列**现在存在**的空间（`deleted_at IS NULL` ✓）＋ 顺序稳定 ✓", () => {
    const rs = read(RUST_MOD);
    expect(
      rs,
      "⛔ 没按「现在存在」过滤 ⇒ 删掉的空间也会被当成「这一台有」✗（owner 口径：`local` ＝ 本机**现在存在**的 ✓）",
    ).toContain("deleted_at IS NULL");
    expect(rs, "⭐ 顺序要与侧栏同源（`sort_order` ⇒ 再加 id 兜底 ✓，别让两个列表顺序不同 ✓）").toContain(
      "ORDER BY sort_order",
    );
    // ⭐ 判据的**值级**那一半在 Rust 自己的 `#[cfg(test)]`（`mesh_panel.rs` 里 ✓）：
    //    ⚠️ 本机 rust 组按 `AGENTS.md` §7 以 **Linux(CI)/WSL** 为准 ⇒ 本片只保证它**编进 lib** ✓
    //      （收口读数里如实标注"编译过、本机未执行"✗）。
    expect(rs, "⭐ `local` 的值级判据（删掉的不出现在列表里）应当落在 Rust 自己的测试里 ✓").toContain(
      "#[cfg(test)]",
    );
  });

  it("3) ⭐ `announced` 用**窗口那把尺** ✓（⛔ 不另发明一条判定 ✗）；`kind` 直读 `meta.workspaces.kind` ✓", () => {
    const rs = read(RUST_MOD);
    expect(
      rs,
      "⛔ 没走 `window_serve_space` ⇒ 「对外宣称在服务谁」与窗口**两把尺**了 ✗（`lan_state.rs:953` 是唯一那处解析 ✓）",
    ).toContain("window_serve_space(");
    expect(rs, "⛔ `kind` 不许另造枚举/映射 ✗ —— 直读 `meta.workspaces` 的那一列 ✓").toContain("kind");
    expect(rs, "⭐ 那个查询要真的 select 到 workspaces 表 ✓").toContain("meta.workspaces");
  });

  it("4) ⭐ `offer` **本片不填**（⛔ 不许瞎编 ✗）：空数组 ＋ 注明「待 B 片」✓", () => {
    const rs = read(RUST_MOD);
    expect(rs, "⭐ `offer` 本片应当留空数组 ✓（B 片才填 ✓）").toContain("offer: Vec::new()");
    expect(
      rs,
      "⚠️ 空数组只表示「这一轮还没接线」，⛔ **不表示「没有」** ✗ ⇒ 必须留一句「待 B 片」的注释，别让下一个人读成结论 ✓",
    ).toContain("待 B 片");
  });

  it("5) ⭐ 三处接线齐了：`CommandMap` 两条 ✓ ＋ `web.ts` 两分支 ✓ ＋ `api.ts` 两包装 ✓（缺一处 `check-web-commands` 当场红 ✗）", () => {
    const cmds = read(COMMANDS_TS);
    expect(cmds, "`CommandMap` 缺 `mesh_panel_scopes`").toContain("mesh_panel_scopes: {");
    expect(cmds, "`CommandMap` 缺 `mesh_panel_spaces`").toContain("mesh_panel_spaces: {");
    expect(cmds, "⭐ 两条都是**无参**命令（`args: undefined` ✓ —— 形状与 Rust 侧一致 ✓）").toContain(
      "mesh_panel_scopes: { args: undefined;",
    );

    const web = read(WEB_TS);
    expect(web, "`web.ts` 缺 `mesh_panel_scopes` 分支 ⇒ 方向 1 会红 ✗").toContain('cmd === "mesh_panel_scopes"');
    expect(web, "`web.ts` 缺 `mesh_panel_spaces` 分支 ⇒ 方向 1 会红 ✗").toContain('cmd === "mesh_panel_spaces"');
    expect(
      web,
      "⭐ Web 上**没有发现层**（UDP 在 Rust 侧 ✓）⇒ `announced` 只许是 `false` ✓，⛔ 不许编成 true ✗",
    ).toContain("announced: false");

    const api = read(API_TS);
    expect(api, "`api.ts` 缺 `meshPanelScopes` 包装").toContain("meshPanelScopes:");
    expect(api, "`api.ts` 缺 `meshPanelSpaces` 包装").toContain("meshPanelSpaces:");
    expect(api, "⭐ 包装要打到**那条**命令名上 ✓").toContain('invoke("mesh_panel_scopes"');
  });

  it("6) ⭐ 回给界面的字段里**没有** `space_id` ✗（内部标识不上界面 ✓ `INV-UI-copy-no-internal-ids` ✓）", () => {
    const rs = read(RUST_MOD);
    const structStart = rs.indexOf("pub struct MeshPanelScope");
    expect(structStart, "前提：`MeshPanelScope` 那个结构体要在").toBeGreaterThan(-1);
    const structEnd = rs.indexOf("}", structStart);
    const body = rs.slice(structStart, structEnd > structStart ? structEnd : structStart + 400);
    expect(
      body,
      `⛔ 回给界面的那四个字段里出现了 \`space_id\` ✗ —— 它是**内部标识**（只用来判断 ✓，⛔ 不许回给界面 ✗）。实测字段体：\n${body}`,
    ).not.toContain("space_id");
  });

  it("7) ⭐ 锁（今天已绿 ✓，⛔ 不是本片的修）：后端那条「**默认是关的**」判据一个字没被动 ✗", () => {
    expect(
      read("src-tauri/src/mesh.rs"),
      "⛔ 有人把「没配绑定 ⇒ 网格是关的」这条既有判据改掉了 ✗（那是**有意**的 ✓：网格监听所有网卡 ✓）",
    ).toContain("without_a_configured_bind_the_mesh_is_off_and_touches_nothing");
  });
});
