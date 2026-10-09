// check-editor-table-gesture —— **在表格单元格上拖选，不许报 `Lexical error #335`**。
//
// ── 挡的是哪一次真实事故（incident）───────────────────────────────────────────────
// owner 2026-10-08 贴来 **1.92.6 生产控制台日志**：`bootstrap` 之后连发 **6 次**
// `Error: Minified Lexical error #335`。查权威出处（`lexical@0.50.0` 自己的
// `scripts/error-codes/codes.json`）：**`"tableObserver not found for tableKey: %s"`**。
//
// 为什么只有真 Chromium 能判：`#335` 抛在 `@lexical/table` 的 `$handleTableSelectionChangeCommand`，
// 而触发它的是**指针/拖拽手势**（整包里只有一处 `tableObservers.setNextFocus(...)`，在单元格手势里）
// ⇒ **合成 `MouseEvent` 触不到它**（本仓实测：第一版探针就是这么**假绿**的 ✗）⇒ 必须真指针 ＋ 真构建断言。
//
// ⚠️⚠️ 这条门禁**真正值钱的是它抓到的第二层**：那次修复（2026-10-01）**只打在 `dist/LexicalTable.dev.js`
//   / `.dev.mjs`**，而包的 `exports` 是 `"production": "./dist/LexicalTable.prod.mjs"`、**线上/发布版走 prod**
//   ⇒ **修复从上线那天起从没生效** ✗（教训：「修好了」要问"**哪个产物**"，不是"补丁在不在"）。
//   本门禁跑的是 **`pnpm build:web` 的真产物** ⇒ 只修 dev 的回归会**当场变红** ✓。
//
// 判据（两条路，改前都是 6 行）：
//   ① **只拖选**（表始终在）—— owner 日志那一幕 ⇒ 必须 **0** 行；
//   ② **拖拽进行中那张表被撤掉**（排队的"待焦点"过期）⇒ 也必须 **0** 行
//      （⚠️ 这一档**先断言前提**：撤销后表得真的没了 —— 否则它是**空判据** ✗）。
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";

const argDir = process.argv.indexOf("--dir");
const DIR = resolve(process.cwd(), argDir > -1 ? process.argv[argDir + 1] : "dist-web");
const ONLY_SELF_TEST = process.argv.includes("--self-test");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 产物里的表格（`#335` 判据**只认这个形状**）：`<table>` 两行两列，第一行表头。 */
const TABLE_HTML =
  "<table><tr><th>甲</th><th>乙</th></tr><tr><td>1</td><td>2</td></tr></table><p>表格下面一行</p>";

/**
 * 从控制台/页面错误的文本里数 `#335`（`tableObserver not found` 也算 —— 它俩是同一件事的
 * prod / dev 两种说法 ✓）。**纯函数**，`--self-test` 直接喂字符串验它。
 */
export function count335(lines) {
  return lines.filter((t) => /Minified Lexical error #335|tableObserver not found/.test(t)).length;
}

/** `--self-test`：把**判据本身**（而不是浏览器）先验一遍。 */
if (ONLY_SELF_TEST) {
  const cases = [
    { name: "空 ⇒ 0", lines: [], want: 0 },
    { name: "prod 文案 ⇒ 1", lines: ["Error: Minified Lexical error #335; visit https://lexical.dev/…"], want: 1 },
    { name: "dev 文案 ⇒ 1", lines: ["tableObserver not found for tableKey: t1"], want: 1 },
    { name: "两条同现 ⇒ 2", lines: ["Minified Lexical error #335", "tableObserver not found for tableKey: x"], want: 2 },
    { name: "别的错误码不算 ⇒ 0", lines: ["Minified Lexical error #334", "tableObserver found for tableKey: x"], want: 0 },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = count335(c.lines);
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✗"} ${c.name}（实测 ${got}）`);
  }
  console.log(`\n[结果] ${cases.length - bad} 通过 / ${bad} 失败`);
  process.exit(bad === 0 ? 0 : 1);
}

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
      "cache-control": "no-store",
    });
    res.end(body);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port })));
}

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
};

if (!existsSync(join(DIR, "index.html"))) {
  console.log(`✗ 找不到构建产物：${DIR}/index.html —— 这条门禁跑的是**真构建**，请先 \`pnpm build:web\` ✗`);
  process.exit(1);
}

const { server, port } = await serveStatic(DIR);
const browser = await launchChrome({ executablePath: findChrome() });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 800 });

/** 抓到的一切控制台/页面错误（判据只在里面数 #335 ✓）。 */
const seen = [];
page.on("console", (m) => seen.push(m.text()));
page.on("pageerror", (e) => seen.push(String(e)));

const cellsBox = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".editor-content td, .editor-content th")).map((td) => {
      const r = td.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }),
  );
const tableCount = () => page.evaluate(() => document.querySelectorAll(".editor-content table").length);

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await sleep(3200);

  // ── 前置：往正文里放一个真表格（粘贴 HTML ⇒ 走应用自己的粘贴路径 ✓）─────
  await page.evaluate((html) => {
    const ed = document.querySelector(".editor-content");
    if (!ed) return;
    ed.focus();
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", "甲 乙 1 2");
    ed.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  }, TABLE_HTML);
  await sleep(2000);

  const boxes = await cellsBox();
  ok((await tableCount()) === 1, `正文里有一个表格（“该在的东西不在”就是判红：实测 ${await tableCount()} 个）`);
  ok(boxes.length >= 2, `表格里至少两个单元格可供拖选（实测 ${boxes.length} 个）`);
  if (boxes.length < 2) throw new Error("前提不成立：没有可拖选的单元格 ⇒ 后面两条会变成空判据 ✗");

  // ── 判据 ①：只拖选（表始终在）＝ owner 日志那一幕 ─────────────────────────
  seen.length = 0;
  await page.mouse.move(boxes[0].x, boxes[0].y);
  await page.mouse.down();
  await sleep(150);
  await page.mouse.move(boxes[1].x, boxes[1].y, { steps: 8 });
  await sleep(400);
  await page.mouse.up();
  await sleep(800);
  const n1 = count335(seen);
  ok(n1 === 0, `① 在表格单元格上拖选，不许报 #335（实测 ${n1} 行；改前是 6 行 ✗）`);
  if (n1 > 0) console.log(`     抓到：${seen.filter((t) => /335|tableObserver/.test(t))[0]?.slice(0, 120)}`);

  // ── 判据 ②：拖拽**进行中**那张表被撤掉（排队的"待焦点"过期）──────────────
  await sleep(2600); // 等自动保存：那一笔粘贴才进得了撤销栈
  seen.length = 0;
  await page.mouse.move(boxes[0].x, boxes[0].y);
  await page.mouse.down();
  await sleep(150);
  await page.mouse.move(boxes[1].x, boxes[1].y, { steps: 6 });
  await sleep(200);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  let gone = await tableCount();
  for (let i = 0; i < 8 && gone !== 0; i++) {
    await sleep(400);
    gone = await tableCount();
    if (gone !== 0) {
      // 再撤一次（有的路径要把"粘贴"与"升级成模型表"分两步撤）
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyZ");
      await page.keyboard.up("Control");
    }
  }
  gone = await tableCount();
  await page.mouse.move(boxes[0].x + 6, boxes[0].y + 4, { steps: 4 });
  await sleep(500);
  await page.mouse.up();
  await sleep(800);
  const n2 = count335(seen);
  // ⚠️ **前提**先判：撤销没把表拿走 ⇒ 这一档是**空判据**，不许算通过 ✗
  ok(gone === 0, `② 前提成立：拖拽中那张表被撤掉了（实测剩余 ${gone} 个）`);
  ok(n2 === 0, `② 表在拖拽中消失，之后也不许报 #335（实测 ${n2} 行；改前是 6 行 ✗）`);
} catch (e) {
  fail++;
  console.log(`  ✗ 跑挂了：${e}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
