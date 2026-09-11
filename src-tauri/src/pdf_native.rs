// M24 desktop-native PDF render engine (MuPDF via mupdf-sys).
//
// Why not the high-level `mupdf` crate? Its safe wrapper currently does not
// compile on `x86_64-pc-windows-msvc` because bindgen does not emit the C
// builtin `max_align_t` on MSVC, and `mupdf::device::native` references it.
// `mupdf-sys` *does* build and link cleanly on Windows, and it exposes a
// convenience C API (`mupdf_*`) that hides MuPDF's `fz_try/fz_catch` longjmp
// mechanism behind an `errptr`. We call that directly, keeping the desktop
// binary self-contained (MuPDF is compiled from source, no binary download).
//
// Important: the MuPDF base context wraps *process-global* static
// CRITICAL_SECTION mutexes. Re-creating it per render (new_base_context +
// drop_base_context) re-initializes and re-deletes those global locks, which
// is undefined behavior and crashes on Windows (0xc0000005). So we create the
// base context once and cache it for the process lifetime (see shared_context),
// never dropping it. Per-render objects (doc/page/pixmap/buffer) still use
// RAII guards and are freed on time.

use mupdf_sys::{
    fz_buffer, fz_colorspace, fz_context, fz_device_rgb, fz_document, fz_drop_buffer,
    fz_drop_document, fz_drop_page, fz_drop_pixmap, fz_new_buffer_from_copied_data, fz_page,
    fz_pixmap, fz_pixmap_height, fz_pixmap_samples, fz_pixmap_stride, fz_pixmap_width, fz_scale,
    mupdf_drop_error, mupdf_error_t, mupdf_load_page, mupdf_new_base_context,
    mupdf_open_document_from_bytes, mupdf_page_to_pixmap,
};
use std::collections::HashMap;
use std::ffi::{c_char, CStr};
use std::ptr;
use std::sync::{Mutex, OnceLock};

/// Owns the base `fz_context`. The MuPDF base context wraps *global* static
/// CRITICAL_SECTION mutexes; creating and destroying it per render (via
/// `mupdf_new_base_context`/`mupdf_drop_base_context`) re-initializes and
/// re-deletes those global locks, which is undefined behavior and crashes on
/// Windows (access violation). So we create the base context **once** and
/// cache it for the process lifetime, never dropping it (the OS reclaims it
/// at exit). Every render borrows it.
fn shared_context() -> &'static mut fz_context {
    use std::sync::OnceLock;

    // The context is process-global and never freed; we only hand out a
    // mutable borrow for the process lifetime, so this is Send + Sync.
    struct CtxPtr(*mut fz_context);
    unsafe impl Send for CtxPtr {}
    unsafe impl Sync for CtxPtr {}

    static CTX: OnceLock<CtxPtr> = OnceLock::new();
    let ptr = (*CTX.get_or_init(|| CtxPtr(unsafe { mupdf_new_base_context() }))).0;
    assert!(!ptr.is_null(), "MuPDF: failed to create base context");
    // SAFETY: created once, never freed, borrowed for process lifetime.
    unsafe { &mut *ptr }
}

/// A cached, open MuPDF document plus its source buffer. The buffer must
/// outlive the document (its stream reads from it on demand), so they share
/// one lifetime and are dropped together.
struct CachedDocument {
    ctx: *mut fz_context,
    doc: *mut fz_document,
    buffer: *mut fz_buffer,
}
// SAFETY: MuPDF objects are only ever touched while holding `doc_cache()`'s
// Mutex, so handing the raw pointers across threads via the cache is safe.
unsafe impl Send for CachedDocument {}
unsafe impl Sync for CachedDocument {}
impl CachedDocument {
    unsafe fn open(ctx: *mut fz_context, data: &[u8]) -> Result<Self, String> {
        let buf = fz_new_buffer_from_copied_data(ctx, data.as_ptr(), data.len());
        if buf.is_null() {
            return Err("MuPDF: failed to allocate buffer".to_string());
        }
        let magic = b"x.pdf\0";
        let mut err: *mut mupdf_error_t = ptr::null_mut();
        let doc = mupdf_open_document_from_bytes(ctx, buf, magic.as_ptr() as *const c_char, &mut err);
        if doc.is_null() {
            fz_drop_buffer(ctx, buf);
            return Err(take_error(err));
        }
        Ok(Self { ctx, doc, buffer: buf })
    }
}
impl Drop for CachedDocument {
    fn drop(&mut self) {
        unsafe {
            if !self.doc.is_null() {
                fz_drop_document(self.ctx, self.doc);
            }
            // Drop the source buffer last: it must outlive the document.
            if !self.buffer.is_null() {
                fz_drop_buffer(self.ctx, self.buffer);
            }
        }
        // The base context is process-global; do NOT drop it.
    }
}

/// Documents cached by attachment content hash so consecutive `render_pdf_page`
/// calls for the same PDF don't re-open and re-parse the document every time
/// (the dominant cost for large/complex PDFs). MuPDF's `fz_context` is not
/// thread-safe, so we serialize all access behind this lock.
fn doc_cache() -> &'static Mutex<HashMap<String, CachedDocument>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedDocument>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether a document for `cache_key` is already open in the cache. Lets the
/// command layer skip re-reading the PDF bytes from disk on every page render
/// (repeated scans + full-file reads are the dominant cost for large PDFs).
pub fn has_document(cache_key: &str) -> bool {
    doc_cache().lock().map(|c| c.contains_key(cache_key)).unwrap_or(false)
}

/// Owns a page + pixmap for a single render, freeing them on drop. The doc and
/// its source buffer are owned by the process-wide doc cache (`CachedDocument`),
/// which outlives any single render.
struct PageCanvas {
    ctx: *mut fz_context,
    page: *mut fz_page,
    pix: *mut fz_pixmap,
}
impl PageCanvas {
    fn new(ctx: *mut fz_context, page: *mut fz_page) -> Self {
        Self { ctx, page, pix: ptr::null_mut() }
    }
}
impl Drop for PageCanvas {
    fn drop(&mut self) {
        unsafe {
            if !self.pix.is_null() {
                fz_drop_pixmap(self.ctx, self.pix);
            }
            if !self.page.is_null() {
                fz_drop_page(self.ctx, self.page);
            }
        }
    }
}

/// A captured MuPDF error, converted to a Rust `String`.
fn take_error(err: *mut mupdf_error_t) -> String {
    if err.is_null() {
        return "unknown MuPDF error".to_string();
    }
    let message = unsafe {
        let msg = (*err).message;
        if msg.is_null() {
            "unknown MuPDF error".to_string()
        } else {
            CStr::from_ptr(msg).to_string_lossy().into_owned()
        }
    };
    unsafe { mupdf_drop_error(err) };
    message
}

/// Rasterize one PDF page to raw RGBA8 samples using MuPDF.
///
/// `cache_key` identifies the PDF content (e.g. its attachment hash) so the
/// opened document is reused across calls instead of re-parsing every time.
/// `data` is the raw PDF bytes; `page_index` is zero-based; `scale` = 100% at
/// 1.0. Returns `(rgba, width, height, stride)`, or an error message. Callers
/// encode the RGBA bytes (e.g. via the `png` crate).
pub unsafe fn render_page(
    cache_key: &str,
    data: &[u8],
    page_index: i64,
    scale: f32,
) -> Result<(Vec<u8>, usize, usize, usize), String> {
    let ctx = shared_context() as *mut fz_context;

    // Grab (or open once) the cached document under the lock. We hold the lock
    // for the whole render because MuPDF's fz_context isn't thread-safe.
    let mut cache = doc_cache()
        .lock()
        .map_err(|_| "MuPDF: doc cache poisoned".to_string())?;

    if !cache.contains_key(cache_key) {
        let doc = CachedDocument::open(ctx, data)?;
        cache.insert(cache_key.to_string(), doc);
        // Bound the cache: drop least-recently-used-ish (first inserted) if it
        // grows too large, so a session with many PDFs doesn't leak documents.
        if cache.len() > 8 {
            if let Some(k) = cache.keys().next().cloned() {
                cache.remove(&k);
            }
        }
    }
    let cached = cache
        .get(cache_key)
        .ok_or_else(|| "MuPDF: cached doc vanished".to_string())?;
    let doc = cached.doc;

    let no = page_index.max(0) as i32;
    let mut page_err: *mut mupdf_error_t = ptr::null_mut();
    let page = mupdf_load_page(ctx, doc, no, &mut page_err);
    if page.is_null() {
        return Err(take_error(page_err));
    }
    let mut canvas = PageCanvas::new(ctx, page);

    let s = scale.max(0.1);
    let ctm = fz_scale(s, s);
    let rgb: *mut fz_colorspace = fz_device_rgb(ctx);

    let mut pix_err: *mut mupdf_error_t = ptr::null_mut();
    let pix = mupdf_page_to_pixmap(ctx, page, ctm, rgb, true, true, &mut pix_err);
    if pix.is_null() {
        return Err(take_error(pix_err));
    }
    canvas.pix = pix;

    let w = fz_pixmap_width(ctx, pix) as usize;
    let h = fz_pixmap_height(ctx, pix) as usize;
    let stride = fz_pixmap_stride(ctx, pix) as usize;

    // alpha=true ⇒ samples length == stride * h (RGBA8).
    let samples = fz_pixmap_samples(ctx, pix);
    if samples.is_null() {
        return Err("MuPDF: pixmap has no samples".to_string());
    }
    let total = stride * h;
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(std::slice::from_raw_parts(samples, total));

    Ok((out, w, h, stride))
}

/// 把 MuPDF 的行对齐样本压成紧凑 RGBA8（长度恰为 `w × h × 4`）。
///
/// 为什么需要：pixmap 每行可能带对齐填充（`stride ≥ w*4`），而前端按
/// `宽 × 高 × 4` 校验字节数——多一个字节就会被判为"字节数对不上"。
/// 填充必须在 Rust 侧去掉，别把这个差异漏到前端去当谜题。
pub fn compact_rgba(samples: &[u8], w: usize, h: usize, stride: usize) -> Result<Vec<u8>, String> {
    let row = w.checked_mul(4).ok_or_else(|| "MuPDF: 页面宽度溢出".to_string())?;
    let need = stride
        .checked_mul(h)
        .ok_or_else(|| "MuPDF: 页面高度溢出".to_string())?;
    if stride < row {
        return Err(format!("MuPDF: 行跨距 {stride} 小于行宽 {row}"));
    }
    if samples.len() < need {
        return Err(format!(
            "MuPDF: 像素缓冲不足（需要 {need} 字节，实际 {} 字节）",
            samples.len()
        ));
    }
    if stride == row {
        return Ok(samples[..row * h].to_vec());
    }
    let mut out = Vec::with_capacity(row * h);
    for y in 0..h {
        let off = y * stride;
        out.extend_from_slice(&samples[off..off + row]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal 1-page PDF with a Helvetica text line, used to exercise the
    // render path without any external file.
    const MIN_PDF: &[u8] = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (Hello) Tj ET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000010 00000 n \n0000000072 00000 n \n0000000142 00000 n \n0000000244 00000 n \n0000000310 00000 n \ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n364\n%%EOF\n";

    #[test]
    fn render_min_pdf_roundtrip() {
        unsafe {
            let result = render_page("test-min", MIN_PDF, 0, 1.0);
            match result {
                Ok((_, w, h, _)) => assert!((w, h) == (200, 200), "unexpected size ({w}x{h})"),
                Err(e) => panic!("render_page failed: {e}"),
            }
        }
    }

    #[test]
    fn compact_rgba_drops_row_padding() {
        // 2×2 页、行跨距多 4 字节填充：第 2 行从 offset 12 开始。
        let samples: Vec<u8> = vec![
            1, 2, 3, 4, 5, 6, 7, 8, 0xAA, 0xAA, 0xAA, 0xAA, // y=0 (含填充)
            9, 10, 11, 12, 13, 14, 15, 16, 0xAA, 0xAA, 0xAA, 0xAA, // y=1
        ];
        let out = compact_rgba(&samples, 2, 2, 12).expect("compact");
        assert_eq!(out.len(), 2 * 2 * 4);
        assert_eq!(out, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    }

    #[test]
    fn compact_rgba_is_identity_when_stride_matches() {
        let samples: Vec<u8> = (0..16).collect();
        let out = compact_rgba(&samples, 2, 2, 8).expect("compact");
        assert_eq!(out, samples);
    }

    #[test]
    fn compact_rgba_rejects_inconsistent_inputs() {
        assert!(compact_rgba(&[0u8; 16], 2, 2, 4).is_err(), "行跨距小于行宽必须报错");
        assert!(compact_rgba(&[0u8; 15], 2, 2, 8).is_err(), "缓冲不足必须报错");
    }

    /// 真机 PDF 的显式冒烟测试（默认忽略）：一条命令跑完 Rust 侧整条链路——
    /// 取页 → 栅格化 → 压掉行填充 → base64，并打印真实尺寸/体积。
    /// 合成出来的 MIN_PDF 太大路货，真实文件（扫描件、奇怪 MediaBox、非 4 字节
    /// 对齐的 stride）才会暴露问题。用法：
    ///   SHUYONOTE_PDF_FIXTURE=/path/to.pdf cargo test --lib real_pdf -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_pdf_page_renders_and_matches_contract() {
        use base64::Engine as _;
        let Ok(path) = std::env::var("SHUYONOTE_PDF_FIXTURE") else {
            eprintln!("跳过：未设置 SHUYONOTE_PDF_FIXTURE");
            return;
        };
        let data = std::fs::read(&path).expect("读取 PDF 失败");
        unsafe {
            let (rgba, w, h, stride) = render_page("real-fixture", &data, 0, 1.0).expect("渲染第 1 页失败");
            let compact = compact_rgba(&rgba, w, h, stride).expect("压缩像素失败");
            assert_eq!(compact.len(), w * h * 4, "紧凑 RGBA 长度必须是 宽×高×4");
            assert!(compact.iter().any(|b| *b != 0), "渲染结果全零");
            let b64 = base64::engine::general_purpose::STANDARD.encode(&compact);
            let decoded = base64::engine::general_purpose::STANDARD.decode(&b64).expect("base64 解码失败");
            assert_eq!(decoded.len(), w * h * 4);
            eprintln!(
                "第 1 页 {w}×{h}（stride {stride}）→ RGBA {} 字节，base64 {} 字节",
                compact.len(),
                b64.len()
            );
        }
    }

    /// 契约测试：命令层返回的载荷里，base64 解码后必须恰好是 `宽 × 高 × 4` 字节。
    /// 前端就是用这条规则校验的（对不上就报错、不画），所以这里必须有闸门。
    #[test]
    fn compact_page_matches_frontend_contract() {
        use base64::Engine as _;
        unsafe {
            let (rgba, w, h, stride) = render_page("test-min-contract", MIN_PDF, 0, 1.0).expect("render");
            let compact = compact_rgba(&rgba, w, h, stride).expect("compact");
            assert_eq!(compact.len(), w * h * 4);
            let b64 = base64::engine::general_purpose::STANDARD.encode(&compact);
            let decoded = base64::engine::general_purpose::STANDARD.decode(b64).expect("decode");
            assert_eq!(decoded.len(), w * h * 4);
            // 200×200 的页面不能是全零：那说明栅格化"成功"但什么也没画。
            assert!(decoded.iter().any(|b| *b != 0), "渲染结果全零");
        }
    }
}
