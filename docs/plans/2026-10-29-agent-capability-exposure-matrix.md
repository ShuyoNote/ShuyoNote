# 方案：把更多 ShuyoNote 能力暴露给外部 Agent —— 能力暴露矩阵（评审稿）

状态：方案待评审（未开始实现）—— 本文只做"暴露多少、暴露到什么权限"的一次性拍板清单，不写代码。

关联：`capabilities/capabilities.json`（能力注册表，**单一事实源**）、`src-tauri/src/mcp_channel.rs`（本机通道：默认关、只绑回环、token 文件、权限位）、`docs/plans/2026-10-29-agent-block-write-p2.md`（块级写面）、`docs/plans/2026-10-29-shuyodoc-m1.md`（导出/导入格式）。

## 0. 原则（先立规矩，再谈清单）

1. **注册表驱动**：能力先写进 `capabilities.json`（`id/kind/scope/permission/desc/mcpDesc/returns`），MCP 才看得见；⛔ 不在 MCP 侧手搓第二套工具表。
2. **三档权限**：`只读` / `读写` / `管理`；按 **空间级** 作用域授予，默认最窄。
3. **写必须可撤回**：`expectedRev` ＋ `dryRun` ＋ 草稿确认（沿用 P2）＋ 审计一条；⛔ 不给"无痕静默写"。
4. **地址稳定**：pageId / blockId / attId / spaceId / dbId / rowId 全暴露；文本匹配只能当兜底。
5. **不暴露危险面**：任意 SQL、任意 HTTP、文件系统路径、密钥/设置写入、批量删除、插件管理。
6. **省 token**：优先"结构 + 增量"（`pages.tree`、`changes_since`），而不是让 Agent 反复拉全文。

## 1. 现有注册表 29 条 × MCP 暴露 × 建议档位

图例：`现` = 已在 MCP（13 个工具覆盖）；`P0` = 只读扩容（先做）；`P1` = 写扩容（P2 块级写之后）；`P2` = 高风险/需专议；`✗` = 不暴露。

| 能力 id | kind | 建议 | 理由（一句话） |
|---|---|---|---|
| pages.list | read | 现 ✓ | 已有 |
| pages.get | read | 现 ✓ | 已有（P1 已加 `rev` + 块锚点） |
| pages.search | read | 现 ✓ | 已有 |
| page.current | read | P0 | 补"当前页"入口，Agent 不必先问 id（⚠️ 只读，不跟随写） |
| blocks.list | read | 现 ✓ | 已有 |
| backlinks.list | read | 现 ✓ | 已有 |
| files.list | read | 现 ✓ | 已有 |
| files.search | read | 现 ✓ | 已有 |
| files.read | read | 现 ✓ | 已有（派生文本） |
| tags.list | read | **P0** | 注册表有、MCP 没暴露；标签是低成本高价值索引 |
| coverage.report | read | **P0** | 让 Agent 知道"哪些内容没进检索面"，避免瞎断言 |
| properties.list | read | **P0** | 属性是数据库/看板的读前门；只读零风险 |
| spaces.list | read | 现 ✓ | 已有 |
| pages.create | write | 现 ✓ | 已有（草稿确认） |
| pages.importMarkdown | write | 现 ✓ | 已有（整页，粗粒度） |
| pages.update | write | 现 ✓ | 已有（整页替换，粗粒度）；**P2 落地后建议降级/收窄** |
| blocks.append | write | 现 ✓ | 已有（尾部追加） |
| tags.add | write | **P1** | 与 `tags.list` 配对；单点写、易审计 |
| properties.set | write | **P1** | 与 `properties.list` 配对；需校验 type 与 attrId |
| editor.insertText | write | **✗** | **即时生效、不进草稿、插入到用户光标处** ⇒ 会干扰正在打字的人，风险最高 |
| files.export | write | **P0 边缘** | 写文件但**要用户点保存**；只允许文本、路径由用户选 ⇒ 可放 P0（带用户确认） |
| spaces.switch | write | **P2** | 会改变用户界面所在的"当前空间"，副作用大；要专议（或干脆不做） |
| kv.get / kv.set / kv.remove | read/write | **✗** | 插件私有数据，与外部 Agent 无关 |
| settings.get | read | **✗** | 同上 |
| user.notify | host | **✗（或 P1 专议）** | 能往用户屏幕弹消息 ⇒ 可做"任务完成通知"，但要防刷屏 |
| log.write | host | **✗** | 插件日志面，外部 Agent 不该写 |

## 2. 需要**新增**的能力（现在注册表里没有，但价值高）

| 新能力 | 档位 | 为什么 | 判据（建议） |
|---|---|---|---|
| `pages.tree` | **P0** | 一次拿空间结构（标题/父子/kind），比 `pages.list` 循环省 token | 与 `pages.list` 的页集合一致；层级与页面树 UI 一致 |
| `changes_since(rev)` | **P0** | 有了 `rev`，Agent 只读"变过的块"（省 token、可轮询） | 同页两次读 rev 相同 ⇒ 空；改一块 ⇒ 只回该块 |
| `db.schema` / `db.rows`（只读） | **P0** | **数据库块现在对 Agent 完全不可见**，这是最大空白 | 列/视图结构可与 UI 对照；分页/过滤在服务端执行 |
| `versions.list` / `version.get` | **P0** | 读历史版本（只读），支撑"改坏了能查" | 历史条数与 UI 一致；读旧版不改现状 |
| `trash.list` | **P0** | 让 Agent 知道页面在回收站、不是丢了 | 与 UI 回收站一致；**⛔ 不给恢复写**（P1 再说） |
| `export.markdown` / `export.docpackage` | **P0** | 导出能力刚做完（`.shuyodoc`），应作为**字节下载句柄**暴露（⛔ 不塞 base64 进上下文） | 导出→再导入往返一致；句柄有 TTL、只本人可用 |
| `blocks.patch / insert / delete` | **P1** | 已有 P2 方案 | 见 P2 文档 7 条判据 |
| `pages.move / pages.rename` | **P1** | 结构整理常用 | 移动后 id 不变、`pages.tree` 反映新父级 |
| `db.rows_write` | **P1** | 写入表格行（按 schema 校验） | 类型/必填校验；写后 rev 变；冲突必拒 |
| `attachment.upload` | **P1** | 附件上传（大小/类型上限） | 内容寻址 sha 一致；不覆盖同名 |

## 3. 分批与验收（每批单独可合入）

| 批次 | 内容 | 判据（批级） |
|---|---|---|
| **B1（只读扩容）** | `tags.list`、`coverage.report`、`properties.list`、`files.export`、新增 `pages.tree` / `changes_since` / `db.schema+db.rows` / `versions.*` / `trash.list` / 导出句柄 | 每条有挂载级判据；**零写路径**改动；`check-capabilities` / `check-agent-surface` / `check-mcp-host-authz` 全绿 |
| **B2（写扩容）** | `tags.add`、`properties.set`、`blocks.patch/insert/delete`、`pages.move/rename`、`db.rows_write`、`attachment.upload` | 全部带 `expectedRev` + `dryRun`；并发冲突必拒；审计一条/次；权限关 ⇒ `permission_denied` |
| **B3（专议）** | `spaces.switch`、`user.notify`、`trash.restore`、`pages.delete`（软删） | 需要 owner 明确"允许 Agent 移动用户视线/通知"的口径 |
| **不做** | `editor.insertText`、`kv.*`、`settings.get`、`log.write`、任意 SQL/HTTP/路径、永久删除 | 写进本文件的"不暴露"清单，防以后有人顺手加 |

## 4. 暴露层的通用机制（B1 就要做，避免每条重复造）

1. **`capabilities.describe` 工具**：返回"当前授权档位 + 可用工具 + 每条一句话 + 版本"，让 Agent 自发现；
2. **权限与空间作用域**：只读/读写分档，`spaceId` 限定；`只读（全部空间）` 单独一档（现有 `pages.search` 已用这个口径）；
3. **审计可读**：`audit.tail`（只读最近 N 条：谁/什么工具/改了哪些 id），让 Agent 能自检、也让用户能追；
4. **限流与体积上限**：每工具每分钟上限、返回体上限、分页强制（⛔ 不给"一次拉全库"）；
5. **错误形状统一**：`{code, message, hint}`，`code` 固定枚举（`rev_conflict` / `permission_denied` / `not_found` / `invalid_args` / `too_large`）。

## 5. 待拍

1. **要不要给 Agent "当前空间之外的只读"**（现有 `只读（全部空间）` 档已存在，是否默认开）？
2. `files.export` 放 P0 可以吗（它要用户点保存，属"半自动"）？
3. `user.notify` 是否允许 Agent 主动弹提示（防刷屏需要限流阈值）？
4. B1 里 `db.schema/db.rows` 的**过滤语法**：沿用界面搜索口径，还是给一套简单 `where`？
