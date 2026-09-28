# ShuyoNote 移动端（M6 / M16）

> **路线已定（2026-09-13）**：
> **移动端 = Tauri 原生壳（Rust 内核）**；**WebView 壳路线只保留给 Tauri 不可达的平台**
> （当前只有**鸿蒙 ArkWeb**）。
>
> 执行计划见 移动端上线计划（Android 优先）（已移入私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md`）。

## 0. 为什么是 Tauri 原生壳（这条决定要能扛住复读）

此前本文档写的是「技术路线 B：WebView 壳，复用 Web 版」（加载 `dist-web` + sql.js WASM +
IndexedDB）。2026-09-13 明确改为**安卓/iOS 走 Tauri 原生壳**，理由是**产品承诺**而不是偏好：

| 能力 | Tauri 原生壳 | WebView 壳（Web 内核） |
|---|---|---|
| 加密 | **SQLCipher 真加密**（与桌面同一套） | 无（数据在 IndexedDB 里） |
| 数据落地 | 应用私有目录里的**真实文件**，可备份、可搬移 | **浏览器存储**，会被系统回收 |
| 多设备同步 | ✅ 与桌面同一套 | **不提供**（**产品决定 2026-09-15：Web 版不开多设备同步**）——`SyncPanel.tsx:523` + `App.css:1222-1227` 在非 Tauri 平台把配置区置灰，`SyncPanel.tsx:502` 提示"Web 版同步受浏览器环境限制"（根因：浏览器存储会被系统回收，不适合当唯一副本）。⚠️ 但 `web.ts:2429/2541/896`（`sync_now` / `sync_workspace` / `syncAttachments`）是**完整实现、不是 stub，且按决定保留**——**别当死代码删掉**（口径与缘由见 `web.ts` 里 `sync_now` 上方注释） |
| 插件 | ✅ 完整（Boa 运行时） | ❌ **根本性限制**：浏览器跑不了 Rust `boa_engine`，需重做 JS 沙盒（M16.3） |
| PDF | 原生 PDFium（默认引擎；MuPDF 是构建期可选项 `mupdf-rollback`，默认不编）+ pdf.js 回退 | 只有 pdf.js |
| 体积 | 大（需专门压，见计划里的体积账） | 小 |

本应用的核心承诺是**本地优先 / 数据主权 / 离线**。把用户笔记放进**会被系统回收的浏览器存储**里，
与这个承诺是直接冲突的——所以"WebView 壳更省事"不能作为选它的理由：它省下的是体积，
而**体积在 Tauri 原生壳里是有解的**（strip + OCR 语言包按需下载），功能缺失却是无解的。

> 一句判据：**只要这个平台能跑 Tauri，就走 Tauri 原生壳。** 走不了才退到 WebView 壳，
> 并且要如实标注该平台是**能力子集**。

## 1. 各平台路线

| 平台 | 路线 | 状态 |
|---|---|---|
| **Android** | **Tauri 原生壳** | 已能构建出**已签名**的 APK——自检包（`.github/workflows/android.yml`）与对外发版件（`.github/workflows/release.yml`）都用正式密钥签名并硬比对指纹；发版件见 [RELEASING.md](RELEASING.md) §⑨ |
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

**已完成**：体积压缩（arm64 **156.7 → 53.41 MiB**，目标 55–70 MiB 达成）、CI 出包
（`.github/workflows/android.yml` 已跑通）、版本号联动（Tauri 每次 `android build` 自动同步
`tauri.properties`，**不需要额外脚本**）。

**已完成**：体积压缩（arm64 **156.7 → 53.41 MiB**）、CI 出包（`.github/workflows/android.yml`）、
**首次真机跑通**（2026-09-13 · HUAWEI Mate 40 `OCE-AN10` / Android 12：装上、冷启动 589 ms、界面正常渲染）。

**待做**（详见私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md` 的阶段划分）：
逐条真机验收、上架材料。

**应用内「检查更新」：Android 上**已完整做到"下载 + 校验 + 交给系统安装器"**（2026-09-14 第一版 → **2026-09-15 补齐第二步**，见 §2.6）。
打开「关于」自动检查，有新版时给**「下载并安装」**：地址与 `sha256` 取自更新清单 `latest.json` 的
`platforms["android-aarch64"]`（与桌面**同一份清单、同一个 gitcode 通道**）；点击后由 Rust 侧
**下到应用缓存、边下边算 sha256**，校验通过再经 `FileProvider` + `ACTION_VIEW` **拉起系统安装器**。
边界要说清：**刻意不做静默安装** —— Android 8+ 要用户给本应用开「安装未知应用」，
装不装由用户在**系统界面**里决定；我们只负责"把包下对、验对、把安装器拉起来"。
apk 没有 minisign `.sig`（签名在包内，由 apksigner 打、系统安装器强制校验），清单里用
`sha256:<hex>` 记录字节。真机实测（含反面测试：错指纹被拦下并删文件）见 §2.6；
发布侧要求见 [RELEASING.md](RELEASING.md) §⑥ / §9.5。

**启动时的红点/横幅：Android 上「有」**（2026-09-14 核实代码后定稿，**别写成"Android 没有红点"**）。
`useUpdateChecker()` 在 `App.tsx` 里无条件调用，而 `isDesktop()` 的真实语义是"有没有 Rust 内核"
（本节 §2 开头那条边界，Android 壳为真）⇒ 它走桌面那一支；Android 上 `tauri-plugin-updater` 没注册
（`lib.rs` 带 `#[cfg(desktop)]`）⇒ 那一步必然失败，代码随即**降级**到 gitcode 发布渠道清单
（`updates::fetch_update_manifest`，全平台注册）比对版本 ⇒ **线上 `latest` 比已装的新时，启动就会出现
红点 + 顶部横幅**，与桌面同一套 UI。回归测试 `src/lib/useUpdateChecker.test.ts` 钉住这条降级路径。
⇒ 真正成立的限制只在"**装**"这一步：启动红点/横幅**只是提醒**，其 CTA 只到「关于」（横幅里不给下载）；
APK 地址与下载入口只在「关于」的 Android 分支；老清单（没有 `android-aarch64` 键）退回「前往发布页」。

仍未做的：应用商店上架、增量更新、iOS。

> 上表与本节其余部分 2026-09-15 校准过一次：**应用内更新**已从"只给下载入口"变成
> "下载 + 校验 + 交给系统安装器"（见 §2.6），别再照旧稿写成"❌ 不做"。

### 2.1 移动端**不提供** / **已知有问题**的能力（边界要能说清，别含糊）

走 Tauri 原生壳意味着大部分能力与桌面一致（加密、附件、同步、原生 PDF 都在），
目前有**三项**要说清：

| 能力 | 移动端 | 为什么 / 边界落在哪 |
|---|---|---|
| **聚合邮箱（含发信）** | ❌ 不做（2026-09-13 定） | 它走 `native-tls`（桌面用系统 TLS），移动端要为此从源码交叉编译 OpenSSL。Rust 侧 `mod email`/`mod smtp` 与 **31 个命令**带 `#[cfg(desktop)]`（2026-09-23 实查 `lib.rs`），**移动端这些命令不存在**；前端入口用 `emailSupported()` 隐藏 |
| **插件运行时（Boa）** | ✅ **已修**（2026-09-13 真机复验：那条 panic 在日志里消失） | 见下面「Boa 的 nan-boxing 在 Android 上不成立」 |
| **应用内更新（in-app updater）** | ✅ **Android 有**（2026-09-15 补齐，见 §2.6） | 说的是 `tauri-plugin-updater`——它**桌面专属**（`lib.rs` 里带 `#[cfg(desktop)]`）。⚠️ 但"这个插件不能用"**不等于**"Android 没有应用内更新"：Android 上走的是**我们自己实现的那条**（Rust 下载 + sha256 校验 + `FileProvider` 拉起系统安装器）。这一条原先写成"❌ 不做"，是当时**只有第一版**（只给「下载 APK」交给系统）留下的旧结论，2026-09-15 已实现第二步并真机验过 |

#### ⚠️ Boa 的 nan-boxing 在 Android 上不成立（2026-09-13 真机实测）

第一次真机跑起来时，日志里就有这么一条：

```text
thread 'plugin-run' panicked at boa_engine-0.21.1/src/value/inner/nan_boxed.rs:270:9:
assertion `left == right` failed: this platform is not compatible with a nan-boxed `JsValueInner`
enable the `jsvalue-enum` feature to use the enum-based `JsValueInner`
  left: 537333788672          right: 12970367464160817152
```

**应用没崩**——panic 在插件线程（`plugin-run`）上，主线程照常跑。M11.5 那套"超预算就 panic 让它
unwind、应用存活"的设计，在这里顺带被真机验证了一次；**但插件整个用不了**。

根因（读 `nan_boxed.rs` 定位）：

```rust
const MASK_POINTER_VALUE: u64 = 0x0000_FFFF_FFFF_FFFF;   // 只留低 48 位
assert_eq!(value_masked, value, "…not compatible with a nan-boxed JsValueInner");
```

而真机上那个指针是 **`0xB400007D1B960000`**，真实地址是 `0x7D1B960000` ——
**最高字节被当 tag 用了**（Android/arm64 上的指针标记）。48 位的掩码装不下它，断言当场失败。

修法（Boa 自己给的提示）：给移动端开 `boa_engine` 的 `jsvalue-enum`，改用**枚举版** `JsValueInner`
（不做指针标记）。桌面 x64 用户态指针高位为 0，不受影响，所以**只对移动端开**：

```toml
[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]
boa_engine = { version = "0.21.1", features = ["jsvalue-enum"] }
```

代价：`JsValue` 从 8 字节 nan-boxed 变成枚举（更大、更慢），但只在移动端。

**状态：✅ 已修，真机复验**（2026-09-13）：

- 修法落在 `src-tauri/Cargo.toml` 的移动端依赖段（`features = ["jsvalue-enum"]`，**只对移动端开**）；
- CI run #5 全绿 ⇒ 移动端带着枚举版 `JsValueInner` **编译通过**；
- 新包（53.21 MiB，同一把测试 key）`adb install -r` 覆盖安装 + 冷启动：**日志里这条 panic 与
  `plugin-run panicked` 都不再出现**，无 FATAL，界面正常渲染（截图存证）。

**这条能推出多少（写清楚，别多推）**：插件**发现**阶段是**真的在 Boa 里执行**插件代码的——
`discover_commands()` 就是 `ctx.eval(Source::from_bytes(source))` 再 `__describe()`，
而它跑在 `with_timeout()` 那个名为 `plugin-run` 的线程上（`plugins.rs:1171`）。
所以这是一次**同触发路径的前后对照**：修前每次启动都在这里 panic，修后同样启动、同样路径、
不再 panic ⇒ **Boa 能在 Android 上执行插件代码（发现阶段）**。

⚠️ **没有**验证到的是：**执行一条插件命令**（那要宿主子进程 + UI 操作）。
这轮试过用 `adb` 驱动界面去跑播种的示例插件命令，**没成功**（原因见 §2.3）。
所以"插件在 Android 上端到端可用"仍然**未验证**——别把上面那条读成它。

> ⚠️ 判定"某个只在桌面存在的功能"**不要**用 `isDesktopPlatform()`——它的真实语义是
> "**有没有 Rust 内核**"，Tauri 的移动端为真，而同步/加密/插件在移动端是要保留的。
> 每个桌面专属能力各自有一个**具体能力函数**（如 `emailSupported()`，见
> `src/lib/platform/capabilities.ts`，纯函数可单测）。

### 2.2 Android 上「选文件」拿不到可读路径（**已修**：2026-09-13 实现 + CI 编译验证；**真机待点一次**）

上线计划把这条列为"风险最高、必须先 spike"的一项。2026-09-13 读源码把它确认了。

**事实链**：

1. `tauri-plugin-dialog` 的 Android 实现把系统返回的 URI **原样**交给前端——
   `DialogPlugin.kt::createPickFilesResult()` 里就是 `uris.add(uri.toString())`，
   拿到的是 `content://com.android.providers.media.documents/document/image%3A1234`
   这种**内容 URI**；同一个文件里的 `FilePickerUtils.getPathFromUri()`（能反查真实路径）
   **在这条路上根本没被调用**。
2. 我们的导入路径把它当文件路径用：`attachments.rs` 的 `copy_and_hash()` 是
   `std::fs::File::open(src)`；`plugins.rs` / `backup.rs` / `workspace_io.rs` 的导入同理
   （`std::fs::read`）。`content://…` 在 `std::fs` 下**必然打不开**。
3. 受影响的不止附件导入：**从文件夹 / zip 装插件、备份导入、空间导入、模板导入**
   全都是"选文件 → 读路径"这条路。

**官方通路是有的**（所以这不是"Tauri 做不到"）：
`tauri-plugin-fs` 的 `Fs::open()` 在 Android 上是
`FilePath::Url(u) → resolve_content_uri()`（经 Kotlin 的
`contentResolver.openAssetFileDescriptor(Uri.parse(uri), mode)` 取 fd）→
`std::fs::File::from_raw_fd(fd)`；在桌面上它就是
`std::fs::OpenOptions::from(opts).open(path)`——**两个平台同一个 API，且桌面语义与我们现在完全一致**。

**修法**：把"读用户选的文件"收敛到一个 helper，走 `tauri-plugin-fs` 的 `open()`
（同时把该插件注册进 `lib.rs`；它的前端命令是**权限门控**的，我们不给 fs 权限 ⇒ 顺带不扩大攻击面）。
涉及 `attachments.rs` / `plugins.rs` / `backup.rs` / `workspace_io.rs` 四处。

**状态：已实施**（2026-09-13）：

- 做法：新增 `src-tauri/src/picked_file.rs` 作为「用户选的东西」的**唯一落地入口**——
  不是把每处读取都改成读 fd，而是把选中项**拷成一条真实临时路径**，下游的 `exists()` /
  `is_file()` / zip 解包 / 流式哈希**全都照旧能用**（各入口只改一行）。代价是一次拷贝，
  这正是本计划早就写下的"先拷到缓存"的退路。
- 判据：**只有看着像 URI 才走插件**（含 `://` 且 scheme ≥2 字符）。特别地，**Windows 的 `C:\…`
  必须判成路径**，否则桌面会被误路由到"为 Android 才存在"的分支上——这条有单测钉着
  （`picked_file::tests::only_real_uris_are_treated_as_uris`）。
- 打开走 `tauri-plugin-fs` 的 `Fs::open`（Android 经 Kotlin 的 ContentResolver 取 fd；
  桌面就是 `std::fs::OpenOptions`，与原来等价）。⚠️ 必须用 `FilePath::from_str`——
  用 `Path::new` 会把它当普通路径，等于白改（编译期就错，已踩过）。
- fs 插件**不是给前端开的**：capabilities 里没授它任何权限。
- 拷出来的临时文件随 `PickedFile` 析构删除；用户原始文件不碰。
- 改到的入口：`attachments.rs`（附件导入）、`plugins.rs`（装 zip 插件）、`backup.rs`（备份恢复）、
  `workspace_io.rs`（空间导入）。
- **先目录选择仍不支持**（系统给的是 tree URI，读不出目录树）——错误信息里如实说清。

**还差最后一步：真机点一次。** CI run #6 已证明 Android 侧编得过；行为验证要人在手机上走一遍：
**附件面板 → 选择文件 → 从「图片」里挑一张 → 应正常导入（不再报"不存在/读取失败"）**。
在那之前，这条只算"实现完成、编译通过"，**不算真机验收通过**。

#### 2.2.2 真机点完之后暴露的第二个问题：**导进来了，但名字和 mime 丢了**（2026-09-17 修）

真机（Mate 40 / Android 12）走通上面那条之后，附件确实导进来了 —— 但列表里显示成：

```text
📎41449ced-d44e-4d3c-8e14-7c6733ad042a   未整理   文件   1.8 KB
```

**这不是难看，是功能坏了**：`FileManagerView.tsx` / `PageTree.tsx` 都按 `file.mime` 分支
（`image/*` → 内置文件预览、`application/pdf` → 内置 PDF 阅读器、`text/markdown` → 预览），
mime 是 `application/octet-stream` 就**一个分支都不命中**，最后掉到
`platform.opener.openPath()`（Android 上 `content://` 转出来的临时路径也没法交给系统应用）。

**根因链**（每一环都只丢元数据、不报错）：

| # | 位置 | 发生了什么 |
|---|---|---|
| 1 | `tauri-plugin-dialog` 的 `DialogPlugin.kt::createPickFilesResult` | 只 `uris.add(uri.toString())` —— 系统给的 display name / mime **根本没进这条管道** |
| 2 | `picked_file::materialize`（旧） | 临时文件名 = `uuid::Uuid::new_v4().to_string()` ⇒ **裸 UUID、无扩展名** |
| 3 | `attachments.rs`（旧） | 用 `src.file_name()` 当**附件名**、用 `mime_from_path(&src)`（**只看扩展名**）定 mime ⇒ UUID 名 + octet-stream |

**为什么不能只靠解析 URI**：尾段能不能当名字**全看 provider**——
`com.android.externalstorage.documents` 给的是 `primary:Download/photo.png`（能解出真名），
但 `com.android.providers.media.documents` 给的是 `image:1234`、
`…downloads.documents` 给的是 `msf:1000000042` —— **那是 id，不是名字**。
名字只有 `ContentResolver.query(OpenableColumns.DISPLAY_NAME)` 知道，而它和
`getType(uri)` 都**只在 Android 运行时里**（`FilePickerUtils` 里两个函数都能做这件事，
但在这条路上**零调用点**：全仓 grep `getNameFromUri` 只有定义没有调用）。

**修法（三层，逐层变弱；桌面一层都不走）**：

1. **问系统** —— 新增本地 Tauri 插件：`src-tauri/src/android_fs.rs` +
   `scripts/android-mobile-shell.mjs` 注入的 `ShuyoFsPlugin.kt`（+ `shuyo-fs.pro`）。
   Rust 侧走 tauri 的官方移动扩展点
   （`tauri-2.11.5/src/plugin/mobile.rs:206` `api.register_android_plugin`），
   之后 `PluginHandle::run_mobile_plugin("pickedFileInfo", { uri })` 就是一次**同步的**
   Rust→Kotlin 调用 —— `tauri-plugin-fs`/`-opener`/`-dialog` 全走这条路，不是新机制。
   **为什么不用 `tls_android.rs` 那种裸 JNI**：`jni_handle().exec` 是把闭包投递到主线程执行的
   （wry 的 `MainPipe`），**拿不回返回值**，"发了就算"的初始化可以，取值不行。
2. **URI 尾段启发** —— `picked_file::name_from_uri`（纯函数）：外置存储那条能救回来；
   纯 id（`1234`）**主动拒绝**（当文件名显示比裸 UUID 更容易让人误以为"这就是原名"）。
3. **按内容嗅探** —— 新模块 `src-tauri/src/magic.rs`（魔数：PNG/JPEG/GIF/WebP/PDF/ZIP/GZ/7z/
   OggS/WAV/MP4/SVG/文本）。这一层让"图片能进预览、PDF 能进阅读器"**不依赖任何 Android 专属代码**，
   所以它能在本机单测里钉住（桥挂了也照样成立）。

**顺带修掉的同类哑火**：

- **临时文件名现在带正确扩展名**（uuid 保证唯一、扩展名交给下游）。
  这修掉了 `plugins.rs` 的"是不是 `.zip` 插件包"——它当时判的是 `source_path`，
  Android 上那是 `content://…%3A1000000042`，`ends_with(".zip")` **恒为假** ⇒
  手机上装 zip 插件包**必然**报"只支持 .zip 插件包"。现在判 `picked.effective_name()`
  （桌面等价，行为不变）。
- **`rename_attachment` 按新名字重算 mime**（判据只有一条：**新名字认得出类型才写回**）。
  `x.txt` 改成 `x.pdf` 就能立刻进内置阅读器；老数据（裸 UUID 名 + octet-stream）改成
  `photo.png` 也能自救。而改成**认不出**的名字（`report.pdf` → `report`、
  `x.unknownext`）**原样保留**原来的 mime —— 所以改名**永远不会把已知类型降级**成
  `application/octet-stream`（否则把 `report.pdf` 改成 `report` 就能把 PDF 阅读器弄丢，
  那是把能用的东西改坏）。

⚠️ **R8 是开着的**（`isMinifyEnabled = true`），`ShuyoFsPlugin` 只被 JNI/反射按名字调用，
所以必须有 Proguard keep 规则（脚本一并写 `gen/android/app/shuyo-fs.pro`）——
漏了就是"**CI 绿、release 真机炸**"（`ClassNotFoundException` / Plugin not initialized），
与 `rustls-platform-verifier` 那条同源。

**真机怎么验（必须用 release 包，R8 才生效）**：见 §2.3 的判据；最短一条是
**附件面板 → 选择文件 → 从「图片」里挑一张 ⇒ 列表里显示的是原文件名（不是 UUID）、
类型不是「文件」，点它能进内置预览**；再挑一个 PDF ⇒ 点它进内置 PDF 阅读器。

### 2.2.1 Android 上没有 `/tmp`：**一个根因、8 个症状**（2026-09-13 找到并统一修掉）

**起因**：§2.2 那次「真机点一次」正好撞上它——选文件链路的**最后一公里**断在这里，
报错是 `建临时目录失败（/tmp/shuyonote-picked）：No such file or directory`。

`std::env::temp_dir()` 在 Android 上返回 **`/tmp`**，而 **Android 根目录下没有 `/tmp`**
（`TMPDIR` 也没设）⇒ 任何 `create_dir_all("/tmp/…")` **立刻失败**。桌面永远有 `/tmp`，
所以这个坑**只在手机上暴露**，而且每个功能只报自己那句错，看起来像 N 个互不相干的 bug。

**同一个根因下的生产调用点（都已改掉）**：

| 位置 | 用途 | 手机上的后果 |
|---|---|---|
| `picked_file.rs` | 把选中的文件复制成可读副本 | ② 选文件直接失败 |
| `backup.rs` ×2 | 备份导出暂存 / 备份恢复解压 | 导出、恢复都失败 |
| `plugin_index.rs` | 插件包（zip）解压 | 装插件失败 |
| `workspace_io.rs` ×2 | 空间包导出快照 / 导入解压 | 空间导入导出失败 |
| `storage.rs` ×2 | 临时占用统计、清理临时文件 | 统计恒为 0、清理恒空转 |

**做法**：新增 `src-tauri/src/tempdir.rs`，启动时（`lib.rs` 的 `setup` **第一句**）把临时根
定向到**应用自己的缓存目录** `app_cache_dir()/tmp`（Android 上是
`/data/user/0/<pkg>/cache/tmp`：应用可写、系统可回收），之后所有临时文件都放它下面。

- `tempdir::dir(tag)` 已建好的唯一目录；`tempdir::path(tag)` 唯一路径但**不建叶子**
  （`package_temp_dir()` 明确要求"解压前目标不存在"，先建好可能让解压工具报已存在）；
  `tempdir::file(tag, ext)` 唯一文件路径（如快照 `xxx.db`）；`tempdir::subdir(name)`
  固定名目录（选文件的副本用它：目录稳定、文件名唯一，选多个也不会互相覆盖）。
- 用全局 `OnceLock` 而**不是**给每个函数加参数：这些调用点散在很深的工具函数里，
  有的（如 `plugin_index::package_temp_dir`）连 `AppHandle` 都拿不到。
- **兜底**：未初始化就退回 `std::env::temp_dir()/shuyonote`（桌面行为不变）；拿不到缓存
  目录时 `setup` 会打一行 `[tempdir]` 警告。
- `cargo test` 里的 `std::env::temp_dir()` **保持原样**：测试只在桌面跑，`/tmp` 一直在。

**顺带修掉一个"从来没生效过"的清理**：`storage.rs` 的 `cleanup_temp_files` 按前缀
`shuyonote-backup-` 找，而导出实际建的是 `shuyonote-export-` ⇒ 那半条清理**从来没命中过**。
现在前缀与创建时的 tag 对齐；临时根又是应用私有目录，扫它不会误删别人的文件
（故意不含 `picked/`：那里的副本可能还被前端引用着）。

**教训**：一个平台约定的差异（"有没有 `/tmp`"）会以 N 个互不相干的报错形式出现。
**按症状逐个修等于修 N 次**；要找共同的下游依赖（"临时文件放哪"）一次修掉。

### 2.3 真机验收能用什么手段、有哪些边界（2026-09-13 实跑记录）

**能用的**：

| 手段 | 用途 |
|---|---|
| `adb install -r <apk>` | 覆盖安装（**同一签名**才行） |
| `adb shell am start -W -n <pkg>/<activity>` | 冷启动 + 耗时（`TotalTime`） |
| `adb shell screencap -p /sdcard/x.png` + `adb pull` | **唯一能"看见界面"的手段**（`adb exec-out` 在 PowerShell 里重定向二进制会坏，走文件最稳） |
| `adb logcat -d -v brief` | Rust 侧 `println!` / panic 都以 `I/RustStdoutStderr` 出现——Boa 那条 panic 就是这么抓到的 |
| `adb shell dumpsys window displays` | 确认前台是不是自家 Activity（`mCurrentFocus`） |
| `adb shell ps -A` | 看插件宿主**子进程**在不在（注意：它**按需才起**，启动时通常没有，别据此说"没跑"） |
| `adb shell uiautomator dump` | 对**桌面/系统界面**有效（能拿到文字 + 坐标） |

**不能用（都实测过，别再重复踩）**：

- **WebView 里的 DOM 读不到**：`uiautomator dump` 在本应用上只拿到约 2.2 KB 的空壳、**没有任何文字节点**
  ⇒ 拿不到"插件管理"这类按钮的坐标，只能靠截图目测；
- **`input keycombination` 发不出 Ctrl+K**（试过 `113 41`）：命令面板根本不弹，两次截图逐字节相同；
- **`input keyevent ENTER` + `input text` 也进不去编辑器**：想验计划里 Phase 0 那条判据
  （"新建一篇笔记 → 写 → 重启后还在"），结果输入前后两张截图**逐字节相同** ⇒ 键没落到 WebView 里。
  **所以那条判据到现在仍未验**（是"手段不够"，不是"功能坏了"——别把它当成红）。
- **盲点坐标不可靠**：右栏图标会被已打开的面板挡住（✨ 一开就连带挡住 💬 与 ☰）；
  而两次 `BACK` 会直接退出应用——我那次点到了系统拨号盘。
  ⇒ **需要点按/打字的验收，交给人在真机上做**，别用盲点坐标假装自动化。

**给下次的建议（把"可驱动点"做进应用）→ 管道已接（2026-09-13）**

应用侧已经有测试钩子了，**只在带 `VITE_TEST_HOOKS=1` 的构建里生效**（正式发版不带它，
没有它时分派层直接拒绝、只提示一句"未启用"，有 5 条单测钉着）：

```bash
adb shell am start -a android.intent.action.VIEW -d "shuyonote://test/run-plugin?plugin=demo&cmd=demo.hello"
adb shell am start -a android.intent.action.VIEW -d "shuyonote://test/new-page?text=hello"
```

- 钩子**不绕过任何检查**：插件命令走与界面完全相同的 `usePlugins.runCommand`（权限与写中介
  原样成立），建页走 `useNotes.createPage`。它只是把"点命令面板/打字"换成"发一条深链"。
- `plugin=` 与 `cmd=` **两个都必须给**：我第一版想从 `demo.hello` 推出插件名——按最后一个点切
  被测试当场逮住，改成按第一个点切**仍然错**（真实例子里 `activity-digest` 的命令叫 `digest.show`，
  不带插件名前缀）。这条路在这份数据上不成立。
- 解析层**不把 `test` 写进给用户看的支持列表**（测试入口不该出现在错误提示里），有单测钉着。

#### 管道已接上（2026-09-13，含一处**我自己判断错**的更正）

三处都补了：`tauri.conf.json` 加了 `plugins.deep-link.mobile`（注意字段是**单数** `scheme`，
对应 `AssociatedDomain.scheme: Vec<String>`）；`deeplink::plugin()` / `attach()` 去掉
`#[cfg(desktop)]`，两平台共用同一份"先入队再 emit"。

**上面第 ③ 条（"移动端走 `onOpenUrl`"）是我编的，实际不存在这个 API。** 真实情况查
`tauri-plugin-deep-link-2.4.10/src/lib.rs` 得到的（结构性理由，不是试出来的）：

| | 桌面 | Android |
|---|---|---|
| 插件在 **Rust 侧**的入口 | `DeepLinkExt::deep_link()`（L481，**无 cfg**） | 同左（`mod imp` 那份 `DeepLink` 也 `pub use` 出来） |
| 冷启动那一次 | 插件 setup 读 `argv`（`handle_cli_arguments`，L195，**这是唯一桌面专属的**） | Kotlin `load()` 存进 `currentUrl` → `get_current()` 取回 |
| 应用已开着时 | `on_open_url`（L511，**无 cfg**） | `on_open_url`（Kotlin `onNewIntent` → channel → 插件 emit） |

所以"移动端 API 不同"是假差异：**变的是谁把 URL 送进来，不变的是 Rust 侧的入口**。
代价实测过——Android 上插件 emit 了 `deep-link://new-url` 却**没有订阅者**（`attach` 被
`#[cfg(desktop)]` 挡掉），前端永远收不到，表现就是"点深链完全没反应"。

**冷启动在 Android 上是同一个洞**：`DeepLinkPlugin.kt` L78-89 的 `load()` 里
`setEventHandler` 还没跑，`this.channel?.send(...)` 是**空操作**，URL 只落到 `currentUrl`。
`get_current()` 补收那段代码一行不改地正好补上——桌面（argv）与 Android（intent）的冷启动
是同一个洞的同一种补法。

#### 验收判据：能程序化就别靠截图

真机排查最难判的恰恰是"**URL 到底到没到 Rust**"："没反应"有两种完全不同的原因——URL 没进来，
或者进来了前端没接住。所以 `handle_urls` 现在会留一行**摘要**日志（只打动作、不打参数：
`?url=` / `?title=` / `?text=` 里可能是用户内容，而 logcat 落在设备上）：

```text
I/RustStdoutStderr: [deep-link] 收到 1 条 URL：shuyonote://test/new-page/…
```

于是判据分三层：① 这行日志 = URL 到了 Rust；② 截图 = 界面确实变了；③ 重启后还在 = 持久化成立。

**两条投递路径必须各验一次**（它们走的是不同代码，一条绿不代表另一条绿）：

```bash
# 路径 A：应用已开着（onNewIntent → on_open_url）
adb shell am start -W -n cn.shuyo.shuyonote/cn.shuyo.shuyonote.MainActivity \
  -a android.intent.action.VIEW -d "shuyonote://test/new-page?text=warm-1"

# 路径 B：冷启动就带 URL（load() → currentUrl → get_current 补收）
adb shell am force-stop cn.shuyo.shuyonote
adb shell am start -W -n cn.shuyo.shuyonote/cn.shuyo.shuyonote.MainActivity \
  -a android.intent.action.VIEW -d "shuyonote://test/new-page?text=cold-1"
```

⚠️ **`-n <组件>` 是显式 intent，绕过 intent-filter**：它只能证明"插件拿到了 URL"，
**不能**证明"浏览器里点链接能唤起应用"。后者看的是**合并后 manifest** 里有没有
`ACTION_VIEW` + `CATEGORY_BROWSABLE` + `scheme=shuyonote`（无需真机）：

```bash
aapt2 dump xmltree --file AndroidManifest.xml <apk> | grep -iE 'VIEW|BROWSABLE|shuyonote'
```

**2026-09-13 实测结果**——下面这些已经验过，不必再验：

- **合并后 manifest 三样齐全**：`android.intent.action.VIEW` ✓ `CATEGORY_DEFAULT` ✓
  `CATEGORY_BROWSABLE` ✓ `android:scheme="shuyonote"` ✓ ⇒ **浏览器里点链接能唤起应用**；
  旁证：不带 `-n` 的隐式 intent 也投递成功（`am start` 回 `intent has been delivered to
  currently running top-most instance`）。
- **两条投递路径都在 Rust 侧被证明**：warm（`onNewIntent`）与**冷启动**（`force-stop` 后带 URL
  启动，走 `load()` → `currentUrl` → `get_current()` 补收）各留下一条
  `[deep-link] 收到 1 条 URL：…`；**普通冷启动（不带 URL）时是 0 行** ⇒「零副作用」也成立。
- **前端确实收到并执行了动作**（不是只走到分派）：`new-page` 钩子让页面上真的出现新建的页
  （标题就是参数里的那段文本、状态"已保存"），`run-plugin` 钩子把插件返回值提示了出来
  —— 这两条要**先确认包里的钩子是开着的**（见上面的 `beforeBuildCommand` 坑）。
- **① 的证书校验器＝已验证通过**：`[tls] 证书校验已交给 Android 系统证书库` 1 条、
  `Expect rustls-platform-verifier` panic **0 条**，并且**真实 HTTPS 请求成功取回了内容**：
  `shuyonote://test/http-probe?url=https://www.baidu.com/` → `http-probe 107B: {"url":…`。
- ⚠️ **同一支探针打我们自己的域名当时失败了**——但**根因不是证书链**，`shuyo.cn` 那条
  「服务端要改链」的结论**当天就被我自己推翻了**（服务端**一个字没改，也不需要改**）。
  那次设备侧的失败**另有原因、尚未查清**，待**连着手机复测**时以真实报错为准——**别拿这份
  文档里下面这段旧结论去动生产服务器**。

  **曾经写过的错误结论（留着当反面教材）**：当时看到「服务端链条最后一张是
  `ISRG Root X2`」+「设备库 `grep` 计数 X1=1、X2=0」，就判成"rustls 按系统根库建不出链，
  修法在服务端（`certbot --preferred-chain "ISRG Root X1"`）"。**这两条证据都不足以支持
  那个结论**——链条里**第 4 张证书恰恰就是用来跨回 X1 的**：`ISRG Root X2` 由
  `ISRG Root X1` **交叉签名**（2026-05-13 起、2032-09-02 止）。交叉签名就是为这种老设备
  兼容性存在的，**"链条最后一张"往往不是终点**。

  **2026-09-13 用两条独立方法把它证死**（本机可复现，不必等手机）：

  1. **JDK 的 PKIX 校验器**（和 Android 系统根库是同一套路径构建算法）+ **只装
     `ISRG Root X1` 的信任库** → 连 `shuyo.cn:443`：**`RESULT: OK`**，链被建成
     `CN=shuyo.cn ← CN=YE2 ← CN=Root YE ← CN=ISRG Root X2 ←（锚）CN=ISRG Root X1`；
  2. **对照组**（证明上面那条 OK 不是"什么都放行"）：同一个 X1-only 信任库连
     `www.baidu.com` → **FAIL**；空信任库连 `shuyo.cn` → **FAIL**。
  3. 旁证：`openssl s_client -CAfile <只含 X1 的库> -verify_return_error -verify_hostname shuyo.cn`
     → **`Verification: OK` / `Verified peername: shuyo.cn`**。

  复现方式：`keytool -importcert -noprompt -trustcacerts -alias isrgx1 -file ISRG_Root_X1.pem
  -keystore x1.jks -storepass changeit`，再跑一个用 `TrustManagerFactory.getInstance("PKIX")`
  初始化 `SSLContext` 的小 Java 程序去连（脚本见本轮会话；根证书可从服务器
  `/etc/ssl/certs/ISRG_Root_X1.pem` 取，指纹 `96:BC:EC:…:08:C6`）。

  **教训（比结论值钱）**：判断"某客户端能不能验某个站点"，**不能靠数设备里有哪些根文件 +
  看链条最后一张是谁**来推，必须**拿一个只装那一条根的信任库真跑一次握手**。

**两条诊断手法（都是这次现学的，下次别再摸黑）**：

1. **toast 单行截断** ⇒ 把手机**转横屏**（`settings put system user_rotation 1`）再截图，
   一行能多显示一倍多；更彻底的是**让 Rust 侧 `eprintln!` 一行**到 logcat
   （`adb logcat -s RustStdoutStderr` 看全，不受界面宽度限制）。
2. **"分不清是哪一层"时先让错误自己说话**：`reqwest::Error` 的 `Display` 只有
   `error sending request for url (…)`，根因在 `source()` 链里——`bookmark.rs` 的
   `describe_err()` 就是干这个的。**在没有这行日志之前，我排掉了网络、AAR 没进包、
   没初始化三种可能，唯独排不掉真正的那一种。**
- **Phase 0 持久化判据（"新建一篇 → 写 → 重启后还在"）＝已验掉**：
  `list-pages` 基线 **41 页** → `new-page` → **42 页** → `force-stop` 重启 → **仍 42 页**。
  ⚠️ 这条**只能**靠"问列表"验：重启后应用总是停在空白新页上，**从界面看不出旧页在不在**
  （这一点我一开始没意识到，白拍了几张截图）。

  **2026-09-13 深夜补证（换成"正式密钥签名的包 + 重装后数据目录"再验一遍）**：

  | 阶段 | 数字 | 证据 |
  |---|---|---|
  | 基线 | **N = 33** | toast `共 33 页：新页面、快速开始…` |
  | `new-page` 之后 | **M = 34** | toast `共 34 页…` ⇒ 建页成功 |
  | `force-stop` 冷启动后 | **K = 34** | toast `共 34 页…` ⇒ **持久化成立** |

  6 次触发**全部**在 logcat 里留下 `[deep-link] 收到 1 条 URL`（0 次未分派）；冷启动后展开侧栏
  **逐行数得 34 行**，底部正是新建的两篇（`PERSIST-0913-CHECK`、`FRESH-20260913-223032`），
  与 toast 数字吻合。

  ⚠️ **顺带纠正一个误判**：这轮我一度根据"建页后界面仍是「开始你的第一页」空状态"判成
  **"全新安装建页失败"**（差点当成发版级 bug）。后来那篇 `PERSIST-0913-CHECK` **出现在页面列表里**
  ⇒ 页其实建上了，**那只是界面还停在空状态的显示时序**。教训：**"界面没变"不等于"操作没发生"**，
  判据要落在计数/列表这类可程序化的东西上。
  （仍未复现的是"真正空数据目录的首次启动"那一刻——那需要 `pm clear` 毁数据，没做，故不声称。）

  **抓 toast 的方法学（这轮踩过）**：按"裁图体积"判有没有抓到 toast **不可靠**——背景是内容丰富的
  编辑器时，无 toast 的裁图也能到 36 KB。**可靠做法是设备端连拍 16–24 帧、逐帧裁图取最大**：
  有 toast 的帧约 46–50 KB，无 toast 约 23–40 KB，且能覆盖 toast 只显示 2–3 秒的窗口。


一键跑完这套的脚本：`%TEMP%\device-hooks2.cjs <run_id>`（下载 CI 产物 → 静态查 intent-filter →
签名安装 → 三条路径 + 重启持久化 + 崩溃检查）。

#### ⚠️ 两个坑都出在 **CI 自己身上**（2026-09-13 真机抓出来的）

1. **进包的 `dist/` 不是"跑门禁"那一步做的那份**。`tauri.conf.json` 有
   `beforeBuildCommand: "pnpm build"`，所以 `tauri android build` **会再跑一遍前端构建**，
   而它**不继承别的 step 上的 `env:`**。`VITE_TEST_HOOKS` 原先只挂在那一步上 ⇒ **进包的是
   没有钩子的那份**。现象极具迷惑性：深链整条链路都通（Rust 日志有、前端也走到了分派），
   界面上却弹「测试钩子未启用（这是正式构建）」——看着像深链没打通，实际是**另一份构建在跑**。
   改法：变量挂 **job 级**。

   > 抓到它的办法值得记：**把截图间隔从 6 秒缩到 1.6 秒**。toast 只活几秒，
   > 之前所有"界面没反应"的判据都被这一个时间差骗过——`handle_urls` 的日志也一样，
   > 它只证明"URL 到了 Rust"，证明不了"前端用上了"。**两者要分开验。**

#### ⚠️ 附带发现：这条 workflow 之前**不会**因 Rust 改动而构建

`android.yml` 的 `paths:` 原本只有本文件与 `src-tauri/tauri.conf.json` 两条，于是改
`src-tauri/src/**`——恰恰是决定 APK 里跑什么的部分——推上去之后 **Actions 里连一条运行记录
都没有**。发现方式很土但有效：推完去看一眼 Actions，空的。**已按构建输入补齐**（见
`CHANGELOG.md`）。教训与本文件 §2.1 那条同源：**"改完会重新出包"这件事本身也要能被验证**，
判据是"推完去 Actions 看有没有新记录"，不是"我记得它配了"。


### 2.4 ⚠️ Rust 侧的 HTTPS 在 Android 上一请求就 panic（2026-09-13 真机实测，**修复方案未定**）

真机日志里逮到的第二处 Android 专属 panic（第一处是 §2.1 的 Boa）：

```text
thread 'tokio-rt-worker' (19189) panicked at rustls-platform-verifier-0.7.0/src/android.rs:90:10:
Expect rustls-platform-verifier to be initialized
```

**根因链**：`reqwest 0.13` 的默认 TLS 特性就是 `rustls`，而它**内联了 `rustls-platform-verifier`**
（其 `Cargo.toml` 里 `rustls = [..., "dep:rustls-platform-verifier", ...]`）；这个 verifier 在 Android 上
**必须先初始化**，否则 `global()` 直接 `expect(...)` panic。而它要在 Android 上工作，按它自己的文档
还需要**在 Gradle 里加一个 Kotlin 组件**（`rustls-platform-verifier-android`）——而我们的
`gen/android` **不在版本控制里**（"可重建、不可复现"）。

**影响面**（**Rust 侧**的 HTTPS，不是 WebView 的）：多设备同步（自建服务器走 https 时）、
插件索引拉取、AI 调用、检查更新。
⚠️ **WebView 自己的 HTTPS 不受影响**（OCR 语言包下载走的是浏览器栈）——这两条别搞混。

**两个候选修法**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 正经初始化**（**已采用**） | Gradle 指向那个 AAR + 启动时初始化。**关键事实已查清**：那个 Java 组件**不在 Maven 上**，而是**随 crate 发布**——本机实测在 `~/.cargo/registry/src/*/rustls-platform-verifier-android-0.1.1/maven/`，坐标 `rustls:rustls-platform-verifier:0.1.1`。**⇒ 必须脚本化**（`gen/android` 不在版本控制里） |
| **B. 换掉验证器** | 用 `ClientBuilder::use_preconfigured_tls(...)` 自建 `rustls::ClientConfig`（webpki-roots 或 rustls-native-certs） | **可能反而更糟**：webpki-roots 是内置根，**用私有 CA 自建服务器的用户会连不上**——而本项目定位是自托管优先 |

### 2.4.1 已按 A 实现（2026-09-13）

三处改动，都做成可复现的：

| 位置 | 做了什么 | 为什么在那儿 |
|---|---|---|
| `scripts/android-platform-verifier.mjs` | 往 `gen/android/app/build.gradle.kts` **追加**指向 crate 内置 maven 目录的仓库 + `implementation("rustls:rustls-platform-verifier:0.1.1")`，并写 `app/rustls-platform-verifier.pro` | `gen/` 不入库，CI 每次自己 `init` ⇒ 定制**只能脚本化**。脚本可重复执行，`--check` 给门禁用 |
| `src-tauri/src/tls_android.rs` | 启动时用 `JniHandle::exec` 拿 JNIEnv/Activity，初始化 verifier | 见 §2.5 的桥 |
| `lib.rs` 的 setup（建完主窗口后立即） | `tls_android::init(&_window)` | 必须在**任何 HTTPS 请求之前**；`jni_handle()` 要有 WebView 才拿得到 |

**Proguard 那条不能省**：release 开了 R8（`isMinifyEnabled = true`），而 `org.rustls.platformverifier.**`
只被 **JNI 按名字**用到，R8 看不见任何 Java 引用 ⇒ 会被当死代码删掉，运行时 `ClassNotFoundException`。
生成的 `build.gradle.kts` 正好用 `fileTree(".") { include("**/*.pro") }` 收集规则，所以脚本把 `.pro`
写进 `app/` 就会被自动收走（不需要再改 gradle）。

**验收判据**（三层，能程序化就不靠截图）：

1. `adb logcat -s RustStdoutStderr` 出现 `[tls] 证书校验已交给 Android 系统证书库` ⇒ 初始化跑到了；
2. **不再出现** `Expect rustls-platform-verifier to be initialized` ⇒ reqwest 那条路不再 panic；
3. 真机跑测试钩子 `shuyonote://test/http-probe?url=https%3A%2F%2Fshuyo.cn%2F`
   ⇒ 界面上出现 `http-probe <字节数>B：<内容开头>` 这样的提示才是**真的握手成功**（这条钩子复用现成的
   `fetch_bookmark_metadata` 命令——它**接受任意 https 地址**并返回网页元数据，所以能看到成功路径；
   ⚠️ 别用 `fetch_community_json`：它只认 `community.shuyo.cn` 一个域名，随便挑的地址必然 404，
   只能看到"失败"，证明不了握手成功。都是现成命令，不新增命令、不动能力清单；
   只在 `VITE_TEST_HOOKS=1` 的构建里存在）。

### 2.4.2 ⚠️ 又一个上游 bug：LE 取消 OCSP，让 Android 把所有 LE 站点判成"已吊销"（2026-09-13 找到并自带补丁修掉）

**现象**：初始化明明成功（§2.4.1），但安卓上走 Rust 的 HTTPS 打 LE 站点全挂：

```text
[http] 取网页失败 https://shuyo.cn/：error sending request ← client error (Connect)
                                      ← invalid peer certificate: Revoked
```

`shuyo.cn` ❌、`community.shuyo.cn` ❌、**`letsencrypt.org` 自己也 ❌**、`www.baidu.com` ✅。

**这是本轮最容易误判的地方**：一看到 `Revoked` 很容易往"我们服务器证书有问题"想（我第一版就是这么判的，**错了**）。
取证链（每一环都能自己复现）：

1. 服务器发的链是 4 张，最后一张是 `ISRG Root X2` 由 `ISRG Root X1` **交叉签名** —— 也就是 §2.4.1
   那种"给只信 X1 的老设备搭桥"的形态，**不是**"锚在 X2"；
2. 用**只装 `ISRG Root X1`** 的信任库跑 PKIX 握手：`shuyo.cn` **OK**；同一个库连 `www.baidu.com`
   **FAIL** ⇒ 说明这不是"什么都放行"，**链本身没问题**；
3. 把 4 张 CRL 全拉下来逐条查序列号：我们链上 4 张证书**都不在吊销清单里**，
   `openssl verify -crl_check_all` 也 OK；
4. 上线试过一招：把 `ISRG Root X1` 自签根**追加进链**再验 —— **没用**
   （Conscrypt 返回的"已验证链"不含信任锚，源码里那个"认识根就跳过吊销检查"的分支走不到），**已回滚**；
5. **决定性对照**：`letsencrypt.org`（LE 官网自己）挂在**同一个错误**上 ⇒ 与我们的证书、我们的服务器**都无关**。

**根因（上游，至今未修）**：Let's Encrypt 从 2025-08 起**取消 OCSP**、只发 CRL。而 Android 的吊销检查器
**默认先查 OCSP**，证书里没有 OCSP 地址时抛
`CertPathValidatorException: Certificate does not specify OCSP responder`，
上层把它当成**已吊销**（该 fail-open 的地方 fail-closed）。百度的中间证书**有** OCSP 地址，所以它能过
——这正好解释了"为什么偏偏别的站点没事"。

- 上游 issue [#221](https://github.com/rustls/rustls-platform-verifier/issues/221)（2026-02 开，**至今 open**，已指派）
- 上游 PR [#179](https://github.com/rustls/rustls-platform-verifier/pull/179)（**就是那两行**，未合并）
- 我们用的 `0.7.0` **已是最新版** ⇒ **升级解决不了**

**处置**：把上游那份 `CertificateVerifier.kt` **自带进仓库**（commit `73a4df87`，MIT OR Apache-2.0），
只加两行 `PREFER_CRLS` + `NO_FALLBACK`（即 PR #179 的内容），由 Gradle 随 App 编译，
**不再用 crate 自带的预编译 AAR**。溯源、许可证、复现步骤见
`scripts/vendor/rustls-platform-verifier/README.md`。

- 脚本里加了**构建期自检**：补丁选项不在、或 `gen/` 里还留着旧的 AAR 注入，就直接报错
  （这类回归**只有真机看得见**，所以拦在构建期）；
- JNI 契约核对过：用 `javap` 对比 AAR 与源码 —— 类名/包名一致，
  `private static final VerificationResult verifyCertificateChain(Context, String, String, String[], byte[], long, byte[][])`
  签名一致、名字**未被混淆**；
- 选它而不是"改用内置根库"：**保留系统证书库语义**（自建私有 CA 仍可用），
  且不必给 39 处 `reqwest::Client` 逐个塞自定义校验器。

**改这份 Kotlin 踩的两个坑（各吃了一次 CI）**：

1. **注释行吞掉了代码行**：补丁注释的末行没带换行，把 `revocationChecker.options = EnumSet.of(`
   粘进了 `//` 注释里 ⇒ 后面几个 `PKIXRevocationChecker.Option.XXX,` 成了无头表达式，
   Kotlin 报 `Unexpected tokens` ×3 + `Expecting an element`。**改完必须回看那一行有没有被注释掉。**
2. **`BuildConfig` 解析不到**：上游代码是在它**自己的库模块**里编译的，`BuildConfig.TEST` 来自那个模块；
   搬进 App 模块后 5 处 `Unresolved reference`。末尾补了个同包名垫片
   `internal object BuildConfig { const val TEST = false }` —— `TEST=false` 正好等于上游的**生产形态**。

**真机判据**：重跑 §2.4.1 那支探针，logcat 里 `[http] 取网页失败` **一条都不该有**。

### 2.5 修 A 路上的两套 jni：**已解决**（2026-09-13，原先判断为"硬阻塞"）

Tauri 侧的官方写法是有的——[tauri#13267](https://github.com/tauri-apps/tauri/issues/13267) 里
作者给出的写法是 `webview.jni_handle().exec(|env, context, _| …)` 拿到 JNIEnv/Context，
再调 `rustls_platform_verifier::android::init_with_refs(env.get_java_vm()?, …)`。**这组版本上编不过**：

| crate | 版本 | 依赖的 jni |
|---|---|---|
| `wry`（`jni_handle().exec` 给的就是它的类型） | 0.55.1 | **jni 0.21.1** |
| `rustls-platform-verifier` | 0.7.0 | **jni 0.22.4** |

两个 jni 大版本的 `Env`/`JObject` 是**不同类型**。jni 0.22 的 `JavaVM::singleton()` 文档还专门
警告过：**不同版本的 jni-rs 不共享任何状态**（`src/vm/java_vm.rs` L261-266），所以"随便找个版本
先把它初始化掉"这条路不存在。

**我原先写的"得用 `env.get_native_interface()` + `as_raw()` 重建 `Env`"是错的方向**——那是在
按结构体布局硬转。查源码后走的是两边各自**文档化的构造器**，只传裸指针：

| 步骤 | API | 出处 |
|---|---|---|
| 1. 拿到 env / Activity / WebView | `JniHandle::exec(FnOnce(&mut JNIEnv, &JObject, &JObject))` | wry `src/android/mod.rs` L479-484（注释原话："the jni environment, **Android activity** and WebView"）⇒ **Context 直接就有，不用反射去猜** |
| 2. 取裸 `JavaVM*` | `env.get_java_vm()?.get_java_vm_pointer()` | jni 0.21 |
| 3. 在 0.22 侧重建成 `JavaVM` | `unsafe { JavaVM::from_raw(ptr) }` | jni 0.22 `src/vm/java_vm.rs` L422 |
| 4. 拿 0.22 的 `Env` | `vm.attach_current_thread(\|env\| …)` | 同文件 L488（当前线程本来就附着着，这一步是廉价空操作） |
| 5. Context 转 0.22 引用 | `unsafe { JObject::from_raw(raw) }` → `init_with_env` | `rustls-platform-verifier` `src/android.rs` L97 |

**顺带纠正 crate 文档的两处过时**（照抄会写不出来）：README 里说的 `init_hosted` / `init_external`
在 0.7 里**已经不存在**（现在叫 `init_with_env` / `init_with_refs` / `init_with_runtime`，
见 `src/android.rs` L97/124/152）；`android.rs` 顶部示例里的 `EnvUnowned::from_raw(...).unwrap()`
也是旧签名——0.22.4 的 `from_raw` 直接返回 `Self`，没有 `Result`。

**这条路上被否掉的另外两个方案**（省得下次再想）：

- **`ndk_context`**：本机实测 **`cargo tree -i ndk-context --target aarch64-linux-android`
  报 "did not match any packages"**——它根本不在这棵依赖树里，**没有任何人初始化它**，
  `android_context()` 一调就 panic。要用它就得自己先有 vm/context ⇒ 循环。
- **换一份用 jni 0.21 的 verifier 版本**：`cargo tree -i rustls-platform-verifier` 显示它由
  **reqwest 0.13.4** 拉进来（tauri 自己也依赖），版本不是我们能挑的。

**为什么这值得单独记一节**：本地**编不了 Android**（`cargo check --target aarch64-linux-android`
会卡在 OpenSSL/mupdf 的构建脚本上），所以这类改动唯一的反馈是 CI（约 15 分钟一轮）+ 真机日志。
结论还是那句——**"能编过"与"跑得起来"在这条链上是两个独立事实**，本节的每一步都必须有真机判据。

#### 但"只有 CI 能编"要先怀疑一下：这段桥**可以**在本机试编

这次我为它烧了**三轮 CI**（`E0308` ×2、`E0061` ×1）才想到这一步，教训是：
**凡是"只有 CI 能编"的代码，先问一句"真的只有 CI 能编吗"**。

`wry` 与 verifier 的 jni 类型都是**纯 Rust**，不需要 NDK。所以开一个临时 crate，把两套类型
同时拉进来就能在本机做**类型检查**：

```toml
# Cargo.toml（临时仓库，别放进产品仓库）
[dependencies]
jni21 = { package = "jni", version = "=0.21.1" }   # ← wry 那一套
jni22 = { package = "jni", version = "=0.22.4" }   # ← verifier 那一套
```

把那段代码抄成两个函数（唯一的改动：`init_with_env` 换成同名同签名的空函数），`cargo check`
就能把形状查出来。**这次连栽的两个坑本地都能查出来**：

- jni 0.21 的 `JObject` **没有实现 `Clone`**，而它 `Deref` 到裸指针 ⇒ `activity.clone()`
  会静默命中 `*mut jobject` 的 `Clone`（报 `found &JObject`，改成 `(*activity).clone()`
  又报 `found *mut _jobject`）。正解：直接 `as_raw()` 拿指针，谁也不用 clone。
- jni 0.22 的 `JObject::from_raw` **要两个参数**（`&Env` + jobject）。

查不出的是"真机上跑起来对不对"——那是另一回事，仍要真机判据。

#### Gradle 那半边也能在本机先跑：只解析依赖，23 秒

同理，**不要**为了验一句 Gradle 配置去烧 15 分钟 CI（run #13 就是"Rust 编过了、Gradle 找不到
AAR"）。在生成出来的 Android 工程里只跑**依赖解析**，不编译任何东西：

```powershell
$env:JAVA_HOME = "$env:LOCALAPPDATA\Android\jdk-17\jdk-17.0.20.1+1"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd src-tauri\gen\android      # 先 `pnpm tauri android init --ci` 生成它
.\gradlew.bat --offline -q :app:dependencies --configuration universalReleaseRuntimeClasspath
```

本机实测 23 秒、退出码 0，且依赖树里能看到 `\--- rustls:rustls-platform-verifier:0.1.1`
（`--offline` 能过说明它真的从 crate 自带的 maven 目录解析到了，没走网络）。
顺带一个 **Gradle 的坑**（crate README 的示例在这里是错的）：加了
`metadataSources { artifact() }` 之后 Gradle **不读 pom**，只按坐标名找
`rustls-platform-verifier-0.1.1.jar`——而这里放的是 **.aar**（pom 里
`<packaging>aar</packaging>` 正是给它看的）。用默认 metadataSources 才会去拿 `.aar`。

### 2.6 应用内更新：下载 + 校验 + 交给系统安装器（2026-09-15 落地）

**改之前**手机上只能"跳发布页手动下载"：拿到清单里的 APK 地址就 `openExternal` 交给浏览器 /
DownloadManager，用户还得自己去文件管理器点安装（三步，中途还容易走错）。现在两步都在应用内。

| 步 | 命令 | 关键点 |
|---|---|---|
| ① 下载 | `download_android_update(url, sha256)` | reqwest 流式下到**应用缓存** `updates/`，**边下边算 sha256**，进度经 `android-update-progress` 事件回给界面；同一指纹已存在 ⇒ 直接复用（"装失败再点一次"不必重下整包） |
| ② 安装 | `install_android_update(path)` | 经 `FileProvider` 换成 `content://`（`file://` 从 Android 7 起抛 `FileUriExposedException`），`ACTION_VIEW` + `application/vnd.android.package-archive` 拉起**系统安装器** |

**三道自保**（这段是整条更新链上**唯一**的完整性判据——Android **不发 minisign**）：

1. 只收 `https://`（清单里已经是 https，这里再挡一次，避免前端被改成 http 地址）；
2. 指纹形状必须合法（64 位十六进制，`sha256:` 前缀可带可不带）——宁可不更新，也不装一个没法校验的包；
3. **校验不通过就删文件并报错**（不给"缓存里躺着半成品/被改过的包"留机会）。

**刻意不做静默安装**：Android 8 起"从应用里装 APK"需要用户给本应用开「安装未知应用」，
那个确认界面是系统的 ⇒ 我们只 `startActivity`，**装不装由用户决定**。所以这一步"成功"的定义是
"安装器起来了"，界面里留一句"请在弹窗里确认"（`.about-update-hint`）。
没有指纹（老清单）时退回「手动下载 / 前往发布页」，两条路并存。

**注入都在脚本里**（`scripts/android-mobile-shell.mjs`，`gen/` 不入库）：

| 位置 | 内容 | 漏了会怎样 |
|---|---|---|
| `ShuyoFsPlugin.kt` | `@Command fun installApk`（`FileProvider.getUriForFile` + `ACTION_VIEW`） | 点"安装"静默没反应 |
| `ShuyoFsPlugin.kt` | `@Command fun networkType`（`ConnectivityManager` + `TRANSPORT_WIFI`/`TRANSPORT_CELLULAR`） | C2 的「仅 Wi-Fi 下自动同步」永远拿不到真值（Rust 侧回 `unknown` ⇒ 按 fail-safe **不自动拉取**，表现为"自动同步不动了"） |
| `app/shuyo-fs.pro` | `-keep …InstallApkArgs` | **CI 全绿、release 真机上** `parseArgs` 反序列化不出来 |
| `AndroidManifest.xml` | `REQUEST_INSTALL_PACKAGES` + `FileProvider`（authority `${applicationId}.fileprovider`） | 抛 `FileUriExposedException` / 根本装不了 |
| `AndroidManifest.xml` | `ACCESS_NETWORK_STATE`（C2；**普通权限，安装即授予、不弹窗**） | `activeNetwork` 查询抛 `SecurityException` ⇒ 同上，退化成 `unknown` |
| `res/xml/shuyo_file_paths.xml` | `<cache-path name="updates" path="updates/" />` | `getUriForFile` 抛 `IllegalArgumentException` |

`--check` 现在**同时**核这 4 样 + Rust↔Kotlin 的**每一个**命令名（不只是第一个——`pickedFileInfo`
之外新加的 `installApk` 如果只写 Rust 不写 Kotlin，只 `match` 第一个的老写法会漏掉）。

**本机实证**（不用等 CI，也不用真机）：

```powershell
cd src-tauri\gen\android
.\gradlew.bat :app:compileUniversalDebugKotlin      # BUILD SUCCESSFUL（含 manifest 注入的校验）
.\gradlew.bat :app:minifyUniversalReleaseWithR8     # BUILD SUCCESSFUL
# R8 产物复核：usage.txt 里没有 ShuyoFsPlugin/InstallApkArgs（没被删），
#             mapping.txt 里类名与 installApk 方法名原样（没被改名）
```

> ⚠️ 本机跑 R8 前要先把 `gen/android/app/build.gradle.kts` 里**旧的 AAR 注入**删掉
> （`android-platform-verifier.mjs --check` 会提示这条）：那份 AAR 与"自带补丁的 Kotlin 源码"
> 都定义了 `org.rustls.platformverifier.CertificateVerifier` ⇒ R8 报
> `Type … is defined multiple times` 而失败。CI 每次从零 init，不会遇到。

**真机验收（2026-09-15，`ee3315d` 的签名包）**：

| 步 | 观测 |
|---|---|
| 入口 | 清单带 url + sha256 时，「关于」摆出 **「下载并安装」**（旁边保留「手动下载」「稍后再说」） |
| 进度 | 按钮文案 `下载中 16% → 61% → 94%`（`android-update-progress` 事件真的到界面） |
| 交给安装器 | 前台 Activity = `com.android.packageinstaller/.InstallStaging`，界面「ShuyoNote / 安装来源：ShuyoNote / 正在查验…」，应用内留下 `.about-update-hint` |
| **反面测试** | 故意给错指纹调 `download_android_update` ⇒ 「更新包校验不通过（期望 000…0，实际 d58f5bad…）——已丢弃」 |

两个省事的手法（下次直接用）：

```js
// ① 不用发版就能验整条链路：应用自己的测试钩子（debugUpdateVersion 读的就是这个查询参数）
location.href = "http://tauri.localhost/?updateDebug=9.9.9";   // 验完导航回 http://tauri.localhost/
// ② 反面测试：小文件（latest.json）+ 错指纹 ⇒ 下载很快结束、校验立刻失败，不必再下 56MB
window.__TAURI_INTERNALS__.invoke("download_android_update", { url: MANIFEST_URL, sha256: "0".repeat(64) })
```

未做的：**老清单（没有指纹）时"不摆应用内入口、只留手动下载"** 这一条只有单测覆盖
（要造这种清单得改发布通道，本机不值得）。

**发版后的真机实测（2026-09-15，v1.91.0 上线当天）**——这一次不是造场景，是真的升级：

手机上装的是 1.90.2，通道上是 1.91.0。打开「关于」⇒ 界面显示
**「发现新版本 v1.91.0，当前 v1.90.2」**、发布说明来自 `RELEASE_NOTES`，按钮是「下载并安装」✓。
点它 ⇒ `下载中 30% → 62% → 93%` ⇒ 前台变成 `com.android.packageinstaller/.InstallStaging` ✓，
应用里留下"已交给系统安装器"那句 ✓。**应用这一半到此为止，剩下全是系统/厂商的闸**：

| # | 闸 | 实测 | 谁能过 |
|---|---|---|---|
| 1 | 「是否允许 ShuyoNote 安装应用？」（安装未知应用） | 出现 ✓ 点「允许」即过 | 设备主人点一下 |
| 2 | **华为应用市场**的风险检查页（安全提示 + 推荐位 + 「已了解此应用未经检测…」复选框 + 「继续安装」） | 出现 ✓；`uiautomator` 读到复选框 bounds `[72,1879][180,1983]`、**「继续安装」在未勾选时 `enabled=false`**（所以"看不见的禁用按钮"会让盲点落到上一条「查找类似应用」上——我前两次就是这么踩空的） | 设备主人勾选 + 点 |
| 3 | **身份验证**（`com.huawei.coauthservice/…UnifiedAuthenticationDialogActivity`，指纹/密码） | 出现 ✓ **到此停手**：这需要设备本人，替用户过这道闸是错的 | **只有设备主人** |

⇒ 产品口径：我们的"应用内更新"做到"下载、校验、把安装器拉起来"为止，**装不装在系统界面里由用户决定**
——这正是 §2.6 开头写的设计，真机走一遍也证实了每一道闸都在用户手里。
附带的一条经验：手机上点这类系统弹窗**必须用 `uiautomator dump` 读真实 bounds**，
不要凭截图按比例估算（华为那页勾选后布局会位移，估出来的坐标会打到隔壁按钮上）。

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

## 4.1 窄屏浮层 / 弹窗硬约束（新增浮层时照做 · 2026-09-14 落地）

> 背景：19 层浮层在窄屏上**有三处是把功能弄坏、而且都不报错**的——设置面板 `min-width:640px`
> 压过 `max-width` ⇒ 「关闭设置」跑到视口外、**面板关不上**；浮层坐标没按**包含块**折算 ⇒
> 左侧被切 48px；全仓**没有滚动锁** ⇒ 浮层开着还能把正文拖走 323px。
> 这三个是**一类**问题（`min-width` vs `max-width` / 定位上下文 / 滚动归属），
> 所以规则写在下面，不逐个组件打补丁。

### 4.1.1 形态：按"多大"选，不按"像不像弹窗"选

| 形态 | 用在哪 | 关键点 |
|---|---|---|
| **底部弹层** | 小对话框、小选择器（确认/输入/快捷键/关于/图标/题头图…） | 贴底、顶部两角圆角、`max-height: calc(100dvh − 24px − env(safe-area-inset-bottom))` |
| **全屏 + 内部滚动** | 大面板（设置/插件管理/命令面板/存储/`plugin-panel`…） | 占满视口、**只有内容区一个元素可滚** |

- **浮层的断点是「窄**或**矮」**（2026-09-15 修正）：CSS 是 `src/App.css` **末尾**那段
  `@media (max-width: 768px), (max-height: 520px)`，JS 是 `src/hooks/useMobile.ts` 的
  `isMobileOverlayViewport()`（= `isNarrowViewport() || isShortViewport()`，两个常量是
  `MOBILE_BREAKPOINT_PX = 768` 与 `SHORT_VIEWPORT_MAX_PX = 520`）——**三处必须是同一对数**。
  JS 说"这是手机"而 CSS 说"这是桌面"会同时废掉两边的分支。

  > **口径写清（这里此前含糊，直接导致了一个线上坏法）**
  > · 「**窄**」（宽度 ≤768）回答的是"**布局**要不要换成窄屏形态"——侧栏收成抽屉、
  >   右栏整屏叠加、主区让位。那是**宽度**问题（横向没地方放），高度再矮也不改变结论
  >   （792×360 横屏仍放得下"侧栏 + 正文"两列）⇒ 所以 `isNarrowViewport()` **只看宽度**。
  > · 「**矮**」（高度 ≤520）**只**用于决定**浮层形态**（大面板 → 整屏 + 内部滚动）。
  > · 一句话：**布局看宽度，浮层看宽度和高度。**
  >
  > 只按宽度判会漏掉**横屏手机**：792×360 不窄 ⇒ 走桌面分支 ⇒ `.set-dialog` 用
  > `min-height: 420px` ⇒ 它压过 `max-height: calc(100vh - 48px)` ⇒
  > 实测 y=24 / h=420 / bottom=**444**，**底部 84px 被裁在屏外**（「关闭设置」就在里面）。

  > ⚠️ 那段 CSS **必须留在文件末尾**：`.plugin-panel` 的窄屏 `width:100%` 曾写在 18973 行，
  > 而基础规则在 19285 行——**特异性相同、后写的赢**，于是 390px 下面板只剩 326px。
  > 解决办法是"放在最后"这一条纪律，**不是 `!important`、也不是堆特异性**。
- 盒子上**一律 `min-width: 0` 且 `min-height: 0`**：`min-*` 会压过 `max-*`，
  这是最隐蔽的一类坑，而且**与轴无关**。上一轮只清了宽度轴（`min-width:640px`），
  高度轴的 `min-height:420px` 于是原样活到了横屏上——就是上面那条 84px。
- 高度用 **`dvh` 而不是 `vh`**，而浮层高度一律取 **`var(--ovh)`**：
  `--ovh: calc(100dvh - var(--sat) - max(var(--sab), var(--kb)))`
  ——已经扣掉状态栏与底部（**手势条 / 软键盘取大者**）。
  写死 `100dvh` 的面板在键盘弹起时底部那截会被键盘盖住；`vh` 则是"地址栏收起后"的高度，
  地址栏一露面底部操作栏就被推出屏。

### 4.1.2 四条硬约束

1. **内容区唯一可滚，并加 `overscroll-behavior: contain`**。
   否则要么内容高过盒子被裁掉**且滚不到**（同步面板的「保存」在 360px 上跑到屏外 121px、
   被 `overflow:hidden` 裁掉，就是这样），要么滚动链穿透到背景。
   列向 flex 里要让"该滚的那个"真的滚，还得给它 `min-height: 0`——自动最小高度是内容高度时它不滚。
2. **操作栏吸底 + `var(--sab)` / `var(--kb)`**。
   吸底用 `position: sticky; bottom: 0`，并在同一个元素上叠加
   `padding-bottom: calc(12px + max(var(--sab), var(--kb)))`，否则被系统手势条压住；
   **键盘弹起时还要再抬到键盘之上**（键盘比手势条高得多）。
   > ⚠️ **安全区一律用 CSS 变量，不要直接用 `env(safe-area-inset-*)`**（2026-09-15 改）。
   > 每个方向现在都有一层间接：`--sat/--sar/--sab/--sal`，由
   > `src/lib/viewportInsets.ts` 从**壳层送来的窗口 inset** 写入，`:root` 里拿
   > `env(safe-area-inset-*)` 当兜底。
   >
   > 为什么不能在 Android 上直接用 `env()`：WebView 的 safe-area inset 取自
   > **屏幕物理刘海（display cutout）**，**不是系统状态栏**。真机实测（Mate 40 /
   > Android 12 / 密度 3.0）：`dumpsys` 的状态栏 inset 是 123 设备 px = **41 CSS px**，
   > 而四个方向的 `env()` **全是 0px**。也就是说：**Android 上所有 `env(safe-area-inset-*)`
   > 的 CSS 都是安慰剂**——`viewport-fit=cover` 写了也一样（它是给 iOS 的）。
   > 详见 §4.2。
   > `index.html` 的 viewport 里那个 `interactive-widget=resizes-content` 同理
   > **在这套 WebView 上不生效**（同样见 §4.2），别指望它挡住键盘。
3. **命中区 ≥ 44×44**（触屏）。主要操作按钮与关闭类按钮上 `min-height: 44px` / `min-width: 44px`。
   签收口径就是 `scripts/verify-mobile-overlays.mjs` 里那条断言。
4. **打开时必须锁住「当前视图真实的那个滚动容器」——不是 `body`，也不只是 `.note-scroll`**。
   理由 ①：这套布局里滚动条**根本不在 body 上**——`.app { overflow: hidden }` 把整页钉死，
   所以 `document.body.style.overflow = "hidden"` 在这里**一点作用都没有**，是安慰剂。

   > ⚠️ **理由 ②（2026-09-15 修正上一版的错话）**：上一版这里写的是"真正滚的是
   > `.note-scroll`"，那是**在编辑器视图下**测出来的结论，被当成了普遍规律。
   > 真机复验时抓到：**切到「文件」视图时 `.note-scroll` 根本不在 DOM 里**，
   > 内容区换成了 `.file-manager-table-wrap`；侧栏抽屉打开时滚的是 `.sidebar-tree`。
   > 只锁 `.note-scroll` ⇒ 那些视图下**一个容器都没锁到**，锁静默失效
   > （当时"背景拖不动"其实是 `overscroll-behavior: contain` 挡住的，不是这把锁）。
   >
   > 现在改成**结构化发现**：应用外壳（`.app`）内、`overflow-y` 是 auto/scroll、
   > 内容确实溢出、且**没有任何 `position: fixed` 祖先**的元素 —— 全部锁上。
   > `position: fixed` 那一条是关键：它恰好把"浮层自己的滚动区"排除掉
   > （实测设置 / 命令面板 / 插件管理 / 图标选择器打开时，浮层内部的
   > `.palette-list` / `.ep-main` / `.set-body-scroll`… **无一例外**都有 `fixed` 祖先）。
   > 锁 `.sidebar-tree` 是**故意**的：窄屏侧栏是抽屉，浮层开着时它就是背景。

   别自己写：用 **`src/hooks/useOverlayScrollLock.ts`**（`useOverlayScrollLock(open)`），它已经处理了
   四件容易漏的事：**多浮层叠着时按计数解锁**（关掉上面一层不能把锁提前解掉）、
   **保留并恢复 `scrollTop`**、**用 `MutationObserver` 盯住滚动容器被重建时补锁**
   （只在"打开那一刻查一次"不够：那一刻它可能还没挂上，于是一个元素都没锁）、
   **不锁浮层内部的滚动区**（判据就是上面那条 `fixed` 结构事实）。

### 4.1.3 锚定浮层：`usePopover` 的两个坑

用 `src/hooks/usePopover.ts` 的浮层（搜索/回收站/同步/备份菜单…）注意：

- **坐标要相对包含块折算**。祖先上只要有 `transform` / `filter` / `will-change`，
  它就成了 `position: fixed` 的**包含块**，`left: 8` 会落在别处（实测落在 −40px）。
  所以窄屏收起的竖条用 **`left: -48px` 而不是 `transform: translateX(-100%)`**——
  `left` 不建立包含块，**从源头**掐掉这类坑。
- **打开期间要重算**：监听 `resize`、`orientationchange` 与 **`visualViewport` 的 `resize`/`scroll`**
  （软键盘弹出、旋转、拖分隔条都会改可视区）。
- 窄屏 / **矮视口**下 `usePopover` 返回**空坐标**并带 `isSheet`，由 CSS 走底部弹层（不再锚定触发按钮）。
  ⚠️ 判定用的是 `isMobileOverlayViewport()`（**宽 ≤768 或 高 ≤520**），不是只看宽度——
  792×360 横屏下"锚在触发按钮下方"这件事本身就不成立（`minSpace` 默认 360 > 视口高度）。

### 4.1.4 加了一层浮层之后：**必须**把它加进验收清单

`scripts/verify-mobile-overlays.mjs` 里有一个层清单（`OVERLAYS` 数组），
它是这套规则的执行点之一——新浮层不登记，就等于没人验过。跑法与加法：

```bash
pnpm dev:web                  # 另开一个终端，脚本要连真实 Chromium
pnpm test:mobile-overlays     # 有失败即非零退出
```

在 `OVERLAYS` 里加一行：

```js
{ id: "myDialog", label: "我的对话框", root: ".my-overlay", box: ".my-dialog", sheet: true },
```

- `root` 是**遮罩层**元素、`box` 是**那个盒子**（断言量的是盒子的四边）。
- `sheet: true` 表示窄屏是底部弹层（若它还靠 `is-sheet` 类切样式，再加 `sheetClass: true`）。
- 需要在**已打开的页面**或更深一层的入口才能取到触发器的，标 `optional: true`——
  取不到时会记一条 note 并跳过（**不算通过也不算失败**，属"未验证项"，要写进报告）。
- 打开动作写在脚本的 `openOverlay(which)` 的 `switch` 里，**走应用自己的 store**
  （与界面同一条路），不要往 DOM 里塞假节点。

跑到一层就断言：四边都在视口内、**`min-width` 与 `min-height` 都为 0**、无横向溢出、
被裁内容必须在可滚容器里、主要操作按钮够得到、**外壳真实的滚动容器被锁**（判据是
"内联 `overflow-y:hidden` 的容器列表非空"，并反向断言**浮层自己的滚动区没被锁**）、
触摸拖 300px 后那个容器的 `scrollTop` 变化 ≤4px、关闭类按钮 ≥44×44、
`.plugin-panel` 在 768 下占满宽、**桌面仍是锚定浮层**（防窄屏规则把桌面也改成弹层）。

> ⚠️ 「四边在视口内」**只挡越界、不挡被压窄**：2026-09-15 第三遍实测，
> 一个只有 72px 宽的浮层四边全都在视口里，那条断言照样绿。
> 所以标了 `fullscreen: true` 的层还要额外交两条**铺满**断言（遮罩铺满视口、
> 盒子铺满遮罩内容盒）——见下面「第三遍」。

另外三组（2026-09-15 新增，对应真机量出来的问题）：

- **两个断点的 JS/CSS 一致性**：768（`matchMedia("(max-width:769px)")` 也命中）与
  520（把视口卡到 521 高，`max-height:520px` 必须**不**命中；同时量 `isShortViewport()`）。
- **视口数量从 2 变 3**：新增 **792×360 横屏**。上一轮只有竖屏，于是
  "横屏不窄 ⇒ 走桌面分支 ⇒ `min-height:420px` 压过 `max-height` ⇒ 底部裁 84px"
  整类坏法没被覆盖——**这是上一轮的断言放水**：只断言了 `min-width`，高度轴空着。
- **注入 `--sat` / `--kb` 变量**量 CSS 那一半：`--sat=41px` 时**最高的可交互元素**必须在
  41 之下、全屏面板顶部也要让开；`--kb=260px` 时底部弹层与全屏面板都必须抬到键盘之上。
  （真机上这两个变量由壳层送进来，"送不送得进来"只能真机验——见 §4.2。）

> 规则改了要**自证能失败**：把修好的逐个改回坏的样子，看断言是否变红
> （2026-09-14 的 5 个变异测试全部被判红，其中两处精确复现了盘点里的 −48/−40 与 326px）。
> 只有能红的门禁才算门禁。
> 2026-09-15 新增的两条也自证过：把 `min-height:420px` 加回 `.set-dialog` ⇒ **792×360 那一档立刻红**
> （`bottom=444 > 360`）；把 `.app` 的 `padding-top` 去掉 ⇒ `--sat=41px` 那一组红。

#### 但"手写一张清单"本身漏一个就没人知道 ⇒ 补了**登记门禁**（2026-09-15）

真机复验抓到的第 6 个问题就是这么来的：**版本历史弹层没登记进返回栈**——
只开着它时 `window.__SHUYONOTE_BACK__.depth()` = **0** ⇒ 按返回键**直接退出应用**，
而弹层还开着（"19 层浮层全部登记"的说法当场不成立）。
漏一层**没有任何症状**：不报错、单测不红、`OVERLAYS` 那份手写清单也照样全绿
（它只检查**已经写上**的那些层）。**清单与实现对不上时，缺的那一方永远不会自己暴露。**

```bash
pnpm check:overlays          # = node scripts/check-overlay-registry.mjs；也串在 pnpm build 与 CI 里
```

它**枚举**仓库里"看起来是覆盖层"的组件（只认一件事：JSX 里字面量写出来的、
以 `-overlay` / `-popover` 结尾的 class token；刻意不做"文件名含 Panel/Dialog"这类模糊匹配，
否则内联面板会被全拉进来、豁免清单被噪声淹掉），然后要求：

| 判据 | 红了说明什么 |
|---|---|
| **A** 渲染浮层容器的组件必须调用 `useOverlayLayer("<id>", …)` | **新增浮层忘了登记**（或忘了显式豁免）——就是第 6 个问题那一类 |
| **B** 每个登记过的 id，其组件渲染的类名必须出现在 `OVERLAYS` 的 `root`/`box` 里 | 登记了但**没人量过它**（移动端几何验收里没有这一层） |
| **C** `OVERLAYS` 每一层的类名都要有组件真的渲染它、且其中至少一个登记了返回栈 | 清单里的**幽灵条目** / 类名被改名（改名后 `optional:true` 的层会**静默降级成一条 note**） |
| **D** 豁免清单不许过期 | 写了豁免、那个组件已经不存在了 |

豁免**必须显式**（脚本里的 `EXEMPT_COMPONENTS` / `EXEMPT_FROM_MOBILE_PASS`，每条都带理由），
且每次运行都会把整张豁免表打印出来——豁免是**显式的欠账**，不是藏东西的地方。

**2026-09-15 第二遍：`gap` 类别的同类缺口已清零。** 上一轮留在 `EXEMPT_COMPONENTS` 里的三处
（`.pdf-reader-overlay` 的浮层形态、插件声明式视图浮层、文件预览浮层）各接了一条
`useOverlayLayer`，于是它们从 A 判据转到 B 判据——**返回栈这一半修好了，几何验收还没纳入**
（打开它们需要一份真实 PDF / 装了视图声明的插件 / 一份真实附件，全新实例里造不出来；
硬塞假对象只会把"四边在视口内 / 外壳被锁"这些断言变成假红），所以三条都如实记在
`EXEMPT_FROM_MOBILE_PASS` 里，属**未验证项**。`gap` 这个类别保留着：下次再发现
"真的是应用级浮层却没登记"就先记在那里，每次运行 ⚠️ 打印出来。

与"版本历史"相关的那条**已经修掉并纳入几何验收**了：`.history-popover` 原来是
`position: absolute; right: 0` 的 320px 锚定浮层，窄屏**没走** §4.1.3 的 is-sheet 形态，
360×640 实测**左边缘 = −6px**（越界 6px）。现在它改用 `usePopover` + `is-sheet`
（JS 侧窄屏不锚定、CSS 侧铺底）+ 滚动锁，并进了 `OVERLAYS`：360×640 量到
`x 0..360 / y 538..640`（四边都在视口内），390×844 量到 `x 0..390 / y 742..844`。

另一条仍未纳入几何验收的是 `backupMenu`：侧栏备份按钮上的下拉菜单（`usePopover` 已管定位），
`OVERLAYS` 里没有它。

**2026-09-15 第三遍：`.fm-preview-overlay` 纳入几何验收，并补上"铺满"那条断言。**

上一轮把"文件预览浮层"记成未验证项，理由写的是"需要一份真实的附件（`target` 非空）才渲染"——
**这句是错的**：`useFilePreview.open()` 收的就是一份 `AttachmentMeta` **元数据**，
浮层完全由它渲染、根本不读文件（"要读字节"的只是 `.md` 分支）。
所以它现在进了 `OVERLAYS`（`fullscreen: true`），豁免同时撤掉。

这一进去就量出了真问题：**360×640 上这个浮层只有 72px 宽**（`x 288..360 / y 0..640`）。
根因是它基础规则的 `left: calc(var(--activity-w) + var(--sidebar-w))`——`--sidebar-w` 是
**桌面**侧栏宽度（240px），而窄屏的侧栏**早已收成抽屉**，变量却没人改，
于是 `left = 48 + 240 = 288`，`360 − 288 = 72`。与 `.set-dialog{min-width:640px}`
是**同一类**："功能不可用，而且不报错"。改法照 §4.1.1：窄屏走"大面板 → 全屏 + 内部滚动"，
让位方式与 `.set-overlay` 一致（给遮罩加 `var(--sat)/var(--sar)/max(--sab,--kb)/var(--sal)`），
内容区 `overscroll-behavior: contain`、图片预览那组按钮 ≥44×44，
并补上这一族唯一漏掉的那条 `useOverlayScrollLock`（实测只开着它时锁计数是 **0**）。

> ⚠️ **顺手补掉一个更值钱的坑：旧的几何断言挡不住"被压窄"。**
> 上面那个 72px 的浮层，四边**全都在视口里**（`x 288..360`），所以"根元素/盒子四边在视口内"
> 那条**照样绿**——把 `filePreview` 加进清单后跑一遍，**912 条断言全部通过，缺陷原样活着**。
> 于是新增 (1b)：标了 `fullscreen: true` 的层（§4.1.1 的"全屏 + 内部滚动"那一族：
> 设置 / 存储 / 插件管理 / 命令面板 / 公式 / 文件预览 / 目录 / AI / 评论）必须
> **遮罩横向铺满视口、盒子横向铺满遮罩内容盒**（安全区就写在遮罩的 padding 上，
> 所以脚本不用另抄那些变量）。变异自证：把 `left` 改回 `--sidebar-w` 依赖 ⇒
> **`✗ 全屏层的遮罩横向铺满视口（root x 288..360，视口宽 360）`**，327 通过 / **1 失败**；
> 改回后 360×640 量到 `x 0..360 / y 0..640`、390×844 量到 `x 0..390 / y 0..844`，
> 三档视口 966 通过 / 0 失败。

> ⚠️ **同一遍还抓到一条"假绿"**：`closeAllOverlays()` **从来没关过** `optional` 的
> `.markdown-import-overlay`（它不吃 Escape、也不在那张触发器表里）——
> 它组件里的 `useOverlayScrollLock()` 于是**永久留着一把锁**，后面每一层的
> "外壳被锁 / 锁住：note-scroll"都是被这把**泄漏的锁**满足的。
> 只开着文件预览时 `overlayScrollLockCount()` 实测 = **0**，而在整轮里同一个浮层却"通过"了锁断言。
> 现在 `closeAllOverlays` 会把它关掉（点「取消」），并**显式把封面浮层也一并关**。

相关：[RELEASING.md](RELEASING.md) ⑧（CHANGELOG 结构门禁）与 ①（`[Unreleased]` 的用法）。
脚本清单见 [development.md](development.md) 的"测试与验证"一节。

### 4.1.5 验收口径：顶部那条 inset 带**永远归 SystemUI**（2026-09-15 真机确认）

真机（Mate 40 / Android 12 / 密度 3.0）上量到的状态栏 inset = 123 设备 px = **41 CSS px**。
`targetSdk = 36` ⇒ Android 15 起对 SDK≥35 的 App **强制 edge-to-edge**
（壳里的 `enableEdgeToEdge()` 删掉也退不回去 ✗，见 §4.2.1），
所以应用**永远**都能把内容画进那一条带里——**但那一条带的触摸不属于它**：
状态栏是 SystemUI **自己的窗口**，位于应用窗口之上。

> ⇒ **验收标准是"可交互 UI 全部移出该带、顶部控件物理可点"，
> 不是"那条带变活"。** 别去想办法"穿透"它——那是按设计拿不到的。

两条判据：

1. **可交互 UI 全部移出该带**：`--sat` 取壳层报来的 inset；最高的那个可交互元素
   （`button` / `input` / `select` / `[role=button]` …）的 `top` 必须 ≥ `--sat`。
   浮层是 `position: fixed`，**不会跟着 `.app` 的 padding 走**，必须自己让位。
   浏览器侧那一条由 `verify-mobile-overlays.mjs` 注入 `--sat=41px` 量（见 §4.1.4）。
2. **顶部控件物理可点**：这一条**只能在真机上**验，而且要按下面这条做。

> ⚠️ **真机必须用 `adb shell input tap`**。CDP 的 `Input.dispatchTouchEvent`
> （`verify-mobile-overlays.mjs` 里那条"触摸拖背景"断言用的就是它）**直接注入渲染进程、
> 绕过 SystemUI** ⇒ **在那条死带里也会"成功"**。用合成触摸去验"顶部点得到"，
> 会把"点不到"验成"点得到"——**假绿**。
>
> 实测判据（§4.2.1 的原始记录）：`adb shell input tap` 打在 y ≤ 123 设备 px ⇒ DOM 收到 **0** 个事件；
> 打在 y = 130 / 180 ⇒ **100+** 个事件。脚本化的那条在
> `node scripts/android-mobile-shell.mjs --device-check`（走 `adb forward` + devtools socket）。

（这条口径是三次踩坑换来的：① 以为 `env(safe-area-inset-*)` 能拿到状态栏高度——
Android 上四个方向**全是 0px**，它取的是**屏幕物理刘海**；② 以为 `viewport-fit=cover` 或
`interactive-widget=resizes-content` 能救——在这套 WebView 上都不生效；
③ 用 CDP 合成触摸"验证修好了"——绕过 SystemUI，死带里照样"成功"。）

## 4.2 Android 壳适配层：窗口 inset / 软键盘 / 返回键（2026-09-15）

真机（Mate 40 `OCE-AN10` / Android 12 / 密度 **3.0**）上量出三个问题，**根因是同一个**：
`targetSdk = 36` ⇒ Android 15 起对 SDK≥35 的 App **强制 edge-to-edge**，而应用**没有消费窗口 inset**。

> 一句话结论：**edge-to-edge 之下，"画得到"不等于"点得到"。**
> 状态栏是 SystemUI **自己的窗口**，位于应用窗口之上，那一带的触摸**按设计归它**。
> 应用能把内容画在那里，却**永远收不到那里的触摸**——这正是 window insets 存在的理由。

### 4.2.1 顶部 41px 触摸死区（**最严重**）

**实测证据**：

| 项 | 值 |
|---|---|
| `adb shell dumpsys window displays` 里的状态栏 inset | `visible=true frame=[0,0][1080,123]` = **41 CSS px**（123 / 3.0） |
| 截图 | 应用标题「默认空间」与系统时间**文字重叠** |
| `adb shell input tap` 打在 y≤123（设备 px） | **0 个 DOM 事件**（扫 y=60 / 90） |
| 同上打在 y=130 / 180 | **100+ 个 DOM 事件** |
| `env(safe-area-inset-top/right/bottom/left)` | **四个方向全是 0px** |

**定位过程（先定位再改）**：

1. **死区边界正好等于状态栏 inset**（123 设备 px）⇒ 不是"某个透明覆盖层"，也不是
   WebView 命中测试的怪癖——那种原因的边界不会刚好卡在系统 inset 上；
2. **`env()` 四个方向都是 0** ⇒ 说明 WebView 根本不认为这里需要安全区。
   查下来是**语义不同**：WebView 的 safe-area inset 取自**屏幕物理刘海（display cutout）**，
   **不是系统状态栏**。这台机器没有刘海 ⇒ 恒为 0。
   ⇒ **Android 上所有 `env(safe-area-inset-*)` 的 CSS 都是安慰剂**，`viewport-fit=cover` 也救不了（那是给 iOS 的）；
3. 于是只剩一个解释：窗口没让开系统栏，**状态栏那一带被 SystemUI 的窗口占着**，
   应用在那一带收不到触摸。`MainActivity.kt` 里只有一句 `enableEdgeToEdge()`，**没有任何 inset 消费**。

**改法**（`scripts/android-mobile-shell.mjs` 注入，见 §4.3）：

- Kotlin 监听 `WindowInsetsCompat`，把 `systemBars()` 与 `ime()` 折算成 **CSS px**
  （除以 `displayMetrics.density`，与页面里的 `devicePixelRatio` 一致），推给页面
  `window.__SHUYONOTE_INSETS__({top,right,bottom,left,ime})`；
- 页面侧 `src/lib/viewportInsets.ts` 把它们写成 `--sat/--sar/--sab/--sal/--kb`；
- `App.css` 用这些变量给**外壳**（`.app` 的 padding）与**浮层**（`--ovh` / `bottom`）让位。
  `:root` 里保留了 `env(safe-area-inset-*)` 作为兜底值（iOS / 浏览器照旧）。

> **为什么不选"干脆不用 edge-to-edge"**：在 Android 12 上把 `enableEdgeToEdge()` 删掉确实有效，
> 但 App 的 `targetSdk = 36`——**Android 15 起对 SDK≥35 的 App 强制 edge-to-edge**，
> 删掉在 15/16 上**退不回去**，同一个 bug 会在新机器上原样复现。
> 所以只能真的消费 inset。（这条也是"别在旧设备上验证完就收工"的例子。）

**顺带抓到的一类**：窄屏把左侧竖条改成了 `position: fixed` 的浮层，
而 **fixed 定位不跟着 `.app` 的 padding 走** ⇒ 竖条展开时它的按钮仍从视口 y=8 开始，
**整条落在死区里**。同一个道理还适用于窄屏所有的 fixed chrome
（右抽屉已用 `top: var(--sat)` / `bottom: max(--sab,--kb)`，唤出按钮用 `bottom: calc(18px + …)`）。

### 4.2.2 底部弹层被软键盘盖住

**实测**：键盘弹起后 `innerHeight` 与 `visualViewport.height` **都不变**；
IME 覆盖 CSS y≥468，而底部弹层钉在 `bottom: 0` ⇒ 输入框正好被盖住。

**根因**：`interactive-widget=resizes-content` 在这套 WebView 上**不生效**，
而 `enableEdgeToEdge()`（= `setDecorFitsSystemWindows(false)`）之下**系统的 `adjustResize` 是空转的**
——窗口不会为 IME 缩小。

> ⚠️ **这一条推翻了本轮开工时的假设**：原计划是"读 `visualViewport` 写 `--kb`"，
> 但既然 `visualViewport.height` 根本不变，**web 层就没有任何办法察觉键盘**。
> 键盘高度只能走与 §4.2.1 同一条 inset 桥（`WindowInsetsCompat.Type.ime()`）。

**关于 `windowSoftInputMode`**：manifest 里**没有**这一项 ⇒ 默认 `adjustResize`
（**不是** `adjustPan`；若是 pan，内容会被整体上推，而实测内容纹丝不动）。
但如上所述它在 edge-to-edge 下是**死代码**，所以**故意不改 manifest**——
写上去只会让人以为"机制在 manifest 里"。

**`--kb` 的语义**（`viewportInsets.ts` 的 `keyboardExtra()`，有单测）：
**键盘额外盖住、而视口还没缩掉的那部分高度** = `max(0, 系统报的 IME 高度 − 视口已缩量)`。
不这样写就会**顶两遍**（某些 OEM/浏览器真的 resize 了窗口时）。CSS 侧：

- 底部弹层：`bottom: max(var(--sab), var(--kb))`，`max-height: calc(var(--ovh) - 24px)`；
- 全屏面板：高度取 `var(--ovh)`（`--ovh` 已扣掉 `max(--sab, --kb)`）；
- 外壳：`padding-bottom: max(var(--sab), var(--kb))`。

### 4.2.3 返回键直接退出应用

**实测**：搜索面板 / 设置 / 确认框三层，按返回键都是 `APP_STILL_FOREGROUND: False`（直接退出）。

**根因链（读源码定位，不是猜的）**：

1. `WryActivity.setWebView` 本来会注册一个返回回调，但 `TauriActivity` 把它**关掉了**：
   `override val handleBackNavigation: Boolean = false`
   （tauri `mobile/android-codegen/TauriActivity.kt:35`）⇒ wry 那条路不存在；
2. Tauri 自己的 Kotlin `AppPlugin`（`mobile/android/src/main/java/app/tauri/AppPlugin.kt:28-46`，
   由 `src/app/plugin.rs:141-146` 的 setup 注册）**确实**注册了一个 `OnBackPressedCallback`：
   没有 `back-button` 监听者时走 `canGoBack()` ⇒ **SPA 没有历史 ⇒ `false`** ⇒
   `activity.onBackPressed()` ⇒ `finish()`；
3. 上游给的逃生口是 `back-button` 事件（web 监听后它就不再退出），
   但**web 侧退不了应用**：`plugin:app|exit` **不在** `core:app` 的权限清单里
   （`src-tauri/gen/schemas/acl-manifests.json` 的 `core:app.permissions` 有
   `allow-register-listener` / `allow-remove-listener`，**没有** `allow-exit`），
   调它会先被 ACL 拒掉（`tauri/src/webview/mod.rs:1823-1852`：plugin 命令一律过 ACL）。
   ⇒ **"退出应用"这一步只能由壳层做。**

**改法**：`onWebViewCreate` 里注册自己的 `OnBackPressedCallback`。

- `OnBackPressedDispatcher` **后注册先派发**，而 AppPlugin 的回调是在 `Builder::build`
  阶段注册的（远早于 webview 创建）⇒ 我们的回调**一定先被调用**；
- 它先问页面：`window.__SHUYONOTE_BACK__.handle()`（`src/lib/overlayStack.ts`）
  —— **`true` = 页面关掉了最上层浮层，本次返回键到此为止**；
  **`false` = 栈是空的**，把自己 disable 后重新派发，落回 AppPlugin 那条回调（它没监听者 ⇒ `finish()`）。

**浮层栈**由各浮层组件用 `useOverlayLayer(id, open, close)` 登记（现在共 **24 条登记**，
`pnpm check:overlays` 的 B 段会逐条打印；2026-09-15 原为 19 层，真机复验补上了**漏掉的版本历史弹层**，
同一轮的第二遍又把剩下三处同类缺口接上：PDF 阅读器的浮层形态 / 插件声明式视图浮层 / 文件预览浮层
——见 §4.1.4 的登记门禁），**后进先出**：最后打开的最先关。逐条断言见 §4.1.4。

### 4.2.4 这一层怎么验（脚本化）

```bash
# 静态：注入的内容在不在（给门禁用，CI 里也跑）
pnpm check:android-mobile-shell
# 真机：需要 adb + 已装调试包（`VITE_TEST_HOOKS` 那支自检包）
node scripts/android-mobile-shell.mjs --device-check
```

`--device-check` 的判据（都走 `adb forward` + WebView 的 devtools socket + CDP）：

| 判据 | 说明 |
|---|---|
| `--sat` > 0 | 修前是 0（`env()` 那条路） |
| `.app` 的 `padding-top === --sat` | 外壳真的让开了 |
| **最高的可交互元素 y ≥ `--sat`** | 状态栏那一条带里**不许有 UI** |
| **`adb shell input tap` 打在顶部能收到 DOM 事件** | ⚠️ 必须用真实 tap：CDP 的 `Input.dispatchTouchEvent` 直接注入渲染进程、**绕过 SystemUI**，在死区里也会"成功" |
| 返回键：浮层栈非空时 `dumpsys` 的 `APP_STILL_FOREGROUND` 仍为 `True` | 修前是 `False` |
| 键盘可见时 `--kb` > 0 且弹层底边 ≤ `innerHeight − --kb` | |

## 4.3 真机抓到的两个"整个功能不可用"（2026-09-15 复验中）

这两个都不是样式问题，是**手机上那件事根本做不成**，而且桌面端完全正常、CI 全绿。
放在一起是因为它们是同一类：**Android 给回来的东西不是路径**，以及**系统 WebView 比引擎要求的旧**。

### 4.3.1 保存到用户选的位置：`content://` URI 被当路径用 ⇒ EROFS

真机现象（Mate 40 / Android 12 / 自检包 `666c062`）：

```text
设置 → 空间 → 导出当前空间 → 系统保存对话框 → 保存
  ⇒ 红字「空间导出失败：Read-only file system (os error 30)」
  ⇒ Downloads 里留下一个 0 字节的 space-复验素材-….zip
```

| 项 | 值 |
|---|---|
| 保存对话框实际返回 | `content://com.android.providers.downloads.documents/document/msf%3A…`（`DialogPlugin.kt::saveFileDialogResult` 只 `put("file", uri.toString())`） |
| 出错的那一行 | `std::fs::File::create("content://…")` |
| 为什么是 EROFS 而不是"权限不够" | `Path::new("content://…")` 是**相对路径**（第一段 `content:`），相对进程 CWD；Android 上 CWD 是 `/`，只读 ⇒ `EROFS(30)` |
| 受影响的命令 | `export_workspace`、`export_backup`、`copy_attachment`、`write_text_file`、`write_binary_file`（= 导出空间 / 导出备份 / 下载附件 / 导出 HTML / 导出模板 / 导出标注副本**六个入口**） |

**修法**（`src-tauri/src/save_target.rs`，与 `picked_file` 对称的写侧）：

| 目标 | 行为 |
|---|---|
| 桌面（普通路径） | 直接写该路径 —— **与改动前逐字节相同**（判据有单测：`classify()` 的路由） |
| Android（URI） | ① 在应用缓存里写一份**中转文件**；② 写完再整份**流式**拷进 URI（`Fs::open` + `write(true).truncate(true)` ⇒ Kotlin 侧折算成 `openAssetFileDescriptor(uri, "wt")`）；③ 无论成败删掉中转文件 |

**为什么不直接往 URI 里流式生成 zip**：`zip::ZipWriter` 需要 `Write + Seek`，而 `content://`
只能顺序写；更要紧的是写到一半失败会在**用户看得见的文件**里留半个包（中转文件则不会）。
`Drop` 兜底清理 —— 提前 `?` 返回也留不下垃圾，且**用户原始数据一字不动**。

### 4.3.2 打开任何 PDF 都失败：系统 WebView 是 Chrome 114，pdf.js 4.8 要 119+

真机现象：点开任何 PDF ⇒ 阅读器外壳起来了，正文里写

```text
这份 PDF 没能打开：Promise.withResolvers is not a function（字节 1820）
```

**先排除素材**：那份 PDF 在本机用**同一套 pdf.js** 解析正常（`numPages: 4`，页面 612×792）。
再量环境：

| 项 | 值 |
|---|---|
| `navigator.userAgent` | `… Android 12; OCE-AN10 … Chrome/114.0.5735.196 Mobile Safari/537.36` |
| `typeof Promise.withResolvers` | `undefined`（Chrome **119+** 才有） |
| `typeof AbortSignal.any` | `undefined`（Chrome **116+** 才有） |
| pdfjs-dist 4.8 里的用量 | `pdf.mjs` **32 处** `Promise.withResolvers`、`pdf.worker.mjs` **13 处**，`AbortSignal.any` 在能力对象的关键路径上 |
| legacy 构建能否救 | **不能**：`legacy/build/pdf.mjs` 里同样有 33 处（它只转译语法，不补运行时 API） |

**修法**（两层，缺一不可）：

| 层 | 文件 | 要点 |
|---|---|---|
| 页面 | `public/es-polyfills.js`（`index.html` 里**同步** `<script src>`，先于任何模块） | 幂等、**绝不覆盖已有实现**（现代浏览器上是空操作）；只用 `var`/`function`（`public/` 不过打包器，不依赖转译） |
| pdf.js worker | `public/pdfjs-worker-shim.mjs`（`pdfjsEngine` 把 `workerSrc` 指向它，带 `?real=<真 worker>&v=<版本>`） | 先动态 `import` 补齐层、**再**加载真 worker。⚠️ 真 worker **必须动态**加载：写成顶层 `import` 会被提升到 polyfill 之前 |

**worker 为什么必须单独补**：worker 是另一个 JS 上下文，页面上的 polyfill 到不了它；
而 pdf.js 自己的兜底（worker 出错 ⇒ 退回主线程 fake worker）只在"worker 还没 ready 就抛错"时触发。
**验收时要连控制台一起收**：出现 `Setting up fake worker` 即说明退回单线程 ⇒ 判不合格。

**已落地的自证**（都能在本机跑，不必等 CI）：

| 脚本 | 钉住什么 |
|---|---|
| `node scripts/check-pdfjs-worker-shim.mjs` | **顺序不变量**：探针模块在自己的模块体里必须已经看到两个 API；把垫片里两条 import 调换 ⇒ 该断言变红（变异自证已做；报错原文就是"真 worker 的模块体里没有 Promise.withResolvers —— 垫片的顺序错了"） |
| `pnpm vitest run scripts/es-polyfills.test.mjs` | 补齐层语义（resolve/reject 接通、`AbortSignal.any` 的 reason 传染与空数组）、幂等、**绝不覆盖原生实现**；把安装那行改成 no-op ⇒ 4 条断言变红 |

### 4.3.3 真机验收实操：这一轮踩到的坑（下次直接照做）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| **adb 推进去的文件，选择器看不见** | `/sdcard/Download/` 里明明有 `plugin-x.zip`，系统选择器里**不出现** | 这台设备（EMUI/Android 12）的选择器是 **MediaStore 驱动**；`adb push` 的文件没有 MediaStore 条目，`am broadcast MEDIA_SCANNER_SCAN_FILE`（API 29 起已废弃）也扫不出来。⇒ **只能用 App 自己写出去的文件**当素材：先用「文件管理 → ⬇ 下载附件」把内部附件存到 Downloads（可在保存对话框里**改成唯一的名字**，如 `probe-zhenji.png`），再用它做导入素材。**这条同时是判据的强证据**：那个名字在库里不存在，能出现在列表里就说明名字是**问系统问到的** |
| 只比"名字对不对"会**假绿** | 库里本来就有一行同名附件，导入后看起来还是那个名字 | 素材必须用**唯一名**（见上一条），否则分不清"新导入的行"与"原有行" |
| 同名附件会被**合并成版本组** | 行尾多出一个 `↻`（历史版本按钮） | 这是 `FileManagerView` 的既有分组行为，不是 bug；判读时别当成异常 |
| 设备会**自己转屏** | 上一秒量的还是 360×792，下一秒变成 792×360（横屏走"内联形态"，量出来的数字全变） | 量几何**当次**先读 `innerWidth/innerHeight` 并写进同一份结果（一次 CDP 调用里取全），别跨调用拼数字；要固定姿态用 `settings put system accelerometer_rotation 0` + `user_rotation 0`（这台设备会被系统重新打开自动旋转，必要时重设） |
| 保存对话框的**文件名框** | 想改成唯一名，`input text` 只在**先点中那个输入框**后才生效 | `adb shell input tap <名框坐标>` → `keyevent KEYCODE_MOVE_END` → 多次 `KEYCODE_DEL` 清空 → `input text <ASCII 名>` → 点「保存」 |
| `.ps1` 在 Windows PowerShell 5.1 下**乱码/解析失败** | 提示 `The string is missing the terminator` | `tmp/` 下的脚本要么纯 ASCII，要么**存成带 BOM 的 UTF-8**（仓库门禁 `check:ps1-ascii` 就是这个规矩；`write` 工具写出来的是无 BOM，加 BOM 用 `[System.IO.File]::WriteAllBytes`） |
| 连续推送会**取消在跑的 CI** | `ci.yml` 有 `concurrency: cancel-in-progress: true`，而 Rust job 是最长一棒 ⇒ 推得越勤，"CI 绿"越不会出现 | 等一轮**跑完**再推下一轮；查状态时**三个 workflow 都要看**（只查名字像 CI 的那个会漏掉 Android/build 的红） |

### 4.3.4 窄屏下 PDF 阅读器**内部分栏**（2026-09-15 真机量到 → 已修）

4.3.2 修好的是"**打得开**"（`第 1 / 4 页`、正文渲染成 `.pdf-annot-img`、控制台有真 worker 的日志）。
真机上接着量到**第二个问题**：360 CSS px 宽时阅读器**内部**仍是桌面的三栏布局——

| 元素 | 修前实测（360×792） | 修后 |
|---|---|---|
| `.pdf-reader-overlay` / `.pdf-reader` | 0,0,360×792（整屏 ✓ 这条本来就对） | 不变 |
| `.pdf-outline-col`（目录） | **240 宽、常驻在左侧**，压着正文 | 抽屉：`position:absolute` + `width:min(300px,86vw)`，**默认收起** |
| 批注栏 `.pdf-sidebar-col` | 与目录并排，右侧文字被**裁掉**（截图里"暂不…"被切） | 同上（贴右抽屉，默认收起） |
| 页面图 `.pdf-annot-img` | x=99、宽 306 ⇒ **右边溢出屏幕**（99+306=405 > 360） | 正文区 `width:100%`，页面按 `适合宽度` 铺满 |
| 拖宽把手 | 并排形态下有意义 | 抽屉形态下 `display:none`（宽度由 CSS 定） |

**改法**（与 §4.1 那 19 层同一条纪律，两处必须一起改）：

| 位置 | 改动 | 为什么 |
|---|---|---|
| `src/App.css` 末尾的 `@media (max-width:768px), (max-height:520px)` | 两栏 `position:absolute` + 贴左/贴右 + 阴影 + `min(300px,86vw)`；`.pdf-reader-layout > .pdf-reader-stage-wrap { width:100% }`；把手 `display:none` | 抽屉形态由 CSS 定宽 |
| `src/components/PdfReader.tsx` | 用 `useMobileOverlayViewport()` 把 `outlineOpen`/`sidebarOpen` 的**初值**设成 `false`；切到浮层视口时**收敛为收起**；抽屉形态下**不写内联 width** | ⚠️ 内联 `style={{width}}` 优先级高于 CSS，写了就把抽屉顶回 240px 的列——两边必须同时改 |

**判据（都能自动跑）**：

| 层 | 判据 |
|---|---|
| CSS 级（`pnpm test:mobile-overlays`，+4 条断言） | 窄屏段里两栏必须是 `position:absolute`；**那条规则必须挂在"窄**或**矮"的同一条查询里**（只写 `max-width` 的话横屏手机又回到并排）；抽屉宽度有上限、正文区 `100%`。变异自证：把 `position:absolute` 去掉 ⇒ 3 条变红 |
| 单测（`useMobile.test.ts`，+2 条） | `subscribeOverlayViewport` **两条查询都要订阅**、取消订阅两条都要摘。变异自证：把矮视口那条改成订阅窄屏查询 ⇒ 2 条变红。这条挡的是"只在挂载时判一次视口/只盯窄屏 ⇒ 竖屏转横屏不更新" |
| 真机 | 打开 PDF：目录/批注栏**默认不出现**、页面图不出屏；点工具条的目录按钮 ⇒ 抽屉盖上来（宽度 ≈ 86vw）；返回键照旧关层不退出 |

### 4.3.5 同一次装机里接着暴露的另外三处（都已修 + 真机复验）

4.3.4 修完装机一看，**同一个组件还有三处**，全部是"手机上那个按钮根本点不到"这一类。
按发现顺序记，因为它们的**判据不一样**——最后一处只有**真实 tap** 能验。

| # | 症状（真机实测） | 根因 | 判据 |
|---|---|---|---|
| ① | 头部工具条内容 **730px** 宽，`scrollWidth 617 > clientWidth 360`：放大 / 还原窗口 / 显示批注侧栏 / 提问 / 护眼 / 导出带批注副本 / **关闭（x=686..730）**整排**在屏外**（外层 `.pdf-reader` 是 `overflow:hidden` ⇒ 点不到）；批注工具行 489px 同理 | 头部/工具行是"一行排到底"，没有窄屏形态 | CSS 级：`.pdf-reader-head` 必须 `flex-wrap: wrap` |
| ② | 加了 `flex-wrap` **仍然溢出**（`scrollWidth` 617） | 头部里的 `.pdf-reader-controls` **自己就是 603px 宽的行** ⇒ 换行只发生在"直接子元素"这一级，内层不换行就等于没换 | CSS 级：内层 `.pdf-reader-controls` 也必须 `flex-wrap` |
| ③ | 阅读器内部 **18 个按钮 < 44×44**（头部一排 28×28） | §4.1 那条"命中区 ≥44"当初没覆盖到阅读器内部 | CSS 级：`.pdf-reader-head button` 等必须 `min-*: 44px` |
| ④ | **目录开关物理点不到**：开关中心在设备 **y=96**（状态栏带 0..123 之内），`adb shell input tap 108 96` **什么都没发生** | 阅读器浮层 `position:fixed; inset:0` 且不给 `--sat` 让位 ⇒ 头部第一行整体落在 §4.2.1 那条"归 SystemUI"的触摸死区里 | **真实 tap**：修后点设备 (108,219) ⇒ `.pdf-outline-col` 出现在 DOM 里；同一手法点「关闭」⇒ 浮层消失且应用仍在前台 |

修后真机复验（`tmp/fixture/pdfhead2.js` / `pdflayout2.js`）：

```
headButtonCount 12 · offscreen [] · smallCount 0 · closeVisible true · scrollWidth 360 == clientWidth 360
outlineInDom false · sidebarInDom false · 页面图 x=12 w=328（right 340 ≤ 360）
物理点 (108,219) ⇒ outlineInDom true        物理点 (972,819) ⇒ depth 1 → 0、应用仍在前台
```

**两条教训**（比修法更值得记）：

1. **"加了 wrap" ≠ "不溢出了"**：CSS 级断言只能挡住"规则被删掉"，几何是否真的不溢出必须量
   `getBoundingClientRect`。②就是"断言绿、真机仍溢出"的典型——断言查的是"有没有 wrap"，
   而真机查的是"每个按钮的 right 是否 ≤ 视口宽"。
2. **门禁自己的白名单也会假红**：那 8 条 PDF 断言的候选规则收集原先带一个"只收这些选择器"
   的白名单，连着漏了 `.pdf-reader-head`、`.pdf-reader-controls`、`.pdf-reader-overlay`
   ⇒ 三次都是"断言找不到规则 ⇒ 假红"。现在**全收**，筛选放到断言里。

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

- **Tauri 原生壳（Android/iOS）**：见 上线计划（已移入私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md`） 的
  Phase 1 清单（含**最高风险项：Android 选文件 SAF**——`import_attachment_files` 走
  `std::fs::read(path)`，而 `open()` 可能返回 `content://`）。
- **WebView 壳（鸿蒙）**：每个壳在真实设备上验「打开外链走系统、附件可读、
  编辑/数据库/检索正常」，并跑 `scripts/smoke-web.mjs` 回归。
