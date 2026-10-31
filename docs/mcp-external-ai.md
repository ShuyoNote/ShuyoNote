# 外部 AI 接入（MCP）配置指南

> 面向用户的**操作手册**：怎么开、怎么选权限、客户端怎么填、怎么验证、出问题怎么查。
> 设计层面的清单（暴露什么能力、什么档、怎么判）见 [plans/2026-10-29-agent-capability-exposure-matrix.md](plans/2026-10-29-agent-capability-exposure-matrix.md)。

## 1. 它是什么

ShuyoNote 内置一个**本机 MCP 通道**：外部 AI 客户端（支持 MCP 的桌面客户端、IDE 插件、脚本）可以通过它**读写你的笔记**。

三条硬边界（设计上固定，不可配）：

1. **默认关**：不开就是完全连不上；
2. **只绑回环** `127.0.0.1`：同网段的设备连不上，出不了本机；
3. **每次会话一个令牌**：令牌从本地文件读，切换档位就换新令牌、旧令牌立刻失效。

## 2. 六个权限档位

设置 →「外部 AI 接入（MCP）」→「外部 AI 权限」：

| 档位（界面名） | 内部 id | 能做什么 | 建议 |
|---|---|---|---|
| 不接 | `off` | 通道关闭 | 平常不用时选它 |
| 只读 | `read` | 读**当前空间**的页面/搜索/块/反链/附件（**附件与历史版本可用 `spaceId` 指定空间**）/当前页/标签/属性定义/页面树/**数据库结构与行**/**历史版本与回收站**/附件元数据/导出下载句柄/**索引覆盖率报告** | 让 AI 总结、问答时够用 |
| 只读（全部空间） | `read_all` | 同上，跨所有空间（加密空间锁着时读不到内容） | 需要跨空间检索时开 |
| 可写（每次确认） | `write_confirm` | 写工具**都先产草稿、等你确认**（含节点整理/回收站恢复/版本回退/标签与属性）；整页替换永远要确认 | **要写就用这个（推荐）** |
| 可写（免确认） | `write_auto` | 所有写操作**直接落库、不询问**；每次写仍留一行审计 | ⚠️ 只在刚备份过、且信任该 AI 时短开 |
| 可写（全部空间） | `write_all` | 上面两档的**全集**：可读写**所有空间**（`write:pages` ＋ `write:all-spaces`，并同时具备 `read:all-spaces`）；写是**免确认**（每次写仍留一行审计）；跨空间写要用它 —— 默认关，只有你显式选这一档才授出 | ⚠️ 最宽的一档：只在"确实要让 AI 改别的空间"时短开，用完切回 |

⚠️ **切档会换新令牌**（旧令牌立刻失效），但**不用重启外部 MCP 客户端** —— 桥**每次调用**
都重新读 `port`/`token` 两个文件（`tools/shuyonote-mcp-rust/src/main.rs` 的 `read_endpoint` ＋ `call_app`），
所以换档/换令牌/端口变化都会被下一次调用自动接上。
**唯一需要重启客户端的情形是"新增了一个 server"**：客户端只在启动（或它自己的重连）时才读 `mcpServers` 配置。

## 3. 配置步骤

### 3.1 应用这边
1. 设置 →「外部 AI 接入（MCP）」；
2. 选一个档位（先 `只读` 验证连通，再考虑 `可写（每次确认）`）；
3. 点「刷新」，状态应显示 **`已打开 · 正在听 127.0.0.1:<端口>`**。

### 3.2 外部客户端这边

**首选：直接从应用面板复制**（**推荐**）—— 面板会把你那台机器上的**真实路径**填好，
令牌**不进片段**，也不用你手写 env：

1. 设置 →「外部 AI 接入（MCP）」→ 权限档位选好 → 点**「复制配置」**；
2. 把复制到的 JSON 粘进客户端的 `mcpServers`（WorkBuddy 是 `~/.workbuddy/mcp.json`；
   Claude Desktop / Cursor / Claude Code / Windsurf / VS Code 的落点在面板里逐条列着，
   ⚠️ **VS Code 的键名是 `servers` 不是 `mcpServers`**，DeepSeek Harness 则是 `cordis.patch.yml` 的 `insert` 一节（YAML））；
3. 客户端是图形应用时**重启它一次**（新增 server 要它重读配置）；之后换档/换令牌**不用再重启**。

面板给的是下面两种形态之一（**默认「随包」**，可切「npx」）：

| 形态 | 片段长什么样 | 要 Node 吗 | 要联网吗 | 什么时候用 |
|---|---|---|---|---|
| **随包（默认）** | `{"mcpServers":{"shuyonote":{"command":"<面板已填好的随包桥路径>"}}}` —— **只有 `command`**，没有 env/args/token | **不要** | **不要** | 装完即用；Rust 桥随安装包发（三个平台各自进了 `bundle.resources`） |
| **npx** | `{"mcpServers":{"shuyonote":{"command":"npx","args":["-y","-p","https://shuyo.cn/mcp/shuyonote-mcp-0.1.0.tgz","shuyonote-mcp"]}}}` | 要 **Node ≥ 20** | 要（首次拉 tgz） | 机器上本来就有 Node、想要"零路径"的人 |

要点：

- **`token` / `port` 两个文件由应用自己写**，**不进配置片段**：面板里令牌默认打码；不要手改、不要复制给别人；
- **端口随会话会变** ⇒ 配置里**别把端口写死**（桥每次调用都重读 `port` 文件）；
- **应用必须开着**（通道只在应用监听时可用；关掉「外部 AI 接入」或退出应用 ⇒ 桥报「通道未开：读不到端口文件」，⛔ 不猜不假装连上）；
- ⚠️ 旧文档里那种 `command: node` ＋ 两个 `env` 的写法**只对"在源码仓库里直接跑 Node 桥"有意义**，
  今天不再需要它（两形态都自带找路径的能力）；确需手写时形如
  `{"command":"node","args":["<仓库>\\tools\\shuyonote-mcp\\index.mjs"],"env":{"SHUYONOTE_MCP_TOKEN_FILE":"…\\mcp\\token","SHUYONOTE_MCP_PORT_FILE":"…\\mcp\\port"}}`，
  默认目录见 [`tools/shuyonote-mcp/README.md`](../tools/shuyonote-mcp/README.md)（Windows `%APPDATA%`／macOS `~/Library/Application Support`／Linux `~/.local/share`）。

## 4. 怎么验证通没通

1. 让 AI **列工具**：应看到 **读面 34 个 / 写面 27 个，共 61 个**——`pages_list` / `pages_get` / `pages_search` / `page_current` / `pages_count` / `pages_tree` / `blocks_list` / `backlinks_list` / `files_list` / `files_search` / `files_read` / `files_stat` / `files_extract_status` / `files_list_orphan` / `files_download` / `blobs_fetch` / `export_markdown` / `export_docpackage` / `coverage_report` / `tags_list` / `properties_list` / `versions_list` / `version_get` / `trash_list` / `spaces_list` / `db_schema` / `db_rows` / `drafts_status` / `audit_tail` / `templates_list` / `space_current` / `changes_since`；切到**可写**档后再多 **27 个写面**（共 **61 个**）：`pages_create` / `pages_update` / `pages_importMarkdown`（旧名保留） / `blocks_append` / `folders_create` / `nodes_move` / `nodes_rename` / `nodes_delete` / `trash_restore` / `pages_revert` / `tags_add` / `tags_remove` / `properties_set` / `properties_unset` / `blocks_patch` / `blocks_insert` / `blocks_delete`（上面只列常用名；**完整 61 条以 `tools/list` 或面板「能力清单」为准**）；
2. 让它读一篇：「列出运营空间最近修改的 3 篇笔记」；
3. 能读出来说明链路通；**被拒**通常说明档位不够（见 §6）；
4. 每次调用都会**记一行审计**（谁/何时/做了什么/成败）。

## 5. 权限 × 工具对照

| 工具 | 需要的档位 |
|---|---|
| `spaces_list`、`pages_list`、`pages_get`、`pages_search`、`pages_count`、`pages_tree`、`tags_list`、`properties_list`、`blocks_list`、`backlinks_list`、`files_list`、`files_search`、`files_read` | 只读及以上 |
| `pages_search` / `pages_list` / `pages_count` / `pages_tree` / `tags_list` / `properties_list` 带 `spaceId`（跨空间） | **只读（全部空间）**及以上（未开该档却带 `spaceId` ⇒ 明确 `permission_denied`，不会悄悄当成当前空间） |
| `page_current`（**没有 `spaceId`**） | 只读及以上；⚠️ 外部接入看不到界面里「当前页」这个状态时**如实回 `opened:false`**（不会编造一页） |
| `db_schema`（数据库的**列/视图/关系列**） | 只读及以上。公式列带 `isFormula:true`、汇总列带 `isRollup:true`，**只标类型、不计算**；带 `spaceId` 跨空间 ⇒ **只读（全部空间）**及以上（未开该档 ⇒ 明确 `permission_denied`，不会悄悄当成当前空间） |
| `db_rows`（数据库**行**） | 只读及以上。`where` 的字段必须来自 `db_schema` 报出的列（id 或列名），操作符白名单 `= != > >= < <= in contains is_null`，写错 ⇒ `invalid_args` 并点名第几条；**只给原始值**（⛔ 不重算公式/汇总，可能与界面计算值不同）；`limit` 默认 100/上限 500；带 `spaceId` 跨空间 ⇒ **只读（全部空间）**及以上（未开 ⇒ `permission_denied`） |
| `versions_list` / `version_get`（历史版本） | 只读及以上。`version_get` 与 `pages_get` 同一套字符分页/块锚点口径；版本不存在 ⇒ `not_found`。**只读，不回滚** | （⚠️ 带 `spaceId` 跨空间需「只读（全部空间）」档；未开 ⇒ `permission_denied` 点名 `read:all-spaces`）
| `trash_list`（回收站） | 只读及以上。只读的**清单**（`deletedAt` 倒序）；⛔ 不恢复、不清空。带 `spaceId` 跨空间 ⇒ **只读（全部空间）**及以上 |
| `files_stat` / `files_extract_status` / `files_list_orphan`（附件元数据） | 只读及以上。`files_stat` 给真 `sha256`；`files_extract_status` 的 `coverage` 是**原始覆盖度**（空 = 未知，⛔ 不等于完整）；`files_list_orphan` 只列**未挂到页面**的附件（只读，不清理） | （⚠️ 带 `spaceId` 跨空间需「只读（全部空间）」档；未开 ⇒ `permission_denied` 点名 `read:all-spaces`）
| `files_download` / `blobs_fetch`（导出/下载句柄） | 只读及以上（需要 `export:files`；只读档已含）。`files_download` **只回句柄不回字节**：句柄 128bit 随机、**单次**、**120 秒**、绑当前会话；`blobs_fetch` 把句柄换成文件，**只写进应用数据目录下的 `exports/`**（文件名会清洗；⛔ **不接受任意目标路径**），sha256 与句柄一致。二次使用/过期/别的会话 ⇒ `not_found`；>10MB ⇒ `needs_confirm`（本批没有确认 UI，不静默下载） | （⚠️ 带 `spaceId` 跨空间需「只读（全部空间）」档；未开 ⇒ `permission_denied` 点名 `read:all-spaces`）
| `export_markdown`（导出 Markdown，**句柄**） | 只读及以上（`export:files`）。两种口径**只能给一个**：`pageId` ⇒ 该页单个 `.md`（与界面「导出为 Markdown」同口径）；`spaceId` ⇒ 整份 `.zip`（Markdown ＋ 附件，与界面「导出本空间」同口径；⚠️ **只支持当前空间**，别的空间 ⇒ `bad_args`）。**只回句柄**（单次/120s/绑会话），落盘用 `blobs_fetch`；>10MB 或 >20 文件 ⇒ `needs_confirm` |
| `export_page_markdown`（单页 Markdown，句柄） | 只读及以上（`export:files`）。只接受 `pageId`（给 spaceId ⇒ `bad_args`）；句柄单次/TTL 120s/绑会话 |
| `export_space_markdown`（整空间 zip，句柄） | 只读及以上（`export:files`）。只接受 `spaceId`（省略=当前空间；给 pageId ⇒ `bad_args`）；本版只支持当前空间 |
| `export_docpackage`（导出 `.shuyodoc`，**句柄**） | 只读及以上（`export:files`）。**只支持单页**（与界面「导出为 .shuyodoc」同一份格式实现：`docPackWriter`）；**只回句柄**，落盘用 `blobs_fetch`；页不存在 ⇒ `not_found`、文件夹 ⇒ `bad_args`、>10MB 或 >20 文件 ⇒ `needs_confirm` |
| `coverage_report`（索引覆盖率报告） | 只读及以上（`read:files`）。**直接回 JSON**（不进句柄表）：`{ok, summary, report}`，与应用内「检查索引覆盖」/AI 面**同一个函数**（唯一实现在 TS）。⚠️ 报告是**当前空间**口径：`spaceId` 只接受当前空间（跨空间 ⇒ `bad_args`）。⚠️ 它经 **Rust→前端桥**算 ⇒ 应用窗口没挂载/忙时会回 `frontend_unavailable` / `frontend_timeout`（见 §7） |
| `drafts_status`（查草稿状态） | 只读及以上。写工具返回 `draftId`；状态 `pending/applied/rejected/expired`（10 分钟未确认 ⇒ expired）；**只回本会话**，别的会话/不存在 ⇒ `not_found` |
| `templates_list`（模板清单） | 只读及以上。`[{templateId,name,title?}]`；空表 ⇒ `[]`；与 `templates_apply` 配对 |
| `space_current`（当前空间） | 只读及以上。`{spaceId,name,pageCount}`（= `spaces_list` 的 active 条）；⛔ 不切换空间 |
| `audit_tail`（最近审计） | 只读及以上。只回**本会话**最近 N 条（默认 20/上限 100）：`{at,tool,capabilityId,ok,code}`；⛔ 不含正文、不回别的会话 |
| `folders_create` / `nodes_move` / `nodes_rename` / `nodes_delete`（**软删**） | 可写；全部**草稿确认**。⚠️ 删**非空节点** ⇒ `bad_args` 并点名 N 个子项（⛔ 不递归删）；`nodes_move` 移到自己的后代下面 ⇒ 拒绝（环检测），返回带 `backlinks` 数；支持 `expectedRev`/`dryRun`/`clientRequestId`；`spaceId` **支持目标空间**（v3 结构类四工具已接；需「可写（全部空间）」档，回滚开关 `SHUYONOTE_MCP_CROSS_SPACE_WRITE=0` 可一键关） |
| `trash_restore`（从回收站恢复） | 可写；草稿确认。活着的节点 ⇒ `bad_args`（不需要恢复）；不存在 ⇒ `not_found` |
| `pages_revert`（回退到历史版本） | 可写；草稿确认。**只能回退到仍在版本历史里的版本**（超出保留期/已清理 ⇒ `not_found`）；⛔ 不删原写审计 |
| `tags_add` / `tags_remove` / `properties_set` / `properties_unset` | 可写；草稿确认。目标页不存在 ⇒ `not_found`；标签/属性不存在 ⇒ `not_found`；数字属性给非数字 ⇒ `bad_args` |
| `blocks_patch` / `blocks_insert` / `blocks_delete`（块级写） | 可写；草稿确认（`mediate:"draft"`）。按**顶层块 id** 寻址；`patch` 后**块 id 不变**；`insert` 返回 `newBlockId`（确认后即可继续用）；`delete` 不留空块、不许删最后一个块。`expectedRev` 不一致 ⇒ `rev_conflict` **带 currentRev ＋ 当前 markdown（带块锚点）**；`dryRun` 只演练；`clientRequestId` 幂等 |
| `files_move` / `files_rename` / `files_delete`（附件写） | 可写；草稿确认。`files_delete` **先做正文引用检查**：正文仍按 `attachment://<sha>` 引用 ⇒ `bad_args` 并点名页面（⛔ 不静默删）；`expectedSha` 可选，不一致 ⇒ `rev_conflict` |
| `files_upload_to_page`（受控上传） | 可写；草稿确认。⚠️ **确认后由用户亲自在系统文件选择框里选文件**（⛔ Agent 不能给路径）；同名自动 `-N` 不覆盖；>10MB ⇒ `needs_confirm`；取消 ⇒ `cancelled` |
| `import_docpackage`（导入 .shuyodoc） | 可写；草稿确认。**用户亲自选文件**；**永远新建、不覆盖**；坏包 ⇒ 错误原文（点名条目）；取消 ⇒ `cancelled` |
| `files_detach`（摘除附件、保留文件） | 可写；草稿确认。`page_id = NULL` ⇒ 变未整理（`files_list_orphan` 可见、页清单不可见）；sha/字节不变；已未整理 ⇒ `bad_args` |
| `templates_apply`（模板建页） | 可写；草稿确认。永远**新建**、⛔ 不覆盖；模板不存在 ⇒ `not_found` |
| `pages_create`、`blocks_append`、`pages_importMarkdown` | `可写（每次确认）`及以上 |
| `pages_update`（整页替换） | `可写（每次确认）`：会先弹确认 |

### 5.1 两处「如实失败」的读取口径（别当成空数据）

| 情形 | 现在的行为 |
|---|---|
| `pages_get` 的页不存在（或目标页不在**当前空间/给定 `spaceId`** 的空间里） | 回**结构化 `not_found`**（点名页 id 与空间），**不再返回 `null`** —— 所以"页不存在"和"页是空的"从此可分辨 |
| `pages_search` 的命中数超过 `limit` | 信封里带 **`truncated: true`**（与 `changes_since` 同一口径）⇒ `matched` 是**本次返回条数**，不是命中总数；`truncated` 为 true 时请放宽 `limit` 或换更短的词 |

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 列出 **0 个工具** | 通道没开（档位＝不接）、或客户端读不到 `token`/`port` 文件、或改完配置没重启客户端 |
| `连不上 App 的通道（127.0.0.1:xxxx）：fetch failed` | 应用已退出/通道关闭；重新打开「外部 AI 接入」并点刷新（端口可能已变） |
| `permission_denied` | 档位不够（例如只读档调用写工具）；**升级档位即可，不用重启客户端**（桥每次调用重读令牌，见 §2） |
| 刚切档后旧客户端报 401/未授权 | 正常：切档会换令牌，旧令牌立即失效；**下一次调用会自动用新令牌**（不用重启）。若客户端只是在启动时读了一次配置，可让它重连一次 |
| 读不到某个空间的内容 | 空间被加密且当前会话未解锁；或用了「只读（当前空间）」但目标是别的空间 |
| 端口和我记的不一样 | 端口每次会话可能不同；**永远从 `port` 文件读**，别写死 |
| 写入没经过我确认 | 档位是「可写（免确认）」（`write_auto`）：直接落库、只留审计。要确认就切「可写（每次确认）」 |
### 6.10 超限需在应用内确认一次

**`files.download` 的超限（>10MB）**：能力层立即返回 `needs_confirm`（带 `needsConfirm=true thresholdBytes`），并**异步**发一条前端确认事件（不等待回执 ⇒ **不影响桥 5s 超时语义**）；用户在应用内点「允许一次」⇒ 前端调桌面命令 `mcp_download_grant` 写**一次性额度**（attId|space、TTL 5 分钟、**进程内存，重启即丢**）⇒ Agent 重试同一请求才拿到句柄（额度用一次即作废）；拒绝/过期仍 `needs_confirm`。`<= 阈值` 不发事件、行为不变。

导出/下载超过 `10MB` 或 `20 个文件` 时，**不会静默截断/执行**：前端桥弹确认框（`允许一次`/`拒绝`），允许后发一张**内存一次性额度**（TTL 5 分钟、只对同一请求类型＋同一目标有效）⇒ Agent **重试同一请求**才通过；额度过期/拒绝仍返回 `needs_confirm`。MCP 错误文本含 `needsConfirm=true thresholdBytes / thresholdFiles`，Agent 可据此提示用户到应用里确认一次。阈值本身未改；上传类仍 unsupported（见 §7）。

## 7. 安全与数据边界（务必先读）

- **本地通道**：只绑 `127.0.0.1`，`Origin`/`Host` 必须恰好回环；同网段设备不可达；
- **令牌**：会话级、从本地文件读、权限位最小化；**不要**把 `token` 文件内容贴进任何聊天或配置共享；
- **数据边界**：笔记本体仍在你的本机，ShuyoNote **不上传**；但**外部 AI 读到什么由它决定**——云端模型收到内容后，这部分内容就离开了本机；
- **免确认档的风险**：AI 的写操作不询问直接落库；可撤销的手段是**历史版本/回收站/审计**（写坏了先看历史，不要靠"再让 AI 改回来"）；
- **导出/下载走句柄**：这类工具**只回句柄、不回字节**（句柄 128bit 随机、单次、120 秒、绑当前会话）；`blobs_fetch` 把句柄换成文件，**只落进应用数据目录下的 `exports/`**（文件名已清洗，**不接受任意目标路径**），落盘前复核 sha256。⛔ 别把 `exports/` 当成"给 AI 的任意写盘口子"；
- **三条「前端桥」能力**（`export_markdown` / `export_docpackage` / `coverage_report`）：它们**唯一实现在前端**（Markdown/`.shuyodoc` 渲染、抽取器注册表），Rust 只负责**把请求转给应用窗口、等它算完**（默认 **5 秒**超时，**不重试、不缓存**）。失败**分型**且**都带原因**：`frontend_unavailable`（应用没开/窗口没挂载 ⇒ **立刻**返回，⛔ 不空等 5 秒）/ `frontend_timeout`（窗口在、已就绪，但 5 秒内没回）。**把事件送出去这一步也不吞错** —— 送不出去按 `frontend_unavailable` 如实报，不会伪装成超时。这是**如实失败**，不是"空成功"；等窗口可用后重试即可。⛔ 桥不会执行任意前端代码（方法白名单固定三条）；
- **AI 不可见空间**（设置 →「外部 AI 接入」里的多选清单）：勾上的空间对**外部 AI 面**整体遮蔽 —— 读、写、跨空间一律 `permission_denied` 并点名「AI 不可见」；`spaces_list` 会过滤掉它们，**当前空间被勾上时连不带 `spaceId` 的调用也拒绝**。清单存本机 `meta.db`（**不随设备同步，换机要重配**）；**清空即恢复**。⚠️ **它是 AI 面的遮罩，不是权限、不是加密** —— 用户自己在界面里读写不受影响，加密空间仍按加密规则（锁着就看不到）。所以"`read:all-spaces` 能读你所有空间"这句要加限定：**被遮罩的空间读不到**；
- **审计的保留口径**：每次调用记一行（谁/何时/哪个能力/成败/错误码，⛔ 不含正文）。`audit_tail` 读的是**进程内最近 500 条**的环（超了丢最老的），同时逐行追加到应用数据目录的 `plugin-audit.jsonl`（**重启不丢**）。⇒ 说"每一次都能查到"要加限定：**跨过 500 条的旧记录只能在 jsonl 里翻**，不是无限期在线可查；`dryRun` 不写审计；
- **写一致性与幂等**：所有写工具都是**草稿确认**（不经你确认不落库）；支持 `expectedRev`（`updated_at:sha8`，与 `pages.get` 的 `rev` 同一形态）——不一致 ⇒ `rev_conflict`（带当前 rev，⛔ 不覆盖）；`dryRun:true` 只回"会做什么"（不产草稿、不记审计）；`clientRequestId` 同 id 重复调用只落一次、只审一条（进程内 10 分钟）；
- **跨空间写（v3 白名单 22 条写面）**：带 `spaceId` 时**写到目标空间**（不是"搬到目标空间"）—— 附件类（`files.move/rename/delete/detach/upload_to_page`）、结构类（`nodes.move/rename/delete`、`folders.create`）、标签/属性类（`tags.add/remove`、`properties.set/unset`）、db 行/回收站/回退类（`db.rows_write/delete`、`trash.restore`、`pages.revert`）以及 `pages.create`/`pages.update`/`blocks.append/patch/delete` 均已接。需要「可写（全部空间）」档；目标空间**锁着/打不开** ⇒ `permission_denied`（含 locked）；`pageId`/`parentId`/`toPageId` 等**必须属于目标空间**（否则 `not_found`/`bad_args`，⛔ 不回落当前空间）；目标空间的 `changes`＋审计（带 `spaceId`）照写；回滚开关 `SHUYONOTE_MCP_CROSS_SPACE_WRITE=0`；**未接的写工具**带 `spaceId` 仍 `bad_args: … 暂不支持跨空间`；
- **块级写的边界**：`blocks_*` 只动**顶层块**（不做整篇锚点对齐、不做嵌套块编辑）；`applied` 在调用时**永远是 false** —— 写能力都是草稿确认，用户确认后才落库；`rev_conflict` 里的 markdown 由应用窗口算（窗口没开时退回正文带锚点，如实说明）；
- **附件与模板写的边界**：`files_delete` 不做静默删除（正文仍引用 ⇒ 拒绝并点名）；`files_upload_to_page` / `import_docpackage` **已实现**（受控入口：⛔ Agent 不接受任意路径，确认草稿后由**用户亲自在系统文件选择框选文件**）；`db_rows_write/delete` **已实现**（2026-10-30 跨空间批：目标空间校验 ＋ 草稿确认）；
- **上传/导入走系统文件选择框**：`files_upload_to_page` / `import_docpackage` **不接受 Agent 传的任何路径**，确认草稿后由**用户亲自选文件**；用户取消 ⇒ `cancelled`（不静默成功/失败）；>10MB 上传 ⇒ `needs_confirm`。
- **企业版**：团队/租户空间的 Agent 写面临时**不在本指南范围**（身份、角色、审计合规、数据边界四问未定，见能力矩阵 §8）。

## 8. 推荐配置（一句话版）

- **日常**：`只读`；
- **跨空间检索**：临时切 `只读（全部空间）`；
- **让 AI 改笔记**：`可写（每次确认）`；
- **免确认**：仅"刚备份 + 本机可信 Agent + 用完就切回"。

## 9. 还没接的（会改变本指南的地方）

> 下面只列**今天确实还没接**的；已落地的不再留在这里（块级写面 P2、只读扩容 B1a–B1c 都已进面，见 §5）。

- **整空间导出跨空间**：`export_space_markdown` / `export_markdown` 的 `spaceId` 形态**只支持当前空间**（别的空间 ⇒ `bad_args` 点名）；单页导出（`export_page_markdown` / `export_docpackage`）已支持目标空间；
- **企业版 Agent 写面**：团队/租户空间暂不在本指南范围（见 §7 末条）；
- 清单与档位判据：[能力暴露矩阵](plans/2026-10-29-agent-capability-exposure-matrix.md)；块级写方案：[P2 方案](plans/2026-10-29-agent-block-write-p2.md)（**已落地**，留作设计出处）。

## 10. 版本

- 2026-10-31：**按实测反馈对账（WorkBuddy 会话记录指出 8 处过期/缺失）**：① 权限档位 **五个 → 六个**（补「可写（全部空间）」＝免确认 ＋ 每次写留审计）；② **切档/换令牌不用重启客户端**（Rust 桥每次调用重读 `port`/`token`；只有新增 server 首次要重启客户端）；③ §3.2 改为「**面板复制**」为首路径，并列 **随包（零 Node/零 env）** 与 **npx（Node ≥20 ＋联网）** 两形态，并写明**应用必须开着**；④ 跨空间写白名单 **22 条写面**（v3-A1–A4，含结构/标签属性/db 行/回收站/回退/附件）；⑤ `pages_get` 对不存在页/跨空间失配 ⇒ **结构化 `not_found`**（不再返回 `null`）；⑥ `pages_search` 信封补 **`truncated`**（命中被 `limit` 截断时为 true）；⑦ 前端桥失败**分型**：`frontend_unavailable`（带原因、立刻返回）/ `frontend_timeout`，**事件出口不再吞错**；⑧ §7 补「**AI 不可见空间**」与「审计＝进程内 500 条环 ＋ 落盘 `plugin-audit.jsonl`」两句，§9 改为只列仍未接的项。

- 2026-10-30：**export 跨空间 v1 —— 单页导出支持**（`apiVersion` 1.23.0）：`export_page_markdown`/`export_docpackage` 可带 `spaceId` 导出目标空间单页（需 `read:all-spaces`；只读（全部空间）档可用）；前端桥通过 `getPage/listPageAttachments/readAttachmentBytes` 的 `spaceId` 读目标空间；句柄仍单次/TTL 120s/绑会话、落盘走 `blobs_fetch` 固定 exports 目录。⚠️ **整空间导出仅支持当前空间**（跨空间 v1 未接，`bad_args` 点名）；加密空间锁着 ⇒ 明确失败。

- 2026-10-30：**跨空间写 v3-A4 —— db 行/回收站/回退四工具**（`apiVersion` 1.27.0）：`db_rows_write/db_rows_delete/trash_restore/pages_revert` 支持 `spaceId`（白名单 18→22）；`pageId`/`rowIds`/`versionId` 必须属于目标空间（否则 `not_found`/`bad_args`，不回落）；读校验（DB 页/列/版本归属/rev）全部走目标空间；命令 `restore_page`/`restore_version` 加 `spaceId`、目标空间 `changes`/审计；**同时修正 apply 的 snake_case 传参**（`savePage/setPageProp/movePage/createFolder/db 行` 之前用 `spaceId` 键，serde 会忽略 ⇒ 跨空间实际落到当前空间；现统一 `space_id`）。其余写工具仍 unsupported。

- 2026-10-30：**跨空间写 v3-A3 —— 标签/属性四工具**（`apiVersion` 1.26.0）：`tags_add/tags_remove/properties_set/properties_unset` 支持 `spaceId`（白名单 14→18）；`pageId` 必须在目标空间（否则 `not_found`）；标签名/属性定义按目标空间解析；目标空间命令内核（`add_tag_in`/`remove_tag_in`/`set_page_prop_impl`/`remove_page_prop_impl`）；审计 `spaceId`、回滚开关同一处。

- 2026-10-30：**跨空间写 v3-A2 —— 结构类四工具**（`apiVersion` 1.25.0）：`nodes_move`/`nodes_rename`/`nodes_delete`/`folders_create` 支持 `spaceId`（白名单 10→14）；目标空间可写连接＋`live_target_in`/`check_expected_rev_in` 同源校验；`parentId` 必须在目标空间（否则 `bad_args`/`not_found`，不回落）；非空文件夹删除仍拒；目标空间 `changes`、审计 `spaceId`；其余 unsupported。

- 2026-10-30：**跨空间写 v3-A1 第四项 —— `files_detach` 支持目标空间**（`apiVersion` 1.22.0）：`files.rename/delete/move/detach` 已支持跨空间；detach 只把目标空间附件的 `page_id` 置 NULL，**保留字节**（sha/大小不变）；已未整理再次 detach ⇒ `bad_args`；目标空间 `changes`/审计 `spaceId`；其余 unsupported。

- 2026-10-30：**跨空间写 v3-A1 第三项 —— `files_move` 支持目标空间**（`apiVersion` 1.21.0）：`files.rename`/`files.delete`/`files.move` 已支持跨空间；move 只允许把附件移到**同一目标空间内**的活页（`toPageId` 跨空间/不存在 ⇒ `bad_args`，不回落）；目标空间写 `changes`、审计带 `spaceId`；其余写工具仍 `bad_args: 暂不支持跨空间`。

- 2026-10-30：**跨空间写 v3-A1 扩展 —— `files_delete` 支持目标空间**（`apiVersion` 1.20.0）：`files.rename`/`files.delete` 已支持跨空间；**引用保护语义**：删除前扫**目标空间之外的所有空间**（页正文 `attachment://sha` 与同 hash 附件行），命中 ⇒ `bad_args` 点名空间/页面；**任一空间打不开/锁着 ⇒ 拒绝删除**（无法确认引用，宁留勿删）；通过后才删行/释放字节；目标空间写 `changes`、审计带 `spaceId`。其余写工具仍 `bad_args: 暂不支持跨空间`。

- 2026-10-30：**跨空间写 v3-A1 —— `files_rename` 支持目标空间**（`apiVersion` 1.19.0）：`rename_attachment` 抽出 `rename_attachment_in(c,…)` 单连接实现；命令/能力/apply 都传 `spaceId`；只允许改**目标空间内**的附件（不在该空间 ⇒ `not_found` 点名）；目标空间写 `changes`；审计带 `spaceId`；仍受回滚开关与 `write:all-spaces` 门约束。v3 其余类别（move/delete/detach/结构/标签/属性/db/回收站等）尚未支持，带 `spaceId` 仍 `bad_args: 暂不支持跨空间`。

- 2026-10-30：**AI 不可见空间清单（apiVersion 1.18.0）**：设置面板新增「AI 不可见空间」多选；清单存本机 `meta.db`（**不随设备同步，换机要重配**）；勾选后 AI 面（`ai:true`）读写该空间 ⇒ `permission_denied: 空间「X」在 AI 不可见清单里（AI 不可见）`，`spaces_list` 过滤隐藏空间，当前空间被隐藏时连不带 `spaceId` 的调用也拒绝；用户自己不受影响；**隐藏 ≠ 加密**（加密空间仍按加密规则不可见）。清空清单即恢复；`SHUYONOTE_AI_HIDDEN_SPACES=off` 可临时跳过判断。

- 2026-10-30：**跨空间写 v2 —— `write_all` 扩读 ＋ `pages_update`/`blocks_append/patch/delete` 可改目标空间**：`write_all` 档 granted ＝ `write:pages`＋`write:all-spaces`＋`read:pages`＋`read:all-spaces`（默认关；开这档 AI 能读所有空间，加密空间内容仍不可见）；新增 `pages_get`/`blocks_list` 的 `spaceId`；v2 白名单 5 条写工具（create/update/blocks.append/patch/delete）由 `apply.ts` 在取回目标页后合并、经命令 `spaceId` 写到目标空间（不复制合并逻辑）；其余写工具带 `spaceId` 仍 `bad_args: 暂不支持跨空间`。目标锁着 ⇒ `permission_denied`（locked）；审计带 `spaceId`；回滚开关同时生效。`apiVersion` 1.16.0 → **1.17.0**。

- 2026-10-30：**跨空间写 v1 —— `pages_create` 可写入指定空间**：`write:all-spaces` 档（默认关）下，`pages_create` 带 `spaceId` ⇒ 在目标空间新建页面（同一处写 `pages`＋`changes`，目标空间设备能同步到）；**当前空间完全不变**（不切空间、不写当前空间）。跨空间 v1 **只支持这一条工具**：其它带 `spaceId` 的写工具 ⇒ `bad_args: … 暂不支持跨空间`（⛔ 不回落当前空间）；目标空间**锁着/打不开** ⇒ `permission_denied`（含 locked）；回滚开关 `SHUYONOTE_MCP_CROSS_SPACE_WRITE=0` ⇒ 立即恢复拒绝。审计行带 `spaceId`。`apiVersion` 1.15.0 → **1.16.0**。

- 2026-10-30：**P2 能力补齐 —— 工具 60 → 61（读面 33 → 34 / 写面 27）**：① `audit_tail` 加可选 `onlyWrites`（默认 false；true 只回 `kind:"write"` 的调用；面板最近审计固定用 true）；② 新读能力 `pages.changes_since` → 工具 `changes_since({since, spaceId?, limit?})`：按 `pages.updated_at > since` 返回 `{pages:[{pageId,title,rev,updatedAt,kind}],truncated}`（limit 默认 50/上限 200；**v1 只给页级**，要知道改了什么请对 pageId 再调 `pages_get`）；跨空间口径同 `pages_list`；③ 新增 `src-tauri/src/cap_limits.rs` 收敛 200KB/分页/句柄 TTL 等限额，能力层改为引用常量。`apiVersion` 1.14.0 → **1.15.0**。

- 2026-10-30：**P1 设置面板「接入面板」六块 ＋ 第六档「可写（全部空间）」**：面板分六块（档位／状态卡／能力清单／最近草稿／最近审计／边界提示）；能力清单与「这一档能做什么」都**从注册表 ai:true 实时算**（⛔ 不手写会漂的句子）。第六档 `write_all` 授予 `write:pages` ＋ `write:all-spaces`（默认关；`read:all-spaces` 不随之给），切档换令牌语义不变。新增两个只读桌面命令：`mcp_recent_drafts(limit)`（最近草稿，默认 5/上限 50；只列**外部接入**会话）与 `mcp_recent_audit(limit)`（最近审计，默认 20/上限 100；本机视角）。⛔ 本版只放行 `write_all` 的**权限门**，跨空间落库链路（前端 apply 切空间）下一版才接 —— 带 `spaceId` 跨空间写会得到 `bad_args` 而不是 `permission_denied`。`apiVersion` 1.13.0 → **1.14.0**。

- 2026-10-30：**UX-④ 附件/历史版本可指定空间**：`files_list/search/read/stat/extract_status/list_orphan/download` 与 `versions_list/version_get` 增加可选 `spaceId`（逐 cap 走 `with_conn_for_space`，跨空间需「只读（全部空间）」档）；省略参数行为不变。`apiVersion` 1.12.0 → **1.13.0**。

- 2026-10-30：**UX-⑦ 导出拆名 —— 工具 60（读面 33 / 写面 27）**：新增 `export_page_markdown`（只接受 pageId）与 `export_space_markdown`（只接受 spaceId，省略=当前空间）；旧 `export_markdown` 保留并标 `deprecated`，行为不变。

- 2026-10-30：**UX-⑤ 命名统一 —— 工具 58（读面 31 / 写面 27）**：新增 `pages_import_markdown`（能力 `pages.import_markdown`，与旧 `pages.importMarkdown` **同一能力、行为一致**）；旧名保留并标 `deprecated`（外部客户端不崩）。`apiVersion` 仍 1.12.0。

- 2026-10-30：**UX-③ 当前空间 —— MCP 工具 57（读面 31 / 写面 26）**：新增 `space_current`（`space.current`，read:pages）→ `{spaceId,name,pageCount}`，与 `spaces_list` 的 active 一致，⛔ 不切换空间。

- 2026-10-30：**UX-② 模板清单 —— MCP 工具 55 → 56（读面 29 → 30 / 写面 26）**：新增 `templates_list`（`templates.list`，read:pages）→ `[{templateId,name,title?}]`，空表 `[]`，与 `templates_apply` 配对。`apiVersion` 仍 1.12.0（同批累积）。

- 2026-10-30：**UX-① 写闭环 —— MCP 工具 51 → 56（读面 29 / 写面 26）**：全部写工具返回 `draftId`（`dryRun` 不生成）；新增 `drafts_status`（pending/applied/rejected/expired，**只回本会话**）与 `audit_tail`（本会话最近 N 条，⛔ 不含正文）。apply 侧确认/拒绝后回写状态（新桌面命令 `mcp_draft_state`）。`apiVersion` 1.11.0 → **1.12.0**。

- 2026-10-29：**B2-补遗-1（受控上传通道）—— MCP 工具 48 → 51（读面 27 / 写面 24）**：新增 `files_upload_to_page`（**用户亲自在系统文件选择框选文件**；同名 `-N`；>10MB ⇒ `needs_confirm`；取消 ⇒ `cancelled`）、`import_docpackage`（用户选 `.shuyodoc`，复用 M1 读包，**永远新建**）、`files_detach`（`page_id=NULL`、保留字节，新增命令 `detach_attachment`）。`apiVersion` 1.9.0 → **1.10.0**。

- 2026-10-29：**附件与模板写 —— MCP 工具 44 → 48（读面 27 / 写面 21）**：新增 `files_move` / `files_rename` / `files_delete`（**正文引用检查**：仍被 `attachment://<sha>` 引用 ⇒ 拒绝并点名页面）与 `templates_apply`（模板建页、永远新建）。全部草稿确认；`expectedSha`/`dryRun`/`clientRequestId` 沿用同一口径。`apiVersion` 1.8.0 → **1.9.0**。⚠️ `files_upload_to_page` / `import_docpackage` / `db_rows_write` / `db_rows_delete` **本批未做**（缺受控字节通道 / 数据库行写命令），见报告降级。

- 2026-10-29：**块级写 B2-块 —— MCP 工具 41 → 44（读面 27 / 写面 17）**：新增 `blocks_patch`（整块替换，**块 id 不变**）、`blocks_insert`（在某块后插入，返回 `newBlockId`）、`blocks_delete`（删顶层块，不留空块）。全部草稿确认（`mediate:"draft"`）；`expectedRev` 不一致 ⇒ `rev_conflict` **带 currentRev ＋ 当前 markdown（带锚点）**；`dryRun`/`clientRequestId` 与 B2-结构同一条口径。`apiVersion` 1.7.0 → **1.8.0**。

- 2026-10-29：**写扩容 B2-结构 —— MCP 工具 31 → 41（读面 27 / 写面 14）**：新增 `folders_create`、`nodes_move`、`nodes_rename`、`nodes_delete`（软删；非空 ⇒ 拒绝并点名 N，⛔ 不递归删）、`trash_restore`、`pages_revert`（只能回退到仍在版本历史里的版本）、`tags_remove`、`properties_unset`；同时把既有的 `tags_add` / `properties_set` 一并进写面。全部 `mediate:"draft"`（落库仍只有 `ai/apply.ts` 一处）；写一致性：`expectedRev` / `dryRun` / `clientRequestId`（幂等，同 id 只落一次、只审一条）。`apiVersion` 1.6.0 → **1.7.0**。
- 2026-10-29：**前端桥（B3）—— MCP 工具 28 → 31（读面 24 → 27，写面 4）**：新增 `export_markdown`（`pageId` ⇒ 单页 `.md`；`spaceId` ⇒ 整空间 zip 含附件；⚠️ 整空间只支持当前空间）、`export_docpackage`（单页 `.shuyodoc`）、`coverage_report`（索引覆盖率报告，直接回 JSON）。三条**唯一实现都在 TS**，经 **Rust→前端桥**取回（方法白名单 3 条、默认 **5 秒**超时；前端没挂载 ⇒ 立刻 `frontend_unavailable`，挂着不回 ⇒ `frontend_timeout`，⛔ 不挂死、不空成功）；两个导出**复用 B1c 的同一张句柄表**（单次/TTL 120s/绑会话，落盘仍只经 `blobs_fetch` → `exports/`）。`coverage_report` 从「M1 时因 `host:"frontend"` 不许进 MCP 面」**改判为正式进面**（`apiVersion` 1.5.0 → **1.6.0**）。
- 2026-10-29：只读扩容（B1c）—— MCP 工具 **20 → 28**（读面 24 / 写面 4）：新增 `versions_list` / `version_get`（历史版本，`version_get` 与 `pages_get` 同口径、**只读不回滚**）、`trash_list`（回收站清单，⛔ 不恢复/不清空）、`files_stat`（附件元数据，含真 `sha256`）、`files_extract_status`（单文件抽取完整度，覆盖度原样透出：未知 ≠ 完整）、`files_list_orphan`（未挂到页面的附件），以及**导出/下载句柄** `files_download` / `blobs_fetch`（只回句柄不回字节：128bit 随机、**单次**、**TTL 120 秒**、绑会话；`blobs_fetch` 只落进应用数据目录的 `exports/`，文件名清洗、**不接受任意路径**、sha256 复核；>10MB ⇒ `needs_confirm`）。`apiVersion` 1.4.0 → **1.5.0**。
- 2026-10-29：只读扩容（B1b）—— MCP 工具 **18 → 20**（读面 16 / 写面 4）：新增 `db_schema`（数据库的列/视图/关系列；公式列 `isFormula:true`、汇总列 `isRollup:true`，**只标类型不计算**）与 `db_rows`（行数据，**只给原始值**，⛔ 不重算公式/汇总；简单 `where` 白名单 ＋ `limit`/`offset` 分页在宿主侧执行，响应体超 200 KB 如实标 `truncated`）。`apiVersion` 1.3.0 → **1.4.0**。
- 2026-10-29：只读扩容（B1a）—— MCP 工具 **13 → 18**（读面 14 / 写面 4）：新增 `page_current`、`pages_count`、`tags_list`、`properties_list`、`pages_tree`（一次给出整棵空间树，超限如实标 `truncated`）。`coverage_report` **仍不在** MCP 面上（它是应用内 AI 宿主能力，接 MCP 需要前端桥，留待后续）。`apiVersion` 1.2.0 → **1.3.0**。
- 2026-10-29：首版（配合 `pages_get` 的 `rev`＋块锚点、`.shuyodoc` 导出导入落地后的对外说明）。
