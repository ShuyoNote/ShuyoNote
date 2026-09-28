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
///
/// ⚠️ **只服务判据**：命令面今天只接了读 / 写那一对，"清"这一条还没有调用方 ——
/// 它与前端 `docContent.ts::clearPageCrdtState` **成对存在**（这一层的口径是三条函数配对）。
/// **删页时该不该清它**是接线决定，不在这里顺手接上；真接的时候删掉下面这一行。
#[cfg(test)]
pub fn clear_page_crdt_state(c: &Connection, page_id: &str) -> Result<(), String> {
    c.execute("DELETE FROM page_crdt WHERE page_id = ?1", [page_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// =====================================================================================
// **待并的远端状态**（冲刺 §11.4 的收口，2026-09-23 第 42 轮）
//
// 为什么要有它：桌面**收到**带 `crdt_state` 的页载荷时，那个字段原先被**静默丢掉**
// （`PageDetail` 没有 `deny_unknown_fields`）⇒ 本地状态永远追不上对端 ⇒ 编辑器 hydration 以本地
// 状态为准 ⇒ 桌面上的跨设备编辑会被自己的旧状态覆盖。Rust 侧**没有** Yjs（要不要引进 `yrs` 是
// S5 阶段 2 的决策），所以这里只把字节**收进来**，由有编辑器语义的那一侧（WebView 里的 TS）在
// **打开页面时**合并 —— 与 S4b-1b 同一手法：C 侧不实现第二份派生/合并实现。
//
// ⚠️ **一行一条（按 `seq`）而不是"每页一行"**：服务端 pull **不回 `device_id`**
//    （`shuyonote-sync-server/src/sync.rs` 只 select seq/entity/entity_id/op/payload/updated_at/project_id），
//    所以桌面无法按"哪台设备"归并。同一台设备后来的状态是**全量状态**（`encodeStateAsUpdate`），
//    但**别的设备**的状态并不包含它的编辑 ⇒ 后到覆盖先到就是**真丢**。⇒ 逐条留着、合并时全并
//    （Yjs 的合并幂等且可交换）⇒ 打开页面后清空。
// =====================================================================================

/// 一条待并的远端状态。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PendingCrdtState {
    /// 服务端那一笔变更的 `seq`（唯一）—— 只用于排序与去重，不外传语义。
    pub seq: i64,
    pub state: Vec<u8>,
}

/// 这一页**最多**留几条待并状态（防"永不打开的页"把库撑大）。
///
/// 取舍写在明处：一个会话窗口里同一页被对端改 24 次以上、而本机一次都没打开过，就会丢最旧的
/// 那几条 —— 丢的是**别人的中间版本**（最终版仍在，因为最新那条是全量状态）；且**留痕**（eprintln）。
pub const MAX_PENDING_PER_PAGE: i64 = 24;

/// 收下一条待并的远端状态（同一 `seq` 重复收到 ⇒ 覆盖，天然幂等）。
pub fn put_pending_state(c: &Connection, page_id: &str, seq: i64, state: &[u8], now: i64) -> Result<(), String> {
    c.execute(
        "INSERT INTO page_crdt_pending (page_id, seq, state, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(page_id, seq) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
        rusqlite::params![page_id, seq, state, now],
    )
    .map_err(|e| e.to_string())?;
    // 超上限 ⇒ 丢最旧的几条（**不静默**：留一条 warn）。
    let dropped = c
        .execute(
            "DELETE FROM page_crdt_pending WHERE page_id = ?1 AND seq NOT IN (
                 SELECT seq FROM page_crdt_pending WHERE page_id = ?1 ORDER BY seq DESC LIMIT ?2
             )",
            rusqlite::params![page_id, MAX_PENDING_PER_PAGE],
        )
        .map_err(|e| e.to_string())?;
    if dropped > 0 {
        eprintln!(
            "[crdt] page {page_id}: 待并的远端状态超过 {MAX_PENDING_PER_PAGE} 条 ⇒ 丢了 {dropped} 条最旧的（最新那条是全量状态，最终内容不受影响）"
        );
    }
    Ok(())
}

/// 这一页所有待并状态（**按 seq 升序**：合并顺序不影响结果，但读数要稳定可复现）。
pub fn read_pending_states(c: &Connection, page_id: &str) -> Result<Vec<PendingCrdtState>, String> {
    let mut stmt = c
        .prepare("SELECT seq, state FROM page_crdt_pending WHERE page_id = ?1 ORDER BY seq ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([page_id], |row| {
            Ok(PendingCrdtState {
                seq: row.get(0)?,
                state: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 清掉这一页的待并状态（合并完就调）。**返回清了几条**（读数用；0 与"清了"分得开）。
pub fn clear_pending_states(c: &Connection, page_id: &str) -> Result<usize, String> {
    c.execute("DELETE FROM page_crdt_pending WHERE page_id = ?1", [page_id])
        .map_err(|e| e.to_string())
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
             );
             CREATE TABLE page_crdt_pending (
                page_id    TEXT NOT NULL,
                seq        INTEGER NOT NULL,
                state      BLOB NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (page_id, seq)
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

    /// ★ **待并的远端状态**：逐条收（**别的设备那条不许被覆盖**）、按 seq 排序读回、清干净。
    ///
    /// 这条钉的就是"每页一行"那种写法的错：同一页两笔来自不同设备的**全量**状态，后到的并不包含
    /// 先到的编辑 ⇒ 覆盖＝真丢。
    #[test]
    fn pending_states_accumulate_per_seq_and_clear() {
        let c = db();
        assert!(read_pending_states(&c, "p1").unwrap().is_empty());

        put_pending_state(&c, "p1", 7, &[1, 2], 1).unwrap();
        put_pending_state(&c, "p1", 9, &[3, 4], 2).unwrap();
        // 别的页不掺和
        put_pending_state(&c, "p2", 8, &[9], 2).unwrap();
        // 同一个 seq 重复收到（重放/重试）⇒ 覆盖，不新增行
        put_pending_state(&c, "p1", 9, &[3, 4, 5], 3).unwrap();

        let got = read_pending_states(&c, "p1").unwrap();
        assert_eq!(got.len(), 2, "两条（seq 7 与 9），重复的 seq 不新增行");
        assert_eq!(got[0], PendingCrdtState { seq: 7, state: vec![1, 2] });
        assert_eq!(got[1], PendingCrdtState { seq: 9, state: vec![3, 4, 5] });

        assert_eq!(clear_pending_states(&c, "p1").unwrap(), 2, "返回清了几条（读数）");
        assert!(read_pending_states(&c, "p1").unwrap().is_empty());
        assert_eq!(read_pending_states(&c, "p2").unwrap().len(), 1, "只清这一页");
        assert_eq!(clear_pending_states(&c, "p1").unwrap(), 0, "再清一次是 0（不是错误）");
    }

    /// 上限：超过 `MAX_PENDING_PER_PAGE` 条 ⇒ 丢最旧的，并**留痕**（不静默）——最新那条一定在。
    #[test]
    fn pending_states_are_capped_but_keep_the_newest() {
        let c = db();
        for seq in 1..=(MAX_PENDING_PER_PAGE + 5) {
            put_pending_state(&c, "p1", seq, &[seq as u8], seq).unwrap();
        }
        let got = read_pending_states(&c, "p1").unwrap();
        assert_eq!(got.len() as i64, MAX_PENDING_PER_PAGE);
        assert_eq!(got.last().unwrap().seq, MAX_PENDING_PER_PAGE + 5, "最新那条必须在");
        assert_eq!(got.first().unwrap().seq, 6, "丢的是最旧的几条");
    }
}
