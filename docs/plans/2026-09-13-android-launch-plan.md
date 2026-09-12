# 移动端上线计划（Android 优先）· 工程侧

> 📤 **2026-09-13 拆分**：「上线」里的**合规 / 商店 / 推广**部分属公司运作材料，已迁至私有仓库
> `shuyonote-sync-server` 的 `docs/android-launch-plan.md`——软著登记材料与周期、各商店开发者账号、
> 隐私政策页、上架材料，以及"合规必须今天启动"那条关键路径。
> **本篇只留工程侧**：现状审计、路线收口、体积账、Phase 0–2、真机验收判据与工程风险。
> 两篇**不重复维护同一件事**。

> 2026-09-13 制定。目标：**Android 原生 App（Tauri 移动端）**，第一批用户走
> **官网 APK 直下 + 酷安**。
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
| 真机 APK | ⚠️ 能构建但**未签名** | 09-10 本机产出 arm64 156.7 MiB / universal 258.8 MiB；**2026-09-13 CI 产出 arm64 53.41 MiB**（见「体积账」） |
| 版本号联动 | ✅ **Tauri 自动同步** | `gen/android/app/tauri.properties` 每次 `android build` 刷新：`1.90.1 / 1090001`（口径 `major*1e6+minor*1e3+patch`）。~~停在 1.82.18~~ 是我看陈旧文件得出的错误结论，已更正 |
| 体积 | ✅ arm64 **53.41 MiB**（目标 55–70 MiB） | 见下面「体积账」 |
| 签名 | ❌ 无 keystore、gradle 无 `signingConfig` | — |
| CI | ✅ **已跑通**（`.github/workflows/android.yml`，run #3 绿） | 路上翻出**两个只在 Linux 上暴露**的坑（NDK 无 `aarch64-linux-android-ranlib`、mupdf-sys 的 bindgen 不带 `--target`），修法与理由写在 workflow 的步骤注释里 |
| 应用内更新 | ❌ Android 没有 | updater 被 `#[cfg(desktop)]` 关掉，且移动端本就该走商店/重新下载 |
| iOS | ❌ 完全没有脚手架 | 无 `gen/apple` |

**一句话**：这不是从零开始——**能跑、能构建的底子已经有了**；缺的是「能装、好用、能持续发、能上架」
这四件事，以及一件容易被忽略的：`gen/android` 不在 git 里，所以**任何手工改过的 gradle/manifest 都不可复现**。

---

## 二、✅ 已拍板（2026-09-13）：仓库里那两条互相冲突的移动端路线，收口为「只留 Tauri 原生壳」

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

> **已于 2026-09-13 拍板并落进文档**：
> **移动端 = Tauri 原生壳（Rust 内核）**；**WebView 壳路线只保留给 Tauri 不可达的平台**
> （当前只有**鸿蒙 ArkWeb**）。
>
> 已同步的位置：`docs/MOBILE.md`（重写，决策放在最前并给出选型判据）、
> `docs/roadmap.md`（M6 标题与状态、M16 引言、M16.4「各平台壳」的范围收窄、竞品表的「多端」行）、
> `docs/README.md`（M6 / M16 两行登记）。
>
> 附带一条判据，供以后新平台直接套用：**只要这个平台能跑 Tauri，就走 Tauri 原生壳；
> 走不了才退到 WebView 壳，并且要如实标注该平台是能力子集。**

> 顺带一条：`MOBILE.md` 记录的 **iOS 环境结论**（那台 Mac 上没有 Homebrew + 系统 Ruby 2.6 →
> `cargo tauri ios init/build` 全链路不可行，缺 xcodegen/CocoaPods）对以后做 iOS 依然有效，
> 与 Android 无关，但别到时候重新踩一遍。

---

## 三、体积账（**已实测**——本节第一版是估算，被实测推翻了）

### 3.1 先纠正一个错误结论

本节最初写的是「`.so` 101 MiB → 加 `strip` 压到 ~30 MiB」。**实测推翻了它**：

```text
arm64 的 libshuyonote_lib.so = 101.2 MiB
  llvm-strip --strip-unneeded → 88.4 MiB   只减 12.7 MiB（12.6%）
  .debug_* 段数量 = 0                      ← 本来就没有调试信息，strip 省的不是它
```

省下的 12.7 MiB 正好等于 `.symtab`(5.79) + `.strtab`(6.96)。段构成：

| 段 | 大小 | 占比 |
|---|---|---|
| **`.rodata`** | **55.95 MiB** | **63%** |
| `.text`（真正的代码） | 23.23 MiB | 26% |
| `.eh_frame` / `.rela.dyn` / `.data.rel.ro` 等 | ~8.7 MiB | 10% |

**代码只有 23 MiB**，所以问题从来不在代码量，也不在符号。

### 3.2 那 56 MiB 的 `.rodata` 是什么：**Tauri 把整个前端嵌进了 `.so`**

`target/<triple>/release/build/shuyonote-*/out/tauri-codegen-assets/` = **304 个文件、50.2 MiB**，
其中最大的两个 `.gz` 正是 OCR 语言包（**19.18 + 10.42 = 29.6 MiB** = `chi_sim` + `eng`）。

**这一节原先那句"Android 上前端被装了两遍"要分两次说**——2026-09-13 的 CI 构建推翻了它的一半：

| 构建 | APK 的 `assets/` | `.so` 里的内嵌副本 | 前端装了几遍 |
|---|---|---|---|
| 09-10 本机（旧 CLI 建的 `gen/android`） | **124.1 MiB / 306 个文件**（含 `index.html`、`boot-scripts.js`） | 有（`.so` 101.2 MiB） | **两遍** |
| 2026-09-13 CI（`tauri android init --ci` 全新生成） | **3.5 KB / 3 个文件**（只有 `tauri.conf.json` + 两个 dexopt profile） | 有（`.so` 50.75 MiB） | **一遍** |

两次的 `.so` 里都能查到 `index.html` / `/assets/` / `manifest.webmanifest` / `sw.js` /
`tauri.localhost` 这些字符串，即**前端确实嵌在 `.so` 里**；差别只在 APK 的 `assets/` 那份副本。

> ⚠️ **一处尚未定论的点，不许当成已解决**：Android WebView 到底从哪一份加载？
> 支持"从 `.so` 那份加载"的证据是——两个 APK 的 `classes.dex` 里都只有 `WebViewAssetLoader`，
> **没有** `android_asset` / `file:///android_asset`；而 `WebViewAssetLoader` 更像对着 CSP 里的
> `asset.localhost`（用户文件的 asset 协议），`tauri.localhost` 只出现在 `.so` 里。
> 但**这只是证据，不是真机验证**：按 §七 的规矩，它必须在真机上开一次才算数
> （前置是签名，见私有仓库 `docs/android-launch-plan.md`）。
>
> ✅ **现在有办法一次定论了**（2026-09-13）：已用测试 key 签出一份**可直接安装**的包
> （§0.1 第 3 条）。**判据很简单**——装上打开：
> 能看到笔记列表 ⇒ 前端确实由 `.so` 内嵌副本提供，`assets/` 那份是多余的（本节上表的结论成立）；
> **白屏 / 停在启动画面** ⇒ `assets/` 那份是必需的，CI 里必须补回前端产物（那就是个真回归）。
> 无论哪种结果，都要把结论回填到本节，别让它继续挂着。

### 3.3 `dist/` 的构成（89.2 MiB）与查出来的死重

| 目录 | 大小 | 内容 |
|---|---|---|
| `ocr/` | **72.9** | `core/` **43.2**（6 个 tesseract-core 变体 × 2 种形态）、`tessdata/` 29.6（chi_sim 19.2 + eng 10.4） |
| `assets/` | 13.4 | JS/CSS/字体 |
| `pdfjs/` | 1.9 | |
| `covers/` `icons/` `prism/` | ~1.1 | |

**`ocr/core` 里的死重**：tesseract.js 7 的 worker 按「SIMD 支持 × `legacyCore`」选一档，
而我们是 `createWorker(langs, 1, …)`（oem=1 纯 LSTM）且**从不设 `legacyCore`**、也不用 `worker.detect`
⇒ 只会走 `-lstm` 那三档。**三个非 `-lstm` 变体（3 个 `.wasm.js` + 3 个 `.wasm` ≈ 23.3 MiB）永远用不到**，
而它们在 Android 上还被装两遍。
（`public/ocr` 因此从 **72.9 → 49.1 MiB**，core 从 43.2 → 19.4 MiB。）

### 3.4 四个杠杆（按收益排序）

| 杠杆 | 收益（APK 估算） | 状态 |
|---|---|---|
| 删掉 3 个用不到的 tesseract-core 变体 | 23.3 ×2 ≈ **46 MiB** | ✅ **本轮已做**（拷贝脚本改白名单 + `check:ocr-assets` 硬门禁，三条变异测试验过它能失败） |
| OCR 语言包改按需下载 | 29.6 ×2 ≈ **59 MiB** | ✅ **已做**（2026-09-13）：语言包不再随包分发，改为运行时按需下载 + tesseract 的 IndexedDB 缓存 ⇒ 首次联网一次、之后永久离线。托管在 `shuyo.cn/ocr/tessdata/4.0.0/`（**路径带 tessdata 版本号**，故可 immutable 长缓存），规矩见 `docs/nginx-ocr.conf` |
| ~~去掉 `.so` 里那份前端内嵌副本~~ | ~~≈ 50 MiB~~ | ❌ **不成立**（2026-09-13 CI 实测）：CI 全新 `init` 出来的工程**根本不往 `assets/` 放前端**，前端只在 `.so` 里一份 ⇒ **没有可砍的第二份**。原估的 ≈50 MiB 因此没有兑现，也不该再写进预期。要再压这一块，只能是"让前端别进二进制"（换 AssetLoader 形态），那是**产品级改动**，不在本轮 |
| `strip = true` | 12.7 MiB | ✅ **本轮已做**（代价：丢符号名；`CARGO_PROFILE_RELEASE_STRIP=false` 可临时关） |

**实测结果（2026-09-13，CI run #3，未签名）**：

| | arm64 APK |
|---|---|
| 09-10 那次（无 strip、语言包随包、core 变体全在、前端两遍） | **156.7 MiB** |
| **2026-09-13 CI**（strip + core 白名单 + 语言包按需） | **53.41 MiB**（`56,000,758` 字节，sha256 `DB710745…`） |

构成：`lib/arm64-v8a/libshuyonote_lib.so` **50.75 MiB** + `classes.dex` 2.0 + `resources.arsc` 1.1 + `res/` 0.7。
**只含一个 ABI**（尽管产物目录名是 `universal` —— 那是"不做 ABI 拆分"的意思），
**语言包不在包里**（CI 有一条硬断言守着，`traineddata` 出现就 fail）。

⇒ **当初定的 55–70 MiB 目标已达成**（53.41 MiB），而且比中间那次估算（85 MiB）好得多——
差额正是"前端两遍"这件事在 CI 构建里本来就不成立。

### 3.5 语言包托管：**必须给 CORS**（这条只在应用里会坏）

语言包托管在 `https://shuyo.cn/ocr/tessdata/4.0.0/`（与官网同域），文件取自 npm 包
`@tesseract.js-data/<lang>/4.0.0/` 的**原字节**（sha256 已记录在提交说明里，线上逐一比对过）。

⚠️ **那个 location 必须带 `Access-Control-Allow-Origin: *`**：桌面/Android 的应用壳里页面
origin 是 `tauri://localhost`，去取 `https://shuyo.cn/...` 是**跨域 fetch**；
而 **Web 版是同源、根本不会暴露这个问题**。所以漏了这个头的表现会是
**"浏览器里测都正常、装成应用就不行"** —— 正是最难查的一类。规则源文件见
[`docs/nginx-ocr.conf`](../nginx-ocr.conf)。

> 附带一条：`.gz` **不能**再叠 `Content-Encoding: gzip`（应用侧 tesseract 用 `gzip: true`
> 自己解压）。当前全局 `gzip_types` 里没有 `application/gzip`、`gzip_static` 也没开，
> 所以默认安全——但**改全局 gzip 配置时要记得这一条**。

> **顺带排除一条疑问**：`mupdf-sys` 在**主依赖**里（未按平台排除），确实被编进了 Android 的 `.so`
> （`.so` 里能查到 `NimbusRoman` 等内嵌字体名）。但它**不是大头**——最大的 mupdf `.o` 只有
> 0.89 MiB（`pdf-cmap-load.o`）。所以"手机上 PDF 退到 pdf.js 以省体积"这条**收益很低**，
> 不值得为它牺牲原生渲染能力。原计划把它列为 Phase 0 的待查项，现**排除**。

> 数字说明：「strip 能省多少」是**高置信度假设**，不是实测——Phase 0 第一件事就是量它，
> 而不是先写进结论。

---

## 四、工程路径

```text
工程路径：体积 → 签名 → 版本联动 → CI 出包 → 真机验收 → 官网/酷安
```

> **另一条是合规路径**（软著 → 商店开发者账号 → 隐私政策/权限说明 → 各商店审核），
> 属公司运作材料，见私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md`。
>
> 这里只留一句与排期有关的结论：**合规路径上唯一"没法用加班换时间"的是软著**，
> 但**官网 APK + 酷安这条路不需要软著**，所以两条路互不阻塞——这正是先走酷安的价值：
> **不用等材料就能拿到真实用户反馈**。

---

## 五、阶段与判据

### Phase 0 · 先能装（1–2 天）

#### 0.0 构建环境：**目前本机复现不出可用的组合**（2026-09-13 实测，重要）

先说结论：**09-10 那次 APK 确实构建成功了，但那次的环境组合没有被记录下来，现在复现不出来。**
下面是逐项实测到哪一步——下次（或 CI）从这份记录接着往下走，不要再从零猜。

**已经确认可用的部分**：

- NDK（`29.0.13846066`）、JDK 17、Android SDK 都在，环境变量齐全；
- 四个 android target（aarch64 / armv7 / i686 / x86_64）都已 `rustup target add`；
- `pnpm tauri android build --target aarch64` 能走到 `cargo build`，前端产物也正常生成。

> ⚠️ **桌面与 Android 的 OpenSSL 环境互斥**：桌面构建要 `OPENSSL_DIR`（`rusqlite` 的
> `bundled-sqlcipher` 要链系统 OpenSSL，见 `dev.ps1`），而 Android 侧要的是**从源码编译**的
> OpenSSL。用 `dev.ps1` 那套设了 `OPENSSL_DIR` 再跑 Android 构建，`openssl-sys` 会直接炸。
> 两个环境要分开：Android 构建前先 `Remove-Item Env:\OPENSSL_DIR`。

**卡点一：Android 的 OpenSSL 需要一个「MSYS 类」的 Perl**

`Cargo.toml` 的 Android 段让 `openssl` 走 `vendored`（从源码编译），而它的 `Configure` 是 Perl 脚本。
两种 Perl 各自不行：

| 用的 Perl | 结果 |
|---|---|
| Strawberry Perl（原生 Windows，`MSWin32-x64`） | **被 Configure 明确拒绝**：`This perl implementation doesn't produce Unix like paths … Please use an implementation that matches your building platform.` |
| Git for Windows 自带（MSYS 版） | 类型对，但**缺 `Locale::Maketext::Simple`**（`Params::Check` → `IPC::Cmd` → OpenSSL 的 `config.pm` 一路要它）；报 `Can't locate Locale/Maketext/Simple.pm` |

那个模块在 Perl 5.28 之后已从核心移除，但 CPAN 上还在（`Locale-Maketext-Simple-0.21`，作者 JESSE）。
本次已把它取下来放进 `%LOCALAPPDATA%\ds-build-tools\perl5lib`（**仓库外**，用 `PERL5LIB` 注入，
不动系统 Perl），实测 Git 的 Perl 能加载：

```powershell
$env:PERL5LIB = "$env:LOCALAPPDATA\ds-build-tools\perl5lib"
# 取模块（network 直连，别走那个会返回 402 的系统代理）：
#   https://cpan.metacpan.org/authors/id/J/JE/JESSE/Locale-Maketext-Simple-0.21.tar.gz
#   解出 lib/Locale/Maketext/Simple.pm → 放进 $env:PERL5LIB\Locale\Maketext\
```

**卡点二：`mupdf-sys` 的 Makefile 在 Windows 上两头不讨好**

它用 GNU make 跑 mupdf 自己的 Makefile，而那份 Makefile 同时假设了 Unix 的 shell 与 Unix 的路径：

| make 用的 shell | 失败方式 |
|---|---|
| 默认的 `cmd.exe` | `File not found - *.[ch]` / `The syntax of the command is incorrect.`（POSIX 语法） |
| 换成 Git 的 `sh.exe`（`$env:SHELL`） | `sh: line 1: …: command not found`（**Error 127**）——因为 mupdf-sys 生成的 `CC` 是**带反斜杠的原生 Windows 路径**，被 sh 当转义吃掉了 |

另外 `pkg-config` 本机没有（mupdf-sys 的构建脚本会去探测它）。

**这件事的真正含义**：本计划把「`gen/android` 不在 git 里 → CI 里必须 `tauri android init`」
列为风险，但**比它更早的一环是宿主工具链本身也不可复现**——09-10 能过、今天过不去，
而差异没有被记录下来。所以 Phase 2 的 CI 任务里必须包含**把 Android 构建环境钉死**
（固定 NDK / Perl / make / pkg-config 的来源与版本），否则"本地能过 CI 不能"会以更难查的形式出现。

**逐项待办**（按性价比）：

1. 先试 **MSYS2**：`pacman -S make pkg-config perl`，用它提供的 `make` + `pkg-config` + `perl`
   （MSYS2 的 make 对反斜杠路径的处理比 Git 精简版更接近 mupdf 的假设）——**最可能一次通**。
2. ~~或者绕开 OpenSSL：把「聚合邮箱」按平台收窄，Android 就不需要编译 OpenSSL，卡点一整个消失。~~
   ❌ **这条不成立**（我先前判断错过，见 §8.1 的纠正）：邮箱已收窄为桌面专属，但 **SQLCipher
   仍要从源码构建 OpenSSL**，卡点一原样还在。**别再把"砍功能"当成解卡点一的手段。**
3. ✅ **已选并已跑通（2026-09-13）**：CI 里用 Ubuntu runner 交叉编译
   （`.github/workflows/android.yml`，run #3 绿，arm64 APK 53.41 MiB）。
   本地构建只作为"给自己装机"的临时手段。
   ⚠️ **但原话"Linux runner 上没有这些 Windows 工具链问题"是错的**——Linux 上没有那组
   Perl / make 问题，却有自己的两个（NDK 缺 `aarch64-linux-android-ranlib`、mupdf-sys 的
   bindgen 不带 `--target`），见 §一 表格的 CI 行与 workflow 里的步骤注释。
   正确的表述是：**换个环境不是"没有问题"，是"换一组问题"**——构建环境仍然必须钉死并实测。

#### 0.1 要做的事

1. `Cargo.toml` 加 `[profile.release] strip = true`（**已做**）：实测 −12.7 MiB。
   ~~`lto` / `codegen-units`~~ 未采纳：收益未测，而它们会显著拖慢每次发布构建——
   要加先量，别凭"应该会更小"就加。
   （原先写的"strip 能把 101 MiB 压到 ~30 MiB"是**错的**，见 §3.1。）
2. OCR 语言包改为按需：先把 `public/ocr/tessdata` 从包内构建里去掉，改成首次用 OCR 时下载到
   `app_data_dir`（离线承诺不破：**下载一次之后永久离线可用**，且要如实告知"首次需要联网一次"）。
3. **签名分两步走**（2026-09-13）——正式 key 的口令与离线备份是**用户决定**的事（私钥丢了
   不可逆：同一签名的老用户永远收不到升级），而签名又是真机验收的前置。所以先用一把
   **测试专用** key 把真机这条路打通：
   - ✅ **测试 key 已生成**：`keytool` RSA-4096 / 有效期 10000 天，别名 `shuyonote-test`，
     DN 里直接写着 `OU=DO NOT SHIP`；放在**所有 git 仓库之外**的本机目录
     （路径不写进公开仓——本文是公开的），同目录有一份 `README-必读.md` 写明它就是测试 key、
     以及重新签包的完整命令。证书 SHA-256 指纹 `98128a67…`（装到手机上后可用来核对）。
     用它签出的包 **53.49 MiB**（未签名的 53.41 MiB + 签名块与对齐），
     `apksigner verify` 过 **v2 + v3** 两套方案。
   - ⚠️ **代价要说清**：Android 只允许**同一签名**覆盖安装 ⇒ 将来换成正式 key 时，
     手机上**必须先卸载**才能装新包；反之正式 key 一旦对外发版就**不能再换**。
   - ⛔ **正式 keystore 仍未生成**——等你定口令与离线备份位置。
   - 说明：这版是 **release 构建**（`debuggable=false`），所以真机上只能靠 `adb logcat` 看日志，
     不能像 debug 包那样直接换 JS。
4. ~~版本联动：一个脚本从 `package.json` 写 `gen/android/app/tauri.properties`~~
   **不需要做——Tauri 自己会同步**（2026-09-13 更正）。原先我写「停在 1.82.18、必须自动化」，
   那是因为只看了 09-10 留下的陈旧文件；今天构建时它被**自动重写成**
   `versionName=1.90.1` / `versionCode=1090001`。口径是 `major*1e6 + minor*1e3 + patch`
   （旧的 1.82.18 → 1082018 同口径），每次 `tauri android build` 都刷新。
   **要留意的只是别手工改这个文件**（文件头自己写着 AUTOGENERATED）。
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

1. ✅ **CI 出包：已跑通**（`.github/workflows/android.yml`，2026-09-13）——ubuntu runner +
   Android SDK/NDK；`gen/android` 不在库里，所以 CI 自己 `pnpm tauri android init --ci`，
   产物（未签名 APK）走 artifacts。**keystore 走 Secrets 这一步还没做**，等签名方案定；
   要加的是 `signingConfig` 的脚本化 + Secrets 注入。
2. **官网下载页**：`shuyo.cn/download`（或 `/app` 旁）给 APK 直链 + sha256 + 签名指纹 +
   "怎么验证签名"；与 Web 版、桌面版并列。
3. **应用内"检查更新"**：Android 不接 updater 插件，改为「发现新版本 → 打开下载页」。
   版本源可以复用桌面那套的 `latest.json`（加一个 `android` 键），**不要另起一套**。
4. **崩溃与日志回流**：至少一个最小方案。没有它，酷安用户的反馈只能靠口述，排查成本极高。
   倾向：应用内"导出诊断包"（现有日志 + 版本 + 机型），而不是引入第三方 SDK
   （与"数据主权"的产品承诺一致）。

**判据**：改一行版本号 → 推 tag → CI 出已签名 APK；下载页自动更新；应用内能提示新版本。

### Phase 3 · 上商店

> **已迁出**（2026-09-13）：软著登记、各商店开发者账号与当期规则、隐私政策页、上架材料
> （AAB / 16 KB page size / 目标 SDK / 商店合规表单）——全部属公司运作材料，
> 见私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md`。
>
> 本篇只需记住一件事：**Phase 3 的材料准备与 Phase 0–2 并行，不排在工程之后**。

---

## 六、风险清单（按"会不会让计划脱轨"排）

| 风险 | 影响 | 应对 |
|---|---|---|
| **选文件 SAF 读不了** | 导入类功能整体不可用 | Phase 1 第一件事就是 spike；有"先拷到缓存"的退路 |
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

---

## 八、待决策（卡在别人身上的两件事，先说清选项）

### 8.1 邮箱要不要保留在 Android 上？—— **已拍板：不做移动端**（2026-09-13）

**用户决定：聚合邮箱不做移动端。** 已落地（收窄为桌面专属）：

- Rust：`mod email` / `mod smtp` 与 **23 个邮箱命令**全部 `#[cfg(desktop)]`；邮箱依赖
  （`mailparse` / `async-imap` / `tokio-native-tls` / `native-tls` / `encoding_rs`）移进
  `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`。
- 前端：新增**具体能力**判定 `emailSupported()`（`src/lib/platform/capabilities.ts`，纯函数可测），
  邮箱面板/设置区改用它。**没有**动 `isDesktopPlatform()` —— 它的语义是"有没有 Rust 内核"，
  移动端为真，而同步/加密/插件在移动端是要保留的。
- 实测：Android 侧 `cargo tree -i native-tls` 现在是 **nothing to print**（彻底移除）；
  桌面侧仍在。`cargo check --lib` 与 `cargo test --lib`（245/0）通过。

#### ⚠️ 但**卡点一没有因此消失**——我先前那句判断是错的

原先这里写「邮箱收窄 ⇒ 卡点一整个消失」，**这是错的**。Android 的 OpenSSL **不只**服务邮箱：

```
openssl-sys
├── libsqlite3-sys ← SQLCipher（加密后端）也用，features 里确有 vendored-openssl
└── native-tls     ← 邮箱（已收窄掉）✅
```

收窄邮箱去掉了 `native-tls` 与 `openssl`（crate），但 **SQLCipher 仍要从源码构建 OpenSSL**，
所以**Perl / make / pkg-config 那组卡点原样还在**。实测确认：收窄后 Android 侧
`cargo tree -i openssl-sys` 只剩 `libsqlite3-sys → rusqlite → shuyonote` 一条。

**所以卡点一的正解不是"砍功能"，而是"换个构建环境"**——见 §8.2。

### 8.2 Android 构建环境怎么钉

无论选 A 还是 B，**宿主工具链都必须在 CI 里固定下来**（§0.0 的教训：09-10 能过、今天过不去）。
倾向：**CI 用 Ubuntu runner 交叉编译**（Linux 上没有这些 Windows 工具链问题），
本地构建只作为"给自己装机"的临时手段。

---

## 九、合规与上架

> **已迁出**（2026-09-13）：整节搬到私有仓库 `shuyonote-sync-server` 的
> `docs/android-launch-plan.md`——软著登记（材料 / 周期 / 两个高频补正的坑）、各商店开发者账号与
> 当期规则、隐私政策页、上架材料，以及"我需要你提供的"三件事。
>
> 留在本篇的只有两条**工程侧**约束，因为它们要落进构建配置：
>
> - **AAB + 按 ABI 拆分**（商店按设备下发，用户少下 2/3）；
> - **16 KB page size**（Android 15+ 对原生库的要求）：本机 NDK 是 **29.0.13846066**，
>   r28+ 默认即 16 KB 对齐 —— **待实测确认**（`llvm-readelf -l` 看 `LOAD` 段的 `Align`），
>   不是靠"新版 NDK 应该没问题"就算数。
