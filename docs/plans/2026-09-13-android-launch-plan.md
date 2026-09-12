# 移动端上线计划（Android 优先）

> 2026-09-13 制定。目标：**Android 原生 App（Tauri 移动端）**，第一批用户走
> **官网 APK 直下 + 酷安**，国内应用商店与软件著作权**并行启动、后补上架**。
>
> 这份文档记录「现在到哪一步」与「为什么这么排」。每一步都尽量给出**可核对的判据**，
> 而不是"做完了"。

---

## 一、现状审计（2026-09-13 实测，不是推测）

| 面 | 状态 | 依据 |
|---|---|---|
| UI 移动端布局 | ✅ **已做** | `src/hooks/useMobile.ts`（≤768px 折行，且**不写 localStorage**以免污染桌面偏好）+ `scripts/verify-mobile-layout.mjs`（390×844 / 1280×800 双视口真实 Chromium 断言，280 行） |
| Rust 平台分支 | ✅ **已做** | `#[cfg(desktop)]` 7 处；`lib.rs` 注释写明"single-instance 只为桌面实现、updater 在移动端走应用商店" |
| Android 依赖 | ✅ **已做** | `[target.'cfg(target_os = "android")'.dependencies]`：`openssl` vendored + `rusqlite` bundled-sqlcipher-vendored-openssl（NDK clang 交叉编译） |
| 加密密钥 | ✅ **无需改造** | `security.rs`：口令派生、**密钥不落盘**、只活在会话内存（E1 的核心）。所以 Android 上**不需要 Keystore 集成** |
| Android 工程 | ⚠️ 本地生成、**未入库** | `.gitignore:45` → `src-tauri/gen`，注释写着"`tauri android init`/build 生成，可重建" |
| 真机 APK | ⚠️ 能构建但**未签名** | 2026-09-10 产出 `app-arm64-release-unsigned.apk`(156.7 MiB)、`app-universal-release-unsigned.apk`(258.8 MiB) |
| 版本号联动 | ❌ **停在 1.82.18** | `gen/android/app/tauri.properties` → `versionName=1.82.18`, `versionCode=1082018` |
| 体积 | ❌ arm64 **156 MiB** | 见下面「体积账」 |
| 签名 | ❌ 无 keystore、gradle 无 `signingConfig` | — |
| CI | ❌ 无 Android 工作流 | `.github/workflows/` 只有 ci / pages / release；`.gitcode/workflows/` 只有 build-linux |
| 应用内更新 | ❌ Android 没有 | updater 被 `#[cfg(desktop)]` 关掉，且移动端本就该走商店/重新下载 |
| iOS | ❌ 完全没有脚手架 | 无 `gen/apple` |

**一句话**：这不是从零开始——**能跑、能构建的底子已经有了**；缺的是「能装、好用、能持续发、能上架」
这四件事，以及一件容易被忽略的：`gen/android` 不在 git 里，所以**任何手工改过的 gradle/manifest 都不可复现**。

---

## 二、⚠️ 必须先拍板：仓库里有**两条互相冲突的移动端路线**

写这份计划时发现既有文档与既有代码指向**两个不同的产品**，而它们不能同时成立：

| | **路线 A：Tauri 原生（Rust 内核）** | **路线 B：WebView 壳（Web 内核）** |
|---|---|---|
| 依据 | `src-tauri/gen/android` + 2026-09-10 的 APK + `Cargo.toml` 的 Android 依赖段 | `docs/MOBILE.md`：「技术路线（B：WebView 壳，复用 Web 版）」+ `src/lib/platform/mobile.ts` |
| 内核 | 桌面同一套 Rust（SQLCipher 真加密、原生附件、mupdf） | `dist-web` + `web.ts` + sql.js WASM + IndexedDB |
| 当前进度 | **已能构建出 APK**（只差签名/体积/CI/验收） | **壳还没写**（`cross-platform-plan.md` 里 M16.5「各平台壳」仍是 🗓） |
| 多设备同步 | ✅ 桌面同一套可用 | ❌ `web.ts` 是 stub（源码：`sync_now` / `sync_workspace` 不支持） |
| 插件 | ✅ 完整（Boa 运行时） | ❌ **根本性限制**：浏览器跑不了 Rust `boa_engine`，M16.4 明写"需重做 JS 沙盒" |
| PDF | 原生 mupdf + pdf.js 双引擎 | 只有 pdf.js |
| 数据落地的样子 | 应用私有目录里的**真实文件**，可备份可搬移 | **浏览器存储**（sql.js + IndexedDB），会被系统回收 |
| 包体积 | 156 MiB → 可压到 ~60 MiB | 极小（~15 MiB 资源） |

**这是矛盾，不是互补**：`MOBILE.md` §6 自己写着「WebView 壳不改变内核是浏览器……真实文件系统、
系统级性能、原生 OCR/加密等桌面原生能力不可用」，而本应用的核心承诺恰恰是**本地优先 / 数据主权 / 离线**。
把用户笔记放进会被系统回收的浏览器存储里，与产品承诺是直接冲突的。

**本计划的选型：路线 A（Tauri 原生）**，理由三条：

1. **只有 A 能兑现产品承诺**——SQLCipher 真加密、真实文件系统、可导出的备份；B 的存储是可被回收的浏览器存储。
2. **A 反而更近**：APK 已经构建过，而 B 的安卓壳一行还没写（M16.5 未开始）。选 B 不是"省事"，是"从零开始做一个功能更少的版本"。
3. **B 的省下的是体积**，而体积在 A 里正是本计划 Phase 0 的主线——**A 的体积问题是有解的，B 的功能缺失是无解的**（除非重做 JS 沙盒）。

> 需要在文档层面收口：`docs/MOBILE.md` 的「技术路线 B」与 `docs/README.md` 的 M6/M16 登记要更新，
> 明确「**移动端 = Tauri 原生壳**；WebView 壳路线仅保留给鸿蒙 ArkWeb 等 Tauri 不可达的平台」。
> 这件事**本计划不擅自改**——它牵动 M16 的四个里程碑定义，需要你点头。

> 顺带一条：`MOBILE.md` 记录的 **iOS 环境结论**（那台 Mac 上没有 Homebrew + 系统 Ruby 2.6 →
> `cargo tauri ios init/build` 全链路不可行，缺 xcodegen/CocoaPods）对以后做 iOS 依然有效，
> 与 Android 无关，但别到时候重新踩一遍。

---

## 三、体积账（决定转化率，也是 Phase 0 的主线）

| 组成 | 现在 | 措施 | 目标 |
|---|---|---|---|
| Rust `.so`（arm64） | **101 MiB** | `Cargo.toml` 里**根本没有 `[profile.release]`** → 没 `strip`。加 `strip = true` + `lto` + `codegen-units = 1` | ~30 MiB |
| `ocr/`（tesseract 语言数据） | **72.9 MiB** | 整个打进包。改为**首次使用 OCR 时按需下载**（或先只内置 `chi_sim`，`eng` 按需） | 包内 ~5 MiB |
| `assets/`（JS 产物） | 13.2 MiB | 已 minify；可再拆 vendor | ~13 MiB |
| `pdfjs/` + `prism/` + `covers/` + `icons/` | ~3 MiB | — | ~3 MiB |
| **arm64 APK 合计** | **156 MiB** | | **目标 55–70 MiB** |

> ⚠️ `mupdf-sys` 在**主依赖**里（没有按平台排除），所以它被编译进 Android 的 `.so`——这是
> 101 MiB 的另一半原因。Phase 0 要顺便量一下：PDF 在手机上走原生 mupdf 是否值得那部分体积，
> 还是退到 pdf.js（Web 端本来就有这条退路）。

> 数字说明：「strip 能省多少」是**高置信度假设**，不是实测——Phase 0 第一件事就是量它，
> 而不是先写进结论。

---

## 四、两条关键路径

```
工程路径：体积 → 签名 → 版本联动 → CI 出包 → 真机验收 → 官网/酷安
合规路径：软著（长周期）→ 商店开发者账号 → 隐私政策/权限说明 → 各商店审核
```

**合规必须今天启动，不能等工程做完**：软件著作权登记通常要几十个工作日（以官方为准），
它是整条链上**唯一"你没法用加班换时间"的环节**。工程侧再快，材料没下来也上不了商店。

好在官网 APK + 酷安这条路**不需要软著**，所以两条路互不阻塞——这正是先走酷安的价值：
**不用等材料就能拿到真实用户反馈**。

---

## 五、阶段与判据

### Phase 0 · 先能装（1–2 天）

要做的事：

1. `Cargo.toml` 加 `[profile.release]`：`strip = true`、`lto = true`、`codegen-units = 1`；
   量 `.so` 前后大小（**这是本阶段唯一的技术假设，先验证再继续**）。
2. OCR 语言包改为按需：先把 `public/ocr/tessdata` 从包内构建里去掉，改成首次用 OCR 时下载到
   `app_data_dir`（离线承诺不破：**下载一次之后永久离线可用**，且要如实告知"首次需要联网一次"）。
3. 生成 keystore（`keytool`），**离线备份两份**（私钥丢了 = 再也无法给同一签名的用户升级，
   这是本项目唯一不可逆的运维事故），记录 SHA-256 指纹。
4. 版本联动：一个脚本从 `package.json` 写 `gen/android/app/tauri.properties`
   （`versionName=1.90.1` / `versionCode=<major*1000000+minor*1000+patch>`），并进 CI。
   **现在那个 1.82.18 是手工遗留，必须自动化，否则每次发版都会忘。**
5. `pnpm tauri android build` 出 arm64 APK 并签名。

**判据**：产出 `ShuyoNote_<ver>_arm64.apk`，体积 ≤ 70 MiB，能装进一台真机并冷启动到
「新建一篇笔记、写、重启后还在」。

### Phase 1 · 手机上真的好用（约 1 周）

**先做风险最高的 spike：选文件（Android SAF）**。

`import_attachment_files` 走的是 `std::fs::read(&src)`（源码第 453 行附近），而 Android 的
`tauri-plugin-dialog` `open()` 可能返回 `content://` URI——**`std::fs` 读不了它**。
受影响的功能不止附件导入：**从文件夹安装插件、装 .zip 插件包、备份导入、邮箱账号导入**全走这条路。

> 这条**必须先验证再排期**：如果确实读不了，方案是把选中的文件先复制到应用缓存再按路径读
> （Tauri 的 dialog 插件在部分平台已经这么做），代价是内存/临时空间与一次拷贝。

其余真机验收清单（逐项过，不许"看起来没问题"）：

- 冷启动 / 换空间 / 新建页面 / 编辑 / 杀进程重启后数据在
- 附件导入（图片、PDF、任意文件）
- PDF 打开与翻页（原生 mupdf 与 pdf.js 两条路都要知道哪条在用）
- 离线 OCR（首次下载语言包 → 之后飞行模式下可用）
- 加密：开启、锁定、解锁、关掉；**锁定后杀进程重启应仍是锁定态**
- 插件管理：列表、启用/禁用、从 zip 装（依赖上面那个 spike）、日志
- 深链 `shuyonote://`：AndroidManifest 加 `intent-filter`；与社区"存一篇"联调
- 同步：切到后台再回来，SSE 能否重连（**厂商省电策略会杀后台，要如实设计预期**：
  可以说清"同步在应用打开时工作"，而不是承诺后台实时）
- 备份导出到用户选的位置、再导入回来
- 屏幕：小屏（≤360dp）、横屏、分屏、手势条/刘海 insets

**判据**：上面每一条都在**真机**上走过一遍并记录结果；`verify-mobile-layout` 在真机 WebView
（或用 USB 调试的 Chrome DevTools 协议）上复跑通过。

### Phase 2 · 能持续发（约 1 周）

1. **CI 出包**：GitHub Actions 加 Android job（ubuntu runner + Android SDK/NDK），
   keystore 走 Secrets；产物上传 artifacts。**注意 `gen/android` 不在库里 → CI 必须先
   `pnpm tauri android init`**，任何需要的 gradle/manifest 定制都要**脚本化**（否则本地能过、CI 不能）。
2. **官网下载页**：`shuyo.cn/download`（或 `/app` 旁）给 APK 直链 + sha256 + 签名指纹 +
   "怎么验证签名"；与 Web 版、桌面版并列。
3. **应用内"检查更新"**：Android 不接 updater 插件，改为「发现新版本 → 打开下载页」。
   版本源可以复用桌面那套的 `latest.json`（加一个 `android` 键），**不要另起一套**。
4. **崩溃与日志回流**：至少一个最小方案。没有它，酷安用户的反馈只能靠口述，排查成本极高。
   倾向：应用内"导出诊断包"（现有日志 + 版本 + 机型），而不是引入第三方 SDK
   （与"数据主权"的产品承诺一致）。

**判据**：改一行版本号 → 推 tag → CI 出已签名 APK；下载页自动更新；应用内能提示新版本。

### Phase 3 · 上商店（与 Phase 0–2 并行启动材料）

**今天就要启动的三件事**：

1. **软件著作权登记**（长周期，先办）
2. **各商店开发者账号**：华为 / 小米 / OPPO / vivo / 应用宝（个人主体多数可注册）
3. **隐私政策页**（挂在官网，商店必填）——本应用反而好写：**数据本地、不上传、不收集**；
   要如实写清唯一的联网行为（同步服务器、插件索引、AI、邮箱、崩溃诊断）

技术侧的上架要求：

- **AAB + 按 ABI 拆分**（商店能按设备下发，用户少下 2/3）
- **16 KB page size**（Android 15+ 对原生库的要求；Play 已强制，国内商店可能跟进）
  → 需要确认 NDK 版本并加 `-Wl,-z,max-page-size=16384`
- `targetSdk` 36、`minSdk` 24（Android 7.0+）——已满足
- 各商店的隐私合规表单、权限说明（本应用只要 `INTERNET`，是优势）

---

## 六、风险清单（按"会不会让计划脱轨"排）

| 风险 | 影响 | 应对 |
|---|---|---|
| **选文件 SAF 读不了** | 导入类功能整体不可用 | Phase 1 第一件事就是 spike；有"先拷到缓存"的退路 |
| **软著周期** | 商店上架整体延后 | 今天启动；官网/酷安不受影响，先跑起来 |
| **体积压不到 70 MiB** | 酷安转化率低、流量成本 | strip + OCR 按需是两条独立的大头，任一成功都有显著收益 |
| **签名密钥丢失** | **不可逆**：老用户永远收不到升级 | 离线两份备份 + 指纹入库（指纹不是秘密） |
| `gen/android` 不可复现 | 本地能过、CI 不能 | 所有定制脚本化；CI 里 `tauri android init` 后跑定制脚本 |
| 老设备 WebView 落后 | pdf.js / wasm / 现代 CSS 失效 | 设最低 WebView 版本并在启动时检查，而不是让它白屏 |
| 后台同步被厂商杀掉 | 用户预期落空 | 明确说"打开应用时同步"；不做后台实时承诺 |
| 移动端插件生态 | 插件模型假设了桌面文件系统 | 先只保证"零代码插件 + 内置命令"可用，桌面专属能力如实禁用 |

---

## 七、"上线"的定义（验收，不可妥协）

> **一个陌生人**：从官网下载 APK → 装上（无需注册）→ 写一篇笔记 → 导出备份 →
> 卸载重装 → 恢复成功。

这条路径必须**由本人真机走过一遍**，而不是"CI 构建成功"。构建成功只证明它能编译，
不证明它是一件能用的产品——这一点在 1.90.1 那版已经吃过一次教训
（4 个插件"校验器说没问题、点安装必报错"，只有用真实路径跑才暴露）。
