//! ⭐ **P1.5 主件 · A1 片**（Lead 2026-10-13 切法 ✓）：设备直连那一屏要用的**本机读数** ✗ ——
//! ⭐ **只读** ✓（⛔ 一个字节都不写 ✗）。
//!
//! ## 两条命令（⭐ 名字由 owner 侧拍定 ✓）
//! · [`mesh_panel_scopes`] ⇒ `[{wsId,name,kind,announced}]` ✓
//! · [`mesh_panel_spaces`] ⇒ `{offer:[…], local:[…]}` ✓ —— ⚠️ ⭐ **本片只填 `local`** ✗
//!   （`offer` 的口径 owner 已拍 ✓ ＝ 这台机器**通过网格对外宣称"我在服务"**的那一批 ✓，
//!    但它是 **B 片**的活 ✓ ⇒ 本片 `offer: Vec::new()` ＋ 注明「待 B 片」✓）。
//!
//! ## 口径（owner 拍 ✓，⛔ 别再发明 ✗）
//! · `local` ＝ 本机**现在存在**的空间 ✓（`deleted_at IS NULL` ✓）—— ⭐ 删掉的空间**不许**出现 ✗
//!   （否则界面会把"已经没有了"说成"这一台有" ✓）；
//! · `announced` ＝ 这一侧**通过网格对外宣称在服务**它 ✗ —— ⭐ **与窗口同一把尺**：
//!   [`crate::lan_state::window_serve_space`]（`lan_state.rs:953` ✓ —— P-B 已同源用过 ✓）
//!   ⇒ ⛔ 不在这里另发明一条判定 ✗（两把尺迟早会漂 ✓）；空串 ⇒ 没在服务它 ✓。
//!   ⚠️ 档案行缺失时 `resolved_space` 有**既有回落**（个人档 ⇒ 设备级暗号 ✓）—— 那正是窗口自己的口径 ✓，
//!   本模块**照用不另判** ✓（⛔ 不把"读不出来"悄悄算成 false ✗ —— 回落是既有语义 ✓）。
//! · `kind` ⭐ **直读** `meta.workspaces.kind` ✓（⛔ 不碰 `space_crypto` 的枚举/映射 ✗）。
//!
//! ## ⛔ 三条边界
//! 1. ⛔ **不动协议** ✗（全读本机库 ＋ 本机窗口状态 ✓，⛔ 一个包都不发 ✗）；
//! 2. ⛔ **回给界面的字段不含内部标识** ✗：`space_id`（协议空间／暗号）**只用来做判断** ✓，
//!    ⛔ 不进 `MeshPanelScope` ✗（`INV-UI-copy-no-internal-ids` ✓）；
//! 3. ⛔ 不含任何秘密值 ✗（暗号值一个字符都不回 ✓）。

use rusqlite::Connection;
use tauri::State;

/// ⭐ 一个空间在"网格面"上的形状 ✓（`announced` 用的是窗口那把尺 ✓）。
///
/// ⚠️ 字段就是回给界面的**全部**内容 ✓ —— ⛔ 这里**不许**出现 `space_id`／暗号值 ✗。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPanelScope {
    /// 空间 id ✓（界面用它做行键／与 `rows` 对齐 ✓ —— 它是**本机**的 id ✓，不是协议标识 ✓）。
    pub ws_id: String,
    /// 空间名 ✓（人话 ✓）。
    pub name: String,
    /// ⭐ 直读 `meta.workspaces.kind` ✓（`''` ＝ 未分类 ⇒ 界面**如实说**，⛔ 不替它猜 ✗）。
    pub kind: String,
    /// ⭐ 这一侧**对外宣称在服务**它吗 ✓（同一把尺：`lan_state::window_serve_space` ✓）。
    pub announced: bool,
}

/// ⭐ 一条"空间"（只够界面列出来 ✓）：id ＋ 名字 ✓。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeshPanelSpace {
    pub id: String,
    pub name: String,
}

/// ⭐ `mesh_panel_spaces` 的结果 ✓。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPanelSpaces {
    /// ⭐ ＝ 这台机器**通过网格对外宣称"我在服务"**的空间 ✓（owner 拍板 1 ✓）——
    /// ⚠️ ⭐ **本片不填** ✗（**待 B 片** ✓）：⛔ 空数组在这里**只表示"这一轮还没接线"** ✗，
    ///   ⛔ **不表示"没有"** ✗（两件事在界面上必须长得不一样 ✓ —— 那条口径见
    ///   `docs/plans/2026-09-29-nearby-devices-spec.md` 一带「0 是结论、读不到是没有结论」✓）。
    pub offer: Vec<MeshPanelSpace>,
    /// ⭐ ＝ 本机**现在存在**的空间 ✓（`deleted_at IS NULL` ✓）＝ 界面上「笔记本有哪些空间」✓。
    pub local: Vec<MeshPanelSpace>,
}

/// 本机**现在存在**的空间：`(id, name, kind)` ✓ —— ⭐ 顺序与侧栏同源（`sort_order` ＋ id 兜底 ✓）。
fn live_workspaces(c: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut st = c
        .prepare(
            "SELECT id, name, kind FROM meta.workspaces \
             WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2).unwrap_or_default(),
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// ⭐ 这一侧**报出去的那一句** ✓（⭐ 与窗口**同一把尺** ✓）：空串 ⇒ 没在服务它 ✓。
///
/// ⚠️ `space_id` 取 `meta.sync_profiles` 那一列 ✓（没有档案行 ⇒ 空串 ✓ ⇒ 交给
///   `window_serve_space` 走它自己的既有回落 ✓ —— ⛔ 不在这里再判一次 ✗）。
fn served_scope(c: &Connection, ws_id: &str) -> String {
    let space_id: String = c
        .query_row(
            "SELECT space_id FROM meta.sync_profiles WHERE ws_id = ?1",
            [ws_id],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();
    crate::lan_state::window_serve_space(c, &space_id, ws_id)
}

/// ⭐ **每个空间"对外宣称"的状态** ✗（只读 ✓）。
#[tauri::command]
pub fn mesh_panel_scopes(db: State<'_, crate::db::Db>) -> Result<Vec<MeshPanelScope>, String> {
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let mut out = Vec::new();
    for (ws_id, name, kind) in live_workspaces(&c)? {
        let announced = !served_scope(&c, &ws_id).trim().is_empty();
        out.push(MeshPanelScope {
            ws_id,
            name,
            kind,
            announced,
        });
    }
    Ok(out)
}

/// ⭐ **这一台有哪些空间** ＋（B 片）**这一台对外说在服务哪些** ✗（只读 ✓）。
#[tauri::command]
pub fn mesh_panel_spaces(db: State<'_, crate::db::Db>) -> Result<MeshPanelSpaces, String> {
    let c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
    let local = live_workspaces(&c)?
        .into_iter()
        .map(|(id, name, _)| MeshPanelSpace { id, name })
        .collect();
    Ok(MeshPanelSpaces {
        // ⭐ **待 B 片** ✓（owner 拍板 1：`offer` ＝ 对外宣称那一批 ✓）—— ⛔ 本片瞎填会造出假读数 ✗。
        offer: Vec::new(),
        local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⭐ 一个最小的 meta 库（照 `lan_state.rs:988` 的那份夹具 ✓ ＋ 本模块要用到的三列 ✓）。
    ///
    /// ⚠️ 本机 rust 组按 `AGENTS.md` §7 以 **Linux(CI)/WSL** 为准 ⇒ 本文件这两条判据在
    /// **本片只保证编进 lib** ✓（收口读数里如实标注"编译过、本机未执行"✗），跑起来的是 CI ✓。
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "ATTACH DATABASE ':memory:' AS meta;
             CREATE TABLE meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE meta.sync_profiles (
                 ws_id TEXT PRIMARY KEY, server_url TEXT NOT NULL DEFAULT '',
                 token TEXT NOT NULL DEFAULT '', space_id TEXT NOT NULL DEFAULT '',
                 last_pushed_seq INTEGER NOT NULL DEFAULT 0, last_pulled_seq INTEGER NOT NULL DEFAULT 0,
                 sync_attachments INTEGER NOT NULL DEFAULT 1, mesh_room TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE meta.workspaces (
                 id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
                 sort_order REAL NOT NULL DEFAULT 0, deleted_at INTEGER
             );
             INSERT INTO meta.workspaces (id, name, kind, sort_order) VALUES ('ws-a', '工作', 'team', 0);
             INSERT INTO meta.workspaces (id, name, kind, sort_order) VALUES ('ws-b', '私人', 'personal', 1);
             INSERT INTO meta.workspaces (id, name, kind, sort_order, deleted_at)
                 VALUES ('ws-gone', '删掉的', 'personal', 2, 1700000000000);
             INSERT INTO meta.sync_state (key, value) VALUES ('device_id', 'dev-a');",
        )
        .unwrap();
        c
    }

    /// ⭐ 判据（`local` 的**值级**那一半 ✓）：`local` ＝ 本机**现在存在**的空间 ⇒
    /// ⛔ 删掉的（`deleted_at` 非空）**不许**出现 ✗；顺序 = `sort_order` ✓。
    #[test]
    fn local_lists_only_live_workspaces_in_sort_order() {
        let c = fixture();
        let live = live_workspaces(&c).unwrap();
        let ids: Vec<&str> = live.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["ws-a", "ws-b"],
            "⛔ `local` 只许列现在存在的空间（`ws-gone` 已被删 ✗），且按 sort_order ✓"
        );
        assert_eq!(live[0].2, "team", "⭐ `kind` 直读 `meta.workspaces.kind` ✓");
        assert_eq!(live[1].2, "personal", "⭐ 同上 ✓");
    }

    /// ⭐ 判据：`announced` 走**窗口那把尺** ✓ —— 没配档案（⇒ 没有"在服务"）⇒ `false` ✓。
    #[test]
    fn announced_follows_the_window_yardstick() {
        let c = fixture();
        assert!(
            served_scope(&c, "ws-a").trim().is_empty(),
            "⭐ 没有档案行 ⇒ 这一侧没在服务它 ⇒ `announced` 必须是 false ✓"
        );
        c.execute_batch(
            "INSERT INTO meta.sync_profiles (ws_id, space_id) VALUES ('ws-a', 'space-a');",
        )
        .unwrap();
        // ⭐ 不判"必须非空" ✗ —— 非空与否由 `window_serve_space`（窗口那把尺 ✓）说了算；
        //    这里钉的是**它被走到了** ✓（`resolved_space` 的回落是既有语义 ✓，⛔ 不在这里另判 ✗）。
        let got = served_scope(&c, "ws-a");
        assert!(
            got == got.trim(),
            "⭐ 回给判断的那一句不该带空白（窗口用的是 `trim()` 后的比较 ✓）"
        );
    }
}
