# ShuyoNote 项目现状摘要（会话延续种子）

> 本文件为项目当前状态摘要（2026-09-01 更新，版本 v1.65.3），供新会话快速了解现状、已做取舍与下一步候选，无需依赖模糊回忆。
> 项目根：`C:\Users\cnzen\zhai\ShuyoNote`。

## 1. 项目概况

- **产品**：ShuyoNote 数友笔记 —— 本地优先 · 类 Notion 的知识管理桌面应用。
- **技术栈**：Tauri 2（桌面）＋ React 18.3.1 ＋ Lexical 0.49（编辑器）＋ SQLite（本地优先）；Web 版用 sql.js（浏览器）。
- **平台**：桌面（Tauri）＋ 浏览器 Web（平台无关 core ＋ 可插拔 driver，见 [跨平台方案](plans/2026-08-24-cross-platform-plan.md)）。
- **版本**：**v1.65.3**（最近发布；`package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json` / `Cargo.lock` 一致；安装包在 `src-tauri/target/release/bundle/`）。当前 main HEAD 与推送一致。
- **许可证**：**AGPL-3.0**（附带的服务端 `shuyonote-sync-server` 在随 AGPL 网络托管形态下同需开源；服务端仓库为商业 `LICENSE-COMMERCIAL`）。
- **配套服务端**：`C:\Users\cnzen\zhai\shuyonote-sync-server`（自建同步服，v1.1.0，商业；见其 `docs/SYNC_SERVER_STATE.md`）。

## 2. 已实现核心功能（里程碑 M1–M27）

| 里程碑 | 主题 | 状态 |
|---|---|---|
| M1 | Markdown 无损往返 | ✅ |
| M2 | 端到端加密（E2E，空间级） | ✅ |
| M3 | 主题 / 外观 + 插件雏形 | ✅ |
| M4 | 属性驱动仪表盘聚合 | ✅ |
| M5 | PDF 导出 | ✅ |
| M6 | 移动端适配 | 未做（环境受限，升级为 M16 全平台通吃） |
| M7 | 数据库视图扩展 | ✅ |
| M8 | 新页面引导 | ✅ |
| M9 | 模板 | ✅ |
| M10 | 多工作空间 | ✅ |
| M11 | 插件 | ✅（M11.3 UI 型 / M11.4 市场已评估延后） |
| M12 | 文件夹 = 网盘 | ✅ |
| M13 | 数据库 = 透镜 | ✅ |
| M14 | 空间清理 / 存储管理 | ✅ |
| M15 | 每空间独立存储（物理隔离） | ✅ |
| M16 | 跨平台适配（全平台通吃） | ✅（部分） |
| M17 | AI 薄 Agent | ✅ |
| M18 | 内联 AI 起草 | ✅ |
| M19 | Wiki 织网增强 | ✅ |
| M20 | 模板变量 + 语义检索 | ✅ |
| M21 | 静态 wiki 导出 + 关系图 | ✅ |
| M22 | 绘图（Excalidraw / mermaid / AI 文生图） | ✅ |
| M23 | Excalidraw 高级功能 | ✅（M23.5 协同 / 代码生成未做） |
| M24 | **PDF 批注** | ✅（阶段 1/3 + 阅读器 + OCR/AI 增强 + **导出带批注 PDF 副本**；写回源 PDF / OCR 精确划词仍延后） |
| M25 | 帮助系统 | ✅ |
| M26 | 公式（数学） | ✅ |
| M27 | 团队版（自建协作） | 规划（服务端已实现 S5；客户端登录/空间绑定 UI 待做） |

## 3. 安全加固（P0/P1/P2，2026-09-01）

- **E1 本地静置加密**（默认关）：口令 → Argon2id → 会话内存密钥（不落盘）→ SQLCipher 加密空间库 ＋ 附件（XChaCha20-Poly1305）；启动锁定门控；明文 ↔ 密文双向迁移；锁定态不读；备份 / 导入兼容加密空间。
- **客户端**：CSP 收紧（`script-src` 去 `'unsafe-inline'`，启动脚本外置；为 pdf.js 保留 `'unsafe-eval'`/`'wasm-unsafe-eval'`，**不加** `'unsafe-inline'`）；`attachment://` 协议路径穿越 + `Access-Control-Allow-Origin` 回显；Markdown 预览 XSS sanitizer；zip-slip（safe_join）；`write_attachment_bytes` hash 校验；E1 × 同步兼容（上传前解密 / 下载后加密）。
- **服务端**（见 shuyonote-sync-server）：附件下载路径穿越补 hash 校验、legacy `/attachments` 挂鉴权、移除 permissive CORS、登录失败限速、会话清理、push device_id 绑定用户、space owner 不可变、口令强度 ≥8。

## 4. 结构性改进（2026-09-01，三项均达成）

1. **markdown round-trip 单测**：`mdToHtml` + `mdPreview` + happy-dom 测试环境，vitest **88 断言**。
2. **web.ts 命令契约层**：`src/lib/platform/commands.ts` 定义 `CommandMap`（118 命令 args+result）；`api.ts` 的 `invoke` 改为 `CommandMap` 泛型（命令名/args/result 编译期报错）；`check-web-commands.mjs` 断言 Rust 命令 ⊆ CommandMap 键并纳入 `pnpm build`。运行时行为零变化。
3. **服务端单 Mutex 并发瓶颈**：`push` 批量单事务；**读写分离**（写连接 + 只读连接池，读不阻塞写、多读并行）。并发基准 8 读×2000 + 写并行 16000 读全完成，单读连接 250ms → 4 连接池 124ms。

详见 [结构项立项](plans/2026-09-01-structural-backlog-plan.md)。

## 5. 关键架构

- **平台 driver**：`src/lib/platform/`（`types.ts` 接口 + `tauri.ts` 桌面 + `web.ts` 浏览器 + `index.ts` 选择）；`api.ts` 经 `platform.executor.invoke` 调命令，命令契约见 `src/lib/platform/commands.ts`（`CommandMap`）。
- **PDF**：桌面 native MuPDF（`mupdf-sys`）+ Web pdf.js 双引擎；`platform.pdfRender` driver；pdf.js 集中于 `pdfjsEngine.ts` 唯一入口。**注意**：`render_pdf_page` 已改为 async command（MuPDF 栅格化用 `spawn_blocking` 放后台，避免主线程"未响应"）。
- **存储**：每工作空间独立库（`meta.db` + `spaces/<ws_id>/`）；附件内容寻址 hash 存储 + 可加密。
- **编辑器**：Lexical 0.49 + 自定义节点（`ColumnsBlockNode` / `DrawingNode` / `FormulaNode` 等），节点类型收敛于 `src/editor/config.ts`。
- **提版**：`scripts/release.mjs`（gitcode 自动更新）+ `tauri-plugin-updater`（签名 + `latest.json`，半自动，非静默强更）。
- **设置中心**：`SettingsDialog.tsx`（外观 / **空间** / **账户** / 插件 / 安全 / AI / 关于七页，`useEditorStore.settingsOpen+settingsTab` 驱动，侧栏齿轮 + 命令面板 `settings.*` 入口）。原「主题设置」弹层已删除；**端到端加密从主题面板迁到「安全」页**，关闭加密改为红色危险区 + 二次确认。AI 表单抽成 `AiSettingsForm`，与 AI 面板的独立对话框共用一份实现。
- **侧栏 vs 设置的划分**（IA 判据，勿轻易推翻）：**高频 / 与当前上下文绑定 / 需要状态常驻可见** → 侧栏；**低频 / 全局 / 不可逆** → 设置（空间配色·删除·导入导出、登录身份、加密）。据此 `AccountCenter` 已下线（并入设置「账户」页），侧栏空间弹层只留「切换 / 重命名 / 新建 + 管理入口」；空间导入导出逻辑在 `lib/spaceTransfer.ts`，进度经 `store/spaceTransfer.ts` 由 App 级 `SpaceTransferProgress` 渲染（关掉面板也能看到进度）。
- **左侧竖条（activity bar）**：`ActivityBar.tsx` + `store/activity.ts`。四段职责：**竖条**=全局导航（笔记/搜索/文件/看板/关系图）+ 全局工具（模板/设置/关于）；**侧栏**=当前活动的内容（页面树 或 `SearchSidebar`）；**侧栏头部**=与当前空间相关的（空间切换/同步/新建）；**右侧 RightRail**=与当前文档相关的（AI/目录）。点当前活动图标收起/展开侧栏（`sidebarOpen` 持久化）；`view`（主区）与 `activity` 同步，命令面板切视图时竖条跟着高亮。**弹层版 `SearchPanel.tsx` 已删除**（同一件事只留一个入口，快速跳转走 Ctrl+K）。注意：`PageTree` 里的 `collapsed` 一直硬编码 `false`（旧折叠是死代码），真正的折叠由竖条负责。

## 6. 边界 / 红线（重要取舍，重开会话勿轻易推翻）

- **版本号约定**：验证性 / 修复轮不改版本号、不重打桌面；只有版本号 bump + 发布才重打 MSI/exe（`pnpm tauri build`）。当前 **v1.65.3**。
- **CSP**：保留 `style-src 'unsafe-inline'`（splash 内联样式）；`script-src` 允许 `'unsafe-eval'`/`'wasm-unsafe-eval'`（pdf.js 必需），但**不加** `'unsafe-inline'`。
- **分栏**：旧 `columns`（ElementNode）不做自动迁移（保留注册可读兼容）；列内块级拖拽 / 跨列复制不做（成本高风险大、收益低）。
- **PDF**：OCR 精度上限由原扫描清晰度决定；AI 视觉识别 / 目录生成需配置**支持图像**的模型（纯文本模型会失败）；系统朗读为系统音色（中文音色包缺失则无声）。
- **AGPL**：不把"托管云同步 SaaS"作为服务端收费点（会触发 AGPL 网络托管条款）；收费点 = AI / 私有部架交付 / 内容模板。服务端 `team` 空间放弃零知识（个人空间保留 E2E）。
- **Web 同步**：Web 版**不做多设备同步/团队版**——同步引擎在 Rust（`sync.rs`）、服务端不挂 CORS、浏览器整库快照模型与增量协议不匹配、长期凭证放浏览器不安全；`web.ts` 里是显式降级桩。Web 跨设备只走备份/导出 zip。详见 [`docs/web-sync-boundary.md`](web-sync-boundary.md)。

## 7. 验证循环

- `npx tsc --noEmit`、`pnpm build`（含 `check-versions` + `check-web-commands` + `tsc` + `vite`）、`node scripts/smoke-web.mjs`（**347 断言**）、`vitest`（**88**）、`cargo test --lib`（**42**，含 PDF 渲染 / 迁移）。
- **pnpm**：用 11.24.0 全路径 `C:\Users\cnzen\AppData\Local\Author Software\nvm\installs\v22.15.0\pnpm.cmd`（v10 有 store 冲突）。
- **发布**：先 `git tag vX && git push origin vX && git push origin main`，再 `node scripts/release.mjs`（构建 + 签名 + 上传 gitcode + 更新 `latest.json`）——release.mjs 已前置校验 tag 存在。
- **坑**：pwsh 会把 `git`/`cargo` 的 stderr 包装成 `[exit code: 1]`（假阳性），看 `main -> main` / `Finished` / `test result: ok`；CRLF 警告正常（autocrlf）；Windows 沙箱读命令用 `pwsh -Command`。
- **代理**：git 需 `-c http.proxy= -c https.proxy=`（或清全局代理）临时直连。

## 8. 下一步候选（按需选一项继续）

1. **PDF 批注阶段 2**：写回源 PDF / OCR 精确划词（仍延后；为低成本替代，已实现「**导出带批注副本**」——逐页把原页面 + 批注合成位图再用 pdf-lib 组装成新 PDF 下载，不动源文件，见 `src/lib/pdfAnnotExport.ts`）。
2. **M27 团队版客户端接入**：登录 + 空间绑定 + 成员 / 权限 UI（见 [账号/空间绑定](plans/2026-08-30-team-edition-account-space-plan.md)）；服务端 `/auth/*` `/spaces/*` 已就绪。
3. **Web 补齐清单（M16.6–M16.8）**：附件移动 / 批量删除、存储统计精确化、全文搜索（见 [Web 补齐清单](plans/2026-08-24-web-polish-backlog-plan.md)）。
4. **M11.3 UI 型插件 / M11.4 市场、M23.5 协同**：已评估延后，如产品必需再立项。
