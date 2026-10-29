# 方案：把更多 ShuyoNote 能力暴露给外部 Agent —— 能力暴露矩阵（v2 · 评审后修订）

状态：待评审 v2（未开始实现）—— 相对 v1 的改动见文末「修订记录」；本文只定"暴露什么、什么档、怎么判"，不写代码。

关联：`capabilities/capabilities.json`（注册表＝单一事实源）、`src-tauri/src/mcp_channel.rs`（默认关/只绑回环/token/权限位）、`docs/plans/2026-10-29-agent-block-write-p2.md`、`docs/plans/2026-10-29-shuyodoc-m1.md`。

## 0. 适用范围

**本册只覆盖「个人版」**（单用户、本机、空间级权限）。团队/企业空间不适用——那里要先回答"Agent 以谁的身份写 / 角色权限 / 审计给谁看"（§8）。目标不是全暴露，而是用最小面覆盖常见工作流（读→总结→改块→整理结构→传附件）。

## 1. 两个正交维度（替代 v1 混用的 P0/P1/P2/边缘/专议）

| 级别 | 含义 |
|---|---|
| **R** | 只读 |
| **W** | 写：必须 `expectedRev`/`expectedSha` ＋ 审计；默认权限关 |
| **Wc** | 写 ＋ **需用户当场确认**（草稿或系统保存框） |
| **✗** | 不暴露（进 §7.2 红测试清单） |

`needs_user_confirm` 与级别正交（W 也可能加）。**批次**：B1 只读扩容 → B2 写扩容＋回滚 → B3 专议。

## 2. 现有 29 条注册表能力（permission 逐条列出）

| 能力 id | permission | 级别 | 批次 | 说明 |
|---|---|---|---|---|
| pages.list / pages.get / pages.search / pages.count | read:pages | 现✓ | — | 已有 |
| page.current | read:page.current | **R** | B1 | 补"当前页"入口（只读） |
| blocks.list | read:pages | 现✓ | — | 已有 |
| backlinks.list | read:backlinks | 现✓ | — | 已有 |
| files.list / files.search / files.read | read:files | 现✓ | — | 已有（含派生文本） |
| coverage.report | read:files | **R** | B1 | "哪些内容没进检索面" |
| tags.list | read:tags | **R** | B1 | 注册表有、MCP 未暴露 |
| properties.list | read:properties | **R** | B1 | 数据库/属性读前门 |
| spaces.list | read:pages | 现✓ | — | 已有 |
| pages.create | write:pages | 现✓ | — | 草稿确认 |
| pages.importMarkdown | write:pages | 现✓ | — | 整页，粗粒度 |
| pages.update | write:pages | 现✓（收窄待定） | — | 整页替换；块级写落地后建议降为 Wc |
| blocks.append | write:pages | 现✓ | — | 尾部追加 |
| tags.add | write:tags | **W** | B2 | 与 tags.list 配对 |
| tags.remove（新增） | write:tags | **W** | B2 | v1 漏（不对称） |
| properties.set | write:properties | **W** | B2 | 校验 attrId/类型 |
| properties.unset（新增） | write:properties | **W** | B2 | v1 漏 |
| files.export | export:files | **Wc** | B1 | 要用户点保存框 |
| editor.insertText | write:page.current | **✗** | — | 即时生效、插用户光标处 ⇒ 干扰打字 |
| spaces.switch | write:pages | **✗**（B3 再议） | B3 | 改用户所在空间，副作用大 |
| user.notify | — | **Wc（B3）** | B3 | 弹提示 ⇒ 限流（§5） |
| kv.get/set/remove、settings.get、log.write | kv:own / — | **✗** | — | 插件私有面 |

## 3. 新增能力

| 能力 | permission | 级别 | 批次 | 判据要点 |
|---|---|---|---|---|
| `pages.tree` | read:pages | R | B1 | 与 pages.list 集合一致、层级与树 UI 一致 |
| `changes_since(pages:{pageId:rev})` | read:pages | R | B1 | **页面级游标**（不再假装空间级 rev）；同 rev 两次读⇒空；改一块⇒只回该块 |
| `db.schema` / `db.rows`（只读） | read:pages | R | B1 | 数据库块最大空白；v1 只给原始值，⛔ 不重算公式/汇总 |
| `versions.list` / `version.get` | read:versions | R | B1 | 与版本 UI 一致；读旧版不改现状 |
| `trash.list` | read:trash | R | B1 | 与回收站 UI 一致；本批不给恢复 |
| `files.stat` | read:files | R | B1 | sha/mime/size/pageId/抽取状态；与 files.list 一致 |
| `files.extract_status` | read:files | R | B1 | 与 coverage.report 同口径 |
| `files.list_orphan` | read:files | R | B1 | `page_id IS NULL`；**.shuyodoc 导入会造这种资产** |
| `files.download` | export:files | **Wc** | B1 | 句柄单次+TTL120s；取回 sha == stat.sha256；⛔ 不塞上下文 |
| `export.markdown` / `export.docpackage` | export:files | **Wc** | B1 | 句柄；`.shuyodoc` 已实现（M1）⇒ 不需对话框 |
| `blocks.patch/insert/delete` | write:pages | W | B2 | 见 P2 七条判据 |
| `pages.move` / `pages.rename`（**节点通用**） | write:pages | W | B2 | id 不变；**环检测必拒**（不许移进自己子孙） |
| `nodes.delete`（软删） | write:pages | W | **B2** | 进回收站、可恢复、引用检查 |
| `trash.restore` | write:pages | W | **B2（与软删同批）** | v1 丢 B3 是错的：不能"能删不能恢复" |
| `pages.revert(rev)` / `audit.revert(auditId)` | write:pages | W | **B2** | 回滚后逐字一致；**新增回滚审计**（不删原记录） |
| `files.upload_to_page` | write:files | W | B2 | sha 自证、同名不覆盖、大小/MIME 上限 |
| `files.detach` | write:files | W | B2 | 摘归属但保留文件（⛔ 与 delete 分开） |
| `files.move` / `files.rename` / `files.delete` | write:files | W | B2 | delete 做**引用检查**：正文引用则拒绝并点名 |
| `db.rows_write` / `db.rows_delete` | write:pages | W | B2 | 类型/必填校验；v1 不写公式列 |
| `templates.list` / `templates.apply` | read:pages / write:pages | R / Wc | B1/B2 | apply 建页要草稿确认 |
| `import.docpackage` | write:pages | **Wc** | B2 | 复用 M1 读包＋永远新建；失败原文照显示 |
| `files.convert_to_note` / `files.reextract` | write:pages | Wc | B3 | 新建页/耗算力 ⇒ 专议＋限流 |

## 4. 分批

| 批次 | 内容 | 批级判据 |
|---|---|---|
| **B1 只读扩容** | §2 的 R ＋ §3 的 R/Wc 只读族（含导出/下载句柄、files.export、templates.list） | 零写路径改动；每条挂载级判据；§7 元判据全绿 |
| **B2 写扩容＋回滚** | blocks.*、pages.move/rename、nodes.delete＋trash.restore、pages.revert、tags.add/remove、properties.set/unset、db.rows_write/delete、files.upload_to_page/detach/move/rename/delete、templates.apply、import.docpackage | 全部带 expectedRev/expectedSha＋dryRun；冲突必拒；审计一条/次；§7 全绿 |
| **B3 专议** | spaces.switch、user.notify、files.convert_to_note/reextract、批量 | owner 拍"允许打扰/耗时" |
| **✗** | editor.insertText、kv.*、settings.get、log.write、任意 SQL/HTTP/路径、永久删除 | §7.2 红测试 |

## 5. 拒绝/打扰的统一判据（v1 不一致，这里定死）

任一条满足 ⇒ 不暴露或降为 Wc：① **改用户正在进行的操作**（光标处插入、切空间）；② **绕过草稿确认**（即时生效）；③ **不可撤销**。
按此重判：`user.notify` 满足 ① ⇒ B3 + **限流 ≤3 条/分钟/会话**；`files.delete` 不满足 ③（软删可恢复）⇒ 可 B2，但必须引用检查。

## 6. 数据外泄约束（v1 最大安全漏）

凡返回**原字节**或**落盘**（files.download / export.* / files.export）：返回**句柄**而非字节——128bit 随机、**单次可用**、**TTL 120s**、绑定会话；判据：二次使用失败、过期失败、跨会话取不到；**>10 MB 或 >20 个文件** ⇒ 追加用户确认；审计记"导出/下载了哪个对象"，⛔ 不记内容。

## 7. 判据矩阵

### 7.1 元判据（对注册表全量跑）
1. 表驱动：每条已暴露能力，权限关 ⇒ 必 `permission_denied`；
2. 表驱动：每个 W/Wc 能力必须在"写操作元数据"清单里（expectedRev/expectedSha/dryRun/审计）；
3. 表驱动：每个 R 能力必须有分页/上限参数；
4. 工具声明的能力 id ⊆ 会话已授予权限；
5. 每个写调用恰 1 条审计（批量合并也要有条数上限）。

### 7.2 不暴露清单红测试
出现以下任一 ⇒ 失败：能力 id ∈ {editor.insertText、kv.*、settings.get、log.write}；描述含"任意 SQL/任意 URL/按路径读取"；任何"永久删除/清空回收站"；任何返回**裸字节**而非句柄的下载工具。

### 7.3 跨块不变式
引用检查（附件被正文引用 ⇒ delete 拒绝并点名）；树不变式（move 后无环/无孤儿/父级顺序正确）；回滚不变式（revert 后逐字一致 ＋ 新增回滚审计）。

## 8. 团队/企业空间（本册不覆盖，只列前置问题）

① Agent 以谁的身份写（用户 token / 服务账号 / 租户级 Agent）；② 企业角色能否被继承、跨空间越权怎么挡；③ 审计合规与保留期；④ 租户内容不得被外部 Agent 带出（与 §6 叠加）。四条不落，企业版不开 Agent 写面。

## 9. 默认数值（v1 全是"待定"，这里落默认）

批量 ≤50/次；文本返回上限 200 KB/次（超出分页）；下载句柄 TTL 120s、单次；大文件阈值 >10 MB 或 >20 文件需确认；`user.notify` ≤3 条/分钟/会话；读单页上限沿用现状（200 条 / 20000 字符）。

## 10. 待拍（更新版）

1. B1 是否**默认开只读**（含"跨空间只读"档）？还是保持默认关、用户开？
2. `files.export` / `export.*` 放 B1（Wc）可以吗？
3. `user.notify` 只允许 B3 ＋ 限流，同意吗？
4. `db.rows` 过滤：沿用界面搜索口径，还是给简单 `where`（字段+操作符+值）？

## 修订记录（v1 → v2）

1. 档位统一为 **R/W/Wc/✗ ＋ B1/B2/B3**（删 P0/P1/P2/边缘/专议混用）；
2. 新增 **permission 列**（逐条来自注册表）；
3. 补 **回滚**（pages.revert / audit.revert）进 B2；
4. **删除与恢复同批**（nodes.delete＋trash.restore 均 B2）；
5. `changes_since` 改**页面级游标**语义；
6. 统一 `files.*` 命名（删 `attachment.upload` 别名）；
7. 补对称写：tags.remove、properties.unset、db.rows_delete、templates.*、import.docpackage；
8. 明确**数据外泄约束**并作为判据；
9. 新增 §5 统一拒绝/打扰判据，重判 editor.insertText（✗）与 user.notify（B3+限流）；
10. 新增 §7 判据矩阵、§9 默认数值、§8 团队空间前置问题。

## 11. 空间作用域：能不能"指定空间"而不切换（2026-10-29 owner 追问）

### 11.1 现状（代码事实，2026-10-29 核对 `src-tauri/src/plugins.rs`）

| 面 | 能否指定空间 | 依据 |
|---|---|---|
| **读** `pages.list` / `pages.search` | **能**（可选 `spaceId`） | `with_conn_for_space(space_id, …)`（L1688/L1739/L1984）；跨空间需 **「只读（全部空间）」** 档 |
| **读** `pages.get` | **不能** | `cap_pages_get(id,…)`（L1932）按 id 读**当前空间**库，无 `spaceId` |
| **写** `pages.create` / `pages.update` / `blocks.append` | **不能** | 都取 `active_workspace_id(c)`（L2332/L2362）⇒ 绑**当前空间** |
| `spaces.switch` | 能切，但**会改用户界面所在空间** | 本矩阵把它判 **✗/B3**（§2） |

⇒ **结论**：现在"读指定空间"部分支持（列表/搜索），**"写指定空间"完全不支持**；唯一的路是 `spaces.switch`，而它正是我们判定"会打扰用户"的那一类。

### 11.2 建议：给写工具加可选 `spaceId`，不要用"切空间"当写手段

服务端写入本来就按 `space_id` 落库，"当前空间"只是 **UI 观念** —— 所以技术上完全可以让写操作**直接落到指定空间**，同时**用户界面上的当前空间一动不动**。

- 新增权限档：**「可写（全部空间）」**（内部 id 建议 `write_all`），默认关；其余三档不变；
- 写法：`pages.create` / `blocks.append` / `pages.update` / 后续 `blocks.*` / `files.upload_to_page` 统一加**可选** `spaceId`；省略＝当前空间（行为不变，向后兼容）；
- `pages.get` / `files.*` 同理加 `spaceId`（读跨空间），与列表/搜索口径一致；
- **返回体**里必须回显 `spaceId`（Agent 才能确认落在哪），并进审计；
- ⛔ 不给 Agent `spaces.switch`（它改的是**用户界面**的状态，不是数据）。

### 11.3 判据

1. 带 `spaceId` 写入后：**用户当前空间不变**（`spaces.list.active` 前后一致），目标空间数据确实变了；
2. 缺 `write_all` 档 ⇒ `permission_denied`（⛔ 不许静默当成当前空间）；
3. 省略 `spaceId` 时行为与今天**逐字节一致**（向后兼容判据）；
4. 返回体与审计都带 `spaceId`；
5. `pages.get(id, spaceId)`：id 属于别的空间时**能读到**（需只读跨空间档），不属于任何空间 ⇒ `not_found`（不猜）。

### 11.4 已拍（2026-10-29，owner 选 B）

**开放 `write_all`（可写全部空间），但默认关。**

- 权限档：「只读」/「只读（全部空间）」/「可写（当前空间，默认）」/「**可写（全部空间）**」四档；最后这档**默认关**，需用户在设置里显式打开；
- 写工具统一加**可选 `spaceId`**（省略＝当前空间，行为逐字节不变）；缺 `write_all` 档时带 `spaceId` 写 ⇒ `permission_denied`（⛔ 不许静默回落当前空间）；
- 返回值与审计**必须带 `spaceId`**；
- ⛔ 仍不给 Agent `spaces.switch`（它改的是用户界面所在的当前空间，不是数据）；
- 判据并入 B2：① 带 `spaceId` 写后 `spaces.list.active` 前后不变；② 缺档 `permission_denied`；③ 省略参数行为不变；④ 返回值/审计带 `spaceId`；⑤ `pages.get(id, spaceId)` 跨空间按 id 读（不属于任何空间 ⇒ `not_found`）。
