// 效果图渲染：把本目录的 HTML 逐张截成 2x PNG（1280×800 × dsf2 ⇒ 2560×1600）。
//
// 用法（在仓库根目录）：
//   node docs/plans/personal-sync-2.0-mockups/render.mjs
//   CHROME_PATH="C:/…/chrome.exe" node docs/plans/personal-sync-2.0-mockups/render.mjs
//
// 说明：用仓库已有的 `puppeteer-core`（不额外下载 Chromium）；浏览器按下列候选找，
// 找不到就 exit 2（「环境不具备」≠ 图坏了）。
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  "01-lan-home",
  "02-diagnose",
  "03-private-relay",
  "04-background-mcp",
  "05-uid-confirm",
  "06-attachment-progress",
  "07-relay-errors",
];

const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error("找不到本机浏览器（可用 CHROME_PATH 指定）；本机环境不具备，不算图坏。");
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ["--no-sandbox", "--hide-scrollbars"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  for (const name of FILES) {
    const html = path.join(HERE, `${name}.html`);
    await page.goto(`file://${html}`, { waitUntil: "load" });
    // 给字体/布局一点稳定时间，避免偶发半帧
    await new Promise((r) => setTimeout(r, 150));
    const png = path.join(HERE, `${name}.png`);
    await page.screenshot({ path: png, type: "png" });
    console.log(`rendered ${name}.png`);
  }
} finally {
  await browser.close();
}
