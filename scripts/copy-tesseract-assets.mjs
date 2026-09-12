// Copy tesseract.js offline runtime assets from node_modules into public/ocr so
// Vite serves them locally (dev + build) — making OCR fully offline (no jsdelivr CDN):
//   worker.min.js  — tesseract web worker script
//   core/          — tesseract core wasm loaders (+ .wasm companions)
//   tessdata/      — chi_sim + eng traineddata (.gz, best_int = small)
// Run before `vite` (dev/build). public/ocr is gitignored (generated).
import { rmSync, mkdirSync, existsSync, copyFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const out = join(root, "public", "ocr");

const workerSrc = join(root, "node_modules", "tesseract.js", "dist", "worker.min.js");
const coreSrc = join(root, "node_modules", "tesseract.js-core");
const dataSrc = join(root, "node_modules", "@tesseract.js-data");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "tessdata"), { recursive: true });

// 1) worker script (copyFileSync 会跟随 pnpm 符号链接解引用)
if (existsSync(workerSrc)) copyFileSync(workerSrc, join(out, "worker.min.js"));

// 2) core wasm loaders + .wasm 同伴。
//
// ⚠️ **只拷运行时真的会加载的那几档**（2026-09-13 改）。原先这里是"整个目录全拷"，
//    而 tesseract.js-core 装了 6 个变体 × 2 种形态 ≈ 43.2 MiB，其中大部分永远用不到。
//
//    依据是 tesseract.js 7.0.0 的 worker 选择逻辑（worker.min.js 里那一行）：
//      relaxedsimd 支持 ? (legacyCore ? "-relaxedsimd-lstm" : "-relaxedsimd")
//      : simd 支持      ? (legacyCore ? "-simd-lstm"       : "-simd")
//                       : (legacyCore ? "-lstm"            : "")
//    我们调的是 `createWorker(langs, 1, …)`（oem=1 纯 LSTM），且**从不设 `legacyCore`**，
//    也不用 `worker.detect`（那是唯一需要 legacy 支持的地方）⇒ 只会走 `-lstm` 那三档。
//
//    所以三个非 `-lstm` 变体（3 个 .wasm.js + 3 个 .wasm ≈ **23.3 MiB**）是死重，
//    而且它们在 Android 上还会被**装两遍**（APK 的 assets/ 一份 + Tauri 嵌进 .so 一份）。
//
//    **将来若要用 `legacyCore` / `worker.detect`，必须同时改这里**——
//    `scripts/check-ocr-assets.mjs` 会拦住忘记改的那一次（它是硬失败，不是警告）。
const CORE_KEEP = [
  // LSTM-only 三档：relaxedsimd（新 WebView）/ simd / 纯标量（老 WebView 兜底）
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-lstm.wasm",
  // 许可与来源说明：随产物一起分发（体积可忽略，但不该省）
  "LICENSE",
  "README.md",
];
if (existsSync(coreSrc)) {
  const coreReal = realpathSync(coreSrc);
  const available = new Set(readdirSync(coreReal));
  const missing = CORE_KEEP.filter((f) => !available.has(f));
  if (missing.length) {
    // 不静默：tesseract.js-core 升版后文件名若变了，这里必须炸，而不是打出一个缺文件的包
    throw new Error(
      `[copy-tesseract-assets] tesseract.js-core 里找不到这些文件：${missing.join(", ")}\n` +
        `  可能升级后改名了——请对照 worker.min.js 里的 core 选择逻辑更新 CORE_KEEP。`,
    );
  }
  for (const f of CORE_KEEP) copyFileSync(join(coreReal, f), join(out, "core", f));
}

// 3) 语言包（traineddata）——**默认不拷**（2026-09-13 改）。
//
// 为什么不打进包：两个语言包共 **29.6 MiB**，而 Android 上它们会被**装两遍**
// （APK 的 `assets/` 一份 + `.so` 里 Tauri 内嵌的前端副本一份，实测见
// docs/plans/2026-09-13-android-launch-plan.md §3）。改为运行时按需下载
// （来源见 src/lib/ocr.ts 的 DEFAULT_OCR_LANG_BASE，托管规矩见 docs/nginx-ocr.conf）：
// **首次用 OCR 联网一次，之后由 tesseract 的 IndexedDB 缓存复用 ⇒ 永久离线可用**。
//
// 仍然需要随包分发的发行版（自托管 / 完全离线）：
//     SHUYONOTE_OCR_BUNDLE=1 pnpm build
//   并同时设 `VITE_TESSERACT_LANG_PATH=/ocr/tessdata`，让运行时指向本地那份。
//   （两者必须一起设；check-ocr-assets 会拦住只设一半的情况。）
//
// 注意模型的**完整版**不能换回 `4.0.0_best_int`：那是量化版、体积小，但在
// tesseract.js-core v7 的 worker 里会「Failed loading language」导致识别为空（踩过）。
const BUNDLE = process.env.SHUYONOTE_OCR_BUNDLE === "1";
if (BUNDLE) {
  for (const lang of ["chi_sim", "eng"]) {
    const s = join(dataSrc, lang, "4.0.0", `${lang}.traineddata.gz`);
    if (existsSync(s)) copyFileSync(s, join(out, "tessdata", `${lang}.traineddata.gz`));
  }
  console.log("[copy-tesseract-assets] SHUYONOTE_OCR_BUNDLE=1 → 语言包已随包拷贝");
} else {
  // 留一个空目录会让 check-ocr-assets 误判为"打包了但缺文件"，直接删掉更干净
  rmSync(join(out, "tessdata"), { recursive: true, force: true });
  console.log("[copy-tesseract-assets] 语言包不随包分发（运行时按需下载 + 缓存）");
}

console.log("[copy-tesseract-assets] worker/core -> public/ocr");
