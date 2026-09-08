# 附件哈希前缀分桶（feat/attachment-hash-bucket）

> 目标：附件存储从「单目录平铺 `attachments/<hash>.<ext>`」改为「**按 sha256 前 2 字符分桶** `attachments/<hash[0..2]>/<hash>.<ext>`」。
> 目的：避免单目录文件过多（O(N) 线性 `find_path_by_hash`），对应掘金文 `juejin-storage-architecture.md` 的设计示意。

## 决策（最终）
- **存储文件名**：`attachments/<hash[0..2]>/<hash>.<ext>`（**保留扩展名**）。
  - 原因：前端 `openPath` / `revealFile` 需要**真实存在**且带扩展名的文件（供系统默认程序打开 / 访达定位）；`attachment://` asset 协议按路径读盘 + 按扩展名推断 mime。**不带扩展名会使这两者失效**（曾评估，后决定保留 ext）。
- **分桶维度**：`<hash[0..2]>`（256 个子目录），避免单目录增长。
- **mime/类型权威**：`attachments.mime`（现有模型）。
- **旧数据兼容（双读）**：`find_path_by_hash` 先查桶目录（`<bucket>/<hash>.<ext>`），找不到再扫**旧单目录**（`attachments/<hash>.<ext>`）。不自动迁移删除，避免数据风险。
- **Web 端**：`blobStore`（IndexedDB 以 hash 为 key）无需改；web 的 `attachment_path`/`list_attachment_hashes` 走 blobStore/SQL，不依赖磁盘路径。

## 改动清单（已完成）

### 后端（`src-tauri/src/attachments.rs`）
- 新增 `bucket_of(hash)`（取 `hash[0..2]`）、`bucket_path(dir, hash, ext)`（`<bucket>/<hash>.<ext>`）。
- `find_path_by_hash`：桶目录优先 + 旧单目录回退（双读）。
- `save_image` / `write_attachment_bytes` / `import_attachment_files`：写 `bucket_path`，`create_dir_all` 建桶目录；`.part` 临时文件仍在单目录（不发布）。
- `attachment_path`：改用 `find_path_by_hash`。
- `list_attachment_hashes`：遍历桶子目录 + 旧单目录（取 hash stem，忽略 `.part`）。

### 同步（`src-tauri/src/sync.rs::sync_attachments`）
- `find_file_by_stem`：桶目录优先 + 旧单目录回退。
- `local_set` 收集：扫桶子目录 + 旧单目录。
- 下载写盘：`attachments/<bucket>/<hash>.<ext>`（hash 已由 `is_valid_attachment_hash` 保证 64 hex）。

### 服务端（sync-server）
- 本次**不动**（另分支/后续，若要对齐：`attachments/<space_id>/<bucket>/<hash>.<ext>`）。

## 验证
- `cargo check`（桌面）通过，无警告。
- `cargo test`（55 个）：**53 passed**；2 个 `search::tests::embed_text_*` 失败为**基线既有**（网络嵌入调用，与附件无关，经 stash 对比确认）。
- `node scripts/smoke-web.mjs`：**350 passed, 0 failed**（附件 CRUD/备份/恢复全绿）。

## 风险 / 后续
- 双读保留旧数据，迁移不删——避免数据丢失。
- 桌面 `attachment://` asset 协议：桶路径在 `attachments_dir` 下，`canonicalize + starts_with` 校验通过；带扩展名文件真实存在 → `openPath`/asset 协议正常。
- 若后续想彻底不带扩展名（纯内容寻址），需前端展示/下载按 mime 补 ext + asset 协议按 hash 桶定位，改动更大，另立任务。
