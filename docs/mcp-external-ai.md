# 外部 AI 接入（MCP）配置指南

> 面向用户的**操作手册**：怎么开、怎么选权限、客户端怎么填、怎么验证、出问题怎么查。
> 设计层面的清单（暴露什么能力、什么档、怎么判）见 [plans/2026-10-29-agent-capability-exposure-matrix.md](plans/2026-10-29-agent-capability-exposure-matrix.md)。

## 1. 它是什么

ShuyoNote 内置一个**本机 MCP 通道**：外部 AI 客户端（支持 MCP 的桌面客户端、IDE 插件、脚本）可以通过它**读写你的笔记**。

三条硬边界（设计上固定，不可配）：

1. **默认关**：不开就是完全连不上；
2. **只绑回环** `127.0.0.1`：同网段的设备连不上，出不了本机；
3. **每次会话一个令牌**：令牌从本地文件读，切换档位就换新令牌、旧令牌立刻失效。

## 2. 五个权限档位

设置 →「外部 AI 接入（MCP）」→「外部 AI 权限」：

| 档位（界面名） | 内部 id | 能做什么 | 建议 |
|---|---|---|---|
| 不接 | `off` | 通道关闭 | 平常不用时选它 |
| 只读 | `read` | 读**当前空间**的页面/搜索/块/反链/附件/当前页/标签/属性定义/页面树 | 让 AI 总结、问答时够用 |
| 只读（全部空间） | `read_all` | 同上，跨所有空间（加密空间锁着时读不到内容） | 需要跨空间检索时开 |
| 可写（每次确认） | `write_confirm` | 新建/追加直接写；**整页替换会先问你** | **要写就用这个（推荐）** |
| 可写（免确认） | `write_auto` | 所有写操作**直接落库、不询问**；每次写仍留一行审计 | ⚠️ 只在刚备份过、且信任该 AI 时短开 |

⚠️ **切档会换新令牌** ⇒ 切完必须**重启外部 MCP 客户端**（它在启动时才读令牌文件）。

## 3. 配置步骤

### 3.1 应用这边
1. 设置 →「外部 AI 接入（MCP）」；
2. 选一个档位（先 `只读` 验证连通，再考虑 `可写（每次确认）`）；
3. 点「刷新」，状态应显示 **`已打开 · 正在听 127.0.0.1:<端口>`**。

### 3.2 外部客户端这边（以通用 `mcpServers` 配置为例）
```json
{
  "mcpServers": {
    "shuyonote": {
      "command": "node",
      "args": ["<仓库路径>\\tools\\shuyonote-mcp\\index.mjs"],
      "env": {
        "SHUYONOTE_MCP_TOKEN_FILE": "%APPDATA%\\cn.shuyo.shuyonote\\mcp\\token",
        "SHUYONOTE_MCP_PORT_FILE": "%APPDATA%\\cn.shuyo.shuyonote\\mcp\\port"
      }
    }
  }
}
```

要点：
- **`token` / `port` 两个文件由应用自己写**：不要手改、不要复制给别人；
- **端口随会话会变** ⇒ 配置里写的是**文件路径**，别把端口写死；
- 客户端若是图形应用，改完配置需要**重启**（或让它重连 MCP 服务）。

## 4. 怎么验证通没通

1. 让 AI **列工具**：应看到 **读面 14 个**——`pages_list` / `pages_get` / `pages_search` / `page_current` / `pages_count` / `pages_tree` / `blocks_list` / `backlinks_list` / `files_list` / `files_search` / `files_read` / `tags_list` / `properties_list` / `spaces_list`；切到**可写**档后再多 **4 个写面**（共 **18 个**）：`pages_create` / `pages_update` / `pages_importMarkdown` / `blocks_append`；
2. 让它读一篇：「列出运营空间最近修改的 3 篇笔记」；
3. 能读出来说明链路通；**被拒**通常说明档位不够（见 §6）；
4. 每次调用都会**记一行审计**（谁/何时/做了什么/成败）。

## 5. 权限 × 工具对照

| 工具 | 需要的档位 |
|---|---|
| `spaces_list`、`pages_list`、`pages_get`、`pages_search`、`pages_count`、`pages_tree`、`tags_list`、`properties_list`、`blocks_list`、`backlinks_list`、`files_list`、`files_search`、`files_read` | 只读及以上 |
| `pages_search` / `pages_list` / `pages_count` / `pages_tree` / `tags_list` / `properties_list` 带 `spaceId`（跨空间） | **只读（全部空间）**及以上（未开该档却带 `spaceId` ⇒ 明确 `permission_denied`，不会悄悄当成当前空间） |
| `page_current`（**没有 `spaceId`**） | 只读及以上；⚠️ 外部接入看不到界面里「当前页」这个状态时**如实回 `opened:false`**（不会编造一页） |
| `pages_create`、`blocks_append`、`pages_importMarkdown` | `可写（每次确认）`及以上 |
| `pages_update`（整页替换） | `可写（每次确认）`：会先弹确认 |

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 列出 **0 个工具** | 通道没开（档位＝不接）、或客户端读不到 `token`/`port` 文件、或改完配置没重启客户端 |
| `连不上 App 的通道（127.0.0.1:xxxx）：fetch failed` | 应用已退出/通道关闭；重新打开「外部 AI 接入」并点刷新（端口可能已变） |
| `permission_denied` | 档位不够（例如只读档调用写工具）；升级档位后**重启客户端**（令牌已换） |
| 刚切档后旧客户端报 401/未授权 | 正常：切档会换令牌，旧令牌立即失效 ⇒ 重启客户端 |
| 读不到某个空间的内容 | 空间被加密且当前会话未解锁；或用了「只读（当前空间）」但目标是别的空间 |
| 端口和我记的不一样 | 端口每次会话可能不同；**永远从 `port` 文件读**，别写死 |
| 写入没经过我确认 | 档位是「可写（免确认）」（`write_auto`）：直接落库、只留审计。要确认就切「可写（每次确认）」 |

## 7. 安全与数据边界（务必先读）

- **本地通道**：只绑 `127.0.0.1`，`Origin`/`Host` 必须恰好回环；同网段设备不可达；
- **令牌**：会话级、从本地文件读、权限位最小化；**不要**把 `token` 文件内容贴进任何聊天或配置共享；
- **数据边界**：笔记本体仍在你的本机，ShuyoNote **不上传**；但**外部 AI 读到什么由它决定**——云端模型收到内容后，这部分内容就离开了本机；
- **免确认档的风险**：AI 的写操作不询问直接落库；可撤销的手段是**历史版本/回收站/审计**（写坏了先看历史，不要靠"再让 AI 改回来"）；
- **企业版**：团队/租户空间的 Agent 写面临时**不在本指南范围**（身份、角色、审计合规、数据边界四问未定，见能力矩阵 §8）。

## 8. 推荐配置（一句话版）

- **日常**：`只读`；
- **跨空间检索**：临时切 `只读（全部空间）`；
- **让 AI 改笔记**：`可写（每次确认）`；
- **免确认**：仅"刚备份 + 本机可信 Agent + 用完就切回"。

## 9. 后续路线（会改变本指南的地方）

- **块级写面（P2）**：新增 `blocks_patch/insert/delete`，带 `expectedRev` 冲突校验与 `dryRun` —— 粒度从"整页替换"降到"按块改"；
- **只读扩容（B1）**：数据库/大纲/历史版本/增量变更（`changes_since`）/附件 stat 等；
- 清单与档位判据：[能力暴露矩阵](plans/2026-10-29-agent-capability-exposure-matrix.md)；块级写方案：[P2 方案](plans/2026-10-29-agent-block-write-p2.md)。

## 10. 版本

- 2026-10-29：只读扩容（B1a）—— MCP 工具 **13 → 18**（读面 14 / 写面 4）：新增 `page_current`、`pages_count`、`tags_list`、`properties_list`、`pages_tree`（一次给出整棵空间树，超限如实标 `truncated`）。`coverage_report` **仍不在** MCP 面上（它是应用内 AI 宿主能力，接 MCP 需要前端桥，留待后续）。`apiVersion` 1.2.0 → **1.3.0**。
- 2026-10-29：首版（配合 `pages_get` 的 `rev`＋块锚点、`.shuyodoc` 导出导入落地后的对外说明）。
