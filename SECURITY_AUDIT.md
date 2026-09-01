# ShuyoNote（数友笔记）Tauri 2 Rust 后端安全审计报告

> 审计范围：`src-tauri/src/` 全部 29 个 Rust 模块、`Cargo.toml`、`tauri.conf.json`、`capabilities/default.json`。
> 审计方法：逐文件通读（约 13k 行）+ 模式 grep（unwrap/expect/unsafe/format! 拼接）。
> 审计日期：2026 年 1 月（基于当前工作区代码）。

---

## 一、总体评价

| 维度 | 评分（1-10） | 评语 |
|---|---|---|
| 架构 | **8** | 双库物理隔离（meta.db + spaces/<id>.db）、outbox/LWW 同步、内容寻址附件、E1 分层（SQLCipher 空间库 + XChaCha 附件 + 会话密钥）思路清晰，模块边界好，注释质量高。 |
| 安全 | **5** | 加密原语使用正确、密钥不落盘设计成立；但**信任边界校验大面积缺失**：自定义协议路径穿越（任意文件读）、两处 zip-slip（任意文件写）、调用方可控 hash 拼接写盘、同步附件与 E1 断裂、SSRF（AI/书签/嵌入）、boa 无超时 DoS。多为「防 XSS/恶意内容/恶意服务端」这一层的缺口。 |
| 测试 | **7** | 全 crate 42 个测试真实有效（不是摆设）：SQLCipher 头嗅探、convert 双向迁移、enable→重启→unlock→disable 全闭环、加密空间跨库读取、boa 命令执行、mock HTTP 语义排序、zip 解析。但 **sync.rs / attachments.rs / lib.rs 协议 / ai.rs 零测试**，且无任何针对穿越/注入的负向测试。 |
| 可维护性 | **8** | `Result<String>` 错误链统一、命名清晰、中文注释详尽；但生产代码 ~50 处 `lock().expect/unwrap`（毒化即全应用崩）、3 处 `unsafe impl Send/Sync` 边界手写、1 个已确认的 ATTACH KEY 引号 bug 属于隐患。 |

**一句话结论**：E1 加密与同步架构设计是亮点，但"本地优先 + 内容可同步 + 插件可执行 + 任意 URL 可请求"的复合威胁模型下，路径/URL/插件侧缺乏最小权限校验，整体处于"功能完备、边界防护未就绪"状态。修复清单集中在 5 个 🔴 与 12 个 🟠。

---

## 二、优点（值得保持的设计）

1. **E1 密钥不落盘**：派生密钥只存 `SESSION_KEY` 内存 Mutex（security.rs:17），meta 只存 salt + verify 哨兵（`VERIFY_MSG` 常量密文），`ENC_KEY` 从不持久化（security.rs:400-402 注释 + 测试断言 `payload_roundtrip_when_enabled` 验证 meta/space 均无 key 行）。
2. **启动锁定门控**：`db::init` 在加密开启且无会话密钥时只开内存库 + ATTACH meta（db.rs:197-209），不触碰加密空间文件，避免"file is not a database"启动失败；`startup_lock` 默认锁定（security.rs:572）。
3. **锁定态不读**：`lock_encryption_impl` 直接替换主连接为内存库（security.rs:474-485），锁定时物理上读不到空间数据；解锁走哨兵口令校验后 `reopen_keyed`。
4. **SQLCipher 头嗅探为 ground truth**（security.rs:113-123），带自愈性，`PRAGMA key = "x'hex'"` 格式正确（security.rs:128）。
5. **迁移安全主路径**：convert_space_db 先写临时文件、验证可读、再换入，失败保留原库（security.rs:253-298），且测试覆盖 idempotent/回读。
6. **SQL 全参数化**：全库未发现 `format!` 拼接用户输入进 SQL 的注入点（`set_profile_field` 的 field 是常量、ATTACH 路径做了 `'` 转义）。
7. **内容寻址附件**：hash 基于明文（attachments.rs:170-183），加密态 dedup 仍生效；`decrypt_attachment_bytes` 失败即明文 passthrough，兼容加密前存量数据。
8. **同步 E2EE**：do_push 对 outbox payload 逐条加密（sync.rs:388-399），sync_gate 在 push/pull 前拦截锁定态（security.rs:448-453）。
9. **boa 面收窄**：只注册 5 个宿主函数（register/__get_current_page/__pages/__toast/__insert），未引入 boa_runtime（无 setTimeout/网络/文件宿主），纯 JS 标准库内无逃逸路径。
10. **测试用真实磁盘 + 真实 SQLCipher + mock HTTP**，不是纯逻辑测试；`SEC_LOCK`/`INIT_LOCK` 串行化处理了全局静态竞争（security.rs:589）。

---

## 三、安全问题清单（按严重度）

### 🔴 高危

#### 1. `attachment://` 自定义协议路径穿越 → 任意文件读取（含 meta.db）
- **位置**：`lib.rs:68-114`（核心在 73-88 行）
- **问题**：`percent_decode` 解码后 `Path::new(&decoded).starts_with(ad)` 是**词法前缀比较，不归一化 `..` 组件**。请求 `/C:/Users/<user>/AppData/Roaming/cn.shuyo.shuyonote/attachments/../meta.db`（或 `%2e%2e%2f` 编码）时，components 前缀与 `attachments` 完全匹配 → 校验通过 → `std::fs::read` 读到 `app_data_dir/meta.db` 并以 `application/octet-stream` + `Access-Control-Allow-Origin: *`（lib.rs:111）返回。meta.db 是明文，内含 **sync token、server_url、device_id、加密 salt、verify 哨兵密文**——一次请求即可把 E1 的口令校验材料与同步凭据全部读出，配合离线暴力破解口令。
- **可达性**：任何能触发 webview 发起 `attachment://`（或 `http://attachment.localhost`）请求的内容——恶意同步服务端推送的含 `<img src="attachment:///...">` 的笔记、渲染层 XSS、被污染的 markdown——都能读；路径可预测（identifier 固定为 `cn.shuyo.shuyonote`）。`*` CORS 还使跨源读取成为可能。
- **修复**：
  1. 校验改为：`fs::canonicalize(decoded)` 与 `fs::canonicalize(attachments_dir)` 比较前缀，且 decoded 的 `Path::components()` 中不允许 `ParentDir`/`CurDir`/`RootDir`；
  2. 移除 `Access-Control-Allow-Origin: *`（自定义协议不需要跨源）；
  3. 补充该 handler 的单元测试（`%2e%2e`、`..\`、编码斜杠、UNC 路径）。

#### 2. sync_attachments 与 E1 磁盘加密断裂（用户已知疑点，确认存在）
- **位置**：`sync.rs:594-732`
- **问题（三个独立缺陷）**：
  - **上传**（sync.rs:657-669）：`tokio::fs::File::open(&path)` 直接流式上传**磁盘上的字节**。加密开启时磁盘附件是 `nonce(24)||ct`（attachments.rs:181），服务端按文件名 hash（=**明文** SHA-256，attachments.rs:172）校验收到的字节 → `SHA256(ciphertext) ≠ hash`，上传必然失败或污染服务端存储。
  - **下载**（sync.rs:692-715）：远端明文字节直接 `file.write_all` 落盘，**不做 E1 加密**——加密开启时磁盘上出现明文附件，破坏"密文静置"一致性；且下载行记录的 `size` 是明文大小（sync.rs:702-723），与本地加密写入路径的语义不一致。
  - **下载路径穿越**（sync.rs:700-704）：`item.hash` 直接来自服务端 JSON（sync.rs:583-592），`attachments_dir.join(format!("{}.{}", item.hash, ext))` 与 `.part` 临时文件同名拼接——恶意/被入侵同步服务端可返回 `hash: "../../meta"` 之类，写入 attachments 目录之外（任意文件写，扩展名受 mime 白名单限制）。上传侧 `find_file_by_stem` 同样以文件名 stem 当 hash。
- **修复**：
  1. 上传：读盘后先 `decrypt_attachment_bytes(session_key, bytes)` 得明文再上传（或服务端改为"按收到的字节计算 hash 建索引"）——建议**统一为上传明文、服务端按明文 SHA-256 校验**；
  2. 下载：落盘前按 `key_if_enabled` 状态 `encrypt_attachment_bytes`，与本地写入路径一致；size 记录明文长度；
  3. 所有 hash 在进入路径拼接前校验 `^[0-9a-f]{64}$`；
  4. `sync_attachments` 入口补 `security::sync_gate`（目前只靠 do_push 的 gate 间接保护）。

#### 3. 备份/空间包导入 Zip-Slip → 任意文件写入 + 恶意 workspace id
- **位置**：`workspace_io.rs:353-391`（scan_workspace_zip）、`backup.rs:230-267`（extract_full_backup）
- **问题**：条目过滤只做 `name.starts_with("attachments/")` / `starts_with("spaces/")` 前缀判断，随后 `tmp_dir.join(&name)` 直接落盘。条目 `attachments/../../../../Users/<user>/xxx` 通过前缀检查，`..` 把写出临时目录 → **任意路径文件写入**（内容来自 zip，可控）。backup.rs 更糟：space id 取自条目名 `name.trim_start_matches("spaces/").trim_end_matches(".db")`（backup.rs:260），恶意 zip 的 `spaces/../../evil.db` 会让 `target_id = ../../evil`，后续 `space_db_path` 把 DB 复制/注册到空间目录之外（backup.rs:387-393），并在 meta.workspaces 植入含 `../` 的 id——再经 `set_active_workspace_id` → `reopen_space` → `space_db_path` 形成二次穿越（任意 sqlite 文件可被打开并写入 migrate）。
- **修复**：每个 zip 条目名用 `Path::components()` 校验（不允许 `ParentDir`/`CurDir`/`RootDir`/`Prefix`），并断言 `tmp_dir.join(name).starts_with(tmp_dir)`；space id 单独用 `^[A-Za-z0-9_-]+$` 白名单校验后再用于文件路径。补负向测试（恶意 zip）。

#### 4. 调用方可控 hash 直接拼接写盘 → 任意文件写入
- **位置**：`attachments.rs:308`（`write_attachment_bytes`）、`attachments.rs:378`（import 路径本身安全，但同模式）；`sync.rs:701` 同模式
- **问题**：`attachments_dir.join(format!("{hash}.{ext}"))` 的 `hash` 是 **IPC 参数**（`write_attachment_bytes(app, db, hash: String, ...)`），未做任何格式校验。`hash = "../../some/where/evil"` → 相对 attachments 目录任意写（内容为调用方数据；加密开启时是密文，关闭时是明文）。同理 `copy_attachment` 的 `dest_path`（attachments.rs:260）、`backup::write_text_file`（backup.rs:440）、`read_text_file`（backup.rs:448）都是无约束任意路径读写。
- **修复**：内容寻址的正确姿势是**服务端自算 hash**（如 save_image 那样），不接受调用方 hash；退而求其次至少校验 `^[0-9a-f]{64}$`。`write_text_file/read_text_file` 收窄到应用导出/备份专用目录或改走 dialog。

#### 5. boa 插件执行无超时/资源限制，且在持有全局 DB 锁时执行 → 全应用 DoS
- **位置**：`plugins.rs:407-446`（run_plugin_command）、`plugins.rs:231-241`（discover_commands）、`plugins.rs:307-309`（conn().unwrap）
- **问题**：
  - `run_plugin_command` 在 `let c = conn(&db);`（plugins.rs:418）取得全局 `Db` MutexGuard 后，`run_command` 同步执行插件 JS（plugins.rs:440）。插件 `while(true){}` 或 `"x".repeat(1e9)` 会**永久占用 DB 锁** → 所有数据库命令阻塞，且持有锁的线程是 Tauri 命令线程，无超时、无指令预算、无内存上限；
  - `list_plugins` 在列举时就执行每个插件的**顶层代码**（plugins.rs:385 `discover_commands`），一个坏插件即可让列表命令挂死；
  - `install_plugin(source_path)` 从任意路径递归拷贝任意目录（plugins.rs:474-495），无大小/文件数限制；`uninstall_plugin`/`run_plugin_command` 的 `root.join(&plugin_id)` 未校验 plugin_id（plugins.rs:415, 465）→ 传 `..` 可 `remove_dir_all` 任意目录（需渲染层被攻陷才可达，但属缺失纵深）。
  - boa 本身无 FS/网络宿主，纯 JS 内 `eval`/`Function` 逃不出解释器，**无任意代码执行**——威胁集中在可用性 + 页面数据注入（`__insert`）。
- **修复**：
  1. 先取数据、释放锁，再执行插件（把 page_count/current_page_json 拷出来）；
  2. 插件执行放独立线程 + `recv_timeout`（如 5s）实现超时；对字符串/数组长度做上限；
  3. `list_plugins` 不应执行顶层代码（或仅执行一次并缓存）；
  4. `plugin_id`/`source_path` 校验：目录名组件、位于 plugins 根内、禁止符号链接。

### 🟠 中危

#### 6. rebuild_space_db 的 ATTACH KEY 缺闭合引号（潜在密钥错误）
- **位置**：`security.rs:190`：`format!("KEY \"x'{}\"", crypto::key_hex(k))` 产出 `KEY "x'<hex>"`，缺少末尾 `'`。对照正确的 `PRAGMA key = "x'<hex>'"`（security.rs:128），此处会被当作**口令**（文本 `x'<hex>`）而非原始 hex key → 解密失败。当前仅因 `convert_space_db` 的 `cur_enc == to_encrypted` 早退（security.rs:234-237）使该分支不可达，一旦源文件状态异常（如标记与头不一致的边角）即触发错误 ATTACH。
- **修复**：补 `'`：`format!("KEY \"x'{}'\"", crypto::key_hex(k))`；并为该分支加测试。

#### 7. 解密迁移吞掉 sqlcipher_export 错误 + 校验不足 → 潜在数据丢失
- **位置**：`security.rs:168`（`let _r: Result<_, _> = ...` 忽略导出结果）、`security.rs:262/291`（只校验 `COUNT(*) FROM sqlite_master`）
- **问题**：解密方向 `sqlcipher_export('target')` 失败被静默吞掉；随后对临时文件的"可读性校验"只查 `sqlite_master` 行数——**空库/部分导出也通过**，然后 `remove_file(path)` + rename（security.rs:277-281）用残缺库替换原库。崩溃窗口（remove 与 rename 之间）更是无原子性（备份仅存内存，security.rs:273）。
- **修复**：检查 export 返回值；校验源/目标表数量与行数一致；改"rename 原库→备份名，再 rename 临时→正式"的两步原子换入；换入后 fsync；崩溃/失败路径统一清理临时文件。

#### 8. convert_space_db 失败残留明文临时库 / 部分失败不回滚
- **位置**：`security.rs:248-251`（tmp 文件 `{stem}_conv_migrate.db`）、`security.rs:407-413`（enable 失败回滚）、`security.rs:530-560`（disable）
- **问题**：
  - `rebuild_space_db` 返回 Err 时（security.rs:251 `?`），`_conv_migrate.db` 残留——**解密方向它可能是整库明文副本**，直接违反 E1 静置加密；
  - `disable_encryption_impl` 先 `convert_all_spaces(...)?`（security.rs:544）逐个解密**非活动**空间，中途失败时 flag 仍是 enabled 而部分库已明文——下次启动"锁定"状态下这些库按头嗅探无需密钥即可读，锁定保证被静默降级。
- **修复**：rebuild 失败即删 tmp（含 -wal/-shm）；disable 改为两阶段（先全部验证/备份，再逐个换入），或失败时反向加密回滚已转换的库。

#### 9. 协议面过宽：CORS `*` + `csp: null` + assetProtocol scope `$APPDATA/**`
- **位置**：`lib.rs:111`、`tauri.conf.json:15-21`
- **问题**：自定义协议对任意 origin 返回 `*`；webview **无 CSP**（`"csp": null`），一旦渲染层出现 XSS，攻击者可 fetch 自定义协议 + 调用任意 IPC（自定义命令不受 ACL 门控）；asset 协议 scope 是 `$APPDATA/**` = 整个 `AppData\Roaming`，可经 `convertFileSrc` 读取其他应用数据。
- **修复**：CSP 至少 `default-src 'self'; img-src 'self' attachment: asset: data:; connect-src 'self'`（按需放行 AI 端点）；asset scope 收窄为 `$APPDATA/cn.shuyo.shuyonote/**`；移除或收紧 `*`。

#### 10. AI / 书签 / 语义嵌入的 SSRF 与 API Key 外泄面
- **位置**：`ai.rs:100-164, 229-236`、`search.rs:238-280`（embed_text）、`bookmark.rs:103-165`
- **问题**：三个功能都接受前端传入的 `base_url`（来自 localStorage，可被用户/被攻陷渲染层篡改）并对其发起带 `Authorization: Bearer <api_key>` 的请求。可指向 `169.254.169.254`（云元数据）、内网 `127.0.0.1:<port>`（本机其他服务）等 → SSRF + 把用户 API key 直接发给任意服务器；`fetch_bookmark_metadata` 的 `og:image` 下载还**不经过 E1 加密直接落盘**（bookmark.rs:130-131）。全部请求无 `.timeout()`。
- **修复**：URL 仅允许 `http/https` 且解析后 host 白名单/黑名单（允许 loopback——Ollama 场景，阻止 link-local/169.254/私网非本机）；请求加超时；书签图片写入走 `encrypt_attachment_bytes`；对非 loopback 端点首次使用时弹确认。

#### 11. E1 锁定态写入洞：锁定时附件仍可明文落盘
- **位置**：`attachments.rs:180-182, 310-312, 379-394`；`security.rs:53-58`（key_if_enabled 锁定时返回 None）
- **问题**：`save_image`/`write_attachment_bytes`/`import_attachment_files` 在会话锁定（`LOCKED=true`）时 `key_if_enabled` 返回 None → **明文写入磁盘**；读路径（read_attachment_bytes、lib.rs:95）锁定时返回密文 passthrough。即"锁定"只门控了同步与空间库读取，附件写面完全开放，且磁盘上出现与 E1 状态不一致的明文。
- **修复**：锁定时这些命令返回错误（或写入后置入待加密队列，解锁时批量加密）；至少在文档中明确定义"锁定态 = 附件只读"。

#### 12. Mutex poison 无恢复：~50 处 `lock().expect/unwrap`
- **位置**：几乎每个命令文件（commands.rs:9、attachments.rs、sync.rs、storage.rs、workspaces.rs:11、templates.rs:8、plugins.rs:308 等，grep 共 250 处匹配，其中约 50 处生产代码）
- **问题**：任一线程在持锁时 panic（如某命令内部 bug），`Mutex` 毒化后**所有后续命令 `expect` panic** → 命令面雪崩；`Db` 无 poison 恢复。Tauri 对命令 panic 只做部分兜底，不解决毒化连锁。
- **修复**：统一改为 `db.0.lock().map_err(|_| "db poisoned")?`（或用 `Mutex::clear_poison` 恢复 + 重建连接），消除生产代码 `expect`。

#### 13. open_space_conn 未校验 space_id → 可打开任意 sqlite 文件并写入
- **位置**：`db.rs:97-120`、`commands.rs:73-98`（list_workspace_pages）
- **问题**：`space_db_path(dir, space_id)` = `spaces/{space_id}.db`，space_id 来自 IPC。`list_workspace_pages("../../meta")` → 打开 `app_data_dir/meta.db` 并按 space 跑 `migrate`/`ensure_space_workspace`（会**写入** workspace 行）；`../../../../Users/<user>/xxx/other.db` 可读任意用户可读的 SQLite 文件内容（经查询返回）。
- **修复**：space_id 必须存在于 `meta.workspaces` 且匹配 `^[A-Za-z0-9_-]+$`。

#### 14. 同步凭据明文静置 + 回传前端
- **位置**：`sync.rs:348-355`（set_sync_config 写 meta.sync_state）、`sync.rs:334-345`（get_sync_config 读回）、`db.rs:255-270`（meta_migrate 建表）
- **问题**：`token`/`server_url` 存明文 meta.db（meta.db 不加密），与问题 1 组合即凭据泄露链；同时 get_sync_config 把 token 回传前端（前端本就要用它，属设计，但应与协议漏洞串联评估）。
- **修复**：至少 token 用 DPAPI/Keychain 存（tauri-plugin-stronghold / keyring）；meta.db 可考虑整体 SQLCipher（需先解决启动鸡生蛋）。

#### 15. 口令解锁无 IPC 限速 + Argon2 参数可再提升
- **位置**：`security.rs:496-519`（unlock_encryption_impl）、`crypto.rs:38-44`（Argon2::default）
- **问题**：`unlock_encryption` 可被无限调用，仅靠 Argon2id 默认参数（19 MiB / t=2 / p=1）做单次成本；meta.db 明文暴露 salt+verify 哨兵（见问题 1）后，攻击者拿到文件即可离线爆破。
- **修复**：IPC 层对 unlock 失败计数 + 指数退避；Argon2id 参数提到 m=64MiB、t=3（桌面可接受）；口令最小长度维持 ≥8。

#### 16. 备份功能与 E1 不兼容（加密空间备份失败/产出不一致）
- **位置**：`backup.rs:139-141`（`Connection::open(space_db_path)` 后直接 `backup_db`，未 `key_space_conn`）
- **问题**：E1 开启时空间库是 SQLCipher 密文，未设 key 的 backup API 读页失败 → `export_backup` 整体报错；即便成功，备份 zip 里 `meta.db` 是明文（含 token），附件是密文/明文混合，导入侧行为不一致。
- **修复**：backup 前对每个空间连接 `key_space_conn`；备份文件建议整包加口令加密。

#### 17. 渲染层无 CSP 时资产/附件 SVG 潜在 XSS 载荷
- **位置**：`lib.rs:104`（svg → `image/svg+xml`）、`tauri.conf.json:15`（csp null）
- **问题**：附件可导入任意 SVG（attachments.rs:60），以 `image/svg+xml` 服务。作为 `<img>` 时脚本不执行，但若渲染层直接导航/iframe 加载该 URL，SVG 内 `<script>` 可执行；配合无 CSP，可提权到 IPC。
- **修复**：SVG 改为 `image/svg+xml; charset=utf-8` + 服务时注入 `Content-Security-Policy: default-src 'none'` 响应头；或对 SVG 做 sanitize 后再存。

### 🟡 低危

18. **sync.rs:454-457**：`space_id` 拼进 GET URL 未 URL 编码（可注入额外 query 参数）。
19. **sync.rs:468-495**：`do_pull` 在 payload 解密/解析失败时仍推进 `max_pulled`（sync.rs:473-474 先于应用逻辑）→ 静默丢变更；建议失败即停并保留游标。
20. **pdf_native.rs:193-225**：`page_index` 无上限、`scale` 无上限、无渲染超时、`doc_cache` Mutex 全程持有（大 PDF 渲染数秒阻塞所有渲染）；恶意 PDF（超大页面尺寸）→ 巨大 pixmap 分配内存 DoS。
21. **pdf_native.rs:38-52, 64-65**：`shared_context` 返回 `&'static mut fz_context` + 手写 `unsafe impl Send/Sync`——当前仅靠注释约定"只在 doc_cache 锁内使用"，属未验证的 UB 边界；建议封装成结构体、仅在 Mutex 内访问。
22. **ai.rs:302-311**：流式响应无换行时 `buf` 无界增长（内存耗尽）。
23. **attachments.rs:359-394**：`import_attachment_files` 的 `.part` 明文窗口 + rename 后加密（387-394），进程崩溃会残留明文附件；建议直接加密流写入。
24. **windows.rs:14**：`page_id` 未 URL 转义拼入 `index.html?page=...`（可注入 query 参数，影响面小）。
25. **search.rs:478**：FTS 查询靠"剥双引号 + 包成 phrase"构造，当前安全但脆弱；建议 FTS5 对查询串做 token 级转义（trigram 下短语语义可能偏离预期）。
26. **lib.rs:89**：`fs::read().unwrap_or_default()` 读失败静默返回空体（配合 403 分支，行为可接受，但错误无日志）。
27. **sync.rs:407/453/603**：每次同步新建 `reqwest::Client` 无连接池、无超时；黑化服务器可挂起命令数分钟。
28. **Cargo 依赖**：`mupdf-sys` 捆绑 **MuPDF（AGPL-3.0）**——随 NSIS 安装包分发需满足 AGPL（源码提供）或购 Artifex 商业授权；`bundled-sqlcipher` 编译体积大（~10MB+）且经 OpenSSL/libcrypto（依赖链含 openssl-sys）；建议审计 Cargo.lock 许可与体积，AGPL 是分发前必须决策项。
29. **backup.rs:313-316**：`cleanup_temp_files` 按前缀 `shuyonote-*` 删除 %TEMP% 下目录（前缀碰撞可误删其他进程目录，影响极小）。

### ⚪ 观察

30. **测试数量**：用户描述的 "security.rs 42 个测试" 不准确——security.rs 有 **12** 个；全 crate 共 **42** 个（bookmark 5 / crypto 3 / backlinks 1 / db 5 / pdf_native 1 / plugins 3 / security 12 / properties 2 / storage 1 / search 7 / workspace_io 2）。security 12 个均真实有效（见优点 10）。
31. **测试盲区**：sync.rs（同步核心，0 测试）、attachments.rs（0 测试）、lib.rs 自定义协议（0 测试）、ai.rs（0 测试）、backup 导入导出（0 测试）、plugins 逃逸/超时（0 负向测试）。建议优先补：附件加密↔同步一致性、协议穿越、zip-slip 负向、插件死循环超时。
32. **security.rs:53-57**：`key_if_enabled` 在锁定时返回 None 使 `decrypt_payload` 变 passthrough——若未来有代码绕过 sync_gate 调用 decrypt，会把密文当明文处理；建议锁定态直接 Err。
33. **`sqlcipher_export`** 依赖 SQLCipher 版本行为（bundled-sqlcipher 4.x），跨版本备份迁移需回归测试。
34. **bookmark.rs HTML 解析**用正则（脆弱但非安全问题）；`meta_value` 的 `content` 正则只匹配单引号/双引号闭合，okay。
35. **capabilities/default.json**：`opener:allow-open-path` 允许 `$HOME/**`——用户主动触发，可接受；但 page 窗口（label `page-{id}`）不在任何 capability 内，自定义命令对全部窗口开放（Tauri 2 自定义命令不受 ACL 门控），当前单用户模型可接受，做多窗口时需重审。

---

## 四、代码质量与架构问题

1. **全局可变静态的集中地**：`SESSION_KEY`/`LOCKED`（security.rs:12-17）、`APP_DATA_DIR` OnceLock（db.rs:14）、pdf 全局 context、插件 `RUN_STATE`/`DISCOVERED` thread_local——都已用锁/OnceLock 串行化，但**无任何一处提供原子性事务**来组合"改 flag + 改库"（如 disable 部分失败问题 8）。建议把 E1 状态收敛为一个 `EncryptionState` 结构（含 Mutex<Option<Key>> + AtomicBool + 版本号），整体管理。
2. **同步无事务边界**：`do_push` 推送成功后推进 `last_pushed_seq` 是"先发后记"，若第 2 步崩溃会重推（幂等性依赖服务端去重）；`do_pull` 应用变更无事务，中途失败游标已推进（问题 19）。建议 push/pull 各自包一个事务 + 游标只在事务内推进。
3. **错误处理风格**：命令层统一 `Result<T, String>`（可接受），但内部 `unwrap_or_default()`/`let _ =` 吞错过多（如 security.rs:168、attachments.rs:391-393 加密写失败仅忽略），安全相关路径应显式处理。
4. **unsafe 边界集中在 pdf_native.rs**（14 处），仅靠注释约束；建议 `#[deny(unsafe_op_in_unsafe_fn)]` 并加 loom/sanitizer 类验证（至少 CI 上 Miri 不可行，但可加 miri 对纯 Rust 部分）。
5. **命令面 110+ 个**（lib.rs:151-268）：无参数结构校验层（除少数 clamp/trim），统一靠 SQL 参数化兜底——可接受，但建议对 `hash`/`id`/`path` 类参数建一个 `validate` helper 集中校验。
6. **meta.db 承担过多**：workspaces + sync_state(token) + templates + plugin_state 混在一个明文库，加密配置（salt/verify）也在此——设计上不得已（启动鸡生蛋），但**token 放这里没有必要性**，应移到系统凭据库。

---

## 五、改进建议 TOP 10（按优先级）

1. **修 `attachment://` 协议路径穿越**（canonicalize + 拒绝 `..` + 去 `*` CORS）——🔴1，最优先，直接关系任意文件读。
2. **修 sync_attachments 的 E1 一致性**：上传前解密、下载后加密、hash 白名单校验、补 sync_gate——🔴2。
3. **统一 zip 解包安全函数**（workspace_io + backup 共用）：组件级路径校验 + 解包大小/条目数上限——🔴3。
4. **所有 hash/path/id 类 IPC 参数集中校验**（`^[0-9a-f]{64}$`、`^[A-Za-z0-9_-]+$`、路径组件白名单）——🔴4、🟠13。
5. **插件执行隔离**：不持 DB 锁执行、独立线程 + 超时、list 不执行顶层代码、plugin_id 校验——🔴5。
6. **网络出口收紧**：AI/书签/嵌入统一一个带 timeout + host 策略（禁 169.254/link-local、非 loopback 需确认）的 client——🟠10。
7. **E1 状态机化**：enable/disable 两阶段事务（先备后换）、失败回滚、tmp 文件清理、修 ATTACH KEY 引号——🟠6/7/8。
8. **CSP + asset scope 收窄 + 锁定时附件写入拒绝**——🟠9/11。
9. **Mutex poison 统一恢复**（`map_err` 或 clear_poison），生产代码去 `expect`——🟠12。
10. **补齐测试盲区**：sync/attachments/协议/zip-slip 负向/插件超时；并把 E1 同步一致性加入 CI——⚪31。

---

*报告生成基于真实代码通读；行号以审计时工作区为准。修复建议按"最小改动消除信任边界缺口"设计，未改动任何代码。*
