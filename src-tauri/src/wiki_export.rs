//! `export_wiki` —— 把前端算好的静态 wiki 文件表打包成一个 zip 写到磁盘。
//!
//! ⚠️ **为什么渲染不在这里做**（2026-10-05，owner：「我要能用的 LLM Wiki」）：
//! wiki 的渲染（`[[双链]]` → `<a>`、反链、slug、索引页）已经在 **TS** 里有一份成熟实现
//! （`src/lib/wikiExport.ts` 的 `buildWikiExport`，Web 档就是用它）。把它照抄到 Rust 会得到
//! **两套实现** —— 而"两份真相源"正是本仓花最多代价去消灭的东西 ⇒ 所以：
//!   前端算 `Vec<{name, content}>`，Rust 只做「打包 + 写盘」这一件**不重复**的事。
//!
//! ⚠️ 之前这条命令**只在 Web 档有**（`commands.ts` 的注释逐字：「桌面端要这个功能的话，
//!    是在 Rust 侧补一条 `export_wiki`」）—— 本文件就是补的那一条。

use std::io::Write;
use std::path::PathBuf;
use tauri::Manager; // ⚠️ `app.path()` 来自这个 trait，不 import 就是 E0599
use tauri::State; // ⚠️ 命令签名里的 `State<'_, Db>` 需要它（不 import 就是 E0425）

/// 一个待写进 zip 的文本文件（前端已渲染好的 HTML / CSS）。
#[derive(serde::Deserialize)]
pub struct WikiFile {
    /// zip 内的文件名（前端已 sanitize；这里**再挡一层**路径穿越）。
    pub name: String,
    /// 文件内容（UTF-8 文本）。
    pub content: String,
}

#[derive(serde::Serialize)]
pub struct WikiExportResult {
    /// 实际写出的绝对路径。
    pub path: String,
    /// 字节数。
    pub size: u64,
    /// 页数（前端报的，原样带回来给提示用）。
    pub pages: usize,
    /// 写进 zip 的文件数。
    pub files: usize,
}

/// 把一个文件名挡成"只能落在 zip 根下"的形状。
///
/// ⚠️ **两件事**：① 去掉目录部分（`a/b.html` 的目录在 zip 里没意义，而且是我们不需要的复杂度）；
/// ② 挡 `..`（zip slip —— 解压时写到目标目录之外）。前端已有 sanitize，这里是**第二层**：
/// 边界上的检查不该只有一个地方做。
fn safe_entry_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20 {
            '_'
        } else {
            c
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        "未命名".to_string()
    } else {
        cleaned
    }
}

/// 一行页面（给前端渲染 wiki 用；`content_text` 是抽取后的纯文本，前端据此渲染 md/双链）。
#[derive(serde::Serialize)]
pub struct WikiPageRow {
    pub id: String,
    pub title: String,
    pub content_text: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub sort_order: f64,
    pub updated_at: i64,
}

/// ⚠️ **为什么要这条命令**（而不是让 Rust 自己渲染）✗：wiki 的渲染实现在 TS 里
/// （`src/lib/wikiExport.ts`，Web 档就在用）。Rust 再写一份 = 两套实现会漂移。
/// ⇒ 所以拆成两步：**Rust 查库**（它有库的访问权）＋ **TS 渲染**（它已有实现）＋ `export_wiki` 打包。
/// ⚠️ 与 Web 档查询同口径：`workspace_id = 活动空间`，按 `sort_order, updated_at` 排序。
#[tauri::command]
pub fn wiki_export_pages(db: State<'_, crate::db::Db>) -> Result<Vec<WikiPageRow>, String> {
    let c = db.0.lock().expect("db mutex poisoned");
    let active = crate::workspaces::active_workspace_id(&c)?;
    let mut stmt = c
        .prepare(
            "SELECT id, title, COALESCE(content_text,''), COALESCE(kind,'page'),
                    parent_id, COALESCE(sort_order,0), COALESCE(updated_at,0)
             FROM pages WHERE workspace_id = ?1 AND deleted_at IS NULL
             ORDER BY parent_id, sort_order, title",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![active], |r| {
            // ⚠️ 每个字段都**显式标注**：`COALESCE(sort_order,0)` 这类表达式的类型在
            // `query_map` 的闭包里推不出来（E0282，我第一版就是这么挂的）。
            Ok::<WikiPageRow, rusqlite::Error>(WikiPageRow {
                id: r.get::<_, String>(0)?,
                title: r.get::<_, String>(1)?,
                content_text: r.get::<_, String>(2)?,
                kind: r.get::<_, String>(3)?,
                parent_id: r.get::<_, Option<String>>(4)?,
                sort_order: r.get::<_, f64>(5)?,
                updated_at: r.get::<_, i64>(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn export_wiki(
    app: tauri::AppHandle,
    dest_path: String,
    files: Vec<WikiFile>,
) -> Result<WikiExportResult, String> {
    if files.is_empty() {
        return Err("没有可导出的内容（这一份 wiki 是空的）".to_string());
    }
    // 目标：给了就用它（相对路径 ⇒ 落在下载目录），没给就用默认名。
    let dest = {
        let raw = dest_path.trim();
        let p = if raw.is_empty() {
            PathBuf::from("wiki-export.zip")
        } else {
            PathBuf::from(raw)
        };
        if p.is_absolute() {
            p
        } else {
            let dir = app
                .path()
                .download_dir()
                .map_err(|e| format!("找不到下载目录：{e}"))?;
            dir.join(p)
        }
    };
    // ⚠️ 不覆盖已有文件：加序号。导出是**可重做**的动作，但**静默覆盖**用户的旧导出是丢数据。
    let dest: PathBuf = {
        if !dest.exists() {
            dest
        } else {
            let stem: String = dest
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "wiki-export".to_string());
            let ext: String = dest
                .extension()
                .map(|s| format!(".{}", s.to_string_lossy()))
                .unwrap_or_default();
            let dir: PathBuf = dest
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(PathBuf::new);
            let mut n = 1;
            loop {
                let cand: PathBuf = dir.join(format!("{stem}-{n}{ext}"));
                if !cand.exists() {
                    break cand;
                }
                n += 1;
            }
        }
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }

    let file = std::fs::File::create(&dest).map_err(|e| format!("建文件失败：{e}"))?;
    let mut zipw = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut written = 0usize;
    for f in &files {
        let name = safe_entry_name(&f.name);
        zipw.start_file(name, opts)
            .map_err(|e| format!("打包失败：{e}"))?;
        zipw.write_all(f.content.as_bytes())
            .map_err(|e| format!("写入失败：{e}"))?;
        written += 1;
    }
    zipw.finish().map_err(|e| format!("收尾失败：{e}"))?;

    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(WikiExportResult {
        path: dest.to_string_lossy().to_string(),
        size,
        pages: 0, // 前端知道页数；这里不重复算（返回值里保留字段是为了契约形状稳定）
        files: written,
    })
}
