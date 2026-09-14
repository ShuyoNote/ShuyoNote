// 几个"真人浏览器验收"脚本共用的 Chrome 启动逻辑（找可执行文件 + 启动 + 失败重试）。
//
// 为什么收敛成一份（2026-09-11 两次踩到）：四个脚本（Web 产物验收 / 面板几何 / PDF 重复加载 /
// 移动端布局）各自抄了一份 `findChrome` 与 `puppeteer.launch`，于是同一个坑要修四遍——
// 而其中最疼的一次是 **Pages 部署**：`check-web-build` 卡在
// `TimeoutError: Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!`
// （CI 容器里 Chrome 启动偶发卡住），**它一红，整个部署就不发了**（那次是文档-only 的提交，
// 重跑就绿了——但"重跑就好"不该是发布路径的常态）。
//
// 两处加固（都是针对那个 flake 的）：
//   1. **启动超时 30 s → 60 s**（puppeteer 默认 30 s，CI 冷启动常常不够）；
//   2. **失败重试 3 次**（带退避）——启动是幂等的，重试不改变任何断言的含义。
// 加上两个标准开关：`--no-sandbox`（CI 容器里必须）与 `--disable-dev-shm-usage`
//（容器 /dev/shm 常只有 64 MB，Chrome 会因此卡住——症状正是"等 WS endpoint 超时"）。
//
// 用法：
//   import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";
//   const browser = await launchChrome({ executablePath: findChrome() });

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 找一个可用的 Chrome/Chromium；找不到返回 null（调用方负责给出可读的提示并以非零退出）。 */
export function findChrome() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cache)) {
    for (const ver of readdirSync(cache)) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux64/chrome",
        "chrome-win64/chrome.exe",
      ]) {
        const p = join(cache, ver, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  // Windows 路径：此前只找 macOS/Linux，于是这些"真实浏览器验收"脚本在
  // Windows 上一律以"找不到 Chrome"退出——而本仓库的开发机正是 Windows
  //（发版脚本的 `zip` 那次事故也是同一个盲区）。Edge 是 Chromium，puppeteer-core
  // 驱动它没有区别，所以放在 Chrome 之后当兜底。
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  for (const p of [
    join(pf, "Google\\Chrome\\Application\\chrome.exe"),
    join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
    ...(local ? [join(local, "Google\\Chrome\\Application\\chrome.exe")] : []),
    join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
    join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
  ]) {
    if (existsSync(p)) return p;
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

/**
 * 启动 Chrome（带重试）。
 *
 * `launcher` 只用于测试注入（默认就是 `puppeteer-core` 的 `launch`），
 * 这样"重试语义"本身可以被单测钉住，而不必真的让浏览器启动失败三次。
 */
export async function launchChrome(
  { executablePath, headless = "shell", args = [], tries = 3, timeoutMs = 60_000, launcher = null } = {},
) {
  const launch =
    launcher ??
    (await import("puppeteer-core")).default.launch.bind((await import("puppeteer-core")).default);
  const fullArgs = ["--no-sandbox", "--disable-dev-shm-usage", ...args];
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await launch({ executablePath, headless, args: fullArgs, timeout: timeoutMs });
    } catch (e) {
      lastErr = e;
      const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
      if (attempt < tries) {
        console.error(`[chrome] 第 ${attempt} 次启动失败（${why}），${attempt} 秒后重试…`);
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw new Error(
    `Chrome 启动失败（已重试 ${tries} 次，每次超时 ${timeoutMs / 1000} 秒）：` +
      `${lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr)}`,
  );
}
