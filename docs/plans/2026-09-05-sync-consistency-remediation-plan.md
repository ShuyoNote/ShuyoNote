# 同步一致性整改 + 跨设备回归脚本（可执行方案）

> 依据 [桌面打磨计划](../plans/2026-09-05-desktop-product-polish-plan.md) 的 P0 地基。
> 目标：**让多设备同步「可信」** —— 不再丢变更、不再 400/413、断点能恢复、有回归防倒退。
> 范围：web（`web.ts`）+ 桌面（`sync.rs`）+ 服务端（`shuyonote-sync-server`）三条路径的一致性闭环。

---

## 〇、现状盘点（每项的真实状态）

| 问题 | 现状 | 已处理 | 待处理 |
|---|---|---|---|
| `device_seq` 全 0 被服务端合并 | 早期崩溃 × | web `doPush` 改 `device_seq: c.id`；桌面待核 | 桌面 `push_changes` 的 device_seq 必须**每设备唯一且单调** |
| 附件哈希 FNV(16) vs SHA-256(64) | 旧数据 400 | web 迁移 + 上传自愈已加 | 桌面附件哈希来源需核对为 SHA-256 |
| `.part` 临时文件误上传 | 400 | 桌面 `local_set`/`find_file_by_stem` 已排除 | 补「下载中断自动重下」体验 |
| 增量指针 `last_*_seq` | 推进后失败不回退 | doPull 用 `since`+`limit` | 指针**单调不回退**；push/pull 与 outbox/库同事务 |
| 幂等/去重 | 服务端 `UNIQUE(space,device,seq)` | 部分 | 服务端幂等 + 客户端避免重复推送同 seq |

---

## 一、具体整改项（按文件/接口）

### 1.1 桌面 `src-tauri/src/sync.rs`
- **device_seq**：`push_changes` 里每个 `change` 的 `device_seq` 必须来自**该设备本地单调自增 id**（不能为 0/const）。核对 `record_change` / outbox 的 seq 来源，与 web 的 `c.id` 对齐。
- **增量指针回退**：`last_pushed_seq/last_pulled_seq` 只允许**向上推进**；当 push 成功才推进 `last_pushed_seq`，pull 成功后推进 `last_pulled_seq`，且写入与 outbox 清理**同事务**，避免「推了但指针没动 → 下次重推」。
- **下载断点**：`.part` 下载中断后，下次同步**自动重下**（当前已能重下；确认覆盖写而不是追加重复字节）。
- **附件哈希**：确认桌面写 `attachments.hash` 一律为 **SHA-256(64)**；下载/上传按内容寻址，不做 FNV。

### 1.2 web `src/lib/platform/web.ts`
- `doPush`：确认 `device_seq: c.id`（已改），并**只有推送成功才推进 `last_pushed_seq`**。
- `doPull`：确认 `since`/`limit` 分页推进 `last_pulled_seq`，不因失败回退。
- `syncAttachments`：上传按 `contentHash` 真 SHA-256（已改流式 + 条件重算哈希），下载流式写 IndexedDB（已改）。核对**失败时不推进**、不破坏 outbox。

### 1.3 服务端 `shuyonote-sync-server`
- `/push`：`INSERT OR IGNORE`，`UNIQUE(space_id, device_id, device_seq)` 兜底去重；返回 `last_server_seq`，客户端据此推进指针。
- `/pull`：`since` 只返回**严格大于**的变更；`exclude_device` 防自回传；`limit` 分页。
- 附件：`/attachments/{hash}` 校验 SHA-256；`--max-body-mb`（2T 默认）避免 413；`client_max_body_size` 对齐。

---

## 二、跨设备回归脚本（`scripts/sync-regression.mjs`）

> 目的：**验证「两设备互改→同步→两端一致」**，阻止一致性回归。

### 流程（对 `127.0.0.1:8787` 或可配 server）
1. `ensure_server`：起 / 确认本地服务端（`/sync/health` ok）。
2. `register`：注册一个账号（两个「设备」用不同 device_id 模拟多端）。
3. `create_space` + 绑定。
4. **设备 A**：建 N 个页面 + 上传 M 个附件 → `push`。
5. **设备 B**：`pull`（`since=0`）→ 断言拿到 A 的全部变更 + 附件字节（逐个比对 SHA-256）。
6. **双方互改**：A 改 2 页，B 改 2 页 + 各加 1 附件 → 各自 push → 互补 pull → 断言收敛。
7. **幂等**：同一 `device_seq` 重 push → 服务端 `INSERT OR IGNORE`，不产生重复行。
8. **指针**：二次 pull（`since=last_seq`）→ 只返回新增，不重复全量。
9. 断言：全程 **无 400/413**；两边 `pages`/`attachments` 数量与 hash 完全一致。

### 断言点（`assert*`）
- `push/pull` 返回 `ok`，无错误码。
- 变更计数一致；附件 `sha256` 一致。
- 设备 B 收到 A 的全部变更（`since=0` 全量一次给齐）。
- 幂等重推不重复；增量 `since` 只给新增。

### 运行
```
node scripts/sync-regression.mjs --server http://127.0.0.1:8787
```
接入 `package.json`：`"test:sync": "node scripts/sync-regression.mjs"`，并进入发布前自检。

---

## 三、新增/改动文件清单

| 文件 | 内容 |
|---|---|
| `src-tauri/src/sync.rs` | device_seq 单调；指针单调不回退（同事务）；`.part` 覆盖重下；SHA-256 哈希核对 |
| `src/lib/platform/web.ts` | doPush/doPull 指针正确推进；附件失败不破坏 outbox |
| `shuyonote-sync-server/src/sync.rs` | `/push` 幂等 + 返回 `last_server_seq`；`/pull` `since` 严格大于 |
| `scripts/sync-regression.mjs` | 跨设备回归脚本（新） |
| `docs/SYNC.md` | 自托管 + 常见错误码排查（新） |
| `docs/plans/**` | 本方案（登记索引） |

---

## 四、验收清单

- [ ] 桌面 `push_changes` 的 `device_seq` 每设备唯一单调（非 0）。
- [ ] push/pull 的 `last_*_seq` 只前进、失败不回退；与 outbox/库同事务。
- [ ] 附件哈希全局为 SHA-256(64)；`.part` 不参与上传、中断能重下。
- [ ] 服务端 `/push` 幂等（同 seq 不重复）；`/pull` 严格 `since`。
- [ ] `scripts/sync-regression.mjs` 全绿：两设备互改收敛、无 400/413、哈希一致、幂等、增量。
- [ ] `docs/SYNC.md` 覆盖：体积上限、`--max-body-mb`、常见 400/401/413、`/health` 自检、同源代理、同步不动排查。

---

## 五、交付物（最小）
1. 一致性整改落地的三条路径（web/桌面/服务端）合并。
2. `scripts/sync-regression.mjs` 回归脚本 + 接入 `test:sync`。
3. `docs/SYNC.md` 一页自托管 + 常见错误手册。

> 做完这三件，多设备同步从「实验性」到「可信」，桌面才有「敢让用户长期当主库」的底气。
