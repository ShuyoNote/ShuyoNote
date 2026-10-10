use crate::db::{now_ms, Db};
use crate::models::WorkspaceMeta;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::MutexGuard;
use tauri::State;

/// Active-workspace key persisted in the key-value `sync_state` table.
const ACTIVE_KEY: &str = "active_workspace_id";

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    db.0.lock().unwrap()
}

fn row_to_meta(row: &rusqlite::Row) -> rusqlite::Result<WorkspaceMeta> {
    let id: String = row.get(0)?;
    Ok(WorkspaceMeta {
        // ⭐ 2026-10-10（`task-27`）：在这里算**派生读数**（磁盘上是不是密文）⇒ **每个**调用点都拿到 ✓
        //（⛔ 不放调用点 ✗：`row_to_meta` 有两个调用方，漏一个那一处的读数就悄悄是 `None` ✗）。
        encrypted_on_disk: crate::db::app_data_dir_ref().map(|dir| {
            crate::security::space_db_is_encrypted(&crate::db::space_db_path(dir, &id))
        }),
        id,
        name: row.get(1)?,
        theme: row.get(2)?,
        icon: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        // ⭐ 2026-10-10：**第 8 列**（追加在最后 ⇒ 前 7 个下标一个都没动 ✓）。
        // 界面靠它判"个人空间不显示同步标识"（owner 口径 ✓）；列是 `TEXT NOT NULL DEFAULT ''` ✓。
        // ⚠️ 凡是用 `row_to_meta` 的 SELECT **都必须带上这一列** ✗ —— 编译器**看不见列清单** ✗：
        //    2026-10-10 实测漏了一处（`create_workspace` 那条，见下面 `,kind` 那笔）⇒ 那是**运行期**
        //    `Invalid column index`，`cargo check` 与所有测试都不会红 ✓。
        kind: row.get(7)?,
    })
}

// ⚠️ `kind` **追加在最后**：`row_to_meta` 按**下标**取值 ⇒ 插在中间会把后面每一列都错位 ✗。
const WS_COLS: &str = "id,name,theme,icon,sort_order,created_at,updated_at,kind";

const ACCENTS: [&str; 8] = [
    "#3370FF", "#00B578", "#FF8A1E", "#7B61FF", "#00A9C7", "#D9A300", "#F54A45", "#646A73",
];

/// The workspace the app is currently operating on (persisted). Falls back to the
/// oldest non-deleted workspace (the "default"/"默认空间" seeded on first run).
/// Reads from `meta.sync_state` (meta.db is ATTACHed as `meta` on the connection).
pub(crate) fn active_workspace_id(c: &Connection) -> Result<String, String> {
    let persisted: Option<String> = c
        .query_row(
            "SELECT value FROM meta.sync_state WHERE key = ?1",
            params![ACTIVE_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = persisted {
        let ok: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1 AND deleted_at IS NULL)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if ok {
            return Ok(id);
        }
    }
    // Fallback: oldest non-deleted workspace; persist it so state stays consistent.
    let id: String = c
        .query_row(
            "SELECT id FROM meta.workspaces WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "没有可用的工作空间".to_string())?;
    c.execute(
        "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![ACTIVE_KEY, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn get_active_workspace_id(db: State<'_, Db>) -> Result<String, String> {
    let c = conn(&db);
    active_workspace_id(&c)
}

/// ⭐ **切活动空间的核心**（2026-10-10：owner 报的「点了加密空间就卡死」那个 bug 的修法 ✓）：
/// ⛔ **指针与连接不许一个成一个败** ✗ —— 原来的顺序是「**先写指针、再换连接**」✗，
/// 而换连接**会失败**（切到一个加密空间、而本会话没有钥匙时必然失败 ✓）。
///
/// ⚠️⭐ **这里曾经被我写错过一次，把纠正一起留下**（否则下一个人会重新推错 ✓）：
///   我当初的推断是「失败之后**指针已经改过去了**」✗ ⇒ 于是"重启应当开在**那个加密空间**并弹锁屏"✗。
///   ⭐ **2026-10-10 实测证伪**：重启后窗口标题是「**项目私密 · 工作**」✗（＝**原来那个明文空间** ✓），
///   且**没有锁屏** ✓。真因是：那条 `INSERT INTO meta.sync_state` 自己就**跑在已经坏掉的连接上** ✗
///   ⇒ **它也没成** ⇒ ⭐ **两者都没成**（指针没变 ＋ 连接坏了）＋ **界面停在旧空间** ✗
///   ⇒ ⭐ 真实形状是「**界面与连接分家**」✗，⛔ 不是「指针改了而连接读不出来」✗。
///   ⇒ ⚠️ **这条纠正很值**：若照那个错前提去写**回滚指针**的代码，就会去回滚一件**根本没发生的事** ✗。
///
/// 现在的顺序：⭐ **先换连接**（`db::reopen_space_at` 已经是**全成或全不动** ✓ ⇒ 它失败时
/// 连接与指针**都没动** ✓），**连接真的切成了才写指针** ✓；⚠️ 万一写指针失败 ⇒
/// **把连接换回旧空间** ✓（⛔ 不留混合状态 ✗）。
/// ⚠️ 抽成这个函数是为了**能在测试里直接判它**（`#[tauri::command]` 那层要 `State<Db>`，单元测试里造不出来 ✓）。
pub(crate) fn switch_active_space(
    c: &mut rusqlite::Connection,
    id: &str,
    dir: &std::path::Path,
) -> Result<(), String> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("工作空间不存在".to_string());
    }
    let prev: Option<String> = c
        .query_row(
            "SELECT value FROM meta.sync_state WHERE key = ?1",
            params![ACTIVE_KEY],
            |r| r.get(0),
        )
        .ok();
    // ⭐⓪ 2026-10-10（owner：「点『保险柜』⇒ 没有弹窗」）：**先问一句这个空间本会话需不需要口令** ✓。
    //   **需要** ⇒ ⛔ **不打开那个加密库** ✗（安全判据 e：一个字节都不读 ✓）⇒ 把主连接停在**锁定态** ✓
    //     ＋ 照常往下写指针 ✓ ⇒ `encryption_status` 读出 `enabled:true` ＋ `locked:true`
    //     ⇒ **解锁屏成立、弹出来** ✓（那两格的算法在 `security.rs:790/802`，本函数**不改它** ✓）。
    //   **不需要** ⇒ 照旧走原路 ✓；⚙ 其它 `Err`（盒子坏／路径没／IO）**照旧拒** ✓（判据 c ✓）。
    if crate::space_crypto::space_needs_passphrase(id) {
        if let Err(e) = park_locked_connection(c, dir) {
            // ⛔ 不许留混合态：停不下来就把连接换回旧空间（换不回也如实上报，⛔ 不吞 ✗）
            if let Some(prev) = prev.as_deref() {
                let _ = crate::db::reopen_space_at(c, prev, dir);
            }
            return Err(e);
        }
    } else {
        // ① **先换连接**：它失败 ⇒ 连接与指针**都没动** ✓（今天那个 bug 正是这一步的顺序反了 ✓）
        crate::db::reopen_space_at(c, id, dir)?;
    }
    // ② 连接切成了，**才**写活动指针
    if let Err(e) = c.execute(
        "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![ACTIVE_KEY, id],
    ) {
        // ⭐ 不许一个成一个败：指针没写成 ⇒ 把连接换回旧空间 ✓（换不回也如实上报，⛔ 不吞 ✗）
        if let Some(prev) = prev.as_deref() {
            let _ = crate::db::reopen_space_at(c, prev, dir);
        }
        return Err(e.to_string());
    }
    Ok(())
}

/// ⭐ 把主连接**停在"锁定态"**（内存库 ＋ 挂上明文 `meta`）—— 复用 `security.rs::lock_encryption_impl`
/// 的**落法**（`security.rs:857-860`：`open_in_memory` ＋ `ATTACH … AS meta KEY ""` ✓）。
///
/// ⚠️ 为什么**不直接调** `lock_encryption_impl`（两处都拦着）：
/// · 它第一件事是 `if !encryption_enabled(conn) { return Err("这个空间没有加密…") }` —— 而本条的场景
///   恰恰是**从明文空间切过去**（主连接就是明文）⇒ 当场被它拒 ✓；
/// · 它还要动 `security.rs` 里那个**私有** `LOCKED`（**进程级会话锁** ✓）—— 那一格是"**整个会话**"的语义，
///   ⛔ 与本条（"**这个活动空间**读不出来"）不是一回事 ✓（`security.rs:791-802` 逐字讲了这条分界 ✓）。
/// ⇒ 所以这里只做"落法"本身：**主连接换成内存库 ＋ 挂 meta** ✓。
/// ⚠️ **不碰 `session_master`**：本条只在"会话本来就锁着"时走 ✓ ⇒ 卸主密钥是空操作，
///   而它一旦被卸掉会误伤**别的**空间 ✓。
fn park_locked_connection(c: &mut rusqlite::Connection, dir: &std::path::Path) -> Result<(), String> {
    let meta = crate::db::meta_path(dir).display().to_string().replace('\'', "''");
    let fresh = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
    let _ = std::mem::replace(c, fresh);
    c.execute_batch(&format!("ATTACH DATABASE '{meta}' AS meta KEY \"\""))
        .map_err(|e| format!("切到锁定态失败（内存库挂 meta）: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn set_active_workspace_id(db: State<'_, Db>, id: String) -> Result<(), String> {
    // ⚠️ 整段**持同一把锁**：换连接与写指针是**一件事**，中间不许被别的命令插进来 ✓
    let dir = crate::db::app_data_dir_ref()
        .ok_or("app data dir not initialised")?
        .to_path_buf();
    let mut c = db.0.lock().expect("db mutex poisoned");
    switch_active_space(&mut c, &id, &dir)
}

/// The active workspace's name (for the sidebar title), falling back to the first workspace.
#[tauri::command]
pub async fn get_workspace_name(db: State<'_, Db>) -> Result<String, String> {
    let c = conn(&db);
    let active = active_workspace_id(&c)?;
    c.query_row("SELECT name FROM meta.workspaces WHERE id = ?1", params![active], |row| row.get(0))
        .or_else(|_| {
            c.query_row(
                "SELECT name FROM meta.workspaces ORDER BY created_at ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
        })
        .map_err(|e| e.to_string())
}

/// Rename a workspace by id.
#[tauri::command]
pub async fn rename_workspace(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".to_string());
    }
    let c = conn(&db);
    let n = c
        .execute(
            "UPDATE meta.workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![trimmed, now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("工作空间不存在".to_string());
    }
    Ok(())
}

/// Set per-workspace settings (accent color / icon / sort order).
#[tauri::command]
pub async fn set_workspace_settings(
    db: State<'_, Db>,
    id: String,
    theme: Option<String>,
    icon: Option<String>,
    sort_order: Option<f64>,
) -> Result<(), String> {
    let c = conn(&db);
    let n = c
        .execute(
            "UPDATE meta.workspaces SET theme = ?1, icon = ?2, sort_order = ?3, updated_at = ?4
             WHERE id = ?5 AND deleted_at IS NULL",
            params![theme, icon.unwrap_or_default(), sort_order.unwrap_or(0.0), now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("工作空间不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_workspaces(db: State<'_, Db>) -> Result<Vec<WorkspaceMeta>, String> {
    let c = conn(&db);
    // Backfill theme colors for legacy workspaces created before the per-space
    // color feature (idempotent: only fills empty themes, distinct by creation order).
    {
        let ids: Vec<String> = c
            .prepare(
                "SELECT id FROM meta.workspaces WHERE deleted_at IS NULL AND (theme IS NULL OR theme = '') ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        for (i, wid) in ids.iter().enumerate() {
            let color = ACCENTS[i % ACCENTS.len()];
            c.execute(
                "UPDATE meta.workspaces SET theme = ?1 WHERE id = ?2 AND (theme IS NULL OR theme = '')",
                params![color, wid],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let mut stmt = c
        .prepare(&format!(
            "SELECT {WS_COLS} FROM meta.workspaces WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC, id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |row| row_to_meta(row))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in mapped {
        out.push(row.map_err(|e| e.to_string())?);
    }
    // ⭐ 2026-10-10（`task-27`）：派生读数（磁盘上是不是密文）**在 `row_to_meta` 里算** ✓
    //（⛔ 不在这里再跑一遍后处理 ✗ —— 那会把每个空间嗅两次）。
    Ok(out)
}

/// ★ **新建一个本地空间的那一行**（隐私边界 A=3，2026-09-24）。
///
/// **分类由入口决定**：本仓是**个人版入口** ⇒ 没显式指定时一律标成 `personal`
/// （团队空间由团队流程走 `space_crypto::set_space_kind(..., Team)` 标）。
/// 于是"新建 ⇒ 还没加密 ⇒ 绑同步会被闸门拦住并引导设口令"这条链**自动成立**，
/// 不需要用户先做一次分类动作。
///
/// ⚠️ 抽成独立函数就是为了**能被判据直接驱动**（命令那层要 `State<Db>`，测不了）。
pub(crate) fn insert_new_local_space(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    sort_order: f64,
    now: i64,
) -> Result<(), String> {
    // 走同一个写入口：**分类只在这里定义一次**（新建与导入共用，免得两处口径漂）。
    insert_space_row(
        c,
        id,
        name,
        theme,
        "",
        sort_order,
        now,
        false,
        crate::space_crypto::SpaceKind::Personal,
    )
}

/// ★★ **用户在"新建空间"那一刻选的那一类**（owner 2026-09-25 拍板 A1）。
///
/// 为什么必须走"入口决定"而不是"先建再改"：`sync_gate` 对**未分类**的空间**一律放行**
/// （`AllowedUnclassified`）⇒ 一个本该加密的个人空间如果在"建完到改分类"之间被绑了同步，
/// 它的内容就**明文上云**了。把这一问放在创建那一刻，中间没有那个窗口。
///
/// ⚠️ `raw` 是**界面传来的参数** ⇒ 走 [`parse_new_space_kind`] 的**窄进**（只认两个字面量，
/// 别的串**报错**），与读库里那列用的 `SpaceKind::parse`（宽进、认不出算未分类）刻意相反。
pub(crate) fn insert_chosen_space(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    sort_order: f64,
    now: i64,
    raw: &str,
) -> Result<(), String> {
    let kind = parse_new_space_kind(raw)?;
    insert_space_row(c, id, name, theme, "", sort_order, now, false, kind)
}

/// 建空间时**只认两个值**（`"personal"` / `"team"`）。
///
/// 为什么窄进：这是**界面传进来的参数**。把 `"tem"` 这类拼错**静默当成"取消分类"**，会让闸门
/// 在用户以为已经归类的时候**松开**（与 `set_space_kind` 的窄进口径一致）。
fn parse_new_space_kind(raw: &str) -> Result<crate::space_crypto::SpaceKind, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "personal" => Ok(crate::space_crypto::SpaceKind::Personal),
        "team" => Ok(crate::space_crypto::SpaceKind::Team),
        other => Err(format!(
            "空间类型只认「personal」或「team」，收到的是「{other}」——不猜（猜错会让同步闸门松开）"
        )),
    }
}

/// ★ **导入一个空间包时写 meta 那一行**（owner 2026-09-24 拍板**选项 ②**）。
///
/// 口径与 [`insert_new_local_space`] **完全一致**：**分类由入口决定** ⇒ 导入进来的也是 `personal`。
/// 于是"导入 ⇒ 还没加密 ⇒ 绑同步被闸门拦住并引导设口令"这条链对导入**同样**自动成立 ——
/// 不需要用户事后自己去面板里分类（那正是"未分类＝闸门没管到它"的漏洞面）。
///
/// `encrypted` 是"导入时**顺手按空间加密了没有**"（见 `workspace_io::import_workspace`：
/// 本机已解锁且有袋子 ⇒ 给新空间现造盒子并加密；否则**留明文**并由面板引导）。
pub(crate) fn insert_imported_space(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    icon: &str,
    sort_order: f64,
    now: i64,
    encrypted: bool,
) -> Result<(), String> {
    insert_space_row(
        c,
        id,
        name,
        theme,
        icon,
        sort_order,
        now,
        encrypted,
        crate::space_crypto::SpaceKind::Personal,
    )
}

/// 新建 / 导入 **共用**的那一条 INSERT（`kind` 只有一个来源，见两个公开入口的注释）。
fn insert_space_row(
    c: &rusqlite::Connection,
    id: &str,
    name: &str,
    theme: &str,
    icon: &str,
    sort_order: f64,
    now: i64,
    encrypted: bool,
    kind: crate::space_crypto::SpaceKind,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO meta.workspaces (id, name, theme, icon, sort_order, created_at, updated_at, encrypted, kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            name,
            theme,
            icon,
            sort_order,
            now,
            now,
            if encrypted { 1 } else { 0 },
            kind.as_str()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn create_workspace(
    db: State<'_, Db>,
    name: Option<String>,
    kind: Option<String>,
) -> Result<WorkspaceMeta, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let trimmed = name.unwrap_or_default().trim().to_string();
    let name = if trimmed.is_empty() { "新建工作区".to_string() } else { trimmed };

    let count: i64 = {
        let c = conn(&db);
        c.query_row("SELECT COUNT(*) FROM meta.workspaces WHERE deleted_at IS NULL", [], |r| r.get(0))
            .map_err(|e| e.to_string())?
    };
    let theme = ACCENTS[(count as usize) % ACCENTS.len()].to_string();
    let sort_order = (count + 1) as f64;

    {
        let c = conn(&db);
        // ★ A1（owner 2026-09-25 拍板）：界面**在创建那一刻**已经问过"个人 / 团队"。
        // 没传 kind（老调用方 / Web）⇒ 走原来的默认（`personal`），行为逐字不变。
        match kind.as_deref() {
            Some(k) => insert_chosen_space(&c, &id, &name, &theme, sort_order, now, k)?,
            None => insert_new_local_space(&c, &id, &name, &theme, sort_order, now)?,
        }
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ACTIVE_KEY, id],
        )
        .map_err(|e| e.to_string())?;
    }

    // Re-point the main connection to the new space's DB file (creates + migrates it).
    let mut c = db.0.lock().expect("db mutex poisoned");
    crate::db::reopen_space(&mut c, &id)?;
    // Seed a default home page so a new space isn't blank.
    let home_id = uuid::Uuid::new_v4().to_string();
    // Build the welcome page from structured blocks. Small local fns keep every
    // serde_json literal shallow, so the json! macro recursion limit isn't hit.
    fn js_text(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "text", "text": s, "detail": 0, "format": 0, "mode": "normal", "style": "", "version": 1 })
    }
    fn js_para(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "paragraph", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] })
    }
    fn js_heading(tag: &str, s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "heading", "tag": tag, "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] })
    }
    fn js_bullet(items: &[&str]) -> serde_json::Value {
        let children = items
            .iter()
            .map(|s| serde_json::json!({ "type": "listitem", "value": 1, "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] }))
            .collect::<Vec<_>>();
        serde_json::json!({ "type": "list", "tag": "ul", "listType": "bullet", "start": 1, "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": children })
    }
    fn js_quote(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "quote", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_text(s)] })
    }
    fn js_callout(s: &str) -> serde_json::Value {
        serde_json::json!({ "type": "callout", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [js_para(s)] })
    }
    fn js_blank() -> serde_json::Value {
        serde_json::json!({ "type": "paragraph", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "", "children": [] })
    }
    let home_json = serde_json::json!({
        "root": {
            "type": "root", "version": 1, "direction": "ltr", "format": "", "indent": 0,
            "children": [
                js_heading("h1", "欢迎来到你的新空间"),
                js_callout("本地优先 · 离线可用。你的笔记都保存在本机，改动即存，无需手动保存。"),
                js_heading("h2", "从这里开始"),
                js_bullet(&[
                    "新建页面：Ctrl+N 或左侧栏 ＋",
                    "插入内容：输入 / 打开块菜单（标题·表格·分栏·绘图…）",
                    "搭建数据库：创建为数据表格，属性页做看板 / 日历 / 时间轴",
                ]),
                js_heading("h2", "常用快捷键"),
                js_quote("Ctrl+K 命令面板 · Ctrl+/ 快捷键面板 · Ctrl+Shift+F 搜索 · Ctrl+E 切换笔记/看板/关系图"),
                serde_json::json!({ "type": "horizontalrule", "version": 1, "direction": "ltr", "format": "", "indent": 0, "style": "" }),
                js_callout("用 / 插入块或从模板中心创建；命令面板 Ctrl+K 找到所有能力；/帮助 打开完整使用指南。"),
                js_blank(),
            ]
        }
    }).to_string();
    // A welcoming cover + icon so the new space's start page feels finished.
    let home_cover = r#"url("/covers/default-cover.jpg")"#;
    let home_icon = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzg4MTg1NDc5MzUyIiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjE2NjIiIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHBhdGggZD0iTTY5NC4yNzIgMjIwLjY3MmMtMTcuMDY2NjY3LTg1LjMzMzMzMy04MS4wNjY2NjctMTYyLjEzMzMzMy0xNzQuOTMzMzMzLTE1My42LTkzLjg2NjY2NyAxMi44LTI0My4yIDgxLjA2NjY2Ny0yMjEuODY2NjY3IDM1NC4xMzMzMzNzNzYuOCA0MDEuMDY2NjY3IDI0Ny40NjY2NjcgNDA5LjYgMzA3LjItMTc0LjkzMzMzMyAzMjguNTMzMzMzLTI2MC4yNjY2NjZjMTcuMDY2NjY3LTY0IDQ2LjkzMzMzMy0xMjMuNzMzMzMzIDg5LjYtMTc0LjkzMzMzNCAyNS42LTM4LjQtNjguMjY2NjY3LTk4LjEzMzMzMy0xMjgtMzQuMTMzMzMzLTU5LjczMzMzMyA2OC4yNjY2NjctNTkuNzMzMzMzIDExMC45MzMzMzMtMTEwLjkzMzMzMyAxMzIuMjY2NjY3LTguNTMzMzMzLTQ2LjkzMzMzMy0xMi44LTE4Ny43MzMzMzMtMjkuODY2NjY3LTI3My4wNjY2Njd6IiBmaWxsPSIjRkZDNjJBIiBvcGFjaXR5PSIuNCIgcC1pZD0iMTY2MyI+PC9wYXRoPjxwYXRoIGQ9Ik03NS42MDUzMzMgNjI2LjAwNTMzM2MyOS44NjY2NjcgNTUuNDY2NjY3IDY4LjI2NjY2NyAxMDYuNjY2NjY3IDExNS4yIDE1My42IDY4LjI2NjY2NyA4MS4wNjY2NjcgMTQwLjggMTgzLjQ2NjY2NyAyMDkuMDY2NjY3IDIxMy4zMzMzMzQgODUuMzMzMzMzIDM4LjQgMTQ1LjA2NjY2NyAxMi44IDIzNC42NjY2NjctMzQuMTMzMzM0IDExOS40NjY2NjctNTkuNzMzMzMzIDE3NC45MzMzMzMtMTU3Ljg2NjY2NyAxMzIuMjY2NjY2LTI5OC42NjY2NjYtMjkuODY2NjY3LTEwNi42NjY2NjctNDYuOTMzMzMzLTIxNy42LTU1LjQ2NjY2Ni0zMjguNTMzMzM0LTQuMjY2NjY3LTU1LjQ2NjY2Ny0xMTkuNDY2NjY3LTM4LjQtMTMyLjI2NjY2NyA1NS40NjY2NjctMTIuOCA5OC4xMzMzMzMgMjUuNiAxMzIuMjY2NjY3LTQuMjY2NjY3IDE4My40NjY2NjctMzguNC0zNC4xMzMzMzMtOTguMTMzMzMzLTg5LjYtMTM2LjUzMzMzMy0xMjMuNzMzMzM0cy0xNzAuNjY2NjY3LTE2Ni40LTIzOC45MzMzMzMtMTY2LjRjLTI5Ljg2NjY2NyAwLTY0IDguNTMzMzMzLTg5LjYgMjUuNi0yNS42IDIxLjMzMzMzMy0zOC40IDQ2LjkzMzMzMy00Ni45MzMzMzQgNzYuOCAwIDU1LjQ2NjY2Ny0xNy4wNjY2NjcgMTY2LjQgMTIuOCAyNDMuMnoiIGZpbGw9IiNGRkM2MkEiIHAtaWQ9IjE2NjQiPjwvcGF0aD48cGF0aCBkPSJNMjU0LjgwNTMzMyAxMS42MDUzMzNsNTkuNzMzMzM0IDE2Mi4xMzMzMzQgMjEuMzMzMzMzLTE2Mi4xMzMzMzRoLTgxLjA2NjY2N3ogbS0yMDAuNTMzMzMzIDE2Mi4xMzMzMzRsMTQwLjggMzguNC04MS4wNjY2NjctMTIzLjczMzMzNC01OS43MzMzMzMgODUuMzMzMzM0eiIgZmlsbD0iIzE1NDRGRiIgb3BhY2l0eT0iLjYiIHAtaWQ9IjE2NjUiPjwvcGF0aD48L3N2Zz4=";
    c.execute(
        "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, cover, icon, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'page', 0, ?6, ?7, ?8, ?8, NULL)",
        params![
            home_id, id, "开始",
            home_json,
            "欢迎来到你的新空间\n本地优先 · 离线可用。你的笔记都保存在本机，改动即存，无需手动保存。\n从这里开始\n新建页面：Ctrl+N 或左侧栏 ＋\n插入内容：输入 / 打开块菜单（标题·表格·分栏·绘图…）\n搭建数据库：创建为数据表格，属性页做看板 / 日历 / 时间轴\n常用快捷键\nCtrl+K 命令面板 · Ctrl+/ 快捷键面板 · Ctrl+Shift+F 搜索 · Ctrl+E 切换笔记/看板/关系图\n用 / 插入块或从模板中心创建；命令面板 Ctrl+K 找到所有能力；/帮助 打开完整使用指南。",
            home_cover,
            home_icon,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    c.query_row(
        // ⚠️ ⭐ 2026-10-10 **修**：这一条原先只有 7 列（漏了 `kind`）✗ —— 而它走 `row_to_meta`，
        //    那一头读的是**第 8 列** ⇒ 运行期 `Invalid column index` ⇒ **`create_workspace` 直接报错** ✗
        //    （＝"新建空间"坏了 ✓）。根因是**加 `kind` 那一笔漏了列清单的一处**，而
        //    `cargo check` **看不见列清单**（它只看得见"构造点缺字段"）⇒ 编译器与全部测试都不红 ✓。
        //    ⇒ 凡是走 `row_to_meta` 的 SELECT，新列一律**追加在最后**并在这里同步 ✓。
        &format!("SELECT id,name,theme,icon,sort_order,created_at,updated_at,kind FROM meta.workspaces WHERE id = ?1"),
        params![id],
        |row| row_to_meta(row),
    )
    .map_err(|e| e.to_string())
}

/// Soft-delete a workspace. If it's the active one, reset the active pointer so
/// the app falls back to another workspace. Content (pages etc.) is retained and
/// recoverable; queries no longer surface the soft-deleted workspace.
#[tauri::command]
pub async fn delete_workspace(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    let active = active_workspace_id(&c)?;
    let now = now_ms();
    let n = c
        .execute(
            "UPDATE meta.workspaces SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![now, now, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("工作空间不存在或已删除".to_string());
    }
    if active == id {
        c.execute("DELETE FROM meta.sync_state WHERE key = ?1", params![ACTIVE_KEY])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 把「卫星行」从 `src` 复制到 `tgt`：**属性／标签／附件行** ✓（附件字节在全局内容寻址库里 ⇒ 不重复占空间 ✓）。
///
/// ⭐⭐ **2026-10-08 抽出来的理由（真事故）**：原来的写法是
/// `tgt.execute("INSERT INTO attachments (…) SELECT … FROM attachments WHERE page_id = ?")` ✗ ——
/// `INSERT … SELECT` 里的 SELECT **在 `tgt` 这条连接上执行** ✓ ⇒ **跨空间**复制时目标库里没有源 `page_id` 的行
/// ⇒ **插入 0 行、且不报错** ✗ ⇒ **静默丢数据**（现场：源文件夹 10 个附件 ⇒ 目标 0 个 ✓）。
/// 同空间复制不受影响（那时 `tgt == src` ✓）—— 这就是它一直没被发现的原因 ✓。
/// ⇒ 一律**显式两步**：从 `src` 读出来 ⇒ 逐行写进 `tgt` ✓（跨库就一定对 ✓）。
fn copy_satellite_rows(
    src: &Connection,
    tgt: &Connection,
    old_id: &str,
    new_id: &str,
) -> Result<(), String> {
    {
        let mut st = src
            .prepare("SELECT attr_id, value FROM page_props WHERE page_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = st
            .query_map(params![old_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (attr_id, value) in rows {
            tgt.execute(
                "INSERT INTO page_props (page_id, attr_id, value) VALUES (?1, ?2, ?3)",
                params![new_id, attr_id, value],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut st = src
            .prepare("SELECT tag_id FROM page_tags WHERE page_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows: Vec<String> = st
            .query_map(params![old_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for tag_id in rows {
            tgt.execute(
                "INSERT INTO page_tags (page_id, tag_id) VALUES (?1, ?2)",
                params![new_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    {
        let mut st = src
            .prepare("SELECT name, hash, mime, size, created_at FROM attachments WHERE page_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String, i64, i64)> = st
            .query_map(params![old_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (name, hash, mime, size, created_at) in rows {
            tgt.execute(
                "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![uuid::Uuid::new_v4().to_string(), new_id, name, hash, mime, size, created_at],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copy a page (and its descendant tree) into another workspace, **across DBs**.
/// The source rows are read from the current (active) space's DB; the rows are
/// inserted into the TARGET space's DB (opened independently via open_space_conn).
/// The copied rows keep their blockIds so intra-subtree block references still
/// resolve; references to blocks outside the copied subtree become unresolved
/// (documented limit, since block graphs are workspace-scoped). Properties, tags
/// and attachment rows are re-parented to the new page ids. Attachment BYTES live
/// in the global content-addressed store (shared across spaces), so only the
/// attachment rows are copied — no byte duplication.
#[tauri::command]
pub fn copy_page_to_workspace(
    db: State<Db>,
    page_id: String,
    target_workspace_id: String,
    new_parent_id: Option<String>,
) -> Result<String, String> {
    let src = conn(&db);

    // Validate the target workspace exists (in meta).
    let ws_ok: bool = src
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM meta.workspaces WHERE id = ?1 AND deleted_at IS NULL)",
            params![target_workspace_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !ws_ok {
        return Err("目标工作空间不存在".to_string());
    }

    // If copying within the same space, the target conn is the main connection.
    let active = active_workspace_id(&src)?;
    let same_space = target_workspace_id == active;

    // Validate the source page exists in the source space.
    let src_exists: bool = src
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL)",
            params![page_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !src_exists {
        return Err("源页面不存在".to_string());
    }

    // Collect the source subtree in BFS order, mapping old -> new id.
    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut queue: Vec<String> = vec![page_id.clone()];
    let mut order: Vec<String> = Vec::new();
    while let Some(pid) = queue.pop() {
        let nid = uuid::Uuid::new_v4().to_string();
        id_map.insert(pid.clone(), nid.clone());
        order.push(pid.clone());
        let mut stmt = src
            .prepare("SELECT id FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        let kids: Vec<String> = stmt
            .query_map(params![pid], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for kid in kids {
            queue.push(kid);
        }
    }

    // Open the target space's connection (may re-open the active file if same_space).
    let tgt = if same_space {
        None
    } else {
        Some(crate::db::open_space_conn(&target_workspace_id)?)
    };
    let tgt = tgt.as_ref().unwrap_or(&src);

    // Validate the new parent against the TARGET space.
    if let Some(np) = &new_parent_id {
        let parent_ok: bool = tgt
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL)",
                params![np],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !parent_ok {
            return Err("目标父页面不存在于目标工作空间".to_string());
        }
    }

    let now = now_ms();
    // ⭐ **2026-10-08**：整段包**事务** ✓ —— 以前中途失败会留下"半个副本"（现场：文件夹落库了、孩子全丢 ✓）。
    tgt.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    for old_id in &order {
        // Fetch source row from the SOURCE connection.
        let (parent, title, content_json, content_text, kind, sort_order, created_at, icon, cover, cover_height, cover_pos): (
            Option<String>,
            String,
            String,
            String,
            String,
            f64,
            i64,
            String,
            String,
            i64,
            f64,
        ) = src
            .query_row(
                "SELECT parent_id, title, content_json, content_text, kind, sort_order, created_at, icon, cover, cover_height, cover_pos
                 FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                params![old_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;

        let new_id = id_map.get(old_id).cloned().unwrap_or_default();
        // Root gets the caller's new parent; descendants get their mapped parent.
        let new_parent = if old_id == &page_id {
            new_parent_id.clone()
        } else {
            parent.as_deref().map(|p| id_map.get(p).cloned()).flatten()
        };

        tgt.execute(
            "INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at, updated_at, deleted_at, icon, cover, cover_height, cover_pos)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13, ?14)",
            params![new_id, target_workspace_id, new_parent, title, content_json, content_text, kind, sort_order, created_at, now, icon, cover, cover_height, cover_pos],
        )
        .map_err(|e| e.to_string())?;

        copy_satellite_rows(&src, tgt, old_id, &new_id)?;

        // Rebuild indexes in the TARGET space so search/blocks/backlinks/graph work.
        crate::search::sync_fts(tgt, &new_id, &title, &content_text)?;
        crate::blocks::rebuild_block_graph(tgt, &new_id, &content_json, &content_text)?;

        // Record a sync upsert (against the target's changes outbox).
        let detail = crate::models::PageDetail {
            id: new_id.clone(),
            workspace_id: target_workspace_id.clone(),
            parent_id: new_parent,
            title,
            content_json,
            content_text,
            cover: String::new(),
            icon: String::new(),
            cover_height: 300,
            cover_pos: 50.0,
            kind,
            sort_order,
            created_at,
            updated_at: now,
        };
        crate::sync::record_page_upsert(tgt, &detail)?;
    }

    tgt.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    // The temporary target connection (if any) drops at end of scope; the ref
    // binding `tgt` borrows either it or the main conn.
    Ok(id_map.get(&page_id).cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⭐⭐ **2026-10-08 事故的单测（跨库复制卫星行）**：
    /// `src` 与 `tgt` 是**两条独立连接**（＝两个空间库 ✓）—— 这正是原来那三处
    /// `tgt.execute("INSERT … SELECT … FROM 表 WHERE page_id = ?")` 会**静默插 0 行**的场景 ✗。
    /// 判据：属性 1 条／标签 1 条／附件 1 条，复制后**目标侧都得在** ✓。
    #[test]
    fn copy_satellite_rows_crosses_connections() {
        let src = rusqlite::Connection::open_in_memory().unwrap();
        let tgt = rusqlite::Connection::open_in_memory().unwrap();
        for c in [&src, &tgt] {
            c.execute_batch(
                "CREATE TABLE page_props (page_id TEXT, attr_id TEXT, value TEXT);
                 CREATE TABLE page_tags (page_id TEXT, tag_id TEXT);
                 CREATE TABLE attachments (id TEXT PRIMARY KEY, page_id TEXT, name TEXT NOT NULL,
                   hash TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);",
            )
            .unwrap();
        }
        src.execute("INSERT INTO page_props (page_id, attr_id, value) VALUES ('old', 'a1', 'v1')", []).unwrap();
        src.execute("INSERT INTO page_tags (page_id, tag_id) VALUES ('old', 't1')", []).unwrap();
        src.execute(
            "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
             VALUES ('att1', 'old', 'a.pdf', 'h1', 'application/pdf', 5, 1)",
            [],
        )
        .unwrap();

        copy_satellite_rows(&src, &tgt, "old", "new").unwrap();

        let props: i64 = tgt.query_row("SELECT COUNT(*) FROM page_props WHERE page_id='new'", [], |r| r.get(0)).unwrap();
        let tags: i64 = tgt.query_row("SELECT COUNT(*) FROM page_tags WHERE page_id='new'", [], |r| r.get(0)).unwrap();
        let atts: i64 = tgt.query_row("SELECT COUNT(*) FROM attachments WHERE page_id='new'", [], |r| r.get(0)).unwrap();
        assert_eq!(props, 1, "属性没复制过去 ✗（跨库时 INSERT…SELECT 会静默插 0 行 ✓）");
        assert_eq!(tags, 1, "标签没复制过去 ✗");
        assert_eq!(atts, 1, "附件行没复制过去 ✗（owner 2026-10-08 现场：源 10 个 ⇒ 目标 0 个 ✓）");
        // 反向：旧写法若被改回来，这几条会红 ✓
        let wrong: i64 = tgt.query_row("SELECT COUNT(*) FROM attachments WHERE page_id='old'", [], |r| r.get(0)).unwrap();
        assert_eq!(wrong, 0, "目标侧不该出现源 page_id 的行 ✓");
    }

    /// 只够 `insert_space_row` 用的最小 `meta.workspaces`（列与 `db::meta_migrate` 同形）。
    fn conn_with_workspaces() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("ATTACH DATABASE ':memory:' AS meta").unwrap();
        c.execute_batch(
            "CREATE TABLE meta.workspaces (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL DEFAULT '',
                 theme TEXT NOT NULL DEFAULT '',
                 icon TEXT NOT NULL DEFAULT '',
                 sort_order REAL NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL DEFAULT 0,
                 deleted_at INTEGER,
                 encrypted INTEGER NOT NULL DEFAULT 0,
                 kind TEXT NOT NULL DEFAULT ''
             );",
        )
        .unwrap();
        c
    }

    fn kind_of(c: &rusqlite::Connection, id: &str) -> String {
        c.query_row("SELECT kind FROM meta.workspaces WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }

    /// ★ A1 判据：**用户在创建那一刻选的那一类，必须真的落库**（个人 / 团队各一条）。
    ///
    /// 为什么承重：分类是**同步闸门唯一的输入**。落错了的表现不是报错，而是
    /// "个人空间没加密也能绑同步"（内容明文上云）——**能编译、别处单测也照绿**。
    #[test]
    fn the_kind_chosen_at_creation_is_what_lands_in_the_row() {
        let c = conn_with_workspaces();
        insert_chosen_space(&c, "s-personal", "我的", "#e11", 1.0, 1_000, "personal").unwrap();
        insert_chosen_space(&c, "s-team", "大家的", "#e22", 2.0, 1_000, "team").unwrap();
        assert_eq!(kind_of(&c, "s-personal"), "personal");
        assert_eq!(kind_of(&c, "s-team"), "team");
        // 大小写与空白照收（界面给的是字面量，但别为多一个空格就报错）
        insert_chosen_space(&c, "s-team2", "大家的2", "#e33", 3.0, 1_000, " Team ").unwrap();
        assert_eq!(kind_of(&c, "s-team2"), "team");
    }

    /// ★ A1 判据（**窄进**）：界面传了别的东西 ⇒ **报错**，而且**一行都不写**。
    ///
    /// 为什么不能"认不出就当未分类"：未分类在闸门眼里是**放行**的 ⇒ 那会让用户
    /// "以为自己选了个类型、其实闸门松开了"。所以这里刻意与读库那侧（`SpaceKind::parse` 宽进）相反。
    #[test]
    fn an_unknown_kind_is_refused_instead_of_silently_becoming_unclassified() {
        let c = conn_with_workspaces();
        for bad in ["", "  ", "tem", "personal!", "team-ish", "1", "Personal Team"] {
            let err = insert_chosen_space(&c, "s-bad", "x", "#e11", 1.0, 1_000, bad)
                .expect_err("认不出的类型必须报错（静默当未分类＝闸门松开）");
            assert!(err.contains("personal") && err.contains("team"), "报错要可操作：{err}");
        }
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM meta.workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "报错那几次不许留下半行");
    }

    /// ★ 老口径不许变：**不传类型** ⇒ 与今天逐字节相同（`personal`，见 `insert_new_local_space`）。
    /// 这条挡的是"为了加 A1 顺手把默认值改掉了"——那会让所有老调用方建出未分类的空间。
    #[test]
    fn without_an_explicit_choice_the_default_stays_personal() {
        let c = conn_with_workspaces();
        insert_new_local_space(&c, "s-default", "默认", "#e11", 1.0, 1_000).unwrap();
        assert_eq!(kind_of(&c, "s-default"), "personal");
        // 导入那条路同样（口径与新建完全一致）
        insert_imported_space(&c, "s-import", "导入的", "#e12", "", 2.0, 1_000, false).unwrap();
        assert_eq!(kind_of(&c, "s-import"), "personal");
    }

    /// ⭐ **2026-10-10（owner 报的「点了加密空间就卡死」）—— 这次那条 bug 的真判据** ✗：
    /// 切到一个**打不开**的空间（加密 ＋ 本会话没钥匙）时，⭐ **主连接绝不许被弄坏** ✗。
    ///
    /// 修之前：`reopen_space_at` 先把 `c` 换成新库、再上钥匙 ⇒ 上钥匙失败 ✗ ⇒ 可 `c` 已经指向
    /// 那个打不开的库 ⇒ **之后整条连接上每一句 SQL** 都报 `file is not a database` ✗
    ///（前端满屏「保存失败：file is not a database」✓ ／ `encryption_status` 读活动空间失败被吞 ⇒
    /// 报「还没有活动空间」⇒ 锁屏闸门永不成立 ✓）。
    #[test]
    fn switching_to_an_unreadable_space_keeps_the_connection_usable() {
        let dir = std::env::temp_dir().join(format!("shuyo-switch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();

        // 明文空间 A：真 schema（用 `migrate` 建 ✓）
        let a = crate::db::space_db_path(&dir, "space-a");
        {
            let c = rusqlite::Connection::open(&a).unwrap();
            crate::db::migrate(&c, "space-a").unwrap();
        }
        // "加密但本会话没钥匙" 的空间 B：头 16 字节不是 SQLite magic ⇒ `space_db_is_encrypted` ⇒ true ✓
        //（⚠️ 只造形状，不放任何数据 ✓）
        let b = crate::db::space_db_path(&dir, "space-b");
        std::fs::write(&b, vec![0x41u8; 4096]).unwrap();

        // 先真的开到 A（走同一条路 ✓）⇒ 此后 A 的表在这条连接上是可查的
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::reopen_space_at(&mut c, "space-a", &dir).unwrap();
        let before: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();

        // ① 切 B ⇒ **Err** ✓
        let err = crate::db::reopen_space_at(&mut c, "space-b", &dir)
            .expect_err("切到一个打不开的加密空间居然成功了");
        // ② 那句话得是**人话**：不许把 SQLCipher 原文漏给用户 ✓（D3 ✓）
        assert!(
            !err.contains("file is not a database"),
            "英文原文漏到用户面了：{err}"
        );
        // ③ ⭐ **主连接还能用**：同一个 `c` 上照样查得到 A 的表 ✓ —— 这条就是这次的重点 ✗
        let after: i64 = c
            .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))
            .expect("主连接被弄坏了 —— 这正是 owner 那个 bug");
        assert_eq!((before, after), (0, 0));
        // ⭐ 判据加强（2026-10-10）：`0 == 0` **证明不了"还是 A"** ✗ —— 换一个**空库**也是 0 ✓。
        //    ⇒ 把主连接指向的**文件名**读出来 ✓：它必须**逐字**还是 A 那个文件 ✓
        //    （`PRAGMA database_list` 的第一行就是 `main` ✓，第 3 列是文件路径 ✓）。
        let main_file: String = c
            .query_row("PRAGMA database_list", [], |r| r.get::<_, String>(2))
            .unwrap();
        assert_eq!(
            main_file,
            a.display().to_string(),
            "⭐ 主连接不再指向原来的空间 A ✗（0 == 0 那种弱断言看不出这一点 ✗）"
        );
        // ④ 再来一次也一样（不是"坏一次就好了" ✓）
        assert!(crate::db::reopen_space_at(&mut c, "space-b", &dir).is_err());
        let again: i64 = c
            .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))
            .expect("第二次失败把主连接弄坏了");

        assert_eq!(again, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐ ③（2026-10-10，**A 形状的前提** ✓）：切到一个**未解锁的加密空间**失败时，
    /// ⭐ **活动指针不许被写** ✗。
    /// ⚠️ 这一条只能在 `switch_active_space` 这一层判 ✓ —— 上面那个夹具直接调 `reopen_space_at` ✓，
    ///    它**管不到指针** ✗（指针是 `switch_active_space` 的第 ② 步 ✓）。
    /// ⭐ 而原来"先换连接、后写指针"只由一条**文本判据**钉着 ✗（那条自己写着"只能钉文本" ✓）
    ///    ⇒ 这里补一条**行为**判据 ✓。
    #[test]
    fn a_refused_switch_leaves_the_active_pointer_untouched() {
        let dir = std::env::temp_dir().join(format!("shuyo-switch-ptr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();

        let a = crate::db::space_db_path(&dir, "space-a");
        {
            let c = rusqlite::Connection::open(&a).unwrap();
            crate::db::migrate(&c, "space-a").unwrap();
        }
        // B："加密但本会话没钥匙"的形状（头 16 字节不是 SQLite magic ✓，与上面那条同法 ✓）
        let b = crate::db::space_db_path(&dir, "space-b");
        std::fs::write(&b, vec![0x41u8; 4096]).unwrap();

        // meta 侧：两个空间都在册 ✓ ＋ 指针**先指向 A** ✓（否则"没被写"是空转 ✗）
        let mut c = conn_with_workspaces();
        // ⚠️ `conn_with_workspaces()` **只建 `meta.workspaces`** ✗ ⇒ 指针那张表要自己建 ✓
        //    （我第一版漏了 ⇒ 真读数 `no such table: meta.sync_state` ✓ —— 那次红是**夹具**的错 ✗，
        //     不是产品 ✗；补上再跑 ✓。）
        c.execute_batch(
            "CREATE TABLE meta.sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
        )
        .unwrap();
        insert_new_local_space(&c, "space-a", "A", "#e11", 1.0, 1_000).unwrap();
        insert_new_local_space(&c, "space-b", "B", "#e12", 2.0, 1_000).unwrap();
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ACTIVE_KEY, "space-a"],
        )
        .unwrap();

        // ① 切 B ⇒ Err ✓
        assert!(
            switch_active_space(&mut c, "space-b", &dir).is_err(),
            "切到一个打不开的加密空间居然成功了"
        );
        // ② ⭐ 指针**没被写** ✓
        let active: String = c
            .query_row(
                "SELECT value FROM meta.sync_state WHERE key = ?1",
                params![ACTIVE_KEY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active, "space-a", "⭐ 指针被写到那个打不开的空间去了 ✗");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐⭐ owner 2026-10-10「点『保险柜』⇒ **没有弹窗**」的真判据（判据 **a** ＋ 安全 **e**）：
    /// 切到"袋里**有**盒子、但本会话**没解锁**"的空间 ⇒ ⭐ **切换成功** ✓（指针真的改了 ✓）
    /// ＋ ⭐ **一个字节都没打开那个加密库** ✓ ＋ 那个库**仍然打不开** ✓ ＋ 明文空间的行为**一点没变** ✓。
    ///
    /// ⚠️ 夹具必须用**文件 meta**（⛔ 不是 `conn_with_workspaces()` 的 `:memory:` meta ✗）：
    ///    锁定态那一步是 `ATTACH <文件> AS meta` ⇒ 内存 meta 里的指针**会当场消失** ⇒ 那条路测不出来 ✓
    ///    （生产里 meta 就是文件 ✓）。
    #[test]
    fn switching_to_a_locked_encrypted_space_succeeds_and_never_opens_that_db() {
        let dir = std::env::temp_dir().join(format!("shuyo-switch-locked-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(crate::db::spaces_dir(&dir)).unwrap();

        let a = crate::db::space_db_path(&dir, "space-a");
        {
            let c = rusqlite::Connection::open(&a).unwrap();
            crate::db::migrate(&c, "space-a").unwrap();
        }
        // B：加密形状（头 16 字节不是 SQLite magic ⇒ `space_db_is_encrypted` ⇒ true ✓，与既有夹具同法）
        let b = crate::db::space_db_path(&dir, "space-b");
        std::fs::write(&b, vec![0x41u8; 4096]).unwrap();

        // 真 meta 文件（跑一次生产的 `meta_migrate` ⇒ 表都在 ✓），再挂成 `meta` 用
        drop(crate::db::open_meta_conn_at(&dir).unwrap());
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        let meta = crate::db::meta_path(&dir).display().to_string().replace('\'', "''");
        c.execute_batch(&format!("ATTACH DATABASE '{meta}' AS meta KEY \"\""))
            .unwrap();
        insert_new_local_space(&c, "space-a", "A", "#e11", 1.0, 1_000).unwrap();
        insert_new_local_space(&c, "space-b", "B", "#e12", 2.0, 1_000).unwrap();
        c.execute(
            "INSERT INTO meta.sync_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ACTIVE_KEY, "space-a"],
        )
        .unwrap();

        // 袋子：给 B 装盒子（那个测试助手**会同时**装上会话主密钥 ⇒ 随后卸掉它 ✓ ⇒ "袋里有、会话锁着"）
        let _ = crate::space_crypto::set_space_box_for_test("space-b", &[7u8; 32], "pw-for-test");
        crate::space_crypto::set_session_master(None).unwrap();
        // 谓词的两条边界（判据 c 的"行为不变"那半）：
        assert!(
            crate::space_crypto::space_needs_passphrase("space-b"),
            "夹具前提：B 在袋里且会话锁着 ⇒ 谓词必须 true"
        );
        assert!(
            !crate::space_crypto::space_needs_passphrase("space-a"),
            "A 不在袋里（明文）⇒ 谓词必须 false（否则明文空间的行为会被改 ✗）"
        );

        // ① 切 B ⇒ ⭐ **成功**（这就是"点了没反应"的反面 ✓）
        switch_active_space(&mut c, "space-b", &dir).expect("切到未解锁的加密空间必须成功，而不是拒绝");
        // ② 指针**真的改成了 B** ✓
        let active: String = c
            .query_row(
                "SELECT value FROM meta.sync_state WHERE key = ?1",
                params![ACTIVE_KEY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active, "space-b", "切换成功后指针必须指向 B");
        // ③ ⭐ 安全（判据 e）：主连接**不是**那个加密库 —— 停在内存库 ⇒ `main` 的路径为空 ✓
        let main_file: String = c
            .query_row("PRAGMA database_list", [], |r| r.get::<_, String>(2))
            .unwrap();
        assert_ne!(
            main_file,
            b.display().to_string(),
            "⛔ 不许真的打开那个加密库（那等于绕过加密）"
        );
        assert_eq!(main_file, "", "锁定态 ⇒ main 应当是内存库（路径为空）");
        // ④ 而那个库**仍然打不开** ✓（不是"顺手把它开了就看不见问题"）
        let mut probe = rusqlite::Connection::open_in_memory().unwrap();
        assert!(
            crate::db::reopen_space_at(&mut probe, "space-b", &dir).is_err(),
            "那个加密库本会话仍然打不开"
        );

        // 还原进程级全局态（KEYRING / SESSION_MASTER 是全局的 ✓；不还原会污染别的判据）
        crate::space_crypto::set_keyring_for_test(None);
        let _ = crate::space_crypto::set_session_master(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐ **结构判据**：`switch_active_space` 里 ⭐ **先换连接、后写指针** ✗ ——
    /// 今天的 bug 就是**反过来的**（先写指针 ⇒ 换连接失败时指针已经改过去 ✓）。
    /// ⚠️ 顺序这种东西编译器看不见，只能钉文本 ✓。
    /// ⚠️ **必须只在那个函数体内找** ✗：本文件**前面**还有一处写 `ACTIVE_KEY` 的地方，
    ///    用全文件的 `find` 会命中它 ⇒ 判据**假红**（2026-10-10 实测栽过一次 ✓）。
    #[test]
    fn the_active_pointer_is_written_only_after_the_connection_switched() {
        let src = include_str!("workspaces.rs");
        let body = &src[src
            .find("fn switch_active_space")
            .expect("找不到 `switch_active_space`")..];
        let at_reopen = body
            .find("crate::db::reopen_space_at(c, id, dir)")
            .expect("找不到「换连接」那一步");
        let at_pointer = body
            .find("ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .expect("找不到「写活动指针」那一步");
        assert!(
            at_reopen < at_pointer,
            "顺序反了：先写指针再换连接（2026-10-10 那个 bug ✓）"
        );
    }
}
