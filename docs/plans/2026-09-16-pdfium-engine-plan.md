# PDFium 替换 MuPDF（桌面光栅化）· 落地方案（已开工）

> 状态：**已拍板（2026-09-16）：开工。** 本文件是可执行的落地设计。
> 动机：**闭源商业授权版的许可干净** —— 客户端当前是 AGPL-3.0，与 MuPDF（同为 AGPL 系）本来就兼容；只有要做**闭源授权版**时才必须换掉 MuPDF（或买 Artifex 商业授权）。
> 上位决策文档：[国密 + PDFium 方案](2026-09-16-sm-crypto-and-pdfium-plan.md)。国密侧见 [国密全链路落地方案](2026-09-16-sm-crypto-full-plan.md)。

---

## 0. Spike 结果（**已跑通，2026-09-16**）

问题：`pdfium-render` 会不会重演当年 `mupdf` 高层 crate 在 MSVC 上编不过的坑（bindgen 不产出内建类型 `max_align_t`，见 `src-tauri/Cargo.toml:61-65` 的注释）？

做法：在**临时目录建一个空白 crate**（不碰主仓库），`cargo add pdfium-render` + `cargo check`，目标 `x86_64-pc-windows-msvc`。

结果：**通过**。

```
Adding pdfium-render v0.9.4 to dependencies
  Features: + image_025 + image_api + image_latest + pdfium_7881 + pdfium_latest + thread_safe
  Locking 59 packages to latest Rust 1.94.0 compatible versions
   Compiling pdfium-render v0.9.4
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 13.49s
```

**三条可直接写进设计的结论**：

1. **不会重演那个坑**：`pdfium-render` 用**预生成绑定 ＋ `libloading 0.9.0` 动态加载**，**构建期不跑 bindgen** ⇒ MSVC 上无 `max_align_t` 问题。这是它与 `mupdf` 高层 crate 的根本差别。
2. **`pdfium_7881`**：crate 把支持的 PDFium 版本钉成了 **build 7881**（同时还开着 `pdfium_latest`）。⇒ 我们**显式钉 7881**，别跟随 `latest`，避免 dll 与绑定漂移。
3. 附带拉进来的依赖：`image 0.25`（图像解码）、`moxcms`（色彩管理）、`zune-jpeg`、`itertools`、`bitflags`、`once_cell` —— 许可均宽松（MIT/Apache/zlib 类），**不引入新的 copyleft**。

> ⚠️ 编译通过 ≠ 跑得起来：**运行时**还需要 `pdfium.dll`（由 `libloading` 运行时加载，路径可指定）。库的获取与固定版本是 P0（§2）。

---

## 0.1 P0 已完成（2026-09-16）：库按「钉死版本 ＋ 校验和」落盘

**结论：P0 完成**，且是可复现的——落库的是**脚本**，不是二进制。

| 事实 | 值 |
|---|---|
| 版本 | **PDFium 151.0.7881.0（BUILD=7881，Chromium 151）**，与 crate 的 `pdfium_7881` feature 对齐 |
| 资产 | `pdfium-win-x64.tgz`，**3,733,154 字节**（与 GitHub release API 报告的资产大小一致） |
| 包 sha256 | `73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08` |
| `pdfium.dll` | **7,211,520 字节**，sha256 `79d4676b656cfb1abcea88f9ade3b4b0826c5200382db5f4ec72a636c598c118` |
| 构建参数（`args.gn`） | `pdf_enable_v8=false`、`pdf_enable_xfa=false`、`pdf_is_standalone=true`、`is_debug=false` ⇒ **不带 JS 引擎的独立 release 构建**，正是"只做光栅化"需要的 |
| 附带资产 | **包内自带 `licenses/`（17 份第三方许可原文：freetype / icu / lcms / libjpeg-turbo / libopenjpeg / libpng / libtiff / zlib / abseil / simdutf / llvm-libc …）** ⇒ **可直接并入交付物的 `THIRD-PARTY-NOTICES`** |
| 其它平台资产（同名 release 内已确认存在） | `pdfium-win-arm64`、`pdfium-linux-x64`、`pdfium-mac-univ`、`pdfium-android-arm64`…（`pdfium-v8-*` 变体**不用**——我们要的是不带 V8 的） |

**交付物**：`scripts/fetch-pdfium.mjs`

```bash
node scripts/fetch-pdfium.mjs            # 取当前平台 → 校验和 → 解到 src-tauri/vendor/pdfium/<平台>/
node scripts/fetch-pdfium.mjs --check    # 只校验（CI 用）
node scripts/fetch-pdfium.mjs --print-sha256 <tgz>   # 补记某平台的校验和
```

三个设计点（都是"别让来路不明的二进制进交付物"这条原则的落地）：

1. **校验和不符直接删档退出**，不给"跳过校验"的口子；
2. **没实测记录校验和的平台硬失败**（其余平台 `sha256: null`）——宁可让人补一次，也不静默下载；
3. 解包后写 `SOURCE.txt`（版本 / 资产 / sha256 / 来源 URL / 时间 / `VERSION` / `args.gn` 原文），`src-tauri/vendor/pdfium/` 已进 `.gitignore`（**二进制不入库**）。

**⚠️ 本机 DNS 被污染时的取法**（实测踩过）：

- GitHub release 资产走 `objects.githubusercontent.com`，**直连会卡死**（我卡了 4 分钟没动静）；
- 先用 DoH 拿真实 IP，再用 `curl --resolve`：
  ```
  $env:PDFIUM_RESOLVE = "github.com:20.205.243.166,objects.githubusercontent.com:185.199.108.133"
  ```
- **同一个 Fastly 域名下不同 IP 通不通不一样**：实测 `.111` 超时、`.108` 成功——换一个 IP 往往就好了；
- 该 release 还带 **`pdfium-attestation.json`（构建溯源）**，自建/交付前可与之交叉核对。

---

## 0.2 拍板记录（2026-09-17 三条 ＋ 2026-09-18 三条）

| # | 决定 | 理由与连带 |
|---|---|---|
| **F** | **分派方式 = 运行时开关**（不用 Cargo feature） | 不重编就能切回 MuPDF，符合 §2-P5「灰度一个发布周期」；代价是两条路径的代码都留在包里（可接受） |
| **G** | **多平台库：先补实测校验和，把多平台跑通** | 与 `win-x64` 同套路、当天可做；**交付前**再按 §6 评估是否自建。⚠️ 现状是**只有 `win-x64` 有校验和**，其余四个平台 `sha256: null` ⇒ 脚本对它们是**硬失败**，多平台打包一开工就卡这 |
| **H** | **对拍样本集 = 写生成脚本 ＋ 少量产物入库** | 自制样本无版权风险；对拍结论**可复现**（换人也能重跑）。只写清单不可复现，换人就得重来 |
| **I** | **未绘制区域语义 = 两条路都「透明」**（不在比对脚本里归一） | MuPDF 那条本来就是 `alpha=true`；`pdfium-render` 默认清屏**不透明白** ⇒ 不处理就"同一内容 99.8% 像素不同"。改**源头**（`pdfium_native::CLEAR_COLOR_TRANSPARENT` 清成全透明）而不是改判据：那样切引擎对**暗色 + 护眼四档零影响**，也不必把"真机目视四档"当切换门槛 |
| **J** | **对拍判据只看 R/G/B、按像素统计；alpha 只报告** | AMD 在 Linux 实测：`text`/`rotate90` 的 **RGB 逐像素完全相同（最大 RGB 差 = 0）**，差异**全在**字形边缘 alpha（最大 240）。第一版把 alpha 塞进"最大通道差"⇒ 该过的样本判红；另有两处口径错误（占比按**字节**算 ⇒ 放大约 4 倍；把"归一白纸"当硬判据 ⇒ 合成不同的 alpha 会**制造** RGB 差，**负灵敏**）。⚠️ 若为了"更严"把 alpha 加回硬判据，请先解释这两个光栅化器的边缘为何可能逐位一致 |
| **K** | **`dev` 回退路径按候选目录探测，不写死 `bin`** | `fetch-pdfium.mjs` 解到 `<平台>/<spec.lib>`，而 `spec.lib` 的目录前缀**各平台不同**（Windows `bin/`；Linux/macOS/Android `lib/`）⇒ 写死 `bin` 让那两个平台的 vendored 回退**从来命中不了**（Windows 恰好是 bin，故本机一直没暴露）。AMD 在 Linux 复现并验证了修复 |

> **G 是当前 P4 的真实拦路石**（不是技术难，是"没填表"）：`scripts/fetch-pdfium.mjs` 的平台表里
> `win-arm64` / `linux-x64` / `mac-univ` / `android-arm64` 全是 `sha256: null`。

## 0.3 2026-09-20：两类新样本 ＋ **一条被自己实测推翻的决定（L）**

| # | 决定 | 理由与连带 |
|---|---|---|
| **L**<br>**（已撤回）** | ~~缺省引擎"看库在不在"：库不在 ⇒ **回退 MuPDF**（`PdfEngine::resolve`）~~ ⇒ **改为：不动引擎取值，保持 `from_env_value`；缺库时由上层 pdf.js 接管（现状），不做任何静默换引擎** | 提议当天就被自己的实测推翻，**过程照记**，免得后人再提一遍：<br>① 原先的理由"那些平台会**当场渲染失败**"**是错的** —— `src/components/PdfReader.tsx:122-131` 会把原生渲染的异常吞掉、**静默降级 pdf.js**（页面照样出来，现场只有控制台一行日志；`1.91.6` 那封函 §三 早已记过）。<br>② 更关键：**回退目标本身更差**。`cjk.pdf`（非嵌入 CID 中文，国标 `STSong-Light`+`UniGB-UCS2-H`，中文办公软件常见写法）实测（见 O）：**MuPDF 画成单字节拉丁乱码**，而 **pdf.js 带 `pdfjs-dist/cmaps` 169 个 bcmap，`getTextContent()` 正确给出 `["中文测试"]`**。⇒ "缺库就换 MuPDF"等于**用更差的正确性去换速度**，而 pdf.js 那条路本来就接着。<br>③ 结论：**不偷偷换引擎**（"成功 ≠ 生效"那一族），维持现状即可 —— 后端错误信息里已经写明"库缺失 + 怎么放库"，前端那行日志也在，排查不缺线索。<br>④ 撤回范围：`PdfEngine::resolve` 与 3 条新判据回到 dev 的 `from_env_value`＋原 4 条判据；`library_preflight` 恢复 `#[cfg(test)]`。**唯一没撤回的是"这个问号已经问过了"本身。** |
| **M** | **对拍样本新增两类，且分两类判**：`scan.pdf`（图像 XObject）走**硬判据**；`cjk.pdf`（Type0＋预定义 CMap＋标准 CJK 字体名）**只报不判** | 报告 §六 自认的缺口 #1 就是这两类。扫描件里没有字形 ⇒ 两个引擎**应当**逐像素一致，判硬；中文**没有嵌入字体** ⇒ 两个引擎各走各的字体解析/回退路径，字形本就不同（**实测比这句更糟，见 O**），**逐像素等价在这个样本上做不到** ⇒ 它只回答"都能开、尺寸一致、都画出了东西"（非透明像素两边都 > 0），字形差异**如实报出来**。⚠️ 这不是"给红样本开后门"：`scan.pdf` 里的图像特意做成**块状 + 1:1 到设备像素**（96×96 画进 64×64 pt，`SCALE=1.5` ⇒ 正好 96 设备像素），把"插值算法的自由"从判据里排除掉 |
| **N**<br>**（随 L 撤回）** | ~~`library_preflight` 去掉 `#[cfg(test)]` ＋ 新增 `library_available()`~~ | 它唯一的用途是喂 L。L 撤回后 `library_preflight` 仍是 `#[cfg(test)]`（唯一调用点是 P3 对拍那条 `#[test]`）。**若哪天要"缺库时在界面/日志里点名"，再把它放出来。** |
| **O** | **`cjk.pdf` 四个读数：这不是"两个引擎各自换字体"，而是"两家都画不对，且方式不同"；「只报不判」那一类的自检**不足以证明文字画出来了**** | 读数与复现命令另存证据包 `ShuyoNote-collab/pdfium-p3/visual-check-cjk/`：<br>① **PDFium／Windows**：墨迹 **28816**，**正确画出「中文测试」**（有 PNG）；<br>② PDFium／WSL2 Linux：墨迹 **27000 = 蓝矩形面积 ⇒ 整行文字一个像素都没画**；<br>③ MuPDF／WSL2 Linux：墨迹 28000 = 矩形 27000 ＋ **文字 1000**，而这 1000 是**把 2 字节码按单字节**喂回退字体画出的拉丁乱码（`<4E2D65876D4B8BD5>` → "N-e mK"）；<br>④ **pdf.js 4.8.69**（带 cmaps）：`getTextContent()` = `["中文测试"]` ✅。<br>**对照实验**：WSL 装系统 CJK 字体（`msyh`+`simsun`）前后 ②③ **数字一字不变** ⇒ 不是"那台机器缺字体"；`mupdf-sys 0.8.0` 的 `build.rs` 明确写 `all-fonts` 已废弃、`msbuild.rs` 把 `fonts\noto\` 从 Windows 工程里删掉 ⇒ 缺 CJK 资源是**构建期决定**。<br>⇒ ① 样本本身是**对的**（①④ 都映回了「中文测试」）⇒ 分叉在引擎/平台，不在夹具；② "两边都画出东西"会被页面里的**矩形**满足，**证明不了文字**；③ 维持"只报不判"，**不许把它的 ✅ 读成"中文没问题"**；④ **六格读数已齐（2026-09-20 当天补完）**：PDFium／Windows **28816** ✅、PDFium／macOS **29582** ✅（目视「中文测试」正确）、PDFium／Linux **27000** ❌（= 正好矩形面积、文字 0 像素）；MuPDF／**三平台逐字同数 28000**（= 矩形 27000 ＋ 乱码 1000，目视均为 `N-e mK`）⇒ MuPDF 的乱码与平台无关，是**构建期**决定（`all-fonts` 已废弃 ＋ `msbuild.rs` 删掉 `fonts\noto\`）。<br>★ **为什么现有硬判据抓不住它**（2026-09-20，macOS 侧）：`cjk.pdf` 那行 **`RGB差=0`、`RGB超阈=0.000%`，而两张图完全不同** —— 差异**全在 alpha/覆盖**（透明像素两边 RGB 都是 0，黑字的 RGB 也都是 0）⇒ **只比 RGB 的硬判据对「黑字＋透明底」结构性失明**，不是调阈值能解决的；而"两边都画出东西"那道自检会被**矩形**满足（Linux PDFium 27000 > 0 也过）。⇒ 表里新增**「非矩形墨迹」**列（`non_rect_ink`：`alpha≠0 且 RGB≠纯蓝矩形`，**只报不判**），三平台立刻可比：**MuPDF 1000／1000／1000**、**PDFium 0（Linux）／1816（Windows）／2582（macOS）**；**不**把它升成硬判据（它反映的是平台缺字体后端这种**环境相关产品缺陷**，不是代码回归，长期红会让人对红脱敏）。<br>★ **P4 拦路石（Windows 查实）**：Linux 那份 `libpdfium.so` **没有 fontconfig 字体后端**（`ldd` 只有 6 行、`fontconfig`/`FcInit` 符号 0 个；对照 Windows `pdfium.dll` 有 GDI 字体映射）⇒ **"包里带了库" ≠ "字能显示"**；**base14 不受影响**（`text.pdf` 在 Linux 上照样 0 差）—— 这正是它隐蔽的原因。出路：① 自建带 fontconfig／随包字体的库；② 这类文档路由到 pdf.js（本仓已随包带 cmaps/standard_fonts）。施工单见信箱 `2026-09-20-pdfium-linux-font-backend-workorder`（推荐路线 D＝随包一个 OFL 中文字体 ＋ `set_custom_font_provider`）。|
| **P** | **P4 的打包通路（Linux ＋ Android）：产物读数、"两条 CI 红"的根因与修法** | 这一行是 P4 那格的读数汇总（2026-09-20，Windows 侧）。<br>**① Linux（已验）**：WSL2 `cargo tauri build --bundles deb` ⇒ `ShuyoNote_1.91.10_amd64.deb` **42,865,680 B**；`dpkg-deb -x` 后 `/usr/lib/ShuyoNote/` 里四项：`libpdfium.so` 7,645,184 B sha256 `f7289309…`（= vendor）、`NotoSansSC-Regular.ttf` **10,559,284 B** sha256 `d45f67f0…`（= `fetch-font.mjs` 钉死值）、`LICENSE-OFL.txt`、`README.md`。**AppImage 也已验（同日晚些时候补的）**：WSL2 里 `cargo tauri build --bundles appimage`（7m47s，`CARGO_TARGET_DIR` 指到 ext4 以免与 Windows 的 `target/release` 撞车）⇒ `ShuyoNote_1.91.10_amd64.AppImage` **117,504,504 B**；`--appimage-extract` 后：`usr/lib/ShuyoNote/libpdfium.so` **7,664,592 B** sha256 `eb19d385…`（源那份 7,645,184 B `f7289309…`）、`usr/lib/ShuyoNote/NotoSansSC-Regular.ttf` 同在**资源目录那一层**；结构比对 **✅ 动态表 31/32 条（只差 `RUNPATH=$ORIGIN`）· 动态符号 783/783 · 大小 7645184/7664592** ⇒ `check-linux-bundle` **0 条 problem** —— AppImage 那条判据**第一次**在真产物上跑（之前只有 deb 的读数）。配方与踩坑记在 `docs/TESTING.md`。<br>**② Linux 门禁补强**：`check-linux-bundle.mjs` 新增**随包字体**三条（在不在／位置对不对／sha256 是否等于钉死值）。理由是缺字体与缺库**同一类静默失效**，而字体本体不入库（`.gitignore`，目录里只有 README 占位）⇒ **构建不会因此变红**，在这之前整条链上没有任何东西拦它。真产物读数：带字体的那份 deb ⇒ **✅ 0 条**；**字体落地之前**那份 `ShuyoNote_1.91.11_amd64.deb`（36,499,418 B）⇒ **❌ 1 条「不在 deb 里」**；真 deb 上的变异 4/4（删字体／挪深一层／改 sha 各自红）。<br>**③ Android 通路**：`fetch-pdfium.mjs --platform android-arm64` → `stage-android-pdfium.mjs`（放进 `gen/android/app/src/main/jniLibs/arm64-v8a/`）→ 构建 → `check-android-bundle.mjs` 断言"包内有 `lib/<abi>/libpdfium.so` 且与 vendor **逐字节相同**"。**这条通路在 CI 上从来没走到头过**，两个红都在我这边：<br>&nbsp;&nbsp;• **平台名被静默吃掉**：两条 workflow 写的是位置形式 `node scripts/fetch-pdfium.mjs android-arm64`，而脚本只认 `--platform` ⇒ 回落成"当前平台"，ubuntu runner 上取回的是 **linux-x64**（日志第一行就是 `target: … / linux-x64`），报错点却在下一步 stage（"vendor 里没有 android-arm64 的那份库"）。修法不是改那一行调用，而是**去掉"静默回落"这个状态**：位置参数与 `--platform` 等价、**认不出的名字当场 exit 2**（判据 `scripts/lib/pdfium-target.test.mjs` ＋ `scripts/fetch-pdfium.test.mjs`）。<br>&nbsp;&nbsp;• **自检用 `tar -tf` 读 APK**：本机 Windows/macOS 是 **bsdtar**（认 zip），**CI 的 ubuntu 是 GNU tar（不认 zip）** ⇒ 那一步在 CI 上恒 exit 2「没验」（本机实测：`wsl tar -tf x.apk` ⇒ `This does not look like a tar archive`；`tar -tf x.apk` ⇒ 正常）。修法：改用仓里**已有的** `scripts/lib/zip.mjs`（纯 JS，`check-apk-contents.mjs` 也在用）。<br>**④ 真产物读数**：CI run **35504661582**（分支 `fix/pipeline-reds-2026-09-20`）**23 步全绿** —— 第 17 步"随包 PDFium 库"、第 19 步"自检：APK 里真的带了随包 PDFium 库"**第一次**通过。<br>**⑤ 顺带**：发版侧 `check-apk-contents.mjs` 也补了"包里必须有 `lib/<abi>/libpdfium.so`"（原来只有自检流水线有那条断言；发版侧的 ABI 断言抓不住它 —— Tauri 自己会把 `libshuyonote_lib.so` 放进同一层，**那一层永远不会空**）。 |

**判据**：`commands::pdf_engine_tests` 保持 dev 的 **4 条**（`unset_uses_the_documented_default_engine`、
`explicit_values_win_and_are_case_insensitive`、`unknown_or_empty_values_fall_back_to_default`、
`explicit_mupdf_always_rolls_back`）—— L 撤回后**没有新增判据**；本轮的净产出是**两个样本 ＋ 一张读数表**。

---

## 0.4 2026-09-21：MuPDF 改成**构建期特性**（默认不编）—— 不是删除，是"平时不背它"

owner 问「是否可以清理 mupdf 了？」。查下来**代码上早就可以删**（PDFium 从 1.91.13 起是默认引擎，
MuPDF 的公开面只有 `has_document`/`forget`/`render_page`/`compact_rgba` 四个函数，职责就是光栅化，
而文本层/坐标/页数/目录本来走 pdf.js），但**删掉就没有一键回滚了**，而 macOS/Android 的**真机**
两格还没验。于是拍了中间的第三条路：

| 项 | 落法 |
|---|---|
| 依赖 | `mupdf-sys` 变 **optional**；新特性 **`mupdf-rollback`**（`default` **不含**它） |
| 平时 | 默认构建**根本不编 MuPDF** ⇒ 少一个重量级 C 依赖（构建、体积、供应链、一处 unsafe FFI） |
| 回滚 | `cargo build --release --features mupdf-rollback`（或 `pnpm tauri build --features mupdf-rollback`）重编一次即可；`SHUYONOTE_PDF_ENGINE=mupdf` 语义不变 |
| 没编时的行为 | 显式要 MuPDF **不静默换 PDFium、也不 panic**，而是回一句能照着做的话（`commands::MUPDF_NOT_COMPILED`：点名 `mupdf-rollback` ＋ 当下用 `pdfium`） |
| 判据 | `commands::pdf_engine_tests` **4 → 5 条**：新增 `asking_for_mupdf_says_what_to_do_when_the_feature_is_off`（两种构建各断言自己那一半；`mupdf_compiled()` 必须等于 `cfg!(feature)`）；P3 对拍模块 `pdf_engine_compare` 改成 `#[cfg(all(test, feature = "mupdf-rollback"))]`（它同时用两个引擎，没编 MuPDF 时没有意义） |

**为什么不是"直接删"**：删了就没有退路，而 §4 的"渲染等价"里中文/扫描件两类**仍未完全达成**、
macOS 装完开 PDF 与 Android 真机开 PDF**都还没验**。这一步把"背不背它"从**产品决定**降成**构建参数**：
验收补齐后只需删一个 feature 定义；反过来哪天 PDFium 出问题，也不必回滚版本、只需换一个构建。

---

## 1. 范围：只换光栅化

```ts
// src/components/PdfReader.tsx:122,136,651 —— 桌面：native 只出「页位图」
if (attachmentId && platform.pdfRender.nativeAvailable()) {
  const { bytes, width, height } = await platform.pdfRender.renderPdfPage(attachmentId, pageIndex, scale);
}
// 文本层 / 坐标 / 页数 / 目录 —— 全部来自 createPdfjsEngine()（pdf.js，Apache-2.0）
// src/lib/platform/web.ts:3605 —— Web：nativeAvailable() === false，全走 pdf.js
```

⇒ **坐标语义不经 native 引擎**，因此：

- ❌ 不需要"两引擎坐标对拍"（当年那份方案担心的 `getPageTextItems` 坐标对齐，在现有分层下**不存在**）；
- ✅ `render_pdf_page` 命令签名与 `{width,height,rgba_base64}` 契约**不变**；
- ✅ `src/lib/pdfNativePage.ts:112` 的 `parseNativePageResponse` **一行不改**。

**唯一用户可见的差异**应该是"渲染出来的像素"本身 —— 所以对拍（§4）是验收的核心。

---

## 2. 分阶段任务

| 阶段 | 内容 | 估算 | 交付物 |
|---|---|---|---|
| **P0** | **拿到并固定 `pdfium.dll`（build 7881）**：自建（Chromium 工具链，重）或取预编译包 + **比对校验和**；把版本与 sha256 写进仓库 | 0.5–1 人日 | ✅ **已完成**（§0.1）：`scripts/fetch-pdfium.mjs` ＋ 校验和 ＋ `SOURCE.txt` 溯源 |
| **P1** | 新增 `src-tauri/src/pdfium_native.rs`（渲染 + 文档缓存 + 全局 init/锁），**保留 `pdf_native.rs`（MuPDF）不动** | 1–2 人日 | 新模块 + 单测 |
| **P2** | `render_pdf_page` 按开关分派（✅ **已定（2026-09-17）：运行时开关**），两条路径都能跑 | 0.5 人日 | 可回滚的双路径 |
| **P3** | **对拍**：同一批真实 PDF（含扫描件、中文、旋转页、超大文件）比较两引擎渲染结果与单页耗时 | 1 人日 | 对拍脚本 + 报告 · **✅ 脚本＋6 个自写样本**（WSL2 实测通过）；`scan.pdf` 走硬判据且一次通过；⚠️ **中文那一类只报不判，而且实测三家各有各的问题**（Windows PDFium ✅ / Linux pdfium.so 不画文字 / MuPDF 乱码，pdf.js ✅——见 §0.3-O 与证据包） |
| **P4** | Windows 打包验收 → 多平台（macOS bundle ＋ 公证、Linux rpath、Android `jniLibs`）**作为独立任务** | 1 人日 + 2–3 人日 | 各平台安装包 · **🟡 Windows ✅（dll 进包、sha256 一致、变异实测）；Linux ✅ 已验**（deb 里 `libpdfium.so` ＋ **随包中文字体**都在资源目录那层、sha256 与钉死值一致，且两件都有产物级门禁）；**Android ✅ 通路已落**（CI 上第一次走通，见 §0.3-**P**；**真机验收未做**）；**macOS ❌ 未验**（归 Mac，见 P3 报告 §七 第 5 行）；⚠️ 中文那类文件的**六格读数已齐**（§0.3-O）；新增一条 **P4 拦路石**：**Linux 那份 `libpdfium.so` 没有 fontconfig 字体后端** ⇒ 非嵌入字体（含国标中文）在 Linux 上**整行不显示**，且"装系统字体"治不了 —— 施工单见信箱 `2026-09-20-pdfium-linux-font-backend-workorder`（已按路线 D 落地：随包 OFL 中文字体；读数见 §0.3-**P**） |
| **P5** | 灰度一个发布周期 → 默认切 PDFium → （可选）删 MuPDF | — | 发布记录 · **✅ 默认已切**（2026-09-19，`PdfEngine::DEFAULT = Pdfium`，4 条判据守着）；⚠️ 缺库的包**不会白屏**：`PdfReader.tsx:122-131` 把原生渲染的异常吞掉、**静默退回 pdf.js**（"要不要改成回退 MuPDF"问过并**否掉**了，理由见 §0.3-L） |
**建议顺序**：P0 → P1 → P3（先证明渲染等价，再谈打包）。**P3 不对拍不算完成。**

---

## 3. 实现要点（可直接照着写）

1. **位图通道顺序**：PDFium 常用档是 **BGRA/BGRx/GRAY**（按所钉 build 的枚举核对），**没有 RGBA** ⇒ 在 Rust 侧换成 RGBA，**保持前端契约**（与 `pdf_native.rs:233` `compact_rgba` 同一条原则：**差异在本侧消化，不漏给下游**）。
2. **stride 反而更简单**：PDFium 的位图缓冲由**调用方分配**（`FPDFBitmap_CreateEx` 传自己的 buffer 与 stride）⇒ **行对齐填充问题消失**，`compact_rgba` 那套处理在 PDFium 路径上可退化为"无需处理"。
3. **全局初始化 + 锁**：`fz_context` 那套模式（`pdf_native.rs:38-52`：进程级只建一次、永不释放、渲染全程持锁）**可以 1:1 搬迁** ⇒ `FPDF_InitLibrary` 一次 ＋ `Mutex`。两个最阴的坑（反复重建全局上下文崩 Windows、非线程安全）不会重踩。
4. **文档缓存仍要管生命周期**：`FPDF_LoadMemDocument` 的**缓冲区必须活得比 document 长**（流是按需读的）——与 MuPDF 的 `CachedDocument`（`pdf_native.rs:57-60`）**是同一个坑**，注释里那条警告要一并搬过去；缓存同样要有界。
5. **错误处理**：每次调用后检查 `FPDF_GetLastError()`，把错误码映射成可读信息（沿用现有"错误信息要有指向性"的原则）。
6. **像素上限不变**：`MAX_PAGE_PIXELS = 40_000_000`（`pdfNativePage.ts:29`）继续作为防御闸门；PDFium 路径同样在**碰画布之前**校验倍率与尺寸。

---

## 4. 验收标准

- [ ] **渲染等价**：同一批 PDF（印刷体 / 扫描件 / 中文 / 旋转页 / 超大页 / 透明底）两引擎输出**目视一致**，像素差异在约定容差内
      —— ✅ **样本集已定（2026-09-17）**：**写生成脚本 ＋ 少量产物入库**（自制样本无版权风险、结论可复现，见 §0.2-H）
      —— ✅ **四样本已对拍（2026-09-19）**：印刷体 `text` / 旋转 `rotate90` / 超大页 `a0-large` / 透明底 `alpha`，
      硬判据 4/4 ＋ 目视 4/4 ⇒ 报告 [2026-09-19-pdfium-p3-report.md](2026-09-19-pdfium-p3-report.md)。
      —— ✅ **两份独立读数**（2026-09-19）：同一被验 commit `23985ef`，Windows 侧 WSL2 与 AMD 侧各自独立复现，
      **数字逐格一致**（RGB 最大差 0/0/1/1、超阈 0.000%、`语义不一致` 四份全零）；目视也是两份
      （本轮 4 张对照图已入库 `docs/media/pdfium-p3-compare/`，AMD 侧 7 张 PNG 留档在信箱 `pdfium-p3/visual-check-23985eff/`）。
      ⚠️ **中文与扫描件样本仍未实现**（生成脚本自己声明未覆盖、不拿近似样本充数）⇒ 本项**尚未完全达成**（其余四类已达成）。
- [ ] **性能不退化**：单页耗时对比记录在案（PDFium 不得明显慢于 MuPDF；扫描件通常更快）
      —— ✅ 读数见 [P3 报告 §五](2026-09-19-pdfium-p3-report.md)（对拍模块本身没有耗时口径，用临时探针补的；探针未入库）
- [ ] **契约不变**：`parseNativePageResponse` 与前端零改动即可工作 —— ✅ 前端零改动（P2 那条分派本来就只动 Rust 侧）
- [ ] **回滚可用**：一键切回 MuPDF，不需要改前端、不需要回滚数据
      —— ✅ `SHUYONOTE_PDF_ENGINE=mupdf`：**显式匹配**（大小写/首尾空格不敏感），有判据钉住；
      另有一条 `assert_ne!(DEFAULT, Mupdf)` 保证"回滚不是回滚到同一个东西"。不需要新版、不需要动数据。
      ⚠️ **可观测口径**：阅读器对"原生渲染失败"有一条 pdf.js 回退（见 §5 末两行）⇒ 判断"切没切成功"要看
      **控制台有没有 `native page render failed, falling back to pdf.js`**，而不是"页面能不能出来"。
- [ ] **打包**：每个平台的安装包**首次启动即可渲染**（动态库随包、路径正确、macOS 过公证、Android 进 `jniLibs`）
      —— Windows ✅ `tauri.windows.conf.json`（1.91.5 起）。本轮独立复核三条：`7z l` 命中 `pdfium.dll`（时间戳=源文件）、
      静默安装后 dll 与 exe 同级、该 dll `LoadLibraryW` 成功且 `FPDF_InitLibraryWithConfig`/`FPDF_LoadDocument` 都在；
      并做了**运行时 A/B**（藏库 ⇒ 控制台出现 pdf.js 回退日志；库在位 ⇒ 无该日志且正常渲染）。
      —— macOS ⚠️ 配置已随包（`tauri.macos.conf.json` → `.app/Contents/Frameworks`，含方向修复 `4c6f83c`），
      但**真出包/公证读数仍缺**（归 Mac）。
      —— Linux ✅ 代码已在 dev（`library_dir()` 的 `resource_dir()` 探测 + `tauri.linux.conf.json` + CI 取库 +
      产物断言 `check-linux-bundle`）；**1.91.6 起 Linux 包会真的带库**（上一版 1.91.5 的 deb 解包实测：无 `libpdfium`）。
      **2026-09-20 补**：真 deb 端到端已验（`libpdfium.so` + **随包中文字体** 都在资源目录那一层、sha256 与钉死值一致），
      并把这两件都做成了 `check-linux-bundle` 的产物级判据 ⇒ 见 §0.3-**P**。**AppImage 已验**（同日在 WSL2 里自建，
      117,504,504 B，库与字体都在资源目录那层、结构比对只差一个 runpath ⇒ 判据 0 条 problem；配方见 `docs/TESTING.md`）。
      —— Android ✅ **通路已落（2026-09-20）**：`fetch-pdfium --platform android-arm64` → `stage-android-pdfium`
      （放进 `gen/android/app/src/main/jniLibs/arm64-v8a/`）→ 构建 → `check-android-bundle` 断言包内那份与 vendor **逐字节相同**；
      CI 上这条通路**第一次**走到头（run 35504661582 全绿，见 §0.3-**P** ③④ —— 修之前它连着三跑红在"取错平台"与"GNU tar 读不了 zip"上）。
      ⚠️ 仍未做的是**真机验收**（下面那条）。
- [ ] **真机**：桌面（Windows + 至少一个其它平台）＋ Android 真机各跑一遍
      —— ✅ **用户侧复验通过（2026-09-19，原话「pdf复验通过」）**：装 **1.91.9**（默认引擎已是 PDFium，
      且那是**第一个真把三平台产物发出去**的版本，见文末「P5 状态」）打开 PDF 正常。
      ⚠️ **覆盖范围按用户原话记，没有逐平台展开**：本行原本要求的"至少一个其它桌面平台"与"Android 真机"
      未见单独签字；macOS 真出包/公证读数与 Android `jniLibs` 仍按上面「打包」那一条挂着。
      Windows 侧另有自动化验证（含上面那次运行时 A/B），但那**不是人手签字** —— 本条记的正是**人的**复验。
- [ ] 既有门禁全绿（`tsc`、`pnpm test`、`check:web-commands`、`cargo check --all-targets`）
      —— ✅ 本机：`cargo check --all-targets` 0 错 0 告警、`tsc` 0、vitest 1174 通过 / 1 跳过、`pnpm verify` **23/23**。
      —— ✅ **CI 的「Rust 测试」红已修（dev `f4151be1`，随 1.91.9 进 main）**：那个 job 改成**先取库再跑**
      （`fetch-pdfium` 步骤），而 `pdf_engine_compare` 在**缺库时响亮跳过并打印原因**、不再判红。
      随后 main 的 CI 三个 job —— Rust 测试 / 单测·冒烟·契约 / 移动端布局 —— **全绿**（run `35427381570`）。
      ⇒ §5 风险表里"CI 全绿不成立"那一条**已关闭**。

> **P5 状态（2026-09-19 更新）**：**默认引擎已切 PDFium**（`7247739`，owner 批准，tag `v1.91.6`）。
> ⚠️ **但 1.91.6 / 1.91.7 / 1.91.8 三版都没能把产物发出去** —— Linux 那条产物断言是**假红**
> （真因与订正见 `scripts/check-linux-bundle.mjs` 顶部那段），于是**更新通道一直停在 1.91.5**。
> 真正落地的是 **`v1.91.9`**：三平台产物齐 + `latest.json` 已发（windows-x86_64 / linux-x86_64 / android-aarch64，
> 三项 url 均 HTTP 206），`check:release-state` **20 项通过**；用户侧 PDF 复验也通过（见上「真机」一条）。
> 回滚杠杆见上（`SHUYONOTE_PDF_ENGINE=mupdf`）。**"删 MuPDF"这一步没做** —— 按 §2 的 P5，等灰度一个发布周期后再评估。
> ⚠️ 2026-09-21 更新（见 §0.4）：**"删"仍然没做，但"背不背它"改成了构建参数** ——
> `mupdf-rollback` 特性默认不编，要回滚就 `--features mupdf-rollback` 重编一次。

---

## 5. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 动态库打包（多平台/公证/Android） | 交付形态问题，**最容易漏** | P4 独立排期，逐平台验收；"首次启动即可渲染"写进验收 |
| PDFium 无官方稳定 API/ABI | 升级即迁移 | **钉 build 7881**（crate 的 feature 已按版本门控）；升级当小迁移做 |
| 预编译包来源是社区 | 商用交付的供应链问题 | **建议自己构建**并固定校验和；若用预编译，记录来源与 sha256（§6） |
| 渲染结果与 MuPDF 有差异 | 用户可见 | P3 对拍，先出报告再切默认 |
| 位图格式/通道顺序搞错 | 颜色错乱（**"能显示但不对"**） | Rust 侧转换 + 单测钉住通道顺序（红绿蓝各写一个已知值断言） |
| 与国密工作流并发改 `Cargo.toml` | 冲突 | 串行：**先落国密的依赖，PDFium 再基于最新 main 落**（见国密方案 §9） |
| **原生引擎失败会被 pdf.js 静默顶上**（2026-09-19 实测） | "切了默认、其实在用 pdf.js"**界面上不可见**：`PdfReader.tsx:122` 有刻意的回退，只在控制台留 `native page render failed, falling back to pdf.js` | ① 发布说明里对"装包没带库"的平台**点名**（当前是 Android）；② 灰度期的观测口径就用那条日志，别用"页面能不能出来" |
| `pdfium_matches_mupdf_on_fixtures` 依赖动态库 | CI 的「Rust 测试」任务在跑测机器上**红**（缺库 ⇒ 该测试失败）⇒ "CI 全绿"不成立 | ✅ **已按此修（dev `f4151be1`，随 1.91.9 进 main）**：两条都做了 —— 该 job 加了 `fetch-pdfium` 取库，且缺库时**显式跳过并打印原因**。main 的 CI 三个 job 随后全绿（run `35427381570`） |

---

## 6. 库获取策略（供应链，别跳过）

三条路，按"商用交付的稳妥度"排序：

1. **自己构建**（推荐用于交付）：按官方 Chromium 工具链（depot_tools/gn/ninja）构建指定 tag，产出各平台库；成本高但**可控、可复现**；
2. **取预编译包 + 记录来源与校验和**（开发期可用）：把 URL、版本、sha256 写进仓库文档，并在 CI 里校验；
3. **走系统/发行版包**（Linux 某些发行版有 `pdfium` 包）：版本不可控，商用交付不建议。

无论哪条：**版本与校验和必须入库**，构建脚本要**校验后使用**，不许"下载了就塞进安装包"。

**✅ 已定（2026-09-17，见 §0.2-G）**：**开发期走第 2 条**——先把四个平台的校验和**实测补齐**（`--print-sha256`，与 `win-x64` 同套路），
把多平台跑通；**交付前**再评估第 1 条（自建）。⚠️ 现状：平台表里只有 `win-x64` 有校验和，其余**四个都是 `sha256: null`**，
脚本对它们硬失败 ⇒ **P4 多平台打包现在就是被这一条卡住的**。

---

## 7. 与国密工作流的关系

- **文件零重叠**：国密在 `crypto.rs`/`security.rs`，PDFium 在 `pdf_native.rs` ＋ 打包；
- **唯一串行点**：`Cargo.toml` / `Cargo.lock`；
- **发布纪律**：两者**不要同时合入 main 并发布** —— 一个动"数据能不能打开"，一个动"内容能不能显示"，同时上真机出问题时无法归因。
