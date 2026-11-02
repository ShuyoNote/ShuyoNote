# AI 不可见空间清单（设计稿）

> 状态：**待实现**（设计稿；本文提交时不写代码）。背景：`write_all`（v2）扩读后，外部 AI 可读
> 全部空间；本清单是**唯一用户可见补偿**：让用户明确标记"这些空间不给 AI 看/写"。
> ⚠️ 清单**不是空间权限、不是加密**：只遮蔽 AI 面，用户自己在界面上照常看写。

---

## 1. 清单存哪

**选 `meta.db` 的 `sync_state` 一行 JSON**（key `ai_hidden_spaces`，值为 `["space-id", …]`）。

| 方案 | 代价 |
|---|---|
| `sync_state` JSON（选） | 无 schema 迁移；读写各一次 SQL；清单很小（空间数量级），过滤时一次解析。缺点：不能 SQL join（但拦截点只需要"是否包含"集合判断，不需要 join） |
| 新表 `ai_hidden_spaces(space_id PK)` | 可 SQL 过滤/审计，但要 `meta_migrate` 新迁移、旧库升级路径、备份/恢复要跟着改；与"只影响 AI 面"的收益不匹配 |

口径：
- **默认空**（key 不存在 = `[]`）⇒ 行为与今天**逐字节一致**；
- 写入做校验：只接受 `spaces_list` 里存在的空间 id、去重、上限 500 条，非法 id ⇒ `bad_args`；
- 读取时**丢弃已删除空间**（空间没了就自然不在清单里，不需要清理任务也不报错）；
- ⛔ 不新建配置文件、不落明文到仓库；清单随 `meta.db` 一起在本机（备份/恢复自动带上）。
- **同步口径（已核实，2026-10-30）**：`meta.sync_state` **不参与空间同步**。证据：`sync.rs` 注释「Only these go to meta: device_id + server_url + token. Per-workspace state (E2EE keys, sync cursor) stays in the space DB own sync_state」——同步只搬空间库（changes/页面），meta 只是本机共享 KV。⇒ **清单是本机的，换机后 AI 遮蔽偏好要重配**；备份/恢复会带上 meta.db，但这不是设备间同步。

## 2. 对谁生效

⛔ **只对 AI 面（外部 MCP 的 `ai:true` 能力）生效**；`mcp_hidden_spaces_*` 命令、用户界面、
其它桌面命令一律不受影响。判据 4 会证明"用户自己仍能读"。

## 3. 拦截点（唯一一处）

全部在 `plugins::dispatch_capability`（唯一鉴权点）：

1. 解析出**本次调用的目标空间**：`args.spaceId`（读写都认）或当前活动空间；命中清单 ⇒
   `permission_denied: 空间「X」在 AI 不可见清单里（AI 不可见）—— 用户可在设置里移除`;
2. **`spaces.list`**：结果里过滤掉隐藏空间（否则"不可见"名不副实）；
   ⚠️ `space.current`：若当前空间被隐藏 ⇒ **明确拒绝**（`permission_denied`，提示"当前空间被设为 AI 不可见"），
   ⛔ 不静默降级成空结果/别的空间；
3. **不带 `spaceId`（= 当前空间）**：当前空间被隐藏 ⇒ 同样明确拒绝（读、写都一样；不返回空当成功）；
4. 读侧 `pages.get/pages.list/blocks.list/...`、写侧 5 条白名单、以及 `spaces.switch` 之外的能力
   都经过同一个入口 ⇒ 没有第二条拦截逻辑可漂移。

边界：`write_all` 档的 `pages.create` 跨空间写同样在 dispatch 被拦（目标空间隐藏 ⇒ 拒），
**不产生草稿**，不会出现"草稿确认后才失败"。

## 4. 误伤风险

- 只影响 **AI 面**：同步、引用、搜索、编辑器、导入导出等**用户路径**都不读这个清单 ⇒ 无影响；
- 隐藏一个正在同步的空间：同步照旧（清单不参与同步协议）；只是 AI 看不到它；
- 隐藏当前空间：AI 的所有能力（含不带 spaceId 的）都会被明确拒；用户界面不受影响；
- 清单里指向已删除空间：读取时丢弃，不报错；`spaces_list` 本来就不含删除空间。

## 5. 回滚

- **清空清单 = 完全恢复**（空 = 今天行为）；
- 可选总开关 `SHUYONOTE_AI_HIDDEN_SPACES=off`（或配置 `aiHiddenSpaces:false`）：置 off 时
  dispatch 跳过遮蔽判断（清单仍保留，便于排查"是不是清单导致"）；默认 on。
- 无 schema 迁移 ⇒ 代码回滚只需 revert 合并提交，`sync_state` 里那行 JSON 变成无人读取的残留（可留着）。

## 6. UI 与判据

**UI**（`McpAccessPane.tsx` 新增一块「AI 不可见空间」）：
- 列出全部空间（每行 checkbox + 空间名/id）；默认全不选；
- 文案："勾选后 AI 既不能读也不能写该空间；**你自己不受影响**。隐藏 ≠ 加密。"；
- 仅当外部接入档位 ≠「不接」时可编辑（关档时只读展示 + 提示先开档）；
- 空清单显示"（未隐藏任何空间）"；
- 保存按钮调 `mcp_hidden_spaces_set`，右上角 toast；重开面板从 `mcp_hidden_spaces_get` 读回。

**判据**：
1. 空清单 ⇒ 既有 AI 行为与今天逐字节一致（抽 `pages.list`/`pages.get` 两档返回值对照）；
2. 隐藏 A ⇒ `pages_get/pages_list/blocks_list` 带 `A` ⇒ `permission_denied` 且含「不可见」；
   写工具（`pages.create`/`blocks.patch`）带 `A` ⇒ 同；`spaces_list` 不含 A；
3. 当前空间被隐藏 ⇒ 不带 `spaceId` 的 `pages.list` 与 `pages.create` 都明确拒（不返回空）；
4. 用户侧命令（`get_page`/`list_pages`）**不受影响**（直接命令路径可读）；
5. 清空清单 ⇒ 立即恢复（同上调用通过）；
6. 面板：勾选保存后重开仍勾选；空清单显示"（未隐藏任何空间）"；
7. `mcp_hidden_spaces_set` 非法 id ⇒ `bad_args`；重复/超过上限 ⇒ 去重/拒绝（判据写明）。

## 实现顺序（供拍板）

1. 设计提交（本文件）；
2. 注册表/生成物：两个命令（`CommandMap`＋`DESKTOP_ONLY`＋真变异证据），`apiVersion` 1.18.0；
3. Rust：`meta` 读写 + dispatch 拦截 + `spaces_list`/`space_current` 特判；
4. 面板 + 判据 + 文档（`mcp-external-ai.md` 新节、CHANGELOG、`TESTING.md` facts）；
5. 全量门禁后合 dev。

⚠️ 自评估：**一批可完成**（无 schema 迁移、拦截点单一、判据可用两空间夹具覆盖）。
