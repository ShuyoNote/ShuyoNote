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
| **P3** | **对拍**：同一批真实 PDF（含扫描件、中文、旋转页、超大文件）比较两引擎渲染结果与单页耗时 | 1 人日 | 对拍脚本 + 报告 |
| **P4** | Windows 打包验收 → 多平台（macOS bundle ＋ 公证、Linux rpath、Android `jniLibs`）**作为独立任务** | 1 人日 + 2–3 人日 | 各平台安装包 |
| **P5** | 灰度一个发布周期 → 默认切 PDFium → （可选）删 MuPDF | — | 发布记录 |

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
      —— Android ❌ **无 `jniLibs`** ⇒ 走 pdf.js 回退（发布说明已点名）。
- [ ] **真机**：桌面（Windows + 至少一个其它平台）＋ Android 真机各跑一遍 —— ❌ **仍未做**；
      Windows 侧只有自动化验证（含上面那次运行时 A/B），**不是人手签字**。
- [ ] 既有门禁全绿（`tsc`、`pnpm test`、`check:web-commands`、`cargo check --all-targets`）
      —— ✅ 本机：`cargo check --all-targets` 0 错 0 告警、`tsc` 0、vitest 1174 通过 / 1 跳过、`pnpm verify` **23/23**。
      ⚠️ **CI 的「Rust 测试」任务在 Linux 上红**（`pdf_engine_compare::pdfium_matches_mupdf_on_fixtures` 需要动态库，
      而 CI 的测试任务不取库）⇒ 这**不是**本轮翻转引入的（`1efd696` 与 dev `97583c5` 上同样红），
      但它意味着"CI 全绿"目前**不成立**：缺库时应显式跳过并打印原因，或给该任务加 `fetch-pdfium` 步骤。

> **P5 状态（2026-09-19）**：**默认引擎已切 PDFium**（`7247739`，owner 批准，随 **1.91.6** 发布）。
> 回滚杠杆见上（`SHUYONOTE_PDF_ENGINE=mupdf`）。**"删 MuPDF"这一步没做** —— 按 §2 的 P5，等灰度一个发布周期后再评估。

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
| `pdfium_matches_mupdf_on_fixtures` 依赖动态库 | CI 的「Rust 测试」任务在跑测机器上**红**（缺库 ⇒ 该测试失败）⇒ "CI 全绿"不成立 | 缺库时**显式跳过并打印原因**（而不是判失败），或给该测试任务加一步 `fetch-pdfium`（谁认领都行） |

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
