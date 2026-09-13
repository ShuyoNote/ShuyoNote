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

**已完成**：体积压缩（arm64 **156.7 → 53.41 MiB**，目标 55–70 MiB 达成）、CI 出包
（`.github/workflows/android.yml` 已跑通）、版本号联动（Tauri 每次 `android build` 自动同步
`tauri.properties`，**不需要额外脚本**）。

**已完成**：体积压缩（arm64 **156.7 → 53.41 MiB**）、CI 出包（`.github/workflows/android.yml`）、
**首次真机跑通**（2026-09-13 · HUAWEI Mate 40 `OCE-AN10` / Android 12：装上、冷启动 589 ms、界面正常渲染）。

**待做**（详见私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md` 的阶段划分）：
正式 keystore 与密钥保管、应用内"检查更新"、逐条真机验收、上架材料。

### 2.1 移动端**不提供** / **已知有问题**的能力（边界要能说清，别含糊）

走 Tauri 原生壳意味着大部分能力与桌面一致（加密、附件、同步、原生 PDF 都在），
目前有**两项**要说清：

| 能力 | 移动端 | 为什么 / 边界落在哪 |
|---|---|---|
| **聚合邮箱（含发信）** | ❌ 不做（2026-09-13 定） | 它走 `native-tls`（桌面用系统 TLS），移动端要为此从源码交叉编译 OpenSSL。Rust 侧 `mod email`/`mod smtp` 与 23 个命令带 `#[cfg(desktop)]`，**移动端这些命令不存在**；前端入口用 `emailSupported()` 隐藏 |
| **插件运行时（Boa）** | ✅ **已修**（2026-09-13 真机复验：那条 panic 在日志里消失） | 见下面「Boa 的 nan-boxing 在 Android 上不成立」 |

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
3. 真机跑测试钩子 `shuyonote://test/http-probe?url=https%3A%2F%2Fcommunity.shuyo.cn%2F`
   ⇒ 界面上提示"拿到 N 字节"才是**真的握手成功**（这条钩子复用现成的 `fetch_community_json`
   命令，不新增命令、不动能力清单；只在 `VITE_TEST_HOOKS=1` 的构建里存在）。

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

- **Tauri 原生壳（Android/iOS）**：见 上线计划（已移入私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md`） 的
  Phase 1 清单（含**最高风险项：Android 选文件 SAF**——`import_attachment_files` 走
  `std::fs::read(path)`，而 `open()` 可能返回 `content://`）。
- **WebView 壳（鸿蒙）**：每个壳在真实设备上验「打开外链走系统、附件可读、
  编辑/数据库/检索正常」，并跑 `scripts/smoke-web.mjs` 回归。
