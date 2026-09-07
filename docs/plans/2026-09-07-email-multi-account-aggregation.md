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

## 交接要点
- 建议**新开会话 / 干净上下文**专注做第 4 步（上千行组件大改），逐项 `tsc` + 真机验证。
- 后端 `email_fetch_all` 已就绪，先接 `api.emailFetchAll`，再改 tab 与账号定位。
- 若第 4 步时间有限，可先只做「全部账号聚合列表 + `accountFor` 定位」，账号 tab 筛选随后补。
