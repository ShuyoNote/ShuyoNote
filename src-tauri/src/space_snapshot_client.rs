//! CRDT 阶段 2 · **客户端「加密快照」的上传切片**（服务端那一半早已落地）。
//!
//! ## 为什么是这个形状
//! 服务端（`shuyonote-sync-server`，提交 `e7245bc` / 迁移 v17）只做三件事：
//! `PUT /spaces/{id}/snapshot?snapshotSeq=<n>`（体是**不透明字节**）、`GET` 同一份、
//! `DELETE /spaces/{id}/deltas`（**先落快照再退役**，没快照 ⇒ 409）。
//! 它**不解析**快照、不建索引、不持密钥 —— 这是「个人空间在数学上无法解密」那条硬边界
//! （见 `docs/plans/2026-09-24-crdt-privacy-handoff.md`）的唯一可执行形态。
//! 本仓的契约单一事实来源是 `scripts/lib/crdt-snapshot-contract.mjs`（门禁
//! `check-crdt-snapshot-contract` 逐条核它）。
//!
//! ## 快照里装什么（口径写死在这里，别处不要各写一份）
//! **这个空间的库文件字节本身**。理由三条：
//! ① 它才是「新设备只用快照 + 之后的增量就能收敛」的那一份东西（页面、`page_crdt`、
//!    `page_crdt_pending`、附件元数据都在里面）；
//! ② 加密空间在磁盘上**本来就是密文**（SQLCipher/国密参数）⇒ 直接读出来上传即满足 E2EE，
//!    不需要在传输层再包一层（**再包一层反而会让"服务端持有密钥才能读"的怀疑成立**）；
//! ③ `snapshotSeq` 的语义天然对得上：它就是「这份字节覆盖到 `changes.seq` 的哪一条」。
//!
//! ## ⛔ 本切片**不做**什么（如实记，别让人以为已经全通）
//! 1. **明文空间拒绝上传**：字节会原样落在服务端，而服务端解不开 ⇒ 这不是"加密快照"。
//!    所以先 `space_db_is_encrypted` 拦一道（判据见下方单测）。
//! 2. **不做自动阈值策略**：什么时机该传（每 N 条增量？每天？）取决于配额与限流语义，
//!    服务端施工单把「配额与限流」列为未定 ⇒ 本切片只提供**显式命令**，由调用方决定时机。
//! 3. **不做新设备的「先快照再增量」**：那是下一片（要动 pull 的冷启动路径）。
//!
//! ## 判据
//! - `snapshot_url` 的形状（含 `snapshotSeq` 必填）—— 单测 ①；
//! - 明文库被拒、密文库放行 —— 单测 ②③（真文件，不 mock 加密）；
//! - 端到端（真 PUT 到本地服务端）不在本文件：它要一台真服务器，属真机/CI 通道。

use std::path::Path;

use tauri::State;

use crate::db::Db;

/// 上传结果的**回执**（给界面/agent 看的读数，⛔ 不回传快照字节本身）。
#[derive(serde::Serialize)]
pub struct SnapshotUploaded {
    pub space_id: String,
    /// 这份快照覆盖到 `changes.seq` 的哪一条（＝上传时的 `last_pushed_seq`）。
    pub snapshot_seq: i64,
    /// 上传的字节数（服务端也记同一项：它只记字节数与覆盖到哪，⛔ 不记内容）。
    pub bytes: usize,
    /// 服务端回执里的 `updated_at`（拿不到就空串 —— 不编）。
    pub updated_at: String,
}

/// `PUT {base}/spaces/{id}/snapshot?snapshotSeq={seq}`。
///
/// ⚠️ `snapshotSeq` 必须**原样**拼上：服务端缺它就 `400`（它没有默认值 —— 不知道覆盖到哪
/// 就无法安全退役旧增量），见服务端 `space_snapshot.rs::UploadQuery`。
pub(crate) fn snapshot_url(base: &str, space_id: &str, seq: i64) -> String {
    format!(
        "{}/spaces/{}/snapshot?snapshotSeq={}",
        base.trim_end_matches('/'),
        space_id,
        seq
    )
}

/// 明文库**不许**当快照源。
///
/// 判据取 `security::space_db_is_encrypted`（读文件头，不是看配置 —— 配置说"加密"而文件是
/// 明文的那种半吊子状态，正是这条要拦的）。
pub(crate) fn ensure_encrypted_source(path: &Path) -> Result<(), String> {
    if !crate::security::space_db_is_encrypted(path) {
        return Err(
            "这个空间还没加密：加密快照只收**密文**（先在空间隐私里开启加密再上传）。\
             明文字节一旦传到服务端，服务端虽然读不懂，但**它拿到的是可被任何拿到它的人读懂的**东西。"
                .to_string(),
        );
    }
    Ok(())
}

/// 把库里的**一致**快照读成字节（走 `backup_db_to`，不是直接读文件 —— WAL 里还有未落盘的行）。
///
/// ⚠️ 目标文件用**同一把钥匙**打开：加密库的备份到明文目标会失败（SQLCipher 的一条硬规则），
/// 而我们**要的**就是"目标也是密文"。
fn read_db_bytes_encrypted(c: &rusqlite::Connection, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let dir = crate::tempdir::dir("shuyonote-snap").map_err(|e| e.to_string())?;
    let tmp = dir.join("space.db");
    let out = crate::workspace_io::backup_db_to(c, &tmp, Some(key))
        .and_then(|_| std::fs::read(&tmp).map_err(|e| e.to_string()));
    let _ = std::fs::remove_dir_all(&dir);
    out
}

/// 入参：`args: { spaceId }`（与 `claim_page_lineage` 同一套约定 —— 平台层把参数包在 `args` 里）。
#[derive(serde::Deserialize, Default)]
pub struct SnapshotUploadArgs {
    /// 不传 ⇒ 当前激活空间。
    #[serde(default)]
    pub space_id: Option<String>,
}

/// 上传一份**加密快照**（显式命令；时机由调用方定，见模块头 §「不做」第 2 条）。
#[tauri::command]
pub async fn sync_upload_snapshot(
    db: State<'_, Db>,
    args: SnapshotUploadArgs,
) -> Result<SnapshotUploaded, String> {
    // ① 取字节 ＋ 基址 ＋ 令牌（**同步段**：全程持锁，⛔ 不在这里 await）
    let (url, token, bytes, seq, sid) = {
        let c = db.0.lock().expect("db mutex poisoned");
        crate::security::sync_gate(&c)?;
        let sid = match args.space_id {
            Some(ref s) if !s.is_empty() => s.clone(),
            _ => crate::workspaces::active_workspace_id(&c)?,
        };
        let dir = crate::db::app_data_dir_ref()
            .ok_or("应用数据目录还没初始化")?
            .to_path_buf();
        let path = crate::db::space_db_path(&dir, &sid);
        ensure_encrypted_source(&path)?;
        let key = crate::space_crypto::space_key_for_path(&path)?
            .ok_or("拿不到这个空间的钥匙（先解锁再上传）")?;
        let profile = crate::sync::get_profile(&c, &sid)?;
        if profile.space_id.is_empty() {
            return Err(
                "这个空间还没绑定同步（档案里没有远端 space）：先配对/登录再谈快照".to_string(),
            );
        }
        let bytes = read_db_bytes_encrypted(&c, &key)?;
        let base = crate::sync::effective_base(&c, &profile);
        let token = if profile.token.is_empty() {
            crate::sync::get_auth_token(&c, &profile.server_url).unwrap_or_default()
        } else {
            profile.token.clone()
        };
        let seq = profile.last_pushed_seq;
        (snapshot_url(&base, &sid, seq), token, bytes, seq, sid)
    };

    // ② 上传（**不持锁**；体是原始字节 ⇒ 服务端原样落盘、不解析）
    let client = reqwest::Client::new();
    let mut req = client
        .put(&url)
        .header("content-type", "application/octet-stream")
        .body(bytes.clone());
    if !token.is_empty() {
        req = req.bearer_auth(&token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            400 => "快照被拒：snapshotSeq 缺失或为空（客户端问题，不是数据问题）".to_string(),
            401 => "快照被拒：会话已失效，请重新登录".to_string(),
            403 => "快照被拒：当前账号对这个空间没有 admin 权限".to_string(),
            409 => "快照被拒：本机这份比分覆盖的增量还旧（服务端要求单调不减）".to_string(),
            413 => "快照被拒：超出服务端上限".to_string(),
            _ => format!("快照上传失败：{status}"),
        });
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(SnapshotUploaded {
        space_id: sid,
        snapshot_seq: body
            .get("snapshot_seq")
            .and_then(|v| v.as_i64())
            .unwrap_or(seq),
        bytes: bytes.len(),
        updated_at: body
            .get("updated_at")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_url_carries_the_required_seq() {
        // ① 形状：**必须**带 snapshotSeq（服务端缺它 ⇒ 400），且基址末尾斜杠不该多出一个
        assert_eq!(
            snapshot_url("https://sync.example/sync/", "sp-1", 42),
            "https://sync.example/sync/spaces/sp-1/snapshot?snapshotSeq=42"
        );
        assert!(snapshot_url("http://127.0.0.1:8787", "sp", 0).ends_with("?snapshotSeq=0"));
    }

    #[test]
    fn plaintext_db_is_refused_as_snapshot_source() {
        // ② 明文库（真文件头 "SQLite format 3"）⇒ **拒**
        let dir = crate::tempdir::dir("snap-test").unwrap();
        let p = dir.join("space.db");
        std::fs::write(&p, b"SQLite format 3\0").unwrap();
        let err = ensure_encrypted_source(&p).expect_err("明文库必须被拒");
        assert!(err.contains("还没加密"), "错误里要说清为什么：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ciphertext_db_is_accepted_as_snapshot_source() {
        // ③ 非 SQLite 头（＝密文形态）⇒ 放行。⚠️ 这条只判"认不认得出密文"，
        //    不判"那把钥匙对不对"（那是 `space_key_for_path` 的活，另有用例）。
        let dir = crate::tempdir::dir("snap-test").unwrap();
        let p = dir.join("space.db");
        std::fs::write(&p, [0u8; 32]).unwrap();
        assert!(ensure_encrypted_source(&p).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
