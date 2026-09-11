// PDF "第二次加载必然失败"验收 · 用真实浏览器 + **真实的引擎代码**证明这条机制。
//
// 背景（2026-09-11 用户报"这份 PDF 没能打开 / The object can not be cloned."）：
// pdf.js 的 `getDocument` 会**接管（transfer）你传进去的 ArrayBuffer**——
// pdf.mjs 里就是 `sendWithPromise("GetDocRequest", docParams, data ? [data.buffer] : null)`。
// 传过一次，那个 buffer 就 detached 了。而开发模式开着 React StrictMode，effect 会
// "挂载 → 清理 → 再挂载"，`[open, bytes]` 这个 effect 于是拿**同一个** `bytes` 对象
// 跑两遍：第二次交出去的是一块已经 detach 的 buffer，WebKit 直接抛
// DataCloneError("The object can not be cloned.")，界面就成了"这份 PDF 没能打开"。
//
// 这个脚本把机制钉住（而不是凭印象解释）：
//   1. 同一份 bytes 连喂两次 → 第一次成功、**原 bytes 被 detach（长度变 0）**、
//      第二次以 DataCloneError 失败；
//   2. 阅读器现在的写法（每次交给 pdf.js 一份私有副本）→ 连着加载两次都成功，
//      调用方手里的 bytes 始终完好。
// 第 1 条若哪天不成立了（pdf.js 不再接管 buffer），这个脚本会红——那时注释与
// `createPdfjsEngine.loadPdf` 里的拷贝就该重新评估，而不是留着一段过期的解释。
//
// 用法：node scripts/check-pdf-reload.mjs

import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjsDir = join(root, "node_modules", "pdfjs-dist");

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};

function findChrome() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cache)) {
    for (const ver of readdirSync(cache)) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux64/chrome",
      ]) {
        const p = join(cache, ver, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error("找不到 Chrome/Chromium（可用 PUPPETEER_EXECUTABLE_PATH 指定）");
  process.exit(2);
}
if (!existsSync(join(pdfjsDir, "build", "pdf.mjs"))) {
  console.error("找不到 node_modules/pdfjs-dist/build/pdf.mjs —— 先装依赖");
  process.exit(2);
}

// 1) 把真实引擎打包成浏览器可直接 import 的 ESM。
//    用 esbuild（而不是 vite build）是有意的：vite 会把
//    `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` 内联成 data: URL，
//    而引擎会在其后拼 `?v=<版本>` 做缓存失效——data: URL 加查询串就再也 import 不动了，
//    pdf.js 于是退到"fake worker"再失败。真实构建里它是独立资源文件，esbuild 也原样保留
//    这个 URL 表达式，跟真实构建一致。
const tmp = mkdtempSync(join(tmpdir(), "pdf-reload-"));
// esbuild 是 vite 的依赖（pnpm 下不从项目根可解析），所以经 vite 的 package.json 找它。
const vitePkg = readdirSync(join(root, "node_modules", ".pnpm")).find((d) => d.startsWith("vite@"));
const require = createRequire(join(root, "node_modules", ".pnpm", vitePkg, "node_modules", "vite", "package.json"));
const esbuild = require(require.resolve("esbuild"));
const built = await esbuild.build({
  entryPoints: [join(root, "src", "lib", "pdfEngine", "pdfjsEngine.ts")],
  bundle: true,
  format: "esm",
  target: "esnext",
  logLevel: "error",
  external: ["pdfjs-dist"],
  write: false,
});
// pdfjs-dist 外置后，把裸模块名换成我们自己的静态路径（浏览器只认 URL）
writeFileSync(join(tmp, "engine.mjs"), built.outputFiles[0].text.replace(/(["'])pdfjs-dist\1/g, '"/pdf.mjs"'));

// 2) 造一份 3 页的真实 PDF 当夹具（不往仓库里塞二进制）
const { PDFDocument } = await import("pdf-lib");
const doc = await PDFDocument.create();
for (let i = 0; i < 3; i++) doc.addPage([300, 400]);
const fixture = Buffer.from(await doc.save());

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>pdf reload</title></head>
<body><p id="status">running</p></body></html>`;

const MIME = { ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".pdf": "application/pdf", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const send = (body, type) => {
    res.writeHead(200, { "content-type": type, "content-length": body.length });
    res.end(body);
  };
  if (path === "/" || path === "/index.html") return send(Buffer.from(html, "utf8"), "text/html; charset=utf-8");
  if (path === "/fixture.pdf") return send(fixture, MIME[".pdf"]);
  if (path === "/pdf.mjs") return send(readFileSync(join(pdfjsDir, "build", "pdf.mjs")), MIME[".mjs"]);
  const rel = path.replace(/^\//, "");
  // 构建产物（engine.mjs 与它旁边的 worker 资源）
  const built = join(tmp, rel);
  if (rel && existsSync(built) && !rel.includes("..")) return send(readFileSync(built), MIME[extname(built)] ?? MIME[".mjs"]);
  // 引擎里 `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` 仍按包布局取
  if (rel.startsWith("pdfjs-dist/")) {
    const file = join(root, "node_modules", rel);
    if (existsSync(file) && !file.includes("..")) return send(readFileSync(file), MIME[".mjs"]);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const puppeteer = (await import("puppeteer-core")).default;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });
console.log("PDF 重复加载验收（真实 Chromium + 真实 pdfjsEngine）");

try {
  await page.goto(url, { waitUntil: "load" });
  const r = await page.evaluate(async () => {
    const { createPdfjsEngine } = await import("/engine.mjs");
    const pdfjs = await import("/pdf.mjs");
    const fetchBytes = async () => new Uint8Array(await (await fetch("/fixture.pdf")).arrayBuffer());
    const out = {};

    // A. 机制：直接问 pdf.js 要两次同一份 buffer —— 证明"pdf.js 会接管 buffer"
    //    （即引擎里那份拷贝不是多余的一步，而是必须的）
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs-dist/build/pdf.worker.min.mjs";
    const rawBytes = await fetchBytes();
    out.rawLength = rawBytes.byteLength;
    await pdfjs.getDocument({ data: rawBytes }).promise;
    out.rawLengthAfterFirst = rawBytes.byteLength; // 被接管 ⇒ 0
    try {
      await pdfjs.getDocument({ data: rawBytes }).promise;
    } catch (e) {
      out.rawSecondError = `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    }

    // B. 阅读器的真实处境：同一份 store bytes 连着加载两次（React StrictMode 的
    //    "挂载 → 清理 → 再挂载"就是这个形状）。引擎必须自己消化掉这件事。
    const store = await fetchBytes();
    out.storeLength = store.byteLength;
    const first = await createPdfjsEngine().loadPdf(store);
    const second = await createPdfjsEngine().loadPdf(store);
    out.pages = [first.pageCount, second.pageCount];
    out.storeLengthAfter = store.byteLength;
    return out;
  });

  ok(
    r.rawLengthAfterFirst === 0,
    `pdf.js 会接管传入的 buffer：加载后调用方长度 ${r.rawLengthAfterFirst}（应为 0）`,
  );
  ok(
    typeof r.rawSecondError === "string" && /clon/i.test(r.rawSecondError),
    `直接调 pdf.js 传两次同一份 buffer 会失败，且是克隆错误：${r.rawSecondError ?? "（竟然成功了）"}`,
  );
  ok(
    r.pages?.[0] === 3 && r.pages?.[1] === 3,
    `引擎连续两次加载同一份 bytes 都成功（${r.pages?.join(" / ")} 页）—— StrictMode 下这是常态`,
  );
  ok(r.storeLengthAfter === r.storeLength, `调用方手里的 bytes 始终完好（${r.storeLengthAfter} 字节）`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
