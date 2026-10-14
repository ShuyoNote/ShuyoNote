// ⭐ **R1（2026-10-13，Lead 砍到最小范围）**：⭐ `device_pair_export` 在**没设窗口口令**时
//    **必须仍能产出** ✗（＝当场生成一串 ＋ 写库 ✓），⛔ 不再回 `not_configured` ✗。
//
// ⚠️ 为什么用**源码级**判据（而不是跑那条命令 ✓）：`device_pair_export` 是 `#[tauri::command]`
//    （收 `State<'_, Db>` ✓）⇒ 单测里**起不了宿主** ✗ —— 与 `syncPanelMesh.wiring.test.ts` 同一手法 ✓。
//
// ⭐ **判据 A**（本片的修 ✓ —— 今天红）：
//    · `bind.trim().is_empty() || token.trim().is_empty()` 这个**合取**必须**不再存在** ✗（今天在 ⇒ 红 ✓）；
//    · 必须出现"**当场生成 ＋ 写库**"那一句（`set_mesh_token(&c, &scope.space, Some(&generated))` ✓）；
//    · 旧人话「设一个**窗口口令**」必须**不再存在** ✗（它会教用户去点一个**已经不存在**的格子 ✗）。
// ⭐ **锁**（今天已绿 ✓，不是本片的修 ✗）：
//    · 「**`bind` 空仍报缺地址**」✓（⛔ 别把前半也放行 ✗）；
//    · 随机源只许走 `crate::crypto::` ✓（`crypto.rs:261` 逐字「随机数入口只有这一处」✓）＋
//      ⛔ `sync.rs` 里**不许**出现 `use rand`／`OsRng` ✗（`Cargo.toml` 只有 `rand_core` ✓）。
// ⚠️ **判据 B（"人话指向**存在**的控件"）本片不动 UI** ✗ ⇒ ⭐ 它**仍是半绿** ✗、归**下一片**（UI）✓
//    —— ⛔ 本文件**不声称** B 已修 ✗（那格早已删掉 ✓，随后承载它的 `MeshAdvancedForm.tsx` 也于
//    2026-10-14 **整份删了** ✓ ⇒ 界面上**没有**可点的口令格 ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SYNC_RS = readFileSync(resolve(__dirname, "..", "..", "src-tauri", "src", "sync.rs"), "utf8");

describe("R1：没设窗口口令时，`device_pair_export` 仍要能产出", () => {
  it("A1 ⭐ 那个**合取**（缺地址 ∨ 缺口令）必须不再存在（今天【红】：它在 ✓）", () => {
    expect(
      SYNC_RS,
      "⛔ `bind.trim().is_empty() || token.trim().is_empty()` 还在 ⇒ 没设口令就回 not_configured ✗（本片要改掉它 ✓）",
    ).not.toContain("bind.trim().is_empty() || token.trim().is_empty()");
  });

  it("A2 ⭐ 必须**当场生成**一串并**写库**（今天【红】：没有这句 ✓）", () => {
    expect(
      SYNC_RS,
      "⛔ 没看到「当场生成 ＋ 写库」那一句 ⇒ 空口令那一档还是进不去 ✗",
    ).toContain("set_mesh_token(&c, &scope.space, Some(&generated))");
  });

  it("A3 ⭐ 旧人话「设一个**窗口口令**」必须删掉（今天【红】：它在 ✓ —— 会教用户点一个不存在的格子 ✗）＋ 新话只说**改后为真**的事 ✓", () => {
    expect(SYNC_RS, "⛔ 还在教用户去面板「设一个窗口口令」✗").not.toContain("设一个**窗口口令**");
    expect(SYNC_RS, "⭐ 自动生成之后要**如实说一句**（只写改后为真的话 ✓：已自动生成、无需手填 ✓）").toContain(
      "已自动生成",
    );
    expect(SYNC_RS, "⛔ 别指一个**还不存在**的格子 ✗（「高级里能看/换」等 UI 落地后再写 ✓）").not.toContain(
      "高级」里可以看",
    );
  });

  it("L1 ⭐ 锁（今天已绿 ✓）：`bind` 空**仍要**报缺地址（⛔ 别把前半也放行 ✗）", () => {
    expect(SYNC_RS, "⛔ 缺地址那一档被一起放行了 ✗（它仍该回 `not_configured` ✓）").toContain(
      "if bind.trim().is_empty()",
    );
  });

  it("L2 ⭐ 锁：随机源只许走 `crate::crypto::` ✓，⛔ `sync.rs` 里不许直接引 `rand`／`OsRng` ✗", () => {
    expect(SYNC_RS, "⭐ 新代码要经 `crate::crypto::` 的既有 helper ✓").toContain("crate::crypto::");
    expect(SYNC_RS, "⛔ `sync.rs` 里不许出现 `use rand` ✗（`Cargo.toml` 只有 `rand_core`）").not.toContain("use rand");
    expect(SYNC_RS, "⛔ `sync.rs` 里不许直接用 `OsRng` ✗（那是 `crypto.rs` 的活 ✓）").not.toContain("OsRng");
  });
});
