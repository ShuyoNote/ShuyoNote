# ShuyoNote 同步机制详解

> 桌面（Rust）与 Web 版共用同一套同步协议，均对接 self-hosted `sync-server`（默认 `http://121.199.8.24/sync`）。

## 一、整体架构

```
设备A(桌面/Web)  ──push──▶  sync-server ──pull──▶  设备B(桌面/Web)
  (本地库 SQLite)                (云端"变更日志")        (本地库)
```

- **本地优先**：每台设备都有自己的本地库（桌面 rusqlite / Web sql.js）。编辑先写本地，秒开。
- **sync-server**：只作为"中继 / 合并"中心，存**账号 + 空间 + 增量变更日志（changes）**，不存最终数据库快照。

## 二、增量：本地 `changes` 表（核心）

每次写入（新建页 / 改页 / 改属性 / 打标签…）都在本地追加一条 change：

```
{ device_id, device_seq, entity, entity_id, op, payload, updated_at, seq }
```

| 字段 | 含义 |
|---|---|
| `entity` | `page` / `attr` / `prop` / `page_tag` / `attachment`（改了哪类） |
| `op` | `upsert`（写入/覆盖）或 `delete` |
| `payload` | 该实体的**完整内容**（服务端与另一设备据此还原） |
| `device_seq` / `seq` | 每台设备独立递增序号，用于"知道我推到哪了" |

> **附件（文件）同步 = 行元数据（changes）+ 字节（附件接口）两部分：**
> - `attachment` 实体只带文件**元数据**（`id / page_id / name / hash / mime / size`），随 push/pull 走 `changes` 表，让文件在另一设备的「文件管理器 / 目录树」里出现。
> - 文件**字节**按内容哈希（SHA-256）走 `sync-server` 的
>   `PUT /spaces/{space_id}/attachments/{hash}`（上传）与 `GET /spaces/{space_id}/attachments/{hash}`（下载）。
>   `sync_attachments` 在每次 push+pull 后做一次"远端/本地哈希差集"：本地有而远端没有的就上传，远端有而本地没有的就下载到本地字节库。上传按内容寻址幂等（同哈希不重复写）。

## 三、推送（push：本地 → 服务器）

```
读 changes WHERE seq > last_pushed_seq，取前 500 条
→ POST {server}/push  { device_id, space_id, changes:[...] }   (Bearer Token)
→ 成功后：last_pushed_seq 推进到本次最大 seq
```

- **只推增量**（按 seq），并非全量。
- `401` = 会话失效，需重新登录。

## 四、拉取（pull：服务器 → 本地）

```
GET {server}/pull?since={last_pulled_seq}&limit=500&space_id=..&exclude_device={device_id}
→ 对每条 change 按 op 应用（upsert 覆盖 / delete 删除）
→ last_pulled_seq 推进到返回的最大 seq
```

- `exclude_device`：跳过自己推上去的那批（不重复应用自己的变更）。
- 应用后的实体写回本地库。

## 五、"实时"程度

这不是 WebSocket 推送，而是**增量轮询**：

- **手动**：点同步按钮 → 立即 push + pull。
- **定时**：应用内每隔一段时间（秒～分钟级）自动 push+pull，检测到新变更就应用 → 接近"实时"。

> 结论：**近实时**（基于轮询间隔），不是毫秒级。跨设备在一台改完，另一台在下一次轮询/手动同步后看到。

## 六、冲突（last-write-wins，LWW）

同时改动同一实体（如同一页面）：以服务端认为**最后到达**的变更覆盖（`op=upsert` 覆盖整个实体）。不做字段级合并。极端并发同改会**后者覆盖前者**——个人笔记足够；团队重要同改场景后续可加字段级合并/冲突提示。

## 七、加密与隔离

- **空间隔离**：每个空间（`space_id`）绑定自己的变更集；`/push` `/pull` 均带 `space_id`，不会串空间。
- **认证**：注册/登录返回 `Bearer Token`，请求带 `Authorization`。
- **设备**：`device_id` 区分每台设备，避免"自己推的自己再拉回"。

## 八、典型跨设备流程

1. 设备A 改页面 → 本地 `changes` 加一条 → 定时/手动 push → 服务器记下。
2. 设备B 定时 pull `since=last_pulled` → 拿到 A 的 change → `upsert` 到 B 本地 → B 看到更新。
3. 反向同理。两端最终**趋向一致**（最终一致模型）。

---

**一句话**：本地优先 + **增量 changes 日志**（push/pull by seq）+ **近实时轮询** + **LWW 冲突** + **空间隔离/token 认证**。桌面 / Web 同一协议互通，鸿蒙版将来复用同一套。

## 相关文档
- 客户端实现（桌面）：`src-tauri/src/sync.rs`
- 客户端实现（Web）：`src/lib/platform/web.ts`（同步引擎）
- 服务端：`shuyonote-sync-server`（`/auth/*` `/spaces` `/push` `/pull`）
