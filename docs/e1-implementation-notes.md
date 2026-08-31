# E1 本地静置加密 — 实现进度与接续笔记

> 目标:口令→Argon2id→密钥**只存会话内存(不落盘)**;启动默认锁定、口令解锁门控(锁定态不同步/不读);用 **SQLCipher 加密每个工作空间库 `spaces/*.db` 与附件**;重启默认锁定、解锁前数据不可读。

## 设计要点(本会话确定)
- **加密配置移入 meta(明文)**:`encryption_enabled` / `encryption_salt` / `encryption_verify` 现存 `meta.sync_state`(meta.db 不清零),而非各空间库的 `sync_state`。**原因**:磁盘加密后空间库本身不可读,若盐/校验密文也存其中则「解锁前读不到盐→派不出密钥→永远无法解锁」死锁;meta 是唯一可读的存真位置。密钥仍只存会话内存 `SESSION_KEY`。
- **磁盘 vs 传输共用一把会话密钥**:同一口令+盐派生出的 `SESSION_KEY` 同时用于(a)同步载荷加解密(b)空间库 SQLCipher `PRAGMA key`。统一为应用级(全局),而非按空间,和单份 `SESSION_KEY` 一致。
- **头部嗅探判加密(`space_db_is_encrypted`)**:明文库首 16 字节是 `"SQLite format 3\0"`,SQLCipher 库换成随机 salt。以此为「是否要 `PRAGMA key`」的 ground truth,自愈(即使 meta 标记丢失也可靠)。读文件头决定开库时是否设 key。

## 已完成的(已验证,`cargo test --lib` 通过)
- **会话密钥不落盘**:`SESSION_KEY`(会话内存);`set_encryption`/`unlock_encryption` 装入、`lock`/`disable` 清空;不再持久化 `ENC_KEY`。
- **加密配置在 meta**:`encryption_enabled`/读写 salt/verify 走 `meta.sync_state`;`encryption_enabled_base`(供 `db::init` 在 attach meta 前读 meta 自身)。
- **SQLCipher 开库上钥**:`key_space_conn(conn, path)` — 文件头为加密库且有会话密钥则 `PRAGMA key`;`db.rs` 三处开库点(`init` / `reopen_space` / `open_space_conn`)均已接入。
- **启动门控**:`db::init` 若「加密已开启 + 会话无密钥(重启默认锁定)」→ **不打开加密空间库文件**(即使只 open + ATTACH meta,SQLite 触碰加密 main 头也会报 `file is not a database`,导致应用无法启动),而是恢复为「**空 in-memory 主库 + ATTACH meta**」:应用外壳(空间列表/加密状态/解锁屏)从明文 meta.db 正常工作;空间库在 `unlock_encryption` 用密钥重开(`reopen_space`)。前端展示 `LockScreen`。
- **meta ATTACH 必须带 `KEY ""`**:当空间连接是**已加 key**(加密空间)时,`ATTACH DATABASE 'meta.db' AS meta` 会让 SQLCipher 用主库的 key 去解密 meta.db → 报 `file is not a database`。因此 `db.rs` 所有 `ATTACH meta` 点(`reopen_space_at`/`open_space_conn`/`init` 两分支)都改为 `ATTACH ... AS meta KEY ""`(强制 meta 为明文)。这是加了磁盘加密后、空间为 keyed 连接时必踩的真 bug。
- **per-space 加密标记**:`meta.workspaces` 新增 `encrypted INTEGER NOT NULL DEFAULT 0` 列(idempotent `meta_migrate`),`set_space_encrypted_marked` 在开启/关闭成功时按空间写入。开库时以**头部嗅探**为 ground truth(自愈),标记为显式记账。
- **迁移核心 `convert_space_db(path, to_encrypted, key)` = 受控「逐表重建」**,两个方向都已打通并验证:
  - **开启(明文→加密)**:在**目标凭 key 新建**的库上跑 `migrate` 重建 schema,再 `ATTACH` 源库为 `plain`(明文源 `KEY ""`),逐表 `INSERT INTO main.<t> SELECT * FROM plain.<t>` 拷贝,清空并重灌 `page_fts`(跳过 `sqlite_*`/`page_fts*` 影子表;拷贝前删除 `migrate` 预置的 `workspaces` 行避免 UNIQUE 冲突)。
  - **关闭(加密→明文)**:以**加密源为 keyed main** + `ATTACH` 明文目标 `KEY ""` + `sqlcipher_export`(把加密源整体拷成明文)。这是加密方向的反向,绕开了「把 keyed 源 ATTACH 到明文连接会报 `file is not a database`」的问题。
  - 验证:`convert_space_db_encrypt_back_to_readable`(真实 schema + 页面的空间**原地加密→`key_space_conn` 读回→解密→明文读回**)、`convert_space_db_is_idempotent_for_already_encrypted`(幂等)。**另有端到端闭环测试 `full_loop_enable_restart_unlock_readable_disable`**:开启(加密+标记)→ 模拟重启锁定(无 key、错口令拒)→ 解锁(口令校验→重开 keyed)→ 可读 → 关闭(解密回明文),用真实 `set_encryption_impl`/`unlock_encryption_impl`/`disable_encryption_impl` 跑通,并断言**用户数据无损**:工作区名 `默认空间` + 页面 title `hello` 在「开启→重启锁定→解锁→关闭」后仍正确(附 `open_space_conn_reads_encrypted_space` 断言加密后 `page_fts MATCH` 仍命中)。仍保留 SAFE:swap 前校验、备份原库、失败恢复、绝不破坏真库;`set_encryption`/`disable_encryption` 已接入回滚。
  - `set`/`unlock`/`disable` 已重构为**可测 core**(`set_encryption_impl(conn, app_data_dir, pass)` / `unlock_encryption_impl(conn, app_data_dir, pass)` / `disable_encryption_impl(conn, app_data_dir)`),命令只需一行委托;`db` 侧新增 `reopen_space_at` / `open_space_conn_at`(带 app_data_dir)供 core 与测试注入路径。
  - **跨空间打开点已验证 + 全文搜索**:`open_space_conn_reads_encrypted_space` — 加密的非 active 空间经 `open_space_conn_at`(keyed)能读回 `pages`,且**加密后全文搜索仍命中**(迁移重建了 `page_fts`,`page_fts MATCH` 返回正确行)。
- **前端锁屏**:`LockScreen.tsx` + `App.tsx` 在 `encryption_status` 为 `enabled+locked` 时整屏门控,解锁后重载页面;`App.css` 加 `.lock-*` 样式。

## 待办 / 接续(状态)
1. **附件磁盘静置加密(已实现,编译+测试+tsc 通过)**:写盘若加密开启+未锁定则用会话密钥加密(`nonce||ct`,哈希仍在明文上,去重不冲突);自定义 `attachment` scheme(镜像 `asset` 协议 `percent_decode`,限定 `app_data/attachments`,**内存解密**后按 MIME 返回,不写明文临时文件);`read_attachment_bytes`/`copy_attachment` 读/下载解密(关/锁/非密文透传);前端 `convertFileSrc(path, "attachment")` 走该 scheme。验证:`attachment_bytes_encrypt_decrypt_roundtrip` 通过;42 断言 + `tsc` 全绿。
   > ⚠️ **运行态确认**:自定义 scheme 在 Windows 的**实际解析/渲染**需在运行中的 Tauri 应用首次启动确认(本会话无法运行桌面应用)。handler 严格镜像已验证的 `asset` 协议解码,故风险低;若首次启动发现 `attachment://`/`http://attachment.localhost` 未解析,仅需把前端切回 `asset` 协议(一行)即可回退到明文 rendering。
2. **真实库回归**:仅在隔离环境验证后再动真库:先用手工空间库测 `set_encryption`→重启→`unlock_encryption` 全链路(端到端闭环单测 `full_loop_...` 已在隔离环境跑通),确认可在真数据上往返。
3. **`lock` 语义已补强(「锁定态不读」)**:`lock_encryption` 关掉空间连接(清 `SESSION_KEY`+`LOCKED=true`+主连接恢复为「空 in-memory+meta」),锁定后该进程也读不了空间。`unlock_encryption` 重开 keyed。验证:`lock_closes_connection_unlock_reopens`。
4. **前端**:`Main`/独立窗口(`?page=`)均有锁屏门控;`ThemeSettings` 的「锁定」触发整屏 `LockScreen`。

## 构建前提(编译需要)
系统 OpenSSL 已装,编译时设:
```
OPENSSL_DIR=C:\Program Files\OpenSSL-Win64
OPENSSL_LIB_DIR=C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD
OPENSSL_INCLUDE_DIR=C:\Program Files\OpenSSL-Win64\include
```

## 相关提交 / 工作区
- `9b8d0d1` E1 第一步(会话密钥 + 启动即锁定)。此后 `security.rs`/`Cargo.toml` 等改动在工作区。
- **当前工作区未提交改动**(含 `Cargo.toml` bundled-sqlcipher):
  - `src-tauri/Cargo.toml`:rusqlite → `bundled-sqlcipher`。
  - `src-tauri/src/security.rs`:meta 配置 + 磁盘加密 helpers + 迁移 + 启动门控配套。
  - `src-tauri/src/db.rs`:`app_data_dir_ref()` + 三处开库点上钥 + 启动门控分支。
  - `src-tauri/src/crypto.rs`:`key_hex()`。
  - `src/components/LockScreen.tsx` / `src/App.tsx` / `src/App.css`:启动锁屏门控。
  - `docs/e1-implementation-notes.md`:本笔记。

> ⚠️ 不要单独把 `security.rs` 提交到 main:main 的 `Cargo.toml` 还是 `bundled`(无 sqlcipher),`sqlcipher_*` 相关测试会 `cargo test` 失败。要么和 `Cargo.toml`(bundled-sqlcipher)一起提交,要么保持在工作区。
