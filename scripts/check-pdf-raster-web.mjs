#!/usr/bin/env node
// Web 端「PDF 页 → RGBA」的真机验收（真 Chromium + 真 canvas + **发货代码本身**）。
//
// 为什么需要它：`src/lib/platform/web.ts` 的 `renderPdfPage` 依赖浏览器的 canvas
// （`getContext("2d")` + `getImageData`），happy-dom / Node 里**没有**这套东西 ⇒ 单测覆盖不到。
// 而"在检查脚本里把 pdf.js 的操作序列再抄一遍"只能证明复制品是对的 ⇒ 所以这里让浏览器去
// import **`src/lib/pdfEngine/pdfjsRaster.ts`**（Web 平台层调用的那个核），再判定它的输出。
//
// 判据（4 条，都对应真实踩过的坑）：
//   ① 渲染一页 ⇒ RGBA8、长度**正好** `宽×高×4`（阅读器会再挡这道）、且**非空白像素够多**
//      ——"尺寸对但什么都没画"是这类渲染最阴的失败形态；
//   ② 同一份字节**渲染两次**都要成功 ⇒ pdf.js 会 transfer 传进去的 buffer（本仓 2026-09-15 真踩过）；
//   ③ `scale=NaN` 必须**抛错**，不能画出 NaN 尺寸的画布（WKWebView 会抛、Chrome 静默画成 0×0）；
//   ④ 页码越界/负数必须抛错。
//
// 用法（与 `test:mobile-layout` 同款：**先起 dev server**）：
//   pnpm dev:web                     # 另开一个终端（CI 里由 workflow 后台启动）
//   node scripts/check-pdf-raster-web.mjs
//   APP_URL=http://127.0.0.1:5173/ node scripts/check-pdf-raster-web.mjs   # 端口不同时
// 退出码：0 = 全过；非 0 = 有失败（逐条打印原因）。

import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";

const APP_URL = (process.env.APP_URL || "http://localhost:5173/").replace(/\/+$/, "") + "/";
const PAGE = `${APP_URL}scripts/pdf-raster-check.html`;

async function main() {
  try {
    const r = await fetch(APP_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(
      `web 开发服务不可达：${APP_URL}（${e?.message ?? e}）\n` +
        "请先启动：pnpm dev:web（或设置 APP_URL 指向已运行的服务）。",
    );
    process.exit(2);
  }

  const browser = await launchChrome({ executablePath: findChrome(), headless: true });
  let results = [];
  let fatal = null;
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(PAGE, { waitUntil: "load", timeout: 60_000 });

    const handle = await page
      .waitForFunction(
        () => {
          const t = document.getElementById("out")?.textContent ?? "";
          return t !== "running" ? t : false;
        },
        { timeout: 60_000 },
      )
      .catch(() => null);
    const text = handle ? await handle.jsonValue() : (await page.evaluate(() => document.getElementById("out")?.textContent ?? ""));

    if (typeof text === "string" && text.startsWith("RASTER_CHECKS ")) {
      results = JSON.parse(text.slice("RASTER_CHECKS ".length));
    } else {
      fatal = typeof text === "string" && text.startsWith("RASTER_FATAL") ? text : `页面没有产出结果（最后内容：${String(text).slice(0, 200)}）`;
      if (logs.length > 0) fatal += `\n浏览器日志：\n  ${logs.slice(-8).join("\n  ")}`;
    }
  } finally {
    await browser.close();
  }

  if (fatal) {
    console.error(`[pdf-raster-web] ❌ ${fatal}`);
    process.exit(1);
  }

  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.name}${r.extra ? `  ${JSON.stringify(r.extra)}` : ""}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${r.name}\n      ${r.error}`);
    }
  }
  console.log(`[结果] ${results.length - failed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[pdf-raster-web] 异常：", e?.message ?? e);
  process.exit(1);
});
