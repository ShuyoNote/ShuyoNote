// ES2024 补齐层 —— **在 Android 的老 WebView 上让 pdf.js 能跑起来**。
//
// 真机实测（2026-09-14，HUAWEI Mate 40 / Android 12 / WebView Chrome **114**）：
// 打开任何 PDF 都显示「这份 PDF 没能打开：**Promise.withResolvers is not a function**」。
//
// 原因是版本错配，不是我们的代码：
//   `Promise.withResolvers` 要 Chrome **119+**（`AbortSignal.any` 要 116+），
//   而这台设备的系统 WebView 停在 114（华为不随 Play 更新）。pdfjs-dist 4.8 在
//   `pdf.mjs` 里用了 32 处 `Promise.withResolvers`，`AbortSignal.any` 也在关键路径上
//   （`PDFDocumentLoadingTask` / `PDFWorker` 的能力对象），worker 里另有 13 处。
//   桌面端 Chrome/Edge 早就支持，所以**这个问题只在老 Android 上出现**——
//   典型的"CI 绿、桌面对、真机死"。
//
// 为什么是补齐而不是降级 pdf.js：pdf.js 的 legacy 构建只转译**语法**，
// 实测同样调用这两个 API（`legacy/build/pdf.mjs` 里也有 33 处），降级救不了。
//
// 为什么放在 `public/`、而不是 `src/`：它有两个消费者，且都**必须早于**模块执行——
//   1. 页面：`index.html` 用一个同步 `<script src>` 引入（在任何 module 之前执行）；
//   2. pdf.js 的 worker：`pdfjs-worker-shim.mjs` 里 `import("./es-polyfills.js")`。
//   放 `src/` 就只有打包器能用，worker 那条路没法共享同一份实现（会变成两份拷贝、必然漂移）。
//
// 写法上刻意保守（`var` + `function`、无箭头函数/模板串）：`public/` 里的文件**不过打包器**，
// 是什么就发什么，所以这里不能依赖转译。
//
// 三条纪律：
//   * **绝不覆盖已有实现**（`typeof x !== "function"` 才装）——现代浏览器上是空操作，
//     免得用我们写的版本盖掉引擎原生实现；
//   * **幂等**：页面脚本与 worker 可能在同一进程里各装一次（pdf.js 的 fake worker 场景）；
//   * **只补真正缺的**：只补 pdf.js（以及我们自己的代码）真的会调到的这两个。
//     以后发现新的，先在这个文件里补，再补一条验收——别在业务代码里散着写兜底。
(function () {
  "use strict";

  var g =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof self !== "undefined"
        ? self
        : this;

  // ---- Promise.withResolvers（ES2024，Chrome 119+）--------------------------------
  // 语义：返回 `{ promise, resolve, reject }`，其中 resolve/reject 就是这个 promise 的
  // 两个函数（同一个引用，按 Promise 语义可反复调用、后到的被忽略）。
  if (typeof g.Promise === "function" && typeof g.Promise.withResolvers !== "function") {
    g.Promise.withResolvers = function withResolvers() {
      var resolve;
      var reject;
      var promise = new g.Promise(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }

  // ---- AbortSignal.any（Chrome 116+）---------------------------------------------
  // 语义：任一输入信号 abort ⇒ 返回的信号以**同一个 reason** abort；空数组 ⇒ 永不 abort。
  // 只需要 `AbortController`（Chrome 66+），所以这条没有别的依赖。
  if (
    typeof g.AbortSignal === "function" &&
    typeof g.AbortController === "function" &&
    typeof g.AbortSignal.any !== "function"
  ) {
    g.AbortSignal.any = function any(signals) {
      var controller = new g.AbortController();
      var list = Array.prototype.slice.call(signals || []);
      var i;
      var abort = function (reason) {
        // abort 自身幂等；这里再判一次是为了不改变已 abort 信号的 reason。
        if (!controller.signal.aborted) controller.abort(reason);
      };
      for (i = 0; i < list.length; i++) {
        var sig = list[i];
        if (sig && sig.aborted) {
          abort(sig.reason);
          return controller.signal;
        }
      }
      for (i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s) continue;
        s.addEventListener(
          "abort",
          function () {
            // `this` 是触发事件的信号；reason 要原样传下去。
            abort(this.reason);
          },
          { once: true },
        );
      }
      return controller.signal;
    };
  }
})();
