# ShuyoNote 开发指南

> 面向想要**跑起来、改代码、验证、提版**的人。本文档是工程侧的"怎么干"，与 `docs/README.md` 的产品/架构/方案文档互补。
> 版本：v1.59.190

## 1. 技术栈与目录

| 层 | 技术 | 位置 |
|---|---|---|
| 前端 | React 18 · TypeScript · Vite 8 | `src/` |
| 编辑器 | Lexical 0.50（块编辑器） | `src/editor/` |
| 状态 | zustand | `src/store/` |
| 平台层 | 可插拔 driver（桌面 Tauri / 浏览器 Web） | `src/lib/platform/` |
| 后端（桌面） | Rust · Tauri 2 · SQLite | `src-tauri/` |
| Web 存储 | sql.js WASM SQLite + IndexedDB + blob 内容寻址 | `src/lib/platform/web.ts` |
| AI 薄 Agent | 语义工具 + 受限宿主 + 审核落库 | `src/lib/ai/` |
| PDF 阅读/批注 | Lexical 无关的阅读器 + 批注 overlay + 内容寻址存储 | `src/components/Pdf*`、`src/lib/pdf*.ts` |
| OCR / AI 识别 | 离线 tesseract（`ocr.ts` + `createOcrWorker`）+ 视觉大模型（`ai/ocrVision.ts`） | `src/lib/ocr.ts`、`src/lib/ai/ocrVision.ts` |
| 目录 / 朗读 | 视觉生成目录（`aiOutline.ts`）+ Web Speech 朗读（`speech.ts`） | `src/lib/aiOutline.ts`、`src/lib/speech.ts` |

关键分层：`src/lib/platform/` 定义 `Executor` / driver 接口，`tauri.ts` 桌面宿主、`web.ts` 浏览器宿主（含 sql.js + IndexedDB），`index.ts` 按 `__TAURI_INTERNALS__` 自动切换。**同一套前端可跑桌面与浏览器。**

## 2. 环境准备（从零搭建）

> 目标：装好依赖后能跑 `pnpm tauri dev`（桌面）或 `pnpm dev:web`（浏览器）。需要 **Node.js ≥ 20 + pnpm、Rust stable（≥1.94）+ Tauri 2 系统依赖**。

### 2.1 Node.js 与 pnpm

- 安装 **Node.js ≥ 20**（推荐 LTS，如 22）。多版本管理可用 `nvm` / `fnm` / `n`。
- 安装 **pnpm**（corepack 已随 Node 附带）：
  ```bash
  corepack enable            # 启用 pnpm（Node 22+ 自带 corepack）
  # 或 npm i -g pnpm
  pnpm -v                    # 应打印 10.x
  ```

### 2.2 Rust 工具链

- 用 **rustup** 安装 **stable** 工具链（`rust-version = "1.94"` 为最低要求，跟随 stable 即可，不锁 channel）：
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # 按提示选默认
  source "$HOME/.cargo/env"
  rustc --version            # 应 ≥ 1.94
  cargo --version
  ```

### 2.3 平台系统依赖（Tauri 2 需要）

- **Windows**：需 **WebView2**（Win10 旧版手动装 runtime）；Rust MSVC 构建工具链（`rustup default stable-msvc`）；可选 Visual Studio C++ Build Tools。
- **macOS**：需 **Xcode Command Line Tools**（`xcode-select --install`）。
- **Linux（Debian/Ubuntu）**：
  ```bash
  sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev libclang-dev xdg-utils
  ```
  （这些同时也是 `release.yml` CI 里 ubuntu 跑 `pnpm tauri build` 要装的包。）

#### 2.3.1 OpenSSL（**Windows 必做**，macOS/Linux 一般可跳过）

`src-tauri/Cargo.toml` 里 `rusqlite` 启用了 `bundled-sqlcipher`，而 **SQLCipher 需要链接系统 OpenSSL**：
macOS/Linux 一般能被构建脚本自动找到（Linux 靠上面的 `libssl-dev`），**Windows 找不到就直接 panic**：

```
error: failed to run custom build command for `libsqlite3-sys vX.Y.Z`
  thread 'main' panicked at ...libsqlite3-sys-.../build.rs:198:29:
  Missing environment variable OPENSSL_DIR or OPENSSL_DIR is not set
```

> ⚠️ 这句报错**不代表代码有问题**，它只是「没找到 OpenSSL」。`Cargo.toml` 里的
> `bundled-sqlcipher-vendored-openssl` 是 **Android 交叉编译专用**，桌面构建不会启用，所以桌面必须提供系统 OpenSSL。

二选一（PowerShell）：

```powershell
# A. 已装 OpenSSL（如 Win64 安装包）→ 只把路径导出来即可
$env:OPENSSL_DIR         = 'C:\Program Files\OpenSSL-Win64'
$env:OPENSSL_LIB_DIR     = 'C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD'   # 按实际子目录调整（MD / MT）
$env:OPENSSL_INCLUDE_DIR = 'C:\Program Files\OpenSSL-Win64\include'

# B. 没装 → 用 vcpkg 装（与 CI 完全一致）
vcpkg install openssl:x64-windows-static-md
$env:OPENSSL_DIR = "$env:VCPKG_INSTALLATION_ROOT\installed\x64-windows-static-md"
$env:VCPKG_ROOT  = $env:VCPKG_INSTALLATION_ROOT
```

> **CI 用的就是 B（vcpkg）** —— 见 `release.yml` 的 “Setup OpenSSL for SQLCipher (Windows)” 步骤。
> 本地设好上面变量后，§4 第 5 步的 `cargo check` 即可通过（本机实测 `cargo check` 3m37s 通过）。
> 这些变量**只在当前终端会话生效**，建议写进用户环境变量或启动脚本。

> 这些是 Tauri 官方 pre-requisites（见 [Tauri docs](https://tauri.app/start/prerequisites/) / Linux 需 `libwebkit2gtk-4.1`）。

### 2.4 装依赖并跑起来

```bash
git clone https://gitcode.com/shuyo-cn/ShuyoNote.git
cd ShuyoNote
pnpm install        # 安装前端依赖（含 PDF/OCR 资源，见下）
pnpm tauri dev      # 桌面（Tauri + Rust，端口 1420）
pnpm dev:web        # 浏览器（Web 平台，Vite 5173）
```

> **PDF/OCR 资源**：`dev`/`dev:web`/`build` 前自动跑 `scripts/copy-pdfjs-assets.mjs`（PDF CJK→`public/pdfjs`）与 `scripts/copy-tesseract-assets.mjs`（tesseract worker/core/双语模型→`public/ocr`）；两者是 gitignore 的生成物，`pnpm install` 后由脚本生成，OCR 才可离线工作。

> **Windows 坑**：若 cargo 用镜像源遇到 SSL 撤销错误，先 `$env:CARGO_HTTP_CHECK_REVOKE="false"` 再跑。


## 3. 运行

| 目标 | 命令 | 说明 |
|---|---|---|
| 浏览器 Web 开发 | `pnpm dev:web` | Vite（`vite.web.config.ts`），默认 `http://localhost:5173/`。**改源码后需 Ctrl+Shift+R 强刷**（浏览器缓存旧的 Vite 模块）。 |
| 桌面开发 | `pnpm tauri dev` | 启动 Tauri 窗口（端口 1420），Rust 后端实时编译。 |
| 生产构建（前端） | `pnpm build` | 即 `tsc && vite build`，产物到 `dist/`。 |
| 生产构建（桌面） | `pnpm tauri build` | 打包桌面安装包。 |
| 预览 | `pnpm preview` | 本地预览 `dist/`。 |

## 4. 测试与验证（权威循环）

> **这些检查现在由 CI 跑**（`.github/workflows/ci.yml`，push/PR 到 `main` 或 `dev` 时触发）：类型检查、vitest、smoke-web、两设备同步验收、版本/命令契约/文档链接，外加一档用真实 Chromium 的移动端布局验收（`test:mobile-layout`）。**需要服务端的两个集成脚本不在这里**（要一个跑着的同步服务端），它们在服务端仓库的 CI 里——那边构建二进制后，clone 本仓拿脚本去打它。
>
> 在此之前这些检查**只靠人记得跑**：`smoke-web`（350 断言）曾因一处无守卫的 `localStorage` 访问整套崩掉而长期无人察觉——没有自动化在跑它，谁都没看见它是红的。

> **`scripts/smoke-web.mjs` 是 web 平台行为的事实标准**：它用 esbuild 打包 `web.ts` + IndexedDB shim + fs 适配器，在 Node 里跑真实 SQLite，对 CRUD / 属性 / 数据库 / 版本 / 块引用 / 备份 / 多空间 / 搜索 / AI / Lexical 净化等做断言。**每次改动都应让它在"全绿"基础上只增不减。**

> **PDF 离线资源**：`dev`/`dev:web`/`build` 前会自动运行 `scripts/copy-pdfjs-assets.mjs`（pdfjs CJK 资源→`public/pdfjs`）与 `scripts/copy-tesseract-assets.mjs`（tesseract worker/core/双语完整模型→`public/ocr`）；两者均 gitignore（生成物），需 `pnpm install` 后由脚本生成，OCR 才可离线工作。

按顺序跑，全部通过才算稳：

```powershell
# 1. 前端单元测试（Vitest，纯函数：treeReorder / pdfAnnotation / …）
pnpm test                             # 期望 "N passed"

# 2. 冒烟测试（web 平台行为事实标准，断言数随功能增长）
node scripts/smoke-web.mjs            # 期望 "N passed, 0 failed"

# 3. 类型检查
npx tsc --noEmit

# 4. 前端构建
pnpm build                            # check-versions + tsc + check-web-commands + vite build

# 5. Rust 检查（会重生成 src-tauri/Cargo.lock，版本号改动后必跑）
cargo check --manifest-path src-tauri/Cargo.toml

# 6. 文档相对链接（改动文档 / 挪动文件后跑）
pnpm check:doc-links                  # 期望 "N 条相对链接全部可达"

# 7. 移动端布局验收（改了侧栏/响应式 CSS 时跑；需本机 Chrome + 已启动 pnpm dev:web）
pnpm test:mobile-layout               # 期望 "N 通过 / 0 失败"
```

> **`test:mobile-layout` 补的是单测够不到的盲区**：侧栏的移动端行为藏在「CSS 层叠 + matchMedia + z-index + localStorage」的交叉处，用 happy-dom 测不出来（它不按视口重算媒体查询）。脚本用真实 Chromium 在 390×844 / 1280×800 两种视口下断言 20 项，详见 `docs/MOBILE.md` §5.2。依赖只用 `puppeteer-core`（不含浏览器下载），找不到 Chrome 会明确报错而不是静默跳过。

> **命令契约守卫**（`scripts/check-web-commands.mjs`，已并入 `pnpm build`）校验三件事：Rust 命令 ⊆ `web.ts`、Rust 命令 ⊆ `CommandMap`、**`CommandMap` 顶层参数键必须是 camelCase**。第三条是运行时坑的静态兜底——**Tauri 2 只接受 camelCase 参数键**并在运行时映射到 Rust 的 snake_case 形参，传 `server_url` 会报 `missing required key serverUrl`；而 TS 查不出来（契约和调用点会「一起错」）。`args: { args: {...} }` 这种「整个结构体当一个参数」的写法除外，内层字段仍是 serde 的 snake_case。

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

> [!] **绝对不要用 shell 重写含中文的 UTF-8 文件**（`Get-Content -Raw` + `WriteAllText` 会产生乱码）。用编辑工具（edit/write）改。

### 5.1 发布管线（自动升级，可选）

让「关于 → 检查更新 → 下载并安装」能拿到新版本，需要一次**签名发布**（详见 [自动升级方案](plans/2026-08-27-auto-update-plan.md)）：

1. **生成签名密钥**（一次）：`pnpm tauri signer generate -w ~/.tauri/shuyonote.key`（私钥**保密、不进 git**，用密码保护）。
2. **配公钥**：把生成的**公钥**写进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`（当前为占位符，需替换）。
3. **配端点**：`plugins.updater.endpoints` → 你的 `latest.json` 实际地址（如 gitcode releases / CDN / 自建静态站）。
4. **先打 tag 并推送（关键，顺序不能反）**：
   ```bash
   git tag v<version> && git push origin v<version> && git push origin main
   ```
   > [!] **gitcode 的 release 创建 API 用 `tag_name` 定位 git tag；tag 不存在会静默失败**（release 未建、`latest.json` 不更新，客户端就查不到更新）。`release.mjs` 现在在发布前校验本地 + 远程 tag 都存在，缺失会直接报错退出；但正常流程应**先打 tag 再发布**。
5. **签名 + 构建 + 生成清单**：
   ```bash
   TAURI_SIGNING_PRIVATE_KEY=<...> TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> \
     UPDATE_BASE_URL=https://<your-host>/shuyonote/updates node scripts/release.mjs
   ```
   脚本：`pnpm tauri build`（`bundle.createUpdaterArtifacts` 产安装包旁的 `.sig`）→ 扫描产物 → 生成 **`latest.json`**（Tauri 更新清单，按平台 `url` + `signature`）。
6. **发布**：把安装包 + `latest.json` 上传到更新托管，保证 `UPDATE_BASE_URL` / `endpoints` 可解析。
7. **版本一致**：发布前按 §5 同步所有版本文件；`scripts/release.mjs` 以 `package.json` 的 `version` 为准。

> [!] 端到端升级需一次**真实签名发布**才能验证（本环境无法白测「真实更新」）。公钥为占位符时，`检查更新` 会优雅回退（见 [`src/lib/updates.ts`](../src/lib/updates.ts) / [`src/lib/updater.ts`](../src/lib/updater.ts)）。

### 5.2 Web 版构建与部署（browser）

Web 版与桌面基于**同一份前端**（平台 driver 在运行时按 `__TAURI_INTERNALS__` 切换：Tauri → `tauri.ts`；浏览器 → `web.ts` + sql.js/mock）。构建与部署：

```bash
# 1. 构建 Web 产物（独立目录 dist-web，与桌面 dist/ 隔离）
pnpm build:web            # 等价于：vite build --config vite.web.config.ts --outDir dist-web

# 2. 部署到自托管静态站（子路径 /app/；用 rsync/scp，主机/路径在仓库外）
rsync -av dist-web/ yourhost:webroot/shuyo/app/
```

部署注意（`base:"./"` 已就绪，产物可放任意子路径）：
- 服务器需把 `.mjs` 以 `application/javascript` 提供（否则 pdf worker 加载失败）。
- 子路径 `/app/` 需把 `index.html` 作为 SPA fallback；`sw.js`/`manifest.webmanifest` 已用相对路径，无需改。
- **`version.json` 必须一起部署**：Web 的「检查更新」读同源 `version.json`（`scripts/write-version-json.mjs` 在 `dev:web` 与 `build:web` 时写入 `public/` 与 `dist-web/`）。服务器要给它 `Cache-Control: no-store`——部署前访问过的 **404 会被浏览器启发式缓存**，之后即使文件已就位也会一直报「未部署」。同理 `index.html` / `sw.js` 用 `no-cache`，`assets/`（内容 hash）才可 `immutable` 长缓存。
- **同步 / 团队版在 Web 上不可用**：`web.ts` 里是显式降级桩，不是配置项——原因与开启路线见 [Web 同步能力边界](web-sync-boundary.md)。
- `dist-web/` 在 `.gitignore`，**不进仓库**（rsync/scp 直传；若改走 git pages 需另建承载仓库并把产物强制发布）。
- 当前仓库**未配置固定 Web 线上入口**（gitcode pages 未建；代码注释目标为 `shuyo.cn/app/`）；`build:web` 仅产出可部署的 `dist-web/`，实际线上托管需提供主机/路径。

## 6. CHANGELOG 约定

- 顶部按版本倒序；每版分 `新增` / `修复` / `修改`。
- 每条写明**现象 + 根因 + 改动**，并附验证结果（如 `scripts/smoke-web.mjs` 从 N→M 全绿，`tsc`/`vite build`/`cargo check` 通过）。
- 里程碑/功能落地会标注 ✅ 并指向具体文档。

## 7. 文案与国际化约定

**当前不做 i18n**（决策与重估信号见内部项目状态笔记）。但新代码要遵守下面三条**止血规矩**——它们零成本、不引入任何框架、不动存量代码，作用是**让将来真要做的时候不必考古**：

**① Rust 侧新增的用户可见错误，消息带错误码前缀**

```rust
// ✅ 新代码
return Err("E_WS_NOT_FOUND:工作空间不存在".to_string());
// ❌ 别再新增这种（存量 160 处不动，但不要让它继续增长）
return Err("工作空间不存在".to_string());
```

前端按 `码:文案` 切分，优先用码查表、查不到就回退显示原文——**没有译文时行为与现在完全一致**。这条止的是最贵的血：错误消息在 Rust 侧成文，国际化时属于接口契约变更，比翻译贵一个数量级。

**② 用户可见文案不要拼接**

```ts
// ❌ 假设了中文语序，换语言必须重写
toast("已删除 " + n + " 项");
// ✅ 完整模板串，将来整条替换即可
toast(`已删除 ${n} 项`);   // 或 t("trash.deleted", { n })
```

**③ 文案集中在模块顶部常量，不要散在 JSX 深处**

组件内多处复用的提示、菜单项、空态文案，声明成顶部的 `const`。将来抽取是机械操作，而不是在 JSX 里逐行挖。

> 同理，**命令 / 斜杠菜单的标题**目前按中文匹配（`title.includes(q)`）。新增命令时如果有通用英文名，顺手在 `description` 里带上，将来做别名表时有据可依。

## 8. 文档体系约定

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

## 9. 常见坑

- **`Missing environment variable OPENSSL_DIR`（Windows）**：`rusqlite` 的 `bundled-sqlcipher` 要链接系统 OpenSSL，Windows 必须显式给路径 —— 装了 OpenSSL 也要导 `OPENSSL_DIR`（最常见就是「装了但没设变量」）。详见 **§2.3.1 OpenSSL（Windows 必做）**。
- **中文乱码**：只能用编辑工具写 UTF-8；shell 重写会坏（`>` 重定向在 PowerShell 里写的是 UTF-16，`Get-Content`/`Set-Content` 往返会把中文写成 GBK 乱码——本项目已因此损坏过 `commands.ts` 与两个预览文件）。从 git 取回旧版本用 `git checkout <commit> -- <path>`，让 git 自己写字节。
- **验证与提交分两步**：PowerShell 的 `;` 不会因前一条失败而中断，`tsc/build` 失败后 `git commit && git push` 照样会跑——曾因此把编译不过的版本推上远端。先跑验证、看退出码，再单独提交。
- **换行符（autocrlf）**：仓库用 `.gitattributes`（`* text=auto eol=lf`）钉死 LF，各平台检出都是 LF；Windows 上若仍看到 `LF will be replaced by CRLF`，说明改动没走到这条规则上，**别当成正常忽略**。历史教训：v1.84.6 首次发布时 Windows runner 因默认 `core.autocrlf=true` 把文本检出成 CRLF，而 `check-capabilities` 对生成物做逐字节比对 → `pnpm build`（Tauri 的 `beforeBuildCommand`）失败 → Windows 构建整个红掉而 Linux 正常。**新写「比对生成物」的检查时必须按行尾无关比较**（`\r\n` → `\n` 后再比），否则等于给 Windows 埋一颗必炸的雷。
- **提交信息**：`git commit -m "..."` 里避免内嵌 `"` 或 `·`，否则会被拆断导致 pathspec 报错。
- **浏览器缓存**：web 端改源码后必须 **Ctrl+Shift+R**，否则还在跑旧模块（以 `[ShuyoNote] bootstrap vX.Y.Z` 确认版本）。
- **`ERR_CACHE_READ_FAILURE` / 模块 re-hash**：Vite dep 优化缓存与浏览器缓存不对齐时，重启 `pnpm dev:web` + 强刷即可。
- **怀疑坏了**：先看 Console 是否打印 `[ShuyoNote] bootstrap v…`，确认跑的是不是当前构建。

## 10. 分支模型与合并流

```
main    ← 只放「已发布」的代码。推 main = GitHub Pages 自动部署 + 可打 tag 发版。
          只接受两类提交：版本号 bump（发版）与 hotfix。
 dev    ← 日常集成分支。feat/* 完成后合到这里，跑完 §4 的全套检查。
feat/*  ← 单个特性，从 dev 切出，完成后合回 dev。
```

**为什么 main 要这么严**：`.github/workflows/pages.yml` 在 push main 时自动把 Web 版发布到 GitHub Pages——落到 main 的 WIP 会被**公开部署出去**。加上 tag 触发三平台构建发版，main 实际上就是"线上"。

**为什么要有 dev**：本仓库常有**多个会话/机器并行改动**（同一时间可能存在多条 `feat/*`）。没有统一集成点，大家各自从 main 切、越走越远，最后合并时冲突面很大。更麻烦的是**特性与修复会互相缠住**：`feat/mobile` 里就同时装着移动端适配和一个桌面端 bug 修复（`.sidebar[hidden]` 让侧栏收不起来），导致那个修复没法单独发版。

### 10.1 日常

```bash
git checkout dev && git pull
git checkout -b feat/your-change
# …改代码 + 跑 §4 的验证循环…
git checkout dev && git merge --no-ff feat/your-change && git push origin dev
```

### 10.2 发版

```bash
git checkout dev && git pull
git checkout main && git merge --no-ff dev     # main 只做这一次合并
# 按 §5 同步 6 处版本号 + 写 CHANGELOG → cargo check 对齐 Cargo.lock
git commit -m "release: X.Y.Z（…）"
git tag -a vX.Y.Z -m "X.Y.Z：…"
git push origin main --follow-tags             # 触发 CI 三平台构建 + Pages 部署
# CI 出包后 → scripts/release.mjs --no-build 发 gitcode + 更新 latest 更新通道
```

> **hotfix**：从 main 切 `fix/*`，修完合回 main 并发补丁版，同时**把这个修复也合回 dev**，否则下次从 dev 发版会把修复覆盖掉。

