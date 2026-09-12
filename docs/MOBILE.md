# ShuyoNote 移动端（M6 / M16）

> **路线已定（2026-09-13）**：
> **移动端 = Tauri 原生壳（Rust 内核）**；**WebView 壳路线只保留给 Tauri 不可达的平台**
> （当前只有**鸿蒙 ArkWeb**）。
>
> 执行计划见 [移动端上线计划（Android 优先）](plans/2026-09-13-android-launch-plan.md)。

## 0. 为什么是 Tauri 原生壳（这条决定要能扛住复读）

此前本文档写的是「技术路线 B：WebView 壳，复用 Web 版」（加载 `dist-web` + sql.js WASM +
IndexedDB）。2026-09-13 明确改为**安卓/iOS 走 Tauri 原生壳**，理由是**产品承诺**而不是偏好：

| 能力 | Tauri 原生壳 | WebView 壳（Web 内核） |
|---|---|---|
| 加密 | **SQLCipher 真加密**（与桌面同一套） | 无（数据在 IndexedDB 里） |
| 数据落地 | 应用私有目录里的**真实文件**，可备份、可搬移 | **浏览器存储**，会被系统回收 |
| 多设备同步 | ✅ 与桌面同一套 | ❌ `web.ts` 的 `sync_now`/`sync_workspace` 是 stub |
| 插件 | ✅ 完整（Boa 运行时） | ❌ **根本性限制**：浏览器跑不了 Rust `boa_engine`，需重做 JS 沙盒（M16.3） |
| PDF | 原生 mupdf + pdf.js 双引擎 | 只有 pdf.js |
| 体积 | 大（需专门压，见计划里的体积账） | 小 |

本应用的核心承诺是**本地优先 / 数据主权 / 离线**。把用户笔记放进**会被系统回收的浏览器存储**里，
与这个承诺是直接冲突的——所以"WebView 壳更省事"不能作为选它的理由：它省下的是体积，
而**体积在 Tauri 原生壳里是有解的**（strip + OCR 语言包按需下载），功能缺失却是无解的。

> 一句判据：**只要这个平台能跑 Tauri，就走 Tauri 原生壳。** 走不了才退到 WebView 壳，
> 并且要如实标注该平台是**能力子集**。

## 1. 各平台路线

| 平台 | 路线 | 状态 |
|---|---|---|
| **Android** | **Tauri 原生壳** | 已能构建出 APK（未签名）；见上线计划 |
| **iOS** | **Tauri 原生壳** | 未开始；**环境结论见 §5**（那台 Mac 上 Tauri iOS 全链路不可行，需先解决工具链） |
| **鸿蒙** | **WebView 壳（ArkWeb）** | Tauri 不可达 → 保留本文档原有的壳路线；见 [鸿蒙桌面版计划](鸿蒙桌面版计划.md) 与 [鸿蒙 Web 天花板](harmony-web-ceiling.md) |
| **浏览器** | Web 平台（PWA） | ✅ M16.1b 已落地，是首个 Web 壳 |

## 2. Android / iOS：Tauri 原生壳

内核与桌面**同一套 Rust**，所以「移动端能不能用某功能」的问题，答案通常等于
「那个功能有没有桌面专属假设」。已经做过的平台工作：

- **Rust 平台分支已就位**：`#[cfg(desktop)]` 7 处（`lib.rs` / `deeplink.rs` / `windows.rs`）。
  `single-instance` 只为桌面实现（移动系统本身保证单实例）；`updater` 桌面专属
  （**移动端更新走应用商店 / 重新下载**，见上线计划的 Phase 2）。
- **Android 交叉编译依赖已就位**：`[target.'cfg(target_os = "android")'.dependencies]`
  里 `openssl` vendored + `rusqlite` 的 `bundled-sqlcipher-vendored-openssl`。
- **加密不需要 Keystore 集成**：`security.rs` 的设计是**口令派生、密钥不落盘、只活在会话内存**
  （E1 的核心不变式），所以移动端没有"系统钥匙串"这一层要做。
- **UI 移动端布局已做且有门禁**：见 §4。

**待做**（详见上线计划的阶段划分）：体积压缩、签名与密钥保管、版本号联动、CI 出包、
应用内"检查更新"、真机验收、上架材料。

## 3. 鸿蒙：WebView 壳（ArkWeb）

鸿蒙是当前**唯一**保留 WebView 壳路线的平台。壳 = `ArkWeb` 加载 `dist-web` 构建产物 +
注入最小 JSBridge。

`dist-web` 由 `src/lib/platform/web.ts`（从 Tauri 抽象出来的浏览器宿主）驱动，
它已经是完整可用的 Web 实现（M16.0b–M16.1b：真实 SQLite(sql.js WASM) / 属性数据库 /
版本历史 / 文件导入导出 / 块引用反链 / 整库备份 / PWA）。

**MobileBridge 接口**（`src/lib/platform/mobile.ts`）：壳在 `window.__SHUYONOTE_MOBILE__`
注入以下**可选**方法（缺任一都回退浏览器默认，保证降级可用）：

| 方法 | 用途 | 无 bridge 时 |
|---|---|---|
| `openUrl(url)` | 用系统浏览器/外部 App 打开外链 | `window.open` |
| `convertFileSrc(path)` | 把内容寻址附件路径改写为 WebView 可加载的 URL | 原样返回 |
| `readAttachmentBytes(id)` | 读附件字节（base64） | 无（附件走 blob） |
| `saveBytes(fileName, base64)` | 保存文件到系统/分享面板 | 无 |

`web.ts::createWebPlatform` 的 `opener.openUrl` / `asset.convertFileSrc` 已优先用 bridge
（`d237c64`）。其余平台能力（dialog/event/webview）在 WebView 里用浏览器原生实现。

壳宿主要做的三件事：

1. 加载 `dist-web/index.html`；
2. 注入 `window.__SHUYONOTE_MOBILE__`（由原生 JSBridge 实现）；
3. 处理文件选择（`dialog.open` 在 WebView 里走 `<input type=file>`，`web.ts` 已支持 `pickBrowserFiles`）。

> ⚠️ **壳路线是能力子集**，且这是**根本性**的（不是"以后再补"）：真实文件系统、原生 OCR/加密、
> 原生 PDF、插件运行时都不可用；数据落在浏览器存储里。这些边界在
> [harmony-web-ceiling.md](harmony-web-ceiling.md) 里逐条写明——**对外描述该平台的可用范围时，
> 要照它说，不要含糊**。

## 4. 窄屏导航（浮层化）· 所有移动端共用

窄屏（≤768px）下三处「常驻栏」全部改成浮层，把宽度还给内容（`src/hooks/useMobile.ts` 判窄屏）：

| 元素 | 桌面 | 窄屏 |
|---|---|---|
| 左侧竖条（activity bar） | 常驻在布局流内（48px） | **浮层**，默认收起；左下角小圆钮唤出，点遮罩或点里面任何按钮即收回 |
| 侧栏（页面树） | 常驻列 | 左侧抽屉 + 遮罩，选完自动收起 |
| 右抽屉（AI / 评论 / 目录） | 固定宽侧板，主区 `padding-right` 让位 | 全屏叠加，**让位内边距清零**（否则主区内容盒被挤成 0 宽） |

`useMobile` 进入窄屏时收起侧栏**但不写 localStorage**——那是屏幕尺寸导致的布局状态，
不该覆盖桌面端的侧栏偏好（手机上开过一次、桌面端下次启动侧栏就是收起的，这个 bug 真实发生过）。

## 5. iOS 环境结论（2026-09，仍然有效）

**Tauri 原生 iOS 全链路**（`cargo tauri ios init/build`）在当时的 Mac 上
（无 Homebrew + 系统 Ruby 2.6）**不可行**：它会逐个要求 `brew` 装系统工具
（xcodegen / libimobiledevice / …），且强依赖 **CocoaPods**（`pod install` 在旧 Ruby 上
极慢/易卡）。已装好的只有：Xcode 26.6 + iOS Rust targets + Tauri CLI（真实 node）+ xcodegen 2.46.0。

**结论**：做 iOS 之前先解决这台 Mac 的工具链（Homebrew / 正常 Ruby），
否则会重新踩一遍上面这些。Android 不受此影响。

## 6. 测试与验收

### 6.1 单测

`pnpm test`（vitest）：`mobile.test.ts` 验证 bridge 探测 / 回退 / 优先；`useMobile.test.ts`
验证窄屏判定；`useGlobalShortcuts.test.ts` 验证侧栏快捷键守卫；`activity.test.ts`
验证侧栏开合的持久化语义。

### 6.2 布局验收（真实浏览器，43 项断言）

```bash
pnpm dev:web                # 另开一个终端
pnpm test:mobile-layout     # 有失败即非零退出
```

`scripts/verify-mobile-layout.mjs` 用真实 Chromium 在 **390×844（手机）** 与 **1280×800（桌面）**
两种视口下断言 43 项行为，覆盖的全是**单测够不到的交叉地带**（CSS 层叠 + matchMedia +
z-index + localStorage）：侧栏默认收起、竖条浮层化且主区拿到全宽、开合按钮在窄屏与桌面都必须常驻、
点遮罩关闭、抽屉打开时遮罩挡住右侧悬浮工具栏、右面板打开时主区 `padding-right=0` 且不超出视口、
移动端自动收起**不写** localStorage。

> 该脚本本身验证过「能失败」：临时删掉 `.sidebar[hidden]` 兜底规则后报 6 项失败并非零退出；
> 去掉窄屏的 `padding-right: 0` 后主区被顶成 380px（视口 342px）。

### 6.3 真机验收

- **Tauri 原生壳（Android/iOS）**：见 [上线计划](plans/2026-09-13-android-launch-plan.md) 的
  Phase 1 清单（含**最高风险项：Android 选文件 SAF**——`import_attachment_files` 走
  `std::fs::read(path)`，而 `open()` 可能返回 `content://`）。
- **WebView 壳（鸿蒙）**：每个壳在真实设备上验「打开外链走系统、附件可读、
  编辑/数据库/检索正常」，并跑 `scripts/smoke-web.mjs` 回归。
