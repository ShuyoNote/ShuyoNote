# ShuyoNote 开发指南

> 面向想要**跑起来、改代码、验证、提版**的人。本文档是工程侧的"怎么干"，与 `docs/README.md` 的产品/架构/方案文档互补。
> 版本：v1.59.190

## 1. 技术栈与目录

| 层 | 技术 | 位置 |
|---|---|---|
| 前端 | React 19 · TypeScript · Vite 8 | `src/` |
| 编辑器 | Lexical 0.49（块编辑器） | `src/editor/` |
| 状态 | zustand | `src/store/` |
| 平台层 | 可插拔 driver（桌面 Tauri / 浏览器 Web） | `src/lib/platform/` |
| 后端（桌面） | Rust · Tauri 2 · SQLite | `src-tauri/` |
| Web 存储 | sql.js WASM SQLite + IndexedDB + blob 内容寻址 | `src/lib/platform/web.ts` |
| AI 薄 Agent | 语义工具 + 受限宿主 + 审核落库 | `src/lib/ai/` |
| PDF 阅读/批注 | Lexical 无关的阅读器 + 批注 overlay + 内容寻址存储 | `src/components/Pdf*`、`src/lib/pdf*.ts` |
| OCR / AI 识别 | 离线 tesseract（`ocr.ts` + `createOcrWorker`）+ 视觉大模型（`ai/ocrVision.ts`） | `src/lib/ocr.ts`、`src/lib/ai/ocrVision.ts` |
| 目录 / 朗读 | 视觉生成目录（`aiOutline.ts`）+ Web Speech 朗读（`speech.ts`） | `src/lib/aiOutline.ts`、`src/lib/speech.ts` |

关键分层：`src/lib/platform/` 定义 `Executor` / driver 接口，`tauri.ts` 桌面宿主、`web.ts` 浏览器宿主（含 sql.js + IndexedDB），`index.ts` 按 `__TAURI_INTERNALS__` 自动切换。**同一套前端可跑桌面与浏览器。**

## 2. 环境准备

- Node.js ≥ 20，pnpm（`corepack enable` 或 `npm i -g pnpm`）。
- Rust toolchain（`rustup`），需 Tauri 系统依赖（Windows 需 WebView2；见 Tauri 官方 pre-reqs）。**MSRV 1.94**（声明于 `src-tauri/Cargo.toml` 的 `rust-version`，与 README 徽章 `1.94+` 一致）；不锁工具链，跟随 stable。

## 3. 运行

| 目标 | 命令 | 说明 |
|---|---|---|
| 浏览器 Web 开发 | `pnpm dev:web` | Vite（`vite.web.config.ts`），默认 `http://localhost:5173/`。**改源码后需 Ctrl+Shift+R 强刷**（浏览器缓存旧的 Vite 模块）。 |
| 桌面开发 | `pnpm tauri dev` | 启动 Tauri 窗口（端口 1420），Rust 后端实时编译。 |
| 生产构建（前端） | `pnpm build` | 即 `tsc && vite build`，产物到 `dist/`。 |
| 生产构建（桌面） | `pnpm tauri build` | 打包桌面安装包。 |
| 预览 | `pnpm preview` | 本地预览 `dist/`。 |

## 4. 测试与验证（权威循环）

> **`scripts/smoke-web.mjs` 是 web 平台行为的事实标准**：它用 esbuild 打包 `web.ts` + IndexedDB shim + fs 适配器，在 Node 里跑真实 SQLite，对 CRUD / 属性 / 数据库 / 版本 / 块引用 / 备份 / 多空间 / 搜索 / AI / Lexical 净化等做断言。**每次改动都应让它在"全绿"基础上只增不减。**

> **PDF 离线资源**：`dev`/`dev:web`/`build` 前会自动运行 `scripts/copy-pdfjs-assets.mjs`（pdfjs CJK 资源→`public/pdfjs`）与 `scripts/copy-tesseract-assets.mjs`（tesseract worker/core/双语完整模型→`public/ocr`）；两者均 gitignore（生成物），需 `pnpm install` 后由脚本生成，OCR 才可离线工作。

按顺序跑，全部通过才算稳：

```powershell
# 1. 冒烟测试（权威，断言数随功能增长）
node scripts/smoke-web.mjs            # 期望 "N passed, 0 failed"

# 2. 类型检查
npx tsc --noEmit

# 3. 前端构建
pnpm build                            # tsc + vite build

# 4. Rust 检查（会重生成 src-tauri/Cargo.lock，版本号改动后必跑）
cargo check --manifest-path src-tauri/Cargo.toml
```

**判读"真成功"**：Windows 下 pwsh 常把 `cargo check` / `git push` 的 stderr 包成 `[exit code: 1]`（NativeCommandError 噪音）。真正的成功信号是：
- `cargo check` → 出现 **`Finished \`dev\` profile …`**。
- `git push` → 出现 **`main -> main`**。
- `node scripts/smoke-web.mjs` → 出现 **`N passed, 0 failed`**。

## 5. 版本号提升规则（重要）

每次发版（哪怕只改文档）都要**同步改齐并验证**，否则 tab 标题 / Cargo / README 徽章会不一致：

1. `package.json` → `"version"`
2. `src-tauri/Cargo.toml` → `version =`
3. `src-tauri/tauri.conf.json` → `"version"`
4. `README.md` → 徽章 `version-X.Y.Z-blue`
5. `docs/README.md` → "当前 \`vX.Y.Z\`"
6. `CHANGELOG.md` → 顶部新增 `## [X.Y.Z] - 日期` 条目（Keep a Changelog）
7. `src-tauri/Cargo.lock` → 由 `cargo check` 自动把 `shuyonote` 的 `version` 对齐上一步

> ⚠️ **绝对不要用 shell 重写含中文的 UTF-8 文件**（`Get-Content -Raw` + `WriteAllText` 会产生乱码）。用编辑工具（edit/write）改。

### 5.1 发布管线（自动升级，可选）

让「关于 → 检查更新 → 下载并安装」能拿到新版本，需要一次**签名发布**（详见 [自动升级方案](../plans/2026-08-27-auto-update-plan.md)）：

1. **生成签名密钥**（一次）：`pnpm tauri signer generate -w ~/.tauri/shuyonote.key`（私钥**保密、不进 git**，用密码保护）。
2. **配公钥**：把生成的**公钥**写进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`（当前为占位符，需替换）。
3. **配端点**：`plugins.updater.endpoints` → 你的 `latest.json` 实际地址（如 gitcode releases / CDN / 自建静态站）。
4. **签名 + 构建 + 生成清单**：
   ```bash
   TAURI_SIGNING_PRIVATE_KEY=<...> TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> \
     UPDATE_BASE_URL=https://<your-host>/shuyonote/updates node scripts/release.mjs
   ```
   脚本：`pnpm tauri build`（`bundle.createUpdaterArtifacts` 产安装包旁的 `.sig`）→ 扫描产物 → 生成 **`latest.json`**（Tauri 更新清单，按平台 `url` + `signature`）。
5. **发布**：把安装包 + `latest.json` 上传到更新托管，保证 `UPDATE_BASE_URL` / `endpoints` 可解析。
6. **版本一致**：发布前按 §5 同步所有版本文件；`scripts/release.mjs` 以 `package.json` 的 `version` 为准。

> ⚠️ 端到端升级需一次**真实签名发布**才能验证（本环境无法白测「真实更新」）。公钥为占位符时，`检查更新` 会优雅回退（见 [`src/lib/updates.ts`](../src/lib/updates.ts) / [`src/lib/updater.ts`](../src/lib/updater.ts)）。

## 6. CHANGELOG 约定

- 顶部按版本倒序；每版分 `新增` / `修复` / `修改`。
- 每条写明**现象 + 根因 + 改动**，并附验证结果（如 `scripts/smoke-web.mjs` 从 N→M 全绿，`tsc`/`vite build`/`cargo check` 通过）。
- 里程碑/功能落地会标注 ✅ 并指向具体文档。

## 7. 文档体系约定

| 类型 | 归属 |
|---|---|
| 产品定位 / 架构 / 设计哲学 / 路线图 | `docs/` 顶层 |
| 某功能的技术方案（需求·ADR·里程碑） | `docs/plans/`（按日期命名） |
| 竞品对比 | `docs/compare-*.md` |
| 像素级 UI/UX 设计交付 | `design/`（设计系统 / UX 流程 / 实现计划） |
| 版本演进 | `CHANGELOG.md` |
| 工程/构建/验证/提版约定 | 本文档 `docs/development.md` |

- `docs/` 聚焦"是什么 / 为什么 / 怎么做"；版本演进以 `CHANGELOG.md` 为准。
- 文档统一入口：`docs/README.md`（导航表 + 方案索引）。新增文档记得登记进去。

## 8. 常见坑

- **中文乱码**：只能用编辑工具写 UTF-8；shell 重写会坏。
- **git autocrlf**：Windows 提交时出现 `LF will be replaced by CRLF` 是**正常的**，忽略。
- **提交信息**：`git commit -m "..."` 里避免内嵌 `"` 或 `·`，否则会被拆断导致 pathspec 报错。
- **浏览器缓存**：web 端改源码后必须 **Ctrl+Shift+R**，否则还在跑旧模块（以 `[ShuyoNote] bootstrap vX.Y.Z` 确认版本）。
- **`ERR_CACHE_READ_FAILURE` / 模块 re-hash**：Vite dep 优化缓存与浏览器缓存不对齐时，重启 `pnpm dev:web` + 强刷即可。
- **怀疑坏了**：先看 Console 是否打印 `[ShuyoNote] bootstrap v…`，确认跑的是不是当前构建。
