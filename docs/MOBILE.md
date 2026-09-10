# ShuyoNote 移动端适配（M16 全端通吃 · WebView 壳）

> 路线：**平台无关核心 + 可插拔平台壳**（见 `docs/plans/2026-08-24-cross-platform-plan.md`）。移动端（安卓 / iOS / 鸿蒙）复用 **Web 版**（`web.ts` + sql.js WASM）作为核心，套进各平台 WebView 壳，通过 **JSBridge** 补齐浏览器缺失的系统能力。

## 1. 技术路线（B：WebView 壳，复用 Web 版）

移动端的核心功能（编辑器 / Lexical / 数据库 / 属性 / 检索 / PDF / 版本 / 备份 / 同步）**已由 Web 版全部实现**（`src/lib/platform/web.ts` 是从 Tauri 抽象出来的浏览器宿主）。移动端壳 = 在各平台 WebView 里加载 `dist-web` 构建产物 + 注入最小 JSBridge。

- **安卓**：`android.webkit.WebView` 加载 `dist-web/index.html`。
- **iOS**：`WKWebView` 加载同一份。
- **鸿蒙**：`ArkWeb`（见 `docs/鸿蒙桌面版计划.md`，方案 1 一致）。

> 这样一套前端（`web.ts`）同时跑桌面（Tauri）、浏览器、安卓、iOS、鸿蒙——无需为每个平台重写。

## 2. MobileBridge 接口（`src/lib/platform/mobile.ts`）

WebView 壳在 `window.__SHUYONOTE_MOBILE__` 注入以下**可选**桥接方法（缺任一都回退浏览器默认，保证降级可用）：

| 方法 | 用途 | 无 bridge 时 |
|---|---|---|
| `openUrl(url)` | 用系统浏览器/外部 App 打开外链 | `window.open` |
| `convertFileSrc(path)` | 把内容寻址附件路径改写为 WebView 可加载的 URL | 原样返回 |
| `readAttachmentBytes(id)` | 读附件字节（base64） | 无（附件走 blob） |
| `saveBytes(fileName, base64)` | 保存文件到系统/分享面板 | 无 |

`web.ts::createWebPlatform` 的 `opener.openUrl` / `asset.convertFileSrc` 已优先用 bridge（见 `d237c64`）。其余平台能力（dialog/event/webview）在 WebView 里用浏览器原生（`web.ts` 已实现）。

## 3. 各平台壳（原生工程，待补）

> **环境结论（2026-09）**：**Tauri 原生 iOS 全链路**（`cargo tauri ios init/build`）在当前 Mac（无 Homebrew + 系统 Ruby 2.6）**不可行**——它会逐个要求 `brew` 装系统工具（xcodegen / libimobiledevice / …），且强依赖 **CocoaPods**（`pod install`，在旧 Ruby 上安装极慢/易卡）。已装好：Xcode 26.6 + iOS Rust targets + Tauri CLI（真实 node）+ xcodegen 2.46.0。**渲染验证建议用 WebView 壳路径**（复用 Web 版，无需 Tauri 原生全链路）；Tauri 原生 iOS 留给具备 Homebrew / 正常工具链的环境。
>
> 移动端适配以 **M16 平台无关核心 + 可插拔平台壳**为路线：核心 = Web 版（`web.ts` + sql.js WASM），壳 = 各平台 WebView + 最小 JSBridge。

### 原生壳（安卓 WebView / iOS WKWebView / 鸿蒙 ArkWeb）

- **宿主**：
  1. 加载 `dist-web/index.html`（Web 层复用 Web 版构建产物）。
  2. 注入 `window.__SHUYONOTE_MOBILE__`（openUrl / convertFileSrc / saveBytes 由原生 JSBridge 实现）。
  3. 处理文件选择（`dialog.open` 在 WebView 里走 `<input type=file>`，`web.ts` 已支持 `pickBrowserFiles`）。
- **数据持久化**：Web 版用 sql.js WASM + IndexedDB，移动端 WebView 的 IndexedDB 天然可用；附件走 `blobStore`（IndexedDB）。
- **同步**：`web.ts` 的 `sync_now`/`sync_workspace` 是浏览器 stub（Web 版不支持多设备同步）；移动端同步需**原生 JSBridge 或走鸿蒙 ArkTS 原生同步客户端**（见鸿蒙方案阶段 2）。

## 4. 建议实施顺序

1. **（已做）** `web.ts` + MobileBridge 抽象（bridge 探测 + openUrl/convertFileSrc 优先）——`d237c64`。
2. **WebView 壳宿主**：每个平台一个最小 WebView 加载 `dist-web` + 注入 bridge（需原生工具链）。
3. **原生 JSBridge**：实现 `convertFileSrc`（虚拟文件/自定义 scheme）+ `saveBytes`（保存/分享）。
4. **同步**：移动端复用 `web.ts` 的 stub 或接入原生同步客户端（鸿蒙已有方案）。

## 4.1 窄屏导航（浮层化）

窄屏（≤768px）下三处「常驻栏」全部改成浮层，把宽度还给内容：

| 元素 | 桌面 | 窄屏 |
|---|---|---|
| 左侧竖条（activity bar） | 常驻在布局流内（48px） | **浮层**，默认收起；左下角小圆钮唤出，点遮罩或点里面任何按钮即收回 |
| 侧栏（页面树） | 常驻列 | 左侧抽屉 + 遮罩，选完自动收起 |
| 右抽屉（AI / 评论 / 目录） | 固定宽侧板，主区 `padding-right` 让位 | 全屏叠加，**让位内边距清零**（否则主区内容盒被挤成 0 宽） |

## 5. 测试与验收

### 5.1 单测

- `pnpm test`（vitest）：`mobile.test.ts` 验证 bridge 探测 / 回退 / 优先；`useMobile.test.ts` 验证窄屏判定；`useGlobalShortcuts.test.ts` 验证侧栏快捷键守卫；`activity.test.ts` 验证侧栏开合的持久化语义 —— **109 passed**。
- 每个平台壳在真实设备上：打开外链走系统、附件可读、编辑/数据库/检索正常。
- 同 Web 版回归（`scripts/smoke-web.mjs`）。

### 5.2 布局验收（真实浏览器）

```bash
pnpm dev:web                # 另开一个终端
pnpm test:mobile-layout     # 有失败即非零退出
```

`scripts/verify-mobile-layout.mjs` 用真实 Chromium 在 **390×844（手机）** 与 **1280×800（桌面）** 两种视口下断言 40 项行为，覆盖的全是**单测够不到的交叉地带**（CSS 层叠 + matchMedia + z-index + localStorage）：

| 断言 | 为什么必须由真实浏览器验 |
|---|---|
| 侧栏默认收起（`display:none`） | `.sidebar{display:flex}` 会压过 `[hidden]{display:none}`，元素照样可见且不报错 |
| 左侧竖条默认收起、主区拿到全宽 390px | 竖条收起靠 `translateX(-100%)`，**`display` 仍是 flex**——判"可见"必须看几何（右边缘是否在视口内），看 display 会漏 |
| 竖条展开是浮层，不挤主区宽度 | 常驻 48px 在 390px 视口上吃掉 12%；浮层化后内容明显变宽（标题从折两行变一行） |
| 窄屏显示开合按钮 / 桌面不显示 | 媒体查询只在真实视口下求值 |
| 点按钮 → 抽屉滑入 + 遮罩出现 | 触屏没有 hover，收起后没有入口是"能用但没人找得到" |
| 点遮罩 → 抽屉关闭 | 遮罩中心点被侧栏盖住，交互层级（z-index）必须实测 |
| 抽屉打开时遮罩挡住右侧悬浮工具栏 | 同上，`elementFromPoint` 才能判定 |
| 打开 AI / 评论 / 目录面板时，主区 `padding-right=0` 且不超出视口 | 桌面端的让位规则（`body.is-ai-open .main`）在窄屏会把主区内容盒挤成 0 宽，并把 `.main` 顶出 `.app-body`——flex 项缩不到 padding 以下 |
| 移动端自动收起**不写** localStorage | 写了会污染桌面端偏好（手机上开过一次，桌面端下次启动侧栏就是收起的） |

> 两个断言都验证过"确实会失败"：删掉 `.sidebar[hidden]` 兜底规则 → 6 项失败、退出码 1，直指 `display=flex`；去掉窄屏的 `padding-right: 0` → 主区宽度被顶成 380px（视口 342px）、`right=428`。

前置：本机有 Chrome/Chromium（`PUPPETEER_EXECUTABLE_PATH` 或 `CHROME_PATH` 可指定），以及已启动的 web 开发服务。`--shots <dir>` 可顺便存图。依赖只用 `puppeteer-core`（不含浏览器下载）。

> 该脚本本身验证过「能失败」：临时删掉 `.sidebar[hidden]` 兜底规则后，它会报 6 项失败并以非零码退出，直指 `display=flex`。

## 6. 边界（诚实标注）

- **WebView 壳不改变内核是浏览器**（见 `docs/harmony-web-ceiling.md`）：真实文件系统、系统级性能、原生 OCR/加密 / mpdf 等桌面原生能力不可用；这些在移动端以 Web 版能力为准。
- **同步**：Web 版不支持多设备同步（`web-sync-boundary.md`），移动端若要同步需原生实现。
