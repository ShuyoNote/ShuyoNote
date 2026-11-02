use crate::db::now_ms;
use crate::db::Db;
use crate::models::{AttrDef, BoardGroup, DatabaseQuery, DatabaseRow, DbViewMeta, PageMeta};
use crate::properties::parse_options;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::MutexGuard;
use tauri::State;

fn conn<'a>(db: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    db.0.lock().expect("db mutex poisoned")
}

/// 一个数据库页的**列**（`database_columns ⋈ attr_defs`，按列排序）。
///
/// ⚠️ `pub(crate)` 是 B1b（2026-10-29）开的：`db.schema` 必须与 `getDbColumns` **同一条 SQL**
/// （两份必然漂，而漂了不会报错——只会让 UI 与外部 agent 看到两套列）。⛔ 别在能力层另写一份查询。
pub(crate) fn db_columns(c: &Connection, db_page_id: &str) -> Result<Vec<AttrDef>, String> {
    let mut stmt = c
        .prepare(
            "SELECT a.id, a.name, a.type, a.options
             FROM database_columns dc JOIN attr_defs a ON a.id = dc.attr_id
             WHERE dc.db_page_id = ?1
             ORDER BY dc.sort_order, a.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![db_page_id], |r| {
            Ok(AttrDef {
                id: r.get(0)?,
                name: r.get(1)?,
                attr_type: r.get(2)?,
                options: parse_options(&r.get::<_, String>(3)?),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_db_columns(db: State<'_, Db>, db_page_id: String) -> Result<Vec<AttrDef>, String> {
    let c = conn(&db);
    db_columns(&c, &db_page_id)
}

#[derive(Deserialize)]
pub struct DbColumnArgs {
    pub db_page_id: String,
    pub attr_id: String,
}

#[tauri::command]
pub fn add_db_column(db: State<'_, Db>, args: DbColumnArgs) -> Result<Vec<AttrDef>, String> {
    let c = conn(&db);
    let sort_order: f64 = c
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM database_columns WHERE db_page_id = ?1",
            params![args.db_page_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT OR IGNORE INTO database_columns (db_page_id, attr_id, sort_order) VALUES (?1, ?2, ?3)",
        params![args.db_page_id, args.attr_id, sort_order],
    )
    .map_err(|e| e.to_string())?;
    db_columns(&c, &args.db_page_id)
}

#[tauri::command]
pub fn remove_db_column(db: State<'_, Db>, args: DbColumnArgs) -> Result<Vec<AttrDef>, String> {
    let c = conn(&db);
    c.execute(
        "DELETE FROM database_columns WHERE db_page_id = ?1 AND attr_id = ?2",
        params![args.db_page_id, args.attr_id],
    )
    .map_err(|e| e.to_string())?;
    db_columns(&c, &args.db_page_id)
}

#[tauri::command]
pub fn query_database(db: State<'_, Db>, db_page_id: String) -> Result<DatabaseQuery, String> {
    let c = conn(&db);
    // M15 物理隔离：每库单空间，数据库页只呈现本库内容（无需按 space 过滤）。
    let columns = db_columns(&c, &db_page_id)?;
    let attr_ids: Vec<String> = columns.iter().map(|a| a.id.clone()).collect();

    let mut stmt = c
        .prepare(
            "SELECT id, title FROM pages WHERE kind = 'page' AND deleted_at IS NULL ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let pages: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // Load all props once, filter to the column attributes.
    let mut pstmt = c
        .prepare("SELECT page_id, attr_id, value FROM page_props")
        .map_err(|e| e.to_string())?;
    let all_props: Vec<(String, String, String)> = pstmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut prop_map: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (page_id, attr_id, value) in all_props {
        if attr_ids.contains(&attr_id) {
            prop_map.entry(page_id).or_default().insert(attr_id, value);
        }
    }

    let mut rows: Vec<DatabaseRow> = pages
        .into_iter()
        .map(|(page_id, title)| DatabaseRow {
            values: prop_map.remove(&page_id).unwrap_or_default(),
            page_id,
            title,
        })
        .collect();

    // `tag` type columns read from the real tags system.
    let tag_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.attr_type == "tag")
        .map(|c| c.id.clone())
        .collect();
    if !tag_cols.is_empty() {
        let mut stmt = c
            .prepare(
                "SELECT pt.page_id, t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
                 ORDER BY t.name",
            )
            .map_err(|e| e.to_string())?;
        let tag_rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let mut tag_map: HashMap<String, Vec<String>> = HashMap::new();
        for (page_id, name) in tag_rows {
            tag_map.entry(page_id).or_default().push(name);
        }
        for row in rows.iter_mut() {
            if let Some(names) = tag_map.get(&row.page_id) {
                let joined = names.join(", ");
                for col_id in &tag_cols {
                    row.values.insert(col_id.clone(), joined.clone());
                }
            }
        }
    }

    // Membership rule (query-type database): keep only pages matching the rule.
    if let Some(ids) = matching_page_ids(&c, &db_rule(&c, &db_page_id)?)? {
        rows.retain(|r| ids.contains(&r.page_id));
    }

    Ok(DatabaseQuery { columns, rows })
}

fn db_rule(c: &Connection, db_page_id: &str) -> Result<String, String> {
    let v = c
        .query_row(
            "SELECT db_rule FROM pages WHERE id = ?1",
            params![db_page_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "{}".to_string());
    Ok(v)
}

fn set_intersect(cur: Option<Vec<String>>, next: Vec<String>) -> Option<Vec<String>> {
    match cur {
        None => Some(next),
        Some(prev) => Some(prev.into_iter().filter(|id| next.contains(id)).collect()),
    }
}

fn prop_page_ids(c: &Connection, name: &str, value: &str) -> Result<Vec<String>, String> {
    let mut stmt = c
        .prepare(
            "SELECT pp.page_id FROM page_props pp JOIN attr_defs a ON a.id = pp.attr_id
             WHERE a.name = ?1 AND pp.value = ?2",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![name, value], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

fn tag_page_ids(c: &Connection, tag: &str) -> Result<Vec<String>, String> {
    let mut stmt = c
        .prepare(
            "SELECT pt.page_id FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
             WHERE t.name = ?1",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![tag], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

/// Evaluate a rule JSON `{ "prop": {name,value}, "tag": "name" }` (AND) into the
/// set of matching page ids; `None` when no rule is set (no filter).
fn matching_page_ids(c: &Connection, rule: &str) -> Result<Option<Vec<String>>, String> {
    let trimmed = rule.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(None);
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
    let mut all: Option<Vec<String>> = None;
    if let Some(prop) = parsed.get("prop") {
        let name = prop.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value = prop.get("value").and_then(|v| v.as_str()).unwrap_or("");
        if !name.is_empty() {
            all = set_intersect(all, prop_page_ids(c, name, value)?);
        }
    }
    if let Some(tag) = parsed.get("tag").and_then(|v| v.as_str()) {
        if !tag.is_empty() {
            all = set_intersect(all, tag_page_ids(c, tag)?);
        }
    }
    Ok(all)
}

#[tauri::command]
pub fn set_db_rule(db: State<'_, Db>, db_page_id: String, rule: String) -> Result<(), String> {
    let c = conn(&db);
    serde_json::from_str::<serde_json::Value>(&rule).map_err(|e| format!("规则格式错误: {e}"))?;
    let n = c
        .execute(
            "UPDATE pages SET db_rule = ?1 WHERE id = ?2 AND kind = 'database'",
            params![rule, db_page_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("该数据库页不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_db_rule(db: State<'_, Db>, db_page_id: String) -> Result<String, String> {
    let c = conn(&db);
    db_rule(&c, &db_page_id)
}

/// Resolve page-reference values (`p:<id>`) to their target page titles.
#[tauri::command]
pub fn resolve_refs(
    db: State<'_, Db>,
    values: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let c = conn(&db);
    let mut out: HashMap<String, String> = HashMap::new();
    for v in values {
        if let Some(pid) = v.strip_prefix("p:") {
            let title: Option<String> = c
                .query_row(
                    "SELECT title FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                    params![pid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let label = title
                .map(|t| format!("⇄ {t}"))
                .unwrap_or_else(|| "已失效引用".to_string());
            out.insert(v, label);
        } else {
            out.insert(v.clone(), v);
        }
    }
    Ok(out)
}

fn list_page_metas(c: &Connection) -> Result<Vec<PageMeta>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at
             FROM pages WHERE kind = 'page' AND deleted_at IS NULL
             ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PageMeta {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                parent_id: r.get(2)?,
                title: r.get(3)?,
                icon: String::new(),
                kind: r.get(4)?,
                sort_order: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                deleted_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

// Board grouped by a `select` attribute: one column per option + an "unset" column.
#[tauri::command]
pub fn board_by_attr(db: State<'_, Db>, attr_id: String) -> Result<Vec<BoardGroup>, String> {
    let c = conn(&db);
    let active = crate::workspaces::active_workspace_id(&c)?;
    let options_json: String = c
        .query_row(
            "SELECT options FROM attr_defs WHERE id = ?1",
            params![attr_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "属性不存在".to_string())?;
    let options = parse_options(&options_json);

    let pages: Vec<PageMeta> = list_page_metas(&c)?
        .into_iter()
        .filter(|p| p.workspace_id == active)
        .collect();

    let mut stmt = c
        .prepare("SELECT page_id, value FROM page_props WHERE attr_id = ?1")
        .map_err(|e| e.to_string())?;
    let values: HashMap<String, String> = stmt
        .query_map(params![attr_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut groups: Vec<BoardGroup> = options
        .iter()
        .map(|o| BoardGroup {
            id: o.clone(),
            name: o.clone(),
            pages: Vec::new(),
        })
        .collect();
    let mut unset: Vec<PageMeta> = Vec::new();

    for page in pages {
        match values.get(&page.id) {
            Some(v) if !v.is_empty() => {
                if let Some(g) = groups.iter_mut().find(|g| g.id == *v) {
                    g.pages.push(page);
                }
            }
            _ => unset.push(page),
        }
    }

    groups.insert(
        0,
        BoardGroup {
            id: "__none".to_string(),
            name: "未设置".to_string(),
            pages: unset,
        },
    );
    Ok(groups)
}

// 重排数据库表格列顺序：按传入 attr_id 数组顺序重写该库 database_columns.sort_order = 0..n。
#[tauri::command]
pub fn reorder_db_columns(
    db: State<'_, Db>,
    db_page_id: String,
    ordered_attr_ids: Vec<String>,
) -> Result<(), String> {
    let c = conn(&db);
    for (i, attr_id) in ordered_attr_ids.iter().enumerate() {
        c.execute(
            "UPDATE database_columns SET sort_order = ?1 WHERE db_page_id = ?2 AND attr_id = ?3",
            params![i as f64, db_page_id, attr_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn row_to_view(row: &rusqlite::Row) -> rusqlite::Result<DbViewMeta> {
    Ok(DbViewMeta {
        id: row.get(0)?,
        db_page_id: row.get(1)?,
        name: row.get(2)?,
        view_type: row.get(3)?,
        config: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
    })
}

#[tauri::command]
pub fn list_db_views(db: State<'_, Db>, db_page_id: String) -> Result<Vec<DbViewMeta>, String> {
    let c = conn(&db);
    db_views(&c, &db_page_id)
}

/// 一个数据库页的**视图**（按 sort_order → created_at）。
///
/// ⚠️ `pub(crate)` 是 B1b 开的：`db.schema` 的 `views` 必须与 `listDbViews` **同一条 SQL**
/// （同 [`db_columns`] 的理由）。
pub(crate) fn db_views(c: &Connection, db_page_id: &str) -> Result<Vec<DbViewMeta>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id, db_page_id, name, view_type, config, sort_order, created_at
             FROM db_views WHERE db_page_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map(params![db_page_id], |row| row_to_view(row))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in mapped {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct SaveDbViewArgs {
    pub db_page_id: String,
    pub name: String,
    pub view_type: String,
    pub config: String,
}

#[tauri::command]
pub fn save_db_view(db: State<'_, Db>, args: SaveDbViewArgs) -> Result<DbViewMeta, String> {
    let c = conn(&db);
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let next: f64 = c
        .query_row(
            "SELECT COALESCE(MAX(sort_order),0) + 1 FROM db_views WHERE db_page_id = ?1",
            params![args.db_page_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO db_views (id, db_page_id, name, view_type, config, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            args.db_page_id,
            args.name,
            args.view_type,
            args.config,
            next,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    c.query_row(
        "SELECT id, db_page_id, name, view_type, config, sort_order, created_at FROM db_views WHERE id = ?1",
        params![id],
        |row| row_to_view(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_db_view(db: State<'_, Db>, id: String) -> Result<(), String> {
    let c = conn(&db);
    c.execute("DELETE FROM db_views WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// B1b（2026-10-29）：`db.schema` / `db.rows` 的**唯一只读查询口径**
//
// 为什么写在这一层（而不是能力层 `plugins.rs`）：列/视图/行值的形状必须与 UI 的
// `getDbColumns` / `listDbViews` / `queryDatabase` **同源** —— 这里直接复用同两条 SQL
// （`db_columns` / `db_views`），⛔ 不在能力层另抄一份。
//
// `db.rows` 的两条硬口径（能力暴露矩阵 v3.1 §4.4 / §13.2-6）：
//   ① **过滤与分页在 Rust（SQL）侧执行**：`where` 编成参数化 WHERE、`LIMIT/OFFSET` 编进 SQL
//      ⇒ ⛔ 不「拉全表回 JS 侧再筛」（那条在 200 KB 响应体上限下必然出事）；
//   ② **只给原始值**：值就是 `page_props.value` / 标签名的原样字符串，⛔ 不重算公式/汇总 ——
//      与界面里显示的计算值**可能不同**（调用方自己算，或看界面）。
//
// ⚠️ `where` 的操作符白名单是**唯一**一处（矩阵 §4.4）：`= != > >= < <= in contains is_null`；
// 越界/未知字段/坏操作符一律 `invalid_args`（人话 ＋ 点名第几条），⛔ 不许 500 / 静默空。
// ═══════════════════════════════════════════════════════════════════════════════

/// `where` 的比较操作符（白名单；见矩阵 §4.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FilterOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    In,
    Contains,
    IsNull,
}

impl FilterOp {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "=" => FilterOp::Eq,
            "!=" => FilterOp::Ne,
            ">" => FilterOp::Gt,
            ">=" => FilterOp::Ge,
            "<" => FilterOp::Lt,
            "<=" => FilterOp::Le,
            "in" => FilterOp::In,
            "contains" => FilterOp::Contains,
            "is_null" => FilterOp::IsNull,
            _ => return None,
        })
    }
}

/// 一条已校验过的简单 where（字段已解析成**列 id**，类型已解析成"是否数值比较"）。
#[derive(Debug, Clone)]
pub(crate) struct RowFilter {
    pub col_id: String,
    pub op: FilterOp,
    /// 标量比较值（`=`/`!=`/`>`/`>=`/`<`/`<=`/`contains`）；`in` 在 `values` 里。
    pub value: Option<String>,
    pub values: Vec<String>,
    /// 数值列（`attr_defs.type = "number"`）⇒ 比较走 `CAST(.. AS REAL)`（与界面 `parseFloat` 同口径）。
    pub numeric: bool,
}

/// `where` 白名单的**给人看**的全文（错误消息里原样点名，别让调用方猜）。
pub(crate) const WHERE_OPS_TEXT: &str = "= != > >= < <= in contains is_null";

/// 把 `where` 参数解析并**按列校验**（未知字段 / 坏操作符 / `in` 非数组 ⇒ `invalid_args`）。
///
/// 优先级：先按**列 id** 找，再按**列名**找（`attr_defs.name` 在空间内唯一）；
/// 两者都不中 ⇒ 点名（并提示先用 `db.schema` 看列）。
pub(crate) fn parse_row_filters(
    where_value: Option<&serde_json::Value>,
    columns: &[AttrDef],
) -> Result<Vec<RowFilter>, String> {
    let Some(v) = where_value else {
        return Ok(Vec::new());
    };
    if v.is_null() {
        return Ok(Vec::new());
    }
    let arr = match v.as_array() {
        Some(a) => a,
        None => {
            return Err(
                "invalid_args: where 必须是数组（[{field,op,value?}, …]，多条之间是 AND）"
                    .to_string(),
            )
        }
    };
    let mut out: Vec<RowFilter> = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let obj = match item.as_object() {
            Some(o) => o,
            None => {
                return Err(format!(
                    "invalid_args: where[{i}] 必须是对象（{{field,op,value?}}），收到 {}",
                    json_kind(item)
                ))
            }
        };
        let field = match obj.get("field").and_then(|x| x.as_str()).map(str::trim) {
            Some(f) if !f.is_empty() => f,
            _ => {
                return Err(format!(
                    "invalid_args: where[{i}] 缺 field（列 id 或列名；先用 db.schema 看这个库有哪些列）"
                ))
            }
        };
        let op_text = match obj.get("op").and_then(|x| x.as_str()).map(str::trim) {
            Some(o) if !o.is_empty() => o,
            _ => {
                return Err(format!(
                    "invalid_args: where[{i}] 缺 op（白名单：{WHERE_OPS_TEXT}）"
                ))
            }
        };
        let Some(op) = FilterOp::parse(op_text) else {
            return Err(format!(
                "invalid_args: where[{i}] 的操作符「{op_text}」不在白名单（{WHERE_OPS_TEXT}）"
            ));
        };
        // 列解析：**id 优先，其次列名**（两者都不可能重复：id 是主键、name 在空间内 UNIQUE）。
        let Some(col) = columns
            .iter()
            .find(|c| c.id == field)
            .or_else(|| columns.iter().find(|c| c.name == field))
        else {
            return Err(format!(
                "invalid_args: where[{i}] 的字段「{field}」不是这个库的列 —— 先用 db.schema 看列（id 或列名都接受；列名必须与实际名字完全一致）"
            ));
        };
        let mut values: Vec<String> = Vec::new();
        let mut value: Option<String> = None;
        match op {
            FilterOp::IsNull => { /* is_null 不需要 value（给了也不看） */ }
            FilterOp::In => {
                let raw = obj
                    .get("value")
                    .ok_or_else(|| format!("invalid_args: where[{i}] 的 in 需要 value 数组"))?;
                let Some(items) = raw.as_array() else {
                    return Err(format!(
                        "invalid_args: where[{i}] 的 in 的 value 必须是**数组**（收到 {}）",
                        json_kind(raw)
                    ));
                };
                if items.is_empty() {
                    return Err(format!(
                        "invalid_args: where[{i}] 的 in 的 value 是空数组 —— 它永远匹配不到任何行；要不就别加这条"
                    ));
                }
                for it in items {
                    values.push(scalar_text(it).ok_or_else(|| {
                        format!(
                            "invalid_args: where[{i}] 的 in 的数组元素必须是字符串/数字/布尔（收到 {}）",
                            json_kind(it)
                        )
                    })?);
                }
            }
            _ => {
                let raw = obj
                    .get("value")
                    .ok_or_else(|| format!("invalid_args: where[{i}] 的「{op_text}」需要 value"))?;
                value = Some(scalar_text(raw).ok_or_else(|| {
                    format!(
                        "invalid_args: where[{i}] 的 value 必须是字符串/数字/布尔（收到 {}）",
                        json_kind(raw)
                    )
                })?);
            }
        }
        out.push(RowFilter {
            col_id: col.id.clone(),
            op,
            value,
            values,
            numeric: col.attr_type == "number",
        });
    }
    Ok(out)
}

/// JSON 值的**人话类型名**（错误消息里点名用，不 dump 整个值）。
fn json_kind(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "布尔",
        serde_json::Value::Number(_) => "数字",
        serde_json::Value::String(_) => "字符串",
        serde_json::Value::Array(_) => "数组",
        serde_json::Value::Object(_) => "对象",
    }
}

/// 标量 → 原始值字符串（与 `page_props.value` 的存储口径一致：数字按十进制文本）。
fn scalar_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(if *b { "true" } else { "false" }.to_string()),
        _ => None,
    }
}

/// 一页 `db.rows` 的结果（列 ＋ 本页行 ＋ **过滤后的总行数**）。
pub(crate) struct DbRowsPage {
    pub rows: Vec<DatabaseRow>,
    pub total: i64,
}

/// 校验 `pageId` 指向的确实是一个**数据库页**（`kind = 'database'`）。
///
/// ⚠️ 两条都报 `invalid_args`（人话 ＋ 下一步），不报 500：`pageId` 是可传错的输入，
/// 而"传错了"和"数据库坏了"必须分得开（矩阵 §4.4 的越界口径）。
pub(crate) fn require_db_page(c: &Connection, db_page_id: &str) -> Result<(), String> {
    let id = db_page_id.trim();
    if id.is_empty() {
        return Err("invalid_args: 缺少参数 pageId（数据库页 id）".to_string());
    }
    let kind: Option<String> = c
        .query_row(
            "SELECT kind FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("db_error: {e}"))?;
    match kind.as_deref() {
        Some("database") => Ok(()),
        Some(other) => Err(format!(
            "invalid_args: pageId「{id}」不是数据库页（kind={other}）—— 本应用的数据库是 kind=database 的页面节点；先用 pages.tree 找到它"
        )),
        None => Err(format!(
            "invalid_args: 找不到页面「{id}」（可能已删除，或 id 不是本空间的）—— 先用 pages.tree / pages.list 确认"
        )),
    }
}

/// 一组 WHERE 条件（SQL 片段 ＋ 位置参数），供 `COUNT(*)` 与分页查询**共用**同一套口径。
struct WhereParts {
    sql: String,
    params: Vec<rusqlite::types::Value>,
}

/// 一个列的**原始值表达式**（与 `query_database` 的取值口径逐字对齐）：
/// - 标签列：该行全部标签名按名字排序后 `", "` 相连（`query_database` 就是这么拼的）；
/// - 其余列：`page_props.value`。
///
/// ⚠️ 表达式里的参数**在这里 push**（调用方随 SQL 文本顺序继续 push 比较值）。
fn value_expr(col: &AttrDef, params: &mut Vec<rusqlite::types::Value>) -> String {
    if col.attr_type == "tag" {
        "(SELECT group_concat(t.name, ', ') FROM (SELECT tt.name FROM page_tags ptt \
          JOIN tags tt ON tt.id = ptt.tag_id WHERE ptt.page_id = p.id ORDER BY tt.name))"
            .to_string()
    } else {
        params.push(rusqlite::types::Value::Text(col.id.clone()));
        "(SELECT ppv.value FROM page_props ppv WHERE ppv.page_id = p.id AND ppv.attr_id = ?)"
            .to_string()
    }
}

/// 拼 WHERE：简单 where（AND）＋ 视图标题过滤（OR 组 / 组内 AND，与界面同口径）＋ 成员规则（`db_rule`）。
fn build_where(
    columns: &[AttrDef],
    filters: &[RowFilter],
    view_filter: Option<&str>,
    rule_ids: Option<&[String]>,
) -> WhereParts {
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    let mut sql = String::from("p.kind = 'page' AND p.deleted_at IS NULL");
    for f in filters {
        let col = match columns.iter().find(|c| c.id == f.col_id) {
            Some(c) => c,
            None => continue, // 解析时已校验过 ⇒ 这里只是防御（不 panic）
        };
        let expr = value_expr(col, &mut params);
        let text = format!("COALESCE({expr}, '')");
        let num = format!("COALESCE(CAST({expr} AS REAL), 0)");
        match f.op {
            FilterOp::Eq => {
                sql.push_str(&format!(" AND {text} = ?"));
                params.push(text_value(f.value.as_deref().unwrap_or("")));
            }
            FilterOp::Ne => {
                sql.push_str(&format!(" AND {text} <> ?"));
                params.push(text_value(f.value.as_deref().unwrap_or("")));
            }
            FilterOp::Gt | FilterOp::Ge | FilterOp::Lt | FilterOp::Le => {
                let op = match f.op {
                    FilterOp::Gt => ">",
                    FilterOp::Ge => ">=",
                    FilterOp::Lt => "<",
                    _ => "<=",
                };
                if f.numeric {
                    sql.push_str(&format!(" AND {num} {op} CAST(? AS REAL)"));
                } else {
                    sql.push_str(&format!(" AND {text} {op} ?"));
                }
                params.push(text_value(f.value.as_deref().unwrap_or("")));
            }
            FilterOp::In => {
                if f.values.is_empty() {
                    sql.push_str(" AND 0");
                    continue;
                }
                let marks = vec!["?"; f.values.len()].join(", ");
                if f.numeric {
                    let casts = vec!["CAST(? AS REAL)"; f.values.len()].join(", ");
                    sql.push_str(&format!(" AND {num} IN ({casts})"));
                } else {
                    sql.push_str(&format!(" AND {text} IN ({marks})"));
                }
                for v in &f.values {
                    params.push(text_value(v));
                }
            }
            FilterOp::Contains => {
                sql.push_str(&format!(" AND INSTR({text}, ?) > 0"));
                params.push(text_value(f.value.as_deref().unwrap_or("")));
            }
            FilterOp::IsNull => {
                // 缺失与空串同义（返回值里两者都表现为"没有这个键/空串"）。
                sql.push_str(&format!(" AND {text} = ''"));
            }
        }
    }
    if let Some(raw) = view_filter {
        let groups = title_filter_groups(raw);
        if !groups.is_empty() {
            let mut ors: Vec<String> = Vec::new();
            for keys in &groups {
                let mut ands: Vec<String> = Vec::new();
                for k in keys {
                    ands.push("INSTR(LOWER(p.title), LOWER(?)) > 0".to_string());
                    params.push(text_value(k));
                }
                ors.push(format!("({})", ands.join(" AND ")));
            }
            sql.push_str(&format!(" AND ({})", ors.join(" OR ")));
        }
    }
    if let Some(ids) = rule_ids {
        if ids.is_empty() {
            sql.push_str(" AND 0");
        } else {
            let marks = vec!["?"; ids.len()].join(", ");
            sql.push_str(&format!(" AND p.id IN ({marks})"));
            for id in ids {
                params.push(text_value(id));
            }
        }
    }
    WhereParts { sql, params }
}

fn text_value(s: &str) -> rusqlite::types::Value {
    rusqlite::types::Value::Text(s.to_string())
}

/// 界面那个「过滤」框的语义（与 `DatabaseView.tsx` 的 `rows` useMemo 逐字同口径）：
/// 逗号 = OR 组、组内空格 = AND（都是**标题**的大小写不敏感子串）。
fn title_filter_groups(raw: &str) -> Vec<Vec<String>> {
    let key = raw.trim().to_lowercase();
    if key.is_empty() {
        return Vec::new();
    }
    key.split(|ch| ch == '，' || ch == ',')
        .map(|g| {
            g.split_whitespace()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|g| !g.is_empty())
        .collect()
}

/// 视图里保存的排序（`{key, dir}`）：`__title` 或列 id；`dir >= 0` 为升序。
fn view_sort(v: &DbViewMeta) -> Option<(String, bool)> {
    let cfg: serde_json::Value = serde_json::from_str(&v.config).ok()?;
    let key = cfg.get("sort")?.get("key")?.as_str()?.trim().to_string();
    if key.is_empty() {
        return None;
    }
    let dir = cfg
        .get("sort")
        .and_then(|s| s.get("dir"))
        .and_then(|d| d.as_i64())
        .unwrap_or(1);
    Some((key, dir >= 0))
}

/// 视图里保存的标题过滤串（没有 ⇒ `None`）。
fn view_filter(v: &DbViewMeta) -> Option<String> {
    let cfg: serde_json::Value = serde_json::from_str(&v.config).ok()?;
    let f = cfg.get("filter")?.as_str()?.trim().to_string();
    if f.is_empty() {
        None
    } else {
        Some(f)
    }
}

/// `db.rows` 的**唯一实现**：SQL 侧过滤 ＋ 排序 ＋ 分页，最后把这一页的行值装配出来。
///
/// 顺序：`updated_at DESC, id ASC`（稳定分页的 tiebreak）；视图带排序时按视图的 key/dir。
/// 视图排序的**已知差异**（如实写在这里，⛔ 不假装它与界面逐字节一致）：
/// 界面用 `localeCompare(..., "zh")` 比文本，SQL 用二进制序 ⇒ 中文排序可能不同；
/// 数值列两侧都按数值（SQL `CAST(.. AS REAL)` ↔ 界面 `parseFloat`）。
pub(crate) fn query_db_rows(
    c: &Connection,
    db_page_id: &str,
    filters: &[RowFilter],
    view: Option<&DbViewMeta>,
    limit: i64,
    offset: i64,
) -> Result<DbRowsPage, String> {
    require_db_page(c, db_page_id)?;
    let columns = db_columns(c, db_page_id)?;
    let rule_ids = matching_page_ids(c, &db_rule(c, db_page_id)?)?;
    if let Some(ids) = rule_ids.as_ref() {
        if ids.is_empty() {
            return Ok(DbRowsPage {
                rows: Vec::new(),
                total: 0,
            });
        }
    }
    let vfilter = view.and_then(view_filter);
    let where_parts = build_where(&columns, filters, vfilter.as_deref(), rule_ids.as_deref());

    let total: i64 = c
        .query_row(
            &format!("SELECT COUNT(*) FROM pages p WHERE {}", where_parts.sql),
            rusqlite::params_from_iter(where_parts.params.iter()),
            |r| r.get(0),
        )
        .map_err(|e| format!("db_error: {e}"))?;

    // 排序：默认 updated_at DESC, id ASC；视图给了排序键就用它（列 id 或 `__title`）。
    let mut order = String::from("p.updated_at DESC, p.id ASC");
    let mut order_params: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(v) = view {
        if let Some((key, asc)) = view_sort(v) {
            let dir = if asc { "ASC" } else { "DESC" };
            if key == "__title" {
                order = format!("p.title {dir}, p.id ASC");
            } else if let Some(col) = columns.iter().find(|c| c.id == key) {
                let expr = value_expr(col, &mut order_params);
                if col.attr_type == "number" {
                    order = format!("COALESCE(CAST({expr} AS REAL), 0) {dir}, p.id ASC");
                } else {
                    order = format!("COALESCE({expr}, '') {dir}, p.id ASC");
                }
            }
        }
    }

    let page_sql = format!(
        "SELECT p.id, p.title FROM pages p WHERE {} ORDER BY {} LIMIT ? OFFSET ?",
        where_parts.sql, order
    );
    let mut page_params = where_parts.params;
    page_params.extend(order_params);
    page_params.push(rusqlite::types::Value::Integer(limit.max(0)));
    page_params.push(rusqlite::types::Value::Integer(offset.max(0)));
    let mut stmt = c.prepare(&page_sql).map_err(|e| format!("db_error: {e}"))?;
    let page: Vec<(String, String)> = stmt
        .query_map(rusqlite::params_from_iter(page_params.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| format!("db_error: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("db_error: {e}"))?;

    // 装配这一页的原始值：与 `query_database` 同口径（page_props 的列值 ＋ 标签列拼名字）。
    let attr_ids: Vec<String> = columns.iter().map(|a| a.id.clone()).collect();
    let page_ids: Vec<String> = page.iter().map(|(id, _)| id.clone()).collect();
    let mut prop_map: HashMap<String, HashMap<String, String>> = HashMap::new();
    if !page_ids.is_empty() && !attr_ids.is_empty() {
        let id_marks = vec!["?"; page_ids.len()].join(", ");
        let attr_marks = vec!["?"; attr_ids.len()].join(", ");
        let mut stmt = c
            .prepare(&format!(
                "SELECT page_id, attr_id, value FROM page_props \
                 WHERE page_id IN ({id_marks}) AND attr_id IN ({attr_marks})"
            ))
            .map_err(|e| format!("db_error: {e}"))?;
        let mut vals: Vec<rusqlite::types::Value> =
            page_ids.iter().map(|s| text_value(s)).collect();
        vals.extend(attr_ids.iter().map(|s| text_value(s)));
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("db_error: {e}"))?;
        for row in rows {
            let (page_id, attr_id, value) = row.map_err(|e| format!("db_error: {e}"))?;
            prop_map.entry(page_id).or_default().insert(attr_id, value);
        }
    }
    let tag_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.attr_type == "tag")
        .map(|c| c.id.clone())
        .collect();
    if !tag_cols.is_empty() && !page_ids.is_empty() {
        let id_marks = vec!["?"; page_ids.len()].join(", ");
        let mut stmt = c
            .prepare(&format!(
                "SELECT pt.page_id, t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id \
                 WHERE pt.page_id IN ({id_marks}) ORDER BY t.name"
            ))
            .map_err(|e| format!("db_error: {e}"))?;
        let vals: Vec<rusqlite::types::Value> = page_ids.iter().map(|s| text_value(s)).collect();
        let tag_rows = stmt
            .query_map(rusqlite::params_from_iter(vals.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("db_error: {e}"))?;
        let mut tag_map: HashMap<String, Vec<String>> = HashMap::new();
        for row in tag_rows {
            let (page_id, name) = row.map_err(|e| format!("db_error: {e}"))?;
            tag_map.entry(page_id).or_default().push(name);
        }
        for (page_id, names) in tag_map {
            let joined = names.join(", ");
            let entry = prop_map.entry(page_id).or_default();
            for col_id in &tag_cols {
                entry.insert(col_id.clone(), joined.clone());
            }
        }
    }

    let rows = page
        .into_iter()
        .map(|(page_id, title)| {
            let values = prop_map.remove(&page_id).unwrap_or_default();
            DatabaseRow {
                page_id,
                title,
                values,
            }
        })
        .collect();
    Ok(DbRowsPage { rows, total })
}
