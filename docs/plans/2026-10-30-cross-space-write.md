# 跨空间写（`write_all` 落库链路）设计稿

> 状态：**待拍板**（设计稿；本文件提交时**未写任何实现代码、未改注册表**）。
>
> 背景：`dev` 当前 70 能力 / 61 工具 / `apiVersion` 1.15.0。第六档「可写（全部空间）」只开了**权限门**：
> `granted` 含 `write:all-spaces`，但 `write_target_space()` 对别的空间仍返回 `bad_args`（明确说"落库链路未接"），
> ⛔ 不静默写当前空间。本设计只回答"怎么接、风险多大、v1 做到哪"。

---

## 1. 现状与约束

### 1.1 写链路（唯一写库入口）

```
外部 agent ──HTTP──▶ mcp_channel ──▶ mcp_host::handle_external_call
                                        │
                                        ▼
                              plugins::dispatch_capability   ← 唯一鉴权/审计点
                                        │ 写能力：只校验 + push_draft
                                        ▼
                              前端草稿队列（无落库）
                                        │ 用户确认（confirmAndApplyDrafts）
                                        ▼
                         src/lib/ai/apply.ts（唯一写库入口）
                                        │ 调用现有 Tauri 命令（无 spaceId 参数）
                                        ▼
                        Rust 命令（create_page / save_page / set_page_prop / …）
                                        │ 全部绑**当前活动空间**的 SQLite 连接
                                        ▼
                   space DB（pages/blocks/page_versions/attachments/…）＋ 变更记录
```

关键事实：

- **MCP 写 = 草稿**：写能力只做参数/前置校验并 `push_draft`，`applied` 恒 false；**落库只在前端 `apply.ts` 一处**。
- **所有写命令都绑当前空间**：命令签名里没有 `spaceId`；连接来自 `db::Db`（活动空间）。前端 `apply.ts` 也只调这些命令。
- **`with_conn_for_space` 只有读侧**：它给 `pages.list` / `files.*` / `versions.*` 等**只读**能力开目标空间连接（并要求 `read:all-spaces`）；
  写侧没有对应物（`write_target_space()` 只做权限判定，不返回目标空间写连接）。
- **每个空间都有一整套状态**（不是"一张 pages 表"）：
  - 空间 SQLite：`pages` / `blocks` / `page_versions` / `page_props` / `tags` / `attachments` / `changes` / FTS 派生（`chunks` / `attachment_text`）等；
  - 附件字节目录：按**空间 id** 分开（`attachments::plain_bytes_of(app_data, space, hash)`）；
  - 加密：每空间独立 SQLCipher 钥匙；**锁着时空间库打不开**（`open_space_conn_at` 会报 cipher/key 错误）；
  - CRDT：`page_crdt` 状态按页存（前端 `page_crdt` 命令写；Rust 只搬运，不认识格式）；
  - 同步游标：`changes`（`record_change` 唯一写入）＋ `sync_*` 表；漏写 ⇒ 该空间那台设备的同步永远看不到这次修改。

### 1.2 本设计必须守住的不变量

1. **唯一写库入口仍在前端 `apply.ts`**（M2 的契约：写必须经过草稿确认；⛔ 不新增第二条"agent 直接落库"的路）。
2. **当前空间完全不被影响**：跨空间写不能顺手改活动空间（不切空间、不动 UI、不动当前空间 `changes`）。
3. **目标空间的所有副作用**必须写全（见 §3），否则会造出"看起来写进去了、同步/搜索/CRDT 却是坏的"。
4. **锁着的目标空间 ⇒ 明确拒绝**（`permission_denied` 并说明 locked；⛔ 不静默回落当前空间）。
5. **不支持的写工具带 `spaceId` ⇒ 明确 unsupported**（`bad_args` 点名该工具暂不支持），⛔ 绝不写当前空间。

---

## 2. 候选方案与取舍

### 方案 A：临时切活动空间（switch → 写 → 切回）

做法：MCP 写带目标 `spaceId` ⇒ 调 `setActiveWorkspace` 切过去 → 前端 apply 写 → 切回。

**不可取**，理由：

- **用户界面被劫持**：切空间会触发页面树/编辑器重挂、当前页丢失、同步状态重算；一次 MCP 写导致整窗跳变，用户无法接受（且 apply 是异步确认流程，窗口期更长）。
- **并发**：用户同时在操作当前页；切走再切回之间，用户的编辑/自动保存/去抖补丁可能落到**错误空间**（这是数据损坏级风险）。
- **同步副作用**：切换会改活动空间游标、触发增量拉取；跨空间写变成"顺带同步一次"，语义不可控。
- **失败不可回滚**：写一半失败时"切回"本身也可能失败，最后一个动作错了就停在错误空间。

### 方案 B：写命令加可选 `spaceId`（**推荐**）

做法：保持"草稿 → 前端 apply 落库"不变，把 `spaceId` 从能力参数一路传到 **Rust 写命令**；
Rust 按目标空间开**可写连接**执行写入（含 `changes` / CRDT 状态 / 派生文本），前端 apply 传目标空间并在确认框标出空间名。

**为什么它守住不变量**：写仍然由 `apply.ts` 发起（前端没有别的写入口）；Rust 的写命令是"这一次调用的执行器"，
不是新的"agent 可直连的写面"。MCP 面仍只能产草稿。

**需要新增/修改**（按最小面）：

- Rust：`create_page` / `save_page` 等命令加可选 `spaceId`；内部用 `open_space_conn_at(target)` **可写**连接，
  并在同一事务里写 `changes`（`record_change`）、更新派生文本、必要时处理 CRDT/版本；
- 前端：`apply.ts` 把草稿 payload 里的 `spaceId` 传给命令；确认框显示目标空间名；
- 读侧：`blocks.append/patch` 需要**先读目标页正文**才能合并 ⇒ 要么 `write_all` 同时给 `read:all-spaces`，
  要么由 Rust 在目标空间内部只读后合并（见 §2.3 取舍）。

### 方案 C：把草稿落库搬进 Rust（前端只确认）

做法：前端确认后调一个"执行草稿"的 Rust 命令，由 Rust 按 payload 在目标空间执行全部写。

**代价**：事实上的**第二个写库入口**（payload → 写）；M2 的"唯一 apply.ts"契约破掉，
草稿语义/幂等/审计/失败上报都要在 Rust 重做一遍，等于把前端那套（含块合并、模板、导入）复制一份 ⇒ 两份实现必然漂。
还有 CRDT/派生文本的写入者约束（`check-derived-writers`：派生表唯一写入者是 TS 抽取管线；CRDT 状态由前端写）。
**不建议**，除非未来整体把 M2 改成"Rust 执行草稿"（那是一次架构迁移，不是本批）。

### 2.3 推荐方案与 v1 最小工具集

**推荐 B。** 但不建议一批做完全部 3 个工具，原因见下：

| 工具 | 跨空间能否安全落库 | 关键依赖 |
|---|---|---|
| `pages.create` | ✅ 可以（**推荐 v1 只做这一个**） | 只需目标空间可写连接 + `changes`；无正文读取、无合并 |
| `blocks.append` | ⚠️ 需要读目标页正文（拿 block 结构/末尾位置） | 读目标空间 ⇒ 需要 `read:all-spaces`，或 Rust 侧盲追加（重复前端合并逻辑 ✗） |
| `blocks.patch` | ⚠️ 同上（必须读目标页、按 blockId 改 JSON） | 同 append；且改正文要处理 CRDT/派生文本，风险更高 |

**owner 2026-10-30 拍板（甲）**：`write_all` 档**同时具备读全空间**（`granted` 加 `read:pages` ＋ `read:all-spaces`），以便改其他空间的已有页面；代价是**开这档 AI 能读所有空间**（加密空间仍不可见，锁着打不开）。v2 按此实现：`pages.get`/`blocks.list` 加 `spaceId`（读目标页），`pages.update`/`blocks.append/patch/delete` 由 `apply.ts` 在取回目标页后用现有合并路径完成、落库传 `spaceId`（⛔ 不复制合并逻辑、不进 Rust），写命令抽单连接实现复用全部副作用。

**v1 建议（可一批交付、判据可证）**：

- **支持**：`pages.create` 带 `spaceId` ⇒ 在目标空间新建页（写目标空间连接 + `changes` + 版本/派生按现有 create 路径）。
- **明确 unsupported**（`bad_args: <tool> 暂不支持跨空间（v1 只支持 pages.create）`）：
  `blocks.append` / `blocks.patch` / 其余所有带 `spaceId` 的写工具。
- `write_all` 面板文案改为"可写到指定空间（v1：新建页面）"，其余工具继续显示"跨空间暂不支持"。
- 这样**不需要**动 `read:all-spaces` 语义（保持"能写到看不见的空间"），也不需要 Rust 复制块合并逻辑。

**如果必须 v1 覆盖三个工具**，则需要 owner 先拍定二选一：

1. `write_all` **同时给 `read:all-spaces`**（"可写全部空间 ⇒ 也能读全部空间"）⇒ 前端 apply 可先读目标页再合并；
   代价：与现有"写 ≠ 读"的档位语义冲突（面板/文档要改，且用户预期变化）。
2. 让 **Rust 在目标空间做块合并**（盲追加/按 blockId patch）⇒ 需要把 `apply.ts` 的块合并逻辑搬到 Rust 或复制一份；
   代价：两份实现、CRDT/派生写入者约束、回归面大，**风险不可控**。

---

## 3. 每空间副作用清单（跨空间写必须写全）

| 副作用 | 由谁写 | 漏了会怎样 | v1（pages.create）是否涉及 |
|---|---|---|---|
| `pages` 行（id/title/content_json/content_text/kind/排序/时间） | 写命令 | 目标空间看不到页 | ✅ 必须 |
| `changes`（`record_change`，entity=page） | 写命令 | 目标空间设备的同步永远看不到这次新建 | ✅ 必须 |
| 块图 / 块行（`blocks`） | 现有 create/save 路径 | 块的引用/反链/块级查询缺失 | ✅（新页按现有 create 行为） |
| 派生文本（FTS `chunks`、`attachment_text`） | TS 抽取管线 / 命令内既有路径 | 目标空间搜不到新页 | ✅ 走既有 create 路径；⛔ 不在 Rust 另写一套 |
| 版本快照（`page_versions`） | 现有 create/save 路径 | 历史缺失（可接受但与当前空间行为不一致） | ✅ 走既有路径 |
| 附件字节目录 | 只有附件写（files.*）涉及 | 附件打不开/解密失败 | ⛔ v1 不涉及（files.* 仍 unsupported） |
| CRDT 状态（`page_crdt`） | 前端 | 多端协作把该页当"未知"、可能覆盖 | ✅ 新页无状态；走既有 create 后由前端播种 |
| 加密（目标空间锁着） | — | 直接打不开/写坏 | ✅ **必须拒绝**（见 §5 判据 2） |
| 同步游标 / 概要 | 既有同步路径 | 同步偏移、重复拉取 | ✅ 由 `changes` 保证；v1 不额外动游标 |

**结论**：v1 只做 `pages.create` 时，所有副作用都能复用**现有 create 路径**（把连接换成目标空间 + `record_change` 已在命令内），
没有"新写一套"的重复实现；一旦扩到 `blocks.*`，正文合并与 CRDT/派生的写入者约束就会成为主要风险源。

---

## 4. 回滚策略

1. **一键关闭开关**（实现时加，默认 on，仅用于回滚）：
   - 环境变量 `SHUYONOTE_MCP_CROSS_SPACE_WRITE=0`（与现有 `SHUYONOTE_MCP_SWITCH` 同风格）或在 MCP 配置文件加 `crossSpaceWrite:false`；
   - 关闭后 `write_target_space()` 立刻回到当前行为：带 `spaceId` ⇒ `bad_args`（明确说"跨空间写已关闭"）；
   - 判据：设开关 ⇒ 拒绝；去掉 ⇒ 恢复。（开关**只影响跨空间**，当前空间写不受影响。）
2. **证明"当前空间没被影响"**：
   - 两空间夹具：记录当前空间在调用前后的 `pages` 行数、`changes` 最大 seq、`page_versions` 行数、`attachments` 行数 ⇒ **逐项相等**；
   - 目标空间对应项按预期 +1；审计行带 `spaceId=目标`；
   - 目标空间**锁着** ⇒ 拒绝，且两空间数据都未变。
3. **代码回滚**：实现独立分支 + `--no-ff` 合并；回滚 revert 合并提交即可（无 schema 迁移）。
4. **不做数据库迁移**：v1 不新增表/列（`changes.payload` 已有）；若实现需要迁移 ⇒ 停下来重新设计。

---

## 5. 判据清单（实现时逐条）

1. **落到目标空间**：两空间夹具，`write:all-spaces` + `pages.create{spaceId: target}` ⇒ 草稿确认后
   目标空间 `pages` 出现该页（直接开目标空间库断言），**当前空间 pages/changes/versions 逐项不变**。
2. **目标空间锁着** ⇒ 明确拒绝：统一用 **`permission_denied`**，消息含 `locked`/`已锁定`（不新增错误码）；
   断言两空间都无写入。
3. **缺 `write:all-spaces`** ⇒ 仍 `permission_denied` 并点名 `write:all-spaces`（现有判据保持）。
4. **不支持的写工具**带 `spaceId` ⇒ `bad_args: <tool> 暂不支持跨空间`，⛔ 不写当前空间（读回当前空间断言不变）。
5. **审计**：该次调用审计行带 `spaceId=目标`（`push_audit` 的 payload/row 增字段）；**变更记录**：目标空间
   `changes` 出现 entity=page、op=upsert 一行（用现有 `changes` 表断言），当前空间不变。
6. **回滚开关**：关闭 ⇒ 判据 1 反向（拒绝）；打开 ⇒ 恢复。
7. 前端：确认框显示目标空间名（"将写入『招标资料』"）；`write_all` 文案改为"可写到指定空间（v1：新建页面）"。
8. 门禁：`check-capabilities` / `check-agent-surface` / `check-generated-artifacts` / `check-api-surface-version` /
   `check-mcp-*` / `check-doc-facts` / `tsc` / `cargo check --lib --tests` 全 0；`apiVersion` 1.15.0 → **1.16.0**。

---

## 6. 风险判断与建议（本批结论）

**结论：不建议"一批做完全部 3 个工具"；建议 v1 只做 `pages.create`。**

理由：

- `pages.create` 的跨空间落库可以**完全复用现有 create 路径**（换连接 + `record_change`），没有第二份合并实现，
  风险可控，判据可逐条证明"目标空间有、当前空间没变"。
- `blocks.append/patch` 需要**先读目标页正文**：要么改 `write_all` 的读权限语义（需要 owner 拍板，影响面板/文档/用户预期），
  要么在 Rust 复制块合并逻辑（第二实现；CRDT/派生文本写入者约束会把风险放大一个量级）。
- 加密锁着的目标空间、每空间派生文本/版本/`changes` 的完整性，都是"漏一处就静默坏"的类型；
  分批交付能把每一批的判据做扎实，避免一次大面积回归。

**建议的下一步拍板**：

- 认可 **B + v1=pages.create** ⇒ 我按 §5 判据实现（独立分支 `feat/cross-space-write`）。
- 或要求 v1 覆盖 `blocks.*` ⇒ 请先拍定 §2.3 的二选一（`read:all-spaces` 扩权 / Rust 合并），再另开设计。
- 本设计提交后**不写实现、不改注册表**，等拍板。
