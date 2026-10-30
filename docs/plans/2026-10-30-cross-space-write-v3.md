# 跨空间写 v3 / 导出跨空间 / 超限确认 UI —— 施工拆解（WIP 计划）

> 状态：**待实施**（本文件只定拆分与风险；本轮未改产品代码）。基线：`dev=3334afc9`，
> 61 工具 / 70 能力 / `apiVersion` 1.18.0。owner 已定 v3 语义：**只在指定空间内操作，⛔ 不做跨空间搬数据**。

## A. v3 白名单扩展（按类别拆，建议 A1→A4 分别提交）

沿用 v1/v2 手法：**单连接实现 ＋ 传连接 helper**、`apply.ts` 传 `spaceId`、审计带 `spaceId`、目标空间 `changes` 必须写。

### A1 附件类（`files.move/rename/delete/detach/upload_to_page`）
- 现状障碍：`attachments.rs` 的命令直接吃 `tauri::State<Db>` 并用 `db.0.lock()`/全局活动空间；`remove_attachment` 还依赖 `other_spaces_refs`（跨空间引用检查，**删除必须保留**）。
- 做法：把每条命令的核心抽 `*_in(c, app_data, …)`（或 `*_row` 已有则复用）；`spaceId` 给定时：
  - 用 `open_space_conn_at(target)` 可写连接；
  - 附件必须在**该空间**（`attachments` 行 + hash 校验），否则 `not_found` 点名；
  - 删除时 `other_spaces_refs` 的语义改为"目标空间之外"，避免误删别的空间共用字节；
  - 上传仍走用户文件选择框（`apply.ts` 的 `dialog.open`），跨空间只是把导入目标换成目标空间。
- 判据：附件行在目标空间变化、当前空间四计数不变；源附件不在目标 ⇒ `not_found`。

### A2 结构类（`nodes.move/rename/delete`、`folders.create`）
- 这些 cap 已用 `write_target_space` 做权限门；需要把 `*` 校验/写入从 `with_read_conn`/当前连接改为**目标空间连接**（照 v2 的 `top_blocks_of_in` 手法），`parentId` 必须同空间否则 `bad_args`；非空文件夹仍拒。
- 判据：目标空间树变化、当前空间不变；跨空间 parent ⇒ `bad_args`。

### A3 标签/属性/数据库行/回收站/版本回退
- `tags.add/remove`、`properties.set/unset`、`db.rows_write/delete`、`trash.restore`、`pages.revert`：
  校验与写入全部走目标空间连接（`db.rows_*` 已是 `with_conn_for_space` 校验，但落库经 apply 的 `createPage/setPageProp/deletePage`，需 `spaceId` 透传）。
- 判据：目标空间数据/属性/行变化、当前空间不变；锁空间拒。

### A4 模板/导入（保留"用户在场"）
- `templates.apply`、`import.docpackage`、`files.upload_to_page`：跨空间同样要求系统文件选择框；若实现成本高，**留 unsupported 并在文档写明**（owner 允许）。

## B. `export.*` 跨空间（`apiVersion` 1.19/1.20 视批次）
- `export_page_markdown(pageId, spaceId?)`、`export_docpackage(pageId, spaceId?)`、`export_space_markdown(spaceId?)`：`read:all-spaces` 门（`write_all` 已含）。
- 前端桥流程不变：apply 侧用 `pages.get/blocks.list/files.list` 的 `spaceId` 读目标空间 → 走现有导出函数 → 句柄同一张表；`blobs.fetch` 仍落固定 exports 目录。
- 判据：导出内容含目标空间标题/附件引用；当前空间不受影响；只读全部空间档能导出不能写；句柄单次/TTL 不变。

## C. `>10MB` / `>20 文件` 确认 UI
- 现状：`files.download` 直接 `needs_confirm` 错误（不顺手）。
- 做法：`write_auto` 遇超限 ⇒ **仍产草稿但强制走确认卡**（与 `write_confirm` 同一交互），卡上写清"本次 X MB（>10MB 阈值）"；`write_confirm` 卡补阈值说明；MCP 返回值加 `needsConfirm:true` + 阈值。
- 判据：auto+超限不自动执行、弹卡、确认执行/取消 `rejected`；confirm+超限卡含阈值；未超限行为不变。
- 若只动前端/草稿 payload，则不改 `apiVersion`（报告说明）。

## 风险 / 顺序建议
1. A1 最大（附件命令 refactor + 跨空间删除引用检查），先做；
2. A2/A3 中（连接空间化模式已由 v2 建立）；
3. B 相对独立（客户端导出路径）；
4. C 最独立（前端确认流程）。
每步独立提交、同一类判据（目标空间真改 + 当前空间四计数不变 + 越权点名 + 锁空间 + 回滚开关）。
