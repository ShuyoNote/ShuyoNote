// 每页的 **CRDT 状态**（桌面侧）—— 与前端那一层（`src/lib/docContent.ts` 的
// `readPageCrdtState` / `writePageCrdtState` / `clearPageCrdtState`）**成对**：两份实现、一套语义，
// 判据也成对（改一边必须同时看另一边 —— 与 `doc_content.rs` 文件头同一条纪律）。
//
// 表 `page_crdt` 由 `db.rs::migrate` 建（两侧同形：`page_id` / `state` BLOB / `updated_at`）。
//
// ⚠️ 这一层**只是存取不透明字节**：Rust 不认识 CRDT 格式，也不该认识 —— 生成/消费它的是前端那套
// `yjs` 会话（`src/lib/crdt/yDocBridge.ts`）。桌面侧要真做"合并"，需要的是 **Rust 的 Yjs 实现**
// （那是另一件事，见 `docs/plans/2026-09-23-crdt-full-launch-sprint.md` 的 S5-0 结论）。
//
// 为什么单开一个文件而不是塞进 `doc_content.rs`：文件小、边界清楚（只碰一张表），
// 而且 `doc_content.rs` 已经很大了（它那一层的判据也在那边成对写着）。
use rusqlite::Connection;

/// 读这一页的状态字节。**没有**（还没建过血统）⇒ `Ok(None)` —— 与"有一份空状态"分得开
/// （前端同一条口径：`null` ≠ 空 `Uint8Array`）。
pub fn read_page_crdt_state(c: &Connection, page_id: &str) -> Result<Option<Vec<u8>>, String> {
    let mut stmt = c
        .prepare("SELECT state FROM page_crdt WHERE page_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([page_id]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => {
            let bytes: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
            Ok(Some(bytes))
        }
        None => Ok(None),
    }
}

/// 写这一页的状态。同一页只留**最新一份**（主键 upsert，不产生第二行）。
pub fn write_page_crdt_state(c: &Connection, page_id: &str, state: &[u8], now: i64) -> Result<(), String> {
    c.execute(
        "INSERT INTO page_crdt (page_id, state, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(page_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
        rusqlite::params![page_id, state, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清掉这一页的状态（页面被删除/彻底重建时用）⇒ 之后读回 `None`。
pub fn clear_page_crdt_state(c: &Connection, page_id: &str) -> Result<(), String> {
    c.execute("DELETE FROM page_crdt WHERE page_id = ?1", [page_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().expect("in-memory db");
        c.execute_batch(
            "CREATE TABLE page_crdt (
                page_id    TEXT PRIMARY KEY,
                state      BLOB NOT NULL,
                updated_at INTEGER NOT NULL
             );",
        )
        .expect("create page_crdt");
        c
    }

    /// 与前端判据 `pageStateStore.test.ts` ① 成对：**没有 ⇒ None**；写回读**逐字节相同**
    /// （含非 UTF-8 字节 —— 若被当文本存过一道，这里就会不相等）。
    #[test]
    fn page_crdt_state_round_trips_bytes() {
        let c = db();
        assert!(read_page_crdt_state(&c, "p1").unwrap().is_none());

        let raw: Vec<u8> = vec![0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0x01];
        write_page_crdt_state(&c, "p1", &raw, 7).unwrap();
        assert_eq!(read_page_crdt_state(&c, "p1").unwrap().unwrap(), raw);
    }

    /// 与前端判据 ② 成对：同一页只留**最新一份**（主键 upsert）；`clear` 之后回 `None`。
    #[test]
    fn page_crdt_state_keeps_latest_and_clears() {
        let c = db();
        write_page_crdt_state(&c, "p1", &[1, 2, 3], 1).unwrap();
        write_page_crdt_state(&c, "p1", &[9, 9], 2).unwrap();

        let rows: i64 = c
            .query_row("SELECT COUNT(*) FROM page_crdt", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "同一页只留一行");
        assert_eq!(read_page_crdt_state(&c, "p1").unwrap().unwrap(), vec![9, 9]);

        clear_page_crdt_state(&c, "p1").unwrap();
        assert!(read_page_crdt_state(&c, "p1").unwrap().is_none());
    }
}
