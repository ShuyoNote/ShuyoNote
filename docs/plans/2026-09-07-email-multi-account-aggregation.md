# 多账号聚合收件流（B）——进度与第 4 步交接

> 2026-09-07 · 分支 `feat/email-aggregate`。目标：把多账号（多服务商/同服务商多账号）聚合到一个统一收件流（方案 B：后端聚合），UI 采用「聚合为主 + 账号 tab 筛选」。

## 已交付（第 1–3 步，已推送）
| commit | 内容 |
|--------|------|
| `c1d8a9f` | 后端 `email_fetch_all` + `EmailMeta.account` + 注册 + `commands.ts`/`web.ts` 契约登记 |
| `901ae7c` | `api.ts`：`emailFetchAll` / `EmailMeta.account` / `EmailAggregate` |

**后端行为**：读所有已保存账号（`email-account.json`，E1 时解密），逐账号循环 folders 拉取、合并、按时间降序、limit/offset 分页，返回 `{ emails, unread, accounts }`；单账号连接失败跳过。`EmailMeta.account` = `host|username` 标注来源。
**验证**：`cargo check`、`tsc`、`check-web-commands` 均通过。前端当前仍是单账号 tab 切换，`emailFetchAll` 已可调、不影响现有功能。

## 第 4 步（待做）：`EmailPanel` 聚合视图
1. **数据源**：列表拉取改为「全部账号 = `api.emailFetchAll(folders, limit, offset)` / 单账号 = `emailFetchInbox(该账号)`」。
2. **账号 tab 语义**：改为「**全部账号**」+ 每账号筛选；点全部走聚合、点单账号走该账号。
3. **`accountFor(meta)`**：按 `meta.account`（`host|username`）从 `accounts` 列表定位 `EmailAccount`；然后把**所有调用点**（`selectEmail` / `emailGetMessage` / `emailGetAttachments` / `emailGetBody` / `openCompose` / `markRead` / `deleteEmail` / `setFlag` / `emailGetHtml`…）的"全局 `account`"替换为 `accountFor(active)`。
4. **未读角标**：用聚合返回的 `unread`。
5. **分页**：`emailFetchAll` 的 limit/offset + `hasMore`。
6. **回归重点**：阅读、存为笔记（含 B2 附件节点）、A2 发件人标签、回复/转发——聚合流下必须用对账号。

## 第 4 步已完成（2026-09-07）
- **实现**：`EmailPanel.tsx` 全量改造——数据源按 `scope` 分「全部账号=`emailFetchAll` / 单账号=`emailFetchInbox`」；账号 tab 改为「全部账号 + 每账号」筛选；`accountFor(meta)` 按 `meta.account`（`host|username`）从加载的 `accounts` 定位所属账号，并把 `selectEmail`/`emailGetMessage`/`emailGetAttachments`/`emailGetHtml`/`markRead`/`deleteEmail`/`toggleStarred`/`markSelectedRead`/`deleteSelected`/`saveUid`/`saveAsTask`/`saveAttachments`/`saveSelectedAsNotes`/`sendCompose`/`autoTrust`/`trustSender` 等调用点的账号全部改为 `accountFor(active)`（单账号命令无 `meta.account` 时回退到当前筛选账号/首个账号）。
- **配套**：为规避聚合流下不同账号 `uid` 相碰撞，引入 `emailKey`（`account|folder|uid`）作为列表 key / 勾选 key / 行高亮标识；批量操作（删除/标已读/存笔记）按「账号 + 文件夹」分组分别调后端。未读角标在聚合视图用后端汇总 `unread`，单操作按增量调整。
- **验证**：`tsc`、`check-web-commands`、`pnpm build`、`cargo check` 均通过；`pnpm tauri dev` 运行中，HMR 已把改动推进真机窗。
- **聚合视图「按月直达」已补**（新增后端 `email_fetch_all_months` + `email_fetch_all` 支持 `date_from/date_to`，前端 `emailFetchAllMonths`/`emailFetchAll` 日期区间，聚合月份选择器已启用）。
- **已知保留**：聚合视图的文件夹/月份列表以首个账号为准（后端聚合按相同文件夹名遍历各账号，且 `email_fetch_all_months` 并集各账号月份、单账号失败跳过）。

## 交接要点
- 第 4 步已于 2026-09-07 完成（见上「已完成」小节），并补上聚合视图「按月直达」（后端 `email_fetch_all_months` + `email_fetch_all` 日期区间）。后续给未来会话：聚合视图已接 `api.emailFetchAll` + `accountFor` 账号定位 + 「全部/单账号」tab 筛选 + 聚合月份直达；真机回归重点仍是阅读 / 存为笔记（含 B2 附件节点）/ A2 发件人标签 / 回复转发，确认聚合流下各操作都用对账号。
- 后端 `email_fetch_all` 已就绪，支持 `date_from/date_to` 日期区间（聚合按月直达用），单账号仍用 `email_fetch_inbox` 的日期区间。
