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
| OCR / AI 识别 | 本地 tesseract（`ocr.ts` + `createOcrWorker`；语言包约 30 MB 按需下载 + IndexedDB 缓存，首次使用需联网一次）+ 视觉大模型（`ai/ocrVision.ts`） | `src/lib/ocr.ts`、`src/lib/ai/ocrVision.ts` |
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

> **PDF/OCR 资源**：`dev`/`dev:web`/`build` 前自动跑 `scripts/copy-pdfjs-assets.mjs`（PDF CJK→`public/pdfjs`）与 `scripts/copy-tesseract-assets.mjs`（tesseract worker + core→`public/ocr`）；两者是 gitignore 的生成物，`pnpm install` 后由脚本生成。
>
> ⚠️ **语言包（traineddata，29.6 MiB）自 2026-09-13 起不再随包分发**，改为首次使用 OCR 时按需下载并缓存（来源见 `src/lib/ocr.ts` 的 `DEFAULT_OCR_LANG_BASE`，托管规矩见 `docs/nginx-ocr.conf`）。理由：Android 上它会被装两遍（APK 的 `assets/` + `.so` 里 Tauri 内嵌的前端副本），实测见 上线计划（已移入私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md`） §3。
> 完全离线的发行版：`SHUYONOTE_OCR_BUNDLE=1` 让脚本把语言包拷回 `public/ocr/tessdata`，**并同时设** `VITE_TESSERACT_LANG_PATH=/ocr/tessdata`（两处必须一致，`pnpm check:ocr-assets` 会拦住只设一半）。

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

> **一条命令先跑起来**：`pnpm verify`（纯 Node 默认组，约 20 秒；`pnpm verify:all` 追加真实 Chromium 档，
> `pnpm verify:rust` 跑 `cargo test`）。门禁清单的单一事实来源是 `scripts/lib/gates.mjs`——
> 本地与 CI 跑的是**同一份**，不要再照 CI 的 YAML 手抄命令。结果、断言数基线与覆盖边界见
> [回归测试体系](TESTING.md)。下面是逐条命令，等价但更细，便于单点排查。

> **这些检查现在由 CI 跑**（`.github/workflows/ci.yml`，push/PR 到 `main` 或 `dev` 时触发，另有每日定时回归）：类型检查、vitest、smoke-web、两设备同步验收、版本/命令契约/文档链接、**浮层登记门禁**（`check:overlays`）、**workflow YAML 窄规则**（`check-workflow-yaml`），外加一档用真实 Chromium 的移动端布局验收（`test:mobile-layout`）。每轮跑完会把汇总写进 **step summary** 并上传 JSON 报告（artifact，30 天）。**需要服务端的两个集成脚本不在这里**（要一个跑着的同步服务端），它们在服务端仓库的 CI 里——那边构建二进制后，clone 本仓拿脚本去打它；状态登记在 `tests/external-suites.json`。
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

# 3. 类型检查（**别用 `npx tsc`** —— 理由见下面的「工具坑」第 1 条）
pnpm exec tsc --noEmit

# 4. 前端构建
pnpm build                            # check-versions + tsc + check-web-commands + vite build

# 5. Rust 检查（会重生成 src-tauri/Cargo.lock，版本号改动后必跑）
cargo check --manifest-path src-tauri/Cargo.toml

# 6. 文档相对链接（改动文档 / 挪动文件后跑）
pnpm check:doc-links                  # 期望 "N 条相对链接全部可达"

# 7. 移动端布局验收（改了侧栏/响应式 CSS 时跑；需本机 Chrome + 已启动 pnpm dev:web）
pnpm test:mobile-layout               # 期望 "N 通过 / 0 失败"

# 8. 移动端浮层验收（改了浮层/弹窗/断点/滚动锁时跑；同样需要 pnpm dev:web）
pnpm test:mobile-overlays             # 期望 "N 通过 / 0 失败"

# 9. Android 壳适配层的注入自检（改了 scripts/android-mobile-shell.mjs 或 gen/ 时跑）
pnpm check:android-mobile-shell       # 期望 "✅ …（--check）"

# 10. 浮层登记门禁（加了/改了任何浮层组件都要跑；纯静态，秒级）
pnpm check:overlays                   # 期望 "22 通过 / 0 失败"


## 工具坑：**"失败得像成功"**的那几种（2026-09-19 汇总）

这几条的共同点：**它们不报错**，或者报出来长得像别的东西。见到就按这里的处置做，别先怀疑自己的改动。

### 1. `npx <工具>` 在 `.bin` 缺失时**会从 registry 装一个同名包**

`.bin` 不完整时（例如有人正在重装 `node_modules`），`npx tsc --noEmit` **不会说"找不到 tsc"**，
而是装一个叫 `tsc` 的同名包（`tsc@2.0.3` 是个专门提醒人别 `npm i -g tsc` 的占位包）：

```
npm warn exec The following package was not found and will be installed: tsc@2.0.3
This is not the tsc command you are looking for      ← 退出码看着还是 0
```

**两处实测**：Windows 侧在**共享检出重装 `node_modules` 期间**撞到（`@esbuild/win32-x64`、`tinyexec`
也跟着缺）；macOS 侧在**全新 worktree 还没 `pnpm install`** 时撞到同一句。
⇒ 处置：动手前先确认工具在（`node_modules/.bin/vitest`、`node_modules/typescript/lib/tsc.js`），
命令用 `pnpm exec <工具>` 或直接点名入口（`node node_modules/typescript/bin/tsc --noEmit`）。

### 2. 别把"版本号高"当成假包 —— 判断假包看 `bin`/`lib`，不看版本

本仓 `package.json` 里 `typescript` 就是 **`~7.0.2`**（TS 7 是原生编译器，`tsc --noEmit` 跑 **0.7 秒**是正常的，
不是"没干活"）。我看到 `Version 7.0.2` 时先怀疑了假包，是**误报**。
真要判断：看 `node_modules/<包>/package.json` 的 `bin` 指向与 `lib/` 是否齐全，
以及 `node_modules/.bin/<工具>` 是不是指向它。

### 4. 在 DSH 会怀里跑"按 `argv[0]` 推自己是谁"的 CLI 包装会**启动即歪**（macOS 实测）

DSH 桌面版把 Node 内嵌在 Helper 里跑，于是被它启动的进程里
`process.argv[0]` / `process.argv0` / `process.execPath` **全都是**
`/Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper`。
后果不是一个参数被吞，而是**启动阶段就错**：

```
$ pnpm tauri build --bundles app          # 连 `tauri --version` 也一样
error: unrecognized subcommand '/Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper'
Usage: cargo-tauri [OPTIONS] <COMMAND>
```

原因：`@tauri-apps/cli/tauri.js` 用 `process.argv` 推 bin 名（`binStem` 匹配 `/node|nodejs|bun/…`），
拿到 Helper 路径后推不出 bin 名，就把那个路径原样传给了下游的 `cargo`。

**处置（本机已验证可用）**：绕开 JS 包装，直接调它的程序化入口 ——

```js
const { run } = require('@tauri-apps/cli/main.js')   // 注意：用 CJS；ESM 里 require 需 createRequire
run(process.argv.slice(2), 'tauri').then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
```

用这个 runner 跑 `build --bundles app,dmg` 一切正常（本机的 `.app`/`.dmg` 就是这么产出的）。
`npx` / `pnpm exec` 不一定中招（它们的 shim 多走一层 shell），但**任何**只信 `argv[0]` 的包装在会怀里都危险。

★ **更省事的处置（2026-09-22 实测，本轮的 `.app`/`.dmg` 就是这么建的）**：把**真 node** 放到 `PATH` 最前面，
劫持就被绕开了 —— 因为 `tauri.js` 拿到的 `process.argv[0]` 终于是 `.../bin/node`：

```bash
export PATH="$HOME/.local/node-v24.20.0-darwin-arm64/bin:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
pnpm tauri build --bundles app,dmg --config /tmp/tauri-ci-config.json   # ✅ 正常构建
```

（这份 `PATH` 里的 `pnpm` 也是真 node 装的那份；会怀的 `.desktop-bin` 里 `node`/`pnpm` 都是指向 Helper 的 shim，
它们**排在后面**就不会被选中。`pnpm verify` 之类的普通命令不受影响，只有"按 `argv[0]` 推自己是谁"的包装会歪。）

### 3. 共享 `node_modules` 在"有人重装"的那几分钟对**所有人**不可用

症状是**缺依赖形状的红**（`@esbuild/win32-x64` 缺失、`tinyexec` 找不到），
很像"这台机器坏了"而不是"有人在装东西"。⇒ 见到这类红先看环境，别先怀疑代码；
**要重装请先在信箱说一句**（约几分钟），和我们对"占用端口/共享库"的做法一致。
另：worktree 里用软链共享主检出 `node_modules` 还会让 Vite 的 `server.fs.allow` 拒绝
`sql.js` 的 wasm（报 `Denied ID …sql-wasm.wasm?url`，22 个文件假红）⇒
**worktree 里跑前端测试要就地 `pnpm install --frozen-lockfile --prefer-offline`**（约 3 秒）。
```

> **`check:overlays`（`scripts/check-overlay-registry.mjs`，也串在 `pnpm build` 与 CI 的静态检查那一档）**
> 枚举仓库里渲染 `*-overlay` / `*-popover` 容器的组件，要求每个要么登记进返回栈
> （`useOverlayLayer`）**且**在 `test:mobile-overlays` 的 `OVERLAYS` 里被量到，要么在脚本内
> **显式豁免**并给出理由。它是被真机复验的第 6 个问题逼出来的：**版本历史弹层漏登记**
> ⇒ 按返回键直接退出应用，而当时所有检查都是绿的（手写清单只检查已经写上的那些层）。
> 判据 A–D 与豁免清单见 `docs/MOBILE.md` §4.1.4。

> **`test:mobile-overlays` 覆盖 19 层浮层 × 3 个视口（360×640 / 390×844 / **792×360 横屏**）+ 桌面**，
> 并额外注入 `--sat` / `--kb` 变量量"系统 inset / 软键盘让位"那一半。
> 横屏那一档是 2026-09-15 补的：只测竖屏时，`min-height:420px` 压过 `max-height` 导致
> 底部被裁 84px 这类坏法完全量不到（**当时的断言只量了 `min-width`，高度轴空着**）。
> 详见 `docs/MOBILE.md` §4.1.4 与 §4.2。

> **`check:android-mobile-shell` 对应的是"只有真机看得见"的那一类回归**：
> `src-tauri/gen/` 不入库（可重建），所以窗口 inset 桥与返回键回调**只能脚本化注入**
> （`scripts/android-mobile-shell.mjs`，CI 里排在 `tauri android init` 之后）；
> 注入漏了不会编译失败，只会在手机上表现为"顶部点不到"与"返回键退出应用"。
> 真机断言另有 `node scripts/android-mobile-shell.mjs --device-check`（需 adb + 调试包），
> 判据见 `docs/MOBILE.md` §4.2.4。

> **`test:mobile-layout` 补的是单测够不到的盲区**：侧栏的移动端行为藏在「CSS 层叠 + matchMedia + z-index + localStorage」的交叉处，用 happy-dom 测不出来（它不按视口重算媒体查询）。脚本用真实 Chromium 在 390×844 / 1280×800 两种视口下断言 43 项，详见 `docs/MOBILE.md` §5.2。依赖只用 `puppeteer-core`（不含浏览器下载），找不到 Chrome 会明确报错而不是静默跳过。

> **命令契约守卫**（`scripts/check-web-commands.mjs`，已并入 `pnpm build`）校验三件事：Rust 命令 ⊆ `web.ts`、Rust 命令 ⊆ `CommandMap`、**`CommandMap` 顶层参数键必须是 camelCase**。第三条是运行时坑的静态兜底——**Tauri 2 只接受 camelCase 参数键**并在运行时映射到 Rust 的 snake_case 形参，传 `server_url` 会报 `missing required key serverUrl`；而 TS 查不出来（契约和调用点会「一起错」）。`args: { args: {...} }` 这种「整个结构体当一个参数」的写法除外，内层字段仍是 serde 的 snake_case。

> [!] **组件 / hooks 类改动要有渲染级测试**（1.85.1 白屏事故的教训）。上面那一整套检查**一个都不渲染 React 组件**：vitest 只跑纯函数，`tsc` / `cargo test` / 作者 CLI / 门禁都不碰 DOM。后果是真实发生过的——`CommandPalette` 里三个 `useState` 被放在 `if (!open) return null` 之后（hooks 有条件调用），**按 `Ctrl+K` 直接抛错并把整棵树卸载成白屏**，而 CI 全绿、后面几档功能照常提交，谁都没察觉。
>
> 所以：改组件（尤其是根部常驻组件、浮层、以及任何"点了才打开"的状态切换）时，顺手写一条真的把组件挂起来的测试——`createRoot` + `flushSync` 就够，不需要 testing-library，见 `src/components/commandPaletteHooks.test.ts` 与 `src/components/errorBoundary.test.ts`。要钉的是**状态切换的每一条路径**（关→开→关、表单开着时关面板…），以及**崩了之后别人还在不在**。
>
> 渲染兜底是分层的：`main.tsx` 的整屏兜底（`AppCrashScreen`）+ App 根部浮层的 `PanelBoundary`。**新加根部浮层时给它一道边界**，否则一个渲染错误又等于整屏白。

> [!] **快捷键：清单改动要同步覆盖率映射；插件里拦按键不要用 `COMMAND_PRIORITY_EDITOR`。** `src/lib/shortcuts.ts` 是清单的单一来源（快捷键面板、文档、tooltip 都读它），但**实现分散在组件与 Lexical 插件里**——2026-09 的热修复（v1.85.2）就是这么来的：照文档逐条按键时才发现两组功能一直是死的，`InsertShortcutPlugin`（Ctrl+Alt+1/2/3/U/O/T/Q/C/L/M 共 10 条）与 `PageLinkSuggestPlugin`（`[[` 菜单的 ↑/↓/Enter/Esc，Enter 变成换行）。根因是 **Lexical 的优先级队列是 `CRITICAL > HIGH > NORMAL > LOW > EDITOR`，EDITOR 是最后一档**，而 Lexical 自己那支 `$handleKeyDown`（由 `RichTextPlugin` 在 **layout effect** 里装进编辑器）就在那一档、且对**每一次** keydown 都 `return true`；插件在 `useEffect`（被动 effect，永远晚于 layout effect）里注册，于是永远排在它后面，**一次都收不到事件**——但注册本身是成功的、清单也一致，所以当时的全部检查都是绿的。**在插件里拦按键请用 `COMMAND_PRIORITY_LOW`**（与 `SlashMenuPlugin` / `ImagePastePlugin` 一致）。
>
> 行为测试在 `src/editor/insertShortcut.test.ts`（真编辑器 + 真 `dispatchCommand`）、`src/editor/editorInputShortcuts.test.ts`（Markdown 行首语法逐字输入、`/`、Ctrl+F、空行空格）、`src/components/overlayShortcuts.test.ts`（Ctrl+K、Esc）、`src/hooks/globalShortcuts.test.ts`；闸门 `src/lib/shortcutCoverage.test.ts` 要求清单**每一条都指到一个真存在的用例**（映射表里的用例标题必须真在 `it(...)` 里），并扫出 `src/editor/plugins` 下 EDITOR 档的 `KEY_DOWN_COMMAND` 注册与「插件分支 ⟷ 文档」的双向差异。**加/改快捷键时，这四处要一起动。**

### 5. 设了 `OPENSSL_DIR` 却**没换加密后端**（macOS/国密，2026-09-19 实测）

给 `libsqlite3-sys`（SQLCipher）换加密后端靠 `OPENSSL_DIR`。但**只设它没有用**：
该 crate 的 `build.rs` 只为 `SQLITE_MAX_*` / `LIBSQLITE3_FLAGS` / `SQLCIPHER_{INCLUDE,LIB}_DIR`
这些声明了 `rerun-if-env-changed`，**没有为 `OPENSSL_DIR` 声明** ⇒ cargo 认为"环境没变" ⇒
**构建脚本根本不重跑**，产物还是旧后端。症状是**"失败得像成功"的典型**：编译通过、测试全绿、
你以为换过了，其实一行都没换。

```bash
cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml   # ← 逼它重跑，这步不能省
OPENSSL_DIR=$HOME/tongsuo-macos/install cargo build --lib --manifest-path src-tauri/Cargo.toml
node scripts/check-crypto-backend.mjs     # ← 拿**产物**说话，不看你设了什么环境变量
```

`check-crypto-backend` 的三种状态分得很清：没产物 ⇒ `!` 自报跳过；最新产物 ≠ 声明 ⇒ 红（附上面那条清库命令）；
存在更旧且分类不同的产物 ⇒ `!` 提示（那正是"沉默不换后端"留下的痕迹）。换后端顺带要过
`security::tests::exactly_one_page_cipher_fixture_opens_and_the_other_is_refused`
（两份内容相同的加密库夹具：`src-tauri/tests/sqlcipher-backend-fixture.db`＝**AES 页**、
`sqlcipher-sm4-page-fixture.db`＝**SM4 页**）——它断言"**恰好一个能开**"，红了就等于
**这份构建读不了它本该读的那种库**（页加密是库文件的属性，见方案 §3.3 判据 1）。

#### 5.1 ★ 跑**应用层**的国密读数时，`--features sm-library` **不能省**（2026-09-22 实测，我自己踩的）

这是第 5 条的同族坑，但**更隐蔽**：`scripts/sm-library-build.mjs` 只在它执行的 `cargo build` 那一句上加了
`--features sm-library`；后面的 `cargo test` / `cargo run` 是你自己敲的 —— **不加这个特性，应用里
`set_cipher_key` 那段国密接线会被 `#[cfg]` 整个编掉**，于是：

- 库仍然是"认识国密标签"的库（补丁在源码上、`page_cipher=sm4`），
- 而**应用一行国密参数都没设** ⇒ 写出来的库仍是 SHA512 参数，
- 你却在读"国密构建"的读数。**两次读数会互相矛盾**（同一份文件"既被默认参数读开、又被国密参数读开"），
  因为其中一次根本不在测你以为的那件事。

```bash
node scripts/sm-library-build.mjs --openssl-dir $HOME/tongsuo-macos/install
# 应用层读数（接线后的构建）——这两个都要：
OPENSSL_DIR=$HOME/tongsuo-macos/install cargo test --lib --features sm-library security::
# 库层读数（provider 能力，不需要特性开关）：
cargo test --lib gm_provider::
```

> **同族第二件（同一天）**：`scripts/sm-library-build.mjs --check` 的帮助文字是「只做构建前的核对，不构建」，
> 但它原先照样 `apply: true` ⇒ **一次核对就把补丁打到全机共享的 registry 源码上**（我拿它确认"源码干不干净"，
> 结果它把源码变成了"打过补丁"的样子 ⇒ "我刚还原过"当场变成假话）。已修（`patchApplyDecision` 纯函数 ＋
> `apply: !noApply && !checkOnly` ＋ 3 条判据 ＋ 变异证明）。**核对是只读动作**：想改状态就显式跑构建或 `--revert`。

三处防线（2026-09-22 加）：① 胶水收尾横幅直接写明这条口径；② `build.rs` 在"源码有补丁但没开 `sm-library`"时
打 `cargo:warning`（不 panic：`--no-default-features` 回滚通道需要在补丁仍在源码上时照样能跑）；
③ `node scripts/gm-version-selfcheck.mjs --with-tests` 的**第 ⑤ 段**就是
`cargo test --lib --features sm-library security::`（＋`OPENSSL_DIR`），删掉任一个，判据立刻红（有变异证明）。

### 6. 门禁"查的产物"可能**不是你这台机器**的（构建目录被重定向/共用时）

判据读 `target/` 下的产物时，有两个默认假设**经常不成立**：① target 就在仓库里（实际很多人设了
`CARGO_TARGET_DIR`，或 CI 用共享缓存）；② 目录里最新那份产物就是**当前平台**的（实际可能混着 Windows 的）。
两者任一不成立，门禁就会**读到别的平台的产物并报 ✓** —— 比红更难发现，因为它长得完全正常。
实例：`scripts/check-crypto-backend.mjs` 第一版在 WSL 上读到的是 Windows 那份，`✓ openssl`
的 link-search 甚至写着 `Files\OpenSSL-Win64\lib`（2026-09-19，AMD 抓出）。

处置：**产物判据必须（a）认 `CARGO_TARGET_DIR`，（b）按当前平台过滤，（c）过滤后只剩别的平台时报"未实查"而不是 ✓**。
"未实查"是一个合法且必要的结论 —— 判据的名字不能比它能证明的多。

### 7. `cargo` 不在 `PATH` 上时，脚本会把它报成**别的东西**

rustup 装在 `~/.cargo/bin`，而有些环境（含本会话的默认 shell）**不把**它带进 `PATH`。
此时凡是要 shell out 到 cargo 的脚本都会失败，而报错**长得像业务问题**：

```text
gm-conformance: ❌ 夹具编不过
spawnSync cargo ENOENT
```

看起来像"夹具坏了"，其实是"找不到 cargo"（2026-09-19 我自己就被这条误导过一次）。
处置：跑之前确认 `command -v cargo`；`scripts/gm-version-selfcheck.mjs` 已内置兜底
（PATH 上没有、但 rustup 默认位置有时补上，并**打印一行 `!`** 说明，不静默改环境）。

### 8. `node` 有两份时，**同一个判据会红绿不同**（2026-09-22 实测，我自己撞上的）

本机有**两份 node**：DSH 会怀里那份 `/Users/shuyo/Library/Application Support/dsh-desktop/harness/.desktop-bin/node`
（**v24.18.1**）与 `~/.local/node-v24.20.0-darwin-arm64/bin/node`（**v24.20.0**）。PATH 上哪个在前，
决定的不只是"能不能跑 `pnpm tauri`"（那条坑见 `docs/development.md` 的 tauri 一节），
**还决定个别判据的红绿** —— 因为那是**库行为本身变了**，不是我们的代码变了：

```text
scripts/session-grep.test.mjs「截断的帧也不抛错」
  node 24.18.1 ⇒ zstdDecompressSync(截断帧) 不抛，返回 "这一�"     ⇒ 判据绿
  node 24.20.0 ⇒ zstdDecompressSync(截断帧) 抛 Z_BUF_ERROR         ⇒ 判据红（5 次跑红 5 次）
```

症状最有误导性的一点：**全库 `vitest` 那一次跑是绿的、单独跑这个文件却是红的**（两边用的是不同的 node）。
处置（已落地）：判据不再钉"某个 zlib 版本的实现细节"，只钉两个版本**共同**的事实
（截断一定丢数据：要么半截、要么报错；"没报错"≠"读全了"），并在注释里**同时记下两份读数**。
⇒ 通用教训：**判据里任何"某个依赖的实现细节"都是一颗定时炸弹**；要钉就钉"我们自己的实现必须满足什么"。
（本轮同一形态还有一条：`vite/vitest` 别的红是 Windows 侧报的另外三条，与本条无关。）

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
   git tag v<version> \
     && git push origin v<version> && git push github v<version> \
     && git push origin main && git push github main
   ```
   > **为什么 tag 与 main 都推两个远端**（`origin` = gitcode、`github` = GitHub，两个是各自独立的仓库）：
   > `release.yml` 三平台构建与 `pages.yml` 的 Pages 部署都是 **GitHub Actions** 的工作流，**只有 GitHub
   > 这个仓库收到 tag / main 才会跑**——只推 `origin` 的话发版件根本不会开始构建；反过来只推 `github`
   > 的话 gitcode 上没有 tag，而 gitcode 是应用内「检查更新」与下载通道，用户收不到新版。
   > 口径与 [RELEASING.md](RELEASING.md) ④ 一致。
   >
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

### 8.1 「记得登记」已经**不是靠记得**（2026-09-22 起由门禁拦）

上面那句"新增文档记得登记"原先只是一句嘱咐，实测会漂移：`docs/plans/` 到 **71 篇**时，有 4 篇
**没进 `docs/README.md` 的方案索引**，而**死链判据抓不到**（链接没坏，只是没人找得到）。
⇒ 现在有三条**可执行**规矩（都在 `node scripts/check-doc-links.mjs`，跑在 `pnpm verify` 的 `contract` 组里）：

| 规矩 | 拦的是什么 |
|---|---|
| **方案索引一一对应** | `docs/plans/*.md` 每个都必须在 `docs/README.md` 的表里有一行，且右列**有内容**（不是空、不是破折号）。⚠️ **只在正文里提一句不算登记** —— 判据只认表行（第一版用全文件匹配，变异当场证明"提一句就能变绿"）。纯函数与变异在 `scripts/lib/docs-index.mjs` / `.test.mjs` |
| **相对链接可达** | 把路径按"自己在 `docs/` 根目录"写（如 `plans/x.md`，正确是 `x.md`）—— 这是本仓真实踩过的一类 |
| **「快速导航」左列是「我想了解…」** | 新增方案时顺手把"文档 → 内容"形态的行插进导航表（两张两列表长得一样、语义不同；死链判据看不见） |

- **刻意不判的反向**：`docs/README.md` 里**允许**出现指向私有仓 `shuyonote-sync-server` 的 `plans/x.md` 路径
  （如 M27 那行）。"提到的必须存在"会对着一条**正确的**说明喊红。
- 所以新增一篇方案的标准动作：写 `docs/plans/YYYY-MM-DD-xxx.md` → 在 `docs/README.md` 的方案索引里加一行
  （一句话说清"这篇讲什么"）→ `node scripts/check-doc-links.mjs` 绿。

## 9. 常见坑

- **`Missing environment variable OPENSSL_DIR`（Windows）**：`rusqlite` 的 `bundled-sqlcipher` 要链接系统 OpenSSL，Windows 必须显式给路径 —— 装了 OpenSSL 也要导 `OPENSSL_DIR`（最常见就是「装了但没设变量」）。详见 **§2.3.1 OpenSSL（Windows 必做）**。
- **`cargo test` 编译得过、跑不起来：`0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`（Windows，2026-09-15 排查记录）**：
  进程**在加载期就死**，一条用例都跑不了，而 `cargo check` / `cargo check --all-targets` / 应用本身都正常。
  ⚠️ **这不是代码问题**（同机器上 `shuyonote-sync-server` 的 `cargo test` 正常，29+3 通过）。
  **已经用证据排除的假设**（别重复挖）：

  | 假设 | 证据 | 结论 |
  |---|---|---|
  | OpenSSL 版本不一致 | 三份 `libcrypto-3-x64.dll`（`OpenSSL-Win64\bin`、`System32`、`target\…\deps`）**SHA-256 完全相同** | ❌ 排除 |
  | `PATH` 上 Python 自带的旧 VC 运行时抢先 | `vcruntime140.dll` 确实解析到 `C:\Python313\`；把 `System32` 提到最前仍失败 | 🟡 真隐患，非病因 |
  | `deps\` 下有陈旧同名 DLL | 只有 `libcrypto`/`libssl`/`shuyonote_lib.dll`；把 exe 拷到**空目录**单独跑，照样 `0xc0000139` | ❌ 排除 |
  | Debug CRT 版本旧（**关键线索**） | `dumpbin /dependents` 显示它导入 **`ucrtbased.dll` / `VCRUNTIME140D.dll` / `MSVCP140D.dll` / `VCRUNTIME140_1D.dll`**（**Debug** CRT，不是发布版）；把 14.44 工具集自带的 `Microsoft.VC143.DebugCRT` 与 SDK 的 `x64\ucrt` 放到 `PATH` 最前仍失败 | ❌ 排除（但**这条线索本身很有用**：任何机器上跑这个测试二进制，都必须能加载 **Debug CRT**） |
  | 是 `LIB` 里 OpenSSL 的 **`MDd`**（debug）导入库把它带成 debug CRT 链接（`dev.ps1` 正是 `MDd;MD` 这个顺序） | 只留 release 的 `MD`、删掉测试 exe 强制重链后仍失败 | ❌ 排除 |

  **仍未定位**。下次接手建议从"能加载 Debug CRT 的最小复现"入手（先确认一个只 import Debug CRT 的极简 Rust 测试二进制在本机能否加载），
  把范围从"整个 crate 的依赖链"缩到 CRT 加载本身。
  **在此之前：本机所有 Rust 单测只能过 `cargo check --all-targets` 的编译检查，不能当"已验证"。**
- **vitest 默认单测超时 5 s —— 端到端 / live 类判据必须自己给超时**（2026-09-22，一周内**三次同源**）：
  签名一模一样：报 **`Test timed out in 5000ms`**（不是断言不等），而且**每次红的集合不同**（排队/负载抖）。
  三次实例：① 我的 `localTranscribe.live.test.ts` 在**唯一有模型服务的机器**上第一跑就红 2 条 —— 本机 TTS 每次 ~3.4 s，
  而 live 族是**多个文件并发**打同一个服务；② Windows 侧 `check-sys-deps` 的端到端在那台要 6.2 s（脚本本体 `node scripts/check-sys-deps.mjs` 1 秒内 exit=0）；
  ③ 疑似同族：`overlayShortcuts` 的 Esc 用例（**macOS 上 20 ms 绿**，未定论）。
  ⇒ 规矩：**凡是"要等外部东西"（模型服务、真浏览器、子进程、端到端链路）的判据，显式给第三参数超时**；
  排查时先看错误原文是 `timed out` 还是断言 —— 两者修法完全不同。
  ★ 更要紧的一条同族纪律：**一条从未在任何地方跑过的判据等于没有判据**（①就是"三台机器都 skipped、第一次真跑才暴露"）。
- **中文乱码**：只能用编辑工具写 UTF-8；shell 重写会坏（`>` 重定向在 PowerShell 里写的是 UTF-16，`Get-Content`/`Set-Content` 往返会把中文写成 GBK 乱码——本项目已因此损坏过 `commands.ts` 与两个预览文件）。从 git 取回旧版本用 `git checkout <commit> -- <path>`，让 git 自己写字节。
- **验证与提交分两步**：PowerShell 的 `;` 不会因前一条失败而中断，`tsc/build` 失败后 `git commit && git push` 照样会跑——曾因此把编译不过的版本推上远端。先跑验证、看退出码，再单独提交。
- **换行符（autocrlf）**：仓库用 `.gitattributes`（`* text=auto eol=lf`）钉死 LF，各平台检出都是 LF；Windows 上若仍看到 `LF will be replaced by CRLF`，说明改动没走到这条规则上，**别当成正常忽略**。历史教训：v1.84.6 首次发布时 Windows runner 因默认 `core.autocrlf=true` 把文本检出成 CRLF，而 `check-capabilities` 对生成物做逐字节比对 → `pnpm build`（Tauri 的 `beforeBuildCommand`）失败 → Windows 构建整个红掉而 Linux 正常。**新写「比对生成物」的检查时必须按行尾无关比较**（`\r\n` → `\n` 后再比），否则等于给 Windows 埋一颗必炸的雷。
- **提交信息**：`git commit -m "..."` 里避免内嵌 `"` 或 `·`，否则会被拆断导致 pathspec 报错。
- **提交前先确认当前分支——而且要和提交分成两条命令**：`git branch --show-current && git add -A && git commit` 这种写法**拦不住任何东西**（它只是把分支名打印出来，提交照样执行）。同一个坑在一次会话里踩了两次：三个提交绕过 `dev` 落在 `main`；后来 M11.9 的提交又落在 `main`（`checkout main` 做完发布合并后没切回来）。正确做法是先单独跑 `git branch --show-current`、**看清输出**，再另起一条命令提交；推完用 `git ls-remote` 核对两条分支的 SHA。原文规则：项目里大量命令是「`git checkout main` → 合并 → 推送」，一旦某步改了分支没切回来，后续提交就会**直接落在 `main` 上、绕过 `dev`**（实际发生过：三个提交绕过集成分支，`dev` 落后 `main` 三个提交，直到下次推送 dev 被拒才发现）。习惯：提交前 `git branch --show-current`，推完再核对一次两条分支的 SHA。
- **推送成功要按 SHA 逐个 ref 确认，别只看输出里的某一行**：`git push origin main dev` 里 `main` 成功、`dev` 被拒（非快进）时，退出码非 0 但输出里仍有 `main -> main`——照着 `grep "main -> main"` 判成功会把**一次失败的推送**记成成功（实际发生过，因为另一条工作线把 `dev` 推到了别处）。正确做法是推完 `git ls-remote <remote> refs/heads/main refs/heads/dev` 与本地 SHA 逐一比对；两条线分叉时先弄清共同祖先，**用合并解决，不要强推**。
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
git checkout dev && git merge --no-ff feat/your-change && git push origin dev && git push github dev   # 两个远端都推：Actions（ci.yml / android.yml）只在 GitHub 侧跑，gitcode 的流水线只在打 tag 时出 Linux 包
```

### 10.2 发版

```bash
git checkout dev && git pull
git checkout main && git merge --no-ff dev     # main 只做这一次合并
# 按 §5 同步 6 处版本号 + 写 CHANGELOG → cargo check 对齐 Cargo.lock
git commit -m "release: X.Y.Z（…）"
git tag -a vX.Y.Z -m "X.Y.Z：…"
git push origin main --follow-tags && git push github main --follow-tags   # 两个远端都推：三平台构建 + Pages 部署都是 GitHub Actions（release.yml / pages.yml）
# CI 出包后 → scripts/release.mjs --no-build 发 gitcode + 更新 latest 更新通道
```

> **hotfix**：从 main 切 `fix/*`，修完合回 main 并发补丁版，同时**把这个修复也合回 dev**，否则下次从 dev 发版会把修复覆盖掉。

### 10.3 中转形态：`feat/*` → `dev` → `main`

合入路径只有一条：**特性分支合成 `dev`，`dev` 再进 `main`**。§10.1 / §10.2 的写法即此意，这里
把它写成规则和判据，免得只靠"记得"。

**为什么 `main` 必须保持可发布**：推 `main` 就等于上线——`pages.yml` 在 push `main` 时自动把
Web 版部署到 GitHub Pages，而 `github-pages` 环境的**分支策略只允许 `main`**，所以想让 Pages 跟上
新版本，唯一不违反策略的路子就是把东西真的合进 `main`（见 [RELEASING.md](RELEASING.md) §⑦ 第 2 条）。
落到 `main` 的 WIP 会被**公开部署出去**。

**"`dev` 领先 `main`" 的准确语义**（别读成"必须永远领先"）：

| 时点 | 两条分支的关系 |
|---|---|
| 有未发布的开发工作时 | `dev` **领先** `main` —— 这正是中转形态在起作用 |
| 发版时（`dev → main`） | 合并后两者**对齐** |
| `main` 上出现 `dev` 没有的提交之后 | 把 `dev` **FF 同步**回来 ⇒ 再次对齐 |

⇒ **静止时 `main == dev` 是正常的，不是异常。**

**规则：`main` 上出现 `dev` 没有的提交（例如纯清理 / 文档提交）时，随后应把 `dev` FF 同步回来**，
否则 `dev` 会白白落在后面，下次合并时白白多出一段分叉：

```bash
git switch dev && git merge --ff-only main    # 能 FF 才对；被拒说明 dev 落后得不正常，先查清来源
git push origin dev && git push github dev
git ls-remote origin refs/heads/dev refs/heads/main    # 两侧 SHA 逐一核对，别只看推送输出
git switch main                               # 别把工作区留在 dev（§9「常见坑」里两条都栽在这上面）
```

#### 10.3.0 ★ 每次发版后，把 `main` **回合进 `dev`**（版本号属于"main-only 提交"）

`release: X.Y.Z`（版本号 bump ＋ CHANGELOG 已发布段）**只发生在 `main` 上** ⇒ 它天然是"`dev` 没有的提交"，
按 §10.3 就该回合进来。**2026-09-22 实例**：`dev` 的版本号一直停在 **`1.91.10`**，而 `main` 已经 `1.91.20`
（差 10 个版本没回合），后果有两条、都不显眼但用户能看见：

1. 「关于」里显示 `v1.91.10`（`APP_VERSION` 来自 `package.json`）；
2. **开发构建天天提示「有新版本」** —— 它拿 `APP_VERSION`（1.91.10）与更新通道的 `latest.json`（1.91.20）比。

做法：`git merge origin/main`（**是 merge，不是手抄版本号** —— `check-changelog-version-parity` 的实现注释
里写明了这个口径："发布提升从 main 回合进 dev 恰恰是 merge"）。冲突面通常**只有 `CHANGELOG.md` 一处**，
解法固定：**`dev` 的 `[Unreleased]` 保持在最前**，把 `main` 的已发布段整段插到 `dev` 现有的**首个已发布段**之前
⇒ 顺序是 `Unreleased → 新发布的几段 → 原来的已发布段 → …`。回合后跑
`check-versions` / `check-changelog` / `check-changelog-version-parity` / `check-doc-links` 四条（都很快）。

#### 10.3.1 ★ 发布线的**文档修正**分支：当天合回 `main`，否则会**静默搁浅**（2026-09-22 实例）

真实发生的一次：`release: 1.91.11`（`39024800`）在 `main` 上之后，为**已发布说明**开了
`docs/changelog-1.91.11-gm-wording`（两笔**只动 `CHANGELOG.md`** 的提交：三处事实性更正 ＋
按 AMD 要求撤掉 `src_sha256` 的**具体值**）。两笔都推到了**双远端**，但**从未合回 `main`** ——
于是 `main` 上那份**已经对外发布**的 1.91.11 国密段，六天里一直带着被撤掉的具体值、
以及一句"缓解方式待定"（而缓解新门禁 `gm-registry-clean` 后来已经落地）。
⇒ **判据（一句话）**：`git branch -r --no-merged main` 里出现的、**只动 `CHANGELOG.md`/发布说明**的分支，
当天就该合回 `main`；它不影响 `dev`，所以**任何 CI/门禁都不会提醒你**。
这是"分支推上去了"与"修正在线上生效"之间的缝——`git log origin/main` 里没有那两笔，就是它。

```bash
# 收口一条发布线文档分支（非强推、只带来 CHANGELOG 改动）
git switch main && git merge --ff-only origin/main
git cherry-pick <两笔的 sha>          # 只动 CHANGELOG.md ⇒ 冲突面最小
git diff --stat origin/main           # ★ 确认只有 CHANGELOG.md
node scripts/check-changelog.mjs && node scripts/check-versions.mjs && node scripts/check-doc-links.mjs
git push origin main && git push github main
git switch dev                        # 别把工作区留在 main
```

**实例读数**（2026-09-22）：cherry-pick 两笔 ⇒ 相对 `origin/main` 只差 `CHANGELOG.md`（11 增 3 删）；
`check-changelog` / `check-versions` / `check-doc-links` / `check-changelog-version-parity` 全绿。

### 10.4 开 MR / 合并之前：**先按目标分支对一次 diff**（2026-09-17 加，AMD 侧实战踩出来的）

**规则**：把特性分支合进 `dev`（或 `dev` 合进 `main`）之前，先跑

```bash
git fetch origin <目标分支>
git diff --stat origin/<目标分支> <你的分支>
```

**判据（一条就够）**：列表里**出现你没动过的文件** ⇒ **停下查清，不要合**。

为什么值得单列成规则——2026-09-16 的真实险情：AMD 侧为了让 Rust 读数取到当前测试集，
把**当时的 `main`** merge 进了自己的 `feat/*` 分支；而那时 `dev` 上刚有一条修法
（`dc7fa13b`，只改 `src-tauri/src/sync.rs` 15 行）**还没进 `main`**。
于是"相对 `dev`"的 diff 里，那个文件显示成 **`15 --`（删除）**：
**照原样合进 `dev` 会把别人的修法回退掉**。它在开 MR 前对了一次 diff 才发现，
补上"再 merge 当前 `main`"、复检后那条消失。

> 同一类事故的另一种形态（同一天，Windows 侧）：`dev → main` 合并时把两份**语义等价**的
> `releaseArtifacts.mjs` 实现整份取了一边，差点丢掉另一边的规则。见 `docs/RELEASING.md` §⑤ 的更正说明。
> 两条的共同点：**"整份取一边"或"基于旧基线合并"都会静默删掉对方的改动，而 git 不会报冲突。**

配套习惯（都是无成本的）：

1. **分支别停在旧基线上**：动手前先 `git fetch` + rebase/merge 目标分支，别拿几天前的 `main` 当基线；
2. **合并冲突里出现文件级"整份取一边"时，逐条核对另一边的提交**：
   `git log --oneline origin/<目标分支>..<你的分支> -- <该文件>`，而不是看哪边"更新"；
3. **合完立刻复核**：`git diff --stat <合并前> <合并后>` 应当**只包含你预期的文件**。

### 10.5 交叉验证：**报告必须写明被验的 commit，且跑之前先核 HEAD**（2026-09-17 加，AMD 侧实战踩出来的）

跨机器验证（"我这边编过不算，要你那台也编过"）有一个**几乎必然发生**的假绿：

```bash
# ❌ 这样很容易在**旧提交**上跑出一个漂亮的绿
gh pr checkout ...        # 或 git fetch <remote> <branch>
cargo check --lib         # 1.57s Finished —— 看着挺好，其实分支没更新
```

AMD 实测的成因：`git fetch` 被 **`refusing to fetch into branch 'refs/heads/<branch>' checked out at …`** 挡下
（本地正检出该分支时，git 拒绝直接把远端推进来），**分支其实没更新**，于是检查在旧提交上跑完并"成功"。

**规矩（三条，都不花时间）**：

1. **报告里必须带被验的 commit**（短 hash 即可）——"我跑了，过了"不是结论，`47495fd7 = ok` 才是；
2. **跑之前先核 HEAD**：`git rev-parse --short HEAD` 与对方给的 commit 对上再跑；
3. **别用会静默不更新的拉取方式**：改用取到临时引用再落：
   ```bash
   git fetch <remote> <branch>
   git reset --hard FETCH_HEAD     # 或 git switch --detach FETCH_HEAD
   git rev-parse --short HEAD      # ← 确认是对方要验的那个
   ```
   另外**看耗时**：**增量 1–3 秒的 "Finished" 往往意味着"没编新东西"**，值得回头核一眼 HEAD。

> 与 §10.4 是同一类病：**都是"看起来完成了、其实基线或对象不是你以为的那个"**。
> §10.4 治"拿旧分支当基线"，这条治"在旧提交上验证"。

### 10.7 本机模型服务（Herdsman）：清单、两个 ASR 的分工、以及一条冒烟配方（2026-09-22 AMD 侧实测）

**服务**：`herdsman.exe`（`C:\Program Files\starwave\Herdsman\`）监听 `127.0.0.1:8080`，OpenAI 兼容
（`/v1/models`、`/v1/chat/completions`、`/v1/audio/speech`、`/v1/audio/transcriptions`）；
数据在 `%USERPROFILE%\.herdsman\`（`models/` 是模型、`launch_records/` 是启动记录），下载缓存在 `.cache\herdsman\`。
CLI：`herdsman.exe skill models {list,download --model <名字> [--wait],start,stop,status,uninstall}`。
⚠️ **从普通 shell 调 `skill models` 会"空输出且什么都没发生"**（2026-09-22 实测：`list` 0 行、
`download` 无输出且 5 min 内 `models/`、`ota_downloads/` 无变化）⇒ 它要**运行中的桌面进程**的通道；
**装模型走桌面应用的「模型商店」最稳**。判"装上了没有"要拿读数：`GET /v1/models` 多出来 ＋
`models/<名字>/` 出现且大小对得上（别只看 UI 说"已安装"）。

**清单（2026-09-22 实测，9 个）**：`DeepSeek-V4-Flash-0731`、`Qwen3.8-Flash-Next`（视觉）、
`bge-m3`（向量）、`bge-reranker-v2-m3`（重排）；
**ASR 两个**：`funasr-nano`、`sherpa-onnx-paraformer-zh-small`（79.5 MB，2026-09-22 装）；
TTS：`sherpa-onnx-vits-melo-tts-zh-en`、`edge-tts`（云端、不占盘）；图片：`zimage-turbo`。

★ **两个 ASR 的差别（同一段音频实测，别让下游静默依赖标点）**：

| 引擎 | 同一句「今天天气不错，我们下午三点开会。」的转写 |
|---|---|
| `funasr-nano` | `今天天气不错，我们下午三点开会。`（**带标点**，与原句一字不差） |
| `sherpa-onnx-paraformer-zh-small` | `今天天气不错我们下午三点开会`（**裸文本，无标点**） |

**闭环冒烟配方**（不需要外部音频；本仓**没有**短音频夹具 —— `*.wav/*.mp3/*.m4a/*.ogg` 全树无命中）：

```bash
# ① 合成：本地 TTS 造一句中文
curl -s -X POST http://127.0.0.1:8080/v1/audio/speech -H "Content-Type: application/json" \
  -d '{"model":"sherpa-onnx-vits-melo-tts-zh-en","input":"今天天气不错，我们下午三点开会。","response_format":"wav"}' \
  -o tts-smoke.wav
# ② 转写：用被验的那个 ASR 模型
curl -s -X POST http://127.0.0.1:8080/v1/audio/transcriptions \
  -F "file=@tts-smoke.wav" -F "model=sherpa-onnx-paraformer-zh-small"
```

⚠️ **这条冒烟的边界**：音频是 TTS 合成的**干净音**（≈3 s、无噪声、标准普通话）⇒ 它证的是"链路通、中文能认"，
**不等于**真人口音／远场／嘈杂环境也这个水平；那类结论要拿**真录音**复跑。

★ **应用里已经接上这条端点**（2026-09-22，macOS 侧）：`src/lib/ai/localTranscribe.ts`（唯一构造点，
与 `localVision` 同一条"只许本机端点"的红线）→ `attachmentDeps` → `av.transcript@1`。
默认模型 `funasr-nano`；**桌面端走原生 http（不经 WebView）⇒ 没有 CORS 这一关**，Web 端才有。
★ **live 冒烟已跑通**（2026-09-22，AMD 那台有服务）：`funasr-nano` 逐字带标点、Paraformer 只差标点、
本机 herdsman 不返回 `segments` ⇒ 契约上一段且 `loc=""`。⚠️ 本机 herdsman 没起（`ECONNREFUSED 127.0.0.1:8080`）⇒ 本机只有假端点那层；
★ 教训：**一条从未在任何地方跑过的判据等于没有判据** —— 那台机器上它第一跑就因"没给 vitest 超时"红了两条（TTS 每次 ~3.4 s），已修。
本机要复现这条读数：先用桌面应用的「模型商店」把服务起起来，再跑 `src/lib/ai/localTranscribe.live.test.ts`
（**服务不在就跳过、并把理由写进 describe 标题**：TTS 合成 → 经我们自己的通道转写 → 经 `av.transcript@1` 成段；
它**必须显式给超时** —— 本机 TTS 每次 ~3.4 s，而 live 族是并发打同一个服务的）。细节见
`docs/plans/2026-09-22-asr-wiring-plan.md` §6（含"换 ASR 模型今天不生效"那条参数优先级问题）。
**§10.5 补一双孪生形态（2026-09-18，AMD 侧复核块 ID 分支时又踩到一次）**：上面那条治的是
**本地分支没更新**，还有一种更隐蔽的 —— **`origin/dev` 这类远端跟踪 ref 静默过期**：

- 成因：clone 时 `remote.origin.fetch` 只配了 `main`（例如 `+refs/heads/main:refs/remotes/origin/main`）
  ⇒ 你 `git fetch origin dev` 之后 `FETCH_HEAD` 是新的，但 **`origin/dev` 这个 ref 不会更新**；
  随后 `git log origin/dev` / 拿 `origin/dev` 当基线，看到的还是旧的（AMD 一度停在 `bd68a608` 上复核）。
- 判据：**引用任何 `origin/<分支>` 之前**，用 `git ls-remote origin refs/heads/<分支>` 核一眼，
  或直接 `git fetch origin <分支>` 后用 `FETCH_HEAD`/`git rev-parse FETCH_HEAD`；
  根治办法是把 fetch refspec 补全（`git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`）。
- ⇒ 与本条同源：**"我看到的分支"必须是"我从远端刚拿到的那一个"**，而不是本地某个同名 ref。

### 10.6 一次真实偏差：`feat/android-mobile` 直接合进了 `main`（2026-09-14）

如实记下，因为它是"要恢复中转形态"这件事的由来：

- `feat/android-mobile`（tip `e4e2909`）**绕过了 `dev`，直接合进 `main`**：合并提交 **`31514c4`**
  （`2026-09-14 09:12`），两个父提交是 `8eb456b`（`dev` 当时所在的位置）与 `e4e2909`。
- 合并后 `dev` 被 **FF 同步**到 `31514c4` ⇒ **`main == dev`**；`feat/android-mobile` 也因此被删除
  （local / origin / github 三处），它的 tip 已完全包含在 `main` 里，**没有未合并的提交**。
- **所以这不是"改一个 SHA 就能修好"的状态**：`main == dev` 是上面那次偏差的结果，不是有人把
  `dev` 推到了 `main`。**下一版起按 §10.3 的中转形态执行**；`dev` 重新领先 `main` 的方式是
  **后续正常往 `dev` 提交**（切到 `dev` → 改 → 提交 → 推），**不是**造一个空提交或假提交去让
  `dev`「看起来领先」——那是自欺，而且会把"静止时对齐"这个正常状态误标成异常。

> **发版前判据**：确认这次进 `main` 的是 `dev`，而不是某条特性分支——`git merge-base --is-ancestor dev main`
> 为真（PowerShell 里 `$LASTEXITCODE` 为 0），且这次合并是显式写的 `git merge --no-ff dev`
> （见 §10.2）。为假 ⇒ 说明又绕过了 `dev`，**停下查清再发**。发版清单里也有一条对应的可勾选项
> （[RELEASING.md](RELEASING.md) §9.6）。

