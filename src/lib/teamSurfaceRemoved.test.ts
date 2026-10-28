// ⭐⭐ **2026-10-29（owner 拍第二阶段 A）：删除团队 UI ＋ `team_*` 前端契约** —— 判据（可回滚的拆除）。
//
// ## 这一笔删了什么、保留什么（判据就钉这两半）
// · **删**：`team_*` 的 **CommandMap 契约**／`web.ts` stub／`api.ts` 包装／**所有团队 UI**
//   （团队服务器卡、账号/组织管理、评论/通知/在线状态、空间同步点、团队新建项）以及**专属组件/模块**。
// · **第三阶段再删**：⭐ **Rust 团队实现**（`src-tauri/src/sync.rs` 里那 31 个 `team_*` 函数、9 个 `Team*` 类型、
//   `AuthUserId`/`parse_team_me`/`presence_page_id_gated` 等 helper）也**已删除** ✓；
// · **永远留**：⭐ `sync_profiles`/工作区同步/`space_id`（含历史 `SpaceKind::Team`）＝个人同步与旧数据要用；
//   ⭐ `specs/`、**企业 IM 规格/判据**（企业版仍引用本仓契约 ✓）。
// · **做法**：把 32 条从 `src-tauri/src/lib.rs` 的 `generate_handler!` **摘掉**（不再注册 IPC ✓）——
//   这样 `check-web-commands` 的三方向自然成立，⛔ **不用改门禁** ✗。
//
// ## 为什么要有这一条
// 拆除是**有意的**（owner 拍的），但"删干净"很容易**删过头**（连 Rust/specs 一起删 ⇒ 企业版失去契约出处 ✗）
// 或**删不干净**（留一条幽灵命令/组件 ⇒ 下一轮又有人接回去 ✗）。本判据两个方向都钉。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => {
  try {
    return readFileSync(resolve(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};
/** ⚠️ 结构类断言**必须剥注释**：解释这件事的注释里就写着这些名字（本仓踩过 ⇒ 假绿）。 */
const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("第二阶段：`team_*` 前端契约已删除（⛔ 不再有任何 IPC 暴露面）", () => {
  it("① Rust `lib.rs` 的 `generate_handler!` 里不再注册任何 `sync::team_*`", () => {
    const lib = stripComments(read("src-tauri/src/lib.rs"));
    expect(lib, "⛔ `generate_handler!` 里还有 `sync::team_*`（IPC 又暴露了）").not.toMatch(/sync::team_[a-z_]+/);
  });

  it("② CommandMap / web.ts / api.ts 三处都不再声明或调用 `team_*`", () => {
    const cmds = stripComments(read("src/lib/platform/commands.ts"));
    expect(cmds, "⛔ CommandMap 里还有 team_* 条目").not.toMatch(/\bteam_[a-z_]+:/);
    const web = stripComments(read("src/lib/platform/web.ts"));
    expect(web, "⛔ web.ts 里还有 team_* stub").not.toMatch(/cmd === "team_/);
    const api = stripComments(read("src/lib/api.ts"));
    expect(api, "⛔ api.ts 里还有 invoke(\"team_*\")").not.toMatch(/invoke\("team_/);
  });

  it("③ src/ 里不再有任何团队 UI 调用点（`api.team*` / 团队专属模块）", () => {
    const files = [
      "src/App.tsx",
      "src/components/SyncPanel.tsx",
      "src/components/SettingsDialog.tsx",
      "src/components/PageTree.tsx",
      "src/components/EditorToolbar.tsx",
      "src/components/TitleBar.tsx",
      "src/plugins/builtinCommands.ts",
      "src/store/rightPanel.ts",
    ];
    for (const f of files) {
      const code = stripComments(read(f));
      expect(code, `⛔ ${f} 里还在调团队 API（api.team*）`).not.toMatch(/api\.team[A-Z]/);
    }
    // 团队专属模块/组件**文件本身**也不许回来（它们只服务已删的 UI）
    for (const gone of [
      "src/lib/edition.ts",
      "src/lib/syncTag.ts",
      "src/store/auth.ts",
      "src/store/presence.ts",
      "src/hooks/usePresence.ts",
      "src/components/CommentsDrawer.tsx",
      "src/components/CommentsPanel.tsx",
      "src/components/NotificationCenter.tsx",
      "src/components/PresenceBar.tsx",
    ]) {
      expect(existsSync(resolve(ROOT, gone)), `⛔ 团队专属文件又出现了：${gone}`).toBe(false);
    }
  });
});

describe("第三阶段：Rust 团队实现**也已删除**；⭐ 保留面（sync_profiles / 历史团队空间语义 / specs / 企业 IM）⛔ 不许跟着删", () => {
  it("① ⛔ Rust 里不再有 `team_*` 函数、`Team*` 类型、`auth_user_id`/`parse_team_me` 那套账号身份 helper", () => {
    const rust = read("src-tauri/src/sync.rs");
    const code = stripComments(rust);
    // ⭐ 第三阶段（owner 2026-10-29）：团队实现整个删掉 ✓（第二阶段只删前端契约）
    expect(code, "⛔ Rust 里还有 `team_*` 函数（第三阶段应删）").not.toMatch(/fn team_[a-z_]+\s*\(/);
    expect(code, "⛔ Rust 里还有 `Team*` 类型（第三阶段应删）").not.toMatch(/struct Team[A-Z][A-Za-z]*/);
    expect(code, "⛔ 账号身份 helper 没删干净（`AuthUserId`/`auth_user_id` 只服务团队账号）").not.toMatch(/AuthUserId|fn auth_user_id/);
    expect(code, "⛔ `parse_team_me`/`fetch_me_user_id` 没删干净（只服务团队 /auth/me）").not.toMatch(/parse_team_me|fetch_me_user_id/);
    expect(code, "⛔ presence 的 `page_id` 隐私闸只服务团队在线状态 ⇒ 应随团队一起删").not.toMatch(/presence_page_id_gated/);
  });

  it("①b ⭐ **必须保留**：`sync_profiles` 机制与历史团队空间语义（⛔ 删了个人同步/旧数据会坏 ✗）", () => {
    const rust = stripComments(read("src-tauri/src/sync.rs"));
    for (const keep of [
      "pub struct SyncProfile",
      "fn get_profile(",
      "fn list_profiles(",
      "pub fn set_sync_profile(",
    ]) {
      expect(rust, `⛔ 个人同步/旧档案要用它，被误删：${keep}`).toContain(keep);
    }
    // 历史团队空间数据仍要读得懂：`SpaceKind::Team` 与 `space_id` 解析分支保留（另在 space_crypto/lan_state 里）
    const metrics = stripComments(read("src-tauri/src/space_crypto.rs"));
    expect(metrics, "⛔ `SpaceKind::Team` 被删了 ⇒ 历史团队空间数据读不懂").toContain("Team");
    const lanState = stripComments(read("src-tauri/src/lan_state.rs"));
    expect(lanState, "⛔ 团队空间按 space_id 服务的那条分支被删了").toContain("space_id");
  });

  it("② specs / 企业 IM 规格 / 边界判据都还在（企业版仍引用）", () => {
    for (const keep of [
      "docs/specs/2026-09-29-enterprise-edition-spec.md",
      "docs/specs/2026-09-29-enterprise-edition-requirements.md",
      "docs/specs/2026-10-01-enterprise-im-spec.md",
      "docs/specs/2026-10-01-enterprise-im-requirements.md",
      "scripts/check-im-boundary.mjs",
    ]) {
      expect(existsSync(resolve(ROOT, keep)), `⛔ 被误删：${keep}（企业版仍引用，第二阶段只删客户端团队 UI）`).toBe(true);
    }
    // `check-im-boundary` 这条门禁必须仍在册（⛔ 不许"顺手"从注册表拿掉 ✗）
    expect(read("scripts/lib/gates.mjs"), "⛔ `check-im-boundary` 从门禁注册表里消失了").toContain("check-im-boundary");
    expect(read("scripts/check-web-commands.mjs"), "⛔ `check-web-commands` 判据本身被改了（本阶段不许改门禁判据）").toContain(
      "CommandMap",
    );
  });
});

describe("第三阶段：文档口径（README / docs）—— 团队 UI/前端契约/**Rust 实现**都已删，specs 保留", () => {
  it("① README 写明：Rust 团队实现也已删除、能力归企业版、specs 契约保留", () => {
    const readme = read("README.md");
    expect(readme, "README 没写「已删除/已移除」").toMatch(/已删(除|掉)|已移除/);
    expect(readme, "README 没写「Rust 团队实现也已删除」（第三阶段）").toContain("Rust 团队实现也已删除");
    expect(readme, "README 没写企业版 enterprise-server").toContain("enterprise-server");
    expect(readme, "README 要写清 specs/企业 IM 契约保留").toMatch(/specs|企业 IM/);
    // ⛔ 第二阶段那句「Rust 后端保留」必须消失（否则与新事实矛盾）
    expect(readme, "⛔ README 还在说「Rust 后端保留」").not.toMatch(/Rust 后端(代码)?保留/);
  });

  it("② docs/README 与 SHUYONOTE_STATE 同一口径（Rust 已删 ＋ 历史规格/契约保留）", () => {
    for (const f of ["docs/README.md", "docs/SHUYONOTE_STATE.md"]) {
      const s = read(f);
      expect(s, `${f} 没写「已删除/已移除」`).toMatch(/已删(除|掉)|已移除/);
      expect(s, `${f} 没写「Rust 团队实现也已删除」`).toContain("Rust 团队实现也已删除");
      expect(s, `${f} 要写清历史规格/契约保留`).toMatch(/保留/);
      expect(s, `${f} 还在说「Rust 后端保留」`).not.toMatch(/Rust 后端(代码)?保留/);
    }
  });
});

