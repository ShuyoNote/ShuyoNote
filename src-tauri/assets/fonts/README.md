# 随包字体（Linux/Android 的"非嵌入字体"兜底）

**这个目录里的字体文件不入库**（见根 `.gitignore`）。它由

```bash
node scripts/fetch-font.mjs          # 取回 NotoSansSC-Regular.ttf（OFL-1.1，钉版本 + 核哈希）
node scripts/fetch-font.mjs --check  # 只核对本地那份
```

取到。为什么需要它、以及它在引擎里怎么起作用，见
[`docs/plans/2026-09-20-pdfium-linux-font-backend-workorder.md`](../../../docs/plans/2026-09-20-pdfium-linux-font-backend-workorder.md)：
那份预编译 `libpdfium.so` **没有字体后端**（无 fontconfig）⇒ 非嵌入字体的中文 PDF 在 Linux 上**整行不显示**；
`src-tauri/src/pdfium_native.rs` 会把"**与动态库同一个目录**里的这份字体"装成 `PdfiumCustomFontProvider`。

⚠️ **这个 README 有第二份职责**：`tauri.linux.conf.json` 里那条资源映射是
`"assets/fonts/*": "./"` —— 它**必须至少匹配到一个文件**，否则 tauri 会在构建期直接报
`glob pattern assets/fonts/* path not found or didn't match any files.`（本机实测：缺目录时 `cargo check` 就红）。
所以这个占位文件**不要删**：没有它，任何"还没取字体"的机器（新克隆、CI 的别的 job）**连编译都过不去**。
