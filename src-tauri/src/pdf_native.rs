// M24 desktop-native PDF render engine (MuPDF via mupdf-sys).
//
// Why not the high-level `mupdf` crate? Its safe wrapper currently does not
// compile on `x86_64-pc-windows-msvc` because bindgen does not emit the C
// builtin `max_align_t` on MSVC, and `mupdf::device::native` references it.
// `mupdf-sys` *does* build and link cleanly on Windows, and it exposes a
// convenience C API (`mupdf_*`) that hides MuPDF's `fz_try/fz_catch` longjmp
// mechanism behind an `errptr`. We call that directly, keeping the desktop
// binary self-contained (MuPDF is compiled from source, no binary download),
// and wrap everything in RAII guards with explicit cleanup so nothing leaks.

use mupdf_sys::{
    fz_colorspace, fz_context, fz_device_rgb, fz_document, fz_drop_buffer, fz_drop_document,
    fz_drop_page, fz_drop_pixmap, fz_new_buffer_from_copied_data, fz_page, fz_pixmap,
    fz_pixmap_height, fz_pixmap_samples, fz_pixmap_stride, fz_pixmap_width, fz_scale,
    mupdf_drop_base_context, mupdf_drop_error, mupdf_error_t, mupdf_load_page,
    mupdf_new_base_context, mupdf_open_document_from_bytes, mupdf_page_to_pixmap,
};
use std::ffi::{c_char, CStr};
use std::ptr;

/// Owns the base `fz_context`; dropped last (RAII) so all MuPDF children are
/// freed first. Holds the raw cache pointers across the whole render call.
struct ContextGuard(*mut fz_context);
impl Drop for ContextGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { mupdf_drop_base_context(self.0) }
        }
    }
}

/// Owns a doc + page pair, freeing them on drop even on the happy path.
struct PageCanvas {
    ctx: *mut fz_context,
    doc: *mut fz_document,
    page: *mut fz_page,
    pix: *mut fz_pixmap,
}
impl PageCanvas {
    fn new(ctx: *mut fz_context, doc: *mut fz_document, page: *mut fz_page) -> Self {
        Self { ctx, doc, page, pix: ptr::null_mut() }
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
            if !self.doc.is_null() {
                fz_drop_document(self.ctx, self.doc);
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
/// `data` is the raw PDF bytes; `page_index` is zero-based; `scale` = 100% at
/// 1.0. Returns `(rgba, width, height, stride)`, or an error message. Callers
/// encode the RGBA bytes (e.g. via the `png` crate).
pub unsafe fn render_page(
    data: &[u8],
    page_index: i64,
    scale: f32,
) -> Result<(Vec<u8>, usize, usize, usize), String> {
    let ctx = mupdf_new_base_context();
    if ctx.is_null() {
        return Err("MuPDF: failed to create base context".to_string());
    }
    let _ctx = ContextGuard(ctx);

    // Copy the PDF bytes into a MuPDF-managed buffer; MuPDF owns it afterward.
    let buf = fz_new_buffer_from_copied_data(ctx, data.as_ptr(), data.len());
    if buf.is_null() {
        return Err("MuPDF: failed to allocate buffer".to_string());
    }

    let magic = b"x.pdf\0";
    let mut err: *mut mupdf_error_t = ptr::null_mut();
    let doc = mupdf_open_document_from_bytes(ctx, buf, magic.as_ptr() as *const c_char, &mut err);
    fz_drop_buffer(ctx, buf);
    if doc.is_null() {
        return Err(take_error(err));
    }

    let no = page_index.max(0) as i32;
    let mut page_err: *mut mupdf_error_t = ptr::null_mut();
    let page = mupdf_load_page(ctx, doc, no, &mut page_err);
    if page.is_null() {
        fz_drop_document(ctx, doc);
        return Err(take_error(page_err));
    }

    let mut canvas = PageCanvas::new(ctx, doc, page);
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
