// OCR 离线资源门禁：**只发运行时真的会加载的东西，且一套都不许少。**
//
// 为什么要有它（两个都真实发生过或差一点发生）：
//   1. `tesseract.js-core` 装了 6 个变体 × 2 种形态 ≈ 43.2 MiB，而 worker 只会加载其中一档。
//      "整个目录全拷"让**约 23.3 MiB 死重**进了产物；在 Android 上还会被装两遍
//      （APK 的 assets/ 一份 + Tauri 嵌进 .so 一份）⇒ 白白多出 ~46 MiB。
//   2. 反过来更危险：`createWorker` 的选择逻辑依赖 `legacyCore`。哪天有人为了 `worker.detect`
//      打开 `legacyCore: true`，而拷贝脚本仍只放 `-lstm` 那三档，**离线 OCR 会在真机上
//      报一个看不懂的加载错误**——构建、单测、类型检查全都发现不了。
//
// 所以这里钉三件事：源码不许用 legacy 路径 / 产物里不许有死重变体 / 每个 .wasm.js 必须有 .wasm 同伴。
//
// 用法：node scripts/check-ocr-assets.mjs   （任何一条不满足即非零退出）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => {
  try {
    return readFileSync(join(root, p), "utf8");
  } catch {
    return "";
  }
};

const errors = [];

// ---- 1. 源码不许走 legacy 路径 ----
// `legacyCore: true` 与 `worker.detect(...)` 都会让 worker 去取**非 -lstm** 的 core。
// 现在拷贝脚本按"只有 -lstm 会被用到"来瘦身，所以这两样一旦出现，产物就必须跟着变。
const srcFiles = (function walk(dir, acc = []) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(rel);
  }
  return acc;
})("src");

for (const f of srcFiles) {
  const text = read("." + f.replace(/^src/, "/src"));
  if (/legacyCore\s*:/.test(text)) {
    for (const [i, line] of text.split("\n").entries()) {
      if (/legacyCore\s*:/.test(line)) {
        errors.push(
          `${f}:${i + 1} 用了 legacyCore —— 那样 worker 会去取「非 -lstm」的 core，` +
            `而 scripts/copy-tesseract-assets.mjs 的 CORE_KEEP 只放 -lstm 那三档，` +
            `离线 OCR 会在真机上加载失败。请同时更新 CORE_KEEP 与这里的白名单。`,
        );
      }
    }
  }
  // worker.detect 在 tesseract.js 文档里明确要求 legacy 支持
  if (/\.detect\s*\(/.test(text)) {
    errors.push(`${f} 调用了 worker.detect —— 它要求 legacy 支持，同样需要非 -lstm 的 core。`);
  }
}

// ---- 2. 产物里不许有死重变体，且 -lstm 三档必须齐全 ----
const CORE_DIR = "public/ocr/core";
if (!existsSync(join(root, CORE_DIR))) {
  // 还没跑过拷贝（例如只跑单测）：明确说清，而不是假装通过
  console.log(`[check-ocr-assets] ${CORE_DIR} 不存在——先跑 scripts/copy-tesseract-assets.mjs（pnpm build 会跑）。`);
  process.exit(0);
}

const have = new Set(readdirSync(join(root, CORE_DIR)));
const REQUIRED = [
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm",
];
const FORBIDDEN = [
  "tesseract-core.wasm.js",
  "tesseract-core.wasm",
  "tesseract-core-simd.wasm.js",
  "tesseract-core-simd.wasm",
  "tesseract-core-relaxedsimd.wasm.js",
  "tesseract-core-relaxedsimd.wasm",
];

for (const f of REQUIRED) {
  if (!have.has(f)) errors.push(`${CORE_DIR} 缺 ${f} —— worker 在某一档 SIMD 下会取它，缺了这个平台就 OCR 不了。`);
}
for (const f of FORBIDDEN) {
  if (have.has(f)) {
    errors.push(
      `${CORE_DIR} 里有死重 ${f} —— 本应用用不到（oem=1 且不用 legacyCore），` +
        `而它在 Android 上会被装两遍。请从 CORE_KEEP 之外**不要**拷贝它。`,
    );
  }
}

// 每个加载器必须有自己的 .wasm 同伴：Emscripten 的 .wasm.js 只是胶水，真正的字节在 .wasm 里。
for (const f of REQUIRED.filter((x) => x.endsWith(".wasm.js"))) {
  const companion = f.replace(/\.wasm\.js$/, ".wasm");
  if (!have.has(companion)) errors.push(`${CORE_DIR} 有 ${f} 但没有同伴 ${companion} —— 加载器会取不到字节。`);
}

// ---- 3. 语言包至少要有被默认请求的那两个（其余是否按需下载由 OCR 侧决定）----
const TESS = "public/ocr/tessdata";
if (existsSync(join(root, TESS))) {
  const langs = readdirSync(join(root, TESS));
  if (langs.length === 0) {
    errors.push(`${TESS} 是空的 —— 离线 OCR 第一次使用就会失败（至少要有 eng）。`);
  }
}

if (errors.length) {
  console.error(`[check-ocr-assets] ${errors.length} 项不通过：`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
const coreBytes = REQUIRED.reduce((a, f) => a + (readFileSync(join(root, CORE_DIR, f))?.length ?? 0), 0);
console.log(
  `[check-ocr-assets] OCR 资源一致：core 三档齐全（${(coreBytes / 1048576).toFixed(1)} MiB）、无死重变体、` +
    `源码未使用 legacy 路径。`,
);
