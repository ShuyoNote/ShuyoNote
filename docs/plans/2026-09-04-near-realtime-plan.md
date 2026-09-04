# ShuyoNote 团队版「近实时协作」落地实现方案

> 目标：在不引入块级 CRDT 的前提下，把团队协作从「页级 LWW + 5 分钟轮询」打磨到**近实时**——改动即时可见、能看到谁在线/谁在编辑、同页冲突有提示、支持评论 / @ / 通知。
> 决策依据：[实时协同利弊分析](../realtime-collab-analysis.md)。
> 关联：[团队版方案](2026-08-30-team-edition-plan.md) · [团队版 M27.1 账号/空间绑定](2026-08-30-team-edition-account-space-plan.md) · [同步协议](../SYNC.md)。

> ⚠️ **本次明确不做**：块级 CRDT / 富块合并（P2 后置，需付费信号）；个人空间不参与实时协作（保留 E2E）。

---

## 1. 目标与非目标（Scope）

**做**
- P0：同页冲突提示（本地有未推改动 + 服务端该页有新 seq → 提示，用户可选保留/采用）。
- P0：在线状态 + 「谁在编辑本页」提示（presence）。
- P1：页面/块评论 + @ 提及 + 通知中心（未读/已读/跳转）。
- P1.5（可选，分界）：传输层近实时化（SSE/WebSocket 推送），替代纯轮询。

**不做**
- 块级实时合并（CRDT/OT）。
- 富块（数据库视图/看板/图表/PDF/公式）的并发合并。
- 个人空间（E2E）的实时协作。

---

## 2. 现状基线

| 层 | 现有能力 |
|---|---|
| 服务端 | 认证、空间/成员/角色、`/push` `/pull`、附件（内容寻址）、审计、组织、`devices`/`server_config` |
| 客户端 | 同步面板、自动同步（10s~5min 可配）、成员管理、每工作空间独立库 |
| 冲突 | 页级 LWW（unintended 静默覆盖） |
| 缺失 | 评论 / @ / 通知 / 在线状态 / 正在编辑提示 / 同页冲突提示 |

---

## 3. 总体架构（增量式，不推倒现有）

沿用现有 **push/pull + changes 序列 + LWW** 作为数据层；在其上新增**协作感知层**（presence / 冲突提示 / 评论通知）与**可选推送层**（SSE/WebSocket）。所有新增都通过同步服务端（`sync-server`）的新职责承载，客户端用现有 `platform.executor.invoke` 语义命令接入。

```
客户端 ── 心跳/presence ──▶ 服务端
  │  ◀── 变更通知（SSE，可选）── 服务端
  │
  ├─ pull 后：冲突检测（本地未推 vs 服务端新 seq）
  ├─ 评论 / @ / 通知（REST）
  └─ 在线列表 / 谁在编辑（REST）
```

---

## 4. P0.1 同页冲突提示（客户端）

**目标**：不再「静默覆盖」。两人同改一页时给出提示与选择。

**原理**：
- 本地每条未推送变更都带 `entity_id`（page）与 `updated_at`。
- `pull` 后，对**本地有未推变更**的 page，比对**该 page 在服务端的新变更**（新 seq）。
- 若服务端该 page 的 `updated_at > 本地未推变更的 updated_at`，判定冲突。

**客户端行为**：
1. 检测到冲突 → 状态条/弹层提示「此页被多人同时修改」。
2. 提供选择：**保留本地**（仅推送本地）/ **采用服务端**（拉服务端覆盖本地）/ **合并**（行级 LWW，可选）。
3. 不强制，绝不静默覆盖。

**关键**：不新增服务端接口，仅用现有 `pull` 返回的 `changes`（含 `entity/entity_id/updated_at/seq`）+ 本地 outbox 做对比。**工程量 ~1-3 天。**

**（可选升级）行级/块级 LWW**：把「页级整条覆盖」改为「按行/块合并」，冲突面更小。放在 P0 之后的增强，不属必须。

---

## 5. P0.2 在线状态 + 谁在编辑（presence）

**目标**：空间成员列表显示在线；页面顶部显示「谁正在编辑本页」。

**服务端（新增）**

表：`presence`
```
user_id      TEXT PRIMARY KEY,
server_url   TEXT NOT NULL,
device_id    TEXT NOT NULL,
space_id     TEXT NOT NULL,
page_id      TEXT,          -- 当前正在编辑的页（可空）
last_seen_at INTEGER NOT NULL
```

接口：
- `POST /spaces/{id}/presence`（auth）—— 心跳，body `{ page_id? }`，更新 `last_seen_at`；用户首次出现即插入。
- `GET /spaces/{id}/online`（auth，viewer）—— 返回在线成员 `[{ user_id, email, page_id, last_seen_at }]`（`last_seen_at` 距今 < 心跳阈值判在线）。

> 依赖：需要登录用户 `user_id` 与 `device_id`（现有 `/push` 已有 device 绑定逻辑，`device_id` 可复用）。

**客户端**
- 空间成员列表：轮询 `online`（或随自动同步一起），在线标记。
- 页面编辑：进入/离开页面时发心跳（带当前 `page_id`）；编辑器失焦/切页/离开时上报离开。
- 心跳间隔建议 15~30s；超时（如 >2×间隔）标记离线。
- 「谁在编辑本页」：从 `online` 里过滤 `page_id = 当前页`。

**工程量中（~3-5 天）** —— 1 表 + 2 接口 + 前端心跳/列表。

---

## 6. P1 评论 / @ 提及 / 通知中心

**目标**：页面与块级评论、@ 成员、通知中心（未读/已读/跳转）。

**服务端（新增）**

表：`comments`
```
id           TEXT PRIMARY KEY,
space_id     TEXT NOT NULL,
page_id      TEXT NOT NULL,
block_id     TEXT,          -- 可空：块级定位
author_id    TEXT NOT NULL,
author_email TEXT NOT NULL,
content      TEXT NOT NULL,
created_at   INTEGER NOT NULL,
deleted_at   INTEGER
```
表：`notifications`
```
id           TEXT PRIMARY KEY,
space_id     TEXT NOT NULL,
user_id      TEXT NOT NULL,   -- 收件人
type         TEXT NOT NULL,   -- 'mention' | 'comment' | 'invite' ...
page_id      TEXT,
comment_id   TEXT,
actor_id     TEXT,
actor_email  TEXT,
seen         INTEGER DEFAULT 0,
created_at   INTEGER NOT NULL
```

接口：
- `GET /spaces/{id}/pages/{page_id}/comments`（auth，viewer）
- `POST /spaces/{id}/pages/{page_id}/comments`（body `{ block_id?, content }`；解析 `@` 生成通知）
- `DELETE /spaces/{id}/comments/{comment_id}`（作者/admin）
- `GET /notifications`（auth，当前用户，按 `seen`/时间分页）
- `POST /notifications/{id}/seen`
- `POST /notifications/seen-all`

**@ 解析**：内容中出现 `@<email 或 显示名>`，匹配空间成员 → 批量生成 `mention` 通知。

**客户端**
- 评论弹层（挂在页面/块上）：列表 + 输入 + 删除 + 时间。
- @ 成员选择器（输入 `@` 弹出成员列表）。
- 通知中心（未读角标、列表、已读、点击跳转到目标页/评论）、未读轮询。
- 可选：桌面系统通知、邮件/Webhook 外发（方案标为可选）。

**工程量中-大（~1-2 周）** —— 2 表 + 6 接口 + 前端评论/@/通知。

---

## 7. P1.5 传输层近实时化（可选，分界）

**现状**：轮询（10s~5min）。若确要「秒级」，加服务端推送。

**服务端**
- SSE：`GET /spaces/{id}/changes-stream`（auth，viewer）—— 订阅空间，有变更即推 `{ space_id, seq }`；客户端收到后触发一次 `pull`。
- 或 WebSocket（更重，需连接管理/心跳/广播）。

**客户端**
- EventSource 监听 + 收到信号 → `syncWorkspace`；断线自动重连。
- 保留轮询作为降级。

**代价 / 取舍**
- 常驻连接 + 连接管理 + 断线重连，与现有短请求/单机模型不同，自建部署/运维复杂度上升。
- **建议：默认不做，只有客户明确要求「秒级同步」才引入**。这是近实时与真实的成本分界。

---

## 8. 数据模型汇总（新增表）

- `presence`（§5）
- `comments`（§6）
- `notifications`（§6）

> 说明：均为 `sync-server`（sync.db）新增表；客户端本地不新增持久化表（评论/通知走服务端，客户端只缓存会话级状态）。

---

## 9. 接口清单汇总（同步服务端新增）

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/spaces/{id}/presence` | POST | 登录（空间成员） | 心跳/上报当前页 |
| `/spaces/{id}/online` | GET | viewer | 在线成员列表 |
| `/spaces/{id}/pages/{page_id}/comments` | GET | viewer | 评论列表 |
| `/spaces/{id}/pages/{page_id}/comments` | POST | editor | 新增评论（解析@） |
| `/spaces/{id}/comments/{comment_id}` | DELETE | 作者/保留 | 删除评论 |
| `/notifications` | GET | 登录 | 我的通知 |
| `/notifications/{id}/seen` | POST | 登录 | 标记已读 |
| `/notifications/seen-all` | POST | 登录 | 全部已读 |
| `/spaces/{id}/changes-stream`（可选 P1.5) | GET | viewer | SSE 变更订阅 |

> 新增命令入口沿用现有 `team_*` 语义命令（`team_list_comments` / `team_add_comment` / `team_list_notifications` / …），遵守 camelCase 契约。

---

## 10. 客户端改动

- `SyncPanel`：冲突提示（§4）。保持「同步」按钮做客户端前置校验（已有）。
- `presence`：新 store（`usePresence`）+ 心跳 hook；空间成员列表 + 页面「谁在编辑」。
- 评论/通知：新组件（`CommentsPanel`、`NotificationCenter`）+ store（`useComments`/`useNotifications`）+ 未读轮询。
- 自动同步间隔：把默认距再缩短（可选），并为 P1.5 预留 EventSource 监听位。

---

## 11. 里程碑（建议）

| 里程碑 | 内容 | 预估 |
|---|---|---|
| **NR-1 冲突提示** | 同页冲突检测 + 提示/选择 | 1-3 天 |
| **NR-2 在线/正在编辑** | presence 表 + 接口 + 心跳 + UI | 3-5 天 |
| **NR-3 评论/@/通知** | 评论/通知表接口 + 前端 | 1-2 周 |
| **NR-4（可选）推送** | SSE/WebSocket 变更通知 | 按需 |

---

## 12. 验收标准

- [ ] 两人同改一页：后到者看到「此页被多人修改」提示，可保留本地/采用服务端，**不静默覆盖**。
- [ ] 空间成员列表显示在线/离线；页面显示「谁正在编辑本页」；离线在超时后消失。
- [ ] 页面/块可评论；`@` 成员生成通知；被 @ 者收到未读通知并可跳转到目标。
- [ ] 通知中心未读/已读正确，清除全部可用。
- [ ] （若做 P1.5）另一设备改动后，本设备在秒级内收到推送并自动拉取。
- [ ] 增量、不加 CRDT；个人空间（E2E）不受影响。

---

## 13. 风险与取舍

- **传输层是分界**：只做「近实时」（几分钟 + 提示）不引入长连接；上 SSE/WebSocket 才显著增加自建复杂度。
- **评论/通知与权限**：按空间角色 gate（viewer 读、editor 写）；@ 解析按空间成员，避免越权。
- **与 E2E**：团队空间明文可评论/通知；个人空间不参与实时协作。
- **冲突提示是「软」方案**：不自动合并，只提示选择；行级 LWW 合并是可选增强，非必须。

---

## 14. 决策记录

| 项 | 结论 |
|---|---|
| 块级 CRDT | ❌ 不做（P2 后置，需付费信号） |
| 近实时第一步 | ✅ 同页冲突提示（软提示，不静默覆盖） |
| 在线/正在编辑 | ✅ presence 心跳 |
| 评论/@/通知 | ✅ P1（团队版规划范围内） |
| 传输层推送 | ⏸ 可选；仅用户明确要秒级才引入 |
| 个人空间 | 不参与实时协作（保留 E2E） |
