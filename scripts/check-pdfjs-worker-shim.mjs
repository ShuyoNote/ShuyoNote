// pdf.js worker 垫片（public/pdfjs-worker-shim.mjs）的**顺序不变量**验收。
//
// 垫片存在的唯一理由：polyfill 必须**早于**真 worker 的模块体执行。而这条遵守起来很脆——
// 把 `await import(real)` 写成顶层 `import "…"`，静态 import 会被**提升**到本文件其余语句
// 之前，polyfill 就落到了后面：代码照样跑、review 看不出来，只有老 WebView 上会死。
//
// 做法：把 `?real=` 指向一个**探针模块**，探针在自己的模块体里就检查 API 在不在，不在就抛。
// 顺序对 ⇒ 探针看到 API 已就位；顺序错（或漏装）⇒ 探针抛错、这里直接红。
// 探针是合成的、不是 pdf.js 真 worker：真 worker 的模块体**不保证**会调这个 API，
// 拿它当探针会假绿。真 worker 另有一条"能 import 成功"的弱断言兜着。
//
// 用法：node scripts/check-pdfjs-worker-shim.mjs
//
// 为什么是独立脚本而不是 vitest 用例：第一版写成 vitest 用例时，垫片里那次动态 import
// 被 vitest 的模块解析接管了（`Cannot find module 'file:///C:/…'`，而同一路径在
// 裸 Node 里好好的）。这类"要真的执行一个文件"的验收，本仓库的既有做法就是独立脚本
// （见 check-pdf-reload.mjs / check-panel-layout.mjs）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shimHref = pathToFileURL(join(root, "public", "pdfjs-worker-shim.mjs")).href;

let pass = 0;
let fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}${extra ? `\n      ${extra}` : ""}`);
  }
};

const nativeWithResolvers = Promise.withResolvers;
const nativeAny = AbortSignal.any;
const nativeLocation = globalThis.location;
const tmp = mkdtempSync(join(tmpdir(), "pdfjs-shim-"));

/**
 * 删掉原生实现（模拟 Chrome 114 那台机器），把 location 指向垫片，再执行垫片。
 *
 * ⚠️ `tag` 不是装饰：垫片里那次 `import("es-polyfills.js?v=…")` 会被 ESM 模块缓存住，
 * 而缓存键是**完整 URL**。同一 tag 跑第二次时 polyfill 模块**不会重新求值**，
 * 于是"刚被删掉的 API"不会有人再装回来——第二条用例就是这么假红过一次
 * （报"缺 Promise.withResolvers"，看着像垫片坏了，其实是用例之间串味）。
 * 每条用例给不同 tag ⇒ 拿到全新的 polyfill 实例，等价于"一个刚起来的 worker 上下文"。
 */
async function runShim(realUrl, tag) {
  delete Promise.withResolvers;
  delete AbortSignal.any;
  const href = `${shimHref}?real=${encodeURIComponent(realUrl)}&v=case-${tag}`;
  globalThis.location = { href };
  // 垫片自身也换查询串：模块缓存会挡住同 URL 的第二次求值。
  return import(`${href}&t=${Math.random()}`);
}

console.log("pdf.js worker 垫片验收（裸 Node；模拟缺 ES2024 API 的老 WebView）");

try {
  // 1) 顺序不变量：探针在**自己的模块体里**看 API 是否已就位。
  const probe = join(tmp, "probe-worker.mjs");
  writeFileSync(
    probe,
    [
      'if (typeof Promise.withResolvers !== "function") {',
      '  throw new Error("真 worker 的模块体里没有 Promise.withResolvers —— 垫片的顺序错了");',
      "}",
      'if (typeof AbortSignal.any !== "function") {',
      '  throw new Error("真 worker 的模块体里没有 AbortSignal.any —— 垫片的顺序错了");',
      "}",
      "const cap = Promise.withResolvers();",
      "cap.resolve(7);",
      "globalThis.__PROBE__ = { value: await cap.promise, anyAborted: AbortSignal.any([]).aborted };",
    ].join("\n"),
    "utf8",
  );
  let probeErr = null;
  try {
    await runShim(pathToFileURL(probe).href, "probe");
  } catch (e) {
    probeErr = e;
  }
  const seen = globalThis.__PROBE__;
  ok(
    !probeErr && seen && seen.value === 7 && seen.anyAborted === false,
    "探针模块在自己的模块体里就看到 Promise.withResolvers / AbortSignal.any（顺序正确）",
    probeErr ? String(probeErr && probeErr.message) : undefined,
  );
  delete globalThis.__PROBE__;

  // 2) 真 worker：在同样的处境下也能 import 成功（垫片没把它带崩）。
  const probeReal = join(tmp, "probe-real-worker.mjs");
  const realWorker = pathToFileURL(join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs")).href;
  writeFileSync(
    probeReal,
    [
      'if (typeof Promise.withResolvers !== "function") throw new Error("缺 Promise.withResolvers");',
      'if (typeof AbortSignal.any !== "function") throw new Error("缺 AbortSignal.any");',
      `await import(${JSON.stringify(realWorker)});`,
      'globalThis.__REAL_WORKER__ = "ok";',
    ].join("\n"),
    "utf8",
  );
  let realErr = null;
  try {
    await runShim(pathToFileURL(probeReal).href, "real");
  } catch (e) {
    realErr = e;
  }
  ok(
    !realErr && globalThis.__REAL_WORKER__ === "ok",
    "真的 pdf.worker.mjs 在这个处境下也能 import 成功",
    realErr ? String(realErr && realErr.message) : undefined,
  );
  delete globalThis.__REAL_WORKER__;

  // 3) 缺 real= 时要给出能看懂的错误，而不是静默什么都不加载。
  delete Promise.withResolvers;
  globalThis.location = { href: `${shimHref}?v=case-missing` };
  let missingErr = null;
  try {
    await import(`${shimHref}?v=case-missing&t=${Math.random()}`);
  } catch (e) {
    missingErr = e;
  }
  ok(
    !!missingErr && /real=/.test(String(missingErr.message)),
    "缺少 real= 参数时报错清晰（提到 real=）",
    missingErr ? String(missingErr.message) : "（居然没报错）",
  );
} finally {
  Promise.withResolvers = nativeWithResolvers;
  AbortSignal.any = nativeAny;
  if (nativeLocation === undefined) delete globalThis.location;
  else globalThis.location = nativeLocation;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
