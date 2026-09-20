# PDFium · **Linux 上非嵌入字体不显示**修复施工单（`cjk.pdf` 整行 0 像素）

> 状态：**施工单**（2026-09-20，Windows 侧）。母方案：[PDFium 替换方案](2026-09-16-pdfium-engine-plan.md) §0.3-O / §4-P4。
> 证据包：信箱 `ShuyoNote-collab/pdfium-p3/visual-check-cjk/`（PNG ＋ 探针 ＋ 全部读数）。
> ⚠️ 本文与 §0.3-O 的分工：**那边记账，这边只写"怎么修 + 怎么算修好"**（避免同一个文件两边并行改）。

---

## 0. 一句话

**Linux 包里带了 `libpdfium.so`，但那份 `.so` 没有字体后端** ⇒
**任何"字体没嵌进 PDF"的文档（含国标中文 `STSong-Light`+`UniGB-UCS2-H`）在 Linux 上不显示文字**。
Windows／macOS 没这个问题（它们有平台字体映射）。**这不是换引擎引入的回归**——
换之前 MuPDF 在同一类文件上是**乱码**（三平台同数 28000 = 矩形 27000 ＋ 乱码 1000）。

## 1. 证据（都能一条命令复现，不是推断）

| # | 读数 | 值 | 来源 |
|---|---|---|---|
| 1 | PDFium／Windows | `p_ink=28816`（超矩形 1816）**✅「中文测试」** | ctypes 直调 ＋ `win-cargo-test.ps1`，**两条独立路径同数** |
| 2 | PDFium／macOS | `p_ink=29582` ✅ | macOS |
| 3 | **PDFium／Linux(WSL2)** | `p_ink=27000` = **矩形面积 ⇒ 文字 0 像素** | WSL2 |
| 4 | MuPDF 三平台 | `m_ink=28000`（乱码 `N-e mK`）× Windows/macOS/Linux **同数** | 三侧 |
| 5 | pdf.js（带 `pdfjs/cmaps`） | 文本层 `["中文测试"]` ✅ | node |

机制（决定性的一条，不是猜测）：

```bash
L=src-tauri/vendor/pdfium/linux-x64/lib/libpdfium.so
ldd $L                       # 只有 6 行：libpthread/libm/libgcc_s/libc/ld-linux — **没有 fontconfig**
grep -c fontconfig $L        # 0
grep -c FreeType    $L       # 7（那只是**内置光栅化器**，不提供字体来源）
grep -c CreateFontIndirect src-tauri/vendor/pdfium/win-x64/bin/pdfium.dll   # 1（Windows 有 GDI 字体映射）
```

- **两平台都不带随包字体**（`vendor/pdfium/**` 下 `*.ttf/ttc/otf/pak` 均为 0 个）；
- 所以"给那台机器装 `msyh`+`simsun`"治不了 —— 它**看不到 fontconfig**（实测：装前装后读数一字不变）；
- **base14 不受影响**（`text.pdf` 的 Helvetica/Times 编在库里）⇒ 这也是这条缺陷隐蔽的原因：
  对拍表上 `text.pdf` 照样 ✅，只有 `cjk.pdf` 那一行暴露它。

## 2. 判据（先定"怎么算修好"，否则会做成"看着好了"）

| # | 判据 | 阈值/口径 |
|---|---|---|
| 1 | **Linux 上 `cjk.pdf` 的"非矩形墨迹" > 0** | `alpha≠0 且 RGB≠(0,0,255)` 的像素数；Windows 1816 / macOS 2582 是参考量级 |
| 2 | **Linux 上目视**：`cjk.pdf` 渲染出来是**「中文测试」**（不是乱码、不是空白） | 人看一眼 PNG，附在报告里 |
| 3 | **回归面**：`text/scan/rotate90/alpha/a0-large` 在 Linux 上仍**全绿**（`scan` 硬判据 0 差） | `cargo test pdf_engine_compare` |
| 4 | **不依赖系统状态**：把测试机的中文字体卸掉（`fc-list` 回 8 条）后判据 1 仍成立 | 随包字体/自建库必须是**自带**的 |
| 5 | **体积预算**（若走随包字体）：Linux 包增量 ≤ **20 MB**；且写进发布说明 | 现 Linux 包里无任何字体文件 |

## 3. 四条路线（**推荐 D**，理由在表下）

| 路线 | 做什么 | 成本 | 风险 / 代价 |
|---|---|---|---|
| **D ★推荐** | **随包一个 OFL 中文字体 ＋ 应用侧实现 `PdfiumCustomFontProvider`**（`pdfium-render` 已暴露 `FPDF_SetSystemFontInfo`） | 1–2 人日 ＋ 一次打包改动 | 包体积 +10~16 MB；字形与"原文档意图"未必一致（但**比不显示好**）；CJK 缺字面残留（可后补子集） |
| **C 兜底** | 不修引擎：**这类文档路由到 pdf.js**（本仓已随包带 `pdfjs/cmaps` ＋ `standard_fonts`） | 0.5–1 人日 | 慢、且"引擎选择"变复杂；要一条判据判断"文档有没有非嵌入字体"（pdf.js 的字体列表能拿到） |
| **A 治本但重** | **自建带 fontconfig 的 `libpdfium.so`**（Chromium/depot_tools 工具链） | 3–5 人日 ＋ CI 镜像 | 供应链变重；产物要能被 `fetch-pdfium.mjs` 用 sha256 钉住；GN 开关名**待证** |
| **B 便宜的先探** | 找**已带 fontconfig 的预编译包**（第三方/发行版构建）替代 bblanchon 包 | 0.5 人日（探） | 版本必须仍是 **build 7881**（与 `pdfium-render` 的 `pdfium_7881` feature 锁死）；来路与许可要过一遍 |

**为什么推荐 D 而不是 A**：A 要一条 Chromium 构建链才能换来"多一个系统字体来源"，而**我们真正缺的只是字体数据**；
D 用**已有的公开 API**（`Pdfium::set_custom_font_provider`，见 §4）把"字体数据"直接喂给 PDFium，
零构建链、零新增二进制供应链，且**判据 4（卸掉系统字体仍成立）天然满足**。
C 作为"万一 D 的字形不可接受"的兜底保留。

## 4. 路线 D 的施工点（**确切到文件/行**）

**现状**（`src-tauri/src/pdfium_native.rs:243-254`）：

```rust
let lib = Pdfium::pdfium_platform_library_name_at_path(&dir);
let bindings = Pdfium::bind_to_library(&lib).map_err(...)?;
let _ = PDFIUM.set(Pdfium::new(bindings));      // ← 只 init，**从不装字体 provider**
```

`pdfium-render 0.9.4` 的公开 API（已核对 crate 源码，`features = ["pdfium_7881","thread_safe"]` 都可用）：

| API | 位置（crate 内） | 用途 |
|---|---|---|
| `Pdfium::set_custom_font_provider(Box<dyn PdfiumCustomFontProvider>)` | `pdfium.rs:256` | **装**我们的字体来源 |
| `trait PdfiumCustomFontProvider { fn provide(&mut self, req) -> Option<Response> }` | `pdf/font/provider.rs:75` | 实现它 |
| `PdfiumCustomFontProviderRequest { font_face, character_set, weight, is_italic, is_fixed_pitch, is_serif, is_cursive }` | 同文件 `:15` | PDFium 来问"这个字体有没有" |
| `PdfiumCustomFontProviderResponse { id, font_face, character_set, data: Vec<u8> }` | 同文件 `:52` | 回**字体原始字节**（TTF/OTF） |

⇒ 改动草案（**约 60 行**）：

```rust
// 1) 拿到字体字节：与库同一个目录（打包用 tauri.linux.conf.json 的 resources 把两者放一起）
let font = font_beside_library(&dir);          // <dir>/NotoSansSC-Regular.otf，缺失就 None
// 2) init 之后、放进 OnceLock 之前装 provider（只在真有字体文件时装 ⇒ Windows/macOS 行为不变）
let mut pdfium = Pdfium::new(bindings);
if let Some(bytes) = font { pdfium.set_custom_font_provider(Box::new(BundledCjkFont::new(bytes))); }
let _ = PDFIUM.set(pdfium);
```

`BundledCjkFont::provide` 的策略：`character_set` 是中日韩/符号一类的请求 ⇒ 回**同一份字体字节**（`id` 自增、`font_face` 回我们自己的名字）；其余 ⇒ `None`（**别乱答**，答了就等于宣称任何字体我们都有）。

**打包**（照现有先例，`src-tauri/tauri.linux.conf.json:8-9` 现在是这么放库的）：

```jsonc
"resources": {
  "vendor/pdfium/linux-x64/lib/libpdfium.so": "libpdfium.so",
  "vendor/fonts/NotoSansSC-Regular.otf":      "NotoSansSC-Regular.otf"   // ← 新增，落在同一目录
}
```

**字体选择**：`Noto Sans SC Regular`（OFL-1.1）或 `Source Han Sans SC`（同源、同许可）。
- 许可：本仓**今天不含任何字体文件**（这是第一次引入随包字体）⇒ 许可原文要随包／随仓库，
  参照 `src-tauri/vendor/pdfium/*/licenses/` 的既有做法；
- 体积：整字面 ~10–16 MB；**不建议**一上来就子集化（子集化会让"任意中文 PDF"缺字，
  与判据 1 的"通用"矛盾）；
- 衬线/黑体：先只带一份无衬线（覆盖绝大多数中文 PDF），**留一条"再补一份衬线"的余量**。

## 5. 验收怎么做（**用现成工具，不新造**）

```bash
# 0) 候选字体放到"库目录旁"（env 变量的目录就是库目录 ⇒ 测试时不用改代码路径）
cp NotoSansSC-Regular.otf <worktree>/src-tauri/vendor/pdfium/linux-x64/lib/
# 1) 跑对拍（就是今天那条命令）
cd src-tauri && SHUYONOTE_PDFIUM_DIR=<...>/vendor/pdfium/linux-x64/lib \
  cargo test pdf_engine_compare -- --nocapture
# 2) 看 cjk.pdf 那一行：非矩形墨迹 > 0（现在 Linux 上是 0）+ 落盘 RGBA 转 PNG 人看一眼
```

⚠️ **负向验收别忘**：把 `NotoSansSC-Regular.otf` **删掉**再跑一次 ⇒ 必须回到"文字 0 像素"
（证明"变好"确实来自这次改动，而不是环境里别的字体）—— 这是本仓"变异实测"的既有做法。

## 6. 分工与顺序

1. **Windows**：本施工单 ＋ `BundledCjkFont`＋`provide` 的实现与单测（`provide` 是纯函数，可在 Windows 上测：
   给一个 CJK 请求必须回非空 `data`、给 Latin 请求必须回 `None`）；
2. **AMD(WSL2)**：判据 1/2/4/5 的读数（**WSL 就能验**，不需要真机 Linux）；
3. **Linux 打包那一位**：`tauri.linux.conf.json` 的 resources ＋ 体积实测 ＋ 发布说明一句话；
4. **macOS**：路线 B 的"探一眼"（他那边网络能到 GitHub）＋ 必要时做 D 在 macOS 上的**行为不变**复核。

## 7. 未决（**别当已定**）

- **路线 A 的 GN 开关名**：待证（候选 `use_fontconfig`，需在有 `depot_tools` 的机器上 `gn args --list | grep -i font`）；
- **Android**：现在无 `jniLibs` ⇒ 走 pdf.js 回退。D 是否也覆盖 Android？⇒ 若 Android 打不进字体资源，**保持 pdf.js**；
- **是否全平台统一装 provider**：保守起见**只在 Linux 装**（Windows/macOS 平台映射已正确，装了反而可能与系统字体抢优先级）；
- **CJK 缺字面**：单一无衬线字体覆盖不全（生僻字/日韩汉字字形差异）⇒ 残留风险写进发布说明，别写成"中文全好了"。

## 8. 挂接

- 母方案：§0.3-O（读数与"只报不判"的理由）、§4 **P4** 行加一条风险：**"Linux 上带库 ≠ 字能显示"**；
- `scripts/fetch-pdfium.mjs`：五个平台 sha256 **都已实测填好**（不再是 P4 拦路石 G）；
  若最终走路线 A/B，这里要加"自建包/替代包"的来源与哈希；
- 对拍表：macOS 侧正在加「**非矩形墨迹**」列（只报不判）——**本施工单的判据 1 就是那一列**；
- 证据：信箱 `pdfium-p3/visual-check-cjk/`（`readings.md` 有全部命令）。
