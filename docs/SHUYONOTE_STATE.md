# ShuyoNote 项目现状摘要（客户端 · 会话延续种子）

> 本文件是**客户端权威现状**——新会话先读本文件，即可精确了解 ShuyoNote 客户端当前进度、已做取舍与下一步候选，无需依赖模糊回忆。**对齐到最新 v1.84.3（2026-09-09）**。
> 项目根：`~/zhai/ShuyoNote`（Mac）/ `C:\Users\cnzen\zhai\ShuyoNote`（Windows）；远端 gitcode + github。
> 服务端现状见 `shuyonote-sync-server/docs/SYNC_SERVER_STATE.md`；跨平台开发接续见 `docs/SESSION_CONTINUE.md`（服务端仓库）。

## 1. 项目概况

- **产品**：ShuyoNote 数友笔记 —— 本地优先 · 类 Notion 的知识管理桌面应用。
- **技术栈**：Tauri 2（桌面）＋ React 18.3.1 ＋ Lexical 0.50（编辑器）＋ SQLite（本地优先）；Web 版用 sql.js（浏览器）。
- **平台**：桌面（Tauri）＋ 浏览器 Web（平台无关 core ＋ 可插拔 driver）。
- **版本**：**v1.84.3**（`package.json` / `Cargo.toml` / `tauri.conf.json` 一致；tag `v1.84.3`）。
- **许可证**：客户端 **AGPL-3.0**；配套自建同步服务端 **商业**（`shuyonote-sync-server`，见其仓库）。

## 2. 已实现核心功能（里程碑 M1–M27）

| 里程碑 | 主题 | 状态 |
|---|---|---|
| M1–M25 | Markdown/加密/主题/仪表盘/PDF/数据库/多空间/插件/网盘/跨平台/AI/绘图/PDF批注/帮助/公式 | [x]（详见客户端 `docs/roadmap.md`） |
| M26 | 公式（数学） | [x] |
| M27 | 团队版（自建协作） | [部分] 部分（服务端 S1–S8 已落地；客户端 per-workspace `sync_profiles` + 账户 UI（U1–U4）+ E2E 加密已落地；**实时协同后置**） |

### 近期重大变更（v1.82 → v1.84.3）
- **多账号聚合邮箱**（v1.83）：多账号 IMAP 聚合收件箱 + 存为笔记 + AI 总结 + 发件人标签 + 按月直达 + 设置多账号管理/测试连接。
- **附件哈希前缀分桶存储**（v1.84.2）：附件从单目录平铺改为 `attachments/<hash前2>/<hash>.<ext>`，旧数据双读兼容，服务端空间桶内再按哈希前 2 字符分片。
- **同步一致性加固（seq-LWW + dirty 优先本地）**（v1.84.3）：根治团队多人同改时钟漂移丢改动。
- **v1.84.3 发布收尾 + 安全审计**（2026-09-09）：三平台安装包（Win/Linux）已发布 gitcode + GitHub + 官网/Pages（应用内「检查更新」通道 `latest/latest.json` 已通）；安全审计修 3 项上线前高危（插件持锁无超时、E2EE 同步不丢数据、import/purge id 校验），详见 `docs/SECURITY.md`。
- **近实时协作**（开发中，`feat/near-realtime`）：同页冲突提示（P0.1）+ presence 在线/谁在编辑（P0.2）+ 评论/@/通知（P1）+ SSE 推送（P1.5）——服务端 `collab.rs`/`migrate_v10` + 客户端命令/UI，集成回归 `test:sync-collab` 15 断言全绿。

## 3. 关键架构

- **平台 driver**：`src/lib/platform/`（types/tauri/web/index）；`api.ts` 经 `platform.executor.invoke` 调命令，命令契约见 `src/lib/platform/commands.ts`（`CommandMap`）。
- **同步**：outbox `changes` + LWW（服务端 seq 基准 + dirty 优先本地，v1.84.3）；附件内容寻址去重。
- **存储**：每工作空间独立库（`meta.db` + `spaces/<ws_id>/`）；附件内容寻址 hash + 分桶 + 可加密。
- **PDF**：桌面 native MuPDF + Web pdf.js 双引擎；`platform.pdfRender` driver。
- **编辑器**：Lexical 0.50 + 自定义节点；节点类型收敛于 `src/editor/config.ts`。
- **提版**：`scripts/release.mjs`（gitcode 更新）+ `tauri-plugin-updater`（签名 + `latest.json`）。

## 4. 边界 / 红线（重要取舍，勿轻易推翻）

- **Web 同步**：Web 版**不做多设备同步/团队版**（同步引擎在 Rust、浏览器模型与协议不匹配、凭证不安全）；Web 跨设备只走备份/导出 zip。详见 `docs/web-sync-boundary.md`。
- **i18n 暂不做（决策，非欠账）**：目标客户是国内 B 端私有部署，无英文用户信号；i18n 会给每次 UI 改动加税。触发信号（英文 issue/海外询单/上架海外）出现才启动。
- **AGPL**：不把"托管云同步 SaaS"作为服务端收费点；收费点 = AI / 私有部署交付 / 内容模板。
- **版本号约定**：验证性/修复轮不改版本号；只有 bump + 发布才重打安装包。
- **协同后置（P2）**：实时协同明确不做（详见 `docs/realtime-collab-analysis.md`）。

## 5. 验证循环

- `npx tsc --noEmit`、`pnpm build`（含 `check-versions` + `check-web-commands` + `tsc` + `vite`）、`node scripts/smoke-web.mjs`（**350 断言**）、`vitest`（**88**）、`cargo test`（**55**）。
- `pnpm run dev:desktop`（桌面开发，自建干净 PATH，见 `scripts/tauri-dev.mjs`）。
- 发布：`git tag vX && git push origin vX && git push origin main` → `node scripts/release.mjs`。

## 6. 下一步候选（按需选一项继续）

1. **M27 团队版剩余**：实时协同（后置）；本地多用户档案。
2. **PDF 批注阶段 2**：写回源 PDF / OCR 精确划词（延后；导出带批注副本已实现）。
3. **M16 其余平台壳**：安卓 / iOS / 鸿蒙（浏览器 PWA 已作为首个 Web 壳）。
4. **插件体系进化 M11.8 触发面与事件**：M11.5/M11.6/M11.7 均已落地（时限与资源上限、ABI v1 + 能力注册表 + 权限与写中介、20 条能力 + 与 AI 工具层合并，**以及 M11.6 收口的作者工具链**——应用内校验/热重载/`pnpm plugin:validate`/示例插件/类型包 globals）；**M11.8 已落地四档**（命令参数 → 宿主渲染表单、结构化返回、事件钩子 v1 + **5 个发射点**（`app.started`/`page.opened`/`page.deleted`/`space.switched`/`page.saved`，另两个标为未接）、**触发面 v1：编辑器 `/` 菜单**）；**M11.8 除「其余触发面（页面/附件右键、编辑器工具栏）」与「两个事件的宿主发射」外均已落地**（命令参数、结构化返回、事件钩子 + 5 个发射点、编辑器 `/` 菜单、插件设置）；下一步按顺序进 **M11.9 声明式贡献面（无代码插件）**——社区贡献阶梯里最先能安全开放的一级，也是 M11.10 沙盒 UI 的启动闸门；另有一处**信任缺口**待办（插件更新后新增 events/权限不重新征求同意，见路线图与 M11.11b）。见[插件体系进化方案](plans/2026-09-10-plugin-evolution-plan.md)（**定位=做第一不做更大**：做**第一个「有权限模型 + 作用在 E2EE 可自托管数据上」的可信插件体系**，不比能力条数）。
5. **数友社区上线当天（不等 M11.13）**：开「模板 / 主题 / 插件配方」分类 + 发布 `plugin-index.json` 规范 + 招募 3 位共创作者；**不做**应用内市场 UI——见[插件分发策略](plans/2026-09-10-plugin-distribution-strategy.md)（协议而非平台 + 贡献阶梯，前三级为惰性数据可立即开放）。
6. **M11.10 UI 插件 / M11.11 市场 / M23.5 协同 / 移动端（M6）**：已评估延后（M11.10 闸门=声明式贡献面穷尽；M11.11 闸门=作者文档 + ≥3 真实第三方插件，前置=M11.13）。

> 注：功能明细 / 里程碑总览以客户端 `docs/roadmap.md` + `docs/README.md`（文档索引）为准；本文件只作"新会话现状种子"，重开会话先读它再读 roadmap/architecture。
