// pdf.js worker 的**前置垫片**：先补齐老 WebView 缺的 ES2024 API，再加载真正的 worker。
//
// 为什么需要它（真机证据）：Mate 40 / Android 12 的系统 WebView 停在 Chrome **114**，
// 而 pdfjs-dist 4.8 的 worker（`pdf.worker.mjs`）里用了 13 处 `Promise.withResolvers`
// （Chrome 119+）。页面那半边由 `index.html` 里的 `es-polyfills.js` 补齐，
// **worker 是另一个 JS 上下文，页面上的 polyfill 到不了它**——只能由这个垫片在
// worker 内部先补一次。同一个进程里补两次没关系：polyfill 本身幂等、且不覆盖已有实现。
//
// 用法（由 `src/lib/pdfEngine/pdfjsEngine.ts` 拼 URL）：
//   /pdfjs-worker-shim.mjs?real=<真正 worker 的绝对 URL>&v=<应用版本>
//
// 几个必须守住的点：
//   * 真 worker **必须动态 import**：静态 import 会被提升到本文件其余语句之前执行，
//     polyfill 就落在了 worker 代码后面——等于没装，白改。
//   * 这里用**顶层 await**：pdf.js 是用 `new Worker(url, { type: "module" })` 建这个文件的
//     （`pdf.mjs::PDFWorker#_initialize`），模块 worker 支持它。
//   * worker 出错时 pdf.js 会自己退到"fake worker"（在主线程跑 worker 代码）。
//     那条路上页面侧的 polyfill 是装好的，所以**即便这个垫片挂了，PDF 也还能打开**——
//     只是退回单线程。这层兜底不该被当成本垫片可选的借口：它慢，且只在"worker 尚未 ready
//     就抛错"时触发。
//   * 相对路径按**本文件所在目录**解析，所以部署在 `/app/` 子路径下也没问题。

const here = new URL(location.href);
const real = here.searchParams.get("real");
const ver = here.searchParams.get("v") || "";
if (!real) {
  throw new Error("pdfjs-worker-shim: 缺少 real= 参数（真正 worker 的 URL）");
}

// 1) 先补 API（同一个 origin，路径相对本文件）。
await import(new URL("es-polyfills.js" + (ver ? "?v=" + ver : ""), here).href);

// 2) 再加载真正的 worker：它的模块体一执行就会用到那些 API。
await import(real);
