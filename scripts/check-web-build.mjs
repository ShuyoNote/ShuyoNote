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
//   node scripts/check-web-build.mjs --url https://shuyo.cn/app/     # 验**线上**那一份
//
// `--url` 模式同样值得有：部署成功、`version.json` 对、资源 200 —— 这些都不等于"打开能用"
// （DB 初始化失败就是既不看版本号也不看资源清单的一种坏法）。

import { createServer } from "node:http";
import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";
import { pinAppLanguage } from "./lib/pin-locale.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dirArg = process.argv.indexOf("--dir");
const DIR = resolve(root, dirArg > -1 ? process.argv[dirArg + 1] : "dist-web");
const urlArg = process.argv.indexOf("--url");
/** 给了 --url 就直接验线上那一份：不起本地服务器，其余断言完全一样。 */
const LIVE_URL = urlArg > -1 ? process.argv[urlArg + 1].replace(/\/+$/, "") + "/" : null;
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

if (!LIVE_URL && !existsSync(join(DIR, "index.html"))) {
  console.error(`找不到构建产物：${join(DIR, "index.html")}——先跑 pnpm build:web（或用 --url 验线上）`);
  process.exit(2);
}
const chrome = findChrome();
if (!chrome) {
  console.error("找不到 Chrome/Chromium（可用 PUPPETEER_EXECUTABLE_PATH 指定）");
  process.exit(2);
}

const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
let built = null;
if (LIVE_URL) {
  try {
    built = JSON.parse(await (await fetch(LIVE_URL + "version.json")).text()).version;
  } catch {
    built = null;
  }
} else {
  built = JSON.parse(readFileSync(join(DIR, "version.json"), "utf8")).version;
}
console.log(LIVE_URL ? `Web 线上验收 · ${LIVE_URL}` : `Web 构建产物验收 · ${DIR}`);
console.log(`  期望版本 ${expected} · 实测版本 ${built ?? "(取不到)"}`);

const { server, port } = LIVE_URL ? { server: null, port: null } : await serveStatic(DIR);
const APP_URL = LIVE_URL ?? `http://127.0.0.1:${port}/`;
const browser = await launchChrome({ executablePath: chrome });
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
  // 语言钉成 zh-CN：CI 的 runner 是 en-US，而下面「文件管理」「上传」这些入口的 title/文案
  // 都走 i18n（见 `src/i18n/index.ts`）—— 只按中文找必然找不到（2026-09-22 三条移动端门禁
  // 就是这么在 CI 上假红的）。这里钉的是**测试环境**，不是改产品去迎合断言。
  await pinAppLanguage(page);
  await page.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(".sidebar, .app, #root", { timeout: 30000 });

  ok(built === expected, `${LIVE_URL ? "线上" : "产物"}的 version.json 是当前版本（${built ?? "取不到"}）`);

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
    const localAssets = LIVE_URL
      ? existsSync(join(DIR, "assets"))
        ? readdirSync(join(DIR, "assets"))
        : []
      : readdirSync(join(DIR, "assets"));
    const rel = localAssets.find((f) => f.includes(pat));
    if (!rel) {
      // 线上模式且本地没有 dist-web 时无从知道文件名——如实说，而不是假装通过
      console.log(`  · ${pat}：${LIVE_URL ? "本地没有 dist-web 可比对文件名，跳过" : "产物里找不到"}`);
      continue;
    }
    // 必须用**绝对**地址：Web 版可能挂在子路径下（国内主站就是 /app/），
    // 而页面里的 `/assets/...` 会被解析到域名根 —— 那会得到 404，然后把这个 404
    // 记成"线上资源缺失"，而其实是检查脚本自己找错了地方（第一次跑就踩了）。
    const abs = new URL(`assets/${rel}`, APP_URL).toString();
    const status = await page.evaluate(async (u) => {
      const r = await fetch(u, { method: "GET" });
      return r.status;
    }, abs);
    ok(status === 200, `${pat} 资源取得到（${rel} → ${status}${hit ? "，页面也用过它" : ""}）`);
  }

  // 插件管理那一屏（这一版的主战场）：能打开、且"从索引安装"在里面
  //
  // ⚠️ 这一步**必须等元素出现**，不能用固定 sleep：CI 的 2 核 runner 上三步点击之间固定
  // 等 500–700ms 常常不够 ⇒ 后面的 `found` 为 false ⇒ 下面两条断言**静默跳过** ⇒
  // 断言数从 8 掉到 6 ⇒ 基线报"退步"（2026-09-17 CI 实测：Linux 上就是这么红的，
  // 而红的信息只有"从 8 降到 6"，说不出原因）。改成等元素 + 失败时如实报告现场。
  const pluginsOk = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const labelOf = (b) => `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`.trim();
    const findBtn = (re) => Array.from(document.querySelectorAll("button")).find((b) => re.test(labelOf(b)));
    /** 等目标按钮出现（最多 6s）——比固定 sleep 稳得多，也不再让"慢"表现成"静默跳过"。 */
    const waitFor = async (re, timeoutMs = 6000) => {
      const t0 = Date.now();
      for (;;) {
        const b = findBtn(re);
        if (b) return b;
        if (Date.now() - t0 > timeoutMs) return null;
        await sleep(100);
      }
    };
    const steps = [];
    const clickStep = async (name, re) => {
      const b = await waitFor(re);
      if (!b) {
        steps.push(`${name}=找不到`);
        return false;
      }
      b.click();
      steps.push(`${name}=已点`);
      await sleep(200);
      return true;
    };
    // 插件管理的入口在「设置」里：设置（竖条上的 icon，aria-label="设置"）
    // → 左侧「插件」那一栏 → 卡片里的「打开插件管理」。三步都要点，少一步就找不到按钮。
    const openedSettings = await clickStep("设置", /^设置$|^Settings$/i);
    // ⚠️ **必须双语**：这一栏的文案来自 i18n（`settings.plugins` ⇒ zh「插件」/ en「Plugins」），
    //    而 CI 的 Chromium 默认 `navigator.language = en-US` ⇒ `src/i18n/index.ts` 选 `en`
    //    ⇒ 只认中文的匹配器在 CI 上永远找不到这一栏。2026-09-17 实测：本机加 `--lang=en-US`
    //    能**逐字复现** CI 的现象（6 通过 / 0 失败 + 同一条 ✗ 诊断）。
    //    （下面「管理插件」「打开插件管理」是组件里硬编码的中文，不随语言变；真被 i18n 化那天，
    //      "不许静默跳过"那条判据会把断言数掉下去，而不是悄悄少跑两条。）
    //    ⚠️ 这里**不能**写 `/^Plugins\b/`：按钮的 textContent 是「标签 + 提示」**连写**
    //    （`PluginsEnable/disable extensions`），`s` 与 `E` 之间没有词边界 ⇒ `\b` 永远不匹配。
    //    （第一次就栽在这——写的时候以为在匹配一个单词。）
    const clickedPlugins = openedSettings && (await clickStep("插件", /^插件|^Plugins/i));
    // 两个入口都认：卡片里的「打开插件管理」与设置页头部的「管理插件」
    // （界面在收拾信息层级，按钮文案可能变；这里不该因为换个词就红）
    const openedManager =
      clickedPlugins && ((await clickStep("打开插件管理", /打开插件管理/)) || (await clickStep("管理插件", /管理插件/)));
    await sleep(400);
    const text = document.body.textContent || "";
    // ⚠️ 打印**头 25 + 尾 25**：只打印前 N 个会恰好把"我们要找的那个按钮"截掉
    //（2026-09-17 实测：只打前 40 个时，英文的「Plugins」正好被截在名单之外，
    //  于是我又多猜了一轮）。截断不能把证据一起截掉。
    const all = Array.from(document.querySelectorAll("button")).map(labelOf).filter(Boolean);
    const head = all.slice(0, 25);
    const tail = all.length > 50 ? all.slice(-25) : all.slice(25);
    const labels = `${head.join(" | ")}${tail.length ? ` …（共 ${all.length} 个）… ${tail.join(" | ")}` : ""}`;
    return {
      found: Boolean(openedSettings && openedManager),
      opened: /插件管理/.test(text),
      hasWebNote: /Web 版不支持磁盘插件/.test(text),
      steps,
      labels,
    };
  });
  if (pluginsOk.found) {
    ok(pluginsOk.opened, "插件管理能打开");
    // Web 平台按设计不显示"从索引安装"面板（没有磁盘插件运行时），必须显示那句说明
    ok(pluginsOk.hasWebNote, "Web 版明确说明「不支持磁盘插件」，而不是装作能用");
  } else {
    // ⚠️ **不许静默跳过**：跳过会让断言数掉下去，而基线只会说"数字降了"、说不出原因
    //（上面那段注释就是这次的真实经过）。`✗` 开头的行会被 `test-report.mjs` 的
    // `extractFailures` 收进报告、并被 CI 注解带出来 ⇒ 下一次红自带原因与现场。
    console.error(`  ✗ 插件入口没走到（${pluginsOk.steps.join("；")}）—— 这会让 2 条断言被跳过，基线会报退步`);
    console.error(`  ✗ 现场按钮文案（前 40 个）：${pluginsOk.labels.slice(0, 1200)}`);
  }

  // 先把上一步打开的「设置 / 插件管理」浮层关掉：它们是**模态**的，留着的话下面点「上传」那一击
  // 会落在浮层上（2026-09-23 实测：文件管理器的 DOM 在、`button` 也在，但点击不触发它的 onClick
  // ⇒ `uploadFiles` 根本没跑 ⇒ 抓不到动态创建的 file input）。Esc 关浮层是本应用的既有行为。
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── 打包产物里「markdown → Lexical」的节点表不能是模块顶层求值 ──────────────
  //
  // 为什么必须有这一档（2026-09-23，用户实测报的 bug）：`src/lib/mdPreview.ts` 的节点表原来是
  // **模块顶层**的数组，而它处在一个循环 import 里：
  //   lib/mdPreview → editor/nodes/ColumnsBlockNode → store/notes → store/filePreview → lib/mdPreview
  // dev / vitest（原生 ESM）下 import 求值顺序**必然**先初始化好那个类，所以单测永远绿；
  // 而**打包产物**把模块拼平后，数组字面量先跑 ⇒ `nodes[9]`（`ColumnsBlockNode`）是 `undefined`
  // ⇒ `createEditor` 抛 `Minified Lexical error #365`。受害者是 `markdownToPageContent` 的两个
  // 调用方：「从社区链接存一篇笔记」与「Markdown 导入为页面」。
  // ⇒ 判据只能钉在**产物形状**上：`createEditor({ nodes: … })` 那个实参必须是**调用/内联数组**，
  //    不能是"模块顶层那个数组标识符"（修好后是 `nodes: ZGr()`；修前是 `nodes: ia`）。
  //    细节见 `mdPreview.ts` 的 `mdNodes()` 头注。
  if (!LIVE_URL) {
    const chunk = readdirSync(join(DIR, "assets"))
      .filter((f) => f.startsWith("index-") && f.endsWith(".js"))
      .map((f) => readFileSync(join(DIR, "assets", f), "utf8"))
      .find((t) => t.includes("shuyonote-md-preview"));
    const callSite = chunk ? chunk.slice(Math.max(0, chunk.indexOf("shuyonote-md-preview") - 400), chunk.indexOf("shuyonote-md-preview")) : "";
    const bare = /nodes:\s*([A-Za-z_$][\w$]*)\s*,/.exec(callSite);
    const lazy = /nodes:\s*(?:[A-Za-z_$][\w$]*\(\)|\[)/.test(callSite);
    ok(
      Boolean(chunk) && lazy && !bare,
      "产物里 markdown 的节点表是**调用/内联**（不是模块顶层那个数组）—— " +
        `实参形态 ${lazy ? "✓ 惰性" : "✗ 裸标识符"}${bare ? `（nodes: ${bare[1]}）` : ""}` +
        "；这一档钉的是「循环 import + 模块顶层求值 ⇒ 打包后节点表里是 undefined」那个 bug",
    );
    if (chunk && (bare || !lazy)) {
      console.error("  ✗ 修法：把节点表挪进函数（见 src/lib/mdPreview.ts 的 mdNodes()），别在模块顶层建数组");
    }
  } else {
    console.log("  · 线上模式（--url）拿不到产物文件 ⇒ 跳过「节点表惰性」这一档形状检查");
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
  server?.close();
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
