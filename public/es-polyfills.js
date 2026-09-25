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

  // ---- Object.hasOwn（ES2022，Chrome 93+）-----------------------------------------
  // 语义：只判**自有**属性（不走原型链）；`__proto__` 按普通键处理。
  if (typeof g.Object.hasOwn !== "function") {
    g.Object.hasOwn = function hasOwn(obj, key) {
      if (obj === null || obj === undefined) {
        throw new g.TypeError("Cannot convert undefined or null to object");
      }
      return g.Object.prototype.hasOwnProperty.call(g.Object(obj), key);
    };
  }

  // ---- String.prototype.replaceAll（Chrome 85+）-----------------------------------
  // 语义：字符串 needle 逐字面量全局替换；正则必须带 `g`，否则抛 TypeError。
  // 实现上刻意**借引擎自己的 `replace`**（把 needle 转义后做成全局正则）——
  // 这样 `$&`/`$$` 那套替换模式与"函数替换"的参数语义都由引擎给，不用我手写一份可能不准的。
  if (typeof g.String.prototype.replaceAll !== "function") {
    g.String.prototype.replaceAll = function replaceAll(searchValue, replaceValue) {
      if (searchValue instanceof g.RegExp) {
        if (!searchValue.global) {
          throw new g.TypeError("replaceAll must be called with a global RegExp");
        }
        return this.replace(searchValue, replaceValue);
      }
      var escaped = g.String(searchValue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return g.String(this).replace(new g.RegExp(escaped, "g"), replaceValue);
    };
  }

  // ---- Array.prototype.at / String.prototype.at（Chrome 92+）----------------------
  if (typeof g.Array.prototype.at !== "function") {
    g.Array.prototype.at = function at(n) {
      var len = this.length >>> 0;
      var i = Math.trunc(Number(n)) || 0;
      if (i < 0) i += len;
      return i < 0 || i >= len ? undefined : this[i];
    };
  }
  if (typeof g.String.prototype.at !== "function") {
    g.String.prototype.at = function at(n) {
      var s = g.String(this);
      var i = Math.trunc(Number(n)) || 0;
      if (i < 0) i += s.length;
      return i < 0 || i >= s.length ? undefined : s.charAt(i);
    };
  }

  // ---- Array.prototype.findLast / findLastIndex（Chrome 97+）----------------------
  if (typeof g.Array.prototype.findLast !== "function") {
    g.Array.prototype.findLast = function findLast(pred, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (pred.call(thisArg, this[i], i, this)) return this[i];
      }
      return undefined;
    };
  }
  if (typeof g.Array.prototype.findLastIndex !== "function") {
    g.Array.prototype.findLastIndex = function findLastIndex(pred, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (pred.call(thisArg, this[i], i, this)) return i;
      }
      return -1;
    };
  }

  // ---- crypto.randomUUID（Chrome 92+）--------------------------------------------
  // 语义：RFC 4122 v4（版本位/变体位按规范置好），随机性来自 `getRandomValues`（Chrome 11+）。
  if (
    g.crypto &&
    typeof g.crypto.randomUUID !== "function" &&
    typeof g.crypto.getRandomValues === "function"
  ) {
    g.crypto.randomUUID = function randomUUID() {
      var b = new g.Uint8Array(16);
      g.crypto.getRandomValues(b);
      b[6] = (b[6] & 15) | 64;
      b[8] = (b[8] & 63) | 128;
      var hex = [];
      for (var i = 0; i < 16; i++) hex.push((b[i] + 256).toString(16).slice(1));
      return (
        hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" +
        hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" +
        hex.slice(10, 16).join("")
      );
    };
  }

  // ---- structuredClone（Chrome 98+）-----------------------------------------------
  // ⚠️ **降级实现**（如实写在这里，别当成完整语义）：支持基本类型 / Array / 普通对象 /
  //    Date / RegExp / Map / Set / ArrayBuffer / TypedArray / DataView，并**处理循环引用**；
  //    **不支持** `transfer`、类实例的原型保留（会退化成普通对象）、以及 Blob/File 等宿主对象。
  //    够依赖用来克隆配置对象；凡是要靠"真 structuredClone"语义的地方，应当在业务侧换写法。
  if (typeof g.structuredClone !== "function") {
    g.structuredClone = function structuredClone(value) {
      var seen = new g.Map();
      var clone = function (v) {
        if (v === null || typeof v !== "object") return v;
        if (seen.has(v)) return seen.get(v);
        if (v instanceof g.Date) return new g.Date(v.getTime());
        if (v instanceof g.RegExp) return new g.RegExp(v.source, v.flags);
        if (typeof g.Map === "function" && v instanceof g.Map) {
          var m = new g.Map();
          seen.set(v, m);
          v.forEach(function (val, k) {
            m.set(clone(k), clone(val));
          });
          return m;
        }
        if (typeof g.Set === "function" && v instanceof g.Set) {
          var st = new g.Set();
          seen.set(v, st);
          v.forEach(function (val) {
            st.add(clone(val));
          });
          return st;
        }
        if (typeof g.ArrayBuffer === "function" && v instanceof g.ArrayBuffer) {
          return v.slice(0);
        }
        if (typeof g.ArrayBuffer === "function" && g.ArrayBuffer.isView(v)) {
          if (typeof g.DataView === "function" && v instanceof g.DataView) {
            return new g.DataView(clone(v.buffer), v.byteOffset, v.byteLength);
          }
          return new v.constructor(v);
        }
        if (g.Array.isArray(v)) {
          var arr = [];
          seen.set(v, arr);
          for (var i = 0; i < v.length; i++) arr[i] = clone(v[i]);
          return arr;
        }
        var obj = {};
        seen.set(v, obj);
        var keys = g.Object.keys(v);
        for (var k = 0; k < keys.length; k++) obj[keys[k]] = clone(v[keys[k]]);
        return obj;
      };
      return clone(value);
    };
  }

  // ---- ParentNode.replaceChildren（Chrome 86+）------------------------------------
  // 语义：清空子节点，再把参数（节点或**字符串**，字符串变文本节点）依次放进去。
  var installReplaceChildren = function (proto) {
    if (!proto || typeof proto.replaceChildren === "function") return;
    proto.replaceChildren = function replaceChildren() {
      var doc = this.ownerDocument || g.document;
      this.textContent = "";
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        if (n === null || n === undefined) continue;
        this.appendChild(
          typeof n === "string" ? doc.createTextNode(n) : n
        );
      }
    };
  };
  if (typeof g.Element === "function") installReplaceChildren(g.Element.prototype);
  if (typeof g.Document === "function") installReplaceChildren(g.Document.prototype);
  if (typeof g.DocumentFragment === "function") installReplaceChildren(g.DocumentFragment.prototype);

  // ---- reportError（Chrome 95+）---------------------------------------------------
  // 语义：把错误交给**全局**错误处理，不向调用方抛出。
  // DOM 环境里"全局那条路"就是 **error 事件**（`window.onerror` 挂在它上面），所以优先派发它；
  // 没有 DOM 的宿主（纯 Node / worker 早期形态）退回"0ms 后抛出"，交给宿主的未捕获异常通道。
  if (typeof g.reportError !== "function") {
    g.reportError = function reportError(error) {
      var target = g.window || (typeof g.dispatchEvent === "function" ? g : null);
      if (target && typeof g.ErrorEvent === "function") {
        target.dispatchEvent(
          new g.ErrorEvent("error", {
            error: error,
            message: error && error.message ? g.String(error.message) : g.String(error),
          }),
        );
        return;
      }
      g.setTimeout(function () {
        throw error;
      }, 0);
    };
  }

  // ---- Intl.Segmenter（Chrome 87+）------------------------------------------------
  // ⚠️ **降级实现**：按**码点**切，不按字素簇 —— emoji 组合、变音记号会被切开。
  //    只保证"调用不抛错、形状对（可迭代，每项有 segment/index/input）"；
  //    凡是"按用户可见字符计数/截断"的地方，在旧 WebView 上会偏。
  if (typeof g.Intl === "object" && typeof g.Intl.Segmenter !== "function") {
    g.Intl.Segmenter = function Segmenter(locale, options) {
      var granularity = (options && options.granularity) || "grapheme";
      this.resolvedOptions = function resolvedOptions() {
        return { locale: g.String(locale || "en"), granularity: granularity };
      };
      this.segment = function segment(input) {
        var str = g.String(input);
        var out = [];
        var idx = 0;
        var chars = g.Array.from(str);
        for (var i = 0; i < chars.length; i++) {
          out.push({
            segment: chars[i],
            index: idx,
            input: str,
            isWordLike: granularity === "word" ? /\S/.test(chars[i]) : undefined,
          });
          idx += chars[i].length;
        }
        return out;
      };
    };
  }
})();
