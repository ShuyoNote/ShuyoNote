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

macOS 侧报回：iOS 包能起，但界面出现**桌面界面**。已定位到 `src/App.tsx` 的主区三元：
`pdfWhere === "inline"` / `previewWhere === "inline"` / `templateOpen` /
`view === "graph" | "timeline" | "map" | "board" | "files" | "sync"` 排在手机分支**前面**
⇒ 任一状态成立（例如上次的看板/关系图被还原）⇒ 手机（含 iOS）渲染桌面主区 ✗。

已在 `2026-10-20` 的 `fix(mobile)` 中给每个桌面主区分支加 `!isMobile &&`，
并加源码形状回归测试 `src/App.mobileBranchOrder.test.ts`（10 条）。⛔ 真机观感仍需复验。

## 5. 相关文档

- 平台细节与历史排查：[`../../MOBILE.md`](../../MOBILE.md) 的「iOS 现状」一节。
- 需求与状态：[`./2026-10-20-mobile-requirements-complete.md`](./2026-10-20-mobile-requirements-complete.md)。
- 技术方案：[`./2026-10-20-mobile-tech-plan-complete.md`](./2026-10-20-mobile-tech-plan-complete.md)。
