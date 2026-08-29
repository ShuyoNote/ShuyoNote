// Copy tesseract.js offline runtime assets from node_modules into public/ocr so
// Vite serves them locally (dev + build) — making OCR fully offline (no jsdelivr CDN):
//   worker.min.js  — tesseract web worker script
//   core/          — tesseract core wasm loaders (+ .wasm companions)
//   tessdata/      — chi_sim + eng traineddata (.gz, best_int = small)
// Run before `vite` (dev/build). public/ocr is gitignored (generated).
import { cpSync, rmSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, realpathSync } from "node:fs";
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

// 2) core wasm loaders + .wasm 同伴：pnpm 把包符号链接化，cpSync 对目录链接会重建链接报 EEXIST，
//    故 realpath 定位真实目录后逐文件复制（同目录内还有 index.js/README 等，无害）。
if (existsSync(coreSrc)) {
  const coreReal = realpathSync(coreSrc);
  for (const f of readdirSync(coreReal)) {
    const p = join(coreReal, f);
    if (statSync(p).isFile()) copyFileSync(p, join(out, "core", f));
  }
}

// 3) traineddata（best_int = 整数量化、体积小；LSTM-only 路径）
for (const lang of ["chi_sim", "eng"]) {
  const s = join(dataSrc, lang, "4.0.0_best_int", `${lang}.traineddata.gz`);
  if (existsSync(s)) copyFileSync(s, join(out, "tessdata", `${lang}.traineddata.gz`));
}

console.log("[copy-tesseract-assets] worker/core/tessdata -> public/ocr");
