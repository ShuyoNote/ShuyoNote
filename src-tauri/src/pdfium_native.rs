//! PDFium 光栅化（P1，2026-09-17 开工）。
//!
//! **只做光栅化**：文本层 / 坐标 / 页数 / 目录仍全部来自前端 `createPdfjsEngine()`（pdf.js），
//! 所以换引擎**不需要两引擎坐标对拍**，前端契约（`{width,height,rgba_base64}`）一行不改
//! （依据见 `docs/plans/2026-09-16-pdfium-engine-plan.md` §1）。
//!
//! **本模块与 `pdf_native.rs`（MuPDF）并存**：P1 阶段 MuPDF 路径照旧是默认，**分派在 P2**。
//! 因此这里刻意把公开接口做成与 MuPDF 那条**同形**，P2 接线时只需按开关二选一：
//!
//! | MuPDF (`pdf_native`) | PDFium (本模块) |
//! |---|---|
//! | `has_document(&str) -> bool` | `has_document(&str) -> bool` |
//! | `unsafe render_page(&str,&[u8],usize,f32) -> (rgba,w,h,stride)` | `render_page(&str,&[u8],usize,f32) -> (rgba,w,h)` |
//! | 需 `compact_rgba()` 压掉行填充 | **不需要**——`as_rgba_bytes()` 已输出紧凑 RGBA |
//!
//! ## 与 MuPDF 实现的三处关键差异（都是问出来的，不是猜的）
//!
//! 1. **通道顺序与行填充都不用我们管**：`PdfBitmap::as_rgba_bytes()` 的文档写明它
//!    "normalizing all color channels into RGBA irrespective of the original pixel format"，
//!    内部自行按 `stride = bytes.len() / height` 处理（`bitmap.rs:292-301`）。
//!    ⇒ 方案 §3 第 1、2 条（BGRA→RGBA 本侧转换、stride 退化处理）**不需要实现**。
//! 2. **缓冲区寿命由 crate 负责**：我们走 `load_pdf_from_byte_vec`（把 `Vec` 交给它），
//!    它内部存进 `PdfDocument::source_byte_buffer`（`document.rs:170` ＋ `pdfium.rs:346`）
//!    ⇒ 方案 §3 第 4 条那个"缓冲区必须活得比 document 长"的坑**在这里不存在**。
//!    （对照：`load_pdf_from_byte_slice` 要求 `bytes: &'a [u8]` 与文档同寿命，缓存里用不了。）
//! 3. **不需要 `unsafe`**：绑定由 `pdfium-render` 内部持有，本模块对外是安全接口。
//!
//! ## 全局初始化与锁（与 `pdf_native.rs:38-52` 同一原则，1:1 搬迁）
//!
//! 进程级只建一次 `Pdfium`、**永不释放**，且**渲染全程持缓存锁**——当年 MuPDF 那两个最阴的坑
//! （反复重建全局上下文崩 Windows、库本身非线程安全）因此不会重踩。
//!
//! ## ⚠️ P2 接线时必须做的三件事（AMD 复核提出，2026-09-17）
//!
//! 1. **两套缓存互斥淘汰**：MuPDF 与 PDFium 的缓存**用同一个 key（内容 hash）**，
//!    接线后可能同时持有同一份文档 ⇒ 内存翻倍而两侧 LRU 互不知情。切引擎时对该 key 调 [`forget`]，
//!    或统一成一个带 `engine` 标签的缓存。**这是复核里最被强调的一处。**
//! 2. **删掉模块级 `#![allow(dead_code)]` 并加门禁**（grep 断言本文件不再有它）——
//!    "临时"最常见的归宿是常设。
//! 3. **口令对齐**：本模块走 `load_pdf_from_byte_vec(bytes, None)`，`None` 是**口令**。
//!    已核实 MuPDF 那条的调用点（`commands.rs:590`）**也只传 4 个参数、没有口令**
//!    ⇒ 两条**都不支持带口令的 PDF**，属对齐。将来要支持就**两条一起加**。
//!
//! ## 调用方（P2 已接线，2026-09-17）
//!
//! 分派在 `commands.rs` 的 `render_pdf_page`：`SHUYONOTE_PDF_ENGINE=pdfium` 时走本模块。
//! ⇒ **模块级 `#![allow(dead_code)]` 已删除**（P2 验收项之一）。
//! 若下面还有逐项 `#[allow(dead_code)]`，那是留给**暂无调用方但有意保留**的入口
//! （`render_page` 借用版 / `clear()` 诊断用），不是遗留物。

use pdfium_render::prelude::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// 一页最多渲染多少像素。**按平台分档**（AMD 复核第 2 条）：
/// 40,000,000 px × 4 B = **160 MB/页**，还要再加 crate 内部 bitmap 的副本——
/// 桌面可接受，**Android 上很危险**（1.6 GB 内存的机器两页并排就 320 MB）。
/// 移动端取 16M px（≈64 MB/页）作为安全默认。
///
/// 与前端的关系：`pdfNativePage.ts` 的 `MAX_PAGE_PIXELS` 是**请求侧**闸门，
/// 这里是**执行侧**、也是更严的那一道。P4 打包时前端也应按平台取同一个值（已记进方案待办）。
const fn max_page_pixels() -> i64 {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        16_000_000
    } else {
        40_000_000
    }
}

/// 文档缓存上限。一个 `PdfDocument` 里**含整份 PDF 字节的副本**（见模块头第 2 条），
/// 所以不能无界增长；按"最久未用"淘汰。
const DOC_CACHE_LIMIT: usize = 4;

/// **未绘制区域**的清屏色：全透明 `(0,0,0,0)`。
///
/// ⚠️ `pdfium-render` 的默认是**不透明白**：`PdfRenderConfig` 里 `do_clear_bitmap_before_rendering: true`
/// ＋ `clear_color: PdfColor::WHITE`（`render_config.rs`）⇒ 渲染前会先把整张位图 `FPDFBitmap_FillRect`
/// 刷成白，再让 PDFium 往上画。而 **MuPDF 那条走的是 `alpha=true`**（`pdf_native`）——
/// 未绘制区域是**透明**的，由前端铺 `--surface`／护眼纸底（`App.css` 的 `.pdf-reader-stage`）。
///
/// ⇒ 不显式改这里，两条路的"未绘制区域语义"就不一致，P3 对拍里表现为**约 99.8% 像素不同**
/// （AMD 2026-09-18 在 Linux 上实测：只有背景不同，归一后降到 1.2–7.6%）。
/// 清成透明让两条路**语义一致**：切引擎对观感（含暗色 + 护眼四档）**零影响**，
/// 且对拍比的是**内容**而不是"谁铺的底"。
const CLEAR_COLOR_TRANSPARENT: PdfColor = PdfColor::new(0, 0, 0, 0);

/// 进程级唯一的 PDFium 实例。只建一次、永不释放。
static PDFIUM: OnceLock<Pdfium> = OnceLock::new();

/// `cache_key -> 已打开的文档`。键沿用附件内容 hash（与 MuPDF 路径同一个键，P2 分派时可直接复用
/// `commands.rs:581` 那次 `has_document` 查询）。
static DOC_CACHE: OnceLock<Mutex<HashMap<String, CachedDocument>>> = OnceLock::new();

/// 单调递增的访问序号，用于淘汰"最久未用"的那个。
static TICK: AtomicU64 = AtomicU64::new(0);

struct CachedDocument {
    doc: PdfDocument<'static>,
    tick: u64,
}

fn doc_cache() -> &'static Mutex<HashMap<String, CachedDocument>> {
    DOC_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// **打包后的「资源目录」**——由 `lib.rs` 的 `setup()` 在启动时登记
/// （`app.path().resource_dir()`）。
///
/// 为什么需要它（2026-09-19，AMD 按 Windows 收尾单 §七.6 的实测建议落地）：
/// Tauri 在 **Linux** 上 `resource_dir` **不等于**可执行文件目录
/// （deb = `/usr/lib/<id>`、AppImage = `$APPDIR/usr/lib/<id>`），
/// 而 `tauri.linux.conf.json` 正是把 `libpdfium.so` 映射进资源目录的
/// ⇒ 只探"exe 同目录"在 Linux 发行包上**永远找不到库**。
/// macOS 走 `bundle.macOS.frameworks`（`Contents/Frameworks`，已在候选里），Windows 上这条是重复探测（无害）。
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 登记打包资源目录（幂等：只有第一次生效；`setup()` 只跑一次）。
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// 候选目录的**顺序**（纯函数：不读环境变量、不碰文件系统 ⇒ 判据可以直接钉顺序）。
///
/// 顺序 = **可执行文件同目录**（发行包形态；Windows 装包把 `pdfium.dll` 放在那里）
/// → **macOS `.app/Contents/Frameworks`**（macOS 动态库的常规位置，且要一起签名/公证）
/// → **打包资源目录**（Linux deb/AppImage）→ **仅 debug** 的仓库内 vendored 目录。
fn candidate_dirs(
    exe_dir: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    vendored_default: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir {
        // macOS 的 .app 束：可执行文件在 Contents/MacOS/，动态库按惯例在 Contents/Frameworks/。
        #[cfg(target_os = "macos")]
        out.push(dir.join("../Frameworks"));
        out.push(dir);
    }
    if let Some(dir) = resource_dir {
        out.push(dir);
    }
    // `fetch-pdfium.mjs` 把库解到 `src-tauri/vendor/pdfium/<平台>/<spec.lib>`，而 `spec.lib` 的
    // 目录前缀**各平台不统一**：Windows 是 `bin/pdfium.dll`，Linux / macOS / Android 是
    // `lib/libpdfium.so|dylib`（见该脚本 `PLATFORMS` 与方案 §0.1）。
    //
    // ⚠️ 2026-09-18 AMD 在 Linux/macOS 实测：这里原来**写死 `bin`** ⇒ 那两个平台的 vendored 回退
    //    **从来不会命中**（Windows 恰好就是 `bin`，所以在本机一直没暴露）。⇒ 改为按候选目录逐个探测。
    if let Some(root) = vendored_default {
        for sub in ["bin", "lib", ""] {
            out.push(if sub.is_empty() { root.clone() } else { root.join(sub) });
        }
    }
    out
}

/// 从候选里挑第一个**真的有库**的目录（文件系统探测只在这一个函数里）。
fn pick_library_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|dir| Pdfium::pdfium_platform_library_name_at_path(dir).exists())
        .cloned()
}

/// 仓库内 vendored 目录（**仅 debug 构建**有意义；release 包不带 `vendor/`）。
#[cfg(debug_assertions)]
fn vendored_root() -> Option<PathBuf> {
    let platform = if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") { "win-arm64" } else { "win-x64" }
    } else if cfg!(target_os = "macos") {
        "mac-univ"
    } else if cfg!(target_os = "android") {
        "android-arm64"
    } else {
        "linux-x64"
    };
    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("vendor")
            .join("pdfium")
            .join(platform),
    )
}

#[cfg(not(debug_assertions))]
fn vendored_root() -> Option<PathBuf> {
    None
}

/// PDFium 动态库所在目录。
///
/// 优先级：**环境变量**（联调/测试用）→ 其余见 [`candidate_dirs`]（可执行文件同目录 →
/// macOS `Contents/Frameworks` → **打包资源目录** → 仅 debug 的 vendored 目录）。
/// 都找不到时由 [`shared_pdfium`] 报出**带路径的可操作错误**。
fn library_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SHUYONOTE_PDFIUM_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let candidates = candidate_dirs(exe_dir.clone(), RESOURCE_DIR.get().cloned(), vendored_root());
    if let Some(dir) = pick_library_dir(&candidates) {
        return dir;
    }
    // 最后回退到可执行文件目录，让错误信息里的路径有意义。
    exe_dir.unwrap_or_else(|| PathBuf::from("."))
}

/// **库在不在**（给判据用）：与 [`shared_pdfium`] 同一套解析，但不加载、不缓存。
///
/// 为什么要单独一个：PDFium 是**运行时 dlopen** 的，而库里那份二进制**不入 git**
/// （`vendor/pdfium/` 在 `.gitignore` 里）⇒ 新克隆、worktree、CI 上都可能没有它。
/// 判据遇到"库不在"时应当**响亮自报跳过**（`! …跳过…`，报告器会收成一等公民），
/// 而不是把 `cargo test` 判红 —— 后者会让"缺一个开发期二进制"看起来像"代码坏了"，
/// 而真红了以后没人分得清是哪一种（2026-09-19 rust job 就是这么红的）。
pub fn library_preflight() -> Result<(), String> {
    let dir = library_dir();
    let lib = Pdfium::pdfium_platform_library_name_at_path(&dir);
    if lib.exists() {
        return Ok(());
    }
    Err(format!(
        "找不到 PDFium 动态库：{}（开发机跑 `node scripts/fetch-pdfium.mjs`；CI 的 rust job 有取库步骤）",
        lib.display()
    ))
}

/// 拿到进程级 PDFium 实例；首次调用时绑定动态库。
///
/// 用 `set`/`get` 而不是 `get_or_init`：绑定**可能失败**（库缺失/版本不符），
/// 而 `get_or_init` 的闭包不接受失败返回值。
fn shared_pdfium() -> Result<&'static Pdfium, String> {
    if PDFIUM.get().is_none() {
        let dir = library_dir();
        let lib = Pdfium::pdfium_platform_library_name_at_path(&dir);
        if !lib.exists() {
            return Err(format!(
                "找不到 PDFium 动态库：{}。开发机先跑 `node scripts/fetch-pdfium.mjs`，\
                 发行包应由打包步骤把库放到可执行文件同目录（或设 SHUYONOTE_PDFIUM_DIR）",
                lib.display()
            ));
        }
        let bindings = Pdfium::bind_to_library(&lib)
            .map_err(|e| format!("加载 PDFium 失败（{}）：{e}", lib.display()))?;
        // 两个线程同时初始化时，`set` 会有一个失败——那说明另一个已经建好了，忽略即可。
        let _ = PDFIUM.set(Pdfium::new(bindings));
    }
    PDFIUM
        .get()
        .ok_or_else(|| "PDFium 初始化失败（实例未建立）".to_string())
}

/// 该 PDF 是否已在本模块的缓存里（与 MuPDF 那条同名同义，P2 分派时按引擎各查各的）。
///
/// ⚠️ **用 `try_lock`，拿不到锁就返回 `false`**（AMD 复核第 1 条）：`false` 在这里是**安全方向**——
/// 调用方（`commands.rs:581`）会去读字节再传进来，而渲染侧命中缓存后会忽略这些字节，只是多一次 I/O；
/// 反过来在拿不到锁时返回 `true`，会让调用方传**空字节**，而那在渲染侧是**必须报错**的路径。
/// 这样一次大页渲染就不会把所有状态查询堵在锁上。
pub fn has_document(cache_key: &str) -> bool {
    match doc_cache().try_lock() {
        Ok(c) => c.contains_key(cache_key),
        Err(_) => false,
    }
}

/// 把某一页渲染成**紧凑 RGBA**（`width * height * 4`，无行填充）＋ 尺寸（借用版）。
///
/// `scale` 与 MuPDF 路径同义：**相对页面自然尺寸的倍率**。
/// 与 MuPDF 那条的差别只有一个——**不返回 `stride`**：PDFium 的输出本来就紧凑，无需 `compact_rgba`。
///
/// 若调用方**已经不再需要**这份字节，用 [`render_page_owned`] 可以省掉一次整文件拷贝（AMD 复核第 4 条）。
#[allow(dead_code)] // 有意保留：借用版，给"还要复用字节"的调用方（P3 对拍脚本可能用）
pub fn render_page(
    cache_key: &str,
    bytes: &[u8],
    page_index: usize,
    scale: f32,
) -> Result<(Vec<u8>, usize, usize), String> {
    let mut cache = doc_cache()
        .lock()
        .map_err(|_| "PDFium 文档缓存锁已中毒".to_string())?;
    let entry = ensure_cached(&mut cache, cache_key, || {
        // 调用方的约定是：缓存命中时传空 bytes（省掉一次解密+整文件读，见 commands.rs:579-585）。
        // 走到这里说明"以为命中但实际没有"——必须显式报出来，不能拿空缓冲去开文档。
        if bytes.is_empty() {
            return Err(empty_bytes_error(cache_key));
        }
        // 这一次拷贝是必要的：crate 要**拥有**这份字节（模块头第 2 条），而调用方给的是借用。
        Ok(bytes.to_vec())
    })?;
    render_entry(entry, page_index, scale)
}

/// 同 [`render_page`]，但**吃掉调用方的 `Vec`**，省掉整份 PDF 的拷贝（借用版做不到这一点）。
///
/// P2 分派时优先用这个：那条分支拿到字节之后本来就不再需要它了。
pub fn render_page_owned(
    cache_key: &str,
    bytes: Vec<u8>,
    page_index: usize,
    scale: f32,
) -> Result<(Vec<u8>, usize, usize), String> {
    let mut cache = doc_cache()
        .lock()
        .map_err(|_| "PDFium 文档缓存锁已中毒".to_string())?;
    let entry = ensure_cached(&mut cache, cache_key, move || {
        if bytes.is_empty() {
            return Err(empty_bytes_error(cache_key));
        }
        Ok(bytes)
    })?;
    render_entry(entry, page_index, scale)
}

fn empty_bytes_error(cache_key: &str) -> String {
    format!("PDFium: 文档 {cache_key} 不在缓存中，但调用方传了空字节（应先查 has_document）")
}

/// 丢掉某个 key 的缓存文档（**P2 切引擎时用它做互斥淘汰**，见模块头 P2 第 1 条）。
pub fn forget(cache_key: &str) {
    if let Ok(mut cache) = doc_cache().lock() {
        cache.remove(cache_key);
    }
}

/// 清空整个文档缓存（诊断/测试用）。
#[allow(dead_code)] // 有意保留：诊断/测试用（清空整个文档缓存）
pub fn clear() {
    if let Ok(mut cache) = doc_cache().lock() {
        cache.clear();
    }
}

/// 确保文档在缓存里，并返回它的引用。`load` **只在未命中时**调用。
fn ensure_cached<'a>(
    cache: &'a mut HashMap<String, CachedDocument>,
    cache_key: &str,
    load: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<&'a CachedDocument, String> {
    if !cache.contains_key(cache_key) {
        let bytes = load()?;
        let pdfium = shared_pdfium()?;
        let doc = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(|e| format!("PDFium 打开 PDF 失败（{cache_key}）：{e}"))?;
        evict_if_needed(cache);
        let tick = TICK.fetch_add(1, Ordering::Relaxed);
        cache.insert(cache_key.to_string(), CachedDocument { doc, tick });
    } else if let Some(entry) = cache.get_mut(cache_key) {
        // 命中即刷新"最久未用"的标记。
        entry.tick = TICK.fetch_add(1, Ordering::Relaxed);
    }
    cache
        .get(cache_key)
        .ok_or_else(|| format!("PDFium 缓存插入后取不到 {cache_key}"))
}

/// 淘汰到上限以内（最久未用的先走）。
fn evict_if_needed(cache: &mut HashMap<String, CachedDocument>) {
    while cache.len() >= DOC_CACHE_LIMIT {
        let victim = cache
            .iter()
            .min_by_key(|(_, e)| e.tick)
            .map(|(k, _)| k.clone());
        match victim {
            Some(key) => {
                cache.remove(&key);
            }
            None => break,
        }
    }
}

/// 真正的渲染：页面自然尺寸 × `scale` → 目标像素 → 闸门校验 → 光栅化 → 紧凑 RGBA。
fn render_entry(
    entry: &CachedDocument,
    page_index: usize,
    scale: f32,
) -> Result<(Vec<u8>, usize, usize), String> {
    let pages = entry.doc.pages();
    let count = pages.len();
    if count <= 0 {
        return Err("PDFium: 这份 PDF 没有页面".to_string());
    }
    let idx = i32::try_from(page_index).map_err(|_| format!("页码 {page_index} 超出范围"))?;
    if idx >= count {
        return Err(format!("页码 {page_index} 超出范围（共 {count} 页）"));
    }
    let page = pages
        .get(idx)
        .map_err(|e| format!("PDFium 取第 {page_index} 页失败：{e}"))?;

    // `scale` 不合法时按 1.0 处理，不让 NaN/负数变成"像素数为负"这种怪错误。
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };

    // 页面自然尺寸单位是**点**（`PdfPoints`），乘倍率得到目标像素——与 MuPDF 那条同义。
    // ⚠️ `PdfPoints::value` 是**公有字段**，不是方法（写成 `.value()` 会报 E0599，实测过）。
    let width_px = (page.width().value as f64 * scale as f64).round().max(1.0);
    let height_px = (page.height().value as f64 * scale as f64).round().max(1.0);

    // ⚠️ **第一道闸门：碰画布之前**。错误信息里带上"要多少 MB"，运维排障时直接受益（复核第 2 条）。
    check_pixel_budget(width_px, height_px, scale, "渲染前")?;
    let target_width = width_px as i32;
    let target_height = height_px as i32;

    let config = PdfRenderConfig::new()
        .set_target_width(target_width)
        .set_target_height(target_height)
        // 未绘制区域清成**透明**，与 MuPDF 的 `alpha=true` 对齐（理由见 `CLEAR_COLOR_TRANSPARENT`）。
        .set_clear_color(CLEAR_COLOR_TRANSPARENT);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("PDFium 渲染第 {page_index} 页失败：{e}"))?;

    let w = bitmap.width() as usize;
    let h = bitmap.height() as usize;

    // ⚠️ **第二道闸门：渲染之后**（复核第 3 条）。零成本的纵深——
    // 万一 PDFium 返回了比请求更大的位图，内存虽已分配，但**不许再往上传**。
    check_pixel_budget(w as f64, h as f64, scale, "渲染后")?;

    // 这里**不做**通道转换与去填充：`as_rgba_bytes()` 已经输出紧凑 RGBA（模块头第 1 条）。
    let rgba = bitmap.as_rgba_bytes();
    let expect = w * h * 4;
    if rgba.len() != expect {
        // 宁可当场报错，也不把长度不对的位图交给前端（前端按 宽×高×4 校验，会判成"对不上"）。
        return Err(format!(
            "PDFium 返回的位图大小对不上：{} 字节，期望 {expect}（{w}×{h}×4）",
            rgba.len()
        ));
    }
    Ok((rgba, w, h))
}

/// 像素预算闸门：`width × height` 与 `max_page_pixels()` 比较，超了就报出**总量与 MB**。
fn check_pixel_budget(width: f64, height: f64, scale: f32, stage: &str) -> Result<(), String> {
    let pixels = width * height;
    let limit = max_page_pixels() as f64;
    if pixels > limit {
        let need_mb = (pixels * 4.0) / (1024.0 * 1024.0);
        let limit_mb = (limit * 4.0) / (1024.0 * 1024.0);
        return Err(format!(
            "PDFium: {stage}页面像素数 {pixels}（{width}×{height}，scale={scale}）超过上限 {limit}，\
             该页约需 {need_mb:.0} MB 而上限约 {limit_mb:.0} MB"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    /// 本平台的库文件名（`pdfium.dll` / `libpdfium.so` / `libpdfium.dylib`）——
    /// 直接用 crate 自己的命名规则，免得判据里硬写平台分支。
    fn lib_file_name() -> std::ffi::OsString {
        Pdfium::pdfium_platform_library_name_at_path(Path::new("."))
            .file_name()
            .expect("库文件名")
            .to_os_string()
    }

    fn scratch(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("shuyo-pdfium-{tag}-{}", std::process::id()))
    }

    fn dir_with_lib(tag: &str) -> PathBuf {
        let dir = scratch(tag);
        fs::create_dir_all(&dir).expect("建目录");
        fs::write(dir.join(lib_file_name()), b"").expect("写占位库");
        dir
    }

    fn dir_without_lib(tag: &str) -> PathBuf {
        let dir = scratch(tag);
        fs::create_dir_all(&dir).expect("建目录");
        dir
    }

    /// 判据 1：**挑的是"真的有库"的第一个候选**，不是"第一个候选"。
    ///
    /// 这条守的是整个回退链的语义：任一候选目录**存在但没有库**时不许就此返回
    /// （那会让错误信息指向一个空目录，而不是继续找）。
    #[test]
    fn picks_the_first_candidate_that_actually_has_the_library() {
        let empty = dir_without_lib("empty");
        let good = dir_with_lib("good");
        let good2 = dir_with_lib("good2");

        assert_eq!(pick_library_dir(&[empty.clone(), good.clone()]), Some(good.clone()));
        assert_eq!(pick_library_dir(&[good.clone(), good2]), Some(good.clone()));
        assert_eq!(pick_library_dir(&[empty.clone()]), None);
        assert_eq!(pick_library_dir(&[]), None);

        let _ = fs::remove_dir_all(&empty);
        let _ = fs::remove_dir_all(&good);
    }

    /// 判据 2：**打包资源目录必须被探到，且排在 exe 同目录之后**。
    ///
    /// 失败面（这条就是为它写的）：Linux 发行包（deb/AppImage）的资源目录**不是** exe 同目录 ⇒
    /// 少了资源目录这一项，真机上症状是「找不到 PDFium 动态库」，而 Windows 上一切正常。
    #[test]
    fn candidate_order_is_exe_then_resource_then_vendored() {
        let exe = PathBuf::from("/exe");
        let res = PathBuf::from("/res");
        let vend = PathBuf::from("/vend");
        let got = candidate_dirs(Some(exe.clone()), Some(res.clone()), Some(vend.clone()));

        // 非 macOS：exe → 资源目录 → vendored 的三段（vendored 内部还会展开 bin/lib/根）。
        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            got,
            vec![
                exe,
                res,
                vend.join("bin"),
                vend.join("lib"),
                vend.clone()
            ]
        );
        // macOS 多一项 `Contents/Frameworks`，且排在 exe 之前（那是 .app 束的常规位置）。
        #[cfg(target_os = "macos")]
        assert_eq!(got[0], PathBuf::from("/exe/../Frameworks"));

        // 没有资源目录时（例如单测/CLI）不 panic，也不影响其它候选。
        //
        // ⚠️ 这条断言**必须分平台**（2026-09-19 修：它此前只在 macOS 上红，而 Windows 跑不了 `cargo test`、
        // Linux CI 走的是 `not(target_os = "macos")` 那一支 ⇒ 这条红只会在 macOS 上出现，谁也没看见）。
        // macOS 上 `Contents/Frameworks` 是从**可执行文件位置**推导出来的（`.app` 束的常规位置），
        // 与 `resource_dir` 在不在**无关** —— 上面那条 `got[0]` 用的就是同一个推导。
        let only_exe = candidate_dirs(Some(PathBuf::from("/exe")), None, None);
        #[cfg(target_os = "macos")]
        assert_eq!(
            only_exe,
            vec![PathBuf::from("/exe/../Frameworks"), PathBuf::from("/exe")],
            "macOS：`Contents/Frameworks` 与 resource_dir 无关，缺了它 .app 里就找不到库"
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(only_exe, vec![PathBuf::from("/exe")]);
        assert!(candidate_dirs(None, None, None).is_empty());
    }

    /// 判据 3（**承重的那条**）：登记过的资源目录要能被**真正的 `library_dir()`** 用上。
    ///
    /// 为什么必须打到 `library_dir()` 而不是只测 `candidate_dirs`：**接线**（把
    /// `RESOURCE_DIR.get()` 传进候选表）才是这一步的全部内容 —— 变异实测：把传参改成
    /// `None`，判据 2 仍然全绿（它只测纯函数的顺序），**只有本条会红**。
    ///
    /// 失败面：Linux 发行包（deb/AppImage）里库不在 exe 同目录 ⇒ 少了这条接线，
    /// 真机症状是「找不到 PDFium 动态库」。
    #[test]
    fn library_dir_uses_the_registered_resource_dir() {
        // 环境变量优先级最高：它若被设了，本判据的前提就不成立（显式跳过，不假绿也不假红）。
        if std::env::var("SHUYONOTE_PDFIUM_DIR").map(|v| !v.trim().is_empty()).unwrap_or(false) {
            eprintln!("跳过：SHUYONOTE_PDFIUM_DIR 已设，环境变量优先于资源目录");
            return;
        }
        let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()));
        if let Some(d) = &exe_dir {
            if Pdfium::pdfium_platform_library_name_at_path(d).exists() {
                eprintln!("跳过：测试二进制同目录已有库（它排在资源目录之前）");
                return;
            }
        }
        let dir = dir_with_lib("resdir-e2e");
        // 进程级 OnceLock 只能设一次 ⇒ 只有这一条判据调它（其余判据不碰）。
        set_resource_dir(dir.clone());
        assert_eq!(library_dir(), dir.clone(), "资源目录登记后 library_dir() 必须命中它");
        let _ = fs::remove_dir_all(&dir);
    }
}
