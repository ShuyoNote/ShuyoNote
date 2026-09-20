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

### 4. 清理软删空间时「存活空间读不到」⇒ 静默少扫 → 附件被当孤儿**真删**（新增 [高危] 数据丢失）
- `storage.rs::purge_deleted_workspaces`：老写法 `if let Ok(conn) = open_space_conn(&sid)` **静默跳过**
  读不到的存活空间（文件缺失 / 半拷贝 / 权限 / 密钥不符），于是它引用的 hash 不在"仍被引用"集合里 ⇒
  与某个已软删空间共享的附件字节被当孤儿**从盘上删掉**，界面却报"释放了 X"。**没有任何一种读不到的原因
  等价于"它不引用任何附件"。**
- 修法：抽出 `scan_referenced_hashes(ids, open)` —— **读不到就返回这批 id 与原因**；调用方把它挪到
  **删除动作之前**，一旦非空就整体失败（"什么都还没删"），错误信息列出是哪几个空间、为什么。
  已软删空间那侧仍保持宽松（它们本来就要被删，读不到只意味着少回收字节 —— 安全方向），并补 `eprintln`。
- 判据：`storage::tests::purge_refuses_to_guess_when_a_live_space_is_unreadable`（三格：都读得到取并集 /
  一个读不到 ⇒ 整体失败且**不返回任何 hash** / 空集合不算失败）＋ **变异证明**：把该函数退回"静默跳过"，
  这条判据立刻红（`Ok(["h1"])` 而不是错误）。
- ⚠️ 诚实边界：单测覆盖的是**这个函数的严格性**；"扫描必须在删除之前"由调用点的**位置**保证，没有端到端
  （那需要 Tauri `AppHandle`）。真机上的清理动作仍属人手验收。

### 5. 「谁还被引用」的另外三条清理路径都只在**当前空间**里数 ⇒ 删掉别的空间还在用的附件字节（缺陷帖 #6 的同族）
- 背景：`attachments/` 是**全局共享**的内容寻址目录，所以"这个字节还有没有人用"必须**跨全部空间**回答。
  2026-09-19 缺陷帖 #6 只修掉了当时看得见的两条（`clear_trash` 的"删完行再数 + 只数当前空间"、
  `purge_deleted_workspaces` 的 `attachments JOIN pages` 内连接）。2026-09-20 我按「同一族清完了吗」
  重扫了**所有**会删附件字节的调用点，发现还剩三处：

  | 路径 | 老口径 | 后果 |
  |---|---|---|
  | `storage::clear_trash`（清空回收站） | `all_referenced_hashes` = `filter_map(open(..).ok())` ＋ `unwrap_or_default()` | 空间读不到 ⇒ 它引用的字节被判成孤儿 |
  | `storage::cleanup_orphan_attachments`（清理孤儿附件） | **只查当前空间**的 `attachments` | 别的空间还在用的字节被删（用户点这个按钮就触发） |
  | `attachments::remove_attachment`（删单个/批量附件） | 注释写着 true global zero-reference，实际 `SELECT COUNT(*) … WHERE hash=?` 只数当前空间 | 在 A 空间删一个附件 ⇒ B 空间同一个文件消失 |

- 修法（统一）：`scan_referenced_hashes` / `all_referenced_hashes` / `other_spaces_referenced_hashes`
  一律返回 `Result`，**读不全就 Err**；三条路径都改成"读不全 ⇒ 不删"：
  · `clear_trash` 把严格扫描挪到**删除动作之前** ⇒ 失败即"什么都没删"；
  · `cleanup_orphan_attachments` 换成跨空间严格集；
  · `remove_attachment(s)` 先算"其他空间的引用集"（批量只算一次），本空间计数 **与** 跨空间集合**两个条件都满足**
    才删字节；读不全时**保文件**（字节留着只占空间，删错就是数据丢失），由 `cleanup_orphan_attachments` 以后回收。
- 判据：`storage::tests::referenced_hashes_counts_rows_whose_page_is_gone_or_null`（补了「JOIN 口径下查不到」的
  反例守卫）、`storage::tests::purge_refuses_to_guess_when_a_live_space_is_unreadable`、
  `attachments::attachment_byte_free_tests::bytes_are_only_freeable_when_no_other_space_references_the_hash`（四种输入）
  ＋ **变异证明两次**（分别退回"静默跳过"、"只看当前空间"，各自判据立刻红）。
- ⚠️ 诚实边界：跨空间取数走的是生产路径（`open_space_conn`），单测覆盖的是**规则与严格性**；
  "扫描必须在删除之前"由调用点的**位置**保证，没有端到端（需要 Tauri `AppHandle`）。

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
- **邮箱 IMAP 凭据明文落盘**（`email.rs:1140-1159`、`:1185-1187`）：`app_data_dir/email-account.json` **只在 E1 开启且解锁**时用会话密钥加密；E1 关闭（默认关）即明文 JSON，且加密**失败**会**静默回退明文**（`:1151`/`:1153` 的 `unwrap_or_else(|_| a.password.clone())`）。IMAP 应用密码通常一次生成、长期有效、可读全部历史邮件，属高价值凭据；任何以该用户身份运行的进程可直接读取，用户备份/网盘同步 AppData 即等于上传邮箱密码。修法：OS 凭据库（stronghold / Keychain / Windows Credential Manager / libsecret）或默认加密；最低限度应把静默回退改为**拒绝保存并报错**。**待修，独立排期。**
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
