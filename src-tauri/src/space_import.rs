// ⭐ M2c：`.shuyospace` 导入落库（Rust 单命令，整包一个事务）。
//
// 边界（本批）：新建空间 + 按 tree 新建节点 + 内层 content 落库 + 附件按 sha 落盘/去重 +
// 返回计数/warnings。⏳ 未做：`id_map.json` 重算与正文/双链重写、审计持久化、UI 入口。
//
// 原子性：空间 DB 的写入在**一个事务**里；任何一步失败 ⇒ 回滚 DB 并删除 meta 行 / 空间库 /
// 本次落盘的附件目录，保证"失败后新空间完全不存在"。
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct ImportNode {
    pub old_id: String,
    pub parent_old_id: Option<String>,
    pub kind: String,
    pub title: String,
    /// 内层文档包的 `content.json` 原文（folder 可省略）。
    #[serde(default)]
    pub doc_json: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ImportFile {
    pub sha256: String,
    pub name: String,
    #[serde(default)]
    pub mime: Option<String>,
    /// 该附件挂到哪个**旧节点**（空 = 空间根/未整理）。
    #[serde(default)]
    pub page_old_id: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
pub struct ImportPayload {
    pub space_name: String,
    pub nodes: Vec<ImportNode>,
    #[serde(default)]
    pub files: Vec<ImportFile>,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub space_id: String,
    pub nodes: usize,
    pub documents: usize,
    pub attachments: usize,
    pub warnings: Vec<String>,
}

const KINDS: &[&str] = &["page", "folder", "database"];

fn ext_of(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((_, e)) if !e.is_empty() && e.len() <= 16 => e.to_ascii_lowercase(),
        _ => "bin".to_string(),
    }
}

pub(crate) fn import_space_package_in(
    app_data: &Path,
    payload: &ImportPayload,
    inject_failure: bool,
) -> Result<ImportResult, String> {
    if payload.space_name.trim().is_empty() {
        return Err("bad_args: space_name 不能为空".to_string());
    }
    if payload.nodes.is_empty() {
        return Err("bad_args: package 没有节点".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for n in &payload.nodes {
        if !KINDS.contains(&n.kind.as_str()) {
            return Err(format!("bad_args: 未知节点类型 {}", n.kind));
        }
        if !seen.insert(n.old_id.clone()) {
            return Err(format!("bad_args: 节点 id 重复 {}", n.old_id));
        }
    }
    for n in &payload.nodes {
        if let Some(p) = &n.parent_old_id {
            if !seen.contains(p) {
                return Err(format!("bad_args: 节点 {} 的 parent 不存在 {}", n.old_id, p));
            }
        }
    }

    let now = crate::db::now_ms();
    let space_id = uuid::Uuid::new_v4().to_string();
    let meta = crate::db::open_meta_conn_at(app_data)?;
    // workspaces::insert_imported_space 走 `meta.workspaces`（生产是 space conn 的 ATTACH 名）⇒ 这里补 alias。
    meta.execute(
        "ATTACH DATABASE ?1 AS meta",
        rusqlite::params![crate::db::meta_path(app_data).to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    let sort: f64 = meta
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM workspaces WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(1.0);
    crate::workspaces::insert_imported_space(
        &meta,
        &space_id,
        payload.space_name.trim(),
        "#000",
        "",
        sort,
        now,
        false,
    )?;
    let cleanup = |space_id: &str| {
        if let Ok(m) = crate::db::open_meta_conn_at(app_data) {
            let _ = m.execute("DELETE FROM workspaces WHERE id = ?1", rusqlite::params![space_id]);
        }
        let p = crate::db::space_db_path(app_data, space_id);
        for f in [p.clone(), p.with_extension("db-wal"), p.with_extension("db-shm")] {
            let _ = std::fs::remove_file(f);
        }
        let _ = std::fs::remove_dir_all(crate::attachments::space_attachments_dir(app_data, space_id));
    };
    if let Err(e) = crate::db::create_space_db_at(app_data, &space_id) {
        cleanup(&space_id);
        return Err(format!("db_error: 建空间库失败：{e}"));
    }
    let res = (|| -> Result<ImportResult, String> {
        let mut conn = crate::db::open_space_conn_at(&space_id, app_data)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // 拓扑序：父先于子（payload 来自 tree，通常已按序；这里做稳定排序兜底）
        let mut order: Vec<usize> = (0..payload.nodes.len()).collect();
        let pos: std::collections::HashMap<String, usize> = payload
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.old_id.clone(), i))
            .collect();
        order.sort_by_key(|&i| {
            let mut depth = 0;
            let mut cur = payload.nodes[i].parent_old_id.clone();
            while let Some(p) = cur {
                depth += 1;
                cur = pos.get(&p).and_then(|&j| payload.nodes[j].parent_old_id.clone());
            }
            depth
        });
        let mut id_map = std::collections::HashMap::new();
        let mut documents = 0usize;
        for i in order {
            let n = &payload.nodes[i];
            let new_parent = match &n.parent_old_id {
                Some(p) => Some(id_map.get(p).cloned().ok_or("bad_args: 父节点尚未导入")?),
                None => None,
            };
            let doc_json = n.doc_json.clone();
            let text: Option<String> = None;
            let page = crate::commands::create_node_in(
                &tx,
                &space_id,
                new_parent,
                Some(n.title.clone()),
                &n.kind,
                doc_json,
                text,
            )?;
            id_map.insert(n.old_id.clone(), page.id.clone());
            if page.kind != "folder" {
                documents += 1;
            }
            if inject_failure {
                return Err("injected failure (test)".to_string());
            }
        }
        let mut attachments = 0usize;
        let mut warnings = Vec::new();
        for f in &payload.files {
            if !f.bytes.is_empty() {
                let actual = crate::db::sha256_hex_bytes(&f.bytes);
                if actual != f.sha256 {
                    return Err(format!("bad_args: 附件 sha 不符 {}", f.sha256));
                }
            }
            let dir = crate::attachments::space_attachments_dir(app_data, &space_id);
            crate::attachments::write_attachment_once(&dir, &f.sha256, &ext_of(&f.name), &f.bytes, None)?;
            let new_page = match &f.page_old_id {
                Some(p) => id_map.get(p).cloned(),
                None => None,
            };
            tx.execute(
                "INSERT INTO attachments (id, page_id, name, hash, mime, size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    new_page,
                    f.name,
                    f.sha256,
                    f.mime.clone().unwrap_or_else(|| "application/octet-stream".to_string()),
                    f.bytes.len() as i64,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            attachments += 1;
        }
        if inject_failure {
            return Err("injected failure (test)".to_string());
        }
        tx.commit().map_err(|e| e.to_string())?;
        let _ = &warnings;
        Ok(ImportResult {
            space_id: space_id.clone(),
            nodes: payload.nodes.len(),
            documents,
            attachments,
            warnings,
        })
    })();
    match res {
        Ok(v) => Ok(v),
        Err(e) => {
            cleanup(&space_id);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn space_package_import(payload: ImportPayload) -> Result<ImportResult, String> {
    let app_data = crate::db::app_data_dir_ref()
        .ok_or_else(|| "bad_args: app data dir 未初始化".to_string())?;
    import_space_package_in(app_data, &payload, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> ImportPayload {
        ImportPayload {
            space_name: "导入空间".into(),
            nodes: vec![
                ImportNode { old_id: "f".into(), parent_old_id: None, kind: "folder".into(), title: "夹".into(), doc_json: None },
                ImportNode { old_id: "p".into(), parent_old_id: Some("f".into()), kind: "page".into(), title: "页".into(), doc_json: Some("{\"root\":{\"children\":[]}}".into()) },
                ImportNode { old_id: "d".into(), parent_old_id: None, kind: "database".into(), title: "库".into(), doc_json: Some("{\"root\":{},\"db\":{\"tables\":[]}}".into()) },
            ],
            files: vec![ImportFile { sha256: crate::db::sha256_hex_bytes(b"abc"), name: "a.pdf".into(), mime: Some("application/pdf".into()), page_old_id: Some("p".into()), bytes: b"abc".to_vec() }],
        }
    }

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("shuyo-space-import-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(crate::db::spaces_dir(&d)).unwrap();
        {
            let m = crate::db::open_meta_conn_at(&d).unwrap();
            m.execute("INSERT OR IGNORE INTO sync_state (key, value) VALUES ('device_id','space-import-test')", []).unwrap();
        }
        d
    }

    #[test]
    fn space_import_creates_new_space_with_remapped_ids_and_counts() {
        let d = dir("ok");
        let p = payload();
        let r = import_space_package_in(&d, &p, false).expect("import");
        assert_eq!(r.nodes, 3);
        assert_eq!(r.documents, 2);
        assert_eq!(r.attachments, 1);
        let c = crate::db::open_space_conn_at(&r.space_id, &d).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM pages", [], |x| x.get(0)).unwrap();
        assert_eq!(n, 3);
        let ids: Vec<String> = c.prepare("SELECT id FROM pages").unwrap().query_map([], |x| x.get(0)).unwrap().filter_map(|x| x.ok()).collect();
        assert!(!ids.contains(&"f".to_string()) && !ids.contains(&"p".to_string()), "id 必须全换新");
        // 父子重映射：page 的 parent 是 folder 的新 id，且 folder 无 parent
        let folder_new: String = c.query_row("SELECT id FROM pages WHERE title='夹'", [], |x| x.get(0)).unwrap();
        let page_parent: Option<String> = c.query_row("SELECT parent_id FROM pages WHERE title='页'", [], |x| x.get(0)).unwrap();
        assert_eq!(page_parent, Some(folder_new.clone()));
        let folder_parent: Option<String> = c.query_row("SELECT parent_id FROM pages WHERE id=?1", rusqlite::params![folder_new], |x| x.get(0)).unwrap();
        assert_eq!(folder_parent, None);
        // 空文件夹保留
        let empty: i64 = c.query_row("SELECT COUNT(*) FROM pages WHERE id=?1", rusqlite::params![&folder_new], |x| x.get(0)).unwrap();
        assert_eq!(empty, 1);
        // 附件行 + 字节
        let (hash, size, name): (String, i64, String) = c.query_row("SELECT hash,size,name FROM attachments", [], |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?))).unwrap();
        assert_eq!(hash, crate::db::sha256_hex_bytes(b"abc"));
        assert_eq!(size, 3);
        assert_eq!(name, "a.pdf");
        assert!(crate::attachments::find_attachment(&d, &r.space_id, &hash).is_some());
        // meta 有且只有这个空间
        let m = crate::db::open_meta_conn_at(&d).unwrap();
        let exists: i64 = m.query_row("SELECT COUNT(*) FROM workspaces WHERE id=?1", rusqlite::params![r.space_id], |x| x.get(0)).unwrap();
        assert_eq!(exists, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn space_import_is_atomic_on_failure() {
        let d = dir("fail");
        let m = crate::db::open_meta_conn_at(&d).unwrap();
        let before: i64 = m.query_row("SELECT COUNT(*) FROM workspaces", [], |x| x.get(0)).unwrap();
        let e = import_space_package_in(&d, &payload(), true).expect_err("注入失败必须回滚");
        assert!(e.contains("injected"), "{e}");
        let after: i64 = m.query_row("SELECT COUNT(*) FROM workspaces", [], |x| x.get(0)).unwrap();
        assert_eq!(before, after, "失败后不许留下空间行");
        let spaces: Vec<_> = std::fs::read_dir(crate::db::spaces_dir(&d)).unwrap().filter_map(|x| x.ok()).collect();
        assert!(spaces.is_empty(), "失败后不许残留空间库/附件目录");
        let _ = std::fs::remove_dir_all(&d);
    }
}
