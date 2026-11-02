#!/usr/bin/env node
/**
 * css-visual-baseline.mjs —— 「CSS 改动的视觉基线」原型（只读工具，不写仓库）
 * ==========================================================================
 *
 * 为什么需要它：CSS 改动最容易造成的隐性回归是「该 375px 换行的地方没换」、
 * 「按钮高度 32→28」这种**像素级**漂移 —— 现有门禁（tsc / vitest / 各 check-*.mjs）
 * 一条都看不见它。这个脚本给 S0 阶段提供一条可重复的读数：
 *   同机、同浏览器、同视口 ⇒ 截图 + 关键几何 ⇒ 下次改动后逐像素/逐字段比对。
 *
 * 本机为什么不用 puppeteer.launch()：
 *   沙箱下 `launch()` 会直接失败（Failed to launch the browser process: Code: 0），
 *   但「手动起 Edge + CDP 连上去」是可行的。所以这里：
 *     1) spawn Edge (`--headless=new --remote-debugging-port=<port> --user-data-dir=<tmp>`)
 *     2) 轮询 http://127.0.0.1:<port>/json/version
 *     3) puppeteer-core.connect({ browserURL })
 *   —— 只 connect，不 launch。
 *
 * 用法（详见同目录 css-visual-baseline.md）：
 *   # 1. 对 dev server 截图（默认 http://localhost:1420/）
 *   node css-visual-baseline.mjs
 *
 *   # 2. dev server 不可用时，托管已构建产物（只读挂 dist-web，随机端口）
 *   node scripts/css-visual-baseline.mjs --static-dir dist-web
 *
 *   # 3. 用场景文件点进「文件管理 / 属性面板」再各截一张
 *   node scripts/css-visual-baseline.mjs --static-dir <dist> --scenario scripts/css-baseline-scenarios.json
 *
 *   # 4. 与旧基线比对（现场重新捕获一次，再和 <dir> 比）
 *   node scripts/css-visual-baseline.mjs --static-dir <dist> --compare _tmp/acceptance/css-baseline-2026-10-31
 *
 *   # 5. 不依赖应用的链路自测（about:blank + 自造 HTML，含「必须报差异」用例）
 *   node css-visual-baseline.mjs --self-test
 *
 * 退出码：0 = 通过 / 无超阈值差异；1 = 差异超阈值或自测失败；2 = 环境不具备（连不上/无浏览器）。
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");             // 仓库根
const DEFAULT_REPO = WORKSPACE;
const OUT_ROOT = path.resolve(WORKSPACE, "..", "..", "_tmp", "acceptance");

const TOOL = "css-visual-baseline";
const SCHEMA = 1;

/** 默认探针：任务点名的三项 + 外壳/容器，缺哪一项都只记 present:false，不报错。 */
const DEFAULT_PROBES = [
  "#root",
  ".app-body",
  ".main",
  ".sidebar",
  ".editor-toolbar-bar",
  ".title-input",          // ← 任务点名 ①
  ".file-manager",
  ".file-manager-head",
  ".file-manager-toolbar", // ← 任务点名 ③
  ".properties",           // ← 任务点名 ②
];

const DEFAULT_VIEWPORTS = "1280x800,375x812,320x700";

/** 冻结动效/光标：让两次截图可比。--live-motion 可关掉（见 usage）。 */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;

// ─────────────────────────────────────────────────────────── 参数解析

function usage() {
  return `css-visual-baseline.mjs —— CSS 改动的视觉基线（只读）

捕获：
  --url <url>            目标地址，默认 ${"http://localhost:1420/"}
  --static-dir <dir>     托管一个已构建目录（如 dist-web），自动起随机端口的只读静态服务
  --out <dir>            输出目录，默认 <工作区>/_tmp/acceptance/css-baseline
  --viewports <list>     形如 "1280x800,375x812,320x700"（默认就是这三个）
  --probes <list>        逗号分隔的选择器，覆盖默认探针
  --settle <ms>          页面稳定后的静置时间，默认 900
  --scenario <file.json> 声明式场景：点哪里→等到哪→按什么名字截图（见 scripts/css-baseline-scenarios.json）
  --mask <list>          只用于稳定截图的遮罩选择器（把「时间戳」这类必变区域涂掉）
  --full-page            截整页（图片会比视口高）
  --live-motion          不注入「冻结动画/光标」的 CSS（默认注入）
  --keep-profile         保留临时 user-data-dir（默认删除）

浏览器：
  --edge <path>          msedge 可执行文件路径
  --port <n>             CDP 端口（默认 9300..9599 随机）
  --profile-dir <dir>    指定 user-data-dir（默认 <工作区>/_tmp/acceptance/css-baseline-profile/run-<ts>）

比对：
  --compare <dir>        与旧基线目录比对；默认先现场捕获到 <out>/.current 再比
  --new <dir>            指定「新基线」目录（给了就不现场捕获）
  --threshold <ratio>    允许的逐像素差异比例，默认 0.002（0.2%）
  --tol <px>             几何字段容差，默认 0.5
  --channel-tol <n>      单通道色差容差（0-255），默认 0（严格）
  --fail-on-metrics      只要有 metrics 字段差异就判失败（默认只报告）
  --no-fail              无论差异多大都 exit 0（探索用）

自测：
  --self-test            用 about:blank + 自造 HTML 验证「CDP→截图→PNG 解码→差异检出」整条链
`;
}

function parseArgs(argv) {
  const out = {
    url: null, staticDir: null, out: path.join(OUT_ROOT, "css-baseline"),
    viewports: DEFAULT_VIEWPORTS, probes: DEFAULT_PROBES.join(","),
    settle: 900, fullPage: false, freezeMotion: true, keepProfile: false,
    scenario: null, mask: "",
    edge: null, port: null, profileDir: null,
    compare: null, newDir: null, threshold: 0.002, tol: 0.5, channelTol: 0,
    failOnMetrics: false, noFail: false, selfTest: false, repo: DEFAULT_REPO,
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith("--")) continue;
    let val = null;
    const eq = a.indexOf("=");
    if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => {
      if (val !== null) return val;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} 需要一个值`);
      i++;
      return v;
    };
    switch (a) {
      case "--help": case "-h": console.log(usage()); process.exit(0);
      case "--url": out.url = next(); break;
      case "--static-dir": out.staticDir = path.resolve(next()); break;
      case "--out": out.out = path.resolve(next()); break;
      case "--viewports": out.viewports = next(); break;
      case "--probes": out.probes = next(); break;
      case "--settle": out.settle = Number(next()); break;
      case "--scenario": out.scenario = path.resolve(next()); break;
      case "--mask": out.mask = next(); break;
      case "--full-page": out.fullPage = true; break;
      case "--live-motion": out.freezeMotion = false; break;
      case "--keep-profile": out.keepProfile = true; break;
      case "--edge": out.edge = next(); break;
      case "--port": out.port = Number(next()); break;
      case "--profile-dir": out.profileDir = path.resolve(next()); break;
      case "--compare": out.compare = path.resolve(next()); break;
      case "--new": out.newDir = path.resolve(next()); break;
      case "--threshold": out.threshold = Number(next()); break;
      case "--tol": out.tol = Number(next()); break;
      case "--channel-tol": out.channelTol = Number(next()); break;
      case "--fail-on-metrics": out.failOnMetrics = true; break;
      case "--no-fail": out.noFail = true; break;
      case "--self-test": out.selfTest = true; break;
      case "--repo": out.repo = path.resolve(next()); break;
      default: throw new Error(`未知参数 ${a}（--help 看用法）`);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────── 小工具

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const round2 = (n) => Math.round(n * 100) / 100;
const log = (...a) => console.log(...a);

function parseViewports(spec) {
  const list = spec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s);
    if (!m) throw new Error(`viewport 写法不对：${s}（要 宽x高，如 375x812）`);
    return { width: Number(m[1]), height: Number(m[2]), key: `${m[1]}x${m[2]}` };
  });
  if (!list.length) throw new Error("viewport 列表为空");
  return list;
}

// ─────────────────────────────────────────────────────────── Edge / CDP

function resolveEdge(explicit) {
  const candidates = [
    explicit,
    process.env.SHUYONOTE_EDGE,
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Microsoft/Edge/Application/msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    "找不到 msedge.exe。用 --edge <path> 指定，或设环境变量 SHUYONOTE_EDGE。\n试过：" +
      candidates.join("\n  ")
  );
}

function loadPuppeteer(repo) {
  // 任务要求：用 createRequire 从仓库 package.json 解析（避免下载浏览器，也不往 _tmp 装依赖）
  try {
    const req = createRequire(path.join(repo, "package.json"));
    return req("puppeteer-core");
  } catch (e) {
    throw new Error(
      `无法从 ${repo} 解析 puppeteer-core：${e.message}\n` +
        "（本工具刻意不装依赖：node_modules 里现成的 puppeteer-core 就够用）"
    );
  }
}

function pickPort(preferred) {
  if (preferred) return preferred;
  return 9300 + Math.floor(Math.random() * 300);
}

async function waitForCdp(port, timeoutMs = 25000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const j = await r.json();
        if (j.webSocketDebuggerUrl) return j;
        lastErr = new Error("/json/version 没有 webSocketDebuggerUrl");
      } else lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等 ${timeoutMs}ms 仍未拿到 http://127.0.0.1:${port}/json/version：${lastErr && lastErr.message}`);
}

function spawnEdge({ edgePath, port, profileDir }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--force-device-scale-factor=1",   // 截图 px 与 CSS px 1:1
    "--force-color-profile=srgb",      // 颜色不随显示器 profile 漂
    "--disable-features=Translate,MediaRouter",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  const proc = spawn(edgePath, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  proc.on("error", (e) => { proc.__spawnError = e; });
  proc.on("exit", (code, sig) => { proc.__exit = { code, sig }; });
  return { proc, args };
}

/** 只杀「带我们那个 user-data-dir」的 msedge —— 不碰用户自己的 Edge。 */
function killOwnEdges(proc, profileDir) {
  try { if (proc && !proc.killed) proc.kill(); } catch {}
  if (process.platform !== "win32") return;
  const needle = profileDir.replace(/'/g, "''");
  const ps = `$ErrorActionPreference='SilentlyContinue';` +
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      stdio: "ignore", windowsHide: true,
    });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
}

// ─────────────────────────────────────────────────────────── 静态托管（只读）

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".map": "application/json",
  ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf", ".traineddata": "application/octet-stream",
  ".gz": "application/gzip", ".br": "application/octet-stream",
};

function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(path.join(root, "index.html"))) {
    throw new Error(`${root} 下没有 index.html —— 不像是构建产物目录`);
  }
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let rel;
      try {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        rel = decodeURIComponent(u.pathname);
      } catch { res.writeHead(400).end("bad request"); return; }

      let abs = path.resolve(root, "." + rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {   // 目录穿越
        res.writeHead(403).end("forbidden");
        return;
      }
      let st = null;
      try { st = fs.statSync(abs); } catch {}
      if (!st) {
        // 无扩展名的路径按 SPA 路由回退到 index.html（有扩展名的真 404）
        if (!path.extname(abs)) {
          res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
          fs.createReadStream(path.join(root, "index.html")).pipe(res);
          return;
        }
        res.writeHead(404).end("not found");
        return;
      }
      if (st.isDirectory()) abs = path.join(abs, "index.html");
      try {
        const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        fs.createReadStream(abs).pipe(res);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}/`, port, root });
    });
  });
}

// ─────────────────────────────────────────────────────────── 捕获

async function probeMetrics(page, probes) {
  return page.evaluate((sels) => {
    const out = {};
    const px = (v) => Math.round(v * 100) / 100;
    for (const sel of sels) {
      try {
        const els = document.querySelectorAll(sel);
        const el = els[0];
        if (!el) { out[sel] = { present: false, count: 0 }; continue; }
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out[sel] = {
          present: true,
          count: els.length,
          rect: {
            x: px(r.x), y: px(r.y), width: px(r.width), height: px(r.height),
            top: px(r.top), right: px(r.right), bottom: px(r.bottom), left: px(r.left),
          },
          style: {
            fontSize: cs.fontSize,
            lineHeight: cs.lineHeight,
            height: cs.height,
            width: cs.width,
            display: cs.display,
            position: cs.position,
            padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
            overflowX: r.left < -0.5 || r.right > window.innerWidth + 0.5,
            overflowY: r.top < -0.5 || r.bottom > window.innerHeight + 0.5,
          },
        };
      } catch (e) {
        out[sel] = { present: false, count: 0, error: String(e && e.message) };
      }
    }
    const de = document.documentElement;
    return {
      probes: out,
      doc: {
        title: document.title,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        scrollWidth: de.scrollWidth,
        scrollHeight: de.scrollHeight,
        horizontalOverflow: de.scrollWidth > window.innerWidth + 1,
        readyState: document.readyState,
      },
    };
  }, probes);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 步骤：{click}/{clickText}/{wait}/{waitFor}。缺目标 ⇒ 抛错（由调用方记成备注，不中断整轮）。 */
async function runStep(page, step) {
  if (step.wait != null) { await sleep(Number(step.wait)); return; }
  if (step.waitFor) {
    await page.waitForSelector(step.waitFor, { timeout: Number(step.timeout) || 6000 });
    return;
  }
  if (step.click) {
    await page.waitForSelector(step.click, { timeout: Number(step.timeout) || 6000 });
    await page.click(step.click);
    return;
  }
  if (step.clickText) {
    const handle = await page.evaluateHandle((t) => {
      const nodes = [...document.querySelectorAll("button,[role=button],a,[title]")];
      return nodes.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4 && (el.textContent || "").trim() === t;
      }) || null;
    }, step.clickText);
    const el = handle.asElement();
    if (!el) { await handle.dispose?.(); throw new Error(`找不到文本为「${step.clickText}」的可点元素`); }
    await el.click();
    await el.dispose?.();
    return;
  }
  throw new Error(`未知步骤 ${JSON.stringify(step)}`);
}

async function captureInto({ browser, target, outDir, viewports, probes, settle, freezeMotion, fullPage, content, label, shots: shotSpecs, masks }) {
  const list = (shotSpecs && shotSpecs.length) ? shotSpecs : [{ name: fullPage ? "initial-full" : "initial" }];
  const maskSelectors = masks || [];
  const shots = [];
  for (const vp of viewports) {
    const page = await browser.newPage();
    const pageNotes = [];
    try {
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      // 服务端 SW 会缓存旧产物 ⇒ 每次跑都在一个新 profile 里，再保险一次关掉 SW
      const cdp = await page.createCDPSession();
      await cdp.send("Network.setBypassServiceWorker", { bypass: true }).catch(() => {});
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }],
      }).catch(() => {});

      if (content != null) {
        await page.setContent(content, { waitUntil: "load", timeout: 30000 });
      } else {
        await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        // 应用挂载：Vite dev 下 #root 一开始是空的；这里给一个宽松但可判的判据
        const mounted = await page
          .waitForFunction(() => {
            const r = document.getElementById("root");
            return document.readyState !== "loading" && (!r || r.childElementCount > 0);
          }, { timeout: 25000, polling: 250 })
          .then(() => true)
          .catch(() => false);
        if (!mounted) pageNotes.push("#root 25s 内没有子节点（可能是纯空白页/启动失败）");
      }

      await page.evaluate(() =>
        document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true
      ).catch(() => {});
      await sleep(settle);
      if (freezeMotion) await page.addStyleTag({ content: FREEZE_CSS });

      for (const spec of list) {
        const name = spec.name || "initial";
        if (spec.minWidth && vp.width < spec.minWidth) {
          pageNotes.push(`${name}: 视口宽 ${vp.width} < ${spec.minWidth}，按场景声明跳过`);
          continue;
        }
        if (spec.maxWidth && vp.width > spec.maxWidth) {
          pageNotes.push(`${name}: 视口宽 ${vp.width} > ${spec.maxWidth}，按场景声明跳过`);
          continue;
        }
        const notes = [];
        let stop = false;
        for (const step of spec.steps || []) {
          try {
            await runStep(page, step);
          } catch (e) {
            notes.push(`步骤失败 ${JSON.stringify(step)}：${e.message}`);
            stop = true;
            break;
          }
        }
        // 步骤失败也照样截：图上的「缺了什么」本身就是要被基线记住的读数
        void stop;
        await page.evaluate(() => new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(true)))
        )).catch(() => {});
        await sleep(120);

        const maskEls = [];
        for (const sel of maskSelectors) {
          const h = await page.$(sel).catch(() => null);
          if (h) maskEls.push(h);
          else notes.push(`遮罩 ${sel} 不存在（此视口可能没这块）`);
        }
        let png;
        try {
          png = await page.screenshot({
            type: "png",
            captureBeyondViewport: false,
            fullPage: Boolean(fullPage || spec.fullPage),
            mask: maskEls,
          });
        } finally {
          for (const h of maskEls) await h.dispose().catch(() => {});
        }
        if (!png) throw new Error(`截图失败：${vp.key}/${name}`);

        const dir = path.join(outDir, vp.key);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, `${name}.png`), png);

        const m = await probeMetrics(page, probes);
        const allNotes = [...pageNotes, ...notes];
        shots.push({
          viewport: vp.key,
          viewportsize: { width: vp.width, height: vp.height },
          name,
          file: path.posix.join(vp.key, `${name}.png`),
          sha256: sha256(png),
          bytes: png.length,
          doc: m.doc,
          probes: m.probes,
          notes: allNotes,
        });
        log(`  ✓ ${vp.key.padEnd(8)} ${name}.png  ${String(png.length).padStart(7)}B  sha=${sha256(png).slice(0, 12)}` +
          (allNotes.length ? `  ⚠ ${allNotes.join("；")}` : ""));
      }
    } finally {
      await page.close().catch(() => {});
    }
  }
  return {
    schema: SCHEMA,
    tool: TOOL,
    generatedAt: new Date().toISOString(),
    label: label || null,
    target,
    options: { viewports: viewports.map((v) => v.key), probes, settle, fullPage, freezeMotion, masks: maskSelectors },
    shots,
  };
}

async function runCapture(opts) {
  const viewports = parseViewports(opts.viewports);
  const probes = opts.probes.split(",").map((s) => s.trim()).filter(Boolean);
  const puppeteer = loadPuppeteer(opts.repo);
  const edgePath = resolveEdge(opts.edge);

  const masks = opts.mask ? opts.mask.split(",").map((s) => s.trim()).filter(Boolean) : [];
  let scenario = null;
  if (opts.scenario) {
    scenario = JSON.parse(await fsp.readFile(opts.scenario, "utf8"));
    if (!Array.isArray(scenario.shots) || !scenario.shots.length) {
      throw new Error(`${opts.scenario} 里没有 shots 数组`);
    }
  }

  let staticSrv = null;
  let target;
  try {
    if (opts.staticDir) {
      staticSrv = await startStaticServer(opts.staticDir);
      target = { mode: "static", url: staticSrv.url, root: staticSrv.root };
    } else {
      target = { mode: "url", url: opts.url || "http://localhost:1420/" };
    }

    const outDir = opts.out;
    await fsp.mkdir(outDir, { recursive: true });

    const port = pickPort(opts.port);
    const profileDir = opts.profileDir || path.join(OUT_ROOT, "css-baseline-profile", `run-${stamp()}`);
    log(`[浏览器] ${edgePath}`);
    log(`[CDP]    127.0.0.1:${port}   profile=${profileDir}`);
    const { proc } = spawnEdge({ edgePath, port, profileDir });
    let browser = null;
    let version = null;
    try {
      version = await waitForCdp(port);
      log(`[浏览器] ${version.Browser}`);
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
      log(`[目标] ${target.mode} ${target.url}`);
      log(`[视口] ${viewports.map((v) => v.key).join(" / ")}`);
      if (scenario) log(`[场景] ${opts.scenario}（${scenario.shots.map((s) => s.name).join(" / ")}）`);
      if (masks.length) log(`[遮罩] ${masks.join(" ")}`);
      const metrics = await captureInto({
        browser, target, outDir, viewports, probes,
        settle: opts.settle, freezeMotion: opts.freezeMotion, fullPage: opts.fullPage,
        shots: scenario ? scenario.shots : null, masks,
      });
      metrics.browser = version.Browser;
      metrics.scenario = opts.scenario || null;
      await fsp.writeFile(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n", "utf8");
      log(`\n[产物] ${path.join(outDir, "metrics.json")}`);
      for (const s of metrics.shots) {
        const present = Object.entries(s.probes || {}).filter(([, v]) => v.present).map(([k]) => k);
        log(`[探针] ${`${s.viewport}/${s.name}`.padEnd(20)} 命中 ${present.length}/${probes.length}：${present.join(" ") || "（无）"}`);
      }
      return { metrics, outDir, exitCode: 0 };
      return { metrics, outDir, exitCode: 0 };
    } finally {
      if (browser) await browser.disconnect().catch(() => {});
      await killOwnEdges(proc, profileDir);
      if (!opts.keepProfile && !opts.profileDir) {
        await rmProfile(profileDir);
      }
    }
  } finally {
    if (staticSrv) staticSrv.server.close();
  }
}

// ─────────────────────────────────────────────────────────── PNG 解码（无依赖）

/**
 * 最小 PNG 解码器：只吃 Chromium 截图会产出的形态
 * （8-bit、非隔行、colorType 2/6/0/4）。zlib 用 Node 内置的 inflateSync。
 * 遇到别的形态**明确报错**，不猜。
 */
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("不是 PNG（签名不对）");
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error("PNG 缺 IHDR");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error(`不支持的 PNG colorType=${ihdr.colorType}（本解码器只做 0/2/4/6）`);
  if (ihdr.bitDepth !== 8) throw new Error(`不支持的 bitDepth=${ihdr.bitDepth}`);
  if (ihdr.interlace !== 0) throw new Error("不支持隔行 PNG");
  if (!idat.length) throw new Error("PNG 缺 IDAT");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const need = (stride + 1) * ihdr.height;
  if (raw.length < need) throw new Error(`PNG 数据不足：${raw.length} < ${need}`);
  const out = Buffer.alloc(stride * ihdr.height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    unfilter(ft, line, cur, prev, channels);
    prev = cur;
  }
  return { width: ihdr.width, height: ihdr.height, channels, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(ft, line, cur, prev, bpp) {
  const n = line.length;
  switch (ft) {
    case 0:
      line.copy(cur);
      break;
    case 1:
      for (let i = 0; i < n; i++) cur[i] = (line[i] + (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) cur[i] = (line[i] + prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const c = i >= bpp ? prev[i - bpp] : 0;
        cur[i] = (line[i] + paeth(a, prev[i], c)) & 0xff;
      }
      break;
    default:
      throw new Error(`未知 PNG filter 类型 ${ft}`);
  }
}

/** 逐像素比对（含 alpha）：任一通道差 > 容差即算「变了」。 */
function diffPng(a, b, channelTol = 0) {
  const A = decodePng(a), B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) {
    return {
      sizeMismatch: true,
      old: { width: A.width, height: A.height },
      new: { width: B.width, height: B.height },
      changedPixels: null, totalPixels: null, ratio: 1, maxChannelDelta: null, bbox: null,
    };
  }
  const ch = Math.min(A.channels, B.channels);
  const total = A.width * A.height;
  let changed = 0, maxDelta = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < A.height; y++) {
    const rowA = y * A.width * A.channels;
    const rowB = y * B.width * B.channels;
    for (let x = 0; x < A.width; x++) {
      const ia = rowA + x * A.channels;
      const ib = rowB + x * B.channels;
      let dif = 0;
      for (let c = 0; c < ch; c++) {
        const d = Math.abs(A.data[ia + c] - B.data[ib + c]);
        if (d > dif) dif = d;
      }
      if (dif > maxDelta) maxDelta = dif;
      if (dif > channelTol) {
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    sizeMismatch: false,
    old: { width: A.width, height: A.height },
    new: { width: B.width, height: B.height },
    changedPixels: changed,
    totalPixels: total,
    ratio: total ? changed / total : 0,
    maxChannelDelta: maxDelta,
    bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

// ─────────────────────────────────────────────────────────── metrics diff

function diffMetrics(oldShot, newShot, tolPx) {
  const diffs = [];
  const od = oldShot?.doc || {}, nd = newShot?.doc || {};
  for (const k of ["innerWidth", "innerHeight", "scrollWidth", "scrollHeight", "dpr", "horizontalOverflow"]) {
    if (od[k] !== nd[k]) diffs.push({ kind: "doc", field: k, old: od[k], new: nd[k] });
  }
  const selectors = new Set([...Object.keys(oldShot?.probes || {}), ...Object.keys(newShot?.probes || {})]);
  for (const sel of selectors) {
    const a = oldShot?.probes?.[sel] || { present: false };
    const b = newShot?.probes?.[sel] || { present: false };
    if (Boolean(a.present) !== Boolean(b.present)) {
      diffs.push({ kind: "presence", selector: sel, old: Boolean(a.present), new: Boolean(b.present) });
      continue;
    }
    if (!a.present) continue;
    if (a.count !== b.count) diffs.push({ kind: "count", selector: sel, old: a.count, new: b.count });
    for (const f of ["x", "y", "width", "height", "top", "right", "bottom", "left"]) {
      const delta = (b.rect?.[f] ?? 0) - (a.rect?.[f] ?? 0);
      if (Math.abs(delta) > tolPx) {
        diffs.push({ kind: "rect", selector: sel, field: f, old: a.rect?.[f], new: b.rect?.[f], delta: round2(delta) });
      }
    }
    for (const f of Object.keys(a.style || {})) {
      if (a.style[f] !== b.style?.[f]) {
        diffs.push({ kind: "style", selector: sel, field: f, old: a.style[f], new: b.style?.[f] });
      }
    }
  }
  return diffs;
}

// ─────────────────────────────────────────────────────────── 比对模式

function keyOf(shot) { return `${shot.viewport}/${shot.name}`; }

function indexShots(metrics) {
  const m = new Map();
  for (const s of metrics.shots || []) m.set(keyOf(s), s);
  return m;
}

async function compareBaselines(oldDir, newDir, opts) {
  const oldM = JSON.parse(await fsp.readFile(path.join(oldDir, "metrics.json"), "utf8"));
  const newM = JSON.parse(await fsp.readFile(path.join(newDir, "metrics.json"), "utf8"));
  const oldIdx = indexShots(oldM), newIdx = indexShots(newM);

  const keys = [...new Set([...oldIdx.keys(), ...newIdx.keys()])].sort();
  const results = [];
  let worstRatio = 0, totalChanged = 0, metricDiffTotal = 0;

  for (const key of keys) {
    const o = oldIdx.get(key), n = newIdx.get(key);
    if (!o || !n) {
      results.push({ key, status: o ? "removed" : "added", pixel: null, metrics: [] });
      metricDiffTotal++;
      continue;
    }
    let pixel = null;
    try {
      const [a, b] = await Promise.all([
        fsp.readFile(path.join(oldDir, o.file)),
        fsp.readFile(path.join(newDir, n.file)),
      ]);
      pixel = diffPng(a, b, opts.channelTol);
    } catch (e) {
      pixel = { error: String(e && e.message) };
    }
    const metrics = diffMetrics(o, n, opts.tol);
    if (pixel && typeof pixel.ratio === "number") {
      worstRatio = Math.max(worstRatio, pixel.ratio);
      totalChanged += pixel.changedPixels || 0;
    }
    metricDiffTotal += metrics.length;
    results.push({ key, status: "compared", pixel, metrics });
  }

  const report = {
    tool: TOOL,
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    oldDir, newDir,
    thresholds: { pixelRatio: opts.threshold, geometricTolPx: opts.tol, channelTol: opts.channelTol },
    summary: {
      shots: results.length,
      worstPixelRatio: worstRatio,
      totalChangedPixels: totalChanged,
      metricDiffCount: metricDiffTotal,
      verdict: "pass",
    },
    results,
  };
  const over = worstRatio > opts.threshold;
  const metricFail = opts.failOnMetrics && metricDiffTotal > 0;
  report.summary.verdict = over || metricFail ? "fail" : "pass";
  await fsp.writeFile(path.join(newDir, "diff-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  log(`\n[比对] old=${oldDir}`);
  log(`        new=${newDir}`);
  for (const r of results) {
    if (r.status !== "compared") { log(`  ${r.key.padEnd(22)} ${r.status}`); continue; }
    const p = r.pixel || {};
    const pct = typeof p.ratio === "number" ? (p.ratio * 100).toFixed(3) + "%" : "n/a";
    const box = p.bbox ? ` bbox=${p.bbox.width}x${p.bbox.height}@${p.bbox.x},${p.bbox.y}` : "";
    const flag = typeof p.ratio === "number" && p.ratio > opts.threshold ? "  ✗" : "";
    log(`  ${r.key.padEnd(22)} 像素 ${pct.padStart(8)}  metrics ${String(r.metrics.length).padStart(3)} 项${box}${p.sizeMismatch ? "  尺寸不同" : ""}${flag}`);
    for (const d of r.metrics.slice(0, 8)) log(`      · ${d.selector || d.field} ${d.field} ${d.old} → ${d.new}`);
    if (r.metrics.length > 8) log(`      · …另有 ${r.metrics.length - 8} 项`);
  }
  log(`\n[结论] ${report.summary.verdict === "pass" ? "通过" : "不通过"}` +
    `  最差像素差异 ${(worstRatio * 100).toFixed(3)}%（阈值 ${(opts.threshold * 100).toFixed(3)}%）` +
    `  metrics 差异 ${metricDiffTotal} 项`);
  log(`[报告] ${path.join(newDir, "diff-report.json")}`);
  return { report, exitCode: report.summary.verdict === "pass" ? 0 : 1 };
}

// ─────────────────────────────────────────────────────────── 自测

/**
 * 自测不依赖应用：about:blank 上 setContent 一段自造 HTML。
 * 用例：
 *   A：基准；B：再截一次（必须 0 像素差异）；C：把 .properties 下移 14px + 字号 15→16px（必须报差异）
 */
function syntheticHtml(mutated) {
  const shift = mutated ? 14 : 0;
  const fontSize = mutated ? 16 : 15;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    body { margin:0; font-family: "Segoe UI", system-ui, sans-serif; background:#fff; color:#1c1c1e; }
    .app-body { display:flex; height:100vh; }
    .sidebar { width:220px; background:#f5f5f7; border-right:1px solid #e5e5ea; flex:none; }
    .main { flex:1; padding:24px; overflow:hidden; }
    .title-input { width:100%; box-sizing:border-box; font-size:28px; line-height:36px; height:44px;
      border:0; outline:0; padding:4px 6px; background:transparent; }
    .file-manager-toolbar { display:flex; gap:8px; align-items:center; height:40px;
      border-bottom:1px solid #e5e5ea; margin-bottom:12px; }
    .properties { position:absolute; right:24px; top:${120 + shift}px; width:200px;
      font-size:${fontSize}px; line-height:1.5; border:1px solid #e5e5ea; border-radius:8px; padding:10px; }
    .row { height:20px; background:#f0f0f2; border-radius:4px; }
  </style></head><body>
    <div id="root"><div class="app-body">
      <aside class="sidebar"><div class="row" style="margin:12px"></div></aside>
      <main class="main">
        <div class="file-manager-toolbar"><span>排序</span><span>筛选</span></div>
        <div class="title-row"><input class="title-input" value="视觉基线自测"></div>
        <div class="editor-stage"><div class="row" style="height:180px;margin-top:16px"></div></div>
      </main>
      <div class="properties"><div>属性：标签 / 创建时间</div><div class="row"></div></div>
    </div></div>
  </body></html>`;
}

/** 删临时 profile：Windows 上 Edge 刚退出时还握着文件锁，所以重试几次（失败只提示，不炸）。 */
async function rmProfile(profileDir) {
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(profileDir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.warn(`[提示] 临时 profile 删不掉（Edge 子进程还握着锁？）：${profileDir}`);
  return false;
}

async function withBrowser(opts, fn) {
  const puppeteer = loadPuppeteer(opts.repo);
  const edgePath = resolveEdge(opts.edge);
  const port = pickPort(opts.port);
  const profileDir = opts.profileDir || path.join(OUT_ROOT, "css-baseline-profile", `run-${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  log(`[浏览器] ${edgePath}`);
  const { proc } = spawnEdge({ edgePath, port, profileDir });
  let browser = null;
  try {
    const version = await waitForCdp(port);
    log(`[浏览器] ${version.Browser}   CDP 127.0.0.1:${port}`);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    return await fn({ browser, version });
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    await killOwnEdges(proc, profileDir);
    if (!opts.keepProfile && !opts.profileDir) {
      await rmProfile(profileDir);
    }
  }
}

async function runSelfTest(opts) {
  const base = path.join(OUT_ROOT, "css-baseline-selftest");
  await fsp.rm(base, { recursive: true, force: true });
  const viewports = parseViewports(opts.viewports);
  const probes = opts.probes.split(",").map((s) => s.trim()).filter(Boolean);
  let failures = 0;
  const check = (ok, msg) => { log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failures++; };

  return withBrowser(opts, async ({ browser, version }) => {
    const capture = async (dirName, html, label) => {
      const outDir = path.join(base, dirName);
      const metrics = await captureInto({
        browser, content: html, outDir, viewports, probes,
        settle: 250, freezeMotion: true, fullPage: false,
        target: { mode: "inline-html", url: "about:blank", label },
      });
      metrics.browser = version.Browser;
      await fsp.writeFile(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n", "utf8");
      return outDir;
    };

    log("\n[自测] A/B/C 三次捕获（about:blank + 自造 HTML）");
    const dirA = await capture("a", syntheticHtml(false), "baseline");
    const dirB = await capture("b", syntheticHtml(false), "repeat");
    const dirC = await capture("c", syntheticHtml(true), "mutated");

    log("\n[自测] 1) 同页面两次捕获必须逐像素一致");
    const same = await compareBaselines(dirA, dirB, { ...opts, threshold: 0, tol: 0.01, channelTol: 0, failOnMetrics: true });
    check(same.exitCode === 0, `A↔B 无差异（最差 ${(same.report.summary.worstPixelRatio * 100).toFixed(3)}%）`);
    check(same.report.summary.totalChangedPixels === 0, "A↔B 变化像素数 = 0");

    log("\n[自测] 2) 改动过 CSS 的页面必须报出差异");
    const diff = await compareBaselines(dirA, dirC, { ...opts, threshold: 0.0005, tol: 0.5, channelTol: 0 });
    const ratio = diff.report.summary.worstPixelRatio;
    check(diff.exitCode === 1, `A↔C 判为不通过（最差 ${(ratio * 100).toFixed(3)}%）`);
    check(ratio > 0.0005, `像素差异比例 ${(ratio * 100).toFixed(3)}% > 阈值 0.05%`);
    const propsDiff = diff.report.results.flatMap((r) => r.metrics).filter((d) => d.selector === ".properties");
    check(propsDiff.length > 0, `metrics 抓到 .properties 的差异（${propsDiff.length} 项：${propsDiff.slice(0, 3).map((d) => `${d.field} ${d.old}→${d.new}`).join(" / ")}）`);
    check(propsDiff.some((d) => d.field === "fontSize"), "抓到 fontSize 变化");
    check(propsDiff.some((d) => d.field === "y"), "抓到 y 位移");

    log("\n[自测] 3) PNG 解码器可独立解码 Chromium 产物");
    const probePng = await fsp.readFile(path.join(dirA, "1280x800", "initial.png"));
    const dec = decodePng(probePng);
    check(dec.width === 1280 && dec.height === 800, `解码尺寸 ${dec.width}x${dec.height}，channels=${dec.channels}`);

    log(`\n[自测] ${failures === 0 ? "全部通过" : `${failures} 条失败`}  （产物留在 ${base}）`);
    if (failures === 0) log("       ⇒ CDP 连接 / 截图 / PNG 解码 / 几何采集 / 差异比对 五段链路均可用。");
    return { exitCode: failures === 0 ? 0 : 1, failures };
  });
}

// ─────────────────────────────────────────────────────────── main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    const r = await runSelfTest(opts);
    process.exit(r.exitCode);
  }
  if (opts.compare) {
    let newDir = opts.newDir;
    if (!newDir) {
      newDir = path.join(opts.out, ".current");
      await fsp.rm(newDir, { recursive: true, force: true });
      const cap = { ...opts, out: newDir, compare: null };
      const r = await runCapture(cap);
      if (r.exitCode !== 0) process.exit(r.exitCode);
    }
    const c = await compareBaselines(opts.compare, newDir, opts);
    process.exit(opts.noFail ? 0 : c.exitCode);
  }
  const r = await runCapture(opts);
  process.exit(r.exitCode);
}

main().catch((e) => {
  console.error(`\n[失败] ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
