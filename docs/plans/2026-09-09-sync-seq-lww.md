# 同步 LWW 改为服务端 seq 基准（根治时钟漂移）

> 背景：团队多人协作下周上线。现 LWW 键 = 各设备本地时钟 `updated_at`（时钟漂移 → 整页覆盖丢改动）。改为**服务端单调 `seq`** 作为 LWW 键，根治漂移。

## 调度模型（关键）
- **服务端** `changes` 表 `seq` = `INTEGER PRIMARY KEY AUTOINCREMENT`（服务器接收顺序，全局单调，已是权威序）。**服务端无需改动**。
- **客户端** `pages` 表新增 `sync_seq`（该页最后**接受**的远端变更 seq）。用于 LWW 判断。

### LWW 规则（客户端 apply 远端变更时）
对变更 `c`（entity=page, seq=c.seq）：
```
page = pages[id]
if page 不存在:  插入（记录 sync_seq = c.seq）        // 新建
else if c.seq > page.sync_seq:                        // 远端更新 → 接受
    pages ← 远端内容；sync_seq = c.seq
else:                                                // 本地已有更新（或曾拉过更新的）→ 保留本地
    （不覆盖）
```
- `sync_seq` 语义 = "该页当前内容基于哪个服务端 seq"。本地编辑**不改变** sync_seq（本地内容是"更新"但 sync_seq 停留在上次拉取点）。
- 陷阱：本地编辑后 sync_seq 不变，下次远端 seq 更大仍覆盖本地 —— 这正是 LWW（远端最后到达赢）。若想保护本地未同步改动，需另加"dirty 标记"（见下）。

### 本地保存（save_page）时
- **不更新 sync_seq**（本地改动属于"待 push"状态）。但需**增加 dirty/locally_modified 标记**，否则本地刚改的会被远端（seq 更大）覆盖丢。

### 保护本地未同步改动（防丢）
- `pages` 加 `dirty`（本地有未 push 改动）。本地 save 时 dirty=1；push 成功后服务端 seq 更新，客户端 pull 回来 seq>sync_seq 且本地 dirty=1 → **保留本地 + 清 dirty**（已同步）。
- 即：**dirty=1 时，远端变更不覆盖本地（保护本地）；dirty=0 时，远端 seq 更大则覆盖（正常 LWW）**。

## Schema / 迁移
- `pages` 表加：
  - `sync_seq INTEGER NOT NULL DEFAULT 0`
  - `dirty INTEGER NOT NULL DEFAULT 0`
- 迁移：`ALTER TABLE pages ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0; ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;`
- 桌面 Rust + Web TS 两处 schema + 迁移都加。

## 改动清单
| 文件 | 改动 |
|---|---|
| 服务端 | 无（seq 已有）|
| 客户端 db 迁移（Rust `db.rs` / Web `sqliteStore.ts`）| `pages` 加 `sync_seq`/`dirty` |
| 客户端 `apply_upsert`（桌面）/ `applyChange`（web）| 用 `c.seq` + `sync_seq` + `dirty` 判断，替代 `updated_at` LWW |
| 客户端 `save_page` | 本地保存置 dirty=1 |
| 客户端 push/pull 后 | push 成功清 dirty；pull 应用按上面规则 |
| 回归 `sync-regression.mjs` / smoke | 补"两设备同改 + dirty 保护"用例 |
| 文档 | `docs/SYNC.md` |

## 风险 / 兼容
- 旧数据 `sync_seq=0`、`dirty=0`：首次 pull 时 seq>0 → 会被远端覆盖（若远端更新）。**旧单人自托管**（单机无并发）影响小。
- 改动面：客户端同步核心（schema + apply + save + push/pull），**影响所有同步数据**，需完整回归。
- 本地 dirty 保护是本设计"防丢"关键，必须正确实现。

## 验证
- 客户端 cargo test / pnpm test / smoke / sync-regression 全绿。
- 新增"两设备同改一页 + 时钟漂移"用例：A/B 都改 → sync_seq/dirty 决定保留谁。
- 真机：两台设备同改一页，确认不互相吞。
