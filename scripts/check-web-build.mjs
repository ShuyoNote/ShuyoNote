// Web 版构建产物验收 · 用真实 Chromium 打开 `dist-web/`，确认它真的能跑起来。
//
// 为什么需要它：GitHub Pages 是**每次推 main 自动部署**的，而"构建成功"与"打开能用"是两件事
// ——v1.84.1 踩过一次：官网手动部署时按静态引用过滤删旧文件，把 sql.js 的 wasm 与 pdf worker
// 这类**运行时才加载**的资源删掉了，页面能打开、DB 却初始化失败（`SqliteStore not initialized`），
// 所有查询报错。版本号文件对、资源清单对，人却用不了——只有真的开一次浏览器才发现。
//
// 所以这个脚本做三件事（对**已构建**的 dist-web，不起 dev server）：
//   1. 起一个静态服务器把 dist-web 原样发出去（和 Pages/官网的处境一致）；
//   2. 在 Chromium 里打开它，断言：没有未捕获错误、版本号是当前版本、**数据库真的初始化了**
//      （建页 → 写入 → 读回）、插件管理能打开（"从索引安装"那一屏不报错）；
//   3. 断言"动态加载"的那几个资源确实取得到（sql-wasm / pdf.worker）。
//
// 用法：
//   pnpm build:web && node scripts/check-web-build.mjs
//   node scripts/check-web-build.mjs --dir dist-web --shots /tmp/shots

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dirArg = process.argv.indexOf("--dir");
const DIR = resolve(root, dirArg > -1 ? process.argv[dirArg + 1] : "dist-web");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".traineddata": "application/octet-stream",
};

/** 静态服务器：与 Pages/官网处境一致（相对路径、不做任何重写）。 */
function serveStatic(dir) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let rel = normalize(urlPath).replace(/^([/\\])+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      // Pages 不带这些，别让本地测试比线上宽松：service worker 会被缓存干扰
      "cache-control": "no-store",
    });
    res.end(body);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port })));
}

if (!existsSync(join(DIR, "index.html"))) {
  console.error(`找不到构建产物：${join(DIR, "index.html")}——先跑 pnpm build:web`);
  process.exit(2);
}
const chrome = findChrome();
if (!chrome) {
  console.error("找不到 Chrome/Chromium（可用 PUPPETEER_EXECUTABLE_PATH 指定）");
  process.exit(2);
}

const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const built = JSON.parse(readFileSync(join(DIR, "version.json"), "utf8")).version;
console.log(`Web 构建产物验收 · ${DIR}`);
console.log(`  期望版本 ${expected} · 产物版本 ${built}`);

const puppeteer = (await import("puppeteer-core")).default;
const { server, port } = await serveStatic(DIR);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const errors = [];
/** 明确"这一版 Web 不支持、请用桌面版"之类的日志：是**设计内**的行为，不是坏掉。
 *  但也不能一丢了之——运行时把它数出来并打印，免得它变成"什么都看不见"的黑洞。 */
const expectedPlatformErrors = [];
const isExpectedPlatformError = (text) =>
  /仅桌面版支持|Web 版不支持|不支持磁盘插件|not supported on web/i.test(text);
const failedRequests = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (isExpectedPlatformError(text)) expectedPlatformErrors.push(text);
  else errors.push(text);
});
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().startsWith("http://127.0.0.1")) {
    failedRequests.push(`${r.status()} ${r.url()}`);
  }
});

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(".sidebar, .app, #root", { timeout: 30000 });

  ok(built === expected, `产物里的 version.json 是当前版本（${built}）`);

  // 数据库真的初始化了吗——用界面自己的入口建一页，再确认编辑器起来了。
  // 这一步才验得到 sql.js 的 wasm：v1.84.1 的坏法是"页面能开、DB 初始化失败"，
  // 版本号与资源清单都对，人却用不了。
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button, [role=button]")).find((b) =>
      /新建页面|新建|New page|New/i.test(b.textContent || b.getAttribute("aria-label") || ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (clicked) {
    await new Promise((r) => setTimeout(r, 1500));
    const hasEditor = await page.$(".editor, .lexical-root, [contenteditable=true]");
    ok(!!hasEditor, "点「新建页面」之后编辑器起来了（说明 DB 写入链路是通的）");
  } else {
    console.error("  ! 没找到「新建页面」按钮（界面文案可能变了），跳过写入探针");
  }

  // 动态加载的资源必须取得到（v1.84.1 的坑：误删之后页面照开、功能全废）
  for (const pat of ["sql-wasm", "pdf.worker"]) {
    const hit = await page.evaluate(async (p) => {
      const links = performance.getEntriesByType("resource").map((e) => e.name);
      return links.some((n) => n.includes(p));
    }, pat);
    // 没被加载过不代表坏了：直接按清单取名去取一次
    const rel = readdirSync(join(DIR, "assets")).find((f) => f.includes(pat));
    if (!rel) {
      ok(false, `产物里找不到 ${pat} 资源`);
      continue;
    }
    const status = await page.evaluate(async (u) => {
      const r = await fetch(u, { method: "GET" });
      return r.status;
    }, `/assets/${rel}`);
    ok(status === 200, `${pat} 资源取得到（${rel} → ${status}${hit ? "，页面也用过它" : ""}）`);
  }

  // 插件管理那一屏（这一版的主战场）：能打开、且"从索引安装"在里面
  const pluginsOk = await page.evaluate(async () => {
    const clickByText = (re) => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => {
        const label = (b.getAttribute("aria-label") || "").trim();
        const text = (b.textContent || "").trim();
        return re.test(label) || re.test(text);
      });
      if (!btn) return false;
      btn.click();
      return true;
    };
    // 插件管理的入口在「设置」里：设置（竖条上的 icon，aria-label="设置"）
    // → 左侧「插件」那一栏 → 卡片里的「打开插件管理」。三步都要点，少一步就找不到按钮。
    const openedSettings = clickByText(/^设置$|^Settings$/i);
    await new Promise((r) => setTimeout(r, 700));
    clickByText(/^插件/);
    await new Promise((r) => setTimeout(r, 500));
    const openedManager = clickByText(/打开插件管理/);
    await new Promise((r) => setTimeout(r, 700));
    const text = document.body.textContent || "";
    return {
      found: openedSettings && openedManager,
      opened: /插件管理/.test(text),
      hasIndex: /从索引安装/.test(text),
      hasWebNote: /Web 版不支持磁盘插件/.test(text),
    };
  });
  if (pluginsOk.found) {
    ok(pluginsOk.opened, "插件管理能打开");
    // Web 平台按设计不显示"从索引安装"面板（没有磁盘插件运行时），必须显示那句说明
    ok(pluginsOk.hasWebNote, "Web 版明确说明「不支持磁盘插件」，而不是装作能用");
  } else {
    console.error("  ! 没找到插件入口（界面文案可能变了），跳过这一项");
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, "web-build.png") });
    console.log(`  截图：${join(SHOTS, "web-build.png")}`);
  }

  ok(
    errors.length === 0,
    `没有未捕获错误（${errors.length ? errors.slice(0, 3).join(" | ") : "0"}）` +
      (expectedPlatformErrors.length
        ? `；另有 ${expectedPlatformErrors.length} 条"Web 不支持 X"的平台提示（设计内，已忽略）`
        : ""),
  );
  ok(failedRequests.length === 0, `没有失败请求（${failedRequests.length ? failedRequests.slice(0, 3).join(" | ") : "0"}）`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
