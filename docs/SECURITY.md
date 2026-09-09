# ShuyoNote 客户端安全审计（v1.84.3）

> 审计日期：2026-09-09　｜　审计范围：`src-tauri/src/`（客户端 Rust 后端）+ 同步服务端协同路径
> 方法：7 个安全维度并行深审（路径/文件、加密/密钥、网络/SSRF、注入/协议、插件/执行、并发/状态、依赖/许可），基于**当前代码**实读，逐项核实 2026-01 旧审计的修复状态并找新增漏洞。
> 先前那份 `shuyonote-sync-server/docs/SECURITY_AUDIT.md`（2026-01 写）已过时，以本文件为准。

---

## 一、总体结论

- **主干高危已真实修复**：`attachment://` 路径穿越、sync_attachments 的 E1 断裂 + hash 穿越、zip-slip、hash 拼接写盘、open_space_conn 的 space_id 校验、do_pull 游标先推进丢变更——这些旧报告的高危项，当前代码已用 `canonicalize` + 组件白名单 + `is_valid_*` + `safe_join` 等封锁。
- **仍未达"安全可用"门槛**：插件执行持全局 DB 锁 + 无超时（死循环即雪崩）、E2EE 同步复用本地 E1 密钥（跨设备静默丢数据）、import_workspace / uninstall_plugin 的 id 未校验（任意文件写/删）——这 3 项是**上线前必须修**的高危，本次已修复（见下）。
- **可后置**：一批中危（同步 HTTP 无超时、AI/书签 SSRF、锁定态附件明文、Mutex poison 无恢复、备份无约束读写命令等）与若干低危/观察。

> 一句结论：架构与加密原语设计好，主体漏洞已收敛；上线前把 3 项高危钉死 + 补插件/同步的边界校验，即可支撑团队使用。

---

## 二、本次已修复（2026-09-09，commit `19184e4`）

### 1. 插件执行持全局 DB 锁 + 无超时（旧 [高危5]）
- `plugins.rs`：`run_plugin_command`/`list_plugins` 改为**先锁内取数据、立即释放锁**，再把 boa JS 执行放到**独立线程 + `recv_timeout(5s)`**。死循环插件不再占用全局 `Db` 锁 / 卡死命令面。
- 新增 `is_safe_plugin_id`（`^[A-Za-z0-9_.-]+$`），`uninstall_plugin`/`install_plugin`/`run_plugin_command` 入口校验——`uninstall_plugin("..")` 不再能 `remove_dir_all` 整个应用数据目录。

### 2. E2EE 同步复用本地密钥 → 跨设备静默丢数据（新增 [高危]）
- `sync.rs::do_pull`：`decrypt_payload` 失败**不再静默跳过 + 推进游标**（那会永久丢弃该变更）；改为返回明确错误（提示各设备 E1 口令/密钥可能不一致），且**游标仅在成功应用后推进**，避免跨设备加密内容被吞。
- （架构级修复——正式 E2EE 需独立 per-space/peer 密钥 + 密钥交换，见"仍存关注"。这里先做"不丢数据"的止损。）

### 3. import 空间 id 路径穿越 + purge 任意文件删（旧 [高危3/4] 的残留）
- `workspace_io.rs::import_workspace`：zip 内 `workspace id` 先过 `is_safe_space_id`（否则改用 UUID），杜绝 `..` id 拼 `spaces/<id>.db` 任意写 / 污染 `meta.workspaces`。
- `storage.rs::purge_deleted_workspaces`：删除前对 `sid` 做 `is_safe_space_id` 纵深校验，防历史脏数据导致任意文件删。
- `db.rs`：`is_safe_space_id` 改 `pub` 供跨模块复用。

> 验证：`cargo test --lib` **55 passed / 0 failed**（含 plugins / sync / workspace_io / storage 测试）。

---

## 三、已修复（旧报告高危，当前代码确认锁定）

| 旧漏洞 | 状态 | 证据 |
|---|---|---|
| [高危1] `attachment://` 路径穿越 → 任意文件读（含 meta.db） | [已修] 已修 | `lib.rs:103-114` canonicalize + 拒绝 `ParentDir` + CORS 去 `*` |
| [高危]2 sync_attachments 与 E1 断裂 + 下载 hash 穿越 | [已修] 已修 | `sync.rs:1556-1668` 解密/加密 + `is_valid_attachment_hash` |
| [高危]3 备份/空间包 zip-slip + 恶意 workspace id | [已修] 已修 | `workspace_io.rs:365` / `backup.rs:219` `safe_join` + `safe_space_id` |
| [高危]4 调用方可控 hash 拼接写盘 | [已修] 已修 | `attachments.rs:371` `is_valid_hash` |
| [中危7] 解密迁移吞 export 错误 | [已修] 已修 | `security.rs:171` `map_err` |
| [中危13] open_space_conn 未校验 space_id | [已修] 已修 | `db.rs:31` `is_safe_space_id` |
| [中危19] do_pull 游标先推进丢变更 | [已修] 已修 | `sync.rs:1252-1305` 游标后置 |
| [中危9] CORS `*` / `csp:null` | [已修] 已修 | `lib.rs:151-163`（origin 白名单）、`tauri.conf.json:15`（非 null CSP） |

---

## 四、仍存在（上线后建议跟进）

**[中危] 中危**
- **do_push 游标过度推进 + dirty 误清**（`sync.rs:1177-1195`）：`max_seq` 取全局 max 而非本次推送 batch 的最大 `device_seq`；>500 pending 或推送期间编辑时可能静默丢同步。
- **do_pull 失败使 `foreign_keys` 永久 OFF**（`sync.rs:1250-1306`）：`?` 早退跳过 FK 恢复 → 数据完整性受损。建议 RAII guard + 事务。
- **apply_delete 不尊重 dirty 优先**（`sync.rs:194-217`）：只比 `updated_at`，未读 `dirty`/`sync_seq` → 本地未同步内容被远端删除覆盖。
- **锁定态附件明文落盘**（`attachments.rs:223/381/456` + `sync.rs:1636`，E1 静置一致性）。
- **同步 HTTP 客户端 26 处 `Client::new()` 无超时**（`sync.rs`）；`team_login`/`team_register` 账号口令可发给任意前端可控 URL。
- **AI/书签/嵌入 SSRF + API key 外泄**（`ai.rs`/`search.rs`/`bookmark.rs`）：`base_url` 无 host/scheme 校验，可指向 `169.254`/内网并带 key。
- **backup 三个无约束 text/binary 读/写命令 + copy_attachment `dest_path`**（`backup.rs:496-516`、`attachments.rs:293`）。
- **ATTACH KEY 缺闭合引号**（`security.rs:194`，潜伏——正常路径当前不可达）。
- **unlock 无限速 + Argon2 仅 19MiB**（`security.rs:532`、`crypto.rs:42`）——meta 泄露后可离线爆破口令。
- **E2EE 架构问题**（真正修复需 per-space 密钥 + 密钥交换；当前已做"不丢数据"止损，但"跨设备可解"需要产品决策）。

**[低危] 低危/观察**
- CORS 前缀匹配放过 `http://127.0.0.1.evil.com`（`lib.rs:155`）；asset scope `$APPDATA/**` 过宽；`space_id` 拼 URL 未编码；`bucket_of` 对非 ASCII `[0..2]` panic；Mutex poison ~100 处 `.expect` 无恢复；SVG 无 CSP 响应头；服务端 `max_body_mb` 默认 2TB；mupdf-sys 渲染不可信 PDF（需 CVE/许可治理）。

---

## 五、建议优先级

1. **（已修）** 插件持锁 + 无超时；E2EE 同步不丢数据；import/purge id 校验。
2. do_push 游标边界 + do_pull 事务/FK 恢复 + apply_delete 尊重 dirty（数据正确性）。
3. 网络出口收紧（AI/书签 SSRF + 同步超时）、锁定态附件写拒绝、unlock 限速 + Argon2 增强。
4. 依赖门禁（`cargo-deny`/`cargo-audit`）+ 备份命令收窄 + Mutex poison 统一恢复。

---

*本文件为安全审计结论与修复记录；行号以 v1.84.3 工作区为准。*
