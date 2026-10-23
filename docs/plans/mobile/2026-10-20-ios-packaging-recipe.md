# iOS 打包配方（2026-10-20 打通记录）

> 状态：施工记录（2026-10-20 打包链路已打通；真机界面/功能待验）
> 来源：macOS 侧 2026-10-20 实跑记录（跨机口头交接）；本仓只做**可复用配方**归档。
> 适用范围：`src-tauri/gen/apple` 的 iOS 构建（Tauri 2 / Xcode 27 / iOS 27 SDK）。
> ⚠️ 本文不把「能打包」写成「界面可用」；真机观感与功能仍以验收为准。

## 1. 三条必知（少一条就会卡一整天）

### ① 代理必须有（build 前 export）

```bash
export https_proxy=http://127.0.0.1:7890
```

FlClash 是**代理模式**、不是全局路由。不设它，`swift-rs` 拉不到 GitHub ⇒ **Swift 产物 0 个** ✗。

### ② 4 个 SwiftPM 库没有人自动生成，必须手工组装

从构建目录：

```text
.../swift-rs/<目标>/out/Intermediates.noindex/<目标>.build/*/Objects-normal/arm64/*.o
```

按目标分别 `ar rcs`，再拷到 `/tmp/ios-swiftpm-libs/`：

| 库 | 内容 |
|---|---|
| `libTauriSwiftPM.a` | `Tauri.build` 的 **8 个 `.o`**（`Invoke.o` / `Channel.o` / `JsonValue.o` / `Plugin.o` / `JSTypes.o` / `Logger.o` / …） |
| `libSwiftRsSwiftPM.a` | `SwiftRs.build` 的 `lib.o`（1 个） |
| `libtauri-plugin-dialog-plugino.a` | `tauri-plugin-dialog.build` 的 `.o` |
| `libtauri-plugin-opener-plugino.a` | `tauri-plugin-opener.build` 的 `.o` |

⛔ **不要拿「合并版 `Tauri.o`」打库** —— 它**没有 `Invoke.o`** ⇒ 链接必缺
`Tauri.Invoke.sendResponse` / `.error` / `.serialize` ⇒ `Undefined symbols`。
✅ 参照物：`src-tauri/gen/apple/Externals/ios-sim-swift/`（模拟器版；符号数 2011/185/1184/302）。

### ③ 已经就位、别动的

- `src-tauri/vendor/n0-dns-resolver`：iOS 缺 `_kSCDynamicStoreUseSessionKeys` 的补丁，已在 `dev`。
- `tauri ios xcode-script` 是**连父进程的 WebSocket 客户端**，单独跑会 `ConnectionRefused` —— 别以为它坏了。

## 2. 产物与安装

```bash
# app
~/Library/Developer/Xcode/DerivedData/shuyonote-*/Build/Products/release-iphoneos/ShuyoNote.app

# 装到真机（设备名 zhiyong的iPhone）
xcrun devicectl device install app --device 00008150-0006222E0C3BC01C <app>
```

⛔ **别碰 Mate 40**（`UJN0221310000547` 是 Android 验收机，`R204` 指定）。

## 3. 两条环境坑

- `tauri ios init` 会**重新生成 `gen/apple`** ⇒ 手改的 `pbxproj` 会被覆盖 ✗。定制必须写进
  `project.yml` 或脚本，不要只手改生成物。
- 本机 `brew prefix=/Users/shuyo/homebrew`（21 字符）⇒ 部分 bottle 无法 relocate，只能源码编。

## 4. 与「iOS 上还是桌面」的关系（2026-10-20）

macOS 侧报回：iOS 包能起，但界面出现**桌面界面**。当时怀疑 `src/App.tsx` 主区三元里
`pdfWhere === "inline"` / `previewWhere === "inline"` / `templateOpen` /
`view === "graph" | "timeline" | "map" | "board" | "files" | "sync"` 排在手机分支**前面**。

⚠️ **该猜测已实测否定**：给这些分支加 `!isMobile &&` 会让手机丢失**模板中心 / 文件 / PDF** 等
既有入口（`mobile-layout` 7 红、`mobile-views` 4 红）⇒ 已在 `ef8ca237` **回退**。
⇒ 「iOS 显示桌面」仍未定位，下一步取 iOS 真机的 `window.innerWidth` / UA / 截图，⛔ 不再加守卫猜。

## 5. 相关文档

- 平台细节与历史排查：[`../../MOBILE.md`](../../MOBILE.md) 的「iOS 现状」一节。
- 需求与状态：[`./2026-10-20-mobile-requirements-complete.md`](./2026-10-20-mobile-requirements-complete.md)。
- 技术方案：[`./2026-10-20-mobile-tech-plan-complete.md`](./2026-10-20-mobile-tech-plan-complete.md)。

---

## 6. 2026-10-23：固化成脚本 ＋ **公司签名**打通（本机 macOS 实跑）

> 状态：施工记录。上一节（10-20）的手工链路已收进 `scripts/ios-build.mjs`，`/tmp` 依赖已消除。

### 6.1 一条命令

```bash
node scripts/ios-build.mjs                    # 默认 --sign company ⇒ App Store 分发档（公司主体 D53949JLS2）
node scripts/ios-build.mjs --sign company --dev  # 公司 team 的开发档（Apple Development；需已注册真机）
node scripts/ios-build.mjs --sign personal    # 显式个人签名（xuechen zhai / 本机调试用；⛔ 不作交付物）
node scripts/ios-build.mjs --sim --run-sim    # 模拟器构建 + 装/启/截图
```

退出码：`0` 通过 ／ `1` 失败 ／ `2` **阻塞**（代理、网络、SwiftPM 缓存、签名缺件 —— 不是通过）。

### 6.2 这一版把哪些"手工坑"固化了

| 项 | 10-20 手工做法 | 现在 |
|---|---|---|
| SwiftPM 4 个归档 | 手工 `ar rcs` 到 `/tmp/ios-swiftpm-libs/`（`/tmp` 一清就得重来） | 脚本从 `target/<rust-target>/release/build/*/out/swift-rs/**/Intermediates.noindex` 取 .o，装到 **`src-tauri/target/ios-swiftpm-libs/`**（sim 在 `…/sim/`），装库后 `nm -arch arm64 -gU` 回验 |
| `project.yml` 的链接路径 | 写死 `/tmp/...` | 脚本改成 `$(PROJECT_DIR)/../../target/ios-swiftpm-libs/…`（与机器/用户名无关） |
| pbxproj 定制 | 靠手工跑 xcodegen | 脚本在改完 project.yml 后**必跑** `xcodegen generate` 并回验 pbxproj 里有新路径 |
| 版号 | `project.yml` 里写死（实测过期成 1.91.26） | 每次从 `tauri.conf.json` 同步；IPA 再回读校验 |
| IPA 里的残留 | 12 个 `.o` ＋ `*.swiftmodule/.swiftdoc/.swiftsourceinfo` ＋ `Info.plist.bak-noscene` | `Externals` / `shuyonote_iOS` 两处 `sources.excludes` 补齐 ⇒ 现为 **0 个** |
| `cargo build --lib` | 直接跑会红在 app 的 cdylib 链接 | 脚本带上 `project.yml` 里那个 `RUSTFLAGS=-C link-arg=-Wl,-undefined,dynamic_lookup`（与 Xcode 侧同一处事实源） |

### 6.3 公司签名（App Store 分发）：为什么不是"直接 `pnpm tauri ios build`"

本机/本队实测（逐字）：

1. `xcodebuild … build`（tauri 的 device 构建第一步）走 **development** 签名 ⇒ 公司 team **0 台注册设备**时：
   `Communication with Apple failed: Your team has no devices from which to generate a provisioning profile.`
   `No profiles for 'cn.shuyo.shuyonote' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'cn.shuyo.shuyonote'.`
2. 把 `CODE_SIGN_IDENTITY` 改成 `Apple Distribution` 也不行（automatic 签名在 build 阶段按 development 解析）：
   `has conflicting provisioning settings. shuyonote_iOS is automatically signed for development, but a conflicting code signing identity Apple Distribution has been manually specified.`
3. ✅ 可行路径（脚本 ⑥ 用的就是它）：**tauri 只归档不签名**（`--no-sign --archive-only`），
   再由脚本跑
   `xcodebuild -exportArchive -archivePath <xcarchive> -exportOptionsPlist <method=app-store-connect,teamID=D53949JLS2,signingStyle=automatic> -exportPath <dir> -allowProvisioningUpdates`
   ⇒ Xcode 用已登录的公司账号**自动创建** `Cloud Managed Apple Distribution` 证书 ＋
   `iOS Team Store Provisioning Profile: cn.shuyo.shuyonote`（两者均 2027-10-23 到期），并导出分发 IPA。
   **App Store 描述文件不需要设备**，所以这条路绕开了"0 台设备"。

本机已出包（2026-10-23 19:59，`dab65697`）：
`build/arm64/ShuyoNote.ipa` ＝ **35,456,557 B**，sha256 `38e6f1123067e7181c26a50426a84370dc2458d668fc22a744122391fa0fc96f`，
`CFBundleShortVersionString=1.92.25`，签名 `Apple Distribution: Puyang Shuyou … (D53949JLS2)`，
`get-task-allow=false`、`beta-reports-active=true`。
⚠️ 它是**分发签名** ⇒ 不能直接装进本机 iPhone 调试；真机调试要 `--sign company --dev`（需先注册设备）。

### 6.4 「iOS 显示桌面界面」：模拟器读数（2026-10-23）

模拟器（iPhone 17 / iOS 27.0 runtime）上这套 `tao 0.35.3` 只有三种态，**都画不出正常画面**：

| `UIApplicationSceneManifest` | 结果（逐字） |
|---|---|
| 最小（只有 `UIApplicationSupportsMultipleScenes=false`，= 10-20 真机那份） | `SIGTRAP`：`Application failed to launch: UIScene life cycle is required for apps built with this SDK.` |
| 完整（＋`UISceneConfigurations`：`TaoScene`/`TaoSceneDelegate`），`false` | 进程活着 ✓、WebView 真的加载并 `didCommitLoadForFrame` ✓，但**全黑** |
| 完整，`true` | 启动即崩：`EXC_BAD_ACCESS/SIGSEGV`，栈顶 `-[UIApplication _connectUISceneFromFBSScene:transitionContext:]` |

在那张"活着但黑"的态里，用注入探针（只存在于 `/tmp/dist-probe`，未进仓）读到了决定性读数：

```
UA        = Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 …) … Mobile/15E148   → isMobileUserAgent = true
innerW/H  = 0 / 0       （appRect 也是 0×0）      screen = 402×874  dpr = 3
mq768     = true         coarse = true            tauri = true
渲染      = .mhome-head ✓  .mtab-bar ✓  （手机壳**确实渲染出来了**）
```

⇒ **前端判定与手机壳都没问题**（`matchMedia(max-width:768px)` 为 true，UA 含 iPhone）；
黑屏的真因是 **WKWebView 的视口是 0×0**（窗口没接进 scene ⇒ 没有尺寸）。
⇒ 「真机显示桌面界面」在模拟器**无法复现**（模拟器只到黑屏/崩溃）；它只可能出在**真机那条 legacy 窗口路径**上
（`tao 0.35.3` 的 `multiple_scenes_enabled()` 读的是 plist 布尔值，最小 manifest ⇒ 走 app-delegate 老路，
窗口 `setWindowScene:` 不会被调用）——那一条**需要真机读数**才能定死：用 `--frontend-dist` 打一份带探针的包，
在真机上量 `innerWidth`（>768 即落进桌面分支）。**未验证的猜测不当结论**。

### 6.5 还差的（owner / 上架侧，不是打包链）

- **App Store Connect 应用记录**（上架 / TestFlight 用）——本机没有 ASC API key，需 owner 建。
- **真机安装**：需插 iPhone（自动注册设备）后 `--sign company --dev`；分发签名的 IPA 不能直接装。
- 模拟器运行时只有 **iOS 27.0**，而 SDK 是 27.1 ⇒ Tauri CLI 的精确匹配检查会拦模拟器构建；
  本次诊断用了一个只存在于 `/tmp/fakebin` 的 `xcrun` shim 把版本号"说成" 27.1（不改系统、不联网），
  ⛔ 它只是诊断手段，**不在**打包脚本里。要么装 iOS 27.1 runtime（需联网下载），要么等 Tauri CLI 放宽。
