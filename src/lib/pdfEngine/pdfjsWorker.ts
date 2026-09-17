// pdf.js 的 **worker 配置只有这一处**（此前有三个调用方各自抄了一份，并且已经漂移过）。
//
// 为什么需要它，以及为什么不能各写各的：
//   · pdf.js 在浏览器/WebView 里靠 worker 干活；`GlobalWorkerOptions.workerSrc` 不设，
//     Node/vitest 下会直接报 `Setting up fake worker failed`；
//   · 但**指给谁**是有讲究的：Android 的系统 WebView（那台设备停在 Chrome 114）缺
//     `Promise.withResolvers` / `AbortSignal.any`，而 pdf.js 的 worker 里有 13 处
//     `Promise.withResolvers`（Chrome 119+ 才有）⇒ 所以要**经过我们自己的垫片**
//     （`public/pdfjs-worker-shim.mjs` 在 worker 内部先补一次再动态加载真 worker）；
//   · 垫片与补齐层都是**不带哈希**的静态文件 ⇒ URL 上要挂版本号当缓存失效用；
//   · 而测试环境（vitest 也有 `document`，但没有那个垫片文件，且 Node 的 ESM 加载器只认
//     `file:`/`data:`）必须换成 node_modules 里的 worker 文件。
//
// **已经真实发生过的漂移**：引擎那份带 `v=<APP_VERSION>`，抽取器那份漏了它 ⇒
// 同样的 pdf.js，两条路径的缓存语义不同。抽成一个函数之后，三种情形只在这里判断。
//
// ⚠️ 这里**不 import pdf.js**（参数传入）：`src/lib/platform/web.ts` 必须保持 pdf.js 为
// **动态 import**（阅读器是懒加载它的，静态引入会把 pdf.js 拖进首屏包），
// 而渲染引擎与抽取器都是静态引入 —— 让调用方自己决定加载方式。

import { APP_VERSION } from "../links";

/** pdf.js 模块里我们用得到的那一小块（参数化以便 web.ts 走动态 import）。 */
export interface PdfjsLike {
  GlobalWorkerOptions: { workerSrc?: string };
}

/**
 * 配好 `workerSrc`（幂等）。
 *
 * @param pdfjs 已经 import 进来的 pdf.js 模块（静态或动态都行）
 * @param opts.documentLike 浏览器/WebView 的 `document`（默认取全局；测试里可显式传 undefined）
 */
export function ensurePdfjsWorkerSrc(
  pdfjs: PdfjsLike,
  opts: { documentLike?: Document | null } = {},
): void {
  const doc = "documentLike" in opts ? opts.documentLike : typeof document !== "undefined" ? document : null;
  const viteMode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;

  if (doc && viteMode !== "test") {
    // 浏览器 / Android WebView：经过垫片（理由见文件头）。
    const real = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
    const shim = new URL("pdfjs-worker-shim.mjs", doc.baseURI).href;
    pdfjs.GlobalWorkerOptions.workerSrc = `${shim}?real=${encodeURIComponent(real)}&v=${encodeURIComponent(APP_VERSION)}`;
    return;
  }

  // 测试运行器与非 DOM 环境：直接指 node_modules 里的 worker 文件。
  // 用 `process.cwd()` 而不是 `import.meta.url`：Vite 在测试里会把 `new URL(…)` 解析成 http 资源，
  // 而 Node 的默认 ESM 加载器不接受 http（实测原文：Only URLs with a scheme in: file and data …）。
  const base = typeof process !== "undefined" && process.cwd ? process.cwd() : "";
  pdfjs.GlobalWorkerOptions.workerSrc = `file://${base}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`;
}
